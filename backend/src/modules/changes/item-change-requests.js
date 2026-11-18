// Idempotency keys for odin_apply_item_changes (docs/mcp-change-feed/plan.md). Each change an
// agent sends carries a key. The first request with a key claims it, applies the change and
// stores the result; a retry with the same key and the same change gets that result back and
// changes nothing. Keys belong to the person (or connection's user) who sent them and are kept 30
// days. A claim whose request died before storing its result stays pending; after
// STALE_CLAIM_MS a retry may take it over, once the change log shows the change never landed.

export const ITEM_CHANGE_REQUEST_RETENTION_DAYS = 30;
export const STALE_CLAIM_MS = 120_000;

export async function ensureMysqlItemChangeRequestsSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS item_change_requests (
    tenant_id VARCHAR(36) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    project_id VARCHAR(36) NOT NULL,
    item_id VARCHAR(36) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    result_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, actor_id, idempotency_key),
    KEY idx_item_change_requests_created (created_at)
  )`);
}

const parse = (value) => {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

function mapRow(row) {
  return {
    itemId: row.item_id,
    projectId: row.project_id,
    requestHash: row.request_hash,
    result: parse(row.result_json),
    status: row.status,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createMysqlItemChangeRequests(pool) {
  const store = {
    /** Claims a key: { claimed: true }, or { claimed: false, record } when someone already has it. */
    async claim({ actorId, itemId, key, projectId, requestHash, tenantId }) {
      const [result] = await pool.execute(
        `INSERT IGNORE INTO item_change_requests (tenant_id, actor_id, idempotency_key, project_id, item_id, request_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW(3), NOW(3))`,
        [tenantId, actorId, key, projectId, itemId, requestHash],
      );
      if (Number(result.affectedRows) === 1) return { claimed: true };
      const [rows] = await pool.execute('SELECT * FROM item_change_requests WHERE tenant_id = ? AND actor_id = ? AND idempotency_key = ?', [tenantId, actorId, key]);
      // Purged between the insert and the read: claim it again.
      if (!rows[0]) return store.claim({ actorId, itemId, key, projectId, requestHash, tenantId });
      return { claimed: false, record: mapRow(rows[0]) };
    },
    /** Takes over a pending claim no one has touched for STALE_CLAIM_MS. True when this caller now holds it. */
    async takeOver({ actorId, key, tenantId }) {
      const [result] = await pool.execute(
        `UPDATE item_change_requests SET updated_at = NOW(3)
         WHERE tenant_id = ? AND actor_id = ? AND idempotency_key = ? AND status = 'pending' AND updated_at < NOW(3) - INTERVAL ? MICROSECOND`,
        [tenantId, actorId, key, STALE_CLAIM_MS * 1000],
      );
      return Number(result.affectedRows) === 1;
    },
    async finish({ actorId, key, result, tenantId }) {
      await pool.execute(
        "UPDATE item_change_requests SET status = 'done', result_json = ?, updated_at = NOW(3) WHERE tenant_id = ? AND actor_id = ? AND idempotency_key = ?",
        [JSON.stringify(result), tenantId, actorId, key],
      );
    },
    /** Gives a key back when nothing was written, so a retry can try again. */
    async release({ actorId, key, tenantId }) {
      await pool.execute("DELETE FROM item_change_requests WHERE tenant_id = ? AND actor_id = ? AND idempotency_key = ? AND status = 'pending'", [tenantId, actorId, key]);
    },
  };
  return store;
}

/** Deletes keys older than the retention period. Returns how many went. */
export async function purgeMysqlItemChangeRequests(executor, { days = ITEM_CHANGE_REQUEST_RETENTION_DAYS } = {}) {
  const [result] = await executor.execute('DELETE FROM item_change_requests WHERE created_at < NOW(3) - INTERVAL ? DAY', [days]);
  return Number(result.affectedRows ?? 0);
}

/** The same store in memory, for tests and the in-memory repositories. */
export function createInMemoryItemChangeRequests({ now = () => Date.now() } = {}) {
  const records = new Map();
  const keyOf = ({ actorId, key, tenantId }) => `${tenantId}\u0000${actorId}\u0000${key}`;
  return {
    async claim(input) {
      const existing = records.get(keyOf(input));
      if (existing) return { claimed: false, record: structuredClone(existing) };
      records.set(keyOf(input), { itemId: input.itemId, projectId: input.projectId, requestHash: input.requestHash, result: null, status: 'pending', updatedAt: new Date(now()).toISOString() });
      return { claimed: true };
    },
    async takeOver(input) {
      const record = records.get(keyOf(input));
      if (!record || record.status !== 'pending' || Date.parse(record.updatedAt) >= now() - STALE_CLAIM_MS) return false;
      record.updatedAt = new Date(now()).toISOString();
      return true;
    },
    async finish(input) {
      const record = records.get(keyOf(input));
      if (record) Object.assign(record, { result: structuredClone(input.result), status: 'done', updatedAt: new Date(now()).toISOString() });
    },
    async release(input) {
      if (records.get(keyOf(input))?.status === 'pending') records.delete(keyOf(input));
    },
  };
}
