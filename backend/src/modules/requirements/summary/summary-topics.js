import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { parseActorRef } from '../requirements-topics.js';
import { commentPlainText, mentionsToPlainText } from '../mentions/mention-tokens.js';
import { emptySummaryOutput, resolveProposedAnswerStatus } from './summary-output.js';

// Topic scope for the Odin summary: how a topic's thread becomes sources, and how stored
// summaries are presented to the team and to the client portal.
//
// Source numbering (the same rule as numberComments in
// frontend/src/lib/requirements/requirements-sources.js): every comment in the topic's
// tree that is not Odin's own is labeled C1, C2, ... in posting order (createdAt across
// the whole thread, replies included; ties keep depth-first thread order). Removed
// comments keep their label but are not citable. The model cites these labels only; the
// engine maps them to `comment:<id>` before validation results are stored, so stored
// citations survive later comments and deletions. Responses carry each cited comment's
// current label.

export const TOPIC_SOURCE_PREFIX = 'comment:';
export const MAX_RELATED_DECISIONS = 25;
const MAX_DECISION_TEXT = 1200;

function normalizeString(value) {
  return String(value ?? '').trim();
}

function truncate(value, max) {
  const text = normalizeString(value);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A decision as summary context: statements are stored as rich text, the model reads plain text. */
export function decisionContext(decision) {
  return {
    decidedAt: decision.decidedAt,
    decidedBy: normalizeString(decision.decidedByName) || 'A project manager',
    outcome: decision.outcome,
    state: decision.supersededById ? 'superseded' : 'active',
    statement: truncate(commentPlainText(decision.statement), MAX_DECISION_TEXT),
  };
}

/**
 * Active decisions on the project's other topics, newest first. A topic summary reads them
 * so a point another topic's decision settled is not raised again.
 */
export function relatedDecisionContext(decisions = [], topicId) {
  if (!topicId) return [];
  return decisions
    .filter((decision) => decision.kind === 'topic' && decision.topicId && decision.topicId !== topicId && !decision.supersededById)
    .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt)))
    .slice(0, MAX_RELATED_DECISIONS)
    .map((decision) => {
      const { state: _state, ...entry } = decisionContext(decision);
      return { ...entry, track: decision.track ?? null };
    });
}

const TOPIC_ROLE_BY_ASSIGNMENT = Object.freeze({ primary: 'owner', required: 'required' });

/**
 * The topic's owner (primary assignee), its required people, the others assigned to it, and
 * the project's admins, as summary participants. Admins rank with required people; an admin
 * who is also assigned keeps their topic role and is marked admin too.
 */
export function topicParticipants(clarification, names = new Map(), { admins = [] } = {}) {
  const assignments = [...(clarification?.assignments ?? [])];
  const primary = clarification?.primaryAssignment;
  if (primary && !assignments.some((entry) => entry.actorType === primary.actorType && entry.actorId === primary.actorId)) {
    assignments.push({ ...primary, role: 'primary' });
  }
  const adminRefs = new Set(admins);
  const assigned = assignments
    .filter((assignment) => normalizeString(assignment?.actorId))
    .map((assignment) => {
      const actorRef = `${assignment.actorType === 'stakeholder' ? 'stakeholder' : 'user'}:${normalizeString(assignment.actorId)}`;
      return {
        actorName: names.get(actorRef) || normalizeString(assignment.label),
        actorRef,
        ...(adminRefs.has(actorRef) ? { admin: true } : {}),
        topicRole: TOPIC_ROLE_BY_ASSIGNMENT[assignment.role] ?? 'assigned',
      };
    });
  const assignedRefs = new Set(assigned.map((participant) => participant.actorRef));
  const otherAdmins = [...adminRefs]
    .filter((actorRef) => !assignedRefs.has(actorRef))
    .map((actorRef) => ({ actorName: names.get(actorRef) ?? '', actorRef, admin: true, topicRole: null }));
  return [...assigned, ...otherAdmins];
}

/**
 * Labels for a topic's comments. `entries` stays in depth-first thread order; each entry
 * carries its label and the label of the nearest labeled ancestor (`parentLabel`).
 */
