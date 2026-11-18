import { randomUUID } from 'node:crypto';

import { mapWithConcurrency } from '../../lib/async/map-with-concurrency.js';
import { requireDecisionRights, resolveDecisionRights } from '../../lib/auth/decision-rights.js';
import { hasProjectCapability, PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { queueRequirementsLinkEmail } from '../mail/mail.service.js';
import { aiNotConfiguredError } from './ai/requirements-ai-service.js';
import { draftedTopicRationale, MAX_DRAFTED_QUESTIONS } from './ai/requirements-draft-questions.js';
import {
  buildRequirementsPortalUrl,
  computeLinkStatus,
  generateAccessToken,
  hashAccessToken,
  LINK_REQUEST_PURPOSE,
  pendingLinkRequest,
} from './requirements-access-links.js';
import { publishRequirementsChange, REQUIREMENTS_EVENTS } from './requirements-events.js';
import { draftQuestionsOutputSchema } from './requirements.schema.js';
import { REQUIREMENTS_TRACKS } from './requirements.repository.js';
import {
  buildTopicRows,
  countTopicStates,
  describeActorRef,
  extractBriefLines,
  filterTopicRows,
  findTopicComment,
  isDuplicatePrompt,
  isTopicOpenStatus,
  presentCommentTree,
  sortTopicRows,
  topicEvidence,
  userActorRef,
} from './requirements-topics.js';
import {
  decisionContext,
  loadActorNames,
  presentSummaryOutput,
  presentSummaryRun,
  presentSummaryStatus,
  presentTopicSummary,
  summaryFailureReason,
  withCommentAuthorNames,
} from './summary/summary-topics.js';
import { presentMentionables, prepareMentions, recordMentions, recordTopicReplies, teamTopicPeople } from './mentions/mentions.service.js';
import { normalizeAssignmentRole } from '../assistant/assignment-roles.js';

const LINK_EXTENSION_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function requirementsClock(deps) {
  return typeof deps?.clock === 'function' ? deps.clock() : new Date();
}

export function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(404, 'Project not found.');
  return tenantId;
}

async function requireCapability(deps, { capability, projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability, projectId, repository: deps.projectRepository, tenantId, user });
  return tenantId;
}

async function requireRights(deps, { projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  return tenantId;
}

function actorFor(user) {
  return user?.id ? { id: user.id, name: user.name ?? '' } : null;
}

/**
 * Project members for the workspace's assign and reviewer pickers: name, email and project
 * role only. The project's valid-users route needs project.plan.edit, so members could not
 * assign a teammate or invite one to review without this list. Viewers can do neither, so
 * the overview leaves it empty for them.
 */
async function loadProjectMembers(deps, { projectId, tenantId }) {
  const valid = await deps.projectRepository?.getValidUsers?.({ projectId, tenantId });
  return (valid?.project_users ?? [])
    .filter((entry) => entry?.id)
    .map((entry) => ({ email: entry.email ?? '', id: String(entry.id), name: entry.name ?? '', role: entry.role ?? 'user' }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function loadUserNames(deps, { projectId, tenantId }) {
  const names = new Map();
  try {
    const valid = await deps.projectRepository?.getValidUsers?.({ projectId, tenantId });
    for (const entry of [...(valid?.tenant_users ?? []), ...(valid?.project_users ?? [])]) {
      if (entry?.id && entry?.name) names.set(entry.id, entry.name);
    }
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.loadUserNames', { projectId, tenantId }),
      error,
      level: 'warn',
      message: 'Requirements could not resolve user names.',
    });
  }
  return names;
}

/**
 * Loads every tracked topic in a project with its current summary, latest summary attempt,
 * active decision, and evidence. Also asks the summary engine to catch up on any topic
 * whose discussion moved on while nothing was scheduled (for example after a restart).
 */
export async function loadProjectTopics(deps, { projectId, scheduleSummaries = true, tenantId, track = '', userNames = null }) {
  const [clarifications, meta, summaries, decisions, attempts] = await Promise.all([
    deps.assistantRepository.listProjectClarifications({ projectId, tenantId }),
    deps.requirementsRepository.listTopicMeta({ projectId, tenantId }),
    deps.requirementsRepository.listLatestSummaries({ projectId, scopeType: 'topic', tenantId }),
    deps.requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId }),
    deps.requirementsRepository.listLatestSummaryAttempts?.({ projectId, scopeType: 'topic', tenantId }) ?? [],
  ]);
  const names = userNames ?? await loadUserNames(deps, { projectId, tenantId });
  const rows = buildTopicRows({ attempts, clarifications, decisions, meta, summaries, track, userNames: names });
  if (scheduleSummaries) scheduleStaleTopicSummaries(deps, { attempts, clarifications, meta, projectId, tenantId });
  return { attempts, clarifications, decisions, meta, rows, summaries, userNames: names };
}

function scheduleStaleTopicSummaries(deps, { attempts, clarifications, meta, projectId, tenantId }) {
  if (!deps.requirementsSummaries?.ensureFresh) return;
  try {
    const tracked = new Set(meta.filter((entry) => entry.track).map((entry) => entry.id));
    deps.requirementsSummaries.ensureFresh({
      attempts,
      projectId,
      tenantId,
      topics: clarifications
        .filter((clarification) => tracked.has(clarification.id))
        .map((clarification) => ({
          humanComments: topicEvidence(clarification).comments,
          id: clarification.id,
          lastActivityAt: clarification.lastActivityAt,
          status: clarification.status,
        })),
    });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.summary.ensureFresh', { projectId, tenantId }),
      error,
      level: 'warn',
      message: 'Odin summary catch-up scheduling failed.',
    });
  }
}

async function loadTopic(deps, { projectId, tenantId, topicId }) {
  const loaded = await loadProjectTopics(deps, { projectId, tenantId });
  const row = loaded.rows.find((item) => item.id === topicId) ?? null;
  if (!row) throw new HttpError(404, 'Topic not found.');
  const clarification = loaded.clarifications.find((item) => item.id === topicId);
  const summary = loaded.summaries.find((item) => item.scopeType === 'topic' && item.scopeId === topicId) ?? null;
  const attempt = loaded.attempts.find((item) => item.scopeType === 'topic' && item.scopeId === topicId) ?? null;
  return { ...loaded, attempt, clarification, row, summary };
}

/** Whether a refresh is scheduled or running for a topic's summary. */
export function topicSummaryPending(deps, { projectId, tenantId, topicId }) {
  return Boolean(deps.requirementsSummaries?.isPending?.({ projectId, scopeId: topicId, scopeType: 'topic', tenantId }));
}

async function notifyTopicChange(deps, { projectId, reason, tenantId, topicIds = [], track = null, type = REQUIREMENTS_EVENTS.topics, user = null }) {
  await publishRequirementsChange({
    actor: actorFor(user),
    liveEventBus: deps.liveEventBus,
    projectId,
    reason,
    requirementsRepository: deps.requirementsRepository,
    tenantId,
    topicIds,
    track,
    type,
  });
  deps.requirementsSummaries?.noteTopicActivity?.({ projectId, reason, tenantId, topicIds });
}

/** Validates assignment targets and fills missing labels. */
async function normalizeAssignments(deps, { assignments = [], projectId, tenantId }) {
  if (assignments.filter((assignment) => assignment.role === 'primary').length > 1) {
    throw new HttpError(400, 'A topic has at most one primary owner.');
  }

  const stakeholders = assignments.some((assignment) => assignment.actorType === 'stakeholder')
    ? await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId })
    : [];
  const stakeholderById = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  const valid = assignments.some((assignment) => assignment.actorType === 'user')
    ? await deps.projectRepository.getValidUsers({ projectId, tenantId })
    : null;
  const userById = new Map([...(valid?.tenant_users ?? []), ...(valid?.project_users ?? [])].map((entry) => [entry.id, entry]));

  const seen = new Set();
  return assignments.map((assignment) => {
    const key = `${assignment.actorType}:${assignment.actorId}`;
    if (seen.has(key)) throw new HttpError(400, 'Each person can be assigned once.');
    seen.add(key);
    if (assignment.actorType === 'stakeholder') {
      const stakeholder = stakeholderById.get(assignment.actorId);
      if (!stakeholder) throw new HttpError(400, 'Assigned stakeholder is not part of this project.');
      return { ...assignment, label: assignment.label || stakeholder.name };
    }
    const member = userById.get(assignment.actorId);
    if (!member) throw new HttpError(400, 'Assigned user is not a member of this workspace.');
    return { ...assignment, label: assignment.label || member.name || '' };
  });
}

