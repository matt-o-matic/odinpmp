import { isHiddenByModule } from '../engagements/engagement-guard.js';
import { hasDecisionRights } from '../../lib/auth/decision-rights.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { queueLinkRequestEmail } from '../mail/mail.service.js';
import { findEmailOptOuts, isOptedOut } from '../users/notification-preferences.js';
import { isProjectSoftDeleted } from '../projects/project-deletion.service.js';
import {
  computeLinkStatus,
  generateAccessToken,
  hashAccessToken,
  latestLinkRequest,
  LINK_REQUEST_INTERVAL_MS,
  LINK_REQUEST_PURPOSE,
} from './requirements-access-links.js';
import { isRemovedTopic, questionRemovedError } from './removed-questions.js';
import { publishRequirementsChange, REQUIREMENTS_EVENTS } from './requirements-events.js';
import {
  ensureOwnComment,
  ensureReplyTarget,
  ensureVotableComment,
  loadProjectTopics,
  requirementsClock,
  topicSummaryPending,
} from './requirements.service.js';
import { presentCommentTree, topicEvidence } from './requirements-topics.js';
import { toPortalMentions } from './mentions/mention-tokens.js';
import { portalTopicPeople, prepareMentions, presentMentionables, recordMentions, recordTopicReplies } from './mentions/mentions.service.js';
import {
  loadActorNames,
  presentSummaryStatus,
  presentTopicSummary,
  withCommentAuthorNames,
} from './summary/summary-topics.js';

// Client portal. A link sees the topics assigned to its stakeholder plus every
// unassigned topic in the project that is not dismissed, including decided ones,
// so the stakeholder can read the decision and comment on it. Stakeholders read, comment,
// and vote; they never change a topic's status or record decisions.

const TOUCH_INTERVAL_MS = 60_000;

function linkNotFound() {
  return new HttpError(404, 'This requirements link is not valid.', { details: { code: 'link_not_found' } });
}

function linkRevoked() {
  return new HttpError(410, 'link_revoked', {
    details: { code: 'link_revoked', message: 'This link was turned off. Ask the project team for a new one.' },
  });
}

/**
 * Throws the portal's 410 when the token or its link was revoked or has expired, and 404
 * when its stakeholder is gone. Returns the stakeholder and the link status. The review
 * origin runs the same check for package grants issued from the token.
 */
export async function ensureLinkTokenActive(deps, { link, token: tokenRecord }) {
  if (tokenRecord.revokedAt) throw linkRevoked();
  if (await isProjectSoftDeleted(deps.projectRepository, { projectId: link.projectId, tenantId: link.tenantId })) throw linkNotFound();

  const now = requirementsClock(deps);
  const involvement = await deps.requirementsRepository.listStakeholderInvolvement({
    projectId: link.projectId,
    stakeholderId: link.stakeholderId,
    tenantId: link.tenantId,
  });
  const linkStatus = computeLinkStatus({ involvement, link, now });
  if (linkStatus.status === 'revoked') throw linkRevoked();
  if (linkStatus.status === 'expired') {
    throw new HttpError(410, 'link_expired', {
      details: { canRequestNewLink: true, code: 'link_expired', expiredAt: linkStatus.expiresAt, message: 'This link has expired. Ask the project team for a new one.' },
    });
  }

  const stakeholder = await deps.assistantRepository.findProjectStakeholderById({
    projectId: link.projectId,
    stakeholderId: link.stakeholderId,
    tenantId: link.tenantId,
  });
  if (!stakeholder) throw linkNotFound();
  return { linkStatus, now, stakeholder };
}

export async function resolvePortalAccess(deps, { token }) {
  const found = await deps.requirementsRepository.findAccessTokenByHash({ tokenHash: hashAccessToken(token) });
  if (!found) throw linkNotFound();
  const { link, token: tokenRecord } = found;
  // An engagement's links stop with the Consulting module off.
  if (await isHiddenByModule(deps, link.projectId)) throw linkNotFound();
  const { linkStatus, now, stakeholder } = await ensureLinkTokenActive(deps, { link, token: tokenRecord });

  const lastUsedMs = tokenRecord.lastUsedAt ? Date.parse(tokenRecord.lastUsedAt) : 0;
  if (!lastUsedMs || now.valueOf() - lastUsedMs > TOUCH_INTERVAL_MS) {
    await deps.requirementsRepository.touchAccessLink({ linkId: link.id, now, tokenId: tokenRecord.id });
  }

  return {
    link,
    linkStatus,
    projectId: link.projectId,
    stakeholder,
    tenantId: link.tenantId,
    tokenId: tokenRecord.id,
  };
}