export function numberTopicComments(comments = []) {
  const entries = [];
  const visit = (list, parent) => {
    for (const comment of list ?? []) {
      if (!comment?.id) continue;
      const entry = { comment, label: '', parent, parentLabel: null };
      entries.push(entry);
      visit(comment.children, entry);
    }
  };
  visit(comments, null);

  const labelById = new Map();
  entries
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => entry.comment.actorType !== 'assistant')
    .sort((left, right) => {
      const leftTime = Date.parse(left.entry.comment.createdAt ?? '');
      const rightTime = Date.parse(right.entry.comment.createdAt ?? '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
      return left.position - right.position;
    })
    .forEach(({ entry }, index) => {
      entry.label = `C${index + 1}`;
      labelById.set(entry.comment.id, entry.label);
    });

  for (const entry of entries) {
    let ancestor = entry.parent;
    while (ancestor && !ancestor.label) ancestor = ancestor.parent;
    entry.parentLabel = ancestor?.label ?? null;
  }
  return { entries: entries.map(({ parent: _parent, ...entry }) => entry), labelById };
}

function labelNumber(label) {
  return Number(String(label).slice(1)) || 0;
}

export function commentActorRef(comment) {
  return `${comment.actorType === 'stakeholder' ? 'stakeholder' : 'user'}:${normalizeString(comment.actorId)}`;
}

/**
 * Builds the generic summarizeScope input for one topic. `decisions` are the project's topic
 * decisions: this topic's go in as its decisions, other topics' active ones as related.
 */
export function buildTopicSummaryInput({ admins = [], clarification, decisions = [], names = new Map(), track, suggestedOwnerRole = '' }) {
  const { entries } = numberTopicComments(clarification?.comments ?? []);
  const sources = [];
  const posted = entries.filter((entry) => entry.label).sort((left, right) => labelNumber(left.label) - labelNumber(right.label));
  for (const { comment, label, parentLabel } of posted) {
    if (!label || comment.deletedAt || !normalizeString(comment.body)) continue;
    const actorRef = commentActorRef(comment);
    sources.push({
      actorName: normalizeString(comment.authorName) || names.get(actorRef) || '',
      actorRef,
      createdAt: comment.createdAt,
      kind: normalizeString(comment.source) || 'comment',
      ref: label,
      replyTo: parentLabel,
      storedRef: `${TOPIC_SOURCE_PREFIX}${comment.id}`,
      text: mentionsToPlainText(comment.body),
      votes: (comment.reactionVotes ?? []).map((vote) => {
        const voterRef = `${vote.actorType === 'stakeholder' ? 'stakeholder' : 'user'}:${normalizeString(vote.actorId)}`;
        return { actorName: names.get(voterRef) ?? '', actorRef: voterRef, vote: vote.reaction === 'down' ? 'down' : 'up' };
      }),
    });
  }

  const topicId = clarification?.id ?? null;
  const related = relatedDecisionContext(decisions, topicId);
  return {
    context: {
      decisions: decisions
        .filter((decision) => decision.kind === 'topic' && (!topicId || decision.topicId === topicId))
        .sort((left, right) => String(left.decidedAt).localeCompare(String(right.decidedAt)))
        .map(decisionContext),
      ...(related.length > 0 ? { relatedDecisions: related } : {}),
    },
    participants: topicParticipants(clarification, names, { admins }),
    sources,
    subject: {
      prompt: normalizeString(clarification?.prompt),
      rationale: normalizeString(clarification?.rationale),
      settles: normalizeString(clarification?.blockingArea),
      suggestedOwnerRole: normalizeString(suggestedOwnerRole),
    },
    track,
  };
}

/** Which stakeholder links can see a topic: every link when unassigned, else assigned stakeholders. */
export function topicPortalAudience(clarification) {
  if (!clarification || clarification.status === 'dismissed') return { stakeholderIds: [] };
  const assignments = clarification.assignments ?? [];
  if (assignments.length === 0) return { stakeholderIds: null };
  return {
    stakeholderIds: assignments
      .filter((assignment) => assignment.actorType === 'stakeholder')
      .map((assignment) => assignment.actorId),
  };
}

/** Display names keyed by actor ref (`user:<id>`, `stakeholder:<id>`). */
export async function loadActorNames(params) {
  return (await loadActorDirectory(params)).names;
}

/**
 * Display names keyed by actor ref, and the refs of the project's admins: users with the
 * admin role on the workspace or on the project.
 */
