import { AsyncLocalStorage } from 'node:async_hooks';

import { currentRequestChannel } from '../../lib/http/request-channel.js';

// The project change log. Each change to a project's work items,
// comments, item links, schedule dependencies, sprint assignments and details adds a row, in the
// same transaction as the change, with a sequence number that agents read as a cursor:
// odin_get_project_changes returns what came after it. Rows hold the actor, how the change
// arrived (`via`) and, for items, the fields that changed with their old and new values. A link
// or dependency is logged under one item and names the other in `related_item_id`, so either
// end's history finds it.

// What an agent said about the change it is making (odin_apply_item_changes): its idempotency
// key, reason and evidence. Every row written while it runs carries it as `detail.note`.
const changeNotes = new AsyncLocalStorage();

export function runWithChangeNote(note, callback) {
  return changeNotes.run(note, callback);
}

export const CHANGE_LOG_RETENTION_DAYS = 90;
// Changes this recent are held back from readers: a transaction that wrote a lower sequence
// number may not have committed yet, and a reader who moved past it would never see it.
export const CHANGE_SETTLE_MS = 5000;

const ITEM_FIELDS = [
  'name', 'status', 'boardColumn', 'assigneeId', 'assigneeName', 'sprintId', 'priority', 'points', 'targetHourEstimate',
  'remainingHours', 'actualHours', 'percentComplete', 'targetStartDate', 'targetEndDate', 'estimateOverride',
  'severity', 'category', 'environment', 'releaseId', 'externalReviewState',
];

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * The fields an item revision changed, as { field: { from, to } }, from its before and after
 * snapshots ({ itemType, node, parentId }). A new item lists the fields it was given; a deleted
 * one lists none. A changed description is reported as { changed: true } without its text.
 */
export function itemChangeFields(before, after) {
  if (!after) return {};
  const old = before?.node ?? {};
  const now = after.node ?? {};
  const fields = {};
  for (const field of ITEM_FIELDS) {
    if (!(field in now) && !(field in old)) continue;
    if (before ? !same(old[field], now[field]) : now[field] != null && now[field] !== '') {
      fields[field] = before ? { from: old[field] ?? null, to: now[field] ?? null } : { to: now[field] };
    }
  }
  if (before ? !same(before.parentId, after.parentId) : after.parentId) fields.parentId = before ? { from: before.parentId ?? null, to: after.parentId ?? null } : { to: after.parentId };
  if (before ? !same(old.description, now.description) : Boolean(now.description)) fields.description = { changed: true };
  return fields;
}

/** The change log entry for an item revision (a row of project_item_revisions, as written). */
export function itemRevisionChange(revision) {
  return {
    action: revision.action,
    actorId: revision.actorUserId,
    detail: { fields: itemChangeFields(revision.before, revision.after), itemType: revision.itemType, version: revision.versionAfter ?? null },
    entityId: revision.itemId,
    entityType: 'item',
    itemId: revision.itemId,
    projectId: revision.projectId,
    tenantId: revision.tenantId,
  };
}

const ITEM_TARGETS = new Set(['epic', 'story', 'task', 'ticket']);

/** The change log entry for a comment written, edited or deleted on a project. */
export function commentChange({ action, actorId, comment, projectId, tenantId }) {
  return {
    action,
    actorId,
    detail: { parentId: comment.parentId ?? null, targetId: comment.targetId, targetType: comment.targetType },
    entityId: comment.id,
    entityType: 'comment',
    itemId: ITEM_TARGETS.has(comment.targetType) ? comment.targetId : null,
    projectId,
    tenantId,
  };
}

/**
 * The change log entry for a file. Action is create, delete, version (a new version uploaded),
 * restore, link, unlink, audience, scanned (a scan finished: detail.scanStatus says how) or
 * version_delete (an old version deleted: detail.deletedVersion). A link names the item it was made on; otherwise the entry sits on the
 * item the file was uploaded to, if any. A file that came with a ticket is logged without its name,
 * type or note: intake names it after the ticket, and a link can put the entry on an item agents
 * see while the ticket itself stays hidden from them.
 */