function portalVisibility(clarification, stakeholderId) {
  if (!clarification || clarification.status === 'dismissed') return null;
  const assignments = clarification.assignments ?? [];
  const mine = assignments.find((assignment) => assignment.actorType === 'stakeholder' && assignment.actorId === stakeholderId);
  if (mine) return { assigned: true, role: mine.role };
  if (assignments.length === 0) return { assigned: false, role: null };
  return null;
}

function presentPortalDecision(decision) {
  if (!decision) return null;
  return {
    decidedAt: decision.decidedAt,
    decidedBy: { name: decision.decidedByName ?? '' },
    id: decision.id,
    outcome: decision.outcome,
    statement: decision.statement,
  };
}

// Odin summaries in the portal carry display names only: no user or stakeholder ids.
function presentPortalTopic({ attempt, clarification, decision, names, pending, row, summary, visibility }) {
  return {
    assignmentRole: visibility.role,
    commentCount: topicEvidence(clarification).comments,
    commentsOpen: row.commentsOpen,
    createdAt: row.createdAt,
    decision: presentPortalDecision(decision),
    id: row.id,
    isAssignedToMe: visibility.assigned,
    lastActivityAt: row.lastActivityAt,
    prompt: row.prompt,
    rationale: row.rationale,
    settles: row.settles,
    state: row.state,
    status: row.status,
    summary: presentTopicSummary(summary, {
      audience: 'portal',
      clarification,
      lastAttempt: attempt,
      names: withCommentAuthorNames(names ?? new Map(), clarification),
    }),
    summaryStatus: presentSummaryStatus({ lastAttempt: attempt, refreshPending: pending }),
    track: row.track,
    updatedAt: row.updatedAt,
  };
}

async function loadPortalTopics(deps, access) {
  const loaded = await loadProjectTopics(deps, { projectId: access.projectId, tenantId: access.tenantId, userNames: new Map() });
  const clarificationById = new Map(loaded.clarifications.map((clarification) => [clarification.id, clarification]));
  const summaryByTopic = new Map(loaded.summaries
    .filter((summary) => summary.scopeType === 'topic')
    .map((summary) => [summary.scopeId, summary]));
  const activeDecisionByTopic = new Map(loaded.decisions
    .filter((decision) => decision.kind === 'topic' && decision.topicId && !decision.supersededById)
    .map((decision) => [decision.topicId, decision]));
  const attemptByTopic = new Map((loaded.attempts ?? [])
    .filter((attempt) => attempt.scopeType === 'topic')
    .map((attempt) => [attempt.scopeId, attempt]));

  const visible = loaded.rows.flatMap((row) => {
    const clarification = clarificationById.get(row.id);
    const visibility = portalVisibility(clarification, access.stakeholder.id);
    return visibility ? [{ clarification, row, visibility }] : [];
  });
  const names = visible.some((entry) => summaryByTopic.has(entry.row.id))
    ? await loadActorNames({
        assistantRepository: deps.assistantRepository,
        projectId: access.projectId,
        projectRepository: deps.projectRepository,
        tenantId: access.tenantId,
      })
    : new Map();

  return visible.map(({ clarification, row, visibility }) => ({
    attempt: attemptByTopic.get(row.id) ?? null,
    clarification,
    decision: activeDecisionByTopic.get(row.id) ?? null,
    names,
    pending: topicSummaryPending(deps, { projectId: access.projectId, tenantId: access.tenantId, topicId: row.id }),
    row,
    summary: summaryByTopic.get(row.id) ?? null,
    visibility,
  }));
}

async function loadPortalTopic(deps, access, topicId) {
  const topics = await loadPortalTopics(deps, access);
  const entry = topics.find((item) => item.row.id === topicId) ?? null;
  if (entry) return entry;
  // A link to a deleted or dismissed topic says so; one shared only with other people stays a plain 404.
  const [topic = null] = await deps.requirementsRepository.listTopicStatuses({ projectId: access.projectId, tenantId: access.tenantId, topicIds: [topicId] });
  if (isRemovedTopic(topic)) throw questionRemovedError(404);
  throw new HttpError(404, 'Question not found.');
}

function stakeholderActor(access) {
  return { actorId: access.stakeholder.id, actorType: 'stakeholder' };
}