/**
 * Saves assignments and, in the same repository write, schedules the stakeholders they
 * invite into their digests, which the mail job sends after the quiet period. A failure
 * rolls the whole save back. With expectedInvitationRecipients, the repository saves only
 * if exactly those stakeholders would be invited (409 otherwise).
 */
async function applyAssignments(deps, { assignments, expectedInvitationRecipients, projectId, tenantId, topicId }) {
  await deps.assistantRepository.updateProjectClarification({
    clarificationId: topicId,
    patch: {
      assignments,
      ...(expectedInvitationRecipients ? { expectedInvitationStakeholderIds: expectedInvitationRecipients } : {}),
      scheduleInvitationsAt: requirementsClock(deps),
    },
    projectId,
    tenantId,
  });
}

// Preferences come from topic discussions or from a review round's screen and round
// summaries. Round ones stay with their round, which settles them when it closes: Decide
// lists, counts, and logs only topic ones.
function preferenceOrigin(scopeType) {
  return scopeType === 'topic' ? 'topic' : 'round';
}

/** Origin of each accepted preference's summary, by summary id. */
async function loadPreferenceOrigins(deps, { decisions = [], projectId, tenantId }) {
  const summaryIds = decisions.filter((decision) => decision.kind === 'preference' && decision.sourceSummaryId).map((decision) => decision.sourceSummaryId);
  if (summaryIds.length === 0 || typeof deps.requirementsRepository.listSummaryScopes !== 'function') return new Map();
  const scopes = await deps.requirementsRepository.listSummaryScopes({ projectId, summaryIds, tenantId });
  return new Map(scopes.map((scope) => [scope.id, preferenceOrigin(scope.scopeType)]));
}

function presentDecision(decision, { topicsById = new Map(), userNames = new Map(), decisionsById = new Map(), originBySummary = new Map() } = {}) {
  const decidedBy = describeActorRef(decision.decidedBy, userNames);
  if (decidedBy && !decidedBy.name) decidedBy.name = decision.decidedByName;
  const chain = [];
  let cursor = decision.supersedesId;
  const visited = new Set([decision.id]);
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    chain.push(cursor);
    cursor = decisionsById.get(cursor)?.supersedesId ?? null;
  }
  const topic = decision.topicId ? topicsById.get(decision.topicId) ?? null : null;
  return {
    chain,
    decidedAt: decision.decidedAt,
    decidedBy,
    id: decision.id,
    kind: decision.kind,
    outcome: decision.outcome,
    preference: decision.kind === 'preference'
      ? { dimension: decision.preferenceDimension, origin: originBySummary.get(decision.sourceSummaryId) ?? 'topic', stance: decision.preferenceStance }
      : null,
    roundId: decision.roundId,
    sources: decision.sources,
    statement: decision.statement,
    status: decision.supersededById ? 'superseded' : 'active',
    supersededAt: decision.supersededAt,
    supersededById: decision.supersededById,
    supersedesId: decision.supersedesId,
    topic: topic ? { id: topic.id, prompt: topic.prompt } : null,
    topicId: decision.topicId,
    track: decision.track,
    updatedAt: decision.updatedAt,
    version: decision.version,
  };
}

function topicStatusForOutcome(outcome, currentStatus) {
  if (outcome === 'deferred') {
    return isTopicOpenStatus(currentStatus) ? null : 'open';
  }
  return 'resolved';
}

/**
 * Proposed preference items from the latest summaries that nobody has accepted yet.
 * `origin` ('topic' or 'round') keeps only the ones from topics or from review rounds.
 */
function collectProposedPreferences({ acceptedDecisions = [], meta = [], origin = '', summaries = [], track = '' }) {
  const trackByTopic = new Map(meta.map((entry) => [entry.id, entry.track]));
  const accepted = acceptedDecisions.filter((decision) => decision.kind === 'preference');
  const acceptedKeys = new Set(accepted.map((decision) => decision.sourceItemKey).filter(Boolean));
  const activeAccepted = accepted.filter((decision) => !decision.supersededById);

  const proposals = [];
  for (const summary of summaries) {
    const summaryTrack = summary.track ?? (summary.scopeType === 'topic' ? trackByTopic.get(summary.scopeId) : null);
    if (!summaryTrack || (track && summaryTrack !== track)) continue;
    if (origin && preferenceOrigin(summary.scopeType) !== origin) continue;
    const items = Array.isArray(summary.output?.proposedPreferences) ? summary.output.proposedPreferences : [];
    items.forEach((item, index) => {
      const statement = String(item?.statement ?? '').trim();
      const dimension = String(item?.dimension ?? '').trim();
      if (!statement) return;
      const key = `${summary.id}:${index}`;
      if (acceptedKeys.has(key)) return;
      if (activeAccepted.some((decision) => decision.track === summaryTrack
        && (decision.preferenceDimension ?? '') === dimension
        && isDuplicatePrompt(decision.statement, statement))) return;
      proposals.push({
        dimension,
        key,
        proposedAt: summary.createdAt,
        scopeId: summary.scopeId,
        scopeType: summary.scopeType,
        sources: Array.isArray(item?.sources) ? item.sources.map(String) : [],
        stance: ['keep', 'change', 'undecided'].includes(item?.stance) ? item.stance : 'undecided',
        statement,
        summaryId: summary.id,
        track: summaryTrack,
      });
    });
  }
  return proposals.sort((left, right) => String(right.proposedAt).localeCompare(String(left.proposedAt)));
}

// ---------------------------------------------------------------------------
// Overview and My open items
// ---------------------------------------------------------------------------

/**
 * What the caller may do in this project's Requirements section, from the capability map
 * the routes enforce. The project detail API does not carry the caller's project role, so
 * the workspace reads these flags instead of guessing from a missing role.
 */
function callerAbilities(rights, user) {
  const has = (capability) => hasProjectCapability({
    capability,
    projectRole: rights.projectRole,
    tenantRole: rights.tenantRole,
    userCapabilities: user?.capabilities,
  });
  return {
    canCollaborate: rights.allowed || has(PROJECT_CAPABILITIES.COLLABORATE),
    canDecide: rights.allowed,
    canEditPlans: rights.allowed || has(PROJECT_CAPABILITIES.PLAN_EDIT),
    projectRole: rights.projectRole ?? null,
  };
}

function latestRoundSummary(rounds = []) {
  const published = rounds.filter((round) => round.status !== 'draft');
  const latest = [...(published.length > 0 ? published : rounds)].sort((left, right) => right.number - left.number)[0] ?? null;
  if (!latest) return null;
  const reviewers = (latest.reviewers ?? []).filter((reviewer) => !reviewer.removedAt);
  return {
    closedAt: latest.closedAt ?? null,
    dueAt: latest.dueAt ?? null,
    id: latest.id,
    number: latest.number,
    publishedAt: latest.publishedAt ?? null,
    reviewersSubmitted: reviewers.filter((reviewer) => reviewer.submittedAt).length,
    reviewersTotal: reviewers.length,
    status: latest.status,
  };
}