export async function loadActorDirectory({ assistantRepository, projectId, projectRepository, tenantId }) {
  const names = new Map();
  const admins = new Set();
  try {
    const [valid, stakeholders] = await Promise.all([
      projectRepository?.getValidUsers?.({ projectId, tenantId }) ?? null,
      assistantRepository?.listProjectStakeholders?.({ projectId, tenantId }) ?? [],
    ]);
    for (const entry of [...(valid?.tenant_users ?? []), ...(valid?.project_users ?? [])]) {
      if (entry?.id && entry?.name) names.set(`user:${entry.id}`, entry.name);
      if (entry?.id && entry?.role === 'admin') admins.add(`user:${entry.id}`);
    }
    for (const stakeholder of stakeholders ?? []) {
      if (stakeholder?.id && stakeholder?.name) names.set(`stakeholder:${stakeholder.id}`, stakeholder.name);
    }
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.summary.loadActorNames', { projectId, tenantId }),
      error,
      level: 'warn',
      message: 'Odin summary could not resolve display names.',
    });
  }
  return { admins: [...admins].sort(), names };
}

/** Adds comment author names (the name shown in the thread) for actors not found elsewhere. */
export function withCommentAuthorNames(names, clarification) {
  const merged = new Map(names);
  for (const { comment } of numberTopicComments(clarification?.comments ?? []).entries) {
    const ref = commentActorRef(comment);
    if (!merged.has(ref) && normalizeString(comment.authorName)) merged.set(ref, normalizeString(comment.authorName));
  }
  return merged;
}

export function createTopicSummaryLoader({ assistantRepository, projectRepository, requirementsRepository }) {
  return {
    async load({ projectId, scopeId, tenantId }) {
      const [clarification, meta, decisions] = await Promise.all([
        assistantRepository.getProjectClarification({ clarificationId: scopeId, projectId, tenantId }),
        requirementsRepository.listTopicMeta({ projectId, tenantId }),
        requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId }),
      ]);
      const entry = meta.find((item) => item.id === scopeId);
      if (!clarification || !entry?.track || clarification.status === 'dismissed') return null;
      const { admins, names } = await loadActorDirectory({ assistantRepository, projectId, projectRepository, tenantId });
      return {
        ...buildTopicSummaryInput({
          admins,
          clarification,
          decisions,
          names,
          suggestedOwnerRole: entry.suggestedOwnerRole ?? '',
          track: entry.track,
        }),
        audience: topicPortalAudience(clarification),
      };
    },
  };
}

// --- presentation ---------------------------------------------------------

function fallbackName(ref) {
  return parseActorRef(ref).actorType === 'stakeholder' ? 'Stakeholder' : 'Team member';
}

function nameFor(ref, names) {
  return names.get(ref) || fallbackName(ref);
}

function citedRefs(output) {
  const refs = [];
  const add = (values) => {
    for (const value of values ?? []) if (value && !refs.includes(value)) refs.push(value);
  };
  for (const entry of output.aligned ?? []) add(entry.sources);
  for (const entry of output.divergent ?? []) for (const position of entry.positions ?? []) add(position.sources);
  for (const entry of output.proposedPreferences ?? []) add(entry.sources);
  for (const entry of output.outstanding ?? []) add(entry.sources);
  for (const entry of output.feedbackThemes ?? []) add(entry.sources);
  add(output.proposedAnswerSources);
  return refs;
}

/** Current label (C3) and availability for each cited source. */
function describeSources(output, clarification) {
  const { entries, labelById } = numberTopicComments(clarification?.comments ?? []);
  const byId = new Map(entries.map((entry) => [entry.comment.id, entry.comment]));
  return citedRefs(output).map((ref) => {
    const commentId = ref.startsWith(TOPIC_SOURCE_PREFIX) ? ref.slice(TOPIC_SOURCE_PREFIX.length) : '';
    const comment = commentId ? byId.get(commentId) : null;
    return {
      available: Boolean(comment && !comment.deletedAt),
      label: commentId ? (labelById.get(commentId) ?? null) : null,
      ref,
    };
  });
}

/**
 * Output for a given audience. Team: actor refs plus display names alongside. Portal:
 * display names only, never user ids, stakeholder ids, or emails.
 */