export function fileChange({ action, actorId, extra = null, file, link = null, note = null, projectId, tenantId }) {
  const target = link ?? file;
  const described = file.targetType === 'ticket' ? {} : { contentType: file.contentType ?? null, fileName: file.fileName, ...(note ? { versionNote: note } : {}) };
  return {
    action,
    actorId,
    detail: { ...described, ...(action === 'audience' ? { audience: file.audience ?? 'internal' } : {}), targetId: target.targetId, targetType: target.targetType, version: file.version ?? 1, ...(extra ?? {}) },
    entityId: file.id,
    entityType: 'file',
    itemId: ITEM_TARGETS.has(target.targetType) ? target.targetId : null,
    projectId,
    tenantId,
  };
}

/** The change log entry for a signature request created, signed, declined, cancelled or completed. */
export function signingChange({ action, actorId, detail = {}, projectId, request, tenantId }) {
  return {
    action,
    actorId,
    detail: { kind: request.kind, status: request.status, subjectId: request.subjectId, subjectType: request.subjectType, title: request.title, ...detail },
    entityId: request.id,
    entityType: 'signing',
    itemId: null,
    projectId,
    tenantId,
  };
}

/** The change log entry for an item link created or deleted. */
export function relationChange({ action, actorId, projectId, relation, tenantId }) {
  return {
    action,
    actorId,
    detail: { fromItemId: relation.fromItemId, relationType: relation.relationType, toItemId: relation.toItemId },
    entityId: relation.id,
    entityType: 'relation',
    itemId: relation.fromItemId,
    projectId,
    relatedItemId: relation.toItemId ?? null,
    tenantId,
  };
}

/** The change log entry for an item whose sprint changed without a revision (sprint planning). */
export function sprintChange({ actorId, from, itemId, itemType, projectId, tenantId, to }) {
  return { action: 'update', actorId, detail: { fields: { sprintId: { from: from ?? null, to: to ?? null } }, itemType }, entityId: itemId, entityType: 'item', itemId, projectId, tenantId };
}

/**
 * The change log entries for a story split, which saves the tree without revisions: the new
 * story, each task moved into it, and the story it came from.
 */
export function splitStoryChanges({ movedTaskIds, projectId, story, storyId, tenantId, user }) {
  const actorId = user?.id ?? '';
  const item = (itemId, action, detail) => ({ action, actorId, detail, entityId: itemId, entityType: 'item', itemId, projectId, tenantId });
  return [
    item(story.id, 'create', { fields: itemChangeFields(null, { node: story, parentId: null }), itemType: 'story', splitFrom: storyId }),
    ...movedTaskIds.map((taskId) => item(taskId, 'update', { fields: { parentId: { from: storyId, to: story.id } }, itemType: 'task' })),
    item(storyId, 'update', { fields: {}, itemType: 'story', splitInto: story.id }),
  ];
}

/** How a change by `actorId` arrived: a task link, ticket intake, or the request's channel. */
export function changeVia(actorId) {
  const id = String(actorId ?? '');
  if (id.startsWith('resource:')) return 'link';
  if (id.startsWith('external:')) return 'intake';
  if (id.startsWith('stakeholder:')) return 'portal';
  return currentRequestChannel() ?? 'system';
}

// A row as stored, from what a write path knows.
function changeRow(entry, createdAt) {
  const note = changeNotes.getStore() ?? null;
  return {
    action: String(entry.action).slice(0, 24),
    actorId: String(entry.actorId ?? '').slice(0, 128),
    createdAt,
    detail: note ? { ...(entry.detail ?? {}), note } : entry.detail ?? null,
    entityId: String(entry.entityId).slice(0, 128),
    entityType: String(entry.entityType).slice(0, 24),
    itemId: entry.itemId ?? null,
    projectId: entry.projectId,
    relatedItemId: entry.relatedItemId ?? null,
    tenantId: entry.tenantId,
    via: String(entry.via ?? changeVia(entry.actorId)).slice(0, 64),
  };
}

export async function ensureMysqlProjectChangeLogSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_change_log (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(36) NOT NULL,
    entity_type VARCHAR(24) NOT NULL,
    entity_id VARCHAR(128) NOT NULL,
    item_id VARCHAR(36) NULL,
    action VARCHAR(24) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    via VARCHAR(64) NOT NULL,
    detail_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    KEY idx_project_change_log_project (tenant_id, project_id, seq),
    KEY idx_project_change_log_item (tenant_id, project_id, item_id, seq),
    KEY idx_project_change_log_created (created_at)
  )`);
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [tableName, indexName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

// 0091_project_change_log_related_item: the other end of a link or dependency, indexed like
// item_id, so an item's history and the stale check in odin_apply_item_changes find changes made
// from either end.
export async function ensureMysqlProjectChangeLogRelatedColumns(executor) {
  if (!await columnExists(executor, 'project_change_log', 'related_item_id')) {
    await executor.execute('ALTER TABLE project_change_log ADD COLUMN related_item_id VARCHAR(36) NULL AFTER item_id');
  }
  if (!await indexExists(executor, 'project_change_log', 'idx_project_change_log_related')) {
    await executor.execute('ALTER TABLE project_change_log ADD KEY idx_project_change_log_related (tenant_id, project_id, related_item_id, seq)');
  }
}

/** Adds changes to the log, on the caller's connection so they commit or roll back with the change. */
export async function appendMysqlProjectChanges(executor, entries) {
  const rows = entries.filter(Boolean).map((entry) => changeRow(entry, null));
  if (!rows.length) return;
  await executor.execute(
    `INSERT INTO project_change_log (tenant_id, project_id, entity_type, entity_id, item_id, related_item_id, action, actor_id, via, detail_json, created_at)
     VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))').join(', ')}`,
    rows.flatMap((row) => [row.tenantId, row.projectId, row.entityType, row.entityId, row.itemId, row.relatedItemId, row.action, row.actorId, row.via, row.detail ? JSON.stringify(row.detail) : null]),
  );
}

const parseDetail = (value) => {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

function mapRow(row) {
  return {
    action: row.action,
    actorId: row.actor_id,
    at: new Date(row.created_at).toISOString(),
    detail: parseDetail(row.detail_json),
    entityId: row.entity_id,
    entityType: row.entity_type,
    itemId: row.item_id ?? null,
    relatedItemId: row.related_item_id ?? null,
    seq: Number(row.seq),
    via: row.via,
  };
}

/**
 * Settled changes to a project after `afterSeq`, oldest first, at most `limit`; for one item
 * (either end of a link or dependency) when `itemId` is given. `settledSeq` is the newest change
 * anywhere in the log past the settle window, and only changes up to it are read: a reader that
 * has read a project's changes up to it has them all, and can move its cursor there even when the
 * project itself was quiet. `floorSeq` is the sequence number below which the log has been purged
 * (a cursor below it may have missed changes).
 */
export async function listMysqlProjectChanges(executor, { afterSeq = 0, itemId = null, limit = 200, projectId, settleMs = CHANGE_SETTLE_MS, tenantId }) {
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 200));
  // The primary key read backwards, stopping at the first change past the settle window.
  const [[settled]] = await executor.query(
    `SELECT seq FROM project_change_log FORCE INDEX (PRIMARY) WHERE created_at <= NOW(3) - INTERVAL ${Math.max(0, Math.round(settleMs)) * 1000} MICROSECOND ORDER BY seq DESC LIMIT 1`,
  );
  const settledSeq = settled ? Number(settled.seq) : 0;
  const [rows] = await executor.query(
    `SELECT * FROM project_change_log WHERE tenant_id = ? AND project_id = ? ${itemId ? 'AND (item_id = ? OR related_item_id = ?)' : ''} AND seq > ? AND seq <= ? ORDER BY seq LIMIT ${bounded + 1}`,
    [tenantId, projectId, ...(itemId ? [itemId, itemId] : []), afterSeq, settledSeq],
  );
  const [[floor]] = await executor.query('SELECT MIN(seq) AS seq FROM project_change_log');
  return {
    entries: rows.slice(0, bounded).map(mapRow),
    floorSeq: floor?.seq == null ? 0 : Number(floor.seq) - 1,
    more: rows.length > bounded,
    settledSeq,
  };
}

/**
 * Each item's changes, newest first, at most `limit` per item: the ones logged under it and the
 * links and dependencies that name it as their other end. `items` lists { itemId, beforeSeq }; a
 * beforeSeq pages back past changes already read. Items read from the newest come from one
 * query; each item paged back, from one more. Returns a Map of itemId to { entries, more,
 * latestSeq }, where latestSeq is the item's newest change (null when it has none or was paged).
 */
