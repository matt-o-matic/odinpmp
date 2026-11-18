import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { LINK_REQUEST_PURPOSE } from './requirements-access-links.js';

// Requirements storage. Topics are rows in project_clarifications with a track; their
// threads, assignments, invitations, and votes stay in the clarification tables and are
// read through the assistant repository. This repository owns the track metadata and the
// requirements tables created by migrations 0051-0056, and the 0063 backfill.
//
// The migration functions below are checksummed by the migration runner once applied.
// Never edit their bodies; add a new migration instead.

export const REQUIREMENTS_TRACKS = Object.freeze(['experience', 'architecture']);
// Review is project-wide: one round open at a time, numbered across the project, with
// questions from either track. Packages and rounds keep their stored track column, always
// this value, so earlier rounds and their numbers carry over unchanged.
export const REVIEW_TRACK = 'experience';
export const TOPIC_ORIGINS = Object.freeze(['assistant', 'brief-draft', 'clarification', 'manual', 'package-question']);
export const DECISION_KINDS = Object.freeze(['topic', 'preference', 'round']);
export const DECISION_OUTCOMES = Object.freeze(['agreed', 'decided', 'deferred', 'superseded']);
export const LINK_TOKEN_PURPOSES = Object.freeze(['manual', 'invitation', 'reminder']);

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

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [tableName, indexName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

// 0051_requirements_tracks
export async function ensureMysqlRequirementsTracksSchema(executor) {
  const topicColumns = [
    ['track', 'VARCHAR(16) NULL'],
    ['topic_origin', 'VARCHAR(16) NULL'],
    ['created_by', 'VARCHAR(80) NULL'],
    ['source_ref', 'VARCHAR(160) NULL'],
    ['suggested_owner_role', 'VARCHAR(120) NULL'],
  ];

  for (const [columnName, definition] of topicColumns) {
    if (!await columnExists(executor, 'project_clarifications', columnName)) {
      await executor.execute(`ALTER TABLE project_clarifications ADD COLUMN ${columnName} ${definition}`);
    }
  }

  if (!await indexExists(executor, 'project_clarifications', 'idx_project_clarifications_track')) {
    await executor.execute('CREATE INDEX idx_project_clarifications_track ON project_clarifications (tenant_id, project_id, track)');
  }
}

// 0052_requirements_links
// One link per project and stakeholder carries the lifetime; every email or manual share
// gets its own token. Tokens are stored only as hashes.
export async function ensureMysqlRequirementsLinksSchema(executor) {
  if (!await tableExists(executor, 'requirements_access_links')) {
    await executor.execute(`
      CREATE TABLE requirements_access_links (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        stakeholder_id VARCHAR(36) NOT NULL,
        issued_at DATETIME(3) NOT NULL,
        extended_until DATETIME(3) NULL,
        extended_by VARCHAR(80) NULL,
        revoked_at DATETIME(3) NULL,
        revoked_by VARCHAR(80) NULL,
        created_by VARCHAR(80) NOT NULL,
        last_used_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_requirements_access_links_stakeholder (tenant_id, project_id, stakeholder_id),
        KEY idx_requirements_access_links_project (tenant_id, project_id)
      )
    `);
  }

  if (!await tableExists(executor, 'requirements_access_link_tokens')) {
    await executor.execute(`
      CREATE TABLE requirements_access_link_tokens (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        link_id VARCHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        purpose VARCHAR(16) NOT NULL,
        created_by VARCHAR(80) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        last_used_at DATETIME(3) NULL,
        revoked_at DATETIME(3) NULL,
        UNIQUE KEY uq_requirements_access_link_tokens_hash (token_hash),
        KEY idx_requirements_access_link_tokens_link (link_id)
      )
    `);
  }
}

// 0053_review_packages
export async function ensureMysqlReviewPackagesSchema(executor) {
  if (!await tableExists(executor, 'review_packages')) {
    await executor.execute(`
      CREATE TABLE review_packages (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NOT NULL,
        version INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        manifest_json JSON NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'draft',
        source VARCHAR(16) NOT NULL DEFAULT 'ui',
        size_bytes BIGINT NOT NULL DEFAULT 0,
        file_count INT NOT NULL DEFAULT 0,
        uploaded_by VARCHAR(80) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_review_packages_version (tenant_id, project_id, track, version),
        KEY idx_review_packages_uploader (tenant_id, project_id, uploaded_by, status)
      )
    `);
  }

  if (!await tableExists(executor, 'review_package_screens')) {
    await executor.execute(`
      CREATE TABLE review_package_screens (
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        package_id VARCHAR(36) NOT NULL,
        screen_id VARCHAR(120) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        src VARCHAR(512) NOT NULL,
        content_hash CHAR(64) NOT NULL,
        direction_id VARCHAR(120) NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (package_id, screen_id),
        KEY idx_review_package_screens_project (tenant_id, project_id)
      )
    `);
  }
}

// 0054_review_rounds
export async function ensureMysqlReviewRoundsSchema(executor) {
  if (!await tableExists(executor, 'review_rounds')) {
    await executor.execute(`
      CREATE TABLE review_rounds (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NOT NULL,
        package_id VARCHAR(36) NOT NULL,
        number INT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'draft',
        due_at DATETIME(3) NULL,
        note MEDIUMTEXT NULL,
        published_by VARCHAR(80) NULL,
        published_at DATETIME(3) NULL,
        closed_by VARCHAR(80) NULL,
        outcome VARCHAR(32) NULL,
        closed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_review_rounds_number (tenant_id, project_id, track, number),
        KEY idx_review_rounds_status (tenant_id, project_id, status)
      )
    `);
  }

  if (!await tableExists(executor, 'review_round_reviewers')) {
    await executor.execute(`
      CREATE TABLE review_round_reviewers (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        round_id VARCHAR(36) NOT NULL,
        actor_type VARCHAR(16) NOT NULL,
        actor_id VARCHAR(36) NOT NULL,
        required TINYINT(1) NOT NULL DEFAULT 0,
        invited_at DATETIME(3) NULL,
        last_seen_at DATETIME(3) NULL,
        submitted_at DATETIME(3) NULL,
        removed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_review_round_reviewers_actor (round_id, actor_type, actor_id),
        KEY idx_review_round_reviewers_actor (tenant_id, project_id, actor_type, actor_id)
      )
    `);
  }
}

// 0055_review_feedback
export async function ensureMysqlReviewFeedbackSchema(executor) {
  if (!await tableExists(executor, 'review_annotations')) {
    await executor.execute(`
      CREATE TABLE review_annotations (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        round_id VARCHAR(36) NOT NULL,
        package_id VARCHAR(36) NOT NULL,
        package_version INT NOT NULL,
        screen_id VARCHAR(120) NOT NULL,
        state_key VARCHAR(512) NULL,
        pin_id VARCHAR(36) NULL,
        anchor_json JSON NOT NULL,
        shapes_json JSON NOT NULL,
        schema_version INT NOT NULL DEFAULT 1,
        snapshot_file_id VARCHAR(36) NULL,
        element_hint_json JSON NULL,
        category VARCHAR(40) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        author_type VARCHAR(16) NOT NULL,
        author_id VARCHAR(36) NOT NULL,
        author_name VARCHAR(255) NOT NULL DEFAULT '',
        carried_from_id VARCHAR(36) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY idx_review_annotations_round_screen (tenant_id, project_id, round_id, screen_id),
        KEY idx_review_annotations_package (package_id, screen_id, status)
      )
    `);
  }

  if (!await tableExists(executor, 'review_comments')) {
    await executor.execute(`
      CREATE TABLE review_comments (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        annotation_id VARCHAR(36) NOT NULL,
        parent_comment_id VARCHAR(36) NULL,
        author_type VARCHAR(16) NOT NULL,
        author_id VARCHAR(36) NOT NULL,
        author_name VARCHAR(255) NOT NULL DEFAULT '',
        body MEDIUMTEXT NOT NULL,
        edited_at DATETIME(3) NULL,
        deleted_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY idx_review_comments_annotation (tenant_id, project_id, annotation_id)
      )
    `);
  }

  if (!await tableExists(executor, 'review_verdicts')) {
    await executor.execute(`
      CREATE TABLE review_verdicts (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        round_id VARCHAR(36) NOT NULL,
        actor_type VARCHAR(16) NOT NULL,
        actor_id VARCHAR(36) NOT NULL,
        target_type VARCHAR(16) NOT NULL,
        target_id VARCHAR(120) NOT NULL,
        dimension VARCHAR(40) NOT NULL DEFAULT 'overall',
        value VARCHAR(32) NOT NULL,
        keep_note MEDIUMTEXT NULL,
        change_note MEDIUMTEXT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_review_verdicts_target (round_id, actor_type, actor_id, target_type, target_id, dimension),
        KEY idx_review_verdicts_round (tenant_id, project_id, round_id)
      )
    `);
  }

  if (!await tableExists(executor, 'review_answers')) {
    await executor.execute(`
      CREATE TABLE review_answers (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        round_id VARCHAR(36) NOT NULL,
        actor_type VARCHAR(16) NOT NULL,
        actor_id VARCHAR(36) NOT NULL,
        question_id VARCHAR(120) NOT NULL,
        value_json JSON NOT NULL,
        posted_comment_id VARCHAR(36) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_review_answers_question (round_id, actor_type, actor_id, question_id),
        KEY idx_review_answers_round (tenant_id, project_id, round_id)
      )
    `);
  }
}

// 0056_requirements_decisions
export async function ensureMysqlRequirementsDecisionsSchema(executor) {
  if (!await tableExists(executor, 'requirements_decisions')) {
    await executor.execute(`
      CREATE TABLE requirements_decisions (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NOT NULL,
        topic_id VARCHAR(36) NULL,
        round_id VARCHAR(36) NULL,
        kind VARCHAR(16) NOT NULL,
        statement MEDIUMTEXT NOT NULL,
        outcome VARCHAR(16) NOT NULL,
        sources_json JSON NOT NULL,
        preference_dimension VARCHAR(80) NULL,
        preference_stance VARCHAR(16) NULL,
        source_summary_id VARCHAR(36) NULL,
        source_item_key VARCHAR(120) NULL,
        decided_by VARCHAR(80) NOT NULL,
        decided_by_name VARCHAR(255) NOT NULL DEFAULT '',
        decided_at DATETIME(3) NOT NULL,
        supersedes_id VARCHAR(36) NULL,
        superseded_by_id VARCHAR(36) NULL,
        superseded_at DATETIME(3) NULL,
        version INT NOT NULL DEFAULT 1,
        updated_by VARCHAR(80) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY idx_requirements_decisions_track (tenant_id, project_id, track, decided_at),
        KEY idx_requirements_decisions_topic (tenant_id, project_id, topic_id)
      )
    `);
  }

  if (!await tableExists(executor, 'requirements_summaries')) {
    await executor.execute(`
      CREATE TABLE requirements_summaries (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NULL,
        scope_type VARCHAR(16) NOT NULL,
        scope_id VARCHAR(160) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'ok',
        output_json JSON NULL,
        dropped_json JSON NULL,
        error_message TEXT NULL,
        model VARCHAR(120) NULL,
        input_digest CHAR(64) NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_requirements_summaries_scope (tenant_id, project_id, scope_type, scope_id, created_at),
        KEY idx_requirements_summaries_track (tenant_id, project_id, track, created_at)
      )
    `);
  }

  if (!await tableExists(executor, 'requirements_plans')) {
    await executor.execute(`
      CREATE TABLE requirements_plans (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NOT NULL,
        version INT NOT NULL,
        body_markdown MEDIUMTEXT NOT NULL,
        criteria_json JSON NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'draft',
        created_by VARCHAR(80) NOT NULL,
        approved_by VARCHAR(80) NULL,
        approved_at DATETIME(3) NULL,
        row_version INT NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_requirements_plans_version (tenant_id, project_id, track, version)
      )
    `);
  }
}

// 0063_clarification_topics_backfill
// Requirements topics replace the older clarification system. Every clarification without
// a track becomes an Experience topic; people move the ones that belong to the Functional track.
export async function backfillMysqlClarificationTopics(executor) {
  await executor.execute(`
    UPDATE project_clarifications
    SET track = 'experience', topic_origin = COALESCE(topic_origin, 'clarification')
    WHERE track IS NULL
  `);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function nullableString(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.valueOf() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function compareIso(left, right) {
  return (toMs(left) ?? 0) - (toMs(right) ?? 0);
}

function decisionConflict(code, message, details = {}) {
  return new HttpError(409, message, { details: { code, ...details } });
}

function normalizeDecisionRecord(record) {
  return {
    createdAt: toIso(record.createdAt),
    decidedAt: toIso(record.decidedAt),
    decidedBy: normalizeString(record.decidedBy),
    decidedByName: normalizeString(record.decidedByName),
    id: record.id,
    kind: record.kind,
    outcome: record.outcome,
    preferenceDimension: nullableString(record.preferenceDimension),
    preferenceStance: nullableString(record.preferenceStance),
    projectId: record.projectId,
    roundId: nullableString(record.roundId),
    sourceItemKey: nullableString(record.sourceItemKey),
    sourceSummaryId: nullableString(record.sourceSummaryId),
    sources: Array.isArray(record.sources) ? clone(record.sources) : [],
    statement: normalizeString(record.statement),
    supersededAt: toIso(record.supersededAt),
    supersededById: nullableString(record.supersededById),
    supersedesId: nullableString(record.supersedesId),
    tenantId: record.tenantId,
    topicId: nullableString(record.topicId),
    track: record.track,
    updatedAt: toIso(record.updatedAt),
    updatedBy: nullableString(record.updatedBy),
    version: Number(record.version ?? 1),
  };
}

function normalizeTokenRecord(record) {
  return {
    createdAt: toIso(record.createdAt),
    createdBy: normalizeString(record.createdBy),
    id: record.id,
    lastUsedAt: toIso(record.lastUsedAt),
    linkId: record.linkId,
    purpose: record.purpose,
    revokedAt: toIso(record.revokedAt),
  };
}

function normalizeLinkRecord(record, tokens = []) {
  return {
    createdAt: toIso(record.createdAt),
    createdBy: normalizeString(record.createdBy),
    extendedBy: nullableString(record.extendedBy),
    extendedUntil: toIso(record.extendedUntil),
    id: record.id,
    issuedAt: toIso(record.issuedAt),
    lastUsedAt: toIso(record.lastUsedAt),
    projectId: record.projectId,
    revokedAt: toIso(record.revokedAt),
    revokedBy: nullableString(record.revokedBy),
    stakeholderId: record.stakeholderId,
    tenantId: record.tenantId,
    tokens: tokens
      .map(normalizeTokenRecord)
      .sort((left, right) => compareIso(left.createdAt, right.createdAt)),
    updatedAt: toIso(record.updatedAt),
  };
}

function linkRevokedError() {
  return new HttpError(409, 'link_revoked', {
    details: { code: 'link_revoked', message: 'This stakeholder link was turned off. A project admin or manager can issue a new one.' },
  });
}

function normalizeSummaryRecord(record) {
  return {
    createdAt: toIso(record.createdAt),
    dropped: Array.isArray(record.dropped) ? clone(record.dropped) : [],
    errorMessage: normalizeString(record.errorMessage),
    id: record.id,
    inputDigest: nullableString(record.inputDigest),
    model: nullableString(record.model),
    output: record.output && typeof record.output === 'object' ? clone(record.output) : null,
    projectId: record.projectId,
    scopeId: normalizeString(record.scopeId),
    scopeType: normalizeString(record.scopeType),
    status: normalizeString(record.status) || 'ok',
    tenantId: record.tenantId,
    track: nullableString(record.track),
  };
}

// Newest run per scope. By default only 'ok' runs count: that row is the current summary.
// Ties on created_at go to the later row in the list.
function latestPerScope(summaries = [], { okOnly = true } = {}) {
  const latest = new Map();
  for (const summary of summaries) {
    if (okOnly && summary.status !== 'ok') continue;
    const key = `${summary.scopeType}:${summary.scopeId}`;
    const current = latest.get(key);
    if (!current || compareIso(summary.createdAt, current.createdAt) >= 0) {
      latest.set(key, summary);
    }
  }
  return [...latest.values()];
}

function topicMetaFromRecord(record) {
  return {
    createdBy: nullableString(record.createdBy),
    id: record.id,
    sourceRef: nullableString(record.sourceRef),
    suggestedOwnerRole: nullableString(record.suggestedOwnerRole),
    topicOrigin: nullableString(record.topicOrigin),
    track: nullableString(record.track),
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests and local tooling). Topics live in the in-memory
// assistant repository's clarification state, so the existing comment, vote, and
// assignment functions see the same rows.
// ---------------------------------------------------------------------------

export function createInMemoryRequirementsRepository({ assistantRepository = null } = {}) {
  const state = {
    decisions: [],
    links: [],
    packages: [],
    plans: [],
    roundReviewers: [],
    rounds: [],
    // Who is asked to sign what (docs/document-signing): the signing repository supplies it.
    signingInvolvement: null,
    summaries: [],
    tokens: [],
  };

  function linkTokens(linkId) {
    return state.tokens.filter((token) => token.linkId === linkId);
  }

  function clarificationRecords() {
    return assistantRepository?.state?.projectClarifications ?? [];
  }

  function requireAssistantState() {
    if (!assistantRepository?.state?.projectClarifications || !assistantRepository?.syncProjectClarifications) {
      throw new Error('The in-memory requirements repository needs the in-memory assistant repository.');
    }
  }

  function findRecord({ projectId, tenantId, id }) {
    return clarificationRecords().find((record) => record.id === id
      && record.projectId === projectId
      && record.tenantId === tenantId) ?? null;
  }

  function scoped(list, { projectId, tenantId }) {
    return list.filter((item) => item.projectId === projectId && item.tenantId === tenantId);
  }

  function findDecision({ projectId, tenantId, decisionId }) {
    return state.decisions.find((item) => item.id === decisionId
      && item.projectId === projectId
      && item.tenantId === tenantId) ?? null;
  }

  return {
    state,

    async listTopicMeta({ projectId, tenantId }) {
      return clarificationRecords()
        .filter((record) => record.projectId === projectId && record.tenantId === tenantId && record.track)
        .map(topicMetaFromRecord);
    },

    async getTopicTrack({ clarificationId, projectId, tenantId }) {
      return nullableString(findRecord({ id: clarificationId, projectId, tenantId })?.track);
    },

    async listTopicStatuses({ projectId, tenantId, topicIds = [] }) {
      const ids = new Set(topicIds);
      return clarificationRecords()
        .filter((record) => ids.has(record.id) && record.projectId === projectId && record.tenantId === tenantId && record.track)
        .map((record) => ({ id: record.id, status: normalizeString(record.status) || 'open' }));
    },

    async createTopics({ projectId, tenantId, topics = [] }) {
      requireAssistantState();
      await assistantRepository.syncProjectClarifications({
        clarifications: topics.map((topic) => ({
          assignments: [],
          blockingArea: topic.blockingArea,
          id: topic.id,
          lifecycleState: 'committed',
          linkedSection: topic.linkedSection,
          prompt: topic.prompt,
          proposedDraftImpact: '',
          rationale: topic.rationale,
          status: 'open',
        })),
        projectId,
        stakeholderContacts: [],
        tenantId,
      });

      for (const topic of topics) {
        const record = findRecord({ id: topic.id, projectId, tenantId });
        Object.assign(record, {
          createdBy: nullableString(topic.createdBy),
          sourceRef: nullableString(topic.sourceRef),
          suggestedOwnerRole: nullableString(topic.suggestedOwnerRole),
          topicOrigin: nullableString(topic.topicOrigin),
          track: topic.track,
        });
      }

      return topics.map((topic) => topic.id);
    },

    async updateTopicFields({ projectId, tenantId, topicId, patch = {} }) {
      const record = findRecord({ id: topicId, projectId, tenantId });
      if (!record?.track) return false;
      if (patch.prompt !== undefined) record.prompt = normalizeString(patch.prompt);
      if (patch.rationale !== undefined) record.rationale = normalizeString(patch.rationale);
      if (patch.blockingArea !== undefined) record.blockingArea = normalizeString(patch.blockingArea);
      if (patch.suggestedOwnerRole !== undefined) record.suggestedOwnerRole = nullableString(patch.suggestedOwnerRole);
      record.updatedAt = new Date().toISOString();
      return true;
    },

    async deleteTopic({ projectId, tenantId, topicId }) {
      const record = findRecord({ id: topicId, projectId, tenantId });
      if (!record?.track) return null;
      const assistantState = assistantRepository.state;
      const sameTopic = (item) => item.clarificationId === topicId && item.projectId === projectId && item.tenantId === tenantId;
      const activity = {
        comments: assistantState.projectClarificationComments.filter(sameTopic).length,
        decisions: state.decisions.filter((decision) => decision.topicId === topicId && decision.projectId === projectId && decision.tenantId === tenantId).length,
        stakeholderAssignments: assistantState.projectClarificationAssignments
          .filter((assignment) => sameTopic(assignment) && assignment.actorType === 'stakeholder').length,
      };
      if (activity.comments + activity.decisions + activity.stakeholderAssignments > 0) {
        return { activity, deleted: false };
      }

      const invitationIds = new Set(assistantState.projectClarificationInvitations.filter(sameTopic).map((invitation) => invitation.id));
      assistantState.projectClarifications = assistantState.projectClarifications.filter((item) => item !== record);
      assistantState.projectClarificationAssignments = assistantState.projectClarificationAssignments.filter((item) => !sameTopic(item));
      assistantState.projectClarificationInvitations = assistantState.projectClarificationInvitations.filter((item) => !sameTopic(item));
      assistantState.projectClarificationCommentReactions = assistantState.projectClarificationCommentReactions.filter((item) => !sameTopic(item));
      assistantState.projectClarificationEmailMessages = assistantState.projectClarificationEmailMessages
        .filter((message) => !invitationIds.has(message.invitationId));
      state.summaries = state.summaries.filter((summary) => !(summary.scopeType === 'topic'
        && summary.scopeId === topicId
        && summary.projectId === projectId
        && summary.tenantId === tenantId));
      return { activity, deleted: true };
    },

    async moveTopic({ projectId, tenantId, toTrack, topicId }) {
      const record = findRecord({ id: topicId, projectId, tenantId });
      if (!record?.track) return null;
      const fromTrack = record.track;
      if (fromTrack === toTrack) return { decisions: 0, fromTrack, moved: false, toTrack };
      const sameProject = (item) => item.projectId === projectId && item.tenantId === tenantId;
      record.track = toTrack;
      record.updatedAt = new Date().toISOString();
      let decisions = 0;
      for (const decision of state.decisions) {
        if (sameProject(decision) && decision.topicId === topicId) {
          decision.track = toTrack;
          decisions += 1;
        }
      }
      for (const summary of state.summaries) {
        if (sameProject(summary) && summary.scopeType === 'topic' && summary.scopeId === topicId) summary.track = toTrack;
      }
      return { decisions, fromTrack, moved: true, toTrack };
    },

    // Access links ----------------------------------------------------------

    async issueAccessToken({ createdBy, now, projectId, purpose, reactivateRevoked = false, stakeholderId, tenantId, tokenHash }) {
      const timestamp = toIso(now);
      let link = state.links.find((item) => item.projectId === projectId
        && item.tenantId === tenantId
        && item.stakeholderId === stakeholderId) ?? null;
      const linkCreated = !link;
      let reactivated = false;

      if (!link) {
        link = {
          createdAt: timestamp,
          createdBy,
          extendedBy: null,
          extendedUntil: null,
          id: randomUUID(),
          issuedAt: timestamp,
          lastUsedAt: null,
          projectId,
          revokedAt: null,
          revokedBy: null,
          stakeholderId,
          tenantId,
          updatedAt: timestamp,
        };
        state.links.push(link);
      } else if (link.revokedAt) {
        if (!reactivateRevoked) throw linkRevokedError();
        // Reactivation starts a fresh window. Tokens revoked with the link stay revoked.
        Object.assign(link, {
          extendedBy: null,
          extendedUntil: null,
          issuedAt: timestamp,
          revokedAt: null,
          revokedBy: null,
          updatedAt: timestamp,
        });
        reactivated = true;
      } else {
        link.issuedAt = timestamp;
        link.updatedAt = timestamp;
      }

      const token = {
        createdAt: timestamp,
        createdBy,
        id: randomUUID(),
        lastUsedAt: null,
        linkId: link.id,
        projectId,
        purpose,
        revokedAt: null,
        tenantId,
        tokenHash,
      };
      state.tokens.push(token);
      return {
        link: normalizeLinkRecord(link, linkTokens(link.id)),
        linkCreated,
        reactivated,
        token: normalizeTokenRecord(token),
      };
    },

    // A token on an existing link that leaves the link as it is, so its lifetime is unchanged.
    // Access links mint these to open the portal (docs/task-access/plan.md).
    async mintLinkToken({ createdBy, linkId, now, purpose, tenantId, tokenHash }) {
      const link = state.links.find((item) => item.id === linkId && item.tenantId === tenantId) ?? null;
      if (!link) return null;
      const token = {
        createdAt: toIso(now), createdBy, id: randomUUID(), lastUsedAt: null, linkId,
        projectId: link.projectId, purpose, revokedAt: null, tenantId, tokenHash,
      };
      state.tokens.push(token);
      return normalizeTokenRecord(token);
    },

    // Revokes, across the workspace, the live tokens one creator minted.
    async revokeTokensCreatedBy({ createdBy, now, tenantId }) {
      let revoked = 0;
      for (const token of state.tokens) {
        if (token.tenantId === tenantId && token.createdBy === createdBy && !token.revokedAt) {
          token.revokedAt = toIso(now);
          revoked += 1;
        }
      }
      return revoked;
    },

    async recordLinkRequest({ linkId, now, requestedBy, tokenHash }) {
      const link = state.links.find((item) => item.id === linkId) ?? null;
      if (!link) return null;
      const timestamp = toIso(now);
      const token = {
        createdAt: timestamp,
        createdBy: requestedBy,
        id: randomUUID(),
        lastUsedAt: null,
        linkId,
        projectId: link.projectId,
        purpose: LINK_REQUEST_PURPOSE,
        revokedAt: timestamp,
        tenantId: link.tenantId,
        tokenHash,
      };
      state.tokens.push(token);
      return normalizeTokenRecord(token);
    },

    async findAccessTokenByHash({ tokenHash }) {
      const token = state.tokens.find((item) => item.tokenHash === tokenHash) ?? null;
      const link = token ? state.links.find((item) => item.id === token.linkId) ?? null : null;
      return token && link ? { link: normalizeLinkRecord(link, linkTokens(link.id)), token: normalizeTokenRecord(token) } : null;
    },

    async getAccessLink({ linkId, projectId, tenantId }) {
      const record = scoped(state.links, { projectId, tenantId }).find((link) => link.id === linkId) ?? null;
      return record ? normalizeLinkRecord(record, linkTokens(record.id)) : null;
    },

    async getAccessLinkForStakeholder({ projectId, stakeholderId, tenantId }) {
      const record = scoped(state.links, { projectId, tenantId }).find((link) => link.stakeholderId === stakeholderId) ?? null;
      return record ? normalizeLinkRecord(record, linkTokens(record.id)) : null;
    },

    async listAccessLinks({ projectId, tenantId }) {
      return scoped(state.links, { projectId, tenantId })
        .map((link) => normalizeLinkRecord(link, linkTokens(link.id)))
        .sort((left, right) => compareIso(left.createdAt, right.createdAt));
    },

    async revokeAccessLink({ linkId, now, projectId, revokedBy, tenantId }) {
      const record = scoped(state.links, { projectId, tenantId }).find((link) => link.id === linkId) ?? null;
      if (!record) return null;
      if (!record.revokedAt) {
        record.revokedAt = toIso(now);
        record.revokedBy = revokedBy;
        record.updatedAt = toIso(now);
      }
      for (const token of state.tokens) {
        if (token.linkId === record.id && !token.revokedAt) token.revokedAt = toIso(now);
      }
      return normalizeLinkRecord(record, linkTokens(record.id));
    },

    async extendAccessLink({ extendedBy, extendedUntil, linkId, now, projectId, tenantId }) {
      const record = scoped(state.links, { projectId, tenantId }).find((link) => link.id === linkId) ?? null;
      if (!record) return null;
      record.extendedUntil = toIso(extendedUntil);
      record.extendedBy = extendedBy;
      record.updatedAt = toIso(now);
      return normalizeLinkRecord(record, linkTokens(record.id));
    },

    async touchAccessLink({ linkId, now, tokenId = null }) {
      const record = state.links.find((link) => link.id === linkId) ?? null;
      if (record) record.lastUsedAt = toIso(now);
      const token = tokenId ? state.tokens.find((item) => item.id === tokenId) ?? null : null;
      if (token) token.lastUsedAt = toIso(now);
    },

    async listStakeholderInvolvement({ projectId, stakeholderId, tenantId }) {
      const invitations = (assistantRepository?.state?.projectClarificationInvitations ?? [])
        .filter((invitation) => invitation.projectId === projectId
          && invitation.tenantId === tenantId
          && invitation.stakeholderId === stakeholderId);
      const topics = invitations.flatMap((invitation) => {
        const record = findRecord({ id: invitation.clarificationId, projectId, tenantId });
        if (!record?.track) return [];
        return [{
          clarificationId: record.id,
          deactivatedAt: toIso(invitation.deactivatedAt),
          invitedAt: toIso(invitation.createdAt),
          status: normalizeString(record.status) || 'open',
          topicUpdatedAt: toIso(record.updatedAt),
        }];
      });
      const rounds = scoped(state.roundReviewers, { projectId, tenantId })
        .filter((reviewer) => reviewer.actorType === 'stakeholder' && reviewer.actorId === stakeholderId)
        .flatMap((reviewer) => {
          const round = state.rounds.find((item) => item.id === reviewer.roundId) ?? null;
          if (!round) return [];
          return [{
            closedAt: toIso(round.closedAt),
            invitedAt: toIso(reviewer.invitedAt),
            removedAt: toIso(reviewer.removedAt),
            roundId: round.id,
            status: round.status,
          }];
        });
      const signings = state.signingInvolvement ? await state.signingInvolvement({ projectId, stakeholderId, tenantId }) : [];
      return { rounds, signings, topics };
    },

    /** Where listStakeholderInvolvement reads signature requests from (the in-memory signing repository). */
    setSigningInvolvementSource(source) {
      state.signingInvolvement = source;
    },

    // Summaries -------------------------------------------------------------

    async createSummary({ projectId, summary, tenantId }) {
      const record = normalizeSummaryRecord({
        ...summary,
        createdAt: summary.createdAt ?? new Date().toISOString(),
        id: summary.id ?? randomUUID(),
        projectId,
        tenantId,
      });
      state.summaries.push(record);
      return clone(record);
    },

    async listLatestSummaries({ projectId, scopeType = '', tenantId, track = '' }) {
      return latestPerScope(scoped(state.summaries, { projectId, tenantId })
        .filter((summary) => (!scopeType || summary.scopeType === scopeType) && (!track || summary.track === track)))
        .map(clone);
    },

    /** What each listed summary run summarized: [{ id, scopeId, scopeType }]. */
    async listSummaryScopes({ projectId, summaryIds = [], tenantId }) {
      const ids = new Set(summaryIds);
      return scoped(state.summaries, { projectId, tenantId })
        .filter((summary) => ids.has(summary.id))
        .map((summary) => ({ id: summary.id, scopeId: summary.scopeId, scopeType: summary.scopeType }));
    },

    /** The newest run of any status per scope (drives "refresh failed" and read-time refresh). */
    async listLatestSummaryAttempts({ projectId, scopeType = '', tenantId }) {
      return latestPerScope(scoped(state.summaries, { projectId, tenantId })
        .filter((summary) => !scopeType || summary.scopeType === scopeType), { okOnly: false })
        .map(clone);
    },

    /** The current summary of one scope: its newest 'ok' run. */
    async getCurrentSummary({ projectId, scopeId, scopeType, tenantId }) {
      const [current] = latestPerScope(scoped(state.summaries, { projectId, tenantId })
        .filter((summary) => summary.scopeType === scopeType && summary.scopeId === scopeId));
      return current ? clone(current) : null;
    },

    /** Every run of one scope, newest first. */
    async listSummaryRuns({ limit = 50, projectId, scopeId, scopeType, tenantId }) {
      return scoped(state.summaries, { projectId, tenantId })
        .map((summary, index) => ({ index, summary }))
        .filter(({ summary }) => summary.scopeType === scopeType && summary.scopeId === scopeId)
        .sort((left, right) => compareIso(right.summary.createdAt, left.summary.createdAt) || right.index - left.index)
        .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
        .map(({ summary }) => clone(summary));
    },

    // Rounds, packages, and plans (read paths for U1; later units write them) -----

    async insertRound({ projectId, reviewers = [], round, tenantId }) {
      const now = new Date().toISOString();
      const record = {
        closedAt: toIso(round.closedAt),
        closedBy: nullableString(round.closedBy),
        createdAt: now,
        dueAt: toIso(round.dueAt),
        id: round.id ?? randomUUID(),
        note: normalizeString(round.note),
        number: Number(round.number ?? 1),
        outcome: nullableString(round.outcome),
        packageId: round.packageId,
        projectId,
        publishedAt: toIso(round.publishedAt),
        publishedBy: nullableString(round.publishedBy),
        status: round.status ?? 'draft',
        tenantId,
        title: normalizeString(round.title),
        track: round.track,
        updatedAt: now,
      };
      state.rounds.push(record);
      for (const reviewer of reviewers) {
        state.roundReviewers.push({
          actorId: reviewer.actorId,
          actorType: reviewer.actorType,
          id: randomUUID(),
          invitedAt: toIso(reviewer.invitedAt ?? now),
          lastSeenAt: toIso(reviewer.lastSeenAt),
          projectId,
          removedAt: toIso(reviewer.removedAt),
          required: Boolean(reviewer.required),
          roundId: record.id,
          submittedAt: toIso(reviewer.submittedAt),
          tenantId,
        });
      }
      return clone(record);
    },

    async listRounds({ projectId, tenantId, track = '' }) {
      return scoped(state.rounds, { projectId, tenantId })
        .filter((round) => !track || round.track === track)
        .map((round) => ({
          ...clone(round),
          reviewers: state.roundReviewers.filter((reviewer) => reviewer.roundId === round.id).map(clone),
        }))
        .sort((left, right) => left.number - right.number);
    },

    async insertPackage({ pkg, projectId, tenantId }) {
      const now = new Date().toISOString();
      const record = {
        createdAt: toIso(pkg.createdAt) ?? now,
        fileCount: Number(pkg.fileCount ?? 0),
        id: pkg.id ?? randomUUID(),
        projectId,
        sizeBytes: Number(pkg.sizeBytes ?? 0),
        source: pkg.source ?? 'ui',
        status: pkg.status ?? 'draft',
        tenantId,
        title: normalizeString(pkg.title),
        track: pkg.track,
        updatedAt: now,
        uploadedBy: pkg.uploadedBy,
        version: Number(pkg.version ?? 1),
      };
      state.packages.push(record);
      return clone(record);
    },

    async listPackages({ projectId, status = '', tenantId, track = '', uploadedBy = '' }) {
      return scoped(state.packages, { projectId, tenantId })
        .filter((pkg) => (!track || pkg.track === track)
          && (!status || pkg.status === status)
          && (!uploadedBy || pkg.uploadedBy === uploadedBy))
        .map(clone)
        .sort((left, right) => left.version - right.version);
    },

    async insertPlan({ plan, projectId, tenantId }) {
      const now = new Date().toISOString();
      const record = {
        approvedAt: toIso(plan.approvedAt),
        approvedBy: nullableString(plan.approvedBy),
        createdAt: now,
        createdBy: plan.createdBy,
        id: plan.id ?? randomUUID(),
        projectId,
        status: plan.status ?? 'draft',
        tenantId,
        track: plan.track,
        updatedAt: now,
        version: Number(plan.version ?? 1),
      };
      state.plans.push(record);
      return clone(record);
    },

    async listPlans({ projectId, tenantId, track = '' }) {
      return scoped(state.plans, { projectId, tenantId })
        .filter((plan) => !track || plan.track === track)
        .map(clone)
        .sort((left, right) => left.version - right.version);
    },

    // Decisions -------------------------------------------------------------

    async listDecisions({ kind = '', projectId, tenantId, topicId = '', track = '' }) {
      return scoped(state.decisions, { projectId, tenantId })
        .filter((decision) => (!track || decision.track === track)
          && (!topicId || decision.topicId === topicId)
          && (!kind || decision.kind === kind))
        .map(normalizeDecisionRecord)
        .sort((left, right) => compareIso(right.decidedAt, left.decidedAt));
    },

    async getDecision({ decisionId, projectId, tenantId }) {
      const record = findDecision({ decisionId, projectId, tenantId });
      return record ? normalizeDecisionRecord(record) : null;
    },

    async createDecision({ decision, projectId, supersedesId = null, tenantId, topicStatus = null }) {
      let topicRecord = null;
      if (decision.topicId) {
        topicRecord = findRecord({ id: decision.topicId, projectId, tenantId });
        if (!topicRecord?.track) throw new HttpError(404, 'Topic not found.');
      }

      const superseded = supersedesId ? findDecision({ decisionId: supersedesId, projectId, tenantId }) : null;
      if (supersedesId && (!superseded || superseded.track !== decision.track)) {
        throw new HttpError(404, 'Decision to supersede not found.');
      }
      if (superseded?.supersededById) {
        throw decisionConflict('decision_superseded', 'That decision has already been superseded.', { supersededById: superseded.supersededById });
      }

      if (decision.kind === 'topic' && decision.topicId) {
        const active = state.decisions.find((item) => item.topicId === decision.topicId
          && item.kind === 'topic'
          && item.projectId === projectId
          && item.tenantId === tenantId
          && !item.supersededById) ?? null;
        if (active && active.id !== supersedesId) {
          throw decisionConflict('decision_exists', 'This topic already has a decision. Supersede it to record a new one.', { activeDecisionId: active.id });
        }
      }

      const timestamp = toIso(decision.decidedAt) ?? new Date().toISOString();
      const record = {
        ...decision,
        createdAt: timestamp,
        decidedAt: timestamp,
        id: decision.id ?? randomUUID(),
        projectId,
        supersededAt: null,
        supersededById: null,
        supersedesId: supersedesId ?? null,
        tenantId,
        updatedAt: timestamp,
        updatedBy: null,
        version: 1,
      };
      state.decisions.push(record);

      if (superseded) {
        superseded.supersededById = record.id;
        superseded.supersededAt = timestamp;
        superseded.updatedAt = timestamp;
        superseded.version += 1;
      }
      if (topicRecord && topicStatus) {
        topicRecord.status = topicStatus;
        topicRecord.updatedAt = timestamp;
        topicRecord.lastActivityAt = timestamp;
      }

      return normalizeDecisionRecord(record);
    },

    async updateDecision({ decisionId, expectedVersion, patch = {}, projectId, tenantId, topicStatus = null, updatedBy, now }) {
      const record = findDecision({ decisionId, projectId, tenantId });
      if (!record) return null;
      if (record.supersededById) {
        throw decisionConflict('decision_superseded', 'Superseded decisions cannot be edited.', { supersededById: record.supersededById });
      }
      if (Number(record.version) !== Number(expectedVersion)) {
        throw decisionConflict('decision_version_conflict', 'This decision changed since you loaded it. Reload and try again.', {
          currentVersion: record.version,
        });
      }

      const timestamp = toIso(now) ?? new Date().toISOString();
      if (patch.statement !== undefined) record.statement = patch.statement;
      if (patch.outcome !== undefined) record.outcome = patch.outcome;
      if (patch.sources !== undefined) record.sources = clone(patch.sources);
      record.updatedBy = updatedBy;
      record.updatedAt = timestamp;
      record.version += 1;

      if (record.topicId && topicStatus) {
        const topicRecord = findRecord({ id: record.topicId, projectId, tenantId });
        if (topicRecord) {
          topicRecord.status = topicStatus;
          topicRecord.updatedAt = timestamp;
          topicRecord.lastActivityAt = timestamp;
        }
      }

      return normalizeDecisionRecord(record);
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL implementation
// ---------------------------------------------------------------------------

// Timestamps are written with FROM_UNIXTIME and read with UNIX_TIMESTAMP so they share
// the session time zone with rows the clarification code writes through NOW(). That keeps
// lifetime arithmetic correct whatever time zone the Node process runs in.
function unixSeconds(value) {
  const ms = toMs(value);
  return ms === null ? null : ms / 1000;
}

function fromUnix(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)).toISOString() : null;
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
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

const LINK_COLUMNS = `
  id,
  tenant_id AS tenantId,
  project_id AS projectId,
  stakeholder_id AS stakeholderId,
  UNIX_TIMESTAMP(issued_at) AS issuedAt,
  UNIX_TIMESTAMP(extended_until) AS extendedUntil,
  extended_by AS extendedBy,
  UNIX_TIMESTAMP(revoked_at) AS revokedAt,
  revoked_by AS revokedBy,
  created_by AS createdBy,
  UNIX_TIMESTAMP(last_used_at) AS lastUsedAt,
  UNIX_TIMESTAMP(created_at) AS createdAt,
  UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const TOKEN_COLUMNS = `
  id,
  link_id AS linkId,
  purpose,
  created_by AS createdBy,
  UNIX_TIMESTAMP(created_at) AS createdAt,
  UNIX_TIMESTAMP(last_used_at) AS lastUsedAt,
  UNIX_TIMESTAMP(revoked_at) AS revokedAt
`;

function mapTokenRow(row) {
  return {
    ...row,
    createdAt: fromUnix(row.createdAt),
    lastUsedAt: fromUnix(row.lastUsedAt),
    revokedAt: fromUnix(row.revokedAt),
  };
}

function mapLinkRow(row, tokenRows = []) {
  return normalizeLinkRecord({
    ...row,
    createdAt: fromUnix(row.createdAt),
    extendedUntil: fromUnix(row.extendedUntil),
    issuedAt: fromUnix(row.issuedAt),
    lastUsedAt: fromUnix(row.lastUsedAt),
    revokedAt: fromUnix(row.revokedAt),
    updatedAt: fromUnix(row.updatedAt),
  }, tokenRows.filter((token) => token.linkId === row.id).map(mapTokenRow));
}

const DECISION_COLUMNS = `
  id,
  tenant_id AS tenantId,
  project_id AS projectId,
  track,
  topic_id AS topicId,
  round_id AS roundId,
  kind,
  statement,
  outcome,
  sources_json AS sourcesJson,
  preference_dimension AS preferenceDimension,
  preference_stance AS preferenceStance,
  source_summary_id AS sourceSummaryId,
  source_item_key AS sourceItemKey,
  decided_by AS decidedBy,
  decided_by_name AS decidedByName,
  UNIX_TIMESTAMP(decided_at) AS decidedAt,
  supersedes_id AS supersedesId,
  superseded_by_id AS supersededById,
  UNIX_TIMESTAMP(superseded_at) AS supersededAt,
  version,
  updated_by AS updatedBy,
  UNIX_TIMESTAMP(created_at) AS createdAt,
  UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

function mapDecisionRow(row) {
  return normalizeDecisionRecord({
    ...row,
    createdAt: fromUnix(row.createdAt),
    decidedAt: fromUnix(row.decidedAt),
    sources: parseJsonColumn(row.sourcesJson, []),
    supersededAt: fromUnix(row.supersededAt),
    updatedAt: fromUnix(row.updatedAt),
  });
}

export async function selectMysqlDecision(executor, { decisionId, forUpdate = false, projectId, tenantId }) {
  const [rows] = await executor.execute(
    `SELECT ${DECISION_COLUMNS} FROM requirements_decisions WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, projectId, decisionId],
  );
  return rows[0] ? mapDecisionRow(rows[0]) : null;
}

/**
 * Inserts one decision row on the caller's connection, so another repository can record a
 * decision inside its own transaction (closing a round). Checks nothing; createDecision
 * owns the topic and supersede rules.
 */
export async function insertMysqlDecision(connection, { decision, id, projectId, supersedesId = null, tenantId }) {
  const decidedAtSeconds = unixSeconds(decision.decidedAt ?? new Date());
  await connection.execute(
    `
      INSERT INTO requirements_decisions (
        id, tenant_id, project_id, track, topic_id, round_id, kind, statement, outcome, sources_json,
        preference_dimension, preference_stance, source_summary_id, source_item_key,
        decided_by, decided_by_name, decided_at, supersedes_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, 1, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
    `,
    [
      id, tenantId, projectId, decision.track, nullableString(decision.topicId), nullableString(decision.roundId), decision.kind,
      decision.statement, decision.outcome, JSON.stringify(decision.sources ?? []),
      nullableString(decision.preferenceDimension), nullableString(decision.preferenceStance),
      nullableString(decision.sourceSummaryId), nullableString(decision.sourceItemKey),
      decision.decidedBy, normalizeString(decision.decidedByName), decidedAtSeconds, supersedesId ?? null,
      decidedAtSeconds, decidedAtSeconds,
    ],
  );
}

function summaryColumns(alias = '') {
  const column = (name) => (alias ? `${alias}.${name}` : name);
  return `
    ${column('id')} AS id,
    ${column('tenant_id')} AS tenantId,
    ${column('project_id')} AS projectId,
    ${column('track')} AS track,
    ${column('scope_type')} AS scopeType,
    ${column('scope_id')} AS scopeId,
    ${column('status')} AS status,
    ${column('output_json')} AS outputJson,
    ${column('dropped_json')} AS droppedJson,
    ${column('error_message')} AS errorMessage,
    ${column('model')} AS model,
    ${column('input_digest')} AS inputDigest,
    UNIX_TIMESTAMP(${column('created_at')}) AS createdAt
  `;
}

function mapSummaryRow(row) {
  return normalizeSummaryRecord({
    ...row,
    createdAt: fromUnix(row.createdAt),
    dropped: parseJsonColumn(row.droppedJson, []),
    output: parseJsonColumn(row.outputJson, null),
  });
}

export function createMysqlRequirementsRepository({ pool }) {
  async function lockTopic(connection, { projectId, tenantId, topicId }) {
    const [rows] = await connection.execute(
      `
        SELECT id, track, clarification_status AS status
        FROM project_clarifications
        WHERE tenant_id = ? AND project_id = ? AND id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [tenantId, projectId, topicId],
    );
    return rows[0] ?? null;
  }

  async function setTopicStatus(connection, { nowSeconds, projectId, status, tenantId, topicId }) {
    await connection.execute(
      `
        UPDATE project_clarifications
        SET clarification_status = ?,
            last_activity_at = FROM_UNIXTIME(?),
            updated_at = FROM_UNIXTIME(?)
        WHERE tenant_id = ? AND project_id = ? AND id = ?
      `,
      [status, nowSeconds, nowSeconds, tenantId, projectId, topicId],
    );
  }

  const selectDecision = selectMysqlDecision;

  return {
    async listTopicMeta({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT
            id,
            track,
            topic_origin AS topicOrigin,
            created_by AS createdBy,
            source_ref AS sourceRef,
            suggested_owner_role AS suggestedOwnerRole
          FROM project_clarifications
          WHERE tenant_id = ? AND project_id = ? AND track IS NOT NULL
        `,
        [tenantId, projectId],
      );
      return rows.map(topicMetaFromRecord);
    },

    async getTopicTrack({ clarificationId, projectId, tenantId }) {
      const [rows] = await pool.execute(
        'SELECT track FROM project_clarifications WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1',
        [tenantId, projectId, clarificationId],
      );
      return nullableString(rows[0]?.track);
    },

    async listTopicStatuses({ projectId, tenantId, topicIds = [] }) {
      if (topicIds.length === 0) return [];
      const [rows] = await pool.execute(
        `SELECT id, clarification_status AS status FROM project_clarifications WHERE tenant_id = ? AND project_id = ? AND track IS NOT NULL AND id IN (${topicIds.map(() => '?').join(', ')})`,
        [tenantId, projectId, ...topicIds],
      );
      return rows.map((row) => ({ id: row.id, status: normalizeString(row.status) || 'open' }));
    },

    async createTopics({ projectId, tenantId, topics = [] }) {
      return withTransaction(pool, async (connection) => {
        for (const topic of topics) {
          await connection.execute(
            `
              INSERT INTO project_clarifications (
                id, tenant_id, project_id, linked_section, blocking_area, prompt, rationale,
                proposed_draft_impact, lifecycle_state, clarification_status, current_answer,
                last_activity_at, created_at, updated_at,
                track, topic_origin, created_by, source_ref, suggested_owner_role
              ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'committed', 'open', '', NOW(), NOW(), NOW(), ?, ?, ?, ?, ?)
            `,
            [
              topic.id,
              tenantId,
              projectId,
              topic.linkedSection,
              normalizeString(topic.blockingArea).slice(0, 160),
              topic.prompt,
              normalizeString(topic.rationale),
              topic.track,
              nullableString(topic.topicOrigin),
              nullableString(topic.createdBy),
              nullableString(topic.sourceRef),
              nullableString(topic.suggestedOwnerRole),
            ],
          );
        }
        return topics.map((topic) => topic.id);
      });
    },

    async updateTopicFields({ projectId, tenantId, topicId, patch = {} }) {
      const assignments = [];
      const params = [];
      if (patch.prompt !== undefined) { assignments.push('prompt = ?'); params.push(normalizeString(patch.prompt)); }
      if (patch.rationale !== undefined) { assignments.push('rationale = ?'); params.push(normalizeString(patch.rationale)); }
      if (patch.blockingArea !== undefined) { assignments.push('blocking_area = ?'); params.push(normalizeString(patch.blockingArea).slice(0, 160)); }
      if (patch.suggestedOwnerRole !== undefined) { assignments.push('suggested_owner_role = ?'); params.push(nullableString(patch.suggestedOwnerRole)); }
      if (assignments.length === 0) return true;
      const [result] = await pool.execute(
        `UPDATE project_clarifications SET ${assignments.join(', ')}, updated_at = NOW() WHERE tenant_id = ? AND project_id = ? AND id = ? AND track IS NOT NULL`,
        [...params, tenantId, projectId, topicId],
      );
      return Number(result.affectedRows) > 0;
    },

    async deleteTopic({ projectId, tenantId, topicId }) {
      return withTransaction(pool, async (connection) => {
        const topic = await lockTopic(connection, { projectId, tenantId, topicId });
        if (!topic?.track) return null;
        const count = async (sql) => Number((await connection.execute(sql, [tenantId, projectId, topicId]))[0][0]?.count ?? 0);
        const activity = {
          comments: await count('SELECT COUNT(*) AS count FROM project_clarification_comments WHERE tenant_id = ? AND project_id = ? AND clarification_id = ?'),
          decisions: await count('SELECT COUNT(*) AS count FROM requirements_decisions WHERE tenant_id = ? AND project_id = ? AND topic_id = ?'),
          stakeholderAssignments: await count("SELECT COUNT(*) AS count FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ? AND clarification_id = ? AND actor_type = 'stakeholder'"),
        };
        if (activity.comments + activity.decisions + activity.stakeholderAssignments > 0) {
          return { activity, deleted: false };
        }

        const scope = [tenantId, projectId, topicId];
        await connection.execute(
          `
            DELETE m FROM project_clarification_email_messages m
            JOIN project_clarification_invitations i ON i.id = m.invitation_id
            WHERE i.tenant_id = ? AND i.project_id = ? AND i.clarification_id = ?
          `,
          scope,
        );
        await connection.execute('DELETE FROM project_clarification_invitations WHERE tenant_id = ? AND project_id = ? AND clarification_id = ?', scope);
        await connection.execute('DELETE FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ? AND clarification_id = ?', scope);
        await connection.execute('DELETE FROM project_clarification_comment_reactions WHERE tenant_id = ? AND project_id = ? AND clarification_id = ?', scope);
        await connection.execute("DELETE FROM requirements_summaries WHERE tenant_id = ? AND project_id = ? AND scope_type = 'topic' AND scope_id = ?", scope);
        await connection.execute('DELETE FROM project_clarifications WHERE tenant_id = ? AND project_id = ? AND id = ?', scope);
        return { activity, deleted: true };
      });
    },

    async moveTopic({ projectId, tenantId, toTrack, topicId }) {
      return withTransaction(pool, async (connection) => {
        const topic = await lockTopic(connection, { projectId, tenantId, topicId });
        if (!topic?.track) return null;
        const fromTrack = topic.track;
        if (fromTrack === toTrack) return { decisions: 0, fromTrack, moved: false, toTrack };
        const scope = [toTrack, tenantId, projectId, topicId];
        await connection.execute('UPDATE project_clarifications SET track = ?, updated_at = NOW() WHERE tenant_id = ? AND project_id = ? AND id = ?', scope);
        // Decisions and summaries keep their own copy of the track; they follow the topic.
        const [decisionResult] = await connection.execute('UPDATE requirements_decisions SET track = ? WHERE tenant_id = ? AND project_id = ? AND topic_id = ?', scope);
        await connection.execute("UPDATE requirements_summaries SET track = ? WHERE tenant_id = ? AND project_id = ? AND scope_type = 'topic' AND scope_id = ?", scope);
        return { decisions: Number(decisionResult.affectedRows ?? 0), fromTrack, moved: true, toTrack };
      });
    },

    // Access links ----------------------------------------------------------

    async issueAccessToken({ createdBy, now, projectId, purpose, reactivateRevoked = false, stakeholderId, tenantId, tokenHash }) {
      const nowSeconds = unixSeconds(now);
      const result = await withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `SELECT id, revoked_at AS revokedAt FROM requirements_access_links WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ? LIMIT 1 FOR UPDATE`,
          [tenantId, projectId, stakeholderId],
        );
        let linkId = rows[0]?.id ?? null;
        const linkCreated = !linkId;
        let reactivated = false;

        if (!linkId) {
          linkId = randomUUID();
          await connection.execute(
            `
              INSERT INTO requirements_access_links (
                id, tenant_id, project_id, stakeholder_id, issued_at, created_by, created_at, updated_at
              ) VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
            `,
            [linkId, tenantId, projectId, stakeholderId, nowSeconds, createdBy, nowSeconds, nowSeconds],
          );
        } else if (rows[0].revokedAt) {
          if (!reactivateRevoked) throw linkRevokedError();
          // Reactivation starts a fresh window. Tokens revoked with the link stay revoked.
          await connection.execute(
            `
              UPDATE requirements_access_links
              SET issued_at = FROM_UNIXTIME(?), extended_until = NULL, extended_by = NULL,
                  revoked_at = NULL, revoked_by = NULL, updated_at = FROM_UNIXTIME(?)
              WHERE id = ?
            `,
            [nowSeconds, nowSeconds, linkId],
          );
          reactivated = true;
        } else {
          await connection.execute(
            'UPDATE requirements_access_links SET issued_at = FROM_UNIXTIME(?), updated_at = FROM_UNIXTIME(?) WHERE id = ?',
            [nowSeconds, nowSeconds, linkId],
          );
        }

        const tokenId = randomUUID();
        await connection.execute(
          `
            INSERT INTO requirements_access_link_tokens (
              id, tenant_id, project_id, link_id, token_hash, purpose, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))
          `,
          [tokenId, tenantId, projectId, linkId, tokenHash, purpose, createdBy, nowSeconds],
        );
        return { linkCreated, linkId, reactivated, tokenId };
      });

      const link = await this.getAccessLink({ linkId: result.linkId, projectId, tenantId });
      return {
        link,
        linkCreated: result.linkCreated,
        reactivated: result.reactivated,
        token: link.tokens.find((token) => token.id === result.tokenId),
      };
    },

    async mintLinkToken({ createdBy, linkId, now, purpose, tenantId, tokenHash }) {
      const [links] = await pool.execute('SELECT project_id AS projectId FROM requirements_access_links WHERE id = ? AND tenant_id = ? LIMIT 1', [linkId, tenantId]);
      if (!links[0]) return null;
      const id = randomUUID();
      await pool.execute(
        `
          INSERT INTO requirements_access_link_tokens (
            id, tenant_id, project_id, link_id, token_hash, purpose, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))
        `,
        [id, tenantId, links[0].projectId, linkId, tokenHash, purpose, createdBy, unixSeconds(now)],
      );
      const [rows] = await pool.execute(`SELECT ${TOKEN_COLUMNS} FROM requirements_access_link_tokens WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? normalizeTokenRecord(mapTokenRow(rows[0])) : null;
    },

    async revokeTokensCreatedBy({ createdBy, now, tenantId }) {
      const [result] = await pool.execute(
        'UPDATE requirements_access_link_tokens SET revoked_at = FROM_UNIXTIME(?) WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL',
        [unixSeconds(now), tenantId, createdBy],
      );
      return Number(result?.affectedRows ?? 0);
    },

    async recordLinkRequest({ linkId, now, requestedBy, tokenHash }) {
      const [links] = await pool.execute('SELECT tenant_id AS tenantId, project_id AS projectId FROM requirements_access_links WHERE id = ? LIMIT 1', [linkId]);
      if (!links[0]) return null;
      const id = randomUUID();
      const nowSeconds = unixSeconds(now);
      await pool.execute(
        `
          INSERT INTO requirements_access_link_tokens (
            id, tenant_id, project_id, link_id, token_hash, purpose, created_by, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [id, links[0].tenantId, links[0].projectId, linkId, tokenHash, LINK_REQUEST_PURPOSE, requestedBy, nowSeconds, nowSeconds],
      );
      const link = await this.getAccessLink({ linkId, projectId: links[0].projectId, tenantId: links[0].tenantId });
      return link?.tokens.find((token) => token.id === id) ?? null;
    },

    async findAccessTokenByHash({ tokenHash }) {
      const [rows] = await pool.execute(
        `SELECT ${TOKEN_COLUMNS}, tenant_id AS tenantId, project_id AS projectId FROM requirements_access_link_tokens WHERE token_hash = ? LIMIT 1`,
        [tokenHash],
      );
      if (!rows[0]) return null;
      const link = await this.getAccessLink({ linkId: rows[0].linkId, projectId: rows[0].projectId, tenantId: rows[0].tenantId });
      return link ? { link, token: normalizeTokenRecord(mapTokenRow(rows[0])) } : null;
    },

    async getAccessLink({ linkId, projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT ${LINK_COLUMNS} FROM requirements_access_links WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1`,
        [tenantId, projectId, linkId],
      );
      if (!rows[0]) return null;
      const [tokenRows] = await pool.execute(`SELECT ${TOKEN_COLUMNS} FROM requirements_access_link_tokens WHERE link_id = ?`, [linkId]);
      return mapLinkRow(rows[0], tokenRows);
    },

    async getAccessLinkForStakeholder({ projectId, stakeholderId, tenantId }) {
      const [rows] = await pool.execute(
        'SELECT id FROM requirements_access_links WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ? LIMIT 1',
        [tenantId, projectId, stakeholderId],
      );
      return rows[0] ? this.getAccessLink({ linkId: rows[0].id, projectId, tenantId }) : null;
    },

    async listAccessLinks({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT ${LINK_COLUMNS} FROM requirements_access_links WHERE tenant_id = ? AND project_id = ? ORDER BY created_at ASC`,
        [tenantId, projectId],
      );
      if (rows.length === 0) return [];
      const [tokenRows] = await pool.execute(
        `SELECT ${TOKEN_COLUMNS} FROM requirements_access_link_tokens WHERE tenant_id = ? AND project_id = ?`,
        [tenantId, projectId],
      );
      return rows.map((row) => mapLinkRow(row, tokenRows));
    },

    async revokeAccessLink({ linkId, now, projectId, revokedBy, tenantId }) {
      const nowSeconds = unixSeconds(now);
      await withTransaction(pool, async (connection) => {
        await connection.execute(
          `
            UPDATE requirements_access_links
            SET revoked_at = FROM_UNIXTIME(?), revoked_by = ?, updated_at = FROM_UNIXTIME(?)
            WHERE tenant_id = ? AND project_id = ? AND id = ? AND revoked_at IS NULL
          `,
          [nowSeconds, revokedBy, nowSeconds, tenantId, projectId, linkId],
        );
        await connection.execute(
          `
            UPDATE requirements_access_link_tokens
            SET revoked_at = FROM_UNIXTIME(?)
            WHERE tenant_id = ? AND project_id = ? AND link_id = ? AND revoked_at IS NULL
          `,
          [nowSeconds, tenantId, projectId, linkId],
        );
      });
      return this.getAccessLink({ linkId, projectId, tenantId });
    },

    async extendAccessLink({ extendedBy, extendedUntil, linkId, now, projectId, tenantId }) {
      await pool.execute(
        `
          UPDATE requirements_access_links
          SET extended_until = FROM_UNIXTIME(?), extended_by = ?, updated_at = FROM_UNIXTIME(?)
          WHERE tenant_id = ? AND project_id = ? AND id = ?
        `,
        [unixSeconds(extendedUntil), extendedBy, unixSeconds(now), tenantId, projectId, linkId],
      );
      return this.getAccessLink({ linkId, projectId, tenantId });
    },

    async touchAccessLink({ linkId, now, tokenId = null }) {
      await pool.execute(
        'UPDATE requirements_access_links SET last_used_at = FROM_UNIXTIME(?) WHERE id = ?',
        [unixSeconds(now), linkId],
      );
      if (tokenId) {
        await pool.execute(
          'UPDATE requirements_access_link_tokens SET last_used_at = FROM_UNIXTIME(?) WHERE id = ?',
          [unixSeconds(now), tokenId],
        );
      }
    },

    async listStakeholderInvolvement({ projectId, stakeholderId, tenantId }) {
      const [topicRows] = await pool.execute(
        `
          SELECT
            i.clarification_id AS clarificationId,
            UNIX_TIMESTAMP(i.created_at) AS invitedAt,
            UNIX_TIMESTAMP(i.deactivated_at) AS deactivatedAt,
            c.clarification_status AS status,
            UNIX_TIMESTAMP(c.updated_at) AS topicUpdatedAt
          FROM project_clarification_invitations i
          JOIN project_clarifications c
            ON c.tenant_id = i.tenant_id
            AND c.project_id = i.project_id
            AND c.id = i.clarification_id
          WHERE i.tenant_id = ? AND i.project_id = ? AND i.stakeholder_id = ? AND c.track IS NOT NULL
        `,
        [tenantId, projectId, stakeholderId],
      );
      const [roundRows] = await pool.execute(
        `
          SELECT
            r.id AS roundId,
            r.status,
            UNIX_TIMESTAMP(r.closed_at) AS closedAt,
            UNIX_TIMESTAMP(rr.invited_at) AS invitedAt,
            UNIX_TIMESTAMP(rr.removed_at) AS removedAt
          FROM review_round_reviewers rr
          JOIN review_rounds r ON r.id = rr.round_id AND r.tenant_id = rr.tenant_id AND r.project_id = rr.project_id
          WHERE rr.tenant_id = ? AND rr.project_id = ? AND rr.actor_type = 'stakeholder' AND rr.actor_id = ?
        `,
        [tenantId, projectId, stakeholderId],
      );
      // Signature requests the stakeholder is asked to sign (docs/document-signing): over when
      // they sign, decline or are removed, or the request ends.
      const [signingRows] = await pool.execute(
        `
          SELECT
            s.request_id AS requestId,
            CASE
              WHEN s.status = 'pending' AND r.status = 'pending' THEN NULL
              ELSE UNIX_TIMESTAMP(COALESCE(s.signed_at, s.declined_at, s.removed_at, r.ended_at, r.updated_at))
            END AS endedAt
          FROM signing_signers s
          JOIN signing_requests r ON r.id = s.request_id AND r.tenant_id = s.tenant_id
          WHERE s.tenant_id = ? AND s.project_id = ? AND s.stakeholder_id = ?
        `,
        [tenantId, projectId, stakeholderId],
      );
      return {
        rounds: roundRows.map((row) => ({
          closedAt: fromUnix(row.closedAt),
          invitedAt: fromUnix(row.invitedAt),
          removedAt: fromUnix(row.removedAt),
          roundId: row.roundId,
          status: row.status,
        })),
        signings: signingRows.map((row) => ({ endedAt: fromUnix(row.endedAt), requestId: row.requestId })),
        topics: topicRows.map((row) => ({
          clarificationId: row.clarificationId,
          deactivatedAt: fromUnix(row.deactivatedAt),
          invitedAt: fromUnix(row.invitedAt),
          status: normalizeString(row.status) || 'open',
          topicUpdatedAt: fromUnix(row.topicUpdatedAt),
        })),
      };
    },

    // Summaries -------------------------------------------------------------

    async createSummary({ projectId, summary, tenantId }) {
      const id = summary.id ?? randomUUID();
      await pool.execute(
        `
          INSERT INTO requirements_summaries (
            id, tenant_id, project_id, track, scope_type, scope_id, status, output_json, dropped_json,
            error_message, model, input_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))
        `,
        [
          id,
          tenantId,
          projectId,
          nullableString(summary.track),
          summary.scopeType,
          summary.scopeId,
          summary.status ?? 'ok',
          summary.output ? JSON.stringify(summary.output) : null,
          JSON.stringify(summary.dropped ?? []),
          nullableString(summary.errorMessage),
          nullableString(summary.model),
          nullableString(summary.inputDigest),
          unixSeconds(summary.createdAt ?? new Date()),
        ],
      );
      const [rows] = await pool.execute(`SELECT ${summaryColumns()} FROM requirements_summaries WHERE id = ? LIMIT 1`, [id]);
      return mapSummaryRow(rows[0]);
    },

    async listLatestSummaries({ projectId, scopeType = '', tenantId, track = '' }) {
      const predicates = ['s.tenant_id = ?', 's.project_id = ?', "s.status = 'ok'"];
      const params = [tenantId, projectId];
      if (scopeType) { predicates.push('s.scope_type = ?'); params.push(scopeType); }
      if (track) { predicates.push('s.track = ?'); params.push(track); }
      const [rows] = await pool.execute(
        `
          SELECT ${summaryColumns('s')}
          FROM requirements_summaries s
          JOIN (
            SELECT scope_type, scope_id, MAX(created_at) AS latest
            FROM requirements_summaries
            WHERE tenant_id = ? AND project_id = ? AND status = 'ok'
            GROUP BY scope_type, scope_id
          ) l ON l.scope_type = s.scope_type AND l.scope_id = s.scope_id AND l.latest = s.created_at
          WHERE ${predicates.join(' AND ')}
        `,
        [tenantId, projectId, ...params],
      );
      return latestPerScope(rows.map(mapSummaryRow));
    },

    async listSummaryScopes({ projectId, summaryIds = [], tenantId }) {
      const ids = [...new Set(summaryIds.filter(Boolean))];
      if (ids.length === 0) return [];
      const [rows] = await pool.execute(
        `SELECT id, scope_id AS scopeId, scope_type AS scopeType FROM requirements_summaries WHERE tenant_id = ? AND project_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
        [tenantId, projectId, ...ids],
      );
      return rows.map((row) => ({ id: row.id, scopeId: row.scopeId, scopeType: row.scopeType }));
    },

    async listLatestSummaryAttempts({ projectId, scopeType = '', tenantId }) {
      const predicates = ['s.tenant_id = ?', 's.project_id = ?'];
      const params = [tenantId, projectId];
      if (scopeType) { predicates.push('s.scope_type = ?'); params.push(scopeType); }
      const [rows] = await pool.execute(
        `
          SELECT ${summaryColumns('s')}
          FROM requirements_summaries s
          JOIN (
            SELECT scope_type, scope_id, MAX(created_at) AS latest
            FROM requirements_summaries
            WHERE tenant_id = ? AND project_id = ?
            GROUP BY scope_type, scope_id
          ) l ON l.scope_type = s.scope_type AND l.scope_id = s.scope_id AND l.latest = s.created_at
          WHERE ${predicates.join(' AND ')}
        `,
        [tenantId, projectId, ...params],
      );
      return latestPerScope(rows.map(mapSummaryRow), { okOnly: false });
    },

    async getCurrentSummary({ projectId, scopeId, scopeType, tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT ${summaryColumns()}
          FROM requirements_summaries
          WHERE tenant_id = ? AND project_id = ? AND scope_type = ? AND scope_id = ? AND status = 'ok'
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [tenantId, projectId, scopeType, scopeId],
      );
      return rows[0] ? mapSummaryRow(rows[0]) : null;
    },

    async listSummaryRuns({ limit = 50, projectId, scopeId, scopeType, tenantId }) {
      const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
      const [rows] = await pool.execute(
        `
          SELECT ${summaryColumns()}
          FROM requirements_summaries
          WHERE tenant_id = ? AND project_id = ? AND scope_type = ? AND scope_id = ?
          ORDER BY created_at DESC
          LIMIT ${safeLimit}
        `,
        [tenantId, projectId, scopeType, scopeId],
      );
      return rows.map(mapSummaryRow);
    },

    // Rounds, packages, and plans -------------------------------------------

    async insertRound({ projectId, reviewers = [], round, tenantId }) {
      const id = round.id ?? randomUUID();
      const nowSeconds = unixSeconds(new Date());
      await withTransaction(pool, async (connection) => {
        await connection.execute(
          `
            INSERT INTO review_rounds (
              id, tenant_id, project_id, track, package_id, number, status, due_at, note,
              published_by, published_at, closed_by, outcome, closed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, FROM_UNIXTIME(?), ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?))
          `,
          [
            id, tenantId, projectId, round.track, round.packageId, Number(round.number ?? 1), round.status ?? 'draft',
            unixSeconds(round.dueAt), normalizeString(round.note), nullableString(round.publishedBy), unixSeconds(round.publishedAt),
            nullableString(round.closedBy), nullableString(round.outcome), unixSeconds(round.closedAt), nowSeconds, nowSeconds,
          ],
        );
        for (const reviewer of reviewers) {
          await connection.execute(
            `
              INSERT INTO review_round_reviewers (
                id, tenant_id, project_id, round_id, actor_type, actor_id, required, invited_at,
                last_seen_at, submitted_at, removed_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?))
            `,
            [
              randomUUID(), tenantId, projectId, id, reviewer.actorType, reviewer.actorId, reviewer.required ? 1 : 0,
              unixSeconds(reviewer.invitedAt ?? new Date()), unixSeconds(reviewer.lastSeenAt), unixSeconds(reviewer.submittedAt),
              unixSeconds(reviewer.removedAt), nowSeconds, nowSeconds,
            ],
          );
        }
      });
      const rounds = await this.listRounds({ projectId, tenantId });
      return rounds.find((item) => item.id === id) ?? null;
    },

    async listRounds({ projectId, tenantId, track = '' }) {
      const [roundRows] = await pool.execute(
        `
          SELECT
            id, tenant_id AS tenantId, project_id AS projectId, track, package_id AS packageId, number, status,
            UNIX_TIMESTAMP(due_at) AS dueAt, note, published_by AS publishedBy, UNIX_TIMESTAMP(published_at) AS publishedAt,
            closed_by AS closedBy, outcome, UNIX_TIMESTAMP(closed_at) AS closedAt,
            UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
          FROM review_rounds
          WHERE tenant_id = ? AND project_id = ?${track ? ' AND track = ?' : ''}
          ORDER BY number ASC
        `,
        track ? [tenantId, projectId, track] : [tenantId, projectId],
      );
      if (roundRows.length === 0) return [];
      const [reviewerRows] = await pool.execute(
        `
          SELECT
            round_id AS roundId, actor_type AS actorType, actor_id AS actorId, required,
            UNIX_TIMESTAMP(invited_at) AS invitedAt, UNIX_TIMESTAMP(last_seen_at) AS lastSeenAt,
            UNIX_TIMESTAMP(submitted_at) AS submittedAt, UNIX_TIMESTAMP(removed_at) AS removedAt
          FROM review_round_reviewers
          WHERE tenant_id = ? AND project_id = ?
        `,
        [tenantId, projectId],
      );
      return roundRows.map((row) => ({
        closedAt: fromUnix(row.closedAt),
        closedBy: nullableString(row.closedBy),
        createdAt: fromUnix(row.createdAt),
        dueAt: fromUnix(row.dueAt),
        id: row.id,
        note: normalizeString(row.note),
        number: Number(row.number),
        outcome: nullableString(row.outcome),
        packageId: row.packageId,
        projectId: row.projectId,
        publishedAt: fromUnix(row.publishedAt),
        publishedBy: nullableString(row.publishedBy),
        reviewers: reviewerRows
          .filter((reviewer) => reviewer.roundId === row.id)
          .map((reviewer) => ({
            actorId: reviewer.actorId,
            actorType: reviewer.actorType,
            invitedAt: fromUnix(reviewer.invitedAt),
            lastSeenAt: fromUnix(reviewer.lastSeenAt),
            removedAt: fromUnix(reviewer.removedAt),
            required: Boolean(Number(reviewer.required)),
            roundId: reviewer.roundId,
            submittedAt: fromUnix(reviewer.submittedAt),
          })),
        status: row.status,
        tenantId: row.tenantId,
        track: row.track,
        updatedAt: fromUnix(row.updatedAt),
      }));
    },

    async insertPackage({ pkg, projectId, tenantId }) {
      const id = pkg.id ?? randomUUID();
      const nowSeconds = unixSeconds(new Date());
      await pool.execute(
        `
          INSERT INTO review_packages (
            id, tenant_id, project_id, track, version, title, manifest_json, status, source,
            size_bytes, file_count, uploaded_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [
          id, tenantId, projectId, pkg.track, Number(pkg.version ?? 1), normalizeString(pkg.title), JSON.stringify(pkg.manifest ?? {}),
          pkg.status ?? 'draft', pkg.source ?? 'ui', Number(pkg.sizeBytes ?? 0), Number(pkg.fileCount ?? 0), pkg.uploadedBy,
          unixSeconds(pkg.createdAt) ?? nowSeconds, nowSeconds,
        ],
      );
      const packages = await this.listPackages({ projectId, tenantId });
      return packages.find((item) => item.id === id) ?? null;
    },

    async listPackages({ projectId, status = '', tenantId, track = '', uploadedBy = '' }) {
      const predicates = ['tenant_id = ?', 'project_id = ?'];
      const params = [tenantId, projectId];
      if (track) { predicates.push('track = ?'); params.push(track); }
      if (status) { predicates.push('status = ?'); params.push(status); }
      if (uploadedBy) { predicates.push('uploaded_by = ?'); params.push(uploadedBy); }
      const [rows] = await pool.execute(
        `
          SELECT
            id, tenant_id AS tenantId, project_id AS projectId, track, version, title, status, source,
            size_bytes AS sizeBytes, file_count AS fileCount, uploaded_by AS uploadedBy,
            UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
          FROM review_packages
          WHERE ${predicates.join(' AND ')}
          ORDER BY version ASC
        `,
        params,
      );
      return rows.map((row) => ({
        ...row,
        createdAt: fromUnix(row.createdAt),
        fileCount: Number(row.fileCount),
        sizeBytes: Number(row.sizeBytes),
        updatedAt: fromUnix(row.updatedAt),
        version: Number(row.version),
      }));
    },

    async insertPlan({ plan, projectId, tenantId }) {
      const id = plan.id ?? randomUUID();
      const nowSeconds = unixSeconds(new Date());
      await pool.execute(
        `
          INSERT INTO requirements_plans (
            id, tenant_id, project_id, track, version, body_markdown, criteria_json, status,
            created_by, approved_by, approved_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [
          id, tenantId, projectId, plan.track, Number(plan.version ?? 1), normalizeString(plan.body), JSON.stringify(plan.criteria ?? []),
          plan.status ?? 'draft', plan.createdBy, nullableString(plan.approvedBy), unixSeconds(plan.approvedAt), nowSeconds, nowSeconds,
        ],
      );
      const plans = await this.listPlans({ projectId, tenantId });
      return plans.find((item) => item.id === id) ?? null;
    },

    async listPlans({ projectId, tenantId, track = '' }) {
      const [rows] = await pool.execute(
        `
          SELECT
            id, tenant_id AS tenantId, project_id AS projectId, track, version, status, created_by AS createdBy,
            approved_by AS approvedBy, UNIX_TIMESTAMP(approved_at) AS approvedAt,
            UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
          FROM requirements_plans
          WHERE tenant_id = ? AND project_id = ?${track ? ' AND track = ?' : ''}
          ORDER BY version ASC
        `,
        track ? [tenantId, projectId, track] : [tenantId, projectId],
      );
      return rows.map((row) => ({
        ...row,
        approvedAt: fromUnix(row.approvedAt),
        approvedBy: nullableString(row.approvedBy),
        createdAt: fromUnix(row.createdAt),
        updatedAt: fromUnix(row.updatedAt),
        version: Number(row.version),
      }));
    },

    // Decisions -------------------------------------------------------------

    async listDecisions({ kind = '', projectId, tenantId, topicId = '', track = '' }) {
      const predicates = ['tenant_id = ?', 'project_id = ?'];
      const params = [tenantId, projectId];
      if (track) { predicates.push('track = ?'); params.push(track); }
      if (topicId) { predicates.push('topic_id = ?'); params.push(topicId); }
      if (kind) { predicates.push('kind = ?'); params.push(kind); }
      const [rows] = await pool.execute(
        `SELECT ${DECISION_COLUMNS} FROM requirements_decisions WHERE ${predicates.join(' AND ')} ORDER BY decided_at DESC, id ASC`,
        params,
      );
      return rows.map(mapDecisionRow);
    },

    async getDecision({ decisionId, projectId, tenantId }) {
      return selectDecision(pool, { decisionId, projectId, tenantId });
    },

    async createDecision({ decision, projectId, supersedesId = null, tenantId, topicStatus = null }) {
      const id = decision.id ?? randomUUID();
      const decidedAtSeconds = unixSeconds(decision.decidedAt ?? new Date());
      await withTransaction(pool, async (connection) => {
        if (decision.topicId) {
          const topic = await lockTopic(connection, { projectId, tenantId, topicId: decision.topicId });
          if (!topic?.track) throw new HttpError(404, 'Topic not found.');
        }

        const superseded = supersedesId
          ? await selectDecision(connection, { decisionId: supersedesId, forUpdate: true, projectId, tenantId })
          : null;
        if (supersedesId && (!superseded || superseded.track !== decision.track)) {
          throw new HttpError(404, 'Decision to supersede not found.');
        }
        if (superseded?.supersededById) {
          throw decisionConflict('decision_superseded', 'That decision has already been superseded.', { supersededById: superseded.supersededById });
        }

        if (decision.kind === 'topic' && decision.topicId) {
          const [activeRows] = await connection.execute(
            `
              SELECT id FROM requirements_decisions
              WHERE tenant_id = ? AND project_id = ? AND topic_id = ? AND kind = 'topic' AND superseded_by_id IS NULL
              LIMIT 1
            `,
            [tenantId, projectId, decision.topicId],
          );
          const activeId = activeRows[0]?.id ?? null;
          if (activeId && activeId !== supersedesId) {
            throw decisionConflict('decision_exists', 'This topic already has a decision. Supersede it to record a new one.', { activeDecisionId: activeId });
          }
        }

        await insertMysqlDecision(connection, { decision, id, projectId, supersedesId, tenantId });

        if (superseded) {
          await connection.execute(
            `
              UPDATE requirements_decisions
              SET superseded_by_id = ?, superseded_at = FROM_UNIXTIME(?), version = version + 1, updated_at = FROM_UNIXTIME(?)
              WHERE id = ?
            `,
            [id, decidedAtSeconds, decidedAtSeconds, supersedesId],
          );
        }

        if (decision.topicId && topicStatus) {
          await setTopicStatus(connection, { nowSeconds: decidedAtSeconds, projectId, status: topicStatus, tenantId, topicId: decision.topicId });
        }
      });
      return selectDecision(pool, { decisionId: id, projectId, tenantId });
    },

    async updateDecision({ decisionId, expectedVersion, now, patch = {}, projectId, tenantId, topicStatus = null, updatedBy }) {
      const nowSeconds = unixSeconds(now ?? new Date());
      const found = await withTransaction(pool, async (connection) => {
        const current = await selectDecision(connection, { decisionId, forUpdate: true, projectId, tenantId });
        if (!current) return false;
        if (current.supersededById) {
          throw decisionConflict('decision_superseded', 'Superseded decisions cannot be edited.', { supersededById: current.supersededById });
        }
        if (Number(current.version) !== Number(expectedVersion)) {
          throw decisionConflict('decision_version_conflict', 'This decision changed since you loaded it. Reload and try again.', {
            currentVersion: current.version,
          });
        }

        const assignments = [];
        const params = [];
        if (patch.statement !== undefined) { assignments.push('statement = ?'); params.push(patch.statement); }
        if (patch.outcome !== undefined) { assignments.push('outcome = ?'); params.push(patch.outcome); }
        if (patch.sources !== undefined) { assignments.push('sources_json = ?'); params.push(JSON.stringify(patch.sources)); }
        assignments.push('updated_by = ?', 'version = version + 1', 'updated_at = FROM_UNIXTIME(?)');
        params.push(updatedBy, nowSeconds);
        const [result] = await connection.execute(
          `UPDATE requirements_decisions SET ${assignments.join(', ')} WHERE id = ? AND version = ?`,
          [...params, decisionId, Number(expectedVersion)],
        );
        if (Number(result.affectedRows) !== 1) {
          throw decisionConflict('decision_version_conflict', 'This decision changed since you loaded it. Reload and try again.', {
            currentVersion: current.version,
          });
        }

        if (current.topicId && topicStatus) {
          await setTopicStatus(connection, { nowSeconds, projectId, status: topicStatus, tenantId, topicId: current.topicId });
        }
        return true;
      });
      return found ? selectDecision(pool, { decisionId, projectId, tenantId }) : null;
    },
  };
}
