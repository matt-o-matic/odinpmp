import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/errors/http-error.js';
import { invitationRecipientIds, requireExpectedInvitationRecipients } from './clarification-invitation-recipients.js';
import {
  createInMemoryInvitationDigestStore,
  createMysqlInvitationDigestStore,
  scheduleInvitationsInState,
  scheduleInvitationsMysql,
} from './clarification-invitation-digest.store.js';
import { assignmentRoleRank, normalizeAssignmentRole } from './assignment-roles.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stableUuidFromText(value) {
  const hash = createHash('sha256').update(String(value ?? '')).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${(Number.parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function normalizeRecordId(value) {
  const id = normalizeString(value);
  if (!id) {
    return randomUUID();
  }

  return id.length <= 36 ? id : stableUuidFromText(id);
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeDateValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.valueOf())) {
    return parsed.toISOString();
  }

  return normalized;
}

function comparableTime(value, fallback = 0) {
  const normalized = normalizeDateValue(value, null);
  if (!normalized) {
    return fallback;
  }

  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function sessionHasActiveRun(session = {}) {
  const runStatus = normalizeString(session?.run?.status);
  return ['queued', 'running'].includes(runStatus) || Boolean(session?.liveRunState?.running);
}

function toMysqlDateTime(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.valueOf())) {
    return parsed.toISOString().slice(0, 19).replace('T', ' ');
  }

  return normalized;
}

function normalizePreferenceScopeValue(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeSessionLiveRunState(value = null) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    hasUnreadUpdate: Boolean(value.hasUnreadUpdate),
    livePlanNodes: Array.isArray(value.livePlanNodes) ? clone(value.livePlanNodes) : [],
    liveTurnError: value.liveTurnError ? clone(value.liveTurnError) : null,
    liveTurnItems: Array.isArray(value.liveTurnItems) ? clone(value.liveTurnItems) : [],
    running: Boolean(value.running),
    streamingAssistantState: normalizeString(value.streamingAssistantState) || 'idle',
    streamingAssistantText: String(value.streamingAssistantText ?? ''),
    turnPhases: Array.isArray(value.turnPhases) ? clone(value.turnPhases) : [],
    updatedAt: normalizeDateValue(value.updatedAt, null),
  };
}

function buildPublicAccessToken() {
  return randomUUID().replace(/-/g, '');
}

function buildClarificationReplyToken() {
  return randomUUID().replace(/-/g, '');
}

const ASSISTANT_SESSION_KEY_PREFIX = 'as:';
const LEGACY_ASSISTANT_SESSION_KEY_PREFIX = 'assistant_session:';
const ASSISTANT_LATEST_SESSION_KEY_PREFIX = 'asl:';
const LEGACY_ASSISTANT_LATEST_SESSION_KEY_PREFIX = 'assistant_session_latest:';
const ASSISTANT_PROJECT_STATE_KEY = 'assistant_project_state';
const ASSISTANT_USER_SETTINGS_KEY = 'assistant_user_settings';

const CLARIFICATION_LIFECYCLE_STATES = new Set(['draft', 'committed']);
const CLARIFICATION_MAIL_STATUSES = new Set(['pending', 'sent', 'failed']);

function buildAssistantSessionKey(sessionId) {
  return `${ASSISTANT_SESSION_KEY_PREFIX}${sessionId}`;
}

function buildLegacyAssistantSessionKey(sessionId) {
  return `${LEGACY_ASSISTANT_SESSION_KEY_PREFIX}${sessionId}`;
}

function buildAssistantLatestSessionKey(mode) {
  return `${ASSISTANT_LATEST_SESSION_KEY_PREFIX}${mode}`;
}

function buildLegacyAssistantLatestSessionKey(mode) {
  return `${LEGACY_ASSISTANT_LATEST_SESSION_KEY_PREFIX}${mode}`;
}

function sessionContextKey({ mode, projectId = '', tenantId, userId }) {
  return `${tenantId}:${userId}:${mode}:${projectId || ''}`;
}

function projectStateKey({ projectId, tenantId }) {
  return `${tenantId}:${projectId}`;
}

function createEmptyProjectArtifactsState() {
  return {
    artifacts: [],
    brief: {},
    updatedAt: null,
  };
}

function mergeProjectArtifacts(existing, value = {}, briefUpdate) {
  if (briefUpdate && (briefUpdate.expectedUpdatedAt === null
    ? existing.updatedAt !== null
    : Date.parse(briefUpdate.expectedUpdatedAt) !== Date.parse(existing.updatedAt))) {
    throw new HttpError(409, 'Project brief changed. Read it again before updating.', {
      details: { code: 'brief_version_conflict', actualUpdatedAt: existing.updatedAt },
    });
  }
  const brief = briefUpdate ? { ...existing.brief, ...briefUpdate.patch } : value.brief ?? existing.brief;
  if (briefUpdate) {
    for (const [key, field] of Object.entries(briefUpdate.patch)) {
      if (Array.isArray(field)) brief[key] = [...new Set(field)];
    }
  }
  return normalizeStoredProjectArtifactsState({
    ...existing,
    ...value,
    artifacts: value.artifacts ?? existing.artifacts,
    brief,
    updatedAt: new Date(Math.max(Date.now(), (Date.parse(existing.updatedAt) || 0) + 1, Date.parse(value.updatedAt) || 0)).toISOString(),
  });
}

function normalizeStoredProjectBrief(value = {}) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const hasStringValue = [
    value.benefits,
    value.currentState,
    value.implementationEffort,
    value.name,
    value.narrative,
    value.objective,
    value.proposedSolution,
    value.sourceSessionId,
  ].some((item) => normalizeString(item));
  const hasListValue = [
    value.assumptions,
    value.constraints,
    value.dependencies,
    value.requirements,
    value.stakeholders,
    value.successMetrics,
  ].some((item) => Array.isArray(item) && item.length > 0);
  if (!hasStringValue && !hasListValue && !value.committedAt) {
    return {};
  }

  return {
    assumptions: Array.isArray(value.assumptions) ? clone(value.assumptions) : [],
    benefits: normalizeString(value.benefits),
    committedAt: normalizeDateValue(value.committedAt, null),
    constraints: Array.isArray(value.constraints) ? clone(value.constraints) : [],
    currentState: normalizeString(value.currentState),
    dependencies: Array.isArray(value.dependencies) ? clone(value.dependencies) : [],
    implementationEffort: normalizeString(value.implementationEffort),
    name: normalizeString(value.name),
    narrative: normalizeString(value.narrative),
    objective: normalizeString(value.objective),
    proposedSolution: normalizeString(value.proposedSolution),
    requirements: Array.isArray(value.requirements) ? clone(value.requirements) : [],
    sourceSessionId: normalizeString(value.sourceSessionId),
    stakeholders: Array.isArray(value.stakeholders) ? clone(value.stakeholders) : [],
    successMetrics: Array.isArray(value.successMetrics) ? clone(value.successMetrics) : [],
  };
}

function normalizeStoredProjectArtifactsState(value = {}) {
  return {
    artifacts: Array.isArray(value.artifacts) ? clone(value.artifacts) : [],
    brief: normalizeStoredProjectBrief(value.brief),
    updatedAt: value.updatedAt ?? null,
  };
}

function normalizeAssistantAutonomyMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'yolo' ? 'yolo' : 'review';
}

function normalizeAssistantSettings(value = {}) {
  const autonomyMode = String(value?.autonomyMode ?? '').trim().toLowerCase();
  const autonomyGrant = value?.autonomyGrant && typeof value.autonomyGrant === 'object'
    ? {
        expiresAt: normalizeString(value.autonomyGrant.expiresAt),
        toolNames: [...new Set((value.autonomyGrant.toolNames ?? []).map(normalizeString).filter(Boolean))],
      }
    : null;

  return {
    ...(autonomyMode === 'review' || autonomyMode === 'yolo' ? { autonomyMode } : {}),
    ...(autonomyGrant?.expiresAt && autonomyGrant.toolNames.length > 0 ? { autonomyGrant } : {}),
    autonomyPreferenceScope: 'user',
  };
}

function createEmptyProjectAssistantState() {
  return {
    artifacts: [],
    brief: {},
    clarifications: [],
    stakeholderContacts: [],
    stakeholders: [],
    updatedAt: null,
  };
}

function normalizeClarificationAssignment(input = {}) {
  const actorType = input.actorType === 'stakeholder' ? 'stakeholder' : 'user';
  const role = normalizeAssignmentRole(input.role);
  const actorId = normalizeString(input.actorId);

  return {
    actorId,
    actorType,
    id: normalizeRecordId(input.id),
    label: normalizeString(input.label),
    role,
  };
}

function normalizeClarificationComment(input = {}) {
  const deletedAt = normalizeDateValue(input.deletedAt, null);
  const body = deletedAt ? '' : normalizeString(input.body);
  return {
    actorId: normalizeString(input.actorId),
    actorType: input.actorType === 'stakeholder'
      ? 'stakeholder'
      : input.actorType === 'assistant'
        ? 'assistant'
        : 'user',
    authorName: normalizeString(input.authorName),
    body,
    createdAt: normalizeDateValue(input.createdAt, nowIso()),
    deletedAt,
    editedAt: normalizeDateValue(input.editedAt, null),
    id: normalizeRecordId(input.id),
    isDeleted: Boolean(deletedAt),
    parentCommentId: normalizePreferenceScopeValue(input.parentCommentId),
    reactionVotes: Array.isArray(input.reactionVotes) ? clone(input.reactionVotes) : [],
    upvotes: Number(input.upvotes ?? 0),
    downvotes: Number(input.downvotes ?? 0),
    currentReaction: input.currentReaction === 'down' ? 'down' : input.currentReaction === 'up' ? 'up' : null,
    source: normalizeString(input.source) || 'comment',
    updatedAt: normalizeDateValue(input.updatedAt ?? input.createdAt, nowIso()),
  };
}

/** A contact's name, email and role title after an edit; omitted fields keep their value. */
function stakeholderPatch(current, patch = {}) {
  return {
    email: patch.email !== undefined ? normalizeString(patch.email).toLowerCase() : current.email,
    name: patch.name !== undefined ? normalizeString(patch.name) : current.name,
    roleTitle: patch.roleTitle !== undefined ? normalizeString(patch.roleTitle) : current.roleTitle,
  };
}

function stakeholderEmailTaken() {
  return new HttpError(409, 'Another stakeholder on this project already uses that email.', { details: { code: 'stakeholder_email_taken' } });
}

function normalizeStakeholder(input = {}) {
  return {
    accessToken: normalizeString(input.accessToken) || buildPublicAccessToken(),
    createdAt: normalizeDateValue(input.createdAt, nowIso()),
    email: normalizeString(input.email).toLowerCase(),
    id: normalizeString(input.id) || randomUUID(),
    name: normalizeString(input.name),
    roleTitle: normalizeString(input.roleTitle),
    updatedAt: normalizeDateValue(input.updatedAt ?? input.createdAt, nowIso()),
  };
}

const CLARIFICATION_TRACKS = new Set(['experience', 'architecture']);

/** Track for a newly inserted clarification: the one asked for, or Experience. */
function newClarificationTrack(input = {}) {
  const track = normalizeString(input.track).toLowerCase();
  return CLARIFICATION_TRACKS.has(track) ? track : 'experience';
}

function normalizeClarificationRecord(input = {}) {
  const status = normalizeString(input.status) || 'open';
  const lifecycleState = CLARIFICATION_LIFECYCLE_STATES.has(normalizeString(input.lifecycleState))
    ? normalizeString(input.lifecycleState)
    : 'committed';
  return {
    blockingArea: normalizeString(input.blockingArea),
    createdAt: normalizeDateValue(input.createdAt, nowIso()),
    currentAnswer: normalizeString(input.currentAnswer),
    currentAnswerUpdatedAt: normalizeDateValue(input.currentAnswerUpdatedAt, null),
    id: normalizeRecordId(input.id),
    latestInboundSuggestedAnswer: normalizeString(input.latestInboundSuggestedAnswer),
    latestInboundSummary: normalizeString(input.latestInboundSummary),
    latestInboundSummaryCommentId: normalizePreferenceScopeValue(input.latestInboundSummaryCommentId),
    latestInboundSummaryUpdatedAt: normalizeDateValue(input.latestInboundSummaryUpdatedAt, null),
    lastActivityAt: normalizeDateValue(input.lastActivityAt ?? input.updatedAt ?? input.createdAt, nowIso()),
    lastAutoCommentActivityAt: normalizeDateValue(input.lastAutoCommentActivityAt, null),
    lastHumanActivityAt: normalizeDateValue(input.lastHumanActivityAt, null),
    lastReviewedActivityAt: normalizeDateValue(input.lastReviewedActivityAt, null),
    lifecycleState,
    linkedSection: ['brief', 'structure', 'clarifications'].includes(input.linkedSection) ? input.linkedSection : 'brief',
    prompt: normalizeString(input.prompt),
    proposedDraftImpact: normalizeString(input.proposedDraftImpact),
    rationale: normalizeString(input.rationale),
    status,
    updatedAt: normalizeDateValue(input.updatedAt ?? input.createdAt, nowIso()),
  };
}

function normalizeClarificationInvitation(input = {}) {
  const mailStatus = CLARIFICATION_MAIL_STATUSES.has(normalizeString(input.mailStatus))
    ? normalizeString(input.mailStatus)
    : 'pending';
  return {
    clarificationId: normalizeString(input.clarificationId),
    createdAt: normalizeDateValue(input.createdAt, nowIso()),
    deactivatedAt: normalizeDateValue(input.deactivatedAt, null),
    deliveryId: normalizeString(input.deliveryId) || null,
    id: normalizeString(input.id) || randomUUID(),
    invitationToken: normalizeString(input.invitationToken) || buildPublicAccessToken(),
    lastError: normalizeString(input.lastError),
    lastInboundAt: normalizeDateValue(input.lastInboundAt, null),
    lastProviderMessageId: normalizeString(input.lastProviderMessageId),
    mailStatus,
    projectId: normalizeString(input.projectId),
    queuedAt: normalizeDateValue(input.queuedAt, null),
    replyToken: normalizeString(input.replyToken) || buildClarificationReplyToken(),
    scheduledAt: normalizeDateValue(input.scheduledAt, null),
    sentAt: normalizeDateValue(input.sentAt, null),
    stakeholderId: normalizeString(input.stakeholderId),
    tenantId: normalizeString(input.tenantId),
    updatedAt: normalizeDateValue(input.updatedAt ?? input.createdAt, nowIso()),
  };
}

function normalizeClarificationEmailMessage(input = {}) {
  return {
    createdAt: normalizeDateValue(input.createdAt, nowIso()),
    direction: normalizeString(input.direction) === 'outbound' ? 'outbound' : 'inbound',
    fromEmail: normalizeString(input.fromEmail).toLowerCase(),
    id: normalizeString(input.id) || randomUUID(),
    inReplyTo: normalizeString(input.inReplyTo),
    invitationId: normalizeString(input.invitationId),
    normalizedBody: normalizeString(input.normalizedBody),
    processedAt: normalizeDateValue(input.processedAt, nowIso()),
    projectId: normalizeString(input.projectId),
    providerMessageId: normalizeString(input.providerMessageId),
    subject: normalizeString(input.subject),
    tenantId: normalizeString(input.tenantId),
    toEmail: normalizeString(input.toEmail).toLowerCase(),
    updatedAt: normalizeDateValue(input.updatedAt ?? input.createdAt, nowIso()),
  };
}

function normalizeOtherIntentReviewLog(input = {}) {
  return {
    classification: input.classification && typeof input.classification === 'object'
      ? clone(input.classification)
      : {},
    createdAt: normalizeDateValue(input.createdAt, nowIso()),
    id: normalizeString(input.id) || randomUUID(),
    latestUserMessage: normalizeString(input.latestUserMessage),
    previousUserMessages: Array.isArray(input.previousUserMessages)
      ? input.previousUserMessages.map((message) => normalizeString(message)).filter(Boolean)
      : [],
    projectId: normalizePreferenceScopeValue(input.projectId),
    projectName: normalizeString(input.projectName),
    sessionId: normalizeString(input.sessionId),
    tenantId: normalizeString(input.tenantId),
    userId: normalizeString(input.userId),
  };
}