export function presentSummaryOutput(output, { audience = 'team', names = new Map() } = {}) {
  if (!output) return null;
  const full = { ...emptySummaryOutput(), ...output };
  const team = audience === 'team';
  return {
    aligned: (full.aligned ?? []).map((entry) => ({
      sources: entry.sources ?? [],
      statement: entry.statement,
      supporterNames: (entry.supporters ?? []).map((ref) => nameFor(ref, names)),
      ...(team ? { supporters: entry.supporters ?? [] } : {}),
    })),
    divergent: (full.divergent ?? []).map((entry) => ({
      issue: entry.issue,
      positions: (entry.positions ?? []).map((position) => ({
        actorNames: (position.actors ?? []).map((ref) => nameFor(ref, names)),
        sources: position.sources ?? [],
        summary: position.summary,
        ...(team ? { actors: position.actors ?? [] } : {}),
      })),
    })),
    feedbackThemes: (full.feedbackThemes ?? []).map((entry) => ({ detail: entry.detail ?? '', sources: entry.sources ?? [], theme: entry.theme })),
    insufficientInput: full.insufficientInput === true,
    outstanding: (full.outstanding ?? []).map((entry) => ({
      blocking: entry.blocking === true,
      item: entry.item,
      sources: entry.sources ?? [],
      suggestedOwnerRole: entry.suggestedOwnerRole ?? '',
      waitingOnNames: (entry.waitingOn ?? []).map((ref) => nameFor(ref, names)),
      ...(team ? { waitingOn: entry.waitingOn ?? [] } : {}),
    })),
    proposedAnswer: normalizeString(full.proposedAnswer),
    proposedAnswerSources: full.proposedAnswerSources ?? [],
    // The stored value, not the defaulted one: runs from before the status existed read as agreed.
    proposedAnswerStatus: resolveProposedAnswerStatus({ proposedAnswer: full.proposedAnswer, status: output.proposedAnswerStatus }),
    proposedPreferences: (full.proposedPreferences ?? []).map((entry) => ({
      dimension: entry.dimension ?? '',
      sources: entry.sources ?? [],
      stance: entry.stance,
      statement: entry.statement,
    })),
    underExplored: (full.underExplored ?? []).map((entry) => ({
      area: entry.area,
      suggestedQuestion: entry.suggestedQuestion ?? '',
      why: entry.why ?? '',
    })),
  };
}

/** Failure code stored at the front of error_message (`ai_request_failed: ...`). */
export function summaryFailureReason(run) {
  if (!run || run.status !== 'failed') return null;
  return normalizeString(run.errorMessage).split(':')[0] || 'ai_request_failed';
}

export function presentSummaryStatus({ lastAttempt = null, refreshPending = false } = {}) {
  return {
    lastAttemptAt: lastAttempt?.createdAt ?? null,
    lastAttemptStatus: lastAttempt ? lastAttempt.status : null,
    refreshPending: Boolean(refreshPending),
  };
}

/**
 * The current (newest ok) summary of a topic for one audience, or null. Carries the
 * latest attempt so a failed refresh shows as "Last updated <time>, refresh failed".
 */
export function presentTopicSummary(summary, { audience = 'team', clarification = null, lastAttempt = null, names = new Map() } = {}) {
  if (!summary) return null;
  const output = presentSummaryOutput(summary.output, { audience, names });
  return {
    createdAt: summary.createdAt,
    id: summary.id,
    lastAttemptAt: lastAttempt?.createdAt ?? summary.createdAt,
    lastAttemptStatus: lastAttempt?.status ?? summary.status ?? 'ok',
    output,
    scopeId: summary.scopeId,
    scopeType: summary.scopeType,
    sources: output ? describeSources(output, clarification) : [],
    status: summary.status ?? 'ok',
  };
}

function presentDroppedRecord(record) {
  return {
    entry: record.entry ?? null,
    index: record.index ?? null,
    position: record.position ?? null,
    reason: record.reason,
    refs: record.refs ?? [],
    section: record.section,
  };
}

/** One run in the team's history view, newest first. */
export function presentSummaryRun(run, { clarification = null, currentId = null, names = new Map() } = {}) {
  const output = run.output ? presentSummaryOutput(run.output, { audience: 'team', names }) : null;
  return {
    createdAt: run.createdAt,
    current: run.id === currentId,
    dropped: (run.dropped ?? []).map(presentDroppedRecord),
    failureReason: summaryFailureReason(run),
    id: run.id,
    inputDigest: run.inputDigest,
    model: run.model,
    output,
    sources: output ? describeSources(output, clarification) : [],
    status: run.status,
  };
}
