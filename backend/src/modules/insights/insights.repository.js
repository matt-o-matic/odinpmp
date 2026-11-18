// Insights storage: each project's dashboard layout, and a compact read of the project's item
// revisions (status, points, sprint and assignee before and after each change) for charts
// over time.
//
// 0073_project_insights_layouts, registered in src/jobs/bootstrap-schema.lib.js, creates the
// layout table. The migration runner checksums its body: never edit it; add a new migration
// instead.

import { HttpError } from '../../lib/errors/http-error.js';

export const MAX_HISTORY_EVENTS = 50_000;

const clone = (value) => structuredClone(value);

function layoutConflict(actualVersion, expectedVersion) {
  return new HttpError(409, 'The Insights layout changed since it was loaded. Reload and try again.', {
    details: { actualVersion, code: 'insights_layout_version_conflict', expectedVersion },
  });
}

function toIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function snapshotOf(snapshot) {
  if (!snapshot?.node) return null;
  return {
    assigneeId: snapshot.node.assigneeId ?? null,
    points: snapshot.node.points ?? null,
    sprintId: snapshot.node.sprintId ?? null,
    status: snapshot.node.status ?? null,
  };
}

/** Newest `limit` events, returned oldest first, with whether older ones were left out. */
function newestFirstWindow(events, limit) {
  const truncated = events.length > limit;
  return { events: truncated ? events.slice(events.length - limit) : events, truncated };
}

export function createInMemoryInsightsRepository({ projectRepository = null } = {}) {
  const layouts = new Map();
  const key = (tenantId, projectId) => `${tenantId}:${projectId}`;
  const projectRevisions = (projectId, tenantId) => (projectRepository?.state?.projectItemRevisions ?? [])
    .filter((revision) => revision.tenantId === tenantId && revision.projectId === projectId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));

  return {
    layouts,
    async getLayout({ projectId, tenantId }) {
      const record = layouts.get(key(tenantId, projectId));
      return record ? clone(record) : null;
    },
    async saveLayout({ cards, expectedVersion, projectId, tenantId, userId }) {
      const current = layouts.get(key(tenantId, projectId)) ?? null;
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) throw layoutConflict(actualVersion, expectedVersion);
      const now = new Date().toISOString();
      const record = { cards: clone(cards), createdAt: current?.createdAt ?? now, projectId, tenantId, updatedAt: now, updatedBy: userId, version: actualVersion + 1 };
      layouts.set(key(tenantId, projectId), record);
      return clone(record);
    },
    async deleteLayout({ expectedVersion, projectId, tenantId }) {
      const current = layouts.get(key(tenantId, projectId)) ?? null;
      if (!current) return false;
      if (current.version !== expectedVersion) throw layoutConflict(current.version, expectedVersion);
      layouts.delete(key(tenantId, projectId));
      return true;
    },
    async listItemHistory({ excludeItemIds = [], limit = MAX_HISTORY_EVENTS, projectId, since, tenantId }) {
      const excluded = new Set(excludeItemIds);
      const revisions = projectRevisions(projectId, tenantId).filter((revision) => !excluded.has(revision.itemId));
      const firstRecordedAt = revisions[0]?.createdAt ?? null;
      const inWindow = revisions
        .filter((revision) => String(revision.createdAt) >= since)
        .map((revision) => ({
          actorUserId: revision.actorUserId || null,
          after: snapshotOf(revision.after),
          at: revision.createdAt,
          before: snapshotOf(revision.before),
          itemId: revision.itemId,
          itemType: revision.itemType,
          parentId: revision.after?.parentId ?? revision.before?.parentId ?? null,
        }));
      return { firstRecordedAt, ...newestFirstWindow(inWindow, limit) };
    },
    async listTicketReviewStates({ projectId, tenantId }) {
      const latest = new Map();
      for (const revision of projectRevisions(projectId, tenantId)) {
        if (revision.itemType === 'ticket') latest.set(revision.itemId, (revision.after ?? revision.before)?.node?.externalReviewState ?? null);
      }
      return [...latest].map(([itemId, externalReviewState]) => ({ externalReviewState, itemId }));
    },
  };
}