function compareClarifications(left, right) {
  const createdDifference = comparableTime(left?.createdAt ?? left?.updatedAt) - comparableTime(right?.createdAt ?? right?.updatedAt);
  if (createdDifference !== 0) {
    return createdDifference;
  }

  const promptDifference = String(left?.prompt ?? '').localeCompare(String(right?.prompt ?? ''));
  if (promptDifference !== 0) {
    return promptDifference;
  }

  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

function compareAssignments(left, right) {
  const rankDifference = assignmentRoleRank(left.role) - assignmentRoleRank(right.role);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  return String(left.label ?? '').localeCompare(String(right.label ?? ''));
}

function compareStakeholders(left, right) {
  return String(left.name ?? '').localeCompare(String(right.name ?? ''));
}

function buildClarificationCommentTree(comments = []) {
  const byId = new Map();
  const roots = [];

  for (const comment of comments) {
    byId.set(comment.id, {
      ...comment,
      children: [],
    });
  }

  for (const comment of byId.values()) {
    if (comment.parentCommentId && byId.has(comment.parentCommentId)) {
      byId.get(comment.parentCommentId).children.push(comment);
    } else {
      roots.push(comment);
    }
  }

  return roots;
}

function pruneClarificationCommentTree(comments = []) {
  return (comments ?? []).reduce((pruned, comment) => {
    if (!comment) {
      return pruned;
    }

    const children = pruneClarificationCommentTree(comment.children ?? []);
    const hasChildren = children.length > 0;
    const hasReactions = Number(comment.upvotes ?? 0) > 0 || Number(comment.downvotes ?? 0) > 0;
    const isDeleted = Boolean(comment.deletedAt);

    if (isDeleted && !hasChildren && !hasReactions) {
      return pruned;
    }

    pruned.push({
      ...comment,
      children,
    });
    return pruned;
  }, []);
}

function flattenClarificationCommentTree(comments = []) {
  const flattened = [];

  for (const comment of comments ?? []) {
    if (!comment) {
      continue;
    }

    flattened.push(comment);
    if (Array.isArray(comment.children) && comment.children.length > 0) {
      flattened.push(...flattenClarificationCommentTree(comment.children));
    }
  }

  return flattened.sort((left, right) => comparableTime(left.createdAt) - comparableTime(right.createdAt));
}

function normalizeSession(value = {}) {
  const deletedAt = normalizeDateValue(value.deletedAt, null);
  return {
    agentTasks: Array.isArray(value.agentTasks) ? clone(value.agentTasks) : [],
    appliedActions: Array.isArray(value.appliedActions) ? clone(value.appliedActions) : [],
    approvals: {
      brief: Boolean(value.approvals?.brief),
      clarifications: Boolean(value.approvals?.clarifications),
      structure: Boolean(value.approvals?.structure),
    },
    artifacts: Array.isArray(value.artifacts) ? clone(value.artifacts) : [],
    autonomyMode: normalizeAssistantAutonomyMode(value.autonomyMode),
    autonomyGrant: value.autonomyGrant && typeof value.autonomyGrant === 'object' ? clone(value.autonomyGrant) : null,
    autonomyPreferenceScope: 'user',
    citations: Array.isArray(value.citations) ? clone(value.citations) : [],
    conversation: Array.isArray(value.conversation) ? clone(value.conversation) : [],
    createdAt: value.createdAt ?? nowIso(),
    deletedAt,
    draft: clone(value.draft ?? {
      brief: {},
      clarifications: [],
      structure: { epics: [] },
    }),
    goal: normalizeString(value.goal),
    id: value.id,
    lastMessagePreview: normalizeString(value.lastMessagePreview),
    lastAppliedClarificationIds: Array.isArray(value.lastAppliedClarificationIds) ? [...value.lastAppliedClarificationIds] : [],
    lastSyncedProjectUpdatedAt: value.lastSyncedProjectUpdatedAt ?? null,
    liveRunState: normalizeSessionLiveRunState(value.liveRunState),
    mode: value.mode ?? 'create-project',
    projectBaselineUpdatedAt: value.projectBaselineUpdatedAt ?? null,
    projectId: value.projectId ?? null,
    planNodes: Array.isArray(value.planNodes) ? clone(value.planNodes) : [],
    proposedActions: Array.isArray(value.proposedActions) ? clone(value.proposedActions) : [],
    rejectedActions: Array.isArray(value.rejectedActions) ? clone(value.rejectedActions) : [],
    rebaseNotice: value.rebaseNotice ? clone(value.rebaseNotice) : null,
    review: value.review ? clone(value.review) : {
      clarifications: {
        items: [],
        selection: 'pending',
      },
      stakeholders: {
        items: [],
        selection: 'pending',
      },
      structure: {
        nodes: [],
        selection: 'pending',
      },
    },
    reviewBaseline: value.reviewBaseline ? clone(value.reviewBaseline) : {
      brief: {},
      clarifications: [],
      structure: { epics: [] },
    },
    reviewSelections: {
      brief: ['approved', 'rejected', 'pending'].includes(String(value.reviewSelections?.brief ?? '').trim())
        ? String(value.reviewSelections.brief).trim()
        : 'pending',
      clarifications: value.reviewSelections?.clarifications && typeof value.reviewSelections.clarifications === 'object'
        ? clone(value.reviewSelections.clarifications)
        : {},
      stakeholders: value.reviewSelections?.stakeholders && typeof value.reviewSelections.stakeholders === 'object'
        ? clone(value.reviewSelections.stakeholders)
        : {},
      structure: value.reviewSelections?.structure && typeof value.reviewSelections.structure === 'object'
        ? clone(value.reviewSelections.structure)
        : {},
    },
    researchFindings: Array.isArray(value.researchFindings) ? clone(value.researchFindings) : [],
    run: value.run ? clone(value.run) : null,
    runPreference: value.runPreference && typeof value.runPreference === 'object'
      ? clone(value.runPreference)
      : null,
    stakeholderContacts: Array.isArray(value.stakeholderContacts) ? clone(value.stakeholderContacts) : [],
    status: value.status ?? 'draft',
    tenantId: value.tenantId,
    title: normalizeString(value.title),
    titleSource: normalizeString(value.titleSource) || 'auto',
    toolEvents: Array.isArray(value.toolEvents) ? clone(value.toolEvents) : [],
    updatedAt: value.updatedAt ?? nowIso(),
    userId: value.userId,
    warnings: Array.isArray(value.warnings) ? clone(value.warnings) : [],
  };
}

function sessionPreferenceRank(session = {}) {
  let rank = 0;

  if (session.mode === 'project-context') {
    rank += 8;
  }

  if (normalizePreferenceScopeValue(session.projectId)) {
    rank += 4;
  }

  if (session.status === 'committed') {
    rank += 2;
  }

  return rank;
}

function compareSessionPreferencePriority(left, right) {
  const rankDifference = sessionPreferenceRank(right) - sessionPreferenceRank(left);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  return String(right?.updatedAt ?? '').localeCompare(String(left?.updatedAt ?? ''));
}

function sortSessionsByPreferencePriority(sessions = []) {
  return [...sessions].sort(compareSessionPreferencePriority);
}

function dedupeSessionsById(sessions = []) {
  const unique = [];
  const seen = new Set();

  for (const session of sortSessionsByPreferencePriority(sessions).filter(Boolean)) {
    if (!session?.id || seen.has(session.id)) {
      continue;
    }

    seen.add(session.id);
    unique.push(session);
  }

  return unique;
}

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getPreference(executor, { key, projectId = null, tenantId, userId = null }) {
  const normalizedUserId = normalizePreferenceScopeValue(userId);
  const normalizedProjectId = normalizePreferenceScopeValue(projectId);
  const [rows] = await executor.execute(
    `
      SELECT value
      FROM preferences
      WHERE tenant_id = ?
        AND user_id <=> ?
        AND project_id <=> ?
        AND \`key\` = ?
      LIMIT 1
    `,
    [tenantId, normalizedUserId, normalizedProjectId, key],
  );

  return rows[0]?.value ?? '';
}

async function upsertPreference(executor, { key, projectId = null, tenantId, userId = null, value }) {
  const normalizedUserId = normalizePreferenceScopeValue(userId);
  const normalizedProjectId = normalizePreferenceScopeValue(projectId);
  const [rows] = await executor.execute(
    `
      SELECT id
      FROM preferences
      WHERE tenant_id = ?
        AND user_id <=> ?
        AND project_id <=> ?
        AND \`key\` = ?
      LIMIT 1
    `,
    [tenantId, normalizedUserId, normalizedProjectId, key],
  );

  if (rows[0]?.id) {
    await executor.execute(
      'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
      [value, rows[0].id],
    );
    return rows[0].id;
  }

  const id = randomUUID();
  await executor.execute(
    `
      INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `,
    [id, tenantId, normalizedUserId, normalizedProjectId, key, value],
  );
  return id;
}

async function deletePreferencesByKeys(executor, { keys, tenantId, userId = null }) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return;
  }

  const normalizedUserId = normalizePreferenceScopeValue(userId);
  const placeholders = keys.map(() => '?').join(', ');
  await executor.execute(
    `
      DELETE FROM preferences
      WHERE tenant_id = ?
        AND user_id <=> ?
        AND \`key\` IN (${placeholders})
    `,
    [tenantId, normalizedUserId, ...keys],
  );
}

async function deleteLatestSessionPointersForSession(executor, { sessionId, tenantId, userId = null }) {
  const normalizedUserId = normalizePreferenceScopeValue(userId);
  const [rows] = await executor.execute(
    `
      SELECT id, value
      FROM preferences
      WHERE tenant_id = ?
        AND user_id <=> ?
        AND (\`key\` LIKE ? OR \`key\` LIKE ?)
    `,
    [tenantId, normalizedUserId, `${ASSISTANT_LATEST_SESSION_KEY_PREFIX}%`, `${LEGACY_ASSISTANT_LATEST_SESSION_KEY_PREFIX}%`],
  );

  for (const row of rows) {
    const pointer = safeJsonParse(row.value, null);
    if (pointer?.sessionId !== sessionId) {
      continue;
    }

    await executor.execute(
      'DELETE FROM preferences WHERE id = ?',
      [row.id],
    );
  }
}

async function listStoredSessions(executor, { sessionId = null, tenantId, userId }) {
  const predicates = [
    'tenant_id = ?',
  ];
  const params = [tenantId];

  if (userId !== undefined && userId !== null && String(userId).trim()) {
    predicates.push('user_id <=> ?');
    params.push(normalizePreferenceScopeValue(userId));
  }

  predicates.push('(`key` LIKE ? OR `key` LIKE ?)');
  params.push(`${ASSISTANT_SESSION_KEY_PREFIX}%`, `${LEGACY_ASSISTANT_SESSION_KEY_PREFIX}%`);

  if (sessionId) {
    predicates.push('(`key` = ? OR `key` = ?)');
    params.push(buildAssistantSessionKey(sessionId), buildLegacyAssistantSessionKey(sessionId));
  }

  const [rows] = await executor.execute(
    `
      SELECT \`key\`, value, updated_at
      FROM preferences
      WHERE ${predicates.join('\n        AND ')}
      ORDER BY updated_at DESC
    `,
    params,
  );

  return dedupeSessionsById(
    rows
      .map((row) => normalizeSession(safeJsonParse(row.value, null)))
      .filter((session) => session && !session.deletedAt),
  );
}

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [tableName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function primaryKeyColumns(executor, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT COLUMN_NAME AS columnName
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `,
    [tableName],
  );

  return rows.map((row) => String(row.columnName ?? '').trim()).filter(Boolean);
}

export async function ensureMysqlClarificationSchema(executor) {
  if (!await tableExists(executor, 'project_stakeholders')) {
    await executor.execute(
      `
        CREATE TABLE project_stakeholders (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL,
          role_title VARCHAR(160) NULL,
          access_token VARCHAR(120) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_project_stakeholders_project_email (project_id, email),
          UNIQUE KEY uq_project_stakeholders_access_token (access_token),
          KEY idx_project_stakeholders_project (project_id),
          KEY idx_project_stakeholders_tenant (tenant_id)
        )
      `,
    );
  }

  if (!await tableExists(executor, 'project_clarifications')) {
    await executor.execute(
      `
        CREATE TABLE project_clarifications (
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          id VARCHAR(36) NOT NULL,
          linked_section VARCHAR(32) NOT NULL,
          blocking_area VARCHAR(160) NOT NULL,
          prompt TEXT NOT NULL,
          rationale TEXT NOT NULL,
          proposed_draft_impact TEXT NOT NULL,
          lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'committed',
          clarification_status VARCHAR(32) NOT NULL DEFAULT 'open',
          current_answer MEDIUMTEXT NULL,
          current_answer_updated_at DATETIME NULL,
          latest_inbound_summary MEDIUMTEXT NULL,
          latest_inbound_suggested_answer MEDIUMTEXT NULL,
          latest_inbound_summary_comment_id VARCHAR(36) NULL,
          latest_inbound_summary_updated_at DATETIME NULL,
          last_activity_at DATETIME NULL,
          last_human_activity_at DATETIME NULL,
          last_reviewed_activity_at DATETIME NULL,
          last_auto_comment_activity_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, project_id, id),
          KEY idx_project_clarifications_project (project_id),
          KEY idx_project_clarifications_tenant (tenant_id),
          KEY idx_project_clarifications_status (clarification_status)
        )
      `,
    );
  } else if (!await columnExists(executor, 'project_clarifications', 'lifecycle_state')) {
    await executor.execute(
      `
        ALTER TABLE project_clarifications
        ADD COLUMN lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'committed'
        AFTER proposed_draft_impact
      `,
    );
  }

  const clarificationPrimaryKey = await primaryKeyColumns(executor, 'project_clarifications');
  if (clarificationPrimaryKey.join(',') !== 'tenant_id,project_id,id') {
    await executor.execute(
      `
        ALTER TABLE project_clarifications
        DROP PRIMARY KEY,
        ADD PRIMARY KEY (tenant_id, project_id, id)
      `,
    );
  }

  if (!await tableExists(executor, 'project_clarification_assignments')) {
    await executor.execute(
      `
        CREATE TABLE project_clarification_assignments (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          clarification_id VARCHAR(36) NOT NULL,
          actor_type VARCHAR(24) NOT NULL,
          actor_id VARCHAR(36) NOT NULL,
          actor_label VARCHAR(255) NOT NULL,
          assignment_role VARCHAR(24) NOT NULL DEFAULT 'collaborator',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_project_clarification_assignments_project (project_id),
          KEY idx_project_clarification_assignments_clarification (clarification_id)
        )
      `,
    );
  }

  if (!await columnExists(executor, 'project_clarifications', 'latest_inbound_summary')) {
    await executor.execute(
      `
        ALTER TABLE project_clarifications
        ADD COLUMN latest_inbound_summary MEDIUMTEXT NULL
        AFTER current_answer_updated_at
      `,
    );
  }

  if (!await columnExists(executor, 'project_clarifications', 'latest_inbound_suggested_answer')) {
    await executor.execute(
      `
        ALTER TABLE project_clarifications
        ADD COLUMN latest_inbound_suggested_answer MEDIUMTEXT NULL
        AFTER latest_inbound_summary
      `,
    );
  }

  if (!await columnExists(executor, 'project_clarifications', 'latest_inbound_summary_comment_id')) {
    await executor.execute(
      `
        ALTER TABLE project_clarifications
        ADD COLUMN latest_inbound_summary_comment_id VARCHAR(36) NULL
        AFTER latest_inbound_suggested_answer
      `,
    );
  }

  if (!await columnExists(executor, 'project_clarifications', 'latest_inbound_summary_updated_at')) {
    await executor.execute(
      `
        ALTER TABLE project_clarifications
        ADD COLUMN latest_inbound_summary_updated_at DATETIME NULL
        AFTER latest_inbound_summary_comment_id
      `,
    );
  }

  if (!await tableExists(executor, 'project_clarification_comments')) {
    await executor.execute(
      `
        CREATE TABLE project_clarification_comments (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          clarification_id VARCHAR(36) NOT NULL,
          parent_comment_id VARCHAR(36) NULL,
          actor_type VARCHAR(24) NOT NULL,
          actor_id VARCHAR(36) NULL,
          actor_label VARCHAR(255) NOT NULL,
          comment_body MEDIUMTEXT NOT NULL,
          comment_source VARCHAR(32) NOT NULL DEFAULT 'comment',
          edited_at DATETIME NULL,
          deleted_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_project_clarification_comments_project (project_id),
          KEY idx_project_clarification_comments_clarification (clarification_id)
        )
      `,
    );
  } else if (!await columnExists(executor, 'project_clarification_comments', 'parent_comment_id')) {
    await executor.execute(
      `
        ALTER TABLE project_clarification_comments
        ADD COLUMN parent_comment_id VARCHAR(36) NULL
        AFTER clarification_id
      `,
    );
  }

  if (!await columnExists(executor, 'project_clarification_comments', 'edited_at')) {
    await executor.execute(
      `
        ALTER TABLE project_clarification_comments
        ADD COLUMN edited_at DATETIME NULL
        AFTER comment_source
      `,
    );
  }

  if (!await columnExists(executor, 'project_clarification_comments', 'deleted_at')) {
    await executor.execute(
      `
        ALTER TABLE project_clarification_comments
        ADD COLUMN deleted_at DATETIME NULL
        AFTER edited_at
      `,
    );
  }

  if (!await tableExists(executor, 'project_clarification_comment_reactions')) {
    await executor.execute(
      `
        CREATE TABLE project_clarification_comment_reactions (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          clarification_id VARCHAR(36) NOT NULL,
          comment_id VARCHAR(36) NOT NULL,
          actor_type VARCHAR(24) NOT NULL,
          actor_id VARCHAR(36) NOT NULL,
          reaction VARCHAR(16) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_project_clarification_comment_reaction_actor (tenant_id, project_id, comment_id, actor_type, actor_id),
          KEY idx_project_clarification_comment_reactions_comment (comment_id),
          KEY idx_project_clarification_comment_reactions_clarification (clarification_id)
        )
      `,
    );
  }

  if (!await tableExists(executor, 'project_clarification_invitations')) {
    await executor.execute(
      `
        CREATE TABLE project_clarification_invitations (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          clarification_id VARCHAR(36) NOT NULL,
          stakeholder_id VARCHAR(36) NOT NULL,
          invitation_token VARCHAR(120) NOT NULL,
          reply_token VARCHAR(120) NOT NULL,
          mail_status VARCHAR(24) NOT NULL DEFAULT 'pending',
          queued_at DATETIME NULL,
          sent_at DATETIME NULL,
          last_inbound_at DATETIME NULL,
          last_provider_message_id VARCHAR(255) NULL,
          last_error TEXT NULL,
          deactivated_at DATETIME NULL,
          scheduled_at DATETIME(3) NULL,
          delivery_id VARCHAR(36) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_project_clarification_invitations_token (invitation_token),
          UNIQUE KEY uq_project_clarification_reply_token (reply_token),
          KEY idx_project_clarification_invitations_scope (tenant_id, project_id, clarification_id),
          KEY idx_project_clarification_invitations_stakeholder (stakeholder_id)
        )
      `,
    );
  } else {
    // Digest state (clarification-invitation-digest.store.js), added in place on older schemas.
    for (const [column, definition] of [['scheduled_at', 'DATETIME(3) NULL'], ['delivery_id', 'VARCHAR(36) NULL']]) {
      if (!await columnExists(executor, 'project_clarification_invitations', column)) {
        await executor.execute(`ALTER TABLE project_clarification_invitations ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  // One digest delivery per tenant, project and stakeholder (clarification-invitation-digest.store.js).
  if (!await tableExists(executor, 'project_clarification_invitation_digests')) {
    await executor.execute(
      `
        CREATE TABLE project_clarification_invitation_digests (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          stakeholder_id VARCHAR(36) NOT NULL,
          claim_token VARCHAR(36) NULL,
          claimed_until DATETIME(3) NULL,
          send_started_at DATETIME(3) NULL,
          attempts INT NOT NULL DEFAULT 0,
          next_attempt_at DATETIME(3) NULL,
          last_error TEXT NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY uq_project_clarification_invitation_digests_recipient (tenant_id, project_id, stakeholder_id)
        )
      `,
    );
  }

  if (!await tableExists(executor, 'project_clarification_email_messages')) {
    await executor.execute(
      `
        CREATE TABLE project_clarification_email_messages (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NOT NULL,
          invitation_id VARCHAR(36) NOT NULL,
          provider_message_id VARCHAR(255) NOT NULL,
          message_direction VARCHAR(24) NOT NULL,
          from_email VARCHAR(255) NOT NULL,
          to_email VARCHAR(255) NOT NULL,
          subject VARCHAR(255) NULL,
          normalized_body MEDIUMTEXT NULL,
          in_reply_to VARCHAR(255) NULL,
          processed_at DATETIME NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_project_clarification_email_messages_provider (invitation_id, provider_message_id),
          KEY idx_project_clarification_email_messages_scope (tenant_id, project_id, invitation_id)
        )
      `,
    );
  }

  if (!await tableExists(executor, 'assistant_other_intent_logs')) {
    await executor.execute(
      `
        CREATE TABLE assistant_other_intent_logs (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          user_id VARCHAR(36) NOT NULL,
          session_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NULL,
          project_name VARCHAR(255) NULL,
          latest_user_message MEDIUMTEXT NOT NULL,
          previous_user_messages_json MEDIUMTEXT NOT NULL,
          classification_json MEDIUMTEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_assistant_other_intent_logs_tenant_created (tenant_id, created_at),
          KEY idx_assistant_other_intent_logs_session (session_id),
          KEY idx_assistant_other_intent_logs_project (project_id)
        )
      `,
    );
  }
}