function presentPortalTopicDetail(entry, access) {
  return {
    ...presentPortalTopic(entry),
    comments: presentCommentTree(entry.clarification, stakeholderActor(access), {
      hideActorIds: true,
      presentBody: (body) => toPortalMentions(body, access.projectId),
    }),
  };
}

export async function getPortalForToken(deps, { token }) {
  const access = await resolvePortalAccess(deps, { token });
  const [project, topics] = await Promise.all([
    deps.projectRepository.getProjectDetail({ projectId: access.projectId, tenantId: access.tenantId }),
    loadPortalTopics(deps, access),
  ]);
  const byCreated = (left, right) => String(left.createdAt).localeCompare(String(right.createdAt));
  const unassigned = topics.filter((entry) => !entry.visibility.assigned);

  return {
    // Active decisions on every topic this link can see, newest first ("Recently decided").
    decisions: topics
      .filter((entry) => entry.decision)
      .map((entry) => ({
        decidedAt: entry.decision.decidedAt,
        decidedBy: { name: entry.decision.decidedByName ?? '' },
        id: entry.decision.id,
        outcome: entry.decision.outcome,
        statement: entry.decision.statement,
        topicId: entry.row.id,
        topicPrompt: entry.row.prompt,
        track: entry.row.track,
      }))
      .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt))),
    link: {
      expiresAt: access.linkStatus.expiresAt,
      extendedUntil: access.linkStatus.extendedUntil,
      id: access.link.id,
      involvementActive: access.linkStatus.involvementActive,
    },
    ok: true,
    project: { id: access.projectId, name: project?.name ?? 'Project' },
    stakeholder: {
      id: access.stakeholder.id,
      name: access.stakeholder.name,
      roleTitle: access.stakeholder.roleTitle ?? '',
    },
    topics: {
      assigned: topics.filter((entry) => entry.visibility.assigned).map(presentPortalTopic).sort(byCreated),
      decided: unassigned.filter((entry) => entry.row.state === 'decided').map(presentPortalTopic).sort(byCreated),
      open: unassigned.filter((entry) => entry.row.state !== 'decided').map(presentPortalTopic).sort(byCreated),
    },
  };
}

export async function getPortalTopicForToken(deps, { token, topicId }) {
  const access = await resolvePortalAccess(deps, { token });
  const entry = await loadPortalTopic(deps, access, topicId);
  return { ok: true, topic: presentPortalTopicDetail(entry, access) };
}

async function finishPortalChange(deps, access, { reason, topicId }) {
  const entry = await loadPortalTopic(deps, access, topicId);
  await publishRequirementsChange({
    actor: { id: access.stakeholder.id, name: access.stakeholder.name, type: 'stakeholder' },
    liveEventBus: deps.liveEventBus,
    projectId: access.projectId,
    reason,
    requirementsRepository: deps.requirementsRepository,
    tenantId: access.tenantId,
    topicIds: [topicId],
    track: entry.row.track,
    type: REQUIREMENTS_EVENTS.topics,
  });
  deps.requirementsSummaries?.noteTopicActivity?.({ projectId: access.projectId, reason, tenantId: access.tenantId, topicIds: [topicId] });
  return presentPortalTopicDetail({
    ...entry,
    pending: topicSummaryPending(deps, { projectId: access.projectId, tenantId: access.tenantId, topicId }),
  }, access);
}

function ensurePortalCommentsOpen(entry) {
  if (!entry.row.commentsOpen) {
    throw new HttpError(409, 'Comments are closed for this question.', { details: { code: 'comments_closed' } });
  }
}

function presentOwnComment(comment, access) {
  if (!comment) return null;
  const { actorId: _actorId, ...rest } = comment;
  return { ...rest, body: toPortalMentions(rest.body ?? '', access.projectId), isMine: true };
}

/** People this stakeholder may tag on a topic they can see. */
export async function listPortalTopicMentionablesForToken(deps, { token, topicId }) {
  const access = await resolvePortalAccess(deps, { token });
  const entry = await loadPortalTopic(deps, access, topicId);
  const people = portalTopicPeople({ author: stakeholderActor(access), clarification: entry.clarification });
  return { ok: true, people: presentMentionables(people, { audience: 'portal', projectId: access.projectId }) };
}