export async function getRequirementsOverviewForUser(deps, { projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const [loaded, assistantState, rounds, plans, rights, members] = await Promise.all([
    loadProjectTopics(deps, { projectId, tenantId }),
    deps.assistantRepository.getProjectAssistantState({ projectId, tenantId }),
    deps.requirementsRepository.listRounds({ projectId, tenantId }),
    deps.requirementsRepository.listPlans({ projectId, tenantId }),
    resolveDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user }),
    loadProjectMembers(deps, { projectId, tenantId }),
  ]);
  const allSummaries = await deps.requirementsRepository.listLatestSummaries({ projectId, tenantId });
  const preferenceDecisions = await deps.requirementsRepository.listDecisions({ kind: 'preference', projectId, tenantId });
  const briefLines = extractBriefLines(assistantState?.brief ?? {});

  const tracks = {};
  for (const track of REQUIREMENTS_TRACKS) {
    const rows = loaded.rows.filter((row) => row.track === track);
    const live = rows.filter((row) => row.state !== 'dismissed');
    const counts = countTopicStates(rows);
    const lines = briefLines.map((line) => ({
      label: line.label,
      ref: line.ref,
      section: line.section,
      text: line.text,
      topicCount: live.filter((row) => row.sourceRef === line.ref).length,
    }));
    const coveredLines = lines.filter((line) => line.topicCount > 0).length;
    const proposedPreferences = collectProposedPreferences({
      acceptedDecisions: preferenceDecisions,
      meta: loaded.meta,
      origin: 'topic',
      summaries: allSummaries,
      track,
    }).length;
    // Review is project-wide: every track reports the project's latest round.
    const latestRound = latestRoundSummary(rounds);
    const trackPlans = plans.filter((plan) => plan.track === track).sort((left, right) => right.version - left.version);
    const latestPlan = trackPlans[0] ?? null;

    tracks[track] = {
      stages: {
        brief: {
          coveredLines,
          lines,
          state: lines.length === 0 ? 'empty' : coveredLines === lines.length ? 'covered' : coveredLines === 0 ? 'uncovered' : 'partial',
          totalLines: lines.length,
        },
        decide: {
          decided: counts.decided,
          proposedPreferences,
          state: counts.ready + proposedPreferences > 0 ? 'waiting' : counts.decided > 0 ? 'active' : 'idle',
          waiting: counts.ready,
        },
        discuss: {
          decided: counts.decided,
          dismissed: counts.dismissed,
          open: counts.open,
          ready: counts.ready,
          state: counts.total === 0 ? 'empty' : counts.ready > 0 ? 'attention' : 'active',
          total: counts.total,
        },
        plan: {
          latestPlan: latestPlan
            ? { approvedAt: latestPlan.approvedAt ?? null, id: latestPlan.id, status: latestPlan.status, version: latestPlan.version }
            : null,
          state: latestPlan ? latestPlan.status : 'not-started',
        },
        review: {
          latestRound,
          state: latestRound ? latestRound.status : 'none',
        },
      },
      track,
    };
  }

  const abilities = callerAbilities(rights, user);
  const latestRound = latestRoundSummary(rounds);
  return {
    ...abilities,
    members: abilities.canCollaborate ? members : [],
    ok: true,
    review: { latestRound, state: latestRound ? latestRound.status : 'none' },
    tracks,
  };
}

export async function getMyItemsForUser(deps, { projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  return (await collectMyItems(deps, { projectId, tenantId, user })).payload;
}

/**
 * The "my items" payload for a screen that reads many projects at once (Home). It doesn't
 * queue Odin summary refreshes. The caller has already checked read access to the project.
 */
export async function collectMyItemsWithoutRefresh(deps, { projectId, tenantId, user }) {
  return (await collectMyItems(deps, { projectId, scheduleSummaries: false, tenantId, user })).payload;
}

// The "my items" payload plus the project's rounds, which the projects list also reads.
// The list passes `scheduleSummaries: false` so browsing it doesn't queue Odin summary
// refreshes for every project.
async function collectMyItems(deps, { projectId, scheduleSummaries = true, tenantId, user }) {
  const [loaded, rounds, packages, rights] = await Promise.all([
    loadProjectTopics(deps, { projectId, scheduleSummaries, tenantId }),
    deps.requirementsRepository.listRounds({ projectId, tenantId }),
    deps.requirementsRepository.listPackages({ projectId, status: 'draft', tenantId, uploadedBy: userActorRef(user.id) }),
    resolveDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user }),
  ]);

  const decide = [];
  if (rights.allowed) {
    for (const row of sortTopicRows(loaded.rows.filter((item) => item.state === 'ready'))) {
      decide.push({
        action: 'decide',
        createdAt: row.createdAt,
        id: row.id,
        kind: 'topic',
        meta: {
          evidence: row.evidence,
          proposedAnswerStatus: row.summary?.proposedAnswerStatus ?? 'none',
          readySince: row.summary?.createdAt ?? row.updatedAt,
          signals: row.signals,
          status: row.status,
        },
        title: row.prompt,
        track: row.track,
        updatedAt: row.updatedAt,
      });
    }
    const [allSummaries, preferenceDecisions] = await Promise.all([
      deps.requirementsRepository.listLatestSummaries({ projectId, tenantId }),
      deps.requirementsRepository.listDecisions({ kind: 'preference', projectId, tenantId }),
    ]);
    for (const proposal of collectProposedPreferences({ acceptedDecisions: preferenceDecisions, meta: loaded.meta, origin: 'topic', summaries: allSummaries })) {
      decide.push({
        action: 'decide',
        createdAt: proposal.proposedAt,
        id: proposal.key,
        kind: 'preference',
        meta: {
          dimension: proposal.dimension,
          scopeId: proposal.scopeId,
          scopeType: proposal.scopeType,
          sources: proposal.sources,
          stance: proposal.stance,
          summaryId: proposal.summaryId,
        },
        title: proposal.statement,
        track: proposal.track,
        updatedAt: proposal.proposedAt,
      });
    }
  }

  const answer = loaded.rows
    .filter((row) => ['open', 'ready'].includes(row.state))
    .flatMap((row) => {
      const mine = row.assignments.find((assignment) => assignment.actorType === 'user' && assignment.actorId === user.id);
      if (!mine) return [];
      return [{
        action: 'reply',
        createdAt: row.createdAt,
        id: row.id,
        kind: 'topic',
        meta: { commentCount: row.evidence.comments, lastActivityAt: row.lastActivityAt, role: mine.role, state: row.state },
        title: row.prompt,
        track: row.track,
        updatedAt: row.updatedAt,
      }];
    })
    .sort((left, right) => String(right.meta.lastActivityAt ?? '').localeCompare(String(left.meta.lastActivityAt ?? '')));

  const review = rounds
    .filter((round) => round.status === 'open')
    .flatMap((round) => {
      const reviewer = (round.reviewers ?? []).find((entry) => entry.actorType === 'user'
        && entry.actorId === user.id
        && !entry.removedAt
        && !entry.submittedAt);
      if (!reviewer) return [];
      return [{
        action: 'review',
        createdAt: round.publishedAt ?? round.createdAt,
        id: round.id,
        kind: 'round',
        meta: { dueAt: round.dueAt ?? null, number: round.number, packageId: round.packageId, required: Boolean(reviewer.required) },
        title: `Round ${round.number}`,
        track: round.track,
        updatedAt: round.updatedAt,
      }];
    })
    .sort((left, right) => String(left.meta.dueAt ?? '9999').localeCompare(String(right.meta.dueAt ?? '9999')));

  const drafts = packages
    .map((pkg) => ({
      action: 'preview',
      createdAt: pkg.createdAt,
      id: pkg.id,
      kind: 'package',
      meta: { source: pkg.source, version: pkg.version },
      title: pkg.title,
      track: pkg.track,
      updatedAt: pkg.updatedAt,
    }))
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));

  const payload = {
    ...callerAbilities(rights, user),
    counts: {
      answer: answer.length,
      decide: decide.length,
      drafts: drafts.length,
      review: review.length,
      total: decide.length + answer.length + review.length + drafts.length,
    },
    groups: { answer, decide, drafts, review },
    ok: true,
  };
  return { payload, rounds };
}

const PROJECT_SIGNAL_CONCURRENCY = 4;