function createEmptyProjectStateMaps() {
  return {
    projectArtifactStates: new Map(),
    projectClarificationAssignments: [],
    projectClarificationComments: [],
    projectClarificationCommentReactions: [],
    projectClarificationEmailMessages: [],
    projectClarificationInvitations: [],
    projectClarifications: [],
    projectStakeholders: [],
    otherIntentReviewLogs: [],
  };
}

function projectScopeMatch(record, { projectId, tenantId }) {
  return record.projectId === projectId && record.tenantId === tenantId;
}

function buildProjectClarificationViews({
  clarifications = [],
  assignments = [],
  comments = [],
  invitations = [],
  reactions = [],
  stakeholders = [],
}) {
  const stakeholderById = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  const invitationByAssignmentKey = new Map();
  const reactionVotesByCommentId = new Map();

  for (const invitation of invitations ?? []) {
    if (invitation.deactivatedAt) {
      continue;
    }
    invitationByAssignmentKey.set(`${invitation.clarificationId}:${invitation.stakeholderId}`, invitation);
  }

  for (const reaction of reactions ?? []) {
    const commentId = String(reaction?.commentId ?? '').trim();
    if (!commentId) {
      continue;
    }
    const existing = reactionVotesByCommentId.get(commentId) ?? [];
    existing.push({
      actorId: normalizeString(reaction.actorId),
      actorType: reaction.actorType === 'stakeholder' ? 'stakeholder' : 'user',
      reaction: reaction.reaction === 'down' ? 'down' : 'up',
    });
    reactionVotesByCommentId.set(commentId, existing);
  }

  return clarifications
    .map((clarification) => {
      const clarificationAssignments = assignments
        .filter((assignment) => assignment.clarificationId === clarification.id)
        .map((assignment) => {
          const stakeholder = assignment.actorType === 'stakeholder'
            ? stakeholderById.get(assignment.actorId) ?? null
            : null;
          const invitation = assignment.actorType === 'stakeholder'
            ? invitationByAssignmentKey.get(`${assignment.clarificationId}:${assignment.actorId}`) ?? null
            : null;

          return {
            actorId: assignment.actorId,
            actorType: assignment.actorType,
            accessToken: stakeholder?.accessToken ?? '',
            id: assignment.id,
            invitationToken: invitation?.invitationToken ?? '',
            label: assignment.label,
            lastInboundAt: invitation?.lastInboundAt ?? null,
            mailStatus: invitation?.mailStatus ?? '',
            queuedAt: invitation?.queuedAt ?? null,
            replyToken: invitation?.replyToken ?? '',
            role: assignment.role,
            scheduledAt: invitation?.scheduledAt ?? null,
            sentAt: invitation?.sentAt ?? null,
          };
        })
        .sort(compareAssignments);

      const clarificationComments = comments
        .filter((comment) => comment.clarificationId === clarification.id)
        .map((comment) => ({
          actorId: comment.actorId,
          actorType: comment.actorType,
          authorName: comment.authorName,
          body: comment.body,
          createdAt: comment.createdAt,
          deletedAt: comment.deletedAt ?? null,
          editedAt: comment.editedAt ?? null,
          id: comment.id,
          isDeleted: Boolean(comment.deletedAt),
          parentCommentId: comment.parentCommentId ?? null,
          reactionVotes: clone(reactionVotesByCommentId.get(comment.id) ?? []),
          upvotes: (reactionVotesByCommentId.get(comment.id) ?? []).filter((reaction) => reaction.reaction === 'up').length,
          downvotes: (reactionVotesByCommentId.get(comment.id) ?? []).filter((reaction) => reaction.reaction === 'down').length,
          source: comment.source,
          updatedAt: comment.updatedAt,
        }))
        .sort((left, right) => comparableTime(left.createdAt) - comparableTime(right.createdAt));
      const threadedComments = pruneClarificationCommentTree(
        buildClarificationCommentTree(clarificationComments),
      );
      const visibleComments = flattenClarificationCommentTree(threadedComments);

      const primaryAssignment = clarificationAssignments.find((assignment) => assignment.role === 'primary') ?? null;

      return {
        answerThread: visibleComments,
        assigneeActorType: primaryAssignment?.actorType ?? 'user',
        assigneeId: primaryAssignment?.actorId ?? '',
        assigneeLabel: primaryAssignment?.label ?? '',
        blockingArea: clarification.blockingArea,
        commentCount: visibleComments.length,
        comments: threadedComments,
        createdAt: clarification.createdAt,
        currentAnswer: clarification.currentAnswer,
        currentAnswerUpdatedAt: clarification.currentAnswerUpdatedAt,
        id: clarification.id,
        latestInboundSuggestedAnswer: clarification.latestInboundSuggestedAnswer,
        latestInboundSummary: clarification.latestInboundSummary,
        latestInboundSummaryCommentId: clarification.latestInboundSummaryCommentId,
        latestInboundSummaryUpdatedAt: clarification.latestInboundSummaryUpdatedAt,
        lastActivityAt: clarification.lastActivityAt,
        lastAutoCommentActivityAt: clarification.lastAutoCommentActivityAt,
        lastHumanActivityAt: clarification.lastHumanActivityAt,
        lastReviewedActivityAt: clarification.lastReviewedActivityAt,
        lifecycleState: clarification.lifecycleState,
        linkedSection: clarification.linkedSection,
        primaryAssignment,
        prompt: clarification.prompt,
        proposedDraftImpact: clarification.proposedDraftImpact,
        rationale: clarification.rationale,
        status: clarification.status,
        updatedAt: clarification.updatedAt,
        assignments: clarificationAssignments,
      };
    })
    .sort(compareClarifications);
}

function buildStakeholderFallbackForInvitation(invitation, clarifications = []) {
  const stakeholderId = normalizeString(invitation?.stakeholderId);
  if (!stakeholderId) {
    return null;
  }

  const assignment = (clarifications ?? [])
    .flatMap((clarification) => clarification?.assignments ?? [])
    .find((item) => item?.actorType === 'stakeholder' && item?.actorId === stakeholderId) ?? null;

  return {
    accessToken: normalizeString(assignment?.accessToken),
    createdAt: normalizeDateValue(invitation?.createdAt, nowIso()),
    email: '',
    id: stakeholderId,
    name: normalizeString(assignment?.label) || 'Stakeholder',
    projectId: normalizeString(invitation?.projectId),
    roleTitle: '',
    tenantId: normalizeString(invitation?.tenantId),
    updatedAt: normalizeDateValue(invitation?.updatedAt ?? invitation?.createdAt, nowIso()),
  };
}

// Requirements topics (clarifications with a track) are reachable only through the
// client portal, whose links expire and can be revoked. The older portal's tokens
// never expire, so it must not show or act on them: they are filtered out here, and an
// older invitation token issued for a tracked topic resolves to nothing. The bridge is
// attached by createApp; without it this is a no-op.
async function excludeRequirementsTopics(repository, accessContext, invitation = null) {
  const bridge = repository?.requirementsBridge;
  if (!accessContext || !bridge?.listTrackedTopicIds) {
    return accessContext;
  }

  const trackedIds = await bridge.listTrackedTopicIds({
    projectId: accessContext.projectId,
    tenantId: accessContext.tenantId,
  });
  if (trackedIds.size === 0) {
    return accessContext;
  }
  if (invitation?.clarificationId && trackedIds.has(invitation.clarificationId)) {
    return null;
  }

  return {
    ...accessContext,
    clarifications: accessContext.clarifications.filter((clarification) => !trackedIds.has(clarification.id)),
    focusClarificationId: trackedIds.has(accessContext.focusClarificationId) ? null : accessContext.focusClarificationId,
  };
}

function buildCompatibilityAccessResult({ accessContext, artifactsState }) {
  const firstClarification = accessContext.clarifications[0] ?? null;
  if (!firstClarification) {
    return null;
  }

  return {
    clarification: clone(firstClarification),
    focusClarificationId: accessContext.focusClarificationId ?? null,
    projectId: accessContext.projectId,
    state: {
      artifacts: clone(artifactsState.artifacts ?? []),
      clarifications: clone(accessContext.clarifications),
      stakeholderContacts: clone(accessContext.stakeholders),
      stakeholders: clone(accessContext.stakeholders),
      updatedAt: artifactsState.updatedAt ?? null,
    },
    tenantId: accessContext.tenantId,
  };
}