function preparePortalMentions(access, entry, body, previousBody = '') {
  if (!String(body ?? '').includes('@[')) return { added: [], body };
  const people = portalTopicPeople({ author: stakeholderActor(access), clarification: entry.clarification });
  return prepareMentions(body, { audience: 'portal', people, previousBody, projectId: access.projectId });
}

function portalMentionAuthor(access) {
  return { ...stakeholderActor(access), name: access.stakeholder.name || 'Stakeholder' };
}

export async function createPortalCommentForToken(deps, { input, token, topicId }) {
  const access = await resolvePortalAccess(deps, { token });
  const entry = await loadPortalTopic(deps, access, topicId);
  ensurePortalCommentsOpen(entry);
  const parentCommentId = ensureReplyTarget(entry.clarification, input.parentCommentId);
  const tagged = preparePortalMentions(access, entry, input.body);

  const comment = await deps.assistantRepository.addProjectClarificationComment({
    clarificationId: topicId,
    comment: {
      actorId: access.stakeholder.id,
      actorType: 'stakeholder',
      authorName: access.stakeholder.name || 'Stakeholder',
      body: tagged.body,
      parentCommentId,
      source: 'comment',
    },
    preserveStatus: true,
    projectId: access.projectId,
    tenantId: access.tenantId,
  });
  await recordMentions(deps, { author: portalMentionAuthor(access), projectId: access.projectId, recipients: tagged.added, source: { commentId: comment.id, topicId, type: 'topic' }, tenantId: access.tenantId });
  await recordTopicReplies(deps, { author: portalMentionAuthor(access), clarification: entry.clarification, commentId: comment?.id, projectId: access.projectId, tenantId: access.tenantId, topicId });
  const topic = await finishPortalChange(deps, access, { reason: 'topic-commented', topicId });
  return { comment: presentOwnComment(comment, access), ok: true, topic };
}

export async function updatePortalCommentForToken(deps, { commentId, input, token, topicId }) {
  const access = await resolvePortalAccess(deps, { token });
  const entry = await loadPortalTopic(deps, access, topicId);
  ensurePortalCommentsOpen(entry);
  const existing = ensureOwnComment(entry.clarification, commentId, stakeholderActor(access));
  const tagged = preparePortalMentions(access, entry, input.body, existing?.body ?? '');

  const comment = await deps.assistantRepository.updateProjectClarificationComment({
    body: tagged.body,
    clarificationId: topicId,
    commentId,
    preserveStatus: true,
    projectId: access.projectId,
    tenantId: access.tenantId,
  });
  await recordMentions(deps, { author: portalMentionAuthor(access), projectId: access.projectId, recipients: tagged.added, source: { commentId, topicId, type: 'topic' }, tenantId: access.tenantId });
  const topic = await finishPortalChange(deps, access, { reason: 'topic-comment-updated', topicId });
  return { comment: presentOwnComment(comment, access), ok: true, topic };
}

export async function deletePortalCommentForToken(deps, { commentId, token, topicId }) {
  const access = await resolvePortalAccess(deps, { token });
  const entry = await loadPortalTopic(deps, access, topicId);
  ensurePortalCommentsOpen(entry);
  ensureOwnComment(entry.clarification, commentId, stakeholderActor(access));

  const result = await deps.assistantRepository.deleteProjectClarificationComment({
    clarificationId: topicId,
    commentId,
    preserveStatus: true,
    projectId: access.projectId,
    tenantId: access.tenantId,
  });
  const topic = await finishPortalChange(deps, access, { reason: 'topic-comment-deleted', topicId });
  return {
    comment: result?.hardDeleted ? null : presentOwnComment(result, access),
    deleteMode: result?.hardDeleted ? 'hard' : 'soft',
    ok: true,
    topic,
  };
}

export async function votePortalCommentForToken(deps, { commentId, input, token, topicId }) {
  const access = await resolvePortalAccess(deps, { token });
  const entry = await loadPortalTopic(deps, access, topicId);
  ensureVotableComment(entry.clarification, commentId);

  const vote = await deps.assistantRepository.voteProjectClarificationComment({
    actorId: access.stakeholder.id,
    actorType: 'stakeholder',
    clarificationId: topicId,
    commentId,
    projectId: access.projectId,
    tenantId: access.tenantId,
    vote: input.vote,
  });
  const topic = await finishPortalChange(deps, access, { reason: 'topic-comment-reacted', topicId });
  return { ok: true, topic, vote };
}

// ---------------------------------------------------------------------------
// Request a new link
// ---------------------------------------------------------------------------