function dueTime(round) {
  const time = round.dueAt ? new Date(round.dueAt).valueOf() : Number.NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * The open round the projects list shows: one the user still owes a review on, else the
 * one closing soonest. Null when no round is open.
 */
export function pickProjectReviewSignal(rounds = [], userId = '') {
  const open = rounds.filter((round) => round.status === 'open');
  const entries = open.map((round) => {
    const reviewer = (round.reviewers ?? []).find((entry) => entry.actorType === 'user'
      && entry.actorId === userId
      && !entry.removedAt) ?? null;
    return { awaitingYou: Boolean(reviewer && !reviewer.submittedAt), reviewer, round };
  });
  entries.sort((left, right) => Number(right.awaitingYou) - Number(left.awaitingYou) || dueTime(left.round) - dueTime(right.round));
  const pick = entries[0];
  if (!pick) return null;
  return {
    awaitingYou: pick.awaitingYou,
    dueAt: pick.round.dueAt ?? null,
    id: pick.round.id,
    number: pick.round.number,
    openCount: open.length,
    required: Boolean(pick.reviewer?.required),
    reviewer: Boolean(pick.reviewer),
    submitted: Boolean(pick.reviewer?.submittedAt),
    track: pick.round.track,
  };
}

/**
 * Per-user signals for the projects list: for each visible project that is not archived,
 * what is waiting on the user (the Requirements tab badge counts) and the open review round.
 * A project whose requirements data fails to load comes back marked unavailable.
 */
export async function listProjectSignalsForUser(deps, { user }) {
  const tenantId = tenantIdFor(user);
  const projects = await deps.projectRepository.listProjectsForTenant({ tenantId, user });
  const visible = projects.filter((project) => project.status !== 'Archived');

  const signals = await mapWithConcurrency(visible, PROJECT_SIGNAL_CONCURRENCY, async (project) => {
    try {
      await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId: project.id, repository: deps.projectRepository, tenantId, user });
      const { payload, rounds } = await collectMyItems(deps, { projectId: project.id, scheduleSummaries: false, tenantId, user });
      return {
        projectId: project.id,
        review: pickProjectReviewSignal(rounds, user.id),
        waiting: payload.counts,
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) return null;
      logBackendError({
        context: buildOperationLogContext('requirements.projectSignals', { projectId: project.id, tenantId, userId: user?.id ?? null }),
        error,
        level: 'warn',
        message: 'Project signals failed to load.',
      });
      return { projectId: project.id, review: null, unavailable: true, waiting: null };
    }
  });

  return { ok: true, projects: signals.filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/** Every topic in a project, both tracks and every state, in register order. */
export async function listProjectTopicsForUser(deps, { projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const { rows } = await loadProjectTopics(deps, { projectId, tenantId });
  return { counts: countTopicStates(rows), ok: true, topics: sortTopicRows(rows) };
}

export async function listTrackTopicsForUser(deps, { projectId, query, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const { clarifications, rows, summaries } = await loadProjectTopics(deps, { projectId, tenantId, track });
  const topics = sortTopicRows(filterTopicRows(rows, query));
  return {
    counts: countTopicStates(rows),
    ok: true,
    q: query.q,
    topics: query.include === 'summaries'
      ? await withSummaryOutputs(deps, { clarifications, projectId, summaries, tenantId, topics })
      : topics,
    track,
    view: query.view,
  };
}

/**
 * Adds `summary.output` (the team view, with display names) to each row that has a current
 * Odin summary, so one request can carry every topic's summary (MCP requirements context).
 */
async function withSummaryOutputs(deps, { clarifications, projectId, summaries, tenantId, topics }) {
  if (!topics.some((row) => row.summary)) return topics;
  const names = await loadActorNames({
    assistantRepository: deps.assistantRepository,
    projectId,
    projectRepository: deps.projectRepository,
    tenantId,
  });
  const clarificationById = new Map(clarifications.map((clarification) => [clarification.id, clarification]));
  const summaryByTopic = new Map(summaries
    .filter((summary) => summary.scopeType === 'topic')
    .map((summary) => [summary.scopeId, summary]));
  return topics.map((row) => {
    const summary = row.summary ? summaryByTopic.get(row.id) : null;
    if (!summary) return row;
    const output = presentSummaryOutput(summary.output, {
      audience: 'team',
      names: withCommentAuthorNames(names, clarificationById.get(row.id)),
    });
    return { ...row, summary: { ...row.summary, output } };
  });
}

export async function getTopicForUser(deps, { projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const { attempt, clarification, decisions, row, summary, userNames } = await loadTopic(deps, { projectId, tenantId, topicId });
  const topicDecisions = decisions.filter((decision) => decision.topicId === topicId);
  const decisionsById = new Map(topicDecisions.map((decision) => [decision.id, decision]));
  const actorNames = summary ? await loadSummaryActorNames(deps, { clarification, projectId, tenantId }) : new Map();
  // Attachments arrive mostly through email replies, stored against the clarification.
  const files = await deps.projectRepository.listFiles?.({ projectId, targetId: topicId, targetType: 'clarification', tenantId }) ?? [];
  return {
    ok: true,
    topic: {
      ...row,
      comments: presentCommentTree(clarification, { actorId: user.id, actorType: 'user' }),
      decisions: topicDecisions.map((decision) => presentDecision(decision, { decisionsById, userNames })),
      files: files.map((file) => ({
        createdAt: file.createdAt ?? null,
        fileName: file.fileName,
        fileSize: Number(file.fileSize ?? 0),
        fileType: file.fileType ?? '',
        id: file.id,
        uploaderName: file.uploaderName ?? '',
      })),
      summary: presentTopicSummary(summary, { audience: 'team', clarification, lastAttempt: attempt, names: actorNames }),
      summaryStatus: presentSummaryStatus({
        lastAttempt: attempt,
        refreshPending: topicSummaryPending(deps, { projectId, tenantId, topicId }),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Odin summary: refresh on request and run history
// ---------------------------------------------------------------------------

async function loadSummaryActorNames(deps, { clarification, projectId, tenantId }) {
  const names = await loadActorNames({
    assistantRepository: deps.assistantRepository,
    projectId,
    projectRepository: deps.projectRepository,
    tenantId,
  });
  return withCommentAuthorNames(names, clarification);
}

/**
 * Runs the topic's summary now. Members and up only; stakeholder links have no route to
 * this. A failed run is stored and reported (`outcome: 'failed'`) while the previous
 * summary stays current; retries follow with backoff.
 */
export async function refreshTopicSummaryForUser(deps, { projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  await loadTopic(deps, { projectId, tenantId, topicId });
  if (!deps.requirementsSummaries?.refreshNow) throw aiNotConfiguredError();

  const result = await deps.requirementsSummaries.refreshNow({ projectId, scopeId: topicId, scopeType: 'topic', tenantId });
  if (result?.status === 'unavailable') throw aiNotConfiguredError();

  const { attempt, clarification, summary } = await loadTopic(deps, { projectId, tenantId, topicId });
  const names = await loadSummaryActorNames(deps, { clarification, projectId, tenantId });
  const run = result?.summary ?? null;
  return {
    ok: true,
    outcome: run ? run.status : 'no-input',
    run: run
      ? { createdAt: run.createdAt, failureReason: summaryFailureReason(run), id: run.id, status: run.status }
      : null,
    summary: presentTopicSummary(summary, { audience: 'team', clarification, lastAttempt: attempt, names }),
    summaryStatus: presentSummaryStatus({
      lastAttempt: attempt,
      refreshPending: topicSummaryPending(deps, { projectId, tenantId, topicId }),
    }),
    topicId,
  };
}

export async function listTopicSummaryHistoryForUser(deps, { limit = 50, projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const { clarification, summary } = await loadTopic(deps, { projectId, tenantId, topicId });
  const [runs, names] = await Promise.all([
    deps.requirementsRepository.listSummaryRuns({ limit, projectId, scopeId: topicId, scopeType: 'topic', tenantId }),
    loadSummaryActorNames(deps, { clarification, projectId, tenantId }),
  ]);
  return {
    currentSummaryId: summary?.id ?? null,
    ok: true,
    runs: runs.map((run) => presentSummaryRun(run, { clarification, currentId: summary?.id ?? null, names })),
    topicId,
  };
}

export async function createTrackTopicForUser(deps, { input, origin = 'manual', projectId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const assignments = await normalizeAssignments(deps, { assignments: input.assignments, projectId, tenantId });
  const topicId = randomUUID();

  await deps.requirementsRepository.createTopics({
    projectId,
    tenantId,
    topics: [{
      blockingArea: input.settles,
      createdBy: userActorRef(user.id),
      id: topicId,
      linkedSection: input.sourceRef?.startsWith('brief:') ? 'brief' : 'clarifications',
      prompt: input.prompt,
      rationale: input.rationale,
      sourceRef: input.sourceRef,
      suggestedOwnerRole: input.suggestedOwnerRole,
      topicOrigin: origin,
      track,
    }],
  });
  if (assignments.length > 0) {
    await applyAssignments(deps, { assignments, projectId, tenantId, topicId });
  }

  const { row } = await loadTopic(deps, { projectId, tenantId, topicId });
  await notifyTopicChange(deps, { projectId, reason: 'topic-created', tenantId, topicIds: [topicId], track, user });
  return { ok: true, topic: row };
}

/**
 * Members delete a topic nobody has engaged with yet, typically a drafted question that
 * missed. Anything with comments, review answers, decisions, stakeholder assignments, or
 * files has a history; those are dismissed by an admin or manager instead. Being asked in a
 * review round nobody has answered yet does not count: reviewers then see the question as
 * removed.
 */
export async function deleteTopicForUser(deps, { projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { row } = await loadTopic(deps, { projectId, tenantId, topicId });

  // Round answers count even when they never reached the thread: a failed post, comments
  // closed when it was given, or its comment removed later.
  const [files, answers] = await Promise.all([
    deps.projectRepository.listFiles?.({ projectId, targetId: topicId, targetType: 'clarification', tenantId }) ?? [],
    deps.roundsRepository?.countTopicAnswers?.({ projectId, tenantId, topicId }) ?? 0,
  ]);
  const elsewhere = { ...(answers > 0 ? { answers } : {}), ...(files.length > 0 ? { files: files.length } : {}) };
  const result = Object.keys(elsewhere).length > 0
    ? { activity: elsewhere, deleted: false }
    : await deps.requirementsRepository.deleteTopic({ projectId, tenantId, topicId });
  if (!result) throw new HttpError(404, 'Topic not found.');
  if (!result.deleted) {
    throw new HttpError(409, 'topic_has_activity', {
      details: {
        activity: result.activity,
        code: 'topic_has_activity',
        message: result.activity.answers > 0
          ? 'Reviewers already answered this topic\'s question in a review round. Ask a project admin or manager to dismiss it instead.'
          : 'This topic already has comments, decisions, stakeholders, or files. Ask a project admin or manager to dismiss it.',
      },
    });
  }

  await notifyTopicChange(deps, { projectId, reason: 'topic-deleted', tenantId, topicIds: [topicId], track: row.track, user });
  return { deleted: { id: topicId, track: row.track }, ok: true };
}

export async function updateTopicForUser(deps, { input, projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  if (input.status !== undefined) {
    await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  }
  const { row } = await loadTopic(deps, { projectId, tenantId, topicId });

  const fieldPatch = {};
  if (input.prompt !== undefined) fieldPatch.prompt = input.prompt;
  if (input.rationale !== undefined) fieldPatch.rationale = input.rationale;
  if (input.settles !== undefined) fieldPatch.blockingArea = input.settles;
  if (input.suggestedOwnerRole !== undefined) fieldPatch.suggestedOwnerRole = input.suggestedOwnerRole;
  if (Object.keys(fieldPatch).length > 0) {
    await deps.requirementsRepository.updateTopicFields({ patch: fieldPatch, projectId, tenantId, topicId });
  }

  if (input.assignments !== undefined) {
    const assignments = await normalizeAssignments(deps, { assignments: input.assignments, projectId, tenantId });
    await applyAssignments(deps, { assignments, expectedInvitationRecipients: input.expectedInvitationRecipients, projectId, tenantId, topicId });
  }

  if (input.status !== undefined && input.status !== row.status) {
    await deps.assistantRepository.updateProjectClarification({
      clarificationId: topicId,
      patch: { status: input.status },
      projectId,
      tenantId,
    });
  }

  const refreshed = await loadTopic(deps, { projectId, tenantId, topicId });
  await notifyTopicChange(deps, {
    projectId,
    reason: input.status !== undefined ? 'topic-status-changed' : 'topic-updated',
    tenantId,
    topicIds: [topicId],
    track: refreshed.row.track,
    user,
  });
  // The summary weighs the owner's and assignees' answers, so a change of people refreshes
  // it (a run whose input did not change is skipped without a model call).
  if (input.assignments !== undefined) {
    deps.requirementsSummaries?.requestRefresh?.({ projectId, scopeId: topicId, scopeType: 'topic', tenantId });
  }
  return { ok: true, topic: refreshed.row };
}

/**
 * Moves a topic to the other track. Its discussion, assignments, summaries, and decisions
 * go with it. Moving a decided topic changes both tracks' decision logs, so it needs
 * decision rights; the old track's plan then shows its citation of that decision as stale.
 */
export async function moveTopicForUser(deps, { projectId, topicId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { row } = await loadTopic(deps, { projectId, tenantId, topicId });
  if (row.track === track) return { moved: false, ok: true, topic: row };

  const decisions = await deps.requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId, topicId });
  if (decisions.length > 0) {
    await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  }

  const result = await deps.requirementsRepository.moveTopic({ projectId, tenantId, toTrack: track, topicId });
  if (!result) throw new HttpError(404, 'Topic not found.');

  const refreshed = await loadTopic(deps, { projectId, tenantId, topicId });
  for (const changedTrack of [result.fromTrack, result.toTrack]) {
    await notifyTopicChange(deps, { projectId, reason: 'topic-moved', tenantId, topicIds: [topicId], track: changedTrack, user });
    if (result.decisions > 0) {
      await notifyTopicChange(deps, {
        projectId,
        reason: 'topic-moved',
        tenantId,
        topicIds: [topicId],
        track: changedTrack,
        type: REQUIREMENTS_EVENTS.decisions,
        user,
      });
    }
  }
  return { from: result.fromTrack, moved: true, ok: true, topic: refreshed.row };
}

// ---------------------------------------------------------------------------
// Topic comments (team side). Reuses the clarification comment storage. Comments never
// change a requirements topic's status.
// ---------------------------------------------------------------------------

function ensureCommentsOpen(row) {
  if (!row?.commentsOpen) {
    throw new HttpError(409, 'Comments are closed for this topic.', { details: { code: 'comments_closed' } });
  }
}

export function ensureReplyTarget(clarification, parentCommentId) {
  const id = String(parentCommentId ?? '').trim();
  if (!id) return null;
  const parent = findTopicComment(clarification, id);
  if (!parent) throw new HttpError(400, 'Invalid parent comment.');
  if (parent.deletedAt) throw new HttpError(409, 'Replies cannot be added to a removed comment.');
  return id;
}

export function ensureOwnComment(clarification, commentId, actor) {
  const comment = findTopicComment(clarification, commentId);
  if (!comment || comment.actorType !== actor.actorType || comment.actorId !== actor.actorId) {
    throw new HttpError(404, 'Comment not found.');
  }
  if (comment.deletedAt) throw new HttpError(409, 'This comment has already been removed.');
  return comment;
}

export function ensureVotableComment(clarification, commentId) {
  const comment = findTopicComment(clarification, commentId);
  if (!comment) throw new HttpError(404, 'Comment not found.');
  if (comment.deletedAt) throw new HttpError(409, 'Removed comments can no longer receive reactions.');
  return comment;
}

async function finishCommentChange(deps, { projectId, reason, tenantId, topicId, user }) {
  const refreshed = await loadTopic(deps, { projectId, tenantId, topicId });
  await notifyTopicChange(deps, {
    projectId,
    reason,
    tenantId,
    topicIds: [topicId],
    track: refreshed.row.track,
    user,
  });
  return {
    ...refreshed.row,
    comments: presentCommentTree(refreshed.clarification, { actorId: user.id, actorType: 'user' }),
  };
}

/** People the team may tag on a topic, for the comment box's picker. */
export async function listTopicMentionablesForUser(deps, { projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { clarification } = await loadTopic(deps, { projectId, tenantId, topicId });
  const people = await teamTopicPeople(deps, { author: { actorId: user.id, actorType: 'user' }, clarification, projectId, tenantId });
  return { ok: true, people: presentMentionables(people) };
}

/**
 * Resolves the tags in a team comment. Tagged stakeholders who can't open the topic in the
 * portal are added as collaborators first, which schedules their invitation digest; they
 * are not sent a mention as well. Returns the body to store, the people to notify, and the
 * actor refs to skip.
 */
async function prepareTopicCommentMentions(deps, { body, clarification, previousBody = '', projectId, tenantId, topicId, user }) {
  const author = { actorId: user.id, actorType: 'user', name: user.name ?? 'User' };
  if (!String(body ?? '').includes('@[')) return { author, body, notify: [], skip: [] };
  const people = await teamTopicPeople(deps, { author, clarification, projectId, tenantId });
  const prepared = prepareMentions(body, { people, previousBody });
  const hidden = prepared.mentioned.filter((entry) => entry.actorType === 'stakeholder'
    && people.some((person) => person.actorType === 'stakeholder' && person.actorId === entry.actorId && person.seesTopic === false));
  if (hidden.length) {
    const current = (clarification.assignments ?? []).map((assignment) => ({
      actorId: assignment.actorId,
      actorType: assignment.actorType,
      label: assignment.label ?? '',
      role: normalizeAssignmentRole(assignment.role),
    }));
    await applyAssignments(deps, {
      assignments: [...current, ...hidden.map((entry) => ({ actorId: entry.actorId, actorType: 'stakeholder', label: entry.label, role: 'collaborator' }))],
      projectId,
      tenantId,
      topicId,
    });
  }
  return { author, body: prepared.body, notify: prepared.added, skip: hidden.map((entry) => entry.actorRef) };
}

export async function createTopicCommentForUser(deps, { input, projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { clarification, row } = await loadTopic(deps, { projectId, tenantId, topicId });
  ensureCommentsOpen(row);
  const parentCommentId = ensureReplyTarget(clarification, input.parentCommentId);
  const tagged = await prepareTopicCommentMentions(deps, { body: input.body, clarification, projectId, tenantId, topicId, user });

  const comment = await deps.assistantRepository.addProjectClarificationComment({
    clarificationId: topicId,
    comment: {
      actorId: user.id,
      actorType: 'user',
      authorName: user.name ?? 'User',
      body: tagged.body,
      parentCommentId,
      source: 'comment',
    },
    preserveStatus: true,
    projectId,
    tenantId,
  });
  await recordMentions(deps, { author: tagged.author, projectId, recipients: tagged.notify, skip: tagged.skip, source: { commentId: comment.id, topicId, type: 'topic' }, tenantId });
  await recordTopicReplies(deps, { author: tagged.author, clarification, commentId: comment?.id, projectId, skip: tagged.skip, tenantId, topicId });
  const topic = await finishCommentChange(deps, { projectId, reason: 'topic-commented', tenantId, topicId, user });
  return { comment, ok: true, topic };
}

export async function updateTopicCommentForUser(deps, { commentId, input, projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { clarification, row } = await loadTopic(deps, { projectId, tenantId, topicId });
  ensureCommentsOpen(row);
  const existing = ensureOwnComment(clarification, commentId, { actorId: user.id, actorType: 'user' });
  const tagged = await prepareTopicCommentMentions(deps, { body: input.body, clarification, previousBody: existing?.body ?? '', projectId, tenantId, topicId, user });

  const comment = await deps.assistantRepository.updateProjectClarificationComment({
    body: tagged.body,
    clarificationId: topicId,
    commentId,
    preserveStatus: true,
    projectId,
    tenantId,
  });
  await recordMentions(deps, { author: tagged.author, projectId, recipients: tagged.notify, skip: tagged.skip, source: { commentId, topicId, type: 'topic' }, tenantId });
  const topic = await finishCommentChange(deps, { projectId, reason: 'topic-comment-updated', tenantId, topicId, user });
  return { comment, ok: true, topic };
}

export async function deleteTopicCommentForUser(deps, { commentId, projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { clarification, row } = await loadTopic(deps, { projectId, tenantId, topicId });
  ensureCommentsOpen(row);
  ensureOwnComment(clarification, commentId, { actorId: user.id, actorType: 'user' });

  const result = await deps.assistantRepository.deleteProjectClarificationComment({
    clarificationId: topicId,
    commentId,
    preserveStatus: true,
    projectId,
    tenantId,
  });
  const topic = await finishCommentChange(deps, { projectId, reason: 'topic-comment-deleted', tenantId, topicId, user });
  return {
    comment: result?.hardDeleted ? null : result,
    deleteMode: result?.hardDeleted ? 'hard' : 'soft',
    ok: true,
    topic,
  };
}

export async function voteTopicCommentForUser(deps, { commentId, input, projectId, topicId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const { clarification } = await loadTopic(deps, { projectId, tenantId, topicId });
  ensureVotableComment(clarification, commentId);

  const vote = await deps.assistantRepository.voteProjectClarificationComment({
    actorId: user.id,
    actorType: 'user',
    clarificationId: topicId,
    commentId,
    projectId,
    tenantId,
    vote: input.vote,
  });
  const topic = await finishCommentChange(deps, { projectId, reason: 'topic-comment-reacted', tenantId, topicId, user });
  return { ok: true, topic, vote };
}

// ---------------------------------------------------------------------------
// Draft questions from the brief
// ---------------------------------------------------------------------------

export async function draftQuestionsFromBriefForUser(deps, { projectId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  if (!deps.requirementsAiService?.draftQuestions) throw aiNotConfiguredError();

  const [assistantState, meta, project, decisions] = await Promise.all([
    deps.assistantRepository.getProjectAssistantState({ projectId, tenantId }),
    deps.requirementsRepository.listTopicMeta({ projectId, tenantId }),
    deps.projectRepository.getProjectDetail({ projectId, tenantId }),
    deps.requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId }),
  ]);
  const briefLines = extractBriefLines(assistantState?.brief ?? {});
  if (briefLines.length === 0) {
    throw new HttpError(409, 'brief_empty', {
      details: { code: 'brief_empty', message: 'Add a project brief before drafting questions from it.' },
    });
  }

  const metaById = new Map(meta.map((entry) => [entry.id, entry]));
  const existing = (assistantState?.clarifications ?? []).map((clarification) => ({
    id: clarification.id,
    prompt: clarification.prompt,
    sourceRef: metaById.get(clarification.id)?.sourceRef ?? null,
    status: clarification.status,
    track: metaById.get(clarification.id)?.track ?? null,
  }));

  let raw;
  try {
    raw = await deps.requirementsAiService.draftQuestions({
      briefLines,
      decisions: decisions
        .filter((decision) => !decision.supersededById)
        .map((decision) => ({ statement: decisionContext(decision).statement })),
      existingTopics: existing.filter((topic) => topic.status !== 'dismissed'),
      projectId,
      projectName: project?.name ?? '',
      tenantId,
      track,
    });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 503) throw aiNotConfiguredError();
    logBackendError({
      context: buildOperationLogContext('requirements.draftQuestions', { projectId, tenantId, track }),
      error,
      level: 'warn',
      message: 'Drafting questions from the brief failed.',
    });
    if (error?.name === 'AiStructuredOutputValidationError') {
      throw new HttpError(502, 'ai_output_invalid', {
        details: { code: 'ai_output_invalid', message: 'Odin returned questions in an unexpected shape. Try again.', retryable: true },
      });
    }
    throw new HttpError(502, 'ai_request_failed', {
      details: { code: 'ai_request_failed', message: 'Odin could not draft questions. Try again.', retryable: true },
    });
  }

  const parsed = draftQuestionsOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'ai_output_invalid', {
      details: { code: 'ai_output_invalid', message: 'Odin returned questions in an unexpected shape. Try again.', retryable: true },
    });
  }

  const lineRefs = new Set(briefLines.map((line) => line.ref));
  const compareWith = existing.map((topic) => ({ id: topic.id, prompt: topic.prompt }));
  const topics = [];
  const skipped = [];
  for (const question of parsed.data.questions) {
    if (!lineRefs.has(question.sourceRef)) {
      skipped.push({ prompt: question.prompt, reason: 'unknown-source', sourceRef: question.sourceRef });
      continue;
    }
    // Every drafted question carries the default the client confirms or changes.
    if (!question.recommendation) {
      skipped.push({ prompt: question.prompt, reason: 'no-recommendation', sourceRef: question.sourceRef });
      continue;
    }
    const duplicate = compareWith.find((entry) => isDuplicatePrompt(entry.prompt, question.prompt));
    if (duplicate) {
      skipped.push({ duplicateOf: duplicate.id, prompt: question.prompt, reason: 'duplicate', sourceRef: question.sourceRef });
      continue;
    }
    if (topics.length >= MAX_DRAFTED_QUESTIONS) {
      skipped.push({ prompt: question.prompt, reason: 'limit', sourceRef: question.sourceRef });
      continue;
    }
    const id = randomUUID();
    topics.push({
      blockingArea: question.settles.slice(0, 160),
      createdBy: userActorRef(user.id),
      id,
      linkedSection: 'brief',
      prompt: question.prompt,
      rationale: draftedTopicRationale(question).slice(0, 2000),
      sourceRef: question.sourceRef,
      suggestedOwnerRole: question.suggestedOwnerRole,
      topicOrigin: 'brief-draft',
      track,
    });
    compareWith.push({ id, prompt: question.prompt });
  }

  if (topics.length > 0) {
    await deps.requirementsRepository.createTopics({ projectId, tenantId, topics });
  }

  const createdIds = new Set(topics.map((topic) => topic.id));
  const { rows } = await loadProjectTopics(deps, { projectId, tenantId, track });
  const created = sortTopicRows(rows.filter((row) => createdIds.has(row.id)));
  if (created.length > 0) {
    await notifyTopicChange(deps, { projectId, reason: 'topics-drafted', tenantId, topicIds: [...createdIds], track, user });
  }

  return {
    created,
    ok: true,
    provider: deps.requirementsAiService.provider ?? 'custom',
    skipped,
    track,
  };
}

// ---------------------------------------------------------------------------
// Decisions and preferences (decision rights only)
// ---------------------------------------------------------------------------

export async function recordDecisionForUser(deps, { input, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const { clarification, row } = await loadTopic(deps, { projectId, tenantId, topicId: input.topicId });

  const decision = await deps.requirementsRepository.createDecision({
    decision: {
      decidedAt: requirementsClock(deps),
      decidedBy: userActorRef(user.id),
      decidedByName: user.name ?? '',
      kind: 'topic',
      outcome: input.outcome,
      sourceSummaryId: input.sourceSummaryId || null,
      sources: input.sources,
      statement: input.statement,
      topicId: input.topicId,
      track: row.track,
    },
    projectId,
    supersedesId: input.supersedesId || null,
    tenantId,
    topicStatus: topicStatusForOutcome(input.outcome, clarification.status),
  });

  const refreshed = await loadTopic(deps, { projectId, tenantId, topicId: input.topicId });
  const allDecisions = await deps.requirementsRepository.listDecisions({ projectId, tenantId, track: row.track });
  const decisionsById = new Map(allDecisions.map((entry) => [entry.id, entry]));
  await notifyTopicChange(deps, {
    projectId,
    reason: 'decision-recorded',
    tenantId,
    topicIds: [input.topicId],
    track: row.track,
    type: REQUIREMENTS_EVENTS.decisions,
    user,
  });
  return {
    decision: presentDecision(decision, {
      decisionsById,
      topicsById: new Map([[row.id, row]]),
      userNames: refreshed.userNames,
    }),
    ok: true,
    topic: refreshed.row,
  };
}

export async function updateDecisionForUser(deps, { decisionId, input, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const current = await deps.requirementsRepository.getDecision({ decisionId, projectId, tenantId });
  if (!current) throw new HttpError(404, 'Decision not found.');

  let topicStatus = null;
  if (input.outcome !== undefined && input.outcome !== current.outcome && current.topicId && current.kind === 'topic') {
    const clarification = await deps.assistantRepository.getProjectClarification({ clarificationId: current.topicId, projectId, tenantId });
    topicStatus = topicStatusForOutcome(input.outcome, clarification?.status);
  }

  const patch = {};
  if (input.statement !== undefined) patch.statement = input.statement;
  if (input.outcome !== undefined) patch.outcome = input.outcome;
  if (input.sources !== undefined) patch.sources = input.sources;

  const updated = await deps.requirementsRepository.updateDecision({
    decisionId,
    expectedVersion: input.version,
    now: requirementsClock(deps),
    patch,
    projectId,
    tenantId,
    topicStatus,
    updatedBy: userActorRef(user.id),
  });
  if (!updated) throw new HttpError(404, 'Decision not found.');

  const [userNames, meta, clarifications] = await Promise.all([
    loadUserNames(deps, { projectId, tenantId }),
    deps.requirementsRepository.listTopicMeta({ projectId, tenantId }),
    deps.assistantRepository.listProjectClarifications({ projectId, tenantId }),
  ]);
  const topic = updated.topicId ? clarifications.find((item) => item.id === updated.topicId) ?? null : null;
  await notifyTopicChange(deps, {
    projectId,
    reason: 'decision-updated',
    tenantId,
    topicIds: updated.topicId ? [updated.topicId] : [],
    track: updated.track ?? meta.find((entry) => entry.id === updated.topicId)?.track ?? null,
    type: REQUIREMENTS_EVENTS.decisions,
    user,
  });
  const allDecisions = await deps.requirementsRepository.listDecisions({ projectId, tenantId, track: updated.track });
  return {
    decision: presentDecision(updated, {
      decisionsById: new Map(allDecisions.map((entry) => [entry.id, entry])),
      topicsById: new Map(topic ? [[topic.id, topic]] : []),
      userNames,
    }),
    ok: true,
  };
}

export async function listTrackDecisionsForUser(deps, { kind = '', projectId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const [decisions, clarifications, userNames] = await Promise.all([
    deps.requirementsRepository.listDecisions({ kind, projectId, tenantId, track }),
    deps.assistantRepository.listProjectClarifications({ projectId, tenantId }),
    loadUserNames(deps, { projectId, tenantId }),
  ]);
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  const topicsById = new Map(clarifications.map((clarification) => [clarification.id, clarification]));
  const originBySummary = await loadPreferenceOrigins(deps, { decisions, projectId, tenantId });
  return {
    decisions: decisions.map((decision) => presentDecision(decision, { decisionsById, originBySummary, topicsById, userNames })),
    ok: true,
    track,
  };
}

export async function listTrackPreferencesForUser(deps, { projectId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const [summaries, preferenceDecisions, meta, userNames] = await Promise.all([
    deps.requirementsRepository.listLatestSummaries({ projectId, tenantId }),
    deps.requirementsRepository.listDecisions({ kind: 'preference', projectId, tenantId }),
    deps.requirementsRepository.listTopicMeta({ projectId, tenantId }),
    loadUserNames(deps, { projectId, tenantId }),
  ]);
  const trackDecisions = preferenceDecisions.filter((decision) => decision.track === track);
  const decisionsById = new Map(trackDecisions.map((decision) => [decision.id, decision]));
  const originBySummary = await loadPreferenceOrigins(deps, { decisions: trackDecisions, projectId, tenantId });
  return {
    accepted: trackDecisions.map((decision) => presentDecision(decision, { decisionsById, originBySummary, userNames })),
    ok: true,
    proposed: collectProposedPreferences({ acceptedDecisions: preferenceDecisions, meta, summaries, track }),
    track,
  };
}

export async function acceptPreferenceForUser(deps, { input, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const decision = await deps.requirementsRepository.createDecision({
    decision: {
      decidedAt: requirementsClock(deps),
      decidedBy: userActorRef(user.id),
      decidedByName: user.name ?? '',
      kind: 'preference',
      outcome: input.outcome,
      preferenceDimension: input.dimension,
      preferenceStance: input.stance,
      sourceItemKey: input.key || null,
      sourceSummaryId: input.sourceSummaryId || (input.key ? input.key.split(':')[0] : null),
      sources: input.sources,
      statement: input.statement,
      topicId: null,
      track: input.track,
    },
    projectId,
    tenantId,
  });
  const userNames = await loadUserNames(deps, { projectId, tenantId });
  await notifyTopicChange(deps, {
    projectId,
    reason: 'preference-accepted',
    tenantId,
    track: input.track,
    type: REQUIREMENTS_EVENTS.decisions,
    user,
  });
  const originBySummary = await loadPreferenceOrigins(deps, { decisions: [decision], projectId, tenantId });
  return { decision: presentDecision(decision, { originBySummary, userNames }), ok: true };
}

// ---------------------------------------------------------------------------
// Stakeholder links (decision rights only)
// ---------------------------------------------------------------------------

export async function presentAccessLink(deps, { link, stakeholder = undefined, userNames = new Map() }) {
  const involvement = await deps.requirementsRepository.listStakeholderInvolvement({
    projectId: link.projectId,
    stakeholderId: link.stakeholderId,
    tenantId: link.tenantId,
  });
  const resolvedStakeholder = stakeholder === undefined
    ? await deps.assistantRepository.findProjectStakeholderById({ projectId: link.projectId, stakeholderId: link.stakeholderId, tenantId: link.tenantId })
    : stakeholder;
  const status = computeLinkStatus({ involvement, link, now: requirementsClock(deps) });
  return {
    createdBy: describeActorRef(link.createdBy, userNames),
    expiresAt: status.expiresAt,
    extendedUntil: status.extendedUntil,
    id: link.id,
    involvementActive: status.involvementActive,
    issuedAt: link.issuedAt,
    lastInvolvementEndedAt: status.lastInvolvementEndedAt,
    lastUsedAt: link.lastUsedAt,
    // A "Request a new link" from the stakeholder that no admin or manager has acted on.
    linkRequest: pendingLinkRequest(link),
    revokedAt: link.revokedAt,
    stakeholder: resolvedStakeholder
      ? { email: resolvedStakeholder.email, id: resolvedStakeholder.id, name: resolvedStakeholder.name, roleTitle: resolvedStakeholder.roleTitle ?? '' }
      : { email: '', id: link.stakeholderId, name: '', roleTitle: '' },
    status: status.status,
    tokens: (link.tokens ?? []).filter((token) => token.purpose !== LINK_REQUEST_PURPOSE).map((token) => ({
      createdAt: token.createdAt,
      id: token.id,
      lastUsedAt: token.lastUsedAt,
      purpose: token.purpose,
      revokedAt: token.revokedAt,
    })),
  };
}

async function notifyLinkChange(deps, { link, projectId, reason, tenantId, user }) {
  await publishRequirementsChange({
    actor: actorFor(user),
    liveEventBus: deps.liveEventBus,
    projectId,
    reason,
    requirementsRepository: deps.requirementsRepository,
    tenantId,
    type: REQUIREMENTS_EVENTS.links,
  });
  // A revoked link no longer receives project broadcasts; tell its open portal directly.
  if (link?.revokedAt && deps.liveEventBus) {
    deps.liveEventBus.publish(LIVE_EVENT_CHANNELS.publicRequirements(link.id), { reason, type: REQUIREMENTS_EVENTS.links });
  }
}

export async function listAccessLinksForUser(deps, { projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const [links, stakeholders, userNames] = await Promise.all([
    deps.requirementsRepository.listAccessLinks({ projectId, tenantId }),
    deps.assistantRepository.listProjectStakeholders({ projectId, tenantId }),
    loadUserNames(deps, { projectId, tenantId }),
  ]);
  const stakeholderById = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  return {
    links: await Promise.all(links.map((link) => presentAccessLink(deps, {
      link,
      stakeholder: stakeholderById.get(link.stakeholderId) ?? null,
      userNames,
    }))),
    ok: true,
  };
}

export async function createAccessLinkForUser(deps, { input, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const stakeholder = await deps.assistantRepository.findProjectStakeholderById({ projectId, stakeholderId: input.stakeholderId, tenantId });
  if (!stakeholder) throw new HttpError(404, 'Stakeholder not found.');

  // Each call issues another token for the stakeholder's one link; earlier tokens keep
  // working. A revoked link is reactivated, but tokens revoked with it stay revoked.
  const token = generateAccessToken();
  const issued = await deps.requirementsRepository.issueAccessToken({
    createdBy: userActorRef(user.id),
    now: requirementsClock(deps),
    projectId,
    purpose: input.send ? 'invitation' : 'manual',
    reactivateRevoked: true,
    stakeholderId: stakeholder.id,
    tenantId,
    tokenHash: hashAccessToken(token),
  });
  const url = buildRequirementsPortalUrl({ frontendAppUrl: deps.frontendAppUrl, token });
  const email = input.send ? await emailAccessLink(deps, { projectId, stakeholder, tenantId, url, user }) : null;
  const userNames = await loadUserNames(deps, { projectId, tenantId });
  const reason = issued.linkCreated ? 'link-created' : issued.reactivated ? 'link-reactivated' : 'link-token-issued';
  await notifyLinkChange(deps, { link: issued.link, projectId, reason, tenantId, user });
  return {
    email,
    link: await presentAccessLink(deps, { link: issued.link, stakeholder, userNames }),
    ok: true,
    reactivated: issued.reactivated,
    regenerated: !issued.linkCreated,
    token,
    tokenId: issued.token.id,
    url,
  };
}

/**
 * Emails a stakeholder their new link. The link exists whether or not this works, so a
 * failure is reported to the caller (who can still copy the link) rather than thrown.
 */
async function emailAccessLink(deps, { projectId, stakeholder, tenantId, url, user }) {
  const recipient = String(stakeholder.email ?? '').trim();
  if (!recipient) return { reason: 'no-email', sent: false };
  if (!deps.mailRepository?.queueMail) return { reason: 'mail-not-configured', sent: false };
  try {
    const project = await deps.projectRepository.getProjectDetail?.({ projectId, tenantId });
    await queueRequirementsLinkEmail({
      mailRepository: deps.mailRepository,
      portalUrl: url,
      projectName: project?.name ?? '',
      recipientEmail: recipient,
      senderName: user.name ?? '',
      stakeholderName: stakeholder.name ?? '',
      // mail_queue.mail_target_id is VARCHAR(36) in production.
      targetId: randomUUID(),
    });
    return { recipient, sent: true };
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.emailAccessLink', { projectId, stakeholderId: stakeholder.id, tenantId }),
      error,
      level: 'warn',
      message: 'Requirements link email could not be queued.',
    });
    return { reason: 'queue-failed', recipient, sent: false };
  }
}

export async function revokeAccessLinkForUser(deps, { linkId, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const link = await deps.requirementsRepository.revokeAccessLink({
    linkId,
    now: requirementsClock(deps),
    projectId,
    revokedBy: userActorRef(user.id),
    tenantId,
  });
  if (!link) throw new HttpError(404, 'Link not found.');
  await notifyLinkChange(deps, { link, projectId, reason: 'link-revoked', tenantId, user });
  return { link: await presentAccessLink(deps, { link, userNames: await loadUserNames(deps, { projectId, tenantId }) }), ok: true };
}

export async function extendAccessLinkForUser(deps, { input, linkId, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const current = await deps.requirementsRepository.getAccessLink({ linkId, projectId, tenantId });
  if (!current) throw new HttpError(404, 'Link not found.');
  if (current.revokedAt) {
    throw new HttpError(409, 'link_revoked', { details: { code: 'link_revoked', message: 'This link was revoked. Create a new link instead.' } });
  }

  const now = requirementsClock(deps);
  const until = new Date(input.until);
  if (until.valueOf() <= now.valueOf()) throw new HttpError(400, 'Choose a date in the future.');
  if (until.valueOf() - now.valueOf() > LINK_EXTENSION_MAX_DAYS * DAY_MS) {
    throw new HttpError(400, `Links can be extended up to ${LINK_EXTENSION_MAX_DAYS} days ahead.`);
  }

  const link = await deps.requirementsRepository.extendAccessLink({
    extendedBy: userActorRef(user.id),
    extendedUntil: until,
    linkId,
    now,
    projectId,
    tenantId,
  });
  await notifyLinkChange(deps, { link, projectId, reason: 'link-extended', tenantId, user });
  return { link: await presentAccessLink(deps, { link, userNames: await loadUserNames(deps, { projectId, tenantId }) }), ok: true };
}