export function createInMemoryAssistantRepository() {
  const state = {
    latestSessions: new Map(),
    sessions: new Map(),
    userSettings: new Map(),
    ...createEmptyProjectStateMaps(),
  };

  function projectArtifacts(projectId, tenantId) {
    return normalizeStoredProjectArtifactsState(
      state.projectArtifactStates.get(projectStateKey({ projectId, tenantId })) ?? createEmptyProjectArtifactsState(),
    );
  }

  function setProjectArtifacts(projectId, tenantId, value, briefUpdate) {
    const existing = projectArtifacts(projectId, tenantId);
    const normalized = mergeProjectArtifacts(existing, value, briefUpdate);
    state.projectArtifactStates.set(projectStateKey({ projectId, tenantId }), normalized);
    return normalized;
  }

  function scopedStakeholders({ projectId, tenantId }) {
    return state.projectStakeholders
      .filter((stakeholder) => projectScopeMatch(stakeholder, { projectId, tenantId }))
      .map((stakeholder) => clone(stakeholder))
      .sort(compareStakeholders);
  }

  function scopedClarificationRecords({ projectId, tenantId }) {
    return state.projectClarifications
      .filter((clarification) => projectScopeMatch(clarification, { projectId, tenantId }))
      .map((clarification) => clone(clarification));
  }

  function scopedAssignments({ projectId, tenantId }) {
    return state.projectClarificationAssignments
      .filter((assignment) => projectScopeMatch(assignment, { projectId, tenantId }))
      .map((assignment) => clone(assignment));
  }

  function scopedComments({ projectId, tenantId }) {
    return state.projectClarificationComments
      .filter((comment) => projectScopeMatch(comment, { projectId, tenantId }))
      .map((comment) => clone(comment));
  }

  function scopedInvitations({ projectId, tenantId }) {
    return state.projectClarificationInvitations
      .filter((invitation) => projectScopeMatch(invitation, { projectId, tenantId }))
      .map((invitation) => clone(invitation));
  }

  function scopedEmailMessages({ projectId, tenantId }) {
    return state.projectClarificationEmailMessages
      .filter((message) => projectScopeMatch(message, { projectId, tenantId }))
      .map((message) => clone(message));
  }

  function scopedCommentReactions({ projectId, tenantId }) {
    return state.projectClarificationCommentReactions
      .filter((reaction) => projectScopeMatch(reaction, { projectId, tenantId }))
      .map((reaction) => clone(reaction));
  }

  function stakeholderForAccessToken(accessToken) {
    return state.projectStakeholders.find((stakeholder) => stakeholder.accessToken === accessToken) ?? null;
  }

  function invitationForAccessToken(accessToken) {
    return state.projectClarificationInvitations.find((invitation) => {
      return invitation.invitationToken === accessToken
        && !invitation.deactivatedAt;
    }) ?? null;
  }

  function invitationForReplyToken(replyToken) {
    return state.projectClarificationInvitations.find((invitation) => {
      return invitation.replyToken === replyToken
        && !invitation.deactivatedAt;
    }) ?? null;
  }

  function buildClarificationViewsForProject({ projectId, tenantId }) {
    return buildProjectClarificationViews({
      assignments: scopedAssignments({ projectId, tenantId }),
      clarifications: scopedClarificationRecords({ projectId, tenantId }),
      comments: scopedComments({ projectId, tenantId }),
      invitations: scopedInvitations({ projectId, tenantId }),
      reactions: scopedCommentReactions({ projectId, tenantId }),
      stakeholders: scopedStakeholders({ projectId, tenantId }),
    });
  }

  function resolveStakeholderRecord({ input, projectId, tenantId }) {
    const normalizedInput = normalizeStakeholder(input);
    const existingById = state.projectStakeholders.find((stakeholder) => {
      return stakeholder.id === normalizedInput.id
        && projectScopeMatch(stakeholder, { projectId, tenantId });
    }) ?? null;
    const existingByEmail = state.projectStakeholders.find((stakeholder) => {
      return stakeholder.email === normalizedInput.email
        && projectScopeMatch(stakeholder, { projectId, tenantId });
    }) ?? null;
    const existing = existingById ?? existingByEmail;
    const saved = {
      ...normalizeStakeholder(existing ?? normalizedInput),
      email: normalizedInput.email,
      name: normalizedInput.name,
      projectId,
      roleTitle: normalizedInput.roleTitle,
      tenantId,
      updatedAt: nowIso(),
    };

    if (!existing) {
      saved.createdAt = normalizedInput.createdAt ?? saved.updatedAt;
      state.projectStakeholders.push(saved);
      return clone(saved);
    }

    Object.assign(existing, saved);
    return clone(existing);
  }

  function replaceAssignmentsForClarification({ assignments = [], clarificationId, projectId, tenantId }) {
    state.projectClarificationAssignments = state.projectClarificationAssignments
      .filter((assignment) => !(assignment.clarificationId === clarificationId && projectScopeMatch(assignment, { projectId, tenantId })));

    for (const assignment of assignments) {
      const normalized = normalizeClarificationAssignment(assignment);
      if (!normalized.actorId) {
        continue;
      }

      state.projectClarificationAssignments.push({
        actorId: normalized.actorId,
        actorType: normalized.actorType,
        clarificationId,
        createdAt: nowIso(),
        id: normalized.id,
        label: normalized.label,
        projectId,
        role: normalized.role,
        tenantId,
        updatedAt: nowIso(),
      });
    }
  }

  function syncClarificationInvitationsForStakeholders({
    clarificationId,
    projectId,
    stakeholderIds = [],
    tenantId,
  }) {
    const activeStakeholderIds = new Set(
      stakeholderIds.map((value) => String(value ?? '').trim()).filter(Boolean),
    );
    const now = nowIso();
    const invitationsToSend = [];

    for (const invitation of state.projectClarificationInvitations) {
      if (!projectScopeMatch(invitation, { projectId, tenantId }) || invitation.clarificationId !== clarificationId) {
        continue;
      }

      if (invitation.deactivatedAt || activeStakeholderIds.has(invitation.stakeholderId)) {
        continue;
      }

      invitation.deactivatedAt = now;
      invitation.updatedAt = now;
    }

    for (const stakeholderId of activeStakeholderIds) {
      const existingActive = state.projectClarificationInvitations.find((invitation) => {
        return invitation.clarificationId === clarificationId
          && invitation.stakeholderId === stakeholderId
          && projectScopeMatch(invitation, { projectId, tenantId })
          && !invitation.deactivatedAt;
      }) ?? null;

      if (existingActive) {
        continue;
      }

      const invitation = normalizeClarificationInvitation({
        clarificationId,
        createdAt: now,
        deactivatedAt: null,
        mailStatus: 'pending',
        projectId,
        stakeholderId,
        tenantId,
        updatedAt: now,
      });
      state.projectClarificationInvitations.push(invitation);
      invitationsToSend.push(clone(invitation));
    }

    return invitationsToSend;
  }

  return {
    state,
    ...createInMemoryInvitationDigestStore(state, { clone, normalize: normalizeClarificationInvitation }),
    async createSession(session) {
      const normalized = normalizeSession(session);
      state.sessions.set(normalized.id, normalized);
      if (normalized.deletedAt) {
        state.latestSessions.delete(sessionContextKey(normalized));
      } else {
        state.latestSessions.set(sessionContextKey(normalized), normalized.id);
      }
      return clone(normalized);
    },
    async getSession({ sessionId, tenantId, userId }) {
      const stored = state.sessions.get(sessionId);
      if (
        !stored
        || stored.deletedAt
        || stored.tenantId !== tenantId
        || (
          userId !== undefined
          && userId !== null
          && String(userId).trim()
          && stored.userId !== userId
        )
      ) {
        return null;
      }

      return clone(stored);
    },
    async findLatestSession({ mode, projectId = '', tenantId, userId }) {
      const sessionId = state.latestSessions.get(sessionContextKey({ mode, projectId, tenantId, userId }));
      if (!sessionId) {
        return null;
      }

      return this.getSession({ sessionId, tenantId, userId });
    },
    async saveSession(session) {
      const normalized = normalizeSession(session);
      state.sessions.set(normalized.id, normalized);
      if (normalized.deletedAt) {
        state.latestSessions.delete(sessionContextKey(normalized));
      } else {
        state.latestSessions.set(sessionContextKey(normalized), normalized.id);
      }
      return clone(normalized);
    },
    async listSessions({ tenantId, userId }) {
      return [...state.sessions.values()]
        .filter((session) => !session.deletedAt && session.tenantId === tenantId && session.userId === userId)
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
        .map((session) => clone(session));
    },
    async listActiveRunSessions({ limit = 100 } = {}) {
      return [...state.sessions.values()]
        .filter((session) => !session.deletedAt && sessionHasActiveRun(session))
        .sort((left, right) => comparableTime(right.updatedAt) - comparableTime(left.updatedAt))
        .slice(0, Math.max(1, Number(limit) || 100))
        .map((session) => clone(session));
    },
    async getUserSettings({ tenantId, userId }) {
      const key = `${tenantId}:${userId}`;
      return normalizeAssistantSettings(state.userSettings.get(key) ?? {});
    },
    async saveUserSettings({ tenantId, userId, value }) {
      const key = `${tenantId}:${userId}`;
      const normalized = normalizeAssistantSettings(value);
      state.userSettings.set(key, normalized);
      return clone(normalized);
    },
    async logOtherIntentReview(value) {
      const normalized = normalizeOtherIntentReviewLog(value);
      state.otherIntentReviewLogs.push(normalized);
      return clone(normalized);
    },
    async listOtherIntentReviewLogs({ sessionId = '', tenantId } = {}) {
      return state.otherIntentReviewLogs
        .filter((log) => (
          (!tenantId || log.tenantId === tenantId)
          && (!sessionId || log.sessionId === sessionId)
        ))
        .sort((left, right) => comparableTime(right.createdAt) - comparableTime(left.createdAt))
        .map((log) => clone(log));
    },
    async getProjectAssistantState({ projectId, tenantId }) {
      const artifactsState = projectArtifacts(projectId, tenantId);
      const clarifications = buildClarificationViewsForProject({ projectId, tenantId });
      const stakeholders = scopedStakeholders({ projectId, tenantId });

      return {
        artifacts: clone(artifactsState.artifacts),
        brief: clone(artifactsState.brief),
        clarifications,
        stakeholderContacts: clone(stakeholders),
        stakeholders: clone(stakeholders),
        updatedAt: artifactsState.updatedAt ?? null,
      };
    },
    async saveProjectAssistantState({ projectId, tenantId, value, briefUpdate }) {
      const normalized = setProjectArtifacts(projectId, tenantId, value, briefUpdate);
      return {
        artifacts: clone(normalized.artifacts),
        brief: clone(normalized.brief),
        clarifications: buildClarificationViewsForProject({ projectId, tenantId }),
        stakeholderContacts: scopedStakeholders({ projectId, tenantId }),
        stakeholders: scopedStakeholders({ projectId, tenantId }),
        updatedAt: normalized.updatedAt,
      };
    },
    async listProjectStakeholders({ projectId, tenantId }) {
      return scopedStakeholders({ projectId, tenantId });
    },
    async createProjectStakeholder({ projectId, tenantId, value }) {
      return resolveStakeholderRecord({ input: value, projectId, tenantId });
    },
    async updateProjectStakeholder({ patch = {}, projectId, stakeholderId, tenantId }) {
      const record = state.projectStakeholders.find((stakeholder) => stakeholder.id === stakeholderId && projectScopeMatch(stakeholder, { projectId, tenantId }));
      if (!record) return null;
      const next = stakeholderPatch(record, patch);
      const taken = state.projectStakeholders.some((stakeholder) => stakeholder.id !== stakeholderId
        && stakeholder.email === next.email && projectScopeMatch(stakeholder, { projectId, tenantId }));
      if (taken) throw stakeholderEmailTaken();
      Object.assign(record, next, { updatedAt: nowIso() });
      if (patch.name !== undefined) {
        for (const entry of [...state.projectClarificationAssignments, ...state.projectClarificationComments]) {
          if (entry.actorType !== 'stakeholder' || entry.actorId !== stakeholderId || !projectScopeMatch(entry, { projectId, tenantId })) continue;
          if ('label' in entry) entry.label = next.name;
          if ('authorName' in entry) entry.authorName = next.name;
        }
      }
      return clone(record);
    },
    async findProjectStakeholderById({ projectId, stakeholderId, tenantId }) {
      return scopedStakeholders({ projectId, tenantId }).find((stakeholder) => stakeholder.id === stakeholderId) ?? null;
    },
    // The stakeholders with this email on every project in the workspace (access links).
    async listStakeholdersByEmail({ email, tenantId }) {
      const address = normalizeString(email).toLowerCase();
      return state.projectStakeholders
        .filter((stakeholder) => address && stakeholder.tenantId === tenantId && stakeholder.email === address)
        .map((stakeholder) => ({ email: stakeholder.email, id: stakeholder.id, name: stakeholder.name, projectId: stakeholder.projectId, roleTitle: stakeholder.roleTitle ?? '' }));
    },
    async syncProjectClarifications({ projectId, tenantId, stakeholderContacts = [], clarifications = [], scheduleInvitations = null }) {
      const stakeholderIdMap = new Map();

      for (const contact of stakeholderContacts) {
        const saved = resolveStakeholderRecord({ input: contact, projectId, tenantId });
        stakeholderIdMap.set(contact.id, saved.id);
      }

      for (const clarificationInput of clarifications) {
        const normalized = normalizeClarificationRecord(clarificationInput);
        const existing = state.projectClarifications.find((clarification) => {
          return clarification.id === normalized.id
            && projectScopeMatch(clarification, { projectId, tenantId });
        }) ?? null;
        const saved = {
          ...normalizeClarificationRecord(existing ?? normalized),
          blockingArea: normalized.blockingArea,
          currentAnswer: normalizeString(existing?.currentAnswer) || normalized.currentAnswer,
          currentAnswerUpdatedAt: existing?.currentAnswerUpdatedAt ?? normalized.currentAnswerUpdatedAt ?? null,
          id: normalized.id,
          lastActivityAt: existing?.lastActivityAt ?? normalized.lastActivityAt ?? nowIso(),
          lastAutoCommentActivityAt: existing?.lastAutoCommentActivityAt ?? normalized.lastAutoCommentActivityAt ?? null,
          lastHumanActivityAt: existing?.lastHumanActivityAt ?? normalized.lastHumanActivityAt ?? null,
          lastReviewedActivityAt: existing?.lastReviewedActivityAt ?? normalized.lastReviewedActivityAt ?? null,
          lifecycleState: normalized.lifecycleState,
          linkedSection: normalized.linkedSection,
          projectId,
          prompt: normalized.prompt,
          proposedDraftImpact: normalized.proposedDraftImpact,
          rationale: normalized.rationale,
          status: existing?.status && existing.status !== 'dismissed' ? existing.status : normalized.status,
          tenantId,
          updatedAt: nowIso(),
        };

        if (!existing) {
          saved.createdAt = normalized.createdAt ?? saved.updatedAt;
          // Every clarification is a requirements topic; new ones start in the track asked
          // for, or Experience.
          saved.track = newClarificationTrack(clarificationInput);
          saved.topicOrigin = 'assistant';
          state.projectClarifications.push(saved);
        } else {
          Object.assign(existing, saved);
        }

        const nextAssignments = (clarificationInput.assignments ?? [])
          .map((assignment) => normalizeClarificationAssignment(assignment))
          .map((assignment) => {
            if (assignment.actorType !== 'stakeholder') {
              return assignment;
            }

            return {
              ...assignment,
              actorId: stakeholderIdMap.get(assignment.actorId) ?? assignment.actorId,
            };
          });

        replaceAssignmentsForClarification({
          assignments: nextAssignments,
          clarificationId: normalized.id,
          projectId,
          tenantId,
        });

        syncClarificationInvitationsForStakeholders({
          clarificationId: normalized.id,
          projectId,
          stakeholderIds: nextAssignments
            .filter((assignment) => assignment.actorType === 'stakeholder')
            .map((assignment) => assignment.actorId),
          tenantId,
        });
      }

      if (scheduleInvitations?.at) {
        scheduleInvitationsInState(state, { clarificationIds: scheduleInvitations.clarificationIds ?? null, projectId, scheduledAt: scheduleInvitations.at, tenantId });
      }

      return buildClarificationViewsForProject({ projectId, tenantId });
    },
    async listProjectClarifications({ projectId, tenantId }) {
      return buildClarificationViewsForProject({ projectId, tenantId });
    },
    async getProjectClarification({ clarificationId, projectId, tenantId }) {
      const clarification = buildClarificationViewsForProject({ projectId, tenantId })
        .find((item) => item.id === clarificationId) ?? null;
      return clarification ? clone(clarification) : null;
    },
    async updateProjectClarification({ clarificationId, patch = {}, projectId, tenantId }) {
      const clarification = state.projectClarifications.find((item) => {
        return item.id === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;

      if (!clarification) {
        return null;
      }

      const updatedAt = nowIso();

      if (patch.assignments && Array.isArray(patch.expectedInvitationStakeholderIds)) {
        // Checked synchronously before any change, so no other save can interleave.
        requireExpectedInvitationRecipients({
          expected: patch.expectedInvitationStakeholderIds,
          recipients: invitationRecipientIds({
            activeInvitations: state.projectClarificationInvitations.filter((invitation) => invitation.clarificationId === clarificationId
              && projectScopeMatch(invitation, { projectId, tenantId })
              && !invitation.deactivatedAt),
            stakeholderIds: patch.assignments.filter((assignment) => assignment.actorType === 'stakeholder').map((assignment) => assignment.actorId),
          }),
        });
      }

      if (patch.assignments) {
        replaceAssignmentsForClarification({
          assignments: patch.assignments,
          clarificationId,
          projectId,
          tenantId,
        });

        syncClarificationInvitationsForStakeholders({
          clarificationId,
          projectId,
          stakeholderIds: patch.assignments
            .filter((assignment) => assignment.actorType === 'stakeholder')
            .map((assignment) => assignment.actorId),
          tenantId,
        });
      }

      // Invited stakeholders join their digests in the same step as the save.
      if (patch.scheduleInvitationsAt) {
        scheduleInvitationsInState(state, { clarificationIds: [clarificationId], projectId, scheduledAt: patch.scheduleInvitationsAt, tenantId });
      }

      if (patch.status) {
        clarification.status = normalizeString(patch.status) || clarification.status;
      }

      if (patch.lifecycleState && CLARIFICATION_LIFECYCLE_STATES.has(normalizeString(patch.lifecycleState))) {
        clarification.lifecycleState = normalizeString(patch.lifecycleState);
      }

      if (patch.currentAnswer !== undefined) {
        clarification.currentAnswer = normalizeString(patch.currentAnswer);
        clarification.currentAnswerUpdatedAt = updatedAt;
        clarification.lastActivityAt = updatedAt;
      }

      if (patch.latestInboundSummary !== undefined || patch.latestInboundSuggestedAnswer !== undefined) {
        clarification.latestInboundSummary = normalizeString(
          patch.latestInboundSummary !== undefined ? patch.latestInboundSummary : clarification.latestInboundSummary,
        );
        clarification.latestInboundSuggestedAnswer = normalizeString(
          patch.latestInboundSuggestedAnswer !== undefined ? patch.latestInboundSuggestedAnswer : clarification.latestInboundSuggestedAnswer,
        );
        clarification.latestInboundSummaryCommentId = normalizePreferenceScopeValue(
          patch.latestInboundSummaryCommentId !== undefined
            ? patch.latestInboundSummaryCommentId
            : clarification.latestInboundSummaryCommentId,
        );
        clarification.latestInboundSummaryUpdatedAt = updatedAt;
      }

      clarification.updatedAt = updatedAt;

      return this.getProjectClarification({ clarificationId, projectId, tenantId });
    },
    async addProjectClarificationComment({ clarificationId, comment, preserveStatus = false, projectId, tenantId }) {
      const clarification = state.projectClarifications.find((item) => {
        return item.id === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;

      if (!clarification) {
        return null;
      }

      const normalizedComment = normalizeClarificationComment(comment);
      if (normalizedComment.parentCommentId) {
        const parentComment = state.projectClarificationComments.find((item) => {
          return item.id === normalizedComment.parentCommentId
            && item.clarificationId === clarificationId
            && projectScopeMatch(item, { projectId, tenantId });
        }) ?? null;
        if (!parentComment) {
          throw new Error('Invalid parent clarification comment.');
        }
      }

      const timestamp = nowIso();
      state.projectClarificationComments.push({
        actorId: normalizedComment.actorId,
        actorType: normalizedComment.actorType,
        authorName: normalizedComment.authorName,
        body: normalizedComment.body,
        clarificationId,
        createdAt: timestamp,
        deletedAt: null,
        editedAt: null,
        id: normalizedComment.id,
        parentCommentId: normalizedComment.parentCommentId,
        projectId,
        source: normalizedComment.source,
        tenantId,
        updatedAt: timestamp,
      });

      clarification.lastActivityAt = timestamp;
      clarification.updatedAt = timestamp;
      if (normalizedComment.actorType !== 'assistant') {
        clarification.lastHumanActivityAt = timestamp;
        if (!preserveStatus && ['open', 'answered'].includes(clarification.status)) {
          clarification.status = 'answered';
        }
      }

      return {
        actorId: normalizedComment.actorId,
        actorType: normalizedComment.actorType,
        authorName: normalizedComment.authorName,
        body: normalizedComment.body,
        createdAt: timestamp,
        id: normalizedComment.id,
        parentCommentId: normalizedComment.parentCommentId,
        source: normalizedComment.source,
        updatedAt: timestamp,
      };
    },
    async updateProjectClarificationComment({ body = '', clarificationId, commentId, preserveStatus = false, projectId, tenantId }) {
      const clarification = state.projectClarifications.find((item) => {
        return item.id === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!clarification) {
        return null;
      }

      const comment = state.projectClarificationComments.find((item) => {
        return item.id === commentId
          && item.clarificationId === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!comment) {
        return null;
      }

      const timestamp = nowIso();
      comment.body = normalizeString(body);
      comment.editedAt = timestamp;
      comment.updatedAt = timestamp;
      comment.deletedAt = null;

      clarification.lastActivityAt = timestamp;
      clarification.lastHumanActivityAt = timestamp;
      clarification.updatedAt = timestamp;
      if (!preserveStatus && ['open', 'answered'].includes(clarification.status)) {
        clarification.status = 'answered';
      }

      return normalizeClarificationComment(comment);
    },
    async deleteProjectClarificationComment({ clarificationId, commentId, preserveStatus = false, projectId, tenantId }) {
      const clarification = state.projectClarifications.find((item) => {
        return item.id === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!clarification) {
        return null;
      }

      const comment = state.projectClarificationComments.find((item) => {
        return item.id === commentId
          && item.clarificationId === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!comment) {
        return null;
      }

      const hasReplies = state.projectClarificationComments.some((item) => {
        return item.parentCommentId === commentId
          && item.clarificationId === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      });
      const hasReactions = state.projectClarificationCommentReactions.some((item) => {
        return item.commentId === commentId
          && item.clarificationId === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      });
      const timestamp = nowIso();
      if (!hasReplies && !hasReactions) {
        state.projectClarificationComments = state.projectClarificationComments.filter((item) => {
          return !(item.id === commentId
            && item.clarificationId === clarificationId
            && projectScopeMatch(item, { projectId, tenantId }));
        });
        state.projectClarificationCommentReactions = state.projectClarificationCommentReactions.filter((item) => {
          return !(item.commentId === commentId
            && item.clarificationId === clarificationId
            && projectScopeMatch(item, { projectId, tenantId }));
        });

        clarification.lastActivityAt = timestamp;
        clarification.lastHumanActivityAt = timestamp;
        clarification.updatedAt = timestamp;

        return {
          hardDeleted: true,
          id: commentId,
        };
      }

      comment.body = '';
      comment.deletedAt = timestamp;
      comment.updatedAt = timestamp;

      clarification.lastActivityAt = timestamp;
      clarification.lastHumanActivityAt = timestamp;
      clarification.updatedAt = timestamp;
      if (!preserveStatus && ['open', 'answered'].includes(clarification.status)) {
        clarification.status = 'answered';
      }

      return {
        ...normalizeClarificationComment(comment),
        hardDeleted: false,
      };
    },
    async voteProjectClarificationComment({
      actorId,
      actorType = 'user',
      clarificationId,
      commentId,
      projectId,
      tenantId,
      vote,
    }) {
      const clarification = state.projectClarifications.find((item) => {
        return item.id === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!clarification) {
        return null;
      }

      const comment = state.projectClarificationComments.find((item) => {
        return item.id === commentId
          && item.clarificationId === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!comment || comment.deletedAt) {
        return null;
      }

      const normalizedVote = vote === 'down' ? 'down' : 'up';
      const normalizedActorType = actorType === 'stakeholder' ? 'stakeholder' : 'user';
      const existing = state.projectClarificationCommentReactions.find((item) => {
        return item.commentId === commentId
          && item.clarificationId === clarificationId
          && item.actorId === actorId
          && item.actorType === normalizedActorType
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      const timestamp = nowIso();

      if (!existing) {
        state.projectClarificationCommentReactions.push({
          actorId,
          actorType: normalizedActorType,
          clarificationId,
          commentId,
          createdAt: timestamp,
          id: randomUUID(),
          projectId,
          reaction: normalizedVote,
          tenantId,
          updatedAt: timestamp,
        });
      } else if (existing.reaction === normalizedVote) {
        state.projectClarificationCommentReactions = state.projectClarificationCommentReactions.filter((item) => item.id !== existing.id);
      } else {
        existing.reaction = normalizedVote;
        existing.updatedAt = timestamp;
      }

      clarification.lastActivityAt = timestamp;
      clarification.updatedAt = timestamp;

      const reactions = state.projectClarificationCommentReactions.filter((item) => {
        return item.commentId === commentId
          && item.clarificationId === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      });

      return {
        commentId,
        currentReaction: reactions.find((item) => item.actorId === actorId && item.actorType === normalizedActorType)?.reaction ?? null,
        downvotes: reactions.filter((item) => item.reaction === 'down').length,
        upvotes: reactions.filter((item) => item.reaction === 'up').length,
      };
    },
    async listClarificationInvitations({ clarificationId = '', projectId, tenantId }) {
      return scopedInvitations({ projectId, tenantId })
        .filter((invitation) => !clarificationId || invitation.clarificationId === clarificationId);
    },
    async syncClarificationInvitations({ clarificationId, projectId, stakeholderIds = [], tenantId }) {
      return syncClarificationInvitationsForStakeholders({
        clarificationId,
        projectId,
        stakeholderIds,
        tenantId,
      });
    },
    async findClarificationInvitationById({ invitationId }) {
      const invitation = state.projectClarificationInvitations.find((item) => item.id === invitationId) ?? null;
      return invitation ? clone(invitation) : null;
    },
    async markClarificationInvitationQueued({ invitationId, projectId, tenantId }) {
      const invitation = state.projectClarificationInvitations.find((item) => {
        return item.id === invitationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!invitation) {
        return null;
      }
      const updatedAt = nowIso();
      invitation.mailStatus = 'pending';
      invitation.lastError = '';
      invitation.queuedAt = updatedAt;
      invitation.updatedAt = updatedAt;
      return clone(invitation);
    },
    async markClarificationInvitationDelivery({ invitationId, lastError = '', mailStatus = 'sent', projectId, providerMessageId = '', tenantId }) {
      const invitation = state.projectClarificationInvitations.find((item) => {
        return item.id === invitationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!invitation) {
        return null;
      }
      const updatedAt = nowIso();
      invitation.mailStatus = CLARIFICATION_MAIL_STATUSES.has(normalizeString(mailStatus))
        ? normalizeString(mailStatus)
        : 'sent';
      invitation.lastError = normalizeString(lastError);
      invitation.lastProviderMessageId = normalizeString(providerMessageId) || invitation.lastProviderMessageId;
      invitation.sentAt = invitation.mailStatus === 'sent' ? updatedAt : invitation.sentAt;
      invitation.updatedAt = updatedAt;
      return clone(invitation);
    },
    async markClarificationInvitationInbound({ invitationId, projectId, providerMessageId = '', tenantId }) {
      const invitation = state.projectClarificationInvitations.find((item) => {
        return item.id === invitationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;
      if (!invitation) {
        return null;
      }
      const updatedAt = nowIso();
      invitation.lastInboundAt = updatedAt;
      invitation.lastProviderMessageId = normalizeString(providerMessageId) || invitation.lastProviderMessageId;
      invitation.updatedAt = updatedAt;
      return clone(invitation);
    },
    async resolveClarificationInvitationByReply({ fromEmail = '', replyToken }) {
      const invitation = invitationForReplyToken(replyToken);
      if (!invitation) {
        return null;
      }
      const stakeholder = state.projectStakeholders.find((item) => item.id === invitation.stakeholderId) ?? null;
      if (!stakeholder) {
        return null;
      }
      const normalizedFrom = normalizeString(fromEmail).toLowerCase();
      if (normalizedFrom && stakeholder.email !== normalizedFrom) {
        return null;
      }
      return {
        invitation: clone(invitation),
        stakeholder: clone(stakeholder),
      };
    },
    async recordClarificationEmailMessage({ value }) {
      const normalized = normalizeClarificationEmailMessage(value);
      const existing = state.projectClarificationEmailMessages.find((message) => {
        return message.invitationId === normalized.invitationId
          && message.providerMessageId
          && message.providerMessageId === normalized.providerMessageId
          && projectScopeMatch(message, { projectId: normalized.projectId, tenantId: normalized.tenantId });
      }) ?? null;
      if (existing) {
        return {
          duplicate: true,
          message: clone(existing),
        };
      }
      state.projectClarificationEmailMessages.push(normalized);
      return {
        duplicate: false,
        message: clone(normalized),
      };
    },
    async applyClarificationDiscussionReview({
      clarificationId,
      comment = '',
      currentAnswer = '',
      explicit = false,
      projectId,
      tenantId,
    }) {
      const clarification = state.projectClarifications.find((item) => {
        return item.id === clarificationId
          && projectScopeMatch(item, { projectId, tenantId });
      }) ?? null;

      if (!clarification) {
        return null;
      }

      const updatedAt = nowIso();
      if (normalizeString(currentAnswer)) {
        clarification.currentAnswer = normalizeString(currentAnswer);
        clarification.currentAnswerUpdatedAt = updatedAt;
        clarification.updatedAt = updatedAt;
        if (clarification.status === 'open') {
          clarification.status = 'answered';
        }
      }
      clarification.lastReviewedActivityAt = clarification.lastHumanActivityAt ?? clarification.lastActivityAt ?? updatedAt;

      const canAutoComment = explicit
        || !clarification.lastHumanActivityAt
        || clarification.lastAutoCommentActivityAt !== clarification.lastHumanActivityAt;

      if (normalizeString(comment) && canAutoComment) {
        await this.addProjectClarificationComment({
          clarificationId,
          comment: {
            actorId: 'odin-ai',
            actorType: 'assistant',
            authorName: 'Odin-AI',
            body: normalizeString(comment),
            source: explicit ? 'ask-odin' : 'review',
          },
          projectId,
          tenantId,
        });

        if (!explicit) {
          clarification.lastAutoCommentActivityAt = clarification.lastHumanActivityAt ?? updatedAt;
        }
      }

      clarification.updatedAt = updatedAt;
      return this.getProjectClarification({ clarificationId, projectId, tenantId });
    },
    async getProjectClarificationAccessContext({ accessToken }) {
      const invitation = invitationForAccessToken(accessToken);
      let clarifications = null;
      const stakeholder = invitation
        ? state.projectStakeholders.find((item) => item.id === invitation.stakeholderId) ?? null
        : stakeholderForAccessToken(accessToken);
      if (!stakeholder && invitation) {
        clarifications = buildClarificationViewsForProject({
          projectId: invitation.projectId,
          tenantId: invitation.tenantId,
        });
      }
      const resolvedStakeholder = stakeholder ?? buildStakeholderFallbackForInvitation(invitation, clarifications);
      if (!resolvedStakeholder) {
        return null;
      }

      clarifications = clarifications ?? buildClarificationViewsForProject({
        projectId: resolvedStakeholder.projectId,
        tenantId: resolvedStakeholder.tenantId,
      }).filter((clarification) => {
        return clarification.status !== 'dismissed'
          && clarification.assignments.some((assignment) => assignment.actorType === 'stakeholder' && assignment.actorId === resolvedStakeholder.id);
      }).map((clarification) => ({
        ...clarification,
        accessToken: resolvedStakeholder.accessToken,
      }));

      return excludeRequirementsTopics(this, {
        clarifications,
        focusClarificationId: invitation?.clarificationId ?? null,
        projectId: resolvedStakeholder.projectId,
        stakeholder: clone(resolvedStakeholder),
        stakeholders: scopedStakeholders({ projectId: resolvedStakeholder.projectId, tenantId: resolvedStakeholder.tenantId }),
        tenantId: resolvedStakeholder.tenantId,
      }, invitation);
    },
    async findClarificationByAccessToken({ accessToken }) {
      const accessContext = await this.getProjectClarificationAccessContext({ accessToken });
      if (!accessContext) {
        return null;
      }

      return buildCompatibilityAccessResult({
        accessContext,
        artifactsState: projectArtifacts(accessContext.projectId, accessContext.tenantId),
      });
    },
  };
}

async function loadProjectStakeholdersMysql(executor, { projectId, tenantId }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        name,
        email,
        role_title AS roleTitle,
        access_token AS accessToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_stakeholders
      WHERE tenant_id = ?
        AND project_id = ?
      ORDER BY name ASC
    `,
    [tenantId, projectId],
  );

  return rows.map((row) => normalizeStakeholder(row)).sort(compareStakeholders);
}

async function loadProjectClarificationInvitationsMysql(executor, { projectId, tenantId }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        clarification_id AS clarificationId,
        stakeholder_id AS stakeholderId,
        invitation_token AS invitationToken,
        reply_token AS replyToken,
        mail_status AS mailStatus,
        queued_at AS queuedAt,
        sent_at AS sentAt,
        last_inbound_at AS lastInboundAt,
        last_provider_message_id AS lastProviderMessageId,
        last_error AS lastError,
        deactivated_at AS deactivatedAt,
        scheduled_at AS scheduledAt,
        delivery_id AS deliveryId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_clarification_invitations
      WHERE tenant_id = ?
        AND project_id = ?
    `,
    [tenantId, projectId],
  );

  return rows.map((row) => normalizeClarificationInvitation({
    ...row,
    projectId,
    tenantId,
  }));
}

async function loadProjectClarificationViewsMysql(executor, { projectId, tenantId }) {
  const [clarificationRows] = await executor.execute(
    `
      SELECT
        id,
        blocking_area AS blockingArea,
        linked_section AS linkedSection,
        prompt,
        rationale,
        proposed_draft_impact AS proposedDraftImpact,
        lifecycle_state AS lifecycleState,
        clarification_status AS status,
        current_answer AS currentAnswer,
        current_answer_updated_at AS currentAnswerUpdatedAt,
        latest_inbound_summary AS latestInboundSummary,
        latest_inbound_suggested_answer AS latestInboundSuggestedAnswer,
        latest_inbound_summary_comment_id AS latestInboundSummaryCommentId,
        latest_inbound_summary_updated_at AS latestInboundSummaryUpdatedAt,
        last_activity_at AS lastActivityAt,
        last_human_activity_at AS lastHumanActivityAt,
        last_reviewed_activity_at AS lastReviewedActivityAt,
        last_auto_comment_activity_at AS lastAutoCommentActivityAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_clarifications
      WHERE tenant_id = ?
        AND project_id = ?
    `,
    [tenantId, projectId],
  );
  const [assignmentRows] = await executor.execute(
    `
      SELECT
        a.id,
        a.clarification_id AS clarificationId,
        a.actor_type AS actorType,
        a.actor_id AS actorId,
        a.actor_label AS label,
        a.assignment_role AS role,
        s.access_token AS accessToken
      FROM project_clarification_assignments a
      LEFT JOIN project_stakeholders s
        ON s.id = a.actor_id
        AND a.actor_type = 'stakeholder'
        AND s.project_id = a.project_id
        AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.project_id = ?
    `,
    [tenantId, projectId],
  );
  const [commentRows] = await executor.execute(
    `
      SELECT
        id,
        clarification_id AS clarificationId,
        parent_comment_id AS parentCommentId,
        actor_type AS actorType,
        actor_id AS actorId,
        actor_label AS authorName,
        comment_body AS body,
        comment_source AS source,
        edited_at AS editedAt,
        deleted_at AS deletedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_clarification_comments
      WHERE tenant_id = ?
        AND project_id = ?
    `,
    [tenantId, projectId],
  );
  const [reactionRows] = await executor.execute(
    `
      SELECT
        comment_id AS commentId,
        actor_type AS actorType,
        actor_id AS actorId,
        reaction
      FROM project_clarification_comment_reactions
      WHERE tenant_id = ?
        AND project_id = ?
    `,
    [tenantId, projectId],
  );
  const stakeholders = await loadProjectStakeholdersMysql(executor, { projectId, tenantId });
  const invitations = await loadProjectClarificationInvitationsMysql(executor, { projectId, tenantId });

  return buildProjectClarificationViews({
    assignments: assignmentRows.map((row) => ({
      ...normalizeClarificationAssignment(row),
      accessToken: normalizeString(row.accessToken),
      clarificationId: row.clarificationId,
    })),
    clarifications: clarificationRows.map((row) => normalizeClarificationRecord(row)),
    comments: commentRows.map((row) => normalizeClarificationComment(row)).map((comment, index) => ({
      ...comment,
      clarificationId: commentRows[index].clarificationId,
    })),
    invitations,
    reactions: reactionRows.map((row) => ({
      actorId: normalizeString(row.actorId),
      actorType: row.actorType === 'stakeholder' ? 'stakeholder' : 'user',
      commentId: normalizeString(row.commentId),
      reaction: row.reaction === 'down' ? 'down' : 'up',
    })),
    stakeholders,
  });
}

async function addProjectClarificationCommentMysql(executor, {
  clarificationId,
  comment,
  preserveStatus = false,
  projectId,
  tenantId,
}) {
  const [rows] = await executor.execute(
    'SELECT id, clarification_status AS status FROM project_clarifications WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1',
    [tenantId, projectId, clarificationId],
  );
  if (!rows[0]?.id) {
    return null;
  }

  const normalized = normalizeClarificationComment(comment);
  const commentId = normalized.id;
  if (normalized.parentCommentId) {
    const [parentRows] = await executor.execute(
      `
        SELECT id
        FROM project_clarification_comments
        WHERE tenant_id = ?
          AND project_id = ?
          AND clarification_id = ?
          AND id = ?
        LIMIT 1
      `,
      [tenantId, projectId, clarificationId, normalized.parentCommentId],
    );
    if (!parentRows[0]?.id) {
      throw new Error('Invalid parent clarification comment.');
    }
  }

  await executor.execute(
    `
      INSERT INTO project_clarification_comments (
        id,
        tenant_id,
        project_id,
        clarification_id,
        parent_comment_id,
        actor_type,
        actor_id,
        actor_label,
        comment_body,
        comment_source,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `,
    [
      commentId,
      tenantId,
      projectId,
      clarificationId,
      normalized.parentCommentId,
      normalized.actorType,
      normalizePreferenceScopeValue(normalized.actorId),
      normalized.authorName,
      normalized.body,
      normalized.source,
    ],
  );

  if (normalized.actorType === 'assistant') {
    await executor.execute(
      `
        UPDATE project_clarifications
        SET last_activity_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = ?
          AND project_id = ?
          AND id = ?
      `,
      [tenantId, projectId, clarificationId],
    );
  } else if (preserveStatus) {
    await executor.execute(
      `
        UPDATE project_clarifications
        SET last_activity_at = NOW(),
            last_human_activity_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = ?
          AND project_id = ?
          AND id = ?
      `,
      [tenantId, projectId, clarificationId],
    );
  } else {
    await executor.execute(
      `
        UPDATE project_clarifications
        SET clarification_status = CASE
              WHEN clarification_status IN ('open', 'answered') THEN 'answered'
              ELSE clarification_status
            END,
            last_activity_at = NOW(),
            last_human_activity_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = ?
          AND project_id = ?
          AND id = ?
      `,
      [tenantId, projectId, clarificationId],
    );
  }

  const createdAt = nowIso();
  return {
    actorId: normalized.actorId,
    actorType: normalized.actorType,
    authorName: normalized.authorName,
    body: normalized.body,
    createdAt,
    deletedAt: null,
    editedAt: null,
    id: commentId,
    isDeleted: false,
    parentCommentId: normalized.parentCommentId,
    source: normalized.source,
    updatedAt: createdAt,
  };
}

async function findProjectStakeholderByAccessTokenMysql(executor, { accessToken }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        tenant_id AS tenantId,
        project_id AS projectId,
        name,
        email,
        role_title AS roleTitle,
        access_token AS accessToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_stakeholders
      WHERE access_token = ?
      LIMIT 1
    `,
    [accessToken],
  );

  if (!rows[0]) {
    return null;
  }

  return {
    ...normalizeStakeholder(rows[0]),
    projectId: rows[0].projectId,
    tenantId: rows[0].tenantId,
  };
}

async function findClarificationInvitationByTokenMysql(executor, { invitationToken }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        tenant_id AS tenantId,
        project_id AS projectId,
        clarification_id AS clarificationId,
        stakeholder_id AS stakeholderId,
        invitation_token AS invitationToken,
        reply_token AS replyToken,
        mail_status AS mailStatus,
        queued_at AS queuedAt,
        sent_at AS sentAt,
        last_inbound_at AS lastInboundAt,
        last_provider_message_id AS lastProviderMessageId,
        last_error AS lastError,
        deactivated_at AS deactivatedAt,
        scheduled_at AS scheduledAt,
        delivery_id AS deliveryId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_clarification_invitations
      WHERE invitation_token = ?
        AND deactivated_at IS NULL
      LIMIT 1
    `,
    [invitationToken],
  );

  return rows[0] ? normalizeClarificationInvitation(rows[0]) : null;
}

async function findClarificationInvitationByIdMysql(executor, { invitationId }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        tenant_id AS tenantId,
        project_id AS projectId,
        clarification_id AS clarificationId,
        stakeholder_id AS stakeholderId,
        invitation_token AS invitationToken,
        reply_token AS replyToken,
        mail_status AS mailStatus,
        queued_at AS queuedAt,
        sent_at AS sentAt,
        last_inbound_at AS lastInboundAt,
        last_provider_message_id AS lastProviderMessageId,
        last_error AS lastError,
        deactivated_at AS deactivatedAt,
        scheduled_at AS scheduledAt,
        delivery_id AS deliveryId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_clarification_invitations
      WHERE id = ?
      LIMIT 1
    `,
    [invitationId],
  );

  return rows[0] ? normalizeClarificationInvitation(rows[0]) : null;
}

async function findClarificationInvitationByReplyTokenMysql(executor, { replyToken }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        tenant_id AS tenantId,
        project_id AS projectId,
        clarification_id AS clarificationId,
        stakeholder_id AS stakeholderId,
        invitation_token AS invitationToken,
        reply_token AS replyToken,
        mail_status AS mailStatus,
        queued_at AS queuedAt,
        sent_at AS sentAt,
        last_inbound_at AS lastInboundAt,
        last_provider_message_id AS lastProviderMessageId,
        last_error AS lastError,
        deactivated_at AS deactivatedAt,
        scheduled_at AS scheduledAt,
        delivery_id AS deliveryId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_clarification_invitations
      WHERE reply_token = ?
        AND deactivated_at IS NULL
      LIMIT 1
    `,
    [replyToken],
  );

  return rows[0] ? normalizeClarificationInvitation(rows[0]) : null;
}

async function findProjectStakeholderByIdMysql(executor, { projectId, stakeholderId, tenantId }) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        tenant_id AS tenantId,
        project_id AS projectId,
        name,
        email,
        role_title AS roleTitle,
        access_token AS accessToken,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_stakeholders
      WHERE tenant_id = ?
        AND project_id = ?
        AND id = ?
      LIMIT 1
    `,
    [tenantId, projectId, stakeholderId],
  );

  return rows[0] ? {
    ...normalizeStakeholder(rows[0]),
    projectId: rows[0].projectId,
    tenantId: rows[0].tenantId,
  } : null;
}

async function syncClarificationInvitationsMysql(executor, {
  clarificationId,
  expectedRecipientIds = null,
  projectId,
  stakeholderIds = [],
  tenantId,
}) {
  const normalizedStakeholderIds = [...new Set(
    stakeholderIds.map((value) => String(value ?? '').trim()).filter(Boolean),
  )];
  const checkRecipients = Array.isArray(expectedRecipientIds);
  // With an expected-recipients precondition, lock this clarification's invitation rows (and
  // the index range, so no invitation can be added) until the transaction ends, then decide
  // from exactly those rows.
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        stakeholder_id AS stakeholderId,
        deactivated_at AS deactivatedAt,
        mail_status AS mailStatus,
        queued_at AS queuedAt,
        scheduled_at AS scheduledAt
      FROM project_clarification_invitations
      WHERE tenant_id = ?
        AND project_id = ?
        AND clarification_id = ?${checkRecipients ? '\n      FOR UPDATE' : ''}
    `,
    [tenantId, projectId, clarificationId],
  );
  if (checkRecipients) {
    requireExpectedInvitationRecipients({
      expected: expectedRecipientIds,
      recipients: invitationRecipientIds({ activeInvitations: rows.filter((row) => !row.deactivatedAt), stakeholderIds: normalizedStakeholderIds }),
    });
  }
  const activeStakeholderIds = new Set(normalizedStakeholderIds);
  const invitationsToSend = [];

  for (const row of rows) {
    if (row.deactivatedAt || activeStakeholderIds.has(String(row.stakeholderId ?? '').trim())) {
      continue;
    }

    await executor.execute(
      `
        UPDATE project_clarification_invitations
        SET deactivated_at = NOW(),
            updated_at = NOW()
        WHERE id = ?
      `,
      [row.id],
    );
  }

  for (const stakeholderId of normalizedStakeholderIds) {
    const existingActive = rows.find((row) => !row.deactivatedAt && row.stakeholderId === stakeholderId) ?? null;
    if (existingActive) {
      continue;
    }

    const invitation = normalizeClarificationInvitation({
      clarificationId,
      projectId,
      stakeholderId,
      tenantId,
    });

    await executor.execute(
      `
        INSERT INTO project_clarification_invitations (
          id,
          tenant_id,
          project_id,
          clarification_id,
          stakeholder_id,
          invitation_token,
          reply_token,
          mail_status,
          queued_at,
          sent_at,
          last_inbound_at,
          last_provider_message_id,
          last_error,
          deactivated_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        invitation.id,
        tenantId,
        projectId,
        clarificationId,
        stakeholderId,
        invitation.invitationToken,
        invitation.replyToken,
        invitation.mailStatus,
        toMysqlDateTime(invitation.queuedAt),
        toMysqlDateTime(invitation.sentAt),
        toMysqlDateTime(invitation.lastInboundAt),
        normalizePreferenceScopeValue(invitation.lastProviderMessageId),
        invitation.lastError,
        toMysqlDateTime(invitation.deactivatedAt),
      ],
    );

    invitationsToSend.push(invitation);
  }

  return invitationsToSend;
}

async function upsertProjectStakeholderMysql(executor, { projectId, tenantId, value }) {
  const normalized = normalizeStakeholder(value);
  const [existingRows] = await executor.execute(
    `
      SELECT
        id,
        access_token AS accessToken,
        created_at AS createdAt
      FROM project_stakeholders
      WHERE tenant_id = ?
        AND project_id = ?
        AND (id = ? OR email = ?)
      LIMIT 1
    `,
    [tenantId, projectId, normalized.id, normalized.email],
  );

  const existing = existingRows[0] ?? null;
  const stakeholderId = existing?.id ?? normalized.id;
  const accessToken = normalizeString(existing?.accessToken) || normalized.accessToken || buildPublicAccessToken();

  if (existing) {
    await executor.execute(
      `
        UPDATE project_stakeholders
        SET name = ?,
            email = ?,
            role_title = ?,
            access_token = ?,
            updated_at = NOW()
        WHERE id = ?
      `,
      [normalized.name, normalized.email, normalized.roleTitle, accessToken, stakeholderId],
    );
  } else {
    await executor.execute(
      `
        INSERT INTO project_stakeholders (
          id,
          tenant_id,
          project_id,
          name,
          email,
          role_title,
          access_token,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [stakeholderId, tenantId, projectId, normalized.name, normalized.email, normalized.roleTitle, accessToken],
    );
  }

  return {
    ...normalizeStakeholder({
      accessToken,
      createdAt: existing?.createdAt ?? nowIso(),
      email: normalized.email,
      id: stakeholderId,
      name: normalized.name,
      roleTitle: normalized.roleTitle,
      updatedAt: nowIso(),
    }),
    projectId,
    tenantId,
  };
}

export function createMysqlAssistantRepository({ pool }) {
  return {
    ...createMysqlInvitationDigestStore({ normalize: normalizeClarificationInvitation, pool, withTransaction }),
    async createSession(session) {
      const normalized = normalizeSession(session);
      await withTransaction(pool, async (connection) => {
        await deletePreferencesByKeys(connection, {
          keys: [
            buildAssistantSessionKey(normalized.id),
            buildLegacyAssistantSessionKey(normalized.id),
          ],
          tenantId: normalized.tenantId,
          userId: normalized.userId,
        });
        await deleteLatestSessionPointersForSession(connection, {
          sessionId: normalized.id,
          tenantId: normalized.tenantId,
          userId: normalized.userId,
        });
        await upsertPreference(connection, {
          key: buildAssistantSessionKey(normalized.id),
          projectId: null,
          tenantId: normalized.tenantId,
          userId: normalized.userId,
          value: JSON.stringify(normalized),
        });
        if (normalized.deletedAt) {
          await deleteLatestSessionPointersForSession(connection, {
            sessionId: normalized.id,
            tenantId: normalized.tenantId,
            userId: normalized.userId,
          });
        } else {
          await upsertPreference(connection, {
            key: buildAssistantLatestSessionKey(normalized.mode),
            projectId: normalized.projectId ?? null,
            tenantId: normalized.tenantId,
            userId: normalized.userId,
            value: JSON.stringify({ sessionId: normalized.id }),
          });
        }
      });
      return clone(normalized);
    },
    async getSession({ sessionId, tenantId, userId }) {
      const [session] = await listStoredSessions(pool, {
        sessionId,
        tenantId,
        userId,
      });
      return session ?? null;
    },
    async findLatestSession({ mode, projectId = '', tenantId, userId }) {
      let raw = await getPreference(pool, {
        key: buildAssistantLatestSessionKey(mode),
        projectId,
        tenantId,
        userId,
      });
      if (!raw) {
        raw = await getPreference(pool, {
          key: buildLegacyAssistantLatestSessionKey(mode),
          projectId,
          tenantId,
          userId,
        });
      }
      const pointer = safeJsonParse(raw, null);
      if (!pointer?.sessionId) {
        return null;
      }

      const session = await this.getSession({
        sessionId: pointer.sessionId,
        tenantId,
        userId,
      });
      if (!session) {
        return null;
      }

      const normalizedProjectId = normalizePreferenceScopeValue(projectId);
      const sessionProjectId = normalizePreferenceScopeValue(session.projectId);
      if (session.mode !== mode || sessionProjectId !== normalizedProjectId) {
        return null;
      }

      return session;
    },
    async saveSession(session) {
      return this.createSession(session);
    },
    async listSessions({ tenantId, userId }) {
      return listStoredSessions(pool, {
        tenantId,
        userId,
      });
    },
    async listActiveRunSessions({ limit = 100 } = {}) {
      const boundedLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
      const [rows] = await pool.execute(
        `
          SELECT value
          FROM preferences
          WHERE (\`key\` LIKE ? OR \`key\` LIKE ?)
          ORDER BY updated_at DESC
          LIMIT ${boundedLimit}
        `,
        [`${ASSISTANT_SESSION_KEY_PREFIX}%`, `${LEGACY_ASSISTANT_SESSION_KEY_PREFIX}%`],
      );

      return dedupeSessionsById(
        rows
          .map((row) => normalizeSession(safeJsonParse(row.value, null)))
          .filter((session) => session && !session.deletedAt && sessionHasActiveRun(session)),
      );
    },
    async getUserSettings({ tenantId, userId }) {
      const raw = await getPreference(pool, {
        key: ASSISTANT_USER_SETTINGS_KEY,
        projectId: null,
        tenantId,
        userId,
      });

      return normalizeAssistantSettings(safeJsonParse(raw, {}));
    },
    async saveUserSettings({ tenantId, userId, value }) {
      const normalized = normalizeAssistantSettings(value);
      await upsertPreference(pool, {
        key: ASSISTANT_USER_SETTINGS_KEY,
        projectId: null,
        tenantId,
        userId,
        value: JSON.stringify(normalized),
      });

      return clone(normalized);
    },
    async logOtherIntentReview(value) {
      const normalized = normalizeOtherIntentReviewLog(value);
      await pool.execute(
        `
          INSERT INTO assistant_other_intent_logs (
            id,
            tenant_id,
            user_id,
            session_id,
            project_id,
            project_name,
            latest_user_message,
            previous_user_messages_json,
            classification_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          normalized.id,
          normalized.tenantId,
          normalized.userId,
          normalized.sessionId,
          normalized.projectId,
          normalized.projectName,
          normalized.latestUserMessage,
          JSON.stringify(normalized.previousUserMessages),
          JSON.stringify(normalized.classification),
          toMysqlDateTime(normalized.createdAt),
        ],
      );
      return clone(normalized);
    },
    async listOtherIntentReviewLogs({ sessionId = '', tenantId } = {}) {
      const predicates = ['tenant_id = ?'];
      const params = [tenantId];
      if (sessionId) {
        predicates.push('session_id = ?');
        params.push(sessionId);
      }
      const [rows] = await pool.execute(
        `
          SELECT
            id,
            tenant_id AS tenantId,
            user_id AS userId,
            session_id AS sessionId,
            project_id AS projectId,
            project_name AS projectName,
            latest_user_message AS latestUserMessage,
            previous_user_messages_json AS previousUserMessagesJson,
            classification_json AS classificationJson,
            created_at AS createdAt
          FROM assistant_other_intent_logs
          WHERE ${predicates.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT 500
        `,
        params,
      );
      return rows.map((row) => normalizeOtherIntentReviewLog({
        ...row,
        classification: safeJsonParse(row.classificationJson, {}),
        previousUserMessages: safeJsonParse(row.previousUserMessagesJson, []),
      }));
    },
    async getProjectAssistantState({ projectId, tenantId }) {
      const raw = await getPreference(pool, {
        key: ASSISTANT_PROJECT_STATE_KEY,
        projectId,
        tenantId,
        userId: null,
      });
      const artifactsState = normalizeStoredProjectArtifactsState(safeJsonParse(raw, createEmptyProjectArtifactsState()));
      const clarifications = await loadProjectClarificationViewsMysql(pool, { projectId, tenantId });
      const stakeholders = await loadProjectStakeholdersMysql(pool, { projectId, tenantId });

      return {
        artifacts: clone(artifactsState.artifacts),
        brief: clone(artifactsState.brief),
        clarifications,
        stakeholderContacts: clone(stakeholders),
        stakeholders: clone(stakeholders),
        updatedAt: artifactsState.updatedAt ?? null,
      };
    },
    async saveProjectAssistantState({ projectId, tenantId, value, briefUpdate }) {
      const normalized = await withTransaction(pool, async (connection) => {
        // The project row exists before the preference, so first saves serialize too.
        const [projects] = await connection.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? FOR UPDATE', [projectId, tenantId]);
        if (!projects.length) throw new HttpError(404, 'Project not found.');
        const raw = await getPreference(connection, {
          key: ASSISTANT_PROJECT_STATE_KEY,
          projectId,
          tenantId,
          userId: null,
        });
        const existing = normalizeStoredProjectArtifactsState(safeJsonParse(raw, createEmptyProjectArtifactsState()));
        const next = mergeProjectArtifacts(existing, value, briefUpdate);
        await upsertPreference(connection, {
          key: ASSISTANT_PROJECT_STATE_KEY,
          projectId,
          tenantId,
          userId: null,
          value: JSON.stringify(next),
        });
        return next;
      });

      const clarifications = await loadProjectClarificationViewsMysql(pool, { projectId, tenantId });
      const stakeholders = await loadProjectStakeholdersMysql(pool, { projectId, tenantId });
      return {
        artifacts: clone(normalized.artifacts),
        brief: clone(normalized.brief),
        clarifications,
        stakeholderContacts: clone(stakeholders),
        stakeholders: clone(stakeholders),
        updatedAt: normalized.updatedAt,
      };
    },
    async listProjectStakeholders({ projectId, tenantId }) {
      return loadProjectStakeholdersMysql(pool, { projectId, tenantId });
    },
    async createProjectStakeholder({ projectId, tenantId, value }) {
      return withTransaction(pool, async (connection) => upsertProjectStakeholderMysql(connection, {
        projectId,
        tenantId,
        value,
      }));
    },
    async updateProjectStakeholder({ patch = {}, projectId, stakeholderId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          'SELECT id, name, email, role_title AS roleTitle FROM project_stakeholders WHERE id = ? AND tenant_id = ? AND project_id = ? FOR UPDATE',
          [stakeholderId, tenantId, projectId],
        );
        if (!rows[0]) return null;
        const next = stakeholderPatch(rows[0], patch);
        const [taken] = await connection.execute(
          'SELECT id FROM project_stakeholders WHERE tenant_id = ? AND project_id = ? AND email = ? AND id <> ? LIMIT 1',
          [tenantId, projectId, next.email, stakeholderId],
        );
        if (taken.length) throw stakeholderEmailTaken();
        await connection.execute(
          'UPDATE project_stakeholders SET name = ?, email = ?, role_title = ?, updated_at = NOW() WHERE id = ?',
          [next.name, next.email, next.roleTitle, stakeholderId],
        );
        if (patch.name !== undefined) {
          // Assignments and comments keep a copy of the name for display.
          for (const table of ['project_clarification_assignments', 'project_clarification_comments']) {
            await connection.execute(
              `UPDATE ${table} SET actor_label = ? WHERE tenant_id = ? AND project_id = ? AND actor_type = 'stakeholder' AND actor_id = ?`,
              [next.name, tenantId, projectId, stakeholderId],
            );
          }
        }
        return (await loadProjectStakeholdersMysql(connection, { projectId, tenantId })).find((stakeholder) => stakeholder.id === stakeholderId) ?? null;
      });
    },
    async syncProjectClarifications({ projectId, tenantId, stakeholderContacts = [], clarifications = [], scheduleInvitations = null }) {
      return withTransaction(pool, async (connection) => {
        const stakeholderIdMap = new Map();

        for (const contact of stakeholderContacts) {
          const stakeholder = await upsertProjectStakeholderMysql(connection, { projectId, tenantId, value: contact });
          stakeholderIdMap.set(contact.id, stakeholder.id);
        }

        for (const clarificationInput of clarifications) {
          const normalized = normalizeClarificationRecord(clarificationInput);
          const [existingRows] = await connection.execute(
            `
              SELECT
                id,
                current_answer AS currentAnswer,
                current_answer_updated_at AS currentAnswerUpdatedAt,
                latest_inbound_summary AS latestInboundSummary,
                latest_inbound_suggested_answer AS latestInboundSuggestedAnswer,
                latest_inbound_summary_comment_id AS latestInboundSummaryCommentId,
                latest_inbound_summary_updated_at AS latestInboundSummaryUpdatedAt,
                clarification_status AS status,
                last_activity_at AS lastActivityAt,
                last_human_activity_at AS lastHumanActivityAt,
                last_reviewed_activity_at AS lastReviewedActivityAt,
                last_auto_comment_activity_at AS lastAutoCommentActivityAt,
                created_at AS createdAt
              FROM project_clarifications
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
              LIMIT 1
            `,
            [tenantId, projectId, normalized.id],
          );
          const existing = existingRows[0] ?? null;

          if (existing) {
            await connection.execute(
              `
                UPDATE project_clarifications
                SET linked_section = ?,
                    blocking_area = ?,
                    prompt = ?,
                    rationale = ?,
                    proposed_draft_impact = ?,
                lifecycle_state = ?,
                clarification_status = ?,
                current_answer = ?,
                current_answer_updated_at = ?,
                latest_inbound_summary = ?,
                latest_inbound_suggested_answer = ?,
                latest_inbound_summary_comment_id = ?,
                latest_inbound_summary_updated_at = ?,
                last_activity_at = ?,
                last_human_activity_at = ?,
                last_reviewed_activity_at = ?,
                    last_auto_comment_activity_at = ?,
                    updated_at = NOW()
                WHERE tenant_id = ?
                  AND project_id = ?
                  AND id = ?
              `,
              [
                normalized.linkedSection,
                normalized.blockingArea,
                normalized.prompt,
                normalized.rationale,
                normalized.proposedDraftImpact,
                normalized.lifecycleState,
                existing.status && existing.status !== 'dismissed' ? existing.status : normalized.status,
                normalizeString(existing.currentAnswer) || normalized.currentAnswer,
                toMysqlDateTime(existing.currentAnswerUpdatedAt ?? normalized.currentAnswerUpdatedAt ?? null),
                normalizeString(existing.latestInboundSummary) || normalized.latestInboundSummary,
                normalizeString(existing.latestInboundSuggestedAnswer) || normalized.latestInboundSuggestedAnswer,
                normalizePreferenceScopeValue(existing.latestInboundSummaryCommentId ?? normalized.latestInboundSummaryCommentId ?? null),
                toMysqlDateTime(existing.latestInboundSummaryUpdatedAt ?? normalized.latestInboundSummaryUpdatedAt ?? null),
                toMysqlDateTime(existing.lastActivityAt ?? normalized.lastActivityAt ?? nowIso()),
                toMysqlDateTime(existing.lastHumanActivityAt ?? normalized.lastHumanActivityAt ?? null),
                toMysqlDateTime(existing.lastReviewedActivityAt ?? normalized.lastReviewedActivityAt ?? null),
                toMysqlDateTime(existing.lastAutoCommentActivityAt ?? normalized.lastAutoCommentActivityAt ?? null),
                tenantId,
                projectId,
                normalized.id,
              ],
            );
          } else {
            await connection.execute(
              `
                INSERT INTO project_clarifications (
                  id,
                  tenant_id,
                  project_id,
                  linked_section,
                  blocking_area,
                  prompt,
                  rationale,
                  proposed_draft_impact,
                  lifecycle_state,
                  clarification_status,
                  current_answer,
                  current_answer_updated_at,
                  latest_inbound_summary,
                  latest_inbound_suggested_answer,
                  latest_inbound_summary_comment_id,
                  latest_inbound_summary_updated_at,
                  last_activity_at,
                  last_human_activity_at,
                  last_reviewed_activity_at,
                  last_auto_comment_activity_at,
                  created_at,
                  updated_at,
                  track,
                  topic_origin
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assistant')
              `,
              [
                normalized.id,
                tenantId,
                projectId,
                normalized.linkedSection,
                normalized.blockingArea,
                normalized.prompt,
                normalized.rationale,
                normalized.proposedDraftImpact,
                normalized.lifecycleState,
                normalized.status,
                normalized.currentAnswer,
                toMysqlDateTime(normalized.currentAnswerUpdatedAt),
                normalized.latestInboundSummary,
                normalized.latestInboundSuggestedAnswer,
                normalizePreferenceScopeValue(normalized.latestInboundSummaryCommentId),
                toMysqlDateTime(normalized.latestInboundSummaryUpdatedAt),
                toMysqlDateTime(normalized.lastActivityAt),
                toMysqlDateTime(normalized.lastHumanActivityAt),
                toMysqlDateTime(normalized.lastReviewedActivityAt),
                toMysqlDateTime(normalized.lastAutoCommentActivityAt),
                toMysqlDateTime(normalized.createdAt),
                toMysqlDateTime(normalized.updatedAt),
                newClarificationTrack(clarificationInput),
              ],
            );
          }

          await connection.execute(
            'DELETE FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ? AND clarification_id = ?',
            [tenantId, projectId, normalized.id],
          );

          for (const assignmentInput of clarificationInput.assignments ?? []) {
            const assignment = normalizeClarificationAssignment(assignmentInput);
            const actorId = assignment.actorType === 'stakeholder'
              ? (stakeholderIdMap.get(assignment.actorId) ?? assignment.actorId)
              : assignment.actorId;
            if (!actorId) {
              continue;
            }

            await connection.execute(
              `
                INSERT INTO project_clarification_assignments (
                  id,
                  tenant_id,
                  project_id,
                  clarification_id,
                  actor_type,
                  actor_id,
                  actor_label,
                  assignment_role,
                  created_at,
                  updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
              `,
              [
                assignment.id,
                tenantId,
                projectId,
                normalized.id,
                assignment.actorType,
                actorId,
                assignment.label,
                assignment.role,
              ],
            );
          }

          const stakeholderIds = (clarificationInput.assignments ?? [])
            .map((assignmentInput) => normalizeClarificationAssignment(assignmentInput))
            .filter((assignment) => assignment.actorType === 'stakeholder')
            .map((assignment) => stakeholderIdMap.get(assignment.actorId) ?? assignment.actorId)
            .filter(Boolean);

          await syncClarificationInvitationsMysql(connection, {
            clarificationId: normalized.id,
            projectId,
            stakeholderIds,
            tenantId,
          });
        }

        // Invited stakeholders join their digests in the same transaction as the save.
        if (scheduleInvitations?.at) {
          await scheduleInvitationsMysql(connection, { clarificationIds: scheduleInvitations.clarificationIds ?? null, projectId, scheduledAt: scheduleInvitations.at, tenantId });
        }

        return loadProjectClarificationViewsMysql(connection, { projectId, tenantId });
      });
    },
    async listProjectClarifications({ projectId, tenantId }) {
      return loadProjectClarificationViewsMysql(pool, { projectId, tenantId });
    },
    async getProjectClarification({ clarificationId, projectId, tenantId }) {
      const clarifications = await loadProjectClarificationViewsMysql(pool, { projectId, tenantId });
      return clarifications.find((clarification) => clarification.id === clarificationId) ?? null;
    },
    async updateProjectClarification({ clarificationId, patch = {}, projectId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          'SELECT id FROM project_clarifications WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1',
          [tenantId, projectId, clarificationId],
        );
        if (!rows[0]?.id) {
          return null;
        }

        if (patch.assignments) {
          await connection.execute(
            'DELETE FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ? AND clarification_id = ?',
            [tenantId, projectId, clarificationId],
          );

          for (const assignmentInput of patch.assignments) {
            const assignment = normalizeClarificationAssignment(assignmentInput);
            if (!assignment.actorId) {
              continue;
            }

            await connection.execute(
              `
                INSERT INTO project_clarification_assignments (
                  id,
                  tenant_id,
                  project_id,
                  clarification_id,
                  actor_type,
                  actor_id,
                  actor_label,
                  assignment_role,
                  created_at,
                  updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
              `,
              [
                assignment.id,
                tenantId,
                projectId,
                clarificationId,
                assignment.actorType,
                assignment.actorId,
                assignment.label,
                assignment.role,
              ],
            );
          }

          // Rolls back the assignment rows above when the expected recipients do not match.
          await syncClarificationInvitationsMysql(connection, {
            clarificationId,
            expectedRecipientIds: patch.expectedInvitationStakeholderIds ?? null,
            projectId,
            stakeholderIds: patch.assignments
              .filter((assignment) => assignment.actorType === 'stakeholder')
              .map((assignment) => assignment.actorId),
            tenantId,
          });
        }

        // Invited stakeholders join their digests in the same transaction as the save; a
        // failure here rolls the save back instead of leaving an unscheduled invitation.
        if (patch.scheduleInvitationsAt) {
          await scheduleInvitationsMysql(connection, { clarificationIds: [clarificationId], projectId, scheduledAt: patch.scheduleInvitationsAt, tenantId });
        }

        if (patch.currentAnswer !== undefined) {
          await connection.execute(
            `
              UPDATE project_clarifications
              SET current_answer = ?,
                  current_answer_updated_at = NOW(),
                  last_activity_at = NOW(),
                  updated_at = NOW()
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
            `,
            [normalizeString(patch.currentAnswer), tenantId, projectId, clarificationId],
          );
        }

        if (patch.latestInboundSummary !== undefined || patch.latestInboundSuggestedAnswer !== undefined) {
          await connection.execute(
            `
              UPDATE project_clarifications
              SET latest_inbound_summary = ?,
                  latest_inbound_suggested_answer = ?,
                  latest_inbound_summary_comment_id = ?,
                  latest_inbound_summary_updated_at = NOW(),
                  updated_at = NOW()
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
            `,
            [
              normalizeString(patch.latestInboundSummary),
              normalizeString(patch.latestInboundSuggestedAnswer),
              normalizePreferenceScopeValue(patch.latestInboundSummaryCommentId),
              tenantId,
              projectId,
              clarificationId,
            ],
          );
        }

        if (patch.status) {
          await connection.execute(
            `
              UPDATE project_clarifications
              SET clarification_status = ?,
                  updated_at = NOW()
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
            `,
            [normalizeString(patch.status), tenantId, projectId, clarificationId],
          );
        }

        if (patch.lifecycleState && CLARIFICATION_LIFECYCLE_STATES.has(normalizeString(patch.lifecycleState))) {
          await connection.execute(
            `
              UPDATE project_clarifications
              SET lifecycle_state = ?,
                  updated_at = NOW()
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
            `,
            [normalizeString(patch.lifecycleState), tenantId, projectId, clarificationId],
          );
        }

        return this.getProjectClarification({ clarificationId, projectId, tenantId });
      });
    },
    async addProjectClarificationComment({ clarificationId, comment, preserveStatus = false, projectId, tenantId }) {
      return withTransaction(pool, async (connection) => addProjectClarificationCommentMysql(connection, {
        clarificationId,
        comment,
        preserveStatus,
        projectId,
        tenantId,
      }));
    },
    async updateProjectClarificationComment({ body = '', clarificationId, commentId, preserveStatus = false, projectId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `
            SELECT id
            FROM project_clarification_comments
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId],
        );
        if (!rows[0]?.id) {
          return null;
        }

        await connection.execute(
          `
            UPDATE project_clarification_comments
            SET comment_body = ?,
                edited_at = NOW(),
                deleted_at = NULL,
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
          `,
          [normalizeString(body), tenantId, projectId, clarificationId, commentId],
        );

        await connection.execute(
          `
            UPDATE project_clarifications
            SET clarification_status = CASE
                  WHEN ? = 0 AND clarification_status IN ('open', 'answered') THEN 'answered'
                  ELSE clarification_status
                END,
                last_activity_at = NOW(),
                last_human_activity_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
          `,
          [preserveStatus ? 1 : 0, tenantId, projectId, clarificationId],
        );

        const [commentRows] = await connection.execute(
          `
            SELECT
              id,
              parent_comment_id AS parentCommentId,
              actor_type AS actorType,
              actor_id AS actorId,
              actor_label AS authorName,
              comment_body AS body,
              comment_source AS source,
              edited_at AS editedAt,
              deleted_at AS deletedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM project_clarification_comments
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId],
        );

        return commentRows[0] ? normalizeClarificationComment(commentRows[0]) : null;
      });
    },
    async deleteProjectClarificationComment({ clarificationId, commentId, preserveStatus = false, projectId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `
            SELECT id
            FROM project_clarification_comments
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId],
        );
        if (!rows[0]?.id) {
          return null;
        }

        const [[replyCountRow]] = await connection.execute(
          `
            SELECT COUNT(*) AS replyCount
            FROM project_clarification_comments
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND parent_comment_id = ?
          `,
          [tenantId, projectId, clarificationId, commentId],
        );
        const [[reactionCountRow]] = await connection.execute(
          `
            SELECT COUNT(*) AS reactionCount
            FROM project_clarification_comment_reactions
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND comment_id = ?
          `,
          [tenantId, projectId, clarificationId, commentId],
        );
        const hasReplies = Number(replyCountRow?.replyCount ?? 0) > 0;
        const hasReactions = Number(reactionCountRow?.reactionCount ?? 0) > 0;

        if (!hasReplies && !hasReactions) {
          await connection.execute(
            `
              DELETE FROM project_clarification_comments
              WHERE tenant_id = ?
                AND project_id = ?
                AND clarification_id = ?
                AND id = ?
            `,
            [tenantId, projectId, clarificationId, commentId],
          );
          await connection.execute(
            `
              DELETE FROM project_clarification_comment_reactions
              WHERE tenant_id = ?
                AND project_id = ?
                AND clarification_id = ?
                AND comment_id = ?
            `,
            [tenantId, projectId, clarificationId, commentId],
          );
          await connection.execute(
            `
              UPDATE project_clarifications
              SET last_activity_at = NOW(),
                  last_human_activity_at = NOW(),
                  updated_at = NOW()
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
            `,
            [tenantId, projectId, clarificationId],
          );

          return {
            hardDeleted: true,
            id: commentId,
          };
        }

        await connection.execute(
          `
            UPDATE project_clarification_comments
            SET comment_body = '',
                deleted_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
          `,
          [tenantId, projectId, clarificationId, commentId],
        );

        await connection.execute(
          `
            UPDATE project_clarifications
            SET clarification_status = CASE
                  WHEN ? = 0 AND clarification_status IN ('open', 'answered') THEN 'answered'
                  ELSE clarification_status
                END,
                last_activity_at = NOW(),
                last_human_activity_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
          `,
          [preserveStatus ? 1 : 0, tenantId, projectId, clarificationId],
        );

        const [commentRows] = await connection.execute(
          `
            SELECT
              id,
              parent_comment_id AS parentCommentId,
              actor_type AS actorType,
              actor_id AS actorId,
              actor_label AS authorName,
              comment_body AS body,
              comment_source AS source,
              edited_at AS editedAt,
              deleted_at AS deletedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM project_clarification_comments
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId],
        );

        return commentRows[0]
          ? {
              ...normalizeClarificationComment(commentRows[0]),
              hardDeleted: false,
            }
          : null;
      });
    },
    async voteProjectClarificationComment({
      actorId,
      actorType = 'user',
      clarificationId,
      commentId,
      projectId,
      tenantId,
      vote,
    }) {
      return withTransaction(pool, async (connection) => {
        const [commentRows] = await connection.execute(
          `
            SELECT id, deleted_at AS deletedAt
            FROM project_clarification_comments
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId],
        );
        if (!commentRows[0]?.id || commentRows[0].deletedAt) {
          return null;
        }

        const normalizedVote = vote === 'down' ? 'down' : 'up';
        const normalizedActorType = actorType === 'stakeholder' ? 'stakeholder' : 'user';
        const [reactionRows] = await connection.execute(
          `
            SELECT id, reaction
            FROM project_clarification_comment_reactions
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND comment_id = ?
              AND actor_type = ?
              AND actor_id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId, normalizedActorType, normalizePreferenceScopeValue(actorId)],
        );

        if (!reactionRows[0]) {
          await connection.execute(
            `
              INSERT INTO project_clarification_comment_reactions (
                id,
                tenant_id,
                project_id,
                clarification_id,
                comment_id,
                actor_type,
                actor_id,
                reaction,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            `,
            [randomUUID(), tenantId, projectId, clarificationId, commentId, normalizedActorType, normalizePreferenceScopeValue(actorId), normalizedVote],
          );
        } else if (reactionRows[0].reaction === normalizedVote) {
          await connection.execute(
            'DELETE FROM project_clarification_comment_reactions WHERE id = ?',
            [reactionRows[0].id],
          );
        } else {
          await connection.execute(
            `
              UPDATE project_clarification_comment_reactions
              SET reaction = ?,
                  updated_at = NOW()
              WHERE id = ?
            `,
            [normalizedVote, reactionRows[0].id],
          );
        }

        await connection.execute(
          `
            UPDATE project_clarifications
            SET last_activity_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
          `,
          [tenantId, projectId, clarificationId],
        );

        const [[summaryRow]] = await connection.execute(
          `
            SELECT
              SUM(CASE WHEN reaction = 'up' THEN 1 ELSE 0 END) AS upvotes,
              SUM(CASE WHEN reaction = 'down' THEN 1 ELSE 0 END) AS downvotes
            FROM project_clarification_comment_reactions
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND comment_id = ?
          `,
          [tenantId, projectId, clarificationId, commentId],
        );
        const [currentReactionRows] = await connection.execute(
          `
            SELECT reaction
            FROM project_clarification_comment_reactions
            WHERE tenant_id = ?
              AND project_id = ?
              AND clarification_id = ?
              AND comment_id = ?
              AND actor_type = ?
              AND actor_id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId, commentId, normalizedActorType, normalizePreferenceScopeValue(actorId)],
        );

        return {
          commentId,
          currentReaction: currentReactionRows[0]?.reaction === 'down'
            ? 'down'
            : currentReactionRows[0]?.reaction === 'up'
              ? 'up'
              : null,
          downvotes: Number(summaryRow?.downvotes ?? 0),
          upvotes: Number(summaryRow?.upvotes ?? 0),
        };
      });
    },
    async listClarificationInvitations({ clarificationId = '', projectId, tenantId }) {
      const invitations = await loadProjectClarificationInvitationsMysql(pool, { projectId, tenantId });
      return invitations.filter((invitation) => !clarificationId || invitation.clarificationId === clarificationId);
    },
    async syncClarificationInvitations({ clarificationId, projectId, stakeholderIds = [], tenantId }) {
      return withTransaction(pool, async (connection) => syncClarificationInvitationsMysql(connection, {
        clarificationId,
        projectId,
        stakeholderIds,
        tenantId,
      }));
    },
    async findClarificationInvitationById({ invitationId }) {
      return findClarificationInvitationByIdMysql(pool, { invitationId });
    },
    async markClarificationInvitationQueued({ invitationId, projectId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        await connection.execute(
          `
            UPDATE project_clarification_invitations
            SET mail_status = 'pending',
                last_error = '',
                queued_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
          `,
          [tenantId, projectId, invitationId],
        );
        const [rows] = await connection.execute(
          `
            SELECT
              id,
              clarification_id AS clarificationId,
              stakeholder_id AS stakeholderId,
              invitation_token AS invitationToken,
              reply_token AS replyToken,
              mail_status AS mailStatus,
              queued_at AS queuedAt,
              sent_at AS sentAt,
              last_inbound_at AS lastInboundAt,
              last_provider_message_id AS lastProviderMessageId,
              last_error AS lastError,
              deactivated_at AS deactivatedAt,
              scheduled_at AS scheduledAt,
              delivery_id AS deliveryId,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM project_clarification_invitations
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, invitationId],
        );
        return rows[0] ? normalizeClarificationInvitation({
          ...rows[0],
          projectId,
          tenantId,
        }) : null;
      });
    },
    async markClarificationInvitationDelivery({ invitationId, lastError = '', mailStatus = 'sent', projectId, providerMessageId = '', tenantId }) {
      return withTransaction(pool, async (connection) => {
        await connection.execute(
          `
            UPDATE project_clarification_invitations
            SET mail_status = ?,
                last_error = ?,
                last_provider_message_id = COALESCE(?, last_provider_message_id),
                sent_at = CASE WHEN ? = 'sent' THEN NOW() ELSE sent_at END,
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
          `,
          [
            CLARIFICATION_MAIL_STATUSES.has(normalizeString(mailStatus)) ? normalizeString(mailStatus) : 'sent',
            normalizeString(lastError),
            normalizePreferenceScopeValue(providerMessageId),
            CLARIFICATION_MAIL_STATUSES.has(normalizeString(mailStatus)) ? normalizeString(mailStatus) : 'sent',
            tenantId,
            projectId,
            invitationId,
          ],
        );
        const [rows] = await connection.execute(
          `
            SELECT
              id,
              clarification_id AS clarificationId,
              stakeholder_id AS stakeholderId,
              invitation_token AS invitationToken,
              reply_token AS replyToken,
              mail_status AS mailStatus,
              queued_at AS queuedAt,
              sent_at AS sentAt,
              last_inbound_at AS lastInboundAt,
              last_provider_message_id AS lastProviderMessageId,
              last_error AS lastError,
              deactivated_at AS deactivatedAt,
              scheduled_at AS scheduledAt,
              delivery_id AS deliveryId,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM project_clarification_invitations
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, invitationId],
        );
        return rows[0] ? normalizeClarificationInvitation({
          ...rows[0],
          projectId,
          tenantId,
        }) : null;
      });
    },
    async markClarificationInvitationInbound({ invitationId, projectId, providerMessageId = '', tenantId }) {
      return withTransaction(pool, async (connection) => {
        await connection.execute(
          `
            UPDATE project_clarification_invitations
            SET last_inbound_at = NOW(),
                last_provider_message_id = COALESCE(?, last_provider_message_id),
                updated_at = NOW()
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
          `,
          [
            normalizePreferenceScopeValue(providerMessageId),
            tenantId,
            projectId,
            invitationId,
          ],
        );
        const [rows] = await connection.execute(
          `
            SELECT
              id,
              clarification_id AS clarificationId,
              stakeholder_id AS stakeholderId,
              invitation_token AS invitationToken,
              reply_token AS replyToken,
              mail_status AS mailStatus,
              queued_at AS queuedAt,
              sent_at AS sentAt,
              last_inbound_at AS lastInboundAt,
              last_provider_message_id AS lastProviderMessageId,
              last_error AS lastError,
              deactivated_at AS deactivatedAt,
              scheduled_at AS scheduledAt,
              delivery_id AS deliveryId,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM project_clarification_invitations
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, invitationId],
        );
        return rows[0] ? normalizeClarificationInvitation({
          ...rows[0],
          projectId,
          tenantId,
        }) : null;
      });
    },
    async resolveClarificationInvitationByReply({ fromEmail = '', replyToken }) {
      const invitation = await findClarificationInvitationByReplyTokenMysql(pool, { replyToken });
      if (!invitation) {
        return null;
      }
      const stakeholder = await findProjectStakeholderByIdMysql(pool, {
        projectId: invitation.projectId,
        stakeholderId: invitation.stakeholderId,
        tenantId: invitation.tenantId,
      });
      if (!stakeholder) {
        return null;
      }
      const normalizedFrom = normalizeString(fromEmail).toLowerCase();
      if (normalizedFrom && stakeholder.email !== normalizedFrom) {
        return null;
      }
      return {
        invitation,
        stakeholder,
      };
    },
    async recordClarificationEmailMessage({ value }) {
      return withTransaction(pool, async (connection) => {
        const normalized = normalizeClarificationEmailMessage(value);
        const [existingRows] = await connection.execute(
          `
            SELECT
              id,
              provider_message_id AS providerMessageId,
              invitation_id AS invitationId,
              message_direction AS direction,
              from_email AS fromEmail,
              to_email AS toEmail,
              subject,
              normalized_body AS normalizedBody,
              in_reply_to AS inReplyTo,
              processed_at AS processedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM project_clarification_email_messages
            WHERE invitation_id = ?
              AND provider_message_id = ?
            LIMIT 1
          `,
          [normalized.invitationId, normalized.providerMessageId],
        );
        if (existingRows[0]) {
          return {
            duplicate: true,
            message: normalizeClarificationEmailMessage({
              ...existingRows[0],
              projectId: normalized.projectId,
              tenantId: normalized.tenantId,
            }),
          };
        }

        await connection.execute(
          `
            INSERT INTO project_clarification_email_messages (
              id,
              tenant_id,
              project_id,
              invitation_id,
              provider_message_id,
              message_direction,
              from_email,
              to_email,
              subject,
              normalized_body,
              in_reply_to,
              processed_at,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `,
          [
            normalized.id,
            normalized.tenantId,
            normalized.projectId,
            normalized.invitationId,
            normalized.providerMessageId,
            normalized.direction,
            normalized.fromEmail,
            normalized.toEmail,
            normalized.subject,
            normalized.normalizedBody,
            normalizePreferenceScopeValue(normalized.inReplyTo),
            toMysqlDateTime(normalized.processedAt),
          ],
        );

        return {
          duplicate: false,
          message: normalized,
        };
      });
    },
    async applyClarificationDiscussionReview({
      clarificationId,
      comment = '',
      currentAnswer = '',
      explicit = false,
      projectId,
      tenantId,
    }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `
            SELECT
              id,
              clarification_status AS status,
              last_human_activity_at AS lastHumanActivityAt,
              last_activity_at AS lastActivityAt,
              last_auto_comment_activity_at AS lastAutoCommentActivityAt
            FROM project_clarifications
            WHERE tenant_id = ?
              AND project_id = ?
              AND id = ?
            LIMIT 1
          `,
          [tenantId, projectId, clarificationId],
        );
        const clarification = rows[0] ?? null;
        if (!clarification) {
          return null;
        }

        if (normalizeString(currentAnswer)) {
          await connection.execute(
            `
              UPDATE project_clarifications
              SET current_answer = ?,
                  current_answer_updated_at = NOW(),
                  last_reviewed_activity_at = ?,
                  clarification_status = CASE
                    WHEN clarification_status = 'open' THEN 'answered'
                    ELSE clarification_status
                  END,
                  updated_at = NOW()
              WHERE tenant_id = ?
                AND project_id = ?
                AND id = ?
            `,
            [
              normalizeString(currentAnswer),
              toMysqlDateTime(clarification.lastHumanActivityAt ?? clarification.lastActivityAt ?? nowIso()),
              tenantId,
              projectId,
              clarificationId,
            ],
          );
        }

        const canAutoComment = explicit
          || !clarification.lastHumanActivityAt
          || clarification.lastAutoCommentActivityAt !== clarification.lastHumanActivityAt;

        if (normalizeString(comment) && canAutoComment) {
          await addProjectClarificationCommentMysql(connection, {
            clarificationId,
            comment: {
              actorId: 'odin-ai',
              actorType: 'assistant',
              authorName: 'Odin-AI',
              body: normalizeString(comment),
              source: explicit ? 'ask-odin' : 'review',
            },
            projectId,
            tenantId,
          });

          if (!explicit) {
            await connection.execute(
              `
                UPDATE project_clarifications
                SET last_auto_comment_activity_at = ?,
                    updated_at = NOW()
                WHERE tenant_id = ?
                  AND project_id = ?
                  AND id = ?
              `,
              [toMysqlDateTime(clarification.lastHumanActivityAt ?? nowIso()), tenantId, projectId, clarificationId],
            );
          }
        }

        return this.getProjectClarification({ clarificationId, projectId, tenantId });
      });
    },
    async getProjectClarificationAccessContext({ accessToken }) {
      const invitation = await findClarificationInvitationByTokenMysql(pool, { invitationToken: accessToken });
      let clarifications = null;
      const stakeholder = invitation
        ? await findProjectStakeholderByIdMysql(pool, {
            projectId: invitation.projectId,
            stakeholderId: invitation.stakeholderId,
            tenantId: invitation.tenantId,
          })
        : await findProjectStakeholderByAccessTokenMysql(pool, { accessToken });
      if (!stakeholder && invitation) {
        clarifications = await loadProjectClarificationViewsMysql(pool, {
          projectId: invitation.projectId,
          tenantId: invitation.tenantId,
        });
      }
      const resolvedStakeholder = stakeholder ?? buildStakeholderFallbackForInvitation(invitation, clarifications);
      if (!resolvedStakeholder) {
        return null;
      }

      clarifications = (clarifications ?? await loadProjectClarificationViewsMysql(pool, {
        projectId: resolvedStakeholder.projectId,
        tenantId: resolvedStakeholder.tenantId,
      })).filter((clarification) => {
        return clarification.status !== 'dismissed'
          && clarification.assignments.some((assignment) => assignment.actorType === 'stakeholder' && assignment.actorId === resolvedStakeholder.id);
      }).map((clarification) => ({
        ...clarification,
        accessToken: resolvedStakeholder.accessToken,
      }));

      return excludeRequirementsTopics(this, {
        clarifications,
        focusClarificationId: invitation?.clarificationId ?? null,
        projectId: resolvedStakeholder.projectId,
        stakeholder: resolvedStakeholder,
        stakeholders: await loadProjectStakeholdersMysql(pool, {
          projectId: resolvedStakeholder.projectId,
          tenantId: resolvedStakeholder.tenantId,
        }),
        tenantId: resolvedStakeholder.tenantId,
      }, invitation);
    },
    async findClarificationByAccessToken({ accessToken }) {
      const accessContext = await this.getProjectClarificationAccessContext({ accessToken });
      if (!accessContext) {
        return null;
      }

      const raw = await getPreference(pool, {
        key: ASSISTANT_PROJECT_STATE_KEY,
        projectId: accessContext.projectId,
        tenantId: accessContext.tenantId,
        userId: null,
      });
      const artifactsState = normalizeStoredProjectArtifactsState(safeJsonParse(raw, createEmptyProjectArtifactsState()));
      return buildCompatibilityAccessResult({
        accessContext,
        artifactsState,
      });
    },
    async findProjectStakeholderById({ projectId, stakeholderId, tenantId }) {
      return findProjectStakeholderByIdMysql(pool, { projectId, stakeholderId, tenantId });
    },
    // The stakeholders with this email on every project in the workspace (access links).
    async listStakeholdersByEmail({ email, tenantId }) {
      const address = normalizeString(email).toLowerCase();
      if (!address) return [];
      const [rows] = await pool.execute(
        'SELECT id, project_id AS projectId, name, email, role_title AS roleTitle FROM project_stakeholders WHERE tenant_id = ? AND email = ? ORDER BY project_id, id',
        [tenantId, address],
      );
      return rows.map((row) => ({ email: row.email, id: row.id, name: row.name ?? '', projectId: row.projectId, roleTitle: row.roleTitle ?? '' }));
    },
  };
}