export async function listMysqlItemChanges(executor, { items, limit = 10, projectId, tenantId }) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 10));
  const result = new Map();
  const ranked = async (ids, beforeSeq = null) => {
    if (!ids.length) return;
    const below = beforeSeq ? 'AND l.seq < ?' : '';
    const bound = beforeSeq ? [beforeSeq] : [];
    const [rows] = await executor.query(
      `SELECT * FROM (
         SELECT u.*, ROW_NUMBER() OVER (PARTITION BY u.for_item ORDER BY u.seq DESC) AS rn FROM (
           SELECT l.*, l.item_id AS for_item FROM project_change_log l WHERE l.tenant_id = ? AND l.project_id = ? AND l.item_id IN (?) ${below}
           UNION ALL
           SELECT l.*, l.related_item_id AS for_item FROM project_change_log l WHERE l.tenant_id = ? AND l.project_id = ? AND l.related_item_id IN (?) ${below}
         ) u
       ) ranked WHERE rn <= ? ORDER BY for_item, seq DESC`,
      [tenantId, projectId, ids, ...bound, tenantId, projectId, ids, ...bound, bounded + 1],
    );
    for (const itemId of ids) {
      const own = rows.filter((row) => row.for_item === itemId);
      result.set(itemId, { entries: own.slice(0, bounded).map(mapRow), latestSeq: beforeSeq ? null : own[0] ? Number(own[0].seq) : null, more: own.length > bounded });
    }
  };
  await ranked(items.filter((entry) => !entry.beforeSeq).map((entry) => entry.itemId));
  for (const entry of items.filter((candidate) => candidate.beforeSeq)) await ranked([entry.itemId], entry.beforeSeq);
  return result;
}

/** Deletes changes older than the retention period. Returns how many went. */
export async function purgeMysqlProjectChanges(executor, { days = CHANGE_LOG_RETENTION_DAYS } = {}) {
  const [result] = await executor.execute('DELETE FROM project_change_log WHERE created_at < NOW(3) - INTERVAL ? DAY', [days]);
  return Number(result.affectedRows ?? 0);
}

/** The same log in memory, for tests and the in-memory repositories. */
export function createInMemoryProjectChangeLog({ now = () => Date.now() } = {}) {
  const rows = [];
  let seq = 0;
  let floorSeq = 0;
  const copy = (row) => ({
    action: row.action, actorId: row.actorId, at: row.createdAt, detail: row.detail ? structuredClone(row.detail) : null, entityId: row.entityId,
    entityType: row.entityType, itemId: row.itemId, relatedItemId: row.relatedItemId, seq: row.seq, via: row.via,
  });
  return {
    append(entries) {
      for (const entry of entries.filter(Boolean)) {
        seq += 1;
        rows.push({ ...changeRow(entry, new Date(now()).toISOString()), seq });
      }
    },
    list({ afterSeq = 0, itemId = null, limit = 200, projectId, settleMs = 0, tenantId }) {
      const bounded = Math.max(1, Math.min(1000, Number(limit) || 200));
      const cutoff = now() - settleMs;
      const settledSeq = rows.filter((row) => Date.parse(row.createdAt) <= cutoff).at(-1)?.seq ?? 0;
      const after = rows.filter((row) => row.tenantId === tenantId && row.projectId === projectId && row.seq > afterSeq && row.seq <= settledSeq
        && (!itemId || row.itemId === itemId || row.relatedItemId === itemId));
      return {
        entries: after.slice(0, bounded).map(copy),
        floorSeq,
        more: after.length > bounded,
        settledSeq,
      };
    },
    // As listMysqlItemChanges.
    listItems({ items, limit = 10, projectId, tenantId }) {
      const bounded = Math.max(1, Math.min(100, Number(limit) || 10));
      const result = new Map();
      for (const { beforeSeq = null, itemId } of items) {
        const own = rows
          .filter((row) => row.tenantId === tenantId && row.projectId === projectId && (row.itemId === itemId || row.relatedItemId === itemId) && (!beforeSeq || row.seq < beforeSeq))
          .sort((left, right) => right.seq - left.seq);
        result.set(itemId, { entries: own.slice(0, bounded).map(copy), latestSeq: beforeSeq ? null : own[0]?.seq ?? null, more: own.length > bounded });
      }
      return result;
    },
    purge({ beforeSeq }) {
      const kept = rows.filter((row) => row.seq > beforeSeq);
      floorSeq = Math.max(floorSeq, beforeSeq);
      rows.splice(0, rows.length, ...kept);
    },
  };
}
