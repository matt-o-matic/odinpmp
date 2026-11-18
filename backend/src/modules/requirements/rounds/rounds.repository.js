import { randomUUID } from 'node:crypto';

import { HttpError } from '../../../lib/errors/http-error.js';
import { insertMysqlDecision, selectMysqlDecision } from '../requirements.repository.js';

// Review rounds and the feedback reviewers give in them. Rows live in the U1 tables from
// migrations 0054 (review_rounds, review_round_reviewers) and 0055 (review_annotations,
// review_comments, review_verdicts, review_answers), so the requirements repository's
// round reads (My open items, the overview, link lifetime) see what this repository writes.
// Migration 0061 below adds what those tables lack.
//
// 0061 is registered in src/jobs/bootstrap-schema.lib.js. The migration runner checksums its
// body: never edit it; add a new migration instead.
//
// Storage conventions:
//   - Verdicts: one row per (round, reviewer, target, dimension). A screen verdict stores its
//     overall value in dimension 'overall' (keep_note = "what should stay", change_note =
//     "what should change", mixed_note = mixed feelings) and each rated feedback dimension
//     as 'dim:<key>'. A direction stance is dimension 'overall' on target type 'direction',
//     with keep_note holding the remix note. Manifest ids cannot contain ':', so the two
//     never collide.
//   - Annotations carry forward by moving: an annotation keeps its id and thread, and its
//     round, package, and display number change. origin_round_id records where it started
//     and carried_from_round_id the round it last left. The 0055 column carried_from_id is
//     not used.
//   - Deleting an annotation is soft (deleted_at), so `restored` brings back the same id,
//     thread, and display number.