/** Users with decision rights on the project, who manage stakeholder links. */
async function linkManagers(deps, { projectId, tenantId }) {
  const valid = await deps.projectRepository.getValidUsers({ projectId, tenantId });
  const managers = new Map();
  for (const entry of valid?.tenant_users ?? []) {
    if (entry?.id && hasDecisionRights({ tenantRole: entry.role })) managers.set(entry.id, entry);
  }
  for (const entry of valid?.project_users ?? []) {
    if (entry?.id && hasDecisionRights({ projectRole: entry.role })) managers.set(entry.id, entry);
  }
  return [...managers.values()].filter((entry) => String(entry.email ?? '').trim());
}

/**
 * A stakeholder whose link expired asks for a new one. Accepted at most once per link per
 * 24 hours; later calls in that window answer `alreadyRequested: true`. Revoked links get
 * the same 410 as the portal, and links that still work get 409 `link_active`. The request
 * is recorded on the link and emailed to the project's admins and managers.
 */
export async function requestNewLinkForToken(deps, { token }) {
  const found = await deps.requirementsRepository.findAccessTokenByHash({ tokenHash: hashAccessToken(token) });
  if (!found || found.token.purpose === LINK_REQUEST_PURPOSE) throw linkNotFound();
  const { link, token: tokenRecord } = found;
  if (link.revokedAt || tokenRecord.revokedAt) throw linkRevoked();

  const now = requirementsClock(deps);
  const involvement = await deps.requirementsRepository.listStakeholderInvolvement({
    projectId: link.projectId,
    stakeholderId: link.stakeholderId,
    tenantId: link.tenantId,
  });
  const status = computeLinkStatus({ involvement, link, now });
  if (status.status === 'revoked') throw linkRevoked();
  if (status.status !== 'expired') {
    throw new HttpError(409, 'link_active', { details: { code: 'link_active', message: 'This link still works. Open it to continue.' } });
  }

  const stakeholder = await deps.assistantRepository.findProjectStakeholderById({
    projectId: link.projectId,
    stakeholderId: link.stakeholderId,
    tenantId: link.tenantId,
  });
  if (!stakeholder) throw linkNotFound();

  const latest = latestLinkRequest(link);
  if (latest && now.valueOf() - Date.parse(latest.requestedAt) < LINK_REQUEST_INTERVAL_MS) {
    return { alreadyRequested: true, ok: true, requestedAt: latest.requestedAt };
  }

  const request = await deps.requirementsRepository.recordLinkRequest({
    linkId: link.id,
    now,
    requestedBy: `stakeholder:${stakeholder.id}`,
    tokenHash: hashAccessToken(generateAccessToken()),
  });

  try {
    const project = await deps.projectRepository.getProjectDetail({ projectId: link.projectId, tenantId: link.tenantId });
    const base = String(deps.frontendAppUrl ?? '').trim().replace(/\/+$/, '');
    const linksUrl = `${base}/projects/${encodeURIComponent(link.projectId)}/requirements/links`;
    const managers = await linkManagers(deps, { projectId: link.projectId, tenantId: link.tenantId });
    const optOuts = await findEmailOptOuts({ kind: 'attention', read: deps.authRepository?.listUserPreferences?.bind(deps.authRepository), userIds: managers.map((manager) => manager.id) });
    for (const manager of managers.filter((entry) => !isOptedOut(optOuts, { userId: entry.id }))) {
      await queueLinkRequestEmail({
        linksUrl,
        mailRepository: deps.mailRepository,
        projectName: project?.name ?? '',
        recipientEmail: manager.email,
        stakeholderDetail: [stakeholder.roleTitle, stakeholder.email].filter((value) => String(value ?? '').trim()).join(', '),
        stakeholderName: stakeholder.name ?? '',
        // One request, one email per manager (mail_queue.mail_target_id is VARCHAR(36)).
        targetId: request.id,
      });
    }
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.linkRequest.notify', { linkId: link.id, projectId: link.projectId, tenantId: link.tenantId }),
      error,
      level: 'warn',
      message: 'A link request was recorded but its email could not be queued.',
    });
  }

  deps.liveEventBus?.publish(LIVE_EVENT_CHANNELS.project(link.projectId), {
    linkId: link.id,
    projectId: link.projectId,
    reason: 'link-requested',
    type: REQUIREMENTS_EVENTS.links,
  });
  return { alreadyRequested: false, ok: true, requestedAt: request.createdAt };
}