// 0073_project_insights_layouts: one stored layout per project.
export async function ensureMysqlInsightsSchema(executor) {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS project_insights_layouts (
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      cards_json JSON NOT NULL,
      version INT NOT NULL DEFAULT 1,
      updated_by VARCHAR(128) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (tenant_id, project_id)
    )
  `);
}

function parseCards(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapLayout(row) {
  if (!row) return null;
  return {
    cards: parseCards(row.cards_json),
    createdAt: toIso(row.created_at),
    projectId: row.project_id,
    tenantId: row.tenant_id,
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
    version: Number(row.version),
  };
}

// JSON_UNQUOTE turns a JSON null into the string 'null'.
function jsonText(value) {
  if (value == null) return null;
  const text = String(value);
  return text === 'null' ? null : text;
}

function jsonNumber(value) {
  if (value == null || value === 'null') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapHistoryRow(row) {
  const side = (prefix, present) => (Number(present) ? {
    assigneeId: jsonText(row[`${prefix}_assignee_id`]),
    points: jsonNumber(row[`${prefix}_points`]),
    sprintId: jsonText(row[`${prefix}_sprint_id`]),
    status: jsonText(row[`${prefix}_status`]),
  } : null);
  return {
    actorUserId: row.actor_user_id || null,
    after: side('after', row.has_after),
    at: toIso(row.created_at),
    before: side('before', row.has_before),
    itemId: row.item_id,
    itemType: row.item_type,
    parentId: jsonText(row.parent_id),
  };
}

const HISTORY_COLUMNS = ['before', 'after'].map((side) => `
  ${side}_json IS NOT NULL AS has_${side},
  JSON_UNQUOTE(JSON_EXTRACT(${side}_json, '$.node.status')) AS ${side}_status,
  JSON_UNQUOTE(JSON_EXTRACT(${side}_json, '$.node.points')) AS ${side}_points,
  JSON_UNQUOTE(JSON_EXTRACT(${side}_json, '$.node.sprintId')) AS ${side}_sprint_id,
  JSON_UNQUOTE(JSON_EXTRACT(${side}_json, '$.node.assigneeId')) AS ${side}_assignee_id`).join(',');

export function createMysqlInsightsRepository({ pool }) {
  if (!pool) throw new Error('A MySQL pool is required to create the insights repository.');

  async function readLayout(projectId, tenantId) {
    const [rows] = await pool.execute(
      'SELECT * FROM project_insights_layouts WHERE tenant_id = ? AND project_id = ? LIMIT 1',
      [tenantId, projectId],
    );
    return mapLayout(rows[0]);
  }

  return {
    async getLayout({ projectId, tenantId }) {
      return readLayout(projectId, tenantId);
    },
    async saveLayout({ cards, expectedVersion, projectId, tenantId, userId }) {
      const cardsJson = JSON.stringify(cards);
      if (expectedVersion === 0) {
        try {
          await pool.execute(
            `INSERT INTO project_insights_layouts (tenant_id, project_id, cards_json, version, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, NOW(3), NOW(3))`,
            [tenantId, projectId, cardsJson, userId],
          );
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY') throw error;
          throw layoutConflict((await readLayout(projectId, tenantId))?.version ?? 1, expectedVersion);
        }
      } else {
        const [result] = await pool.execute(
          `UPDATE project_insights_layouts
           SET cards_json = ?, version = version + 1, updated_by = ?, updated_at = NOW(3)
           WHERE tenant_id = ? AND project_id = ? AND version = ?`,
          [cardsJson, userId, tenantId, projectId, expectedVersion],
        );
        if (Number(result?.affectedRows ?? 0) !== 1) throw layoutConflict((await readLayout(projectId, tenantId))?.version ?? 0, expectedVersion);
      }
      return readLayout(projectId, tenantId);
    },
    async deleteLayout({ expectedVersion, projectId, tenantId }) {
      const [result] = await pool.execute(
        'DELETE FROM project_insights_layouts WHERE tenant_id = ? AND project_id = ? AND version = ?',
        [tenantId, projectId, expectedVersion],
      );
      if (Number(result?.affectedRows ?? 0) === 1) return true;
      const current = await readLayout(projectId, tenantId);
      if (!current) return false;
      throw layoutConflict(current.version, expectedVersion);
    },
    async listItemHistory({ excludeItemIds = [], limit = MAX_HISTORY_EVENTS, projectId, since, tenantId }) {
      const boundedLimit = Math.max(1, Math.min(MAX_HISTORY_EVENTS, Math.trunc(Number(limit)) || MAX_HISTORY_EVENTS));
      const excluded = [...new Set(excludeItemIds)];
      const leaveOut = excluded.length ? ` AND item_id NOT IN (${excluded.map(() => '?').join(', ')})` : '';
      const [firstRows] = await pool.execute(
        `SELECT MIN(created_at) AS first_recorded_at FROM project_item_revisions WHERE tenant_id = ? AND project_id = ?${leaveOut}`,
        [tenantId, projectId, ...excluded],
      );
      // Newest first so a cap keeps the recent end, which backwards replay needs most.
      const [rows] = await pool.execute(
        `SELECT id, item_id, item_type, actor_user_id, created_at,${HISTORY_COLUMNS},
           JSON_UNQUOTE(COALESCE(JSON_EXTRACT(after_json, '$.parentId'), JSON_EXTRACT(before_json, '$.parentId'))) AS parent_id
         FROM project_item_revisions
         WHERE tenant_id = ? AND project_id = ? AND created_at >= ?${leaveOut}
         ORDER BY created_at DESC, id DESC
         LIMIT ${boundedLimit + 1}`,
        [tenantId, projectId, new Date(since), ...excluded],
      );
      const truncated = rows.length > boundedLimit;
      return {
        events: rows.slice(0, boundedLimit).reverse().map(mapHistoryRow),
        firstRecordedAt: toIso(firstRows[0]?.first_recorded_at),
        truncated,
      };
    },
    // A delete revision has no after side, so the before side holds the ticket as it was deleted.
    async listTicketReviewStates({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT item_id, review_state FROM (
           SELECT item_id,
             JSON_UNQUOTE(JSON_EXTRACT(COALESCE(after_json, before_json), '$.node.externalReviewState')) AS review_state,
             ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY created_at DESC, id DESC) AS position
           FROM project_item_revisions
           WHERE tenant_id = ? AND project_id = ? AND item_type = 'ticket'
         ) latest
         WHERE position = 1`,
        [tenantId, projectId],
      );
      return rows.map((row) => ({ externalReviewState: jsonText(row.review_state), itemId: row.item_id }));
    },
  };
}