export const ANNOTATION_STATUSES = Object.freeze(['open', 'resolved', 'carried', 'outdated', 'superseded']);
export const ROUND_OUTCOMES = Object.freeze(['direction-chosen', 'screens-accepted', 'changes-requested', 'abandoned']);
export const OVERALL_DIMENSION = 'overall';
export const DIMENSION_PREFIX = 'dim:';

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [tableName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, columnName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnLength(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    'SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, columnName],
  );
  return Number(rows[0]?.maxLength ?? 0);
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [tableName, indexName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

// 0061_review_round_details
export async function ensureMysqlReviewRoundDetailsSchema(executor) {
  const columns = [
    ['review_rounds', 'reminder_days_before', 'INT NULL'],
    ['review_rounds', 'question_topics_json', 'JSON NULL'],
    ['review_rounds', 'outcome_direction_id', 'VARCHAR(120) NULL'],
    ['review_round_reviewers', 'mail_status', 'VARCHAR(24) NULL'],
    ['review_round_reviewers', 'mail_reason', 'VARCHAR(40) NULL'],
    ['review_round_reviewers', 'mail_target_id', 'VARCHAR(128) NULL'],
    ['review_round_reviewers', 'mail_queued_at', 'DATETIME(3) NULL'],
    ['review_round_reviewers', 'reminded_at', 'DATETIME(3) NULL'],
    ['review_round_reviewers', 'position_json', 'JSON NULL'],
    ['review_annotations', 'display_number', 'INT NULL'],
    ['review_annotations', 'origin_round_id', 'VARCHAR(36) NULL'],
    ['review_annotations', 'carried_from_round_id', 'VARCHAR(36) NULL'],
    ['review_annotations', 'status_changed_by', 'VARCHAR(80) NULL'],
    ['review_annotations', 'status_changed_at', 'DATETIME(3) NULL'],
    ['review_annotations', 'deleted_at', 'DATETIME(3) NULL'],
    ['review_verdicts', 'mixed_note', 'MEDIUMTEXT NULL'],
    ['review_answers', 'topic_id', 'VARCHAR(36) NULL'],
  ];
  for (const [tableName, columnName, definition] of columns) {
    if (!await columnExists(executor, tableName, columnName)) {
      await executor.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  // Custom feedback dimension ids run to 64 characters; 0055 sized these columns at 40.
  const dimensionLength = await columnLength(executor, 'review_verdicts', 'dimension');
  if (dimensionLength > 0 && dimensionLength < 80) {
    await executor.execute("ALTER TABLE review_verdicts MODIFY COLUMN dimension VARCHAR(80) NOT NULL DEFAULT 'overall'");
  }
  const categoryLength = await columnLength(executor, 'review_annotations', 'category');
  if (categoryLength > 0 && categoryLength < 80) {
    await executor.execute('ALTER TABLE review_annotations MODIFY COLUMN category VARCHAR(80) NULL');
  }

  if (!await indexExists(executor, 'review_rounds', 'idx_review_rounds_due')) {
    await executor.execute('CREATE INDEX idx_review_rounds_due ON review_rounds (status, due_at)');
  }

  if (!await tableExists(executor, 'review_snapshots')) {
    await executor.execute(`
      CREATE TABLE review_snapshots (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        round_id VARCHAR(36) NOT NULL,
        screen_id VARCHAR(120) NULL,
        state_key VARCHAR(512) NULL,
        storage_key VARCHAR(160) NOT NULL,
        width INT NOT NULL,
        height INT NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 CHAR(64) NOT NULL,
        uploaded_by VARCHAR(80) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_review_snapshots_round (tenant_id, project_id, round_id)
      )
    `);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers and record shapes
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

function nullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function roundOpenConflict(openRound) {
  return new HttpError(409, 'A round is already open for this track. Close it before publishing another.', {
    details: { code: 'round_open', openRoundId: openRound.id, openRoundNumber: Number(openRound.number) },
  });
}

function normalizeReviewer(record) {
  return {
    actorId: record.actorId,
    actorType: record.actorType,
    createdAt: toIso(record.createdAt),
    id: record.id,
    invitedAt: toIso(record.invitedAt),
    lastSeenAt: toIso(record.lastSeenAt),
    mailQueuedAt: toIso(record.mailQueuedAt),
    mailReason: nullableString(record.mailReason),
    mailStatus: nullableString(record.mailStatus),
    mailTargetId: nullableString(record.mailTargetId),
    position: record.position && typeof record.position === 'object' ? clone(record.position) : null,
    remindedAt: toIso(record.remindedAt),
    removedAt: toIso(record.removedAt),
    required: Boolean(Number(record.required ?? 0)),
    roundId: record.roundId,
    submittedAt: toIso(record.submittedAt),
    updatedAt: toIso(record.updatedAt),
  };
}

function normalizeRound(record, reviewers = []) {
  return {
    closedAt: toIso(record.closedAt),
    closedBy: nullableString(record.closedBy),
    createdAt: toIso(record.createdAt),
    dueAt: toIso(record.dueAt),
    id: record.id,
    note: normalizeString(record.note),
    number: Number(record.number),
    outcome: nullableString(record.outcome),
    outcomeDirectionId: nullableString(record.outcomeDirectionId),
    packageId: record.packageId,
    projectId: record.projectId,
    publishedAt: toIso(record.publishedAt),
    publishedBy: nullableString(record.publishedBy),
    questionTopics: record.questionTopics && typeof record.questionTopics === 'object' ? clone(record.questionTopics) : {},
    reminderDaysBefore: nullableInt(record.reminderDaysBefore),
    reviewers: reviewers.map(normalizeReviewer).sort((left, right) => String(left.createdAt ?? left.invitedAt ?? '').localeCompare(String(right.createdAt ?? right.invitedAt ?? ''))),
    status: record.status,
    tenantId: record.tenantId,
    track: record.track,
    updatedAt: toIso(record.updatedAt),
  };
}

function normalizeAnnotation(record) {
  return {
    anchor: record.anchor && typeof record.anchor === 'object' ? clone(record.anchor) : {},
    authorId: record.authorId,
    authorName: normalizeString(record.authorName),
    authorType: record.authorType,
    carriedFromRoundId: nullableString(record.carriedFromRoundId),
    category: nullableString(record.category),
    createdAt: toIso(record.createdAt),
    deletedAt: toIso(record.deletedAt),
    elementHint: record.elementHint && typeof record.elementHint === 'object' ? clone(record.elementHint) : null,
    id: record.id,
    number: nullableInt(record.number),
    originRoundId: nullableString(record.originRoundId),
    packageId: record.packageId,
    packageVersion: Number(record.packageVersion),
    pinId: nullableString(record.pinId),
    projectId: record.projectId,
    roundId: record.roundId,
    schemaVersion: Number(record.schemaVersion ?? 1),
    screenId: record.screenId,
    shapes: Array.isArray(record.shapes) ? clone(record.shapes) : [],
    snapshotFileId: nullableString(record.snapshotFileId),
    stateKey: nullableString(record.stateKey),
    status: record.status,
    statusChangedAt: toIso(record.statusChangedAt),
    statusChangedBy: nullableString(record.statusChangedBy),
    tenantId: record.tenantId,
    updatedAt: toIso(record.updatedAt),
  };
}

function normalizeComment(record) {
  return {
    annotationId: record.annotationId,
    authorId: record.authorId,
    authorName: normalizeString(record.authorName),
    authorType: record.authorType,
    body: record.deletedAt ? '' : String(record.body ?? ''),
    createdAt: toIso(record.createdAt),
    deletedAt: toIso(record.deletedAt),
    editedAt: toIso(record.editedAt),
    id: record.id,
    parentCommentId: nullableString(record.parentCommentId),
    projectId: record.projectId,
    tenantId: record.tenantId,
    updatedAt: toIso(record.updatedAt),
  };
}

function normalizeVerdict(record) {
  return {
    actorId: record.actorId,
    actorType: record.actorType,
    changeNote: normalizeString(record.changeNote),
    createdAt: toIso(record.createdAt),
    dimension: record.dimension,
    id: record.id,
    keepNote: normalizeString(record.keepNote),
    mixedNote: normalizeString(record.mixedNote),
    roundId: record.roundId,
    targetId: record.targetId,
    targetType: record.targetType,
    updatedAt: toIso(record.updatedAt),
    value: record.value,
  };
}

function normalizeAnswer(record) {
  return {
    actorId: record.actorId,
    actorType: record.actorType,
    createdAt: toIso(record.createdAt),
    id: record.id,
    postedCommentId: nullableString(record.postedCommentId),
    questionId: record.questionId,
    roundId: record.roundId,
    topicId: nullableString(record.topicId),
    updatedAt: toIso(record.updatedAt),
    value: clone(record.value ?? null),
  };
}

function normalizeSnapshot(record) {
  return {
    createdAt: toIso(record.createdAt),
    height: Number(record.height),
    id: record.id,
    projectId: record.projectId,
    roundId: record.roundId,
    screenId: nullableString(record.screenId),
    sha256: record.sha256,
    sizeBytes: Number(record.sizeBytes),
    stateKey: nullableString(record.stateKey),
    storageKey: record.storageKey,
    tenantId: record.tenantId,
    uploadedBy: record.uploadedBy,
    width: Number(record.width),
  };
}

function sameScope(record, { projectId, tenantId }) {
  return record.projectId === projectId && record.tenantId === tenantId;
}

/** Due when the reminder window has opened and the round is not yet due. */
function reminderDue({ dueAt, reminderDaysBefore }, nowMs) {
  const dueMs = toMs(dueAt);
  if (dueMs === null || reminderDaysBefore === null || reminderDaysBefore === undefined) return false;
  return nowMs >= dueMs - (Number(reminderDaysBefore) * 24 * 60 * 60 * 1000) && nowMs < dueMs;
}

// ---------------------------------------------------------------------------
// In-memory implementation. Rounds and reviewers share the requirements repository's state,
// as the MySQL repositories share tables.
// ---------------------------------------------------------------------------

export function createInMemoryRoundsRepository({ requirementsRepository = null } = {}) {
  const shared = requirementsRepository?.state ?? { roundReviewers: [], rounds: [] };
  const state = {
    annotations: [],
    answers: [],
    comments: [],
    rounds: shared.rounds,
    roundReviewers: shared.roundReviewers,
    snapshots: [],
    verdicts: [],
  };

  function reviewersOf(roundId) {
    return state.roundReviewers.filter((reviewer) => reviewer.roundId === roundId);
  }

  function findRound({ projectId, roundId, tenantId }) {
    return state.rounds.find((round) => round.id === roundId && sameScope(round, { projectId, tenantId })) ?? null;
  }

  function present(round) {
    return round ? normalizeRound(round, reviewersOf(round.id)) : null;
  }

  function nextNumber(roundId, screenId) {
    return state.annotations
      .filter((annotation) => annotation.roundId === roundId && annotation.screenId === screenId)
      .reduce((max, annotation) => Math.max(max, Number(annotation.number ?? 0)), 0) + 1;
  }

  return {
    state,

    // Rounds ----------------------------------------------------------------

    async createRound({ projectId, requireNoOpenRound = true, reviewers = [], round, tenantId }) {
      // Review is project-wide: one open round per project, numbered across the project.
      const projectRounds = state.rounds.filter((item) => sameScope(item, { projectId, tenantId }));
      const open = projectRounds.find((item) => item.status === 'open');
      if (requireNoOpenRound && open) throw roundOpenConflict(open);
      const now = toIso(round.publishedAt) ?? new Date().toISOString();
      const record = {
        closedAt: null,
        closedBy: null,
        createdAt: now,
        dueAt: toIso(round.dueAt),
        id: round.id ?? randomUUID(),
        note: normalizeString(round.note),
        number: projectRounds.reduce((max, item) => Math.max(max, Number(item.number)), 0) + 1,
        outcome: null,
        outcomeDirectionId: null,
        packageId: round.packageId,
        projectId,
        publishedAt: toIso(round.publishedAt),
        publishedBy: nullableString(round.publishedBy),
        questionTopics: clone(round.questionTopics ?? {}),
        reminderDaysBefore: nullableInt(round.reminderDaysBefore),
        status: 'open',
        tenantId,
        title: '',
        track: round.track,
        updatedAt: now,
      };
      state.rounds.push(record);
      for (const reviewer of reviewers) {
        state.roundReviewers.push({
          actorId: reviewer.actorId,
          actorType: reviewer.actorType,
          createdAt: now,
          id: reviewer.id ?? randomUUID(),
          invitedAt: toIso(reviewer.invitedAt ?? now),
          lastSeenAt: null,
          projectId,
          removedAt: null,
          required: Boolean(reviewer.required),
          roundId: record.id,
          submittedAt: null,
          tenantId,
          updatedAt: now,
        });
      }
      return present(record);
    },

    async getRound({ projectId, roundId, tenantId }) {
      return present(findRound({ projectId, roundId, tenantId }));
    },

    async listRounds({ projectId, tenantId, track = '' }) {
      return state.rounds
        .filter((round) => sameScope(round, { projectId, tenantId }) && (!track || round.track === track))
        .map(present)
        .sort((left, right) => left.track.localeCompare(right.track) || left.number - right.number);
    },

    async updateRound({ patch = {}, projectId, roundId, tenantId }) {
      const record = findRound({ projectId, roundId, tenantId });
      if (!record || record.status !== 'open') return null;
      if (patch.dueAt !== undefined) record.dueAt = toIso(patch.dueAt);
      if (patch.note !== undefined) record.note = normalizeString(patch.note);
      if (patch.reminderDaysBefore !== undefined) record.reminderDaysBefore = nullableInt(patch.reminderDaysBefore);
      record.updatedAt = new Date().toISOString();
      return present(record);
    },

    /**
     * Closes an open round and records its decision together: if the decision cannot be
     * stored, the round stays open. Returns `{ round, decision }`, or null when the round
     * is not open.
     */
    async closeRound({ closedAt, closedBy, decision, outcome, outcomeDirectionId = null, projectId, roundId, tenantId }) {
      const record = findRound({ projectId, roundId, tenantId });
      if (!record || record.status !== 'open') return null;
      const before = { ...record };
      // Closed before the decision is written, so a concurrent close sees it and gets null.
      Object.assign(record, {
        closedAt: toIso(closedAt),
        closedBy,
        outcome,
        outcomeDirectionId: nullableString(outcomeDirectionId),
        status: 'closed',
        updatedAt: toIso(closedAt),
      });
      try {
        const created = await requirementsRepository.createDecision({ decision, projectId, tenantId });
        return { decision: created, round: present(record) };
      } catch (error) {
        Object.assign(record, before);
        throw error;
      }
    },

    // Reviewers -------------------------------------------------------------

    /** Inserts new reviewers and reactivates removed ones. Returns the affected rows. */
    async addReviewers({ now, projectId, reviewers = [], roundId, tenantId }) {
      const timestamp = toIso(now) ?? new Date().toISOString();
      const affected = [];
      for (const reviewer of reviewers) {
        let record = state.roundReviewers.find((item) => item.roundId === roundId
          && item.actorType === reviewer.actorType && item.actorId === reviewer.actorId) ?? null;
        if (record && !record.removedAt) continue;
        if (record) {
          Object.assign(record, { invitedAt: timestamp, removedAt: null, required: Boolean(reviewer.required), updatedAt: timestamp });
        } else {
          record = {
            actorId: reviewer.actorId,
            actorType: reviewer.actorType,
            createdAt: timestamp,
            id: randomUUID(),
            invitedAt: timestamp,
            lastSeenAt: null,
            projectId,
            removedAt: null,
            required: Boolean(reviewer.required),
            roundId,
            submittedAt: null,
            tenantId,
            updatedAt: timestamp,
          };
          state.roundReviewers.push(record);
        }
        affected.push(normalizeReviewer(record));
      }
      return affected;
    },

    async updateReviewer({ patch = {}, projectId, reviewerId, roundId, tenantId }) {
      const record = state.roundReviewers.find((item) => item.id === reviewerId && item.roundId === roundId && sameScope(item, { projectId, tenantId })) ?? null;
      if (!record) return null;
      for (const key of ['lastSeenAt', 'mailQueuedAt', 'removedAt', 'submittedAt', 'remindedAt']) {
        if (patch[key] !== undefined) record[key] = toIso(patch[key]);
      }
      for (const key of ['mailReason', 'mailStatus', 'mailTargetId']) {
        if (patch[key] !== undefined) record[key] = nullableString(patch[key]);
      }
      if (patch.required !== undefined) record.required = Boolean(patch.required);
      if (patch.position !== undefined) record.position = clone(patch.position);
      record.updatedAt = new Date().toISOString();
      return normalizeReviewer(record);
    },

    /** Marks a reminder as sent once per reviewer per round. False when already claimed. */
    /** Records that the reviewer's reminder is queued. False when it already was. */
    async markReminded({ now, reviewerId }) {
      const record = state.roundReviewers.find((item) => item.id === reviewerId) ?? null;
      if (!record || record.remindedAt) return false;
      record.remindedAt = toIso(now);
      return true;
    },

    async listDueReminders({ limit = 200, now }) {
      const nowMs = toMs(now) ?? Date.now();
      const due = [];
      for (const round of state.rounds) {
        if (round.status !== 'open' || !reminderDue({ dueAt: round.dueAt, reminderDaysBefore: round.reminderDaysBefore ?? null }, nowMs)) continue;
        for (const reviewer of reviewersOf(round.id)) {
          if (reviewer.removedAt || reviewer.submittedAt || reviewer.remindedAt) continue;
          due.push({ reviewer: normalizeReviewer(reviewer), round: present(round) });
        }
      }
      return due.slice(0, limit);
    },

    // Annotations -----------------------------------------------------------

    async getAnnotation({ annotationId }) {
      const record = state.annotations.find((item) => item.id === annotationId) ?? null;
      return record ? normalizeAnnotation(record) : null;
    },

    async listAnnotations({ includeDeleted = false, projectId, roundIds = [], tenantId }) {
      const ids = new Set(roundIds);
      return state.annotations
        .filter((item) => sameScope(item, { projectId, tenantId }) && ids.has(item.roundId) && (includeDeleted || !item.deletedAt))
        .map(normalizeAnnotation)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    },

    /** Inserts an annotation with the next display number for its round and screen. */
    async createAnnotation({ annotation, numberShapes = (shapes) => shapes }) {
      if (state.annotations.some((item) => item.id === annotation.id)) {
        throw new HttpError(409, 'That annotation id is already in use.', { details: { code: 'annotation_id_taken' } });
      }
      const now = toIso(annotation.createdAt) ?? new Date().toISOString();
      const number = nextNumber(annotation.roundId, annotation.screenId);
      const record = {
        ...clone(annotation),
        createdAt: now,
        deletedAt: null,
        number,
        originRoundId: annotation.originRoundId ?? annotation.roundId,
        shapes: numberShapes(clone(annotation.shapes), number),
        status: annotation.status ?? 'open',
        updatedAt: now,
      };
      state.annotations.push(record);
      return normalizeAnnotation(record);
    },

    async updateAnnotation({ annotationId, patch = {}, now }) {
      const record = state.annotations.find((item) => item.id === annotationId) ?? null;
      if (!record) return null;
      for (const key of ['anchor', 'category', 'elementHint', 'schemaVersion', 'shapes', 'snapshotFileId', 'stateKey', 'status', 'statusChangedBy']) {
        if (patch[key] !== undefined) record[key] = clone(patch[key]);
      }
      for (const key of ['deletedAt', 'statusChangedAt']) {
        if (patch[key] !== undefined) record[key] = toIso(patch[key]);
      }
      record.updatedAt = toIso(now) ?? new Date().toISOString();
      return normalizeAnnotation(record);
    },

    /** Sets one status on many annotations (carry-forward transitions). */
    async setAnnotationStatuses({ annotationIds = [], now, status }) {
      const ids = new Set(annotationIds);
      for (const record of state.annotations) {
        if (!ids.has(record.id)) continue;
        record.status = status;
        record.statusChangedAt = toIso(now);
        record.statusChangedBy = 'system:carry-forward';
        record.updatedAt = toIso(now);
      }
    },

    /** Moves an annotation into another round with the next display number there. */
    async moveAnnotation({ annotationId, changedBy, now, numberShapes = (shapes) => shapes, status, toPackageId, toPackageVersion, toRoundId }) {
      const record = state.annotations.find((item) => item.id === annotationId) ?? null;
      if (!record) return null;
      const number = nextNumber(toRoundId, record.screenId);
      Object.assign(record, {
        carriedFromRoundId: record.roundId,
        number,
        originRoundId: record.originRoundId ?? record.roundId,
        packageId: toPackageId,
        packageVersion: Number(toPackageVersion),
        roundId: toRoundId,
        shapes: numberShapes(record.shapes, number),
        status,
        statusChangedAt: toIso(now),
        statusChangedBy: changedBy,
        updatedAt: toIso(now),
      });
      return normalizeAnnotation(record);
    },

    // Annotation comments ---------------------------------------------------

    async listComments({ annotationIds = [] }) {
      const ids = new Set(annotationIds);
      return state.comments
        .filter((item) => ids.has(item.annotationId))
        .map(normalizeComment)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    },

    async getComment({ commentId }) {
      const record = state.comments.find((item) => item.id === commentId) ?? null;
      return record ? normalizeComment(record) : null;
    },

    async createComment({ comment }) {
      const now = toIso(comment.createdAt) ?? new Date().toISOString();
      const record = { ...clone(comment), createdAt: now, deletedAt: null, editedAt: null, id: comment.id ?? randomUUID(), updatedAt: now };
      state.comments.push(record);
      return normalizeComment(record);
    },

    async updateComment({ commentId, patch = {}, now }) {
      const record = state.comments.find((item) => item.id === commentId) ?? null;
      if (!record) return null;
      if (patch.body !== undefined) record.body = String(patch.body);
      if (patch.editedAt !== undefined) record.editedAt = toIso(patch.editedAt);
      if (patch.deletedAt !== undefined) {
        record.deletedAt = toIso(patch.deletedAt);
        if (record.deletedAt) record.body = '';
      }
      record.updatedAt = toIso(now) ?? new Date().toISOString();
      return normalizeComment(record);
    },

    // Verdicts and direction stances ------------------------------------------

    async listVerdicts({ roundIds = [] }) {
      const ids = new Set(roundIds);
      return state.verdicts.filter((item) => ids.has(item.roundId)).map(normalizeVerdict);
    },

    /**
     * Replaces one reviewer's verdict rows for one target. Rows keep their ids when the
     * dimension stays; an empty list clears the verdict.
     */
    async replaceVerdict({ actorId, actorType, now, projectId, roundId, rows = [], targetId, targetType, tenantId }) {
      const timestamp = toIso(now) ?? new Date().toISOString();
      const mine = (item) => item.roundId === roundId && item.actorType === actorType && item.actorId === actorId
        && item.targetType === targetType && item.targetId === targetId;
      const keep = new Set(rows.map((row) => row.dimension));
      state.verdicts = state.verdicts.filter((item) => !mine(item) || keep.has(item.dimension));
      for (const row of rows) {
        const existing = state.verdicts.find((item) => mine(item) && item.dimension === row.dimension);
        if (existing) {
          Object.assign(existing, {
            changeNote: row.changeNote ?? '',
            keepNote: row.keepNote ?? '',
            mixedNote: row.mixedNote ?? '',
            updatedAt: timestamp,
            value: row.value,
          });
        } else {
          state.verdicts.push({
            actorId,
            actorType,
            changeNote: row.changeNote ?? '',
            createdAt: timestamp,
            dimension: row.dimension,
            id: randomUUID(),
            keepNote: row.keepNote ?? '',
            mixedNote: row.mixedNote ?? '',
            projectId,
            roundId,
            targetId,
            targetType,
            tenantId,
            updatedAt: timestamp,
            value: row.value,
          });
        }
      }
      return state.verdicts.filter(mine).map(normalizeVerdict);
    },

    // Answers ---------------------------------------------------------------

    async listAnswers({ roundIds = [] }) {
      const ids = new Set(roundIds);
      return state.answers.filter((item) => ids.has(item.roundId)).map(normalizeAnswer);
    },

    async countTopicAnswers({ projectId, tenantId, topicId }) {
      return state.answers.filter((item) => item.topicId === topicId && sameScope(item, { projectId, tenantId })).length;
    },

    async upsertAnswer({ actorId, actorType, now, projectId, questionId, roundId, tenantId, topicId = null, value }) {
      const timestamp = toIso(now) ?? new Date().toISOString();
      let record = state.answers.find((item) => item.roundId === roundId && item.actorType === actorType
        && item.actorId === actorId && item.questionId === questionId) ?? null;
      if (record) {
        Object.assign(record, { topicId: nullableString(topicId), updatedAt: timestamp, value: clone(value) });
      } else {
        record = {
          actorId,
          actorType,
          createdAt: timestamp,
          id: randomUUID(),
          postedCommentId: null,
          projectId,
          questionId,
          roundId,
          tenantId,
          topicId: nullableString(topicId),
          updatedAt: timestamp,
          value: clone(value),
        };
        state.answers.push(record);
      }
      return normalizeAnswer(record);
    },

    async setAnswerComment({ answerId, postedCommentId }) {
      const record = state.answers.find((item) => item.id === answerId) ?? null;
      if (!record) return null;
      record.postedCommentId = nullableString(postedCommentId);
      return normalizeAnswer(record);
    },

    async deleteAnswer({ answerId }) {
      const before = state.answers.length;
      state.answers = state.answers.filter((item) => item.id !== answerId);
      return state.answers.length < before;
    },

    // Snapshots -------------------------------------------------------------

    async createSnapshot({ snapshot }) {
      const record = { ...clone(snapshot), createdAt: toIso(snapshot.createdAt) ?? new Date().toISOString() };
      state.snapshots.push(record);
      return normalizeSnapshot(record);
    },

    async getSnapshot({ projectId, snapshotId, tenantId }) {
      const record = state.snapshots.find((item) => item.id === snapshotId && sameScope(item, { projectId, tenantId })) ?? null;
      return record ? normalizeSnapshot(record) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL implementation
// ---------------------------------------------------------------------------

// Timestamps are written with FROM_UNIXTIME and read with UNIX_TIMESTAMP, as the
// requirements repository does, so they share the session time zone.
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
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function withRetry(task, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const retryable = error?.code === 'ER_DUP_ENTRY' || error?.code === 'ER_LOCK_DEADLOCK';
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 20)); });
    }
  }
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

const ROUND_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, track, package_id AS packageId, number, status,
  UNIX_TIMESTAMP(due_at) AS dueAt, note, published_by AS publishedBy, UNIX_TIMESTAMP(published_at) AS publishedAt,
  closed_by AS closedBy, outcome, outcome_direction_id AS outcomeDirectionId, UNIX_TIMESTAMP(closed_at) AS closedAt,
  reminder_days_before AS reminderDaysBefore, question_topics_json AS questionTopicsJson,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const REVIEWER_COLUMNS = `
  id, round_id AS roundId, actor_type AS actorType, actor_id AS actorId, required,
  UNIX_TIMESTAMP(invited_at) AS invitedAt, UNIX_TIMESTAMP(last_seen_at) AS lastSeenAt,
  UNIX_TIMESTAMP(submitted_at) AS submittedAt, UNIX_TIMESTAMP(removed_at) AS removedAt,
  mail_status AS mailStatus, mail_reason AS mailReason, mail_target_id AS mailTargetId,
  UNIX_TIMESTAMP(mail_queued_at) AS mailQueuedAt, UNIX_TIMESTAMP(reminded_at) AS remindedAt,
  position_json AS positionJson, UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const ANNOTATION_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, round_id AS roundId, package_id AS packageId,
  package_version AS packageVersion, screen_id AS screenId, state_key AS stateKey, pin_id AS pinId,
  anchor_json AS anchorJson, shapes_json AS shapesJson, schema_version AS schemaVersion,
  snapshot_file_id AS snapshotFileId, element_hint_json AS elementHintJson, category, status,
  author_type AS authorType, author_id AS authorId, author_name AS authorName,
  display_number AS number, origin_round_id AS originRoundId, carried_from_round_id AS carriedFromRoundId,
  status_changed_by AS statusChangedBy, UNIX_TIMESTAMP(status_changed_at) AS statusChangedAt,
  UNIX_TIMESTAMP(deleted_at) AS deletedAt, UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const COMMENT_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, annotation_id AS annotationId, parent_comment_id AS parentCommentId,
  author_type AS authorType, author_id AS authorId, author_name AS authorName, body,
  UNIX_TIMESTAMP(edited_at) AS editedAt, UNIX_TIMESTAMP(deleted_at) AS deletedAt,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const VERDICT_COLUMNS = `
  id, round_id AS roundId, actor_type AS actorType, actor_id AS actorId, target_type AS targetType, target_id AS targetId,
  dimension, value, keep_note AS keepNote, change_note AS changeNote, mixed_note AS mixedNote,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const ANSWER_COLUMNS = `
  id, round_id AS roundId, actor_type AS actorType, actor_id AS actorId, question_id AS questionId,
  CAST(value_json AS CHAR) AS valueJson, posted_comment_id AS postedCommentId, topic_id AS topicId,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const SNAPSHOT_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, round_id AS roundId, screen_id AS screenId, state_key AS stateKey,
  storage_key AS storageKey, width, height, size_bytes AS sizeBytes, sha256, uploaded_by AS uploadedBy,
  UNIX_TIMESTAMP(created_at) AS createdAt
`;

function mapReviewerRow(row) {
  return {
    ...row,
    createdAt: fromUnix(row.createdAt),
    invitedAt: fromUnix(row.invitedAt),
    lastSeenAt: fromUnix(row.lastSeenAt),
    mailQueuedAt: fromUnix(row.mailQueuedAt),
    position: parseJsonColumn(row.positionJson, null),
    remindedAt: fromUnix(row.remindedAt),
    removedAt: fromUnix(row.removedAt),
    submittedAt: fromUnix(row.submittedAt),
    updatedAt: fromUnix(row.updatedAt),
  };
}

function mapRoundRow(row, reviewerRows = []) {
  return normalizeRound({
    ...row,
    closedAt: fromUnix(row.closedAt),
    createdAt: fromUnix(row.createdAt),
    dueAt: fromUnix(row.dueAt),
    publishedAt: fromUnix(row.publishedAt),
    questionTopics: parseJsonColumn(row.questionTopicsJson, {}),
    updatedAt: fromUnix(row.updatedAt),
  }, reviewerRows.filter((reviewer) => reviewer.roundId === row.id).map(mapReviewerRow));
}

function mapAnnotationRow(row) {
  return normalizeAnnotation({
    ...row,
    anchor: parseJsonColumn(row.anchorJson, {}),
    createdAt: fromUnix(row.createdAt),
    deletedAt: fromUnix(row.deletedAt),
    elementHint: parseJsonColumn(row.elementHintJson, null),
    shapes: parseJsonColumn(row.shapesJson, []),
    statusChangedAt: fromUnix(row.statusChangedAt),
    updatedAt: fromUnix(row.updatedAt),
  });
}

function mapCommentRow(row) {
  return normalizeComment({
    ...row,
    createdAt: fromUnix(row.createdAt),
    deletedAt: fromUnix(row.deletedAt),
    editedAt: fromUnix(row.editedAt),
    updatedAt: fromUnix(row.updatedAt),
  });
}

function mapVerdictRow(row) {
  return normalizeVerdict({ ...row, createdAt: fromUnix(row.createdAt), updatedAt: fromUnix(row.updatedAt) });
}

// Answer values can be JSON scalars ("range-on-home", 4), which mysql2 would hand back
// already parsed and indistinguishable from text; the column is read as text instead.
function mapAnswerRow(row) {
  let value = null;
  try {
    value = row.valueJson === null || row.valueJson === undefined ? null : JSON.parse(String(row.valueJson));
  } catch (_error) {
    value = null;
  }
  return normalizeAnswer({ ...row, createdAt: fromUnix(row.createdAt), updatedAt: fromUnix(row.updatedAt), value });
}

function mapSnapshotRow(row) {
  return normalizeSnapshot({ ...row, createdAt: fromUnix(row.createdAt) });
}

export function createMysqlRoundsRepository({ pool }) {
  async function selectRounds(executor, where, params) {
    const [rows] = await executor.execute(`SELECT ${ROUND_COLUMNS} FROM review_rounds WHERE ${where} ORDER BY track ASC, number ASC`, params);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [reviewerRows] = await executor.execute(
      `SELECT ${REVIEWER_COLUMNS} FROM review_round_reviewers WHERE round_id IN (${placeholders(ids)})`,
      ids,
    );
    return rows.map((row) => mapRoundRow(row, reviewerRows));
  }

  async function selectRound(executor, { projectId, roundId, tenantId }) {
    const [round] = await selectRounds(executor, 'tenant_id = ? AND project_id = ? AND id = ?', [tenantId, projectId, roundId]);
    return round ?? null;
  }

  async function selectReviewer(executor, reviewerId) {
    const [rows] = await executor.execute(`SELECT ${REVIEWER_COLUMNS} FROM review_round_reviewers WHERE id = ? LIMIT 1`, [reviewerId]);
    return rows[0] ? normalizeReviewer(mapReviewerRow(rows[0])) : null;
  }

  async function selectAnnotation(executor, annotationId) {
    const [rows] = await executor.execute(`SELECT ${ANNOTATION_COLUMNS} FROM review_annotations WHERE id = ? LIMIT 1`, [annotationId]);
    return rows[0] ? mapAnnotationRow(rows[0]) : null;
  }

  async function nextAnnotationNumber(connection, { roundId, screenId }) {
    // Locking the round row serializes numbering within a round.
    await connection.execute('SELECT id FROM review_rounds WHERE id = ? FOR UPDATE', [roundId]);
    const [rows] = await connection.execute(
      'SELECT COALESCE(MAX(display_number), 0) AS number FROM review_annotations WHERE round_id = ? AND screen_id = ?',
      [roundId, screenId],
    );
    return Number(rows[0]?.number ?? 0) + 1;
  }

  async function insertReviewerRow(connection, { projectId, reviewer, roundId, tenantId, timestamp }) {
    await connection.execute(
      `
        INSERT INTO review_round_reviewers (
          id, tenant_id, project_id, round_id, actor_type, actor_id, required, invited_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?))
      `,
      [reviewer.id ?? randomUUID(), tenantId, projectId, roundId, reviewer.actorType, reviewer.actorId, reviewer.required ? 1 : 0,
        unixSeconds(reviewer.invitedAt ?? timestamp), unixSeconds(timestamp), unixSeconds(timestamp)],
    );
  }

  return {
    // Rounds ----------------------------------------------------------------

    async createRound({ projectId, requireNoOpenRound = true, reviewers = [], round, tenantId }) {
      const id = round.id ?? randomUUID();
      const timestamp = round.publishedAt ?? new Date();
      await withRetry(() => withTransaction(pool, async (connection) => {
        // Locks the project's rounds, so concurrent publishes serialize and the one open round
        // per project rule holds. Review is project-wide, so numbers run across the project.
        const [existing] = await connection.execute(
          'SELECT id, number, status FROM review_rounds WHERE tenant_id = ? AND project_id = ? FOR UPDATE',
          [tenantId, projectId],
        );
        const open = existing.find((row) => row.status === 'open');
        if (requireNoOpenRound && open) throw roundOpenConflict(open);
        const number = existing.reduce((max, row) => Math.max(max, Number(row.number)), 0) + 1;
        await connection.execute(
          `
            INSERT INTO review_rounds (
              id, tenant_id, project_id, track, package_id, number, status, due_at, note, published_by, published_at,
              reminder_days_before, question_topics_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'open', FROM_UNIXTIME(?), ?, ?, FROM_UNIXTIME(?), ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
          `,
          [
            id, tenantId, projectId, round.track, round.packageId, number, unixSeconds(round.dueAt), normalizeString(round.note),
            nullableString(round.publishedBy), unixSeconds(round.publishedAt), nullableInt(round.reminderDaysBefore),
            JSON.stringify(round.questionTopics ?? {}), unixSeconds(timestamp), unixSeconds(timestamp),
          ],
        );
        for (const reviewer of reviewers) {
          await insertReviewerRow(connection, { projectId, reviewer, roundId: id, tenantId, timestamp });
        }
      }));
      return selectRound(pool, { projectId, roundId: id, tenantId });
    },

    async getRound({ projectId, roundId, tenantId }) {
      return selectRound(pool, { projectId, roundId, tenantId });
    },

    async listRounds({ projectId, tenantId, track = '' }) {
      return track
        ? selectRounds(pool, 'tenant_id = ? AND project_id = ? AND track = ?', [tenantId, projectId, track])
        : selectRounds(pool, 'tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    },

    async updateRound({ patch = {}, projectId, roundId, tenantId }) {
      const assignments = [];
      const params = [];
      if (patch.dueAt !== undefined) { assignments.push('due_at = FROM_UNIXTIME(?)'); params.push(unixSeconds(patch.dueAt)); }
      if (patch.note !== undefined) { assignments.push('note = ?'); params.push(normalizeString(patch.note)); }
      if (patch.reminderDaysBefore !== undefined) { assignments.push('reminder_days_before = ?'); params.push(nullableInt(patch.reminderDaysBefore)); }
      assignments.push('updated_at = FROM_UNIXTIME(?)');
      params.push(unixSeconds(new Date()));
      const [result] = await pool.execute(
        `UPDATE review_rounds SET ${assignments.join(', ')} WHERE tenant_id = ? AND project_id = ? AND id = ? AND status = 'open'`,
        [...params, tenantId, projectId, roundId],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return null;
      return selectRound(pool, { projectId, roundId, tenantId });
    },

    /** Closes an open round and records its decision in one transaction. See the in-memory version. */
    async closeRound({ closedAt, closedBy, decision, outcome, outcomeDirectionId = null, projectId, roundId, tenantId }) {
      const seconds = unixSeconds(closedAt ?? new Date());
      const decisionId = decision.id ?? randomUUID();
      const closed = await withTransaction(pool, async (connection) => {
        const [result] = await connection.execute(
          `
            UPDATE review_rounds
            SET status = 'closed', closed_at = FROM_UNIXTIME(?), closed_by = ?, outcome = ?, outcome_direction_id = ?, updated_at = FROM_UNIXTIME(?)
            WHERE tenant_id = ? AND project_id = ? AND id = ? AND status = 'open'
          `,
          [seconds, closedBy, outcome, nullableString(outcomeDirectionId), seconds, tenantId, projectId, roundId],
        );
        if (Number(result.affectedRows ?? 0) !== 1) return false;
        await insertMysqlDecision(connection, { decision, id: decisionId, projectId, tenantId });
        return true;
      });
      if (!closed) return null;
      return {
        decision: await selectMysqlDecision(pool, { decisionId, projectId, tenantId }),
        round: await selectRound(pool, { projectId, roundId, tenantId }),
      };
    },

    // Reviewers -------------------------------------------------------------

    async addReviewers({ now, projectId, reviewers = [], roundId, tenantId }) {
      const timestamp = now ?? new Date();
      const affectedIds = [];
      await withTransaction(pool, async (connection) => {
        for (const reviewer of reviewers) {
          const [rows] = await connection.execute(
            'SELECT id, removed_at AS removedAt FROM review_round_reviewers WHERE round_id = ? AND actor_type = ? AND actor_id = ? LIMIT 1 FOR UPDATE',
            [roundId, reviewer.actorType, reviewer.actorId],
          );
          if (rows[0] && !rows[0].removedAt) continue;
          if (rows[0]) {
            await connection.execute(
              `
                UPDATE review_round_reviewers
                SET removed_at = NULL, invited_at = FROM_UNIXTIME(?), required = ?, updated_at = FROM_UNIXTIME(?)
                WHERE id = ?
              `,
              [unixSeconds(timestamp), reviewer.required ? 1 : 0, unixSeconds(timestamp), rows[0].id],
            );
            affectedIds.push(rows[0].id);
          } else {
            const id = randomUUID();
            await insertReviewerRow(connection, { projectId, reviewer: { ...reviewer, id, invitedAt: timestamp }, roundId, tenantId, timestamp });
            affectedIds.push(id);
          }
        }
      });
      const affected = [];
      for (const id of affectedIds) affected.push(await selectReviewer(pool, id));
      return affected;
    },

    async updateReviewer({ patch = {}, projectId, reviewerId, roundId, tenantId }) {
      const assignments = [];
      const params = [];
      const timestamps = { lastSeenAt: 'last_seen_at', mailQueuedAt: 'mail_queued_at', remindedAt: 'reminded_at', removedAt: 'removed_at', submittedAt: 'submitted_at' };
      for (const [key, column] of Object.entries(timestamps)) {
        if (patch[key] !== undefined) { assignments.push(`${column} = FROM_UNIXTIME(?)`); params.push(unixSeconds(patch[key])); }
      }
      const strings = { mailReason: 'mail_reason', mailStatus: 'mail_status', mailTargetId: 'mail_target_id' };
      for (const [key, column] of Object.entries(strings)) {
        if (patch[key] !== undefined) { assignments.push(`${column} = ?`); params.push(nullableString(patch[key])); }
      }
      if (patch.required !== undefined) { assignments.push('required = ?'); params.push(patch.required ? 1 : 0); }
      if (patch.position !== undefined) { assignments.push('position_json = ?'); params.push(patch.position === null ? null : JSON.stringify(patch.position)); }
      if (assignments.length === 0) return selectReviewer(pool, reviewerId);
      assignments.push('updated_at = FROM_UNIXTIME(?)');
      params.push(unixSeconds(new Date()));
      const [result] = await pool.execute(
        `UPDATE review_round_reviewers SET ${assignments.join(', ')} WHERE id = ? AND round_id = ? AND tenant_id = ? AND project_id = ?`,
        [...params, reviewerId, roundId, tenantId, projectId],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return null;
      return selectReviewer(pool, reviewerId);
    },

    async markReminded({ now, reviewerId }) {
      const [result] = await pool.execute(
        'UPDATE review_round_reviewers SET reminded_at = FROM_UNIXTIME(?) WHERE id = ? AND reminded_at IS NULL',
        [unixSeconds(now), reviewerId],
      );
      return Number(result.affectedRows ?? 0) === 1;
    },

    async listDueReminders({ limit = 200, now }) {
      const nowSeconds = unixSeconds(now ?? new Date());
      const safeLimit = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 200));
      const [rows] = await pool.execute(
        `
          SELECT rr.id AS reviewerId, r.id AS roundId, r.tenant_id AS tenantId, r.project_id AS projectId
          FROM review_rounds r
          JOIN review_round_reviewers rr ON rr.round_id = r.id
          WHERE r.status = 'open'
            AND r.due_at IS NOT NULL
            AND r.reminder_days_before IS NOT NULL
            AND r.due_at > FROM_UNIXTIME(?)
            AND DATE_SUB(r.due_at, INTERVAL r.reminder_days_before DAY) <= FROM_UNIXTIME(?)
            AND rr.removed_at IS NULL
            AND rr.submitted_at IS NULL
            AND rr.reminded_at IS NULL
          ORDER BY r.due_at ASC
          LIMIT ${safeLimit}
        `,
        [nowSeconds, nowSeconds],
      );
      const due = [];
      const rounds = new Map();
      for (const row of rows) {
        if (!rounds.has(row.roundId)) rounds.set(row.roundId, await selectRound(pool, { projectId: row.projectId, roundId: row.roundId, tenantId: row.tenantId }));
        const round = rounds.get(row.roundId);
        const reviewer = round?.reviewers.find((item) => item.id === row.reviewerId) ?? null;
        if (round && reviewer) due.push({ reviewer, round });
      }
      return due;
    },

    // Annotations -----------------------------------------------------------

    async getAnnotation({ annotationId }) {
      return selectAnnotation(pool, annotationId);
    },

    async listAnnotations({ includeDeleted = false, projectId, roundIds = [], tenantId }) {
      if (roundIds.length === 0) return [];
      const [rows] = await pool.execute(
        `
          SELECT ${ANNOTATION_COLUMNS} FROM review_annotations
          WHERE tenant_id = ? AND project_id = ? AND round_id IN (${placeholders(roundIds)})${includeDeleted ? '' : ' AND deleted_at IS NULL'}
          ORDER BY created_at ASC, id ASC
        `,
        [tenantId, projectId, ...roundIds],
      );
      return rows.map(mapAnnotationRow);
    },

    async createAnnotation({ annotation, numberShapes = (shapes) => shapes }) {
      const timestamp = annotation.createdAt ?? new Date();
      try {
        await withRetry(() => withTransaction(pool, async (connection) => {
          const number = await nextAnnotationNumber(connection, annotation);
          await connection.execute(
            `
              INSERT INTO review_annotations (
                id, tenant_id, project_id, round_id, package_id, package_version, screen_id, state_key, pin_id,
                anchor_json, shapes_json, schema_version, snapshot_file_id, element_hint_json, category, status,
                author_type, author_id, author_name, display_number, origin_round_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
            `,
            [
              annotation.id, annotation.tenantId, annotation.projectId, annotation.roundId, annotation.packageId,
              Number(annotation.packageVersion), annotation.screenId, nullableString(annotation.stateKey), nullableString(annotation.pinId),
              JSON.stringify(annotation.anchor ?? {}), JSON.stringify(numberShapes(clone(annotation.shapes ?? []), number)),
              Number(annotation.schemaVersion ?? 1), nullableString(annotation.snapshotFileId),
              annotation.elementHint ? JSON.stringify(annotation.elementHint) : null, nullableString(annotation.category),
              annotation.status ?? 'open', annotation.authorType, annotation.authorId, normalizeString(annotation.authorName).slice(0, 255),
              number, annotation.originRoundId ?? annotation.roundId, unixSeconds(timestamp), unixSeconds(timestamp),
            ],
          );
        }), 3);
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
          throw new HttpError(409, 'That annotation id is already in use.', { details: { code: 'annotation_id_taken' } });
        }
        throw error;
      }
      return selectAnnotation(pool, annotation.id);
    },

    async updateAnnotation({ annotationId, now, patch = {} }) {
      const assignments = [];
      const params = [];
      const json = { anchor: 'anchor_json', elementHint: 'element_hint_json', shapes: 'shapes_json' };
      for (const [key, column] of Object.entries(json)) {
        if (patch[key] !== undefined) { assignments.push(`${column} = ?`); params.push(patch[key] === null ? null : JSON.stringify(patch[key])); }
      }
      const plain = { category: 'category', schemaVersion: 'schema_version', snapshotFileId: 'snapshot_file_id', stateKey: 'state_key', status: 'status', statusChangedBy: 'status_changed_by' };
      for (const [key, column] of Object.entries(plain)) {
        if (patch[key] !== undefined) { assignments.push(`${column} = ?`); params.push(patch[key] ?? null); }
      }
      const times = { deletedAt: 'deleted_at', statusChangedAt: 'status_changed_at' };
      for (const [key, column] of Object.entries(times)) {
        if (patch[key] !== undefined) { assignments.push(`${column} = FROM_UNIXTIME(?)`); params.push(unixSeconds(patch[key])); }
      }
      assignments.push('updated_at = FROM_UNIXTIME(?)');
      params.push(unixSeconds(now ?? new Date()));
      await pool.execute(`UPDATE review_annotations SET ${assignments.join(', ')} WHERE id = ?`, [...params, annotationId]);
      return selectAnnotation(pool, annotationId);
    },

    async setAnnotationStatuses({ annotationIds = [], now, status }) {
      if (annotationIds.length === 0) return;
      const seconds = unixSeconds(now ?? new Date());
      await pool.execute(
        `
          UPDATE review_annotations
          SET status = ?, status_changed_at = FROM_UNIXTIME(?), status_changed_by = 'system:carry-forward', updated_at = FROM_UNIXTIME(?)
          WHERE id IN (${placeholders(annotationIds)})
        `,
        [status, seconds, seconds, ...annotationIds],
      );
    },

    async moveAnnotation({ annotationId, changedBy, now, numberShapes = (shapes) => shapes, status, toPackageId, toPackageVersion, toRoundId }) {
      const seconds = unixSeconds(now ?? new Date());
      const moved = await withRetry(() => withTransaction(pool, async (connection) => {
        const current = await selectAnnotation(connection, annotationId);
        if (!current) return false;
        const number = await nextAnnotationNumber(connection, { roundId: toRoundId, screenId: current.screenId });
        await connection.execute(
          `
            UPDATE review_annotations
            SET carried_from_round_id = round_id, origin_round_id = COALESCE(origin_round_id, round_id), round_id = ?, package_id = ?,
                package_version = ?, display_number = ?, shapes_json = ?, status = ?, status_changed_by = ?,
                status_changed_at = FROM_UNIXTIME(?), updated_at = FROM_UNIXTIME(?)
            WHERE id = ?
          `,
          [toRoundId, toPackageId, Number(toPackageVersion), number, JSON.stringify(numberShapes(current.shapes, number)), status, changedBy,
            seconds, seconds, annotationId],
        );
        return true;
      }), 3);
      return moved ? selectAnnotation(pool, annotationId) : null;
    },

    // Annotation comments ---------------------------------------------------

    async listComments({ annotationIds = [] }) {
      if (annotationIds.length === 0) return [];
      const [rows] = await pool.execute(
        `SELECT ${COMMENT_COLUMNS} FROM review_comments WHERE annotation_id IN (${placeholders(annotationIds)}) ORDER BY created_at ASC, id ASC`,
        annotationIds,
      );
      return rows.map(mapCommentRow);
    },

    async getComment({ commentId }) {
      const [rows] = await pool.execute(`SELECT ${COMMENT_COLUMNS} FROM review_comments WHERE id = ? LIMIT 1`, [commentId]);
      return rows[0] ? mapCommentRow(rows[0]) : null;
    },

    async createComment({ comment }) {
      const id = comment.id ?? randomUUID();
      const seconds = unixSeconds(comment.createdAt ?? new Date());
      await pool.execute(
        `
          INSERT INTO review_comments (
            id, tenant_id, project_id, annotation_id, parent_comment_id, author_type, author_id, author_name, body, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [id, comment.tenantId, comment.projectId, comment.annotationId, nullableString(comment.parentCommentId), comment.authorType,
          comment.authorId, normalizeString(comment.authorName).slice(0, 255), String(comment.body ?? ''), seconds, seconds],
      );
      return this.getComment({ commentId: id });
    },

    async updateComment({ commentId, now, patch = {} }) {
      const assignments = [];
      const params = [];
      if (patch.body !== undefined) { assignments.push('body = ?'); params.push(String(patch.body)); }
      if (patch.editedAt !== undefined) { assignments.push('edited_at = FROM_UNIXTIME(?)'); params.push(unixSeconds(patch.editedAt)); }
      if (patch.deletedAt !== undefined) {
        assignments.push('deleted_at = FROM_UNIXTIME(?)');
        params.push(unixSeconds(patch.deletedAt));
        if (patch.deletedAt) assignments.push("body = ''");
      }
      assignments.push('updated_at = FROM_UNIXTIME(?)');
      params.push(unixSeconds(now ?? new Date()));
      await pool.execute(`UPDATE review_comments SET ${assignments.join(', ')} WHERE id = ?`, [...params, commentId]);
      return this.getComment({ commentId });
    },

    // Verdicts --------------------------------------------------------------

    async listVerdicts({ roundIds = [] }) {
      if (roundIds.length === 0) return [];
      const [rows] = await pool.execute(
        `SELECT ${VERDICT_COLUMNS} FROM review_verdicts WHERE round_id IN (${placeholders(roundIds)}) ORDER BY created_at ASC, id ASC`,
        roundIds,
      );
      return rows.map(mapVerdictRow);
    },

    async replaceVerdict({ actorId, actorType, now, projectId, roundId, rows = [], targetId, targetType, tenantId }) {
      const seconds = unixSeconds(now ?? new Date());
      const scope = [roundId, actorType, actorId, targetType, targetId];
      await withRetry(() => withTransaction(pool, async (connection) => {
        const dimensions = rows.map((row) => row.dimension);
        await connection.execute(
          `
            DELETE FROM review_verdicts
            WHERE round_id = ? AND actor_type = ? AND actor_id = ? AND target_type = ? AND target_id = ?
              ${dimensions.length > 0 ? `AND dimension NOT IN (${placeholders(dimensions)})` : ''}
          `,
          [...scope, ...dimensions],
        );
        for (const row of rows) {
          await connection.execute(
            `
              INSERT INTO review_verdicts (
                id, tenant_id, project_id, round_id, actor_type, actor_id, target_type, target_id, dimension, value,
                keep_note, change_note, mixed_note, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
              ON DUPLICATE KEY UPDATE value = VALUES(value), keep_note = VALUES(keep_note), change_note = VALUES(change_note),
                mixed_note = VALUES(mixed_note), updated_at = VALUES(updated_at)
            `,
            [randomUUID(), tenantId, projectId, ...scope, row.dimension, row.value, row.keepNote || null, row.changeNote || null,
              row.mixedNote || null, seconds, seconds],
          );
        }
      }));
      const [result] = await pool.execute(
        `SELECT ${VERDICT_COLUMNS} FROM review_verdicts WHERE round_id = ? AND actor_type = ? AND actor_id = ? AND target_type = ? AND target_id = ?`,
        scope,
      );
      return result.map(mapVerdictRow);
    },

    // Answers ---------------------------------------------------------------

    async listAnswers({ roundIds = [] }) {
      if (roundIds.length === 0) return [];
      const [rows] = await pool.execute(
        `SELECT ${ANSWER_COLUMNS} FROM review_answers WHERE round_id IN (${placeholders(roundIds)}) ORDER BY created_at ASC, id ASC`,
        roundIds,
      );
      return rows.map(mapAnswerRow);
    },

    async countTopicAnswers({ projectId, tenantId, topicId }) {
      const [rows] = await pool.execute(
        'SELECT COUNT(*) AS count FROM review_answers WHERE tenant_id = ? AND project_id = ? AND topic_id = ?',
        [tenantId, projectId, topicId],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async upsertAnswer({ actorId, actorType, now, projectId, questionId, roundId, tenantId, topicId = null, value }) {
      const seconds = unixSeconds(now ?? new Date());
      await withRetry(() => pool.execute(
        `
          INSERT INTO review_answers (
            id, tenant_id, project_id, round_id, actor_type, actor_id, question_id, value_json, topic_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
          ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), topic_id = VALUES(topic_id), updated_at = VALUES(updated_at)
        `,
        [randomUUID(), tenantId, projectId, roundId, actorType, actorId, questionId, JSON.stringify(value), nullableString(topicId), seconds, seconds],
      ), 3);
      const [rows] = await pool.execute(
        `SELECT ${ANSWER_COLUMNS} FROM review_answers WHERE round_id = ? AND actor_type = ? AND actor_id = ? AND question_id = ? LIMIT 1`,
        [roundId, actorType, actorId, questionId],
      );
      return rows[0] ? mapAnswerRow(rows[0]) : null;
    },

    async setAnswerComment({ answerId, postedCommentId }) {
      await pool.execute('UPDATE review_answers SET posted_comment_id = ? WHERE id = ?', [nullableString(postedCommentId), answerId]);
      const [rows] = await pool.execute(`SELECT ${ANSWER_COLUMNS} FROM review_answers WHERE id = ? LIMIT 1`, [answerId]);
      return rows[0] ? mapAnswerRow(rows[0]) : null;
    },

    async deleteAnswer({ answerId }) {
      const [result] = await pool.execute('DELETE FROM review_answers WHERE id = ?', [answerId]);
      return Number(result.affectedRows ?? 0) > 0;
    },

    // Snapshots -------------------------------------------------------------

    async createSnapshot({ snapshot }) {
      await pool.execute(
        `
          INSERT INTO review_snapshots (
            id, tenant_id, project_id, round_id, screen_id, state_key, storage_key, width, height, size_bytes, sha256, uploaded_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))
        `,
        [snapshot.id, snapshot.tenantId, snapshot.projectId, snapshot.roundId, nullableString(snapshot.screenId), nullableString(snapshot.stateKey),
          snapshot.storageKey, snapshot.width, snapshot.height, snapshot.sizeBytes, snapshot.sha256, snapshot.uploadedBy,
          unixSeconds(snapshot.createdAt ?? new Date())],
      );
      return this.getSnapshot({ projectId: snapshot.projectId, snapshotId: snapshot.id, tenantId: snapshot.tenantId });
    },

    async getSnapshot({ projectId, snapshotId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT ${SNAPSHOT_COLUMNS} FROM review_snapshots WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1`,
        [tenantId, projectId, snapshotId],
      );
      return rows[0] ? mapSnapshotRow(rows[0]) : null;
    },
  };
}
