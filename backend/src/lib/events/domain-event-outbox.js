import { randomUUID } from 'node:crypto';

function clone(value) { return structuredClone(value); }
function iso(value = new Date()) { return new Date(value).toISOString(); }
function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapMysqlEvent(row) {
  return {
    attempts: Number(row.attempts),
    availableAt: iso(row.available_at),
    createdAt: iso(row.created_at),
    eventType: row.event_type,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    lastError: row.last_error ?? '',
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    leaseToken: row.lease_token ?? null,
    payload: parseJson(row.payload_json),
    processedAt: row.processed_at ? iso(row.processed_at) : null,
    projectId: row.project_id ?? null,
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: iso(row.updated_at),
  };
}

export async function ensureMysqlDomainEventOutboxSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS domain_event_outbox (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(36) NULL,
    event_type VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    payload_json JSON NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    available_at DATETIME(3) NOT NULL,
    lease_token VARCHAR(36) NULL,
    lease_expires_at DATETIME(3) NULL,
    processed_at DATETIME(3) NULL,
    last_error TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_domain_event_idempotency (tenant_id, idempotency_key),
    KEY idx_domain_event_claim (status, available_at, lease_expires_at),
    KEY idx_domain_event_project (tenant_id, project_id, created_at)
  )`);
}

export function createInMemoryDomainEventOutboxRepository() {
  const events = new Map();
  const byIdempotencyKey = new Map();
  return {
    state: { events },
    async enqueue({ eventType, idempotencyKey, payload = {}, projectId = null, tenantId }) {
      const key = `${tenantId}:${idempotencyKey}`;
      const existingId = byIdempotencyKey.get(key);
      if (existingId) return { created: false, event: clone(events.get(existingId)) };
      const now = iso();
      const event = {
        attempts: 0, availableAt: now, createdAt: now, eventType, id: randomUUID(), idempotencyKey,
        lastError: '', leaseExpiresAt: null, leaseToken: null, payload: clone(payload), processedAt: null,
        projectId, status: 'pending', tenantId, updatedAt: now,
      };
      events.set(event.id, event); byIdempotencyKey.set(key, event.id);
      return { created: true, event: clone(event) };
    },
    async claim({ leaseMs = 30_000, limit = 20, now = new Date() } = {}) {
      const claimed = [];
      const nowMs = now.getTime();
      for (const event of events.values()) {
        const expiredLease = event.status === 'processing' && new Date(event.leaseExpiresAt).getTime() <= nowMs;
        if (claimed.length >= limit || (event.status !== 'pending' && !expiredLease) || new Date(event.availableAt).getTime() > nowMs) continue;
        event.attempts += 1; event.leaseToken = randomUUID(); event.leaseExpiresAt = iso(nowMs + leaseMs); event.status = 'processing'; event.updatedAt = iso(now);
        claimed.push(clone(event));
      }
      return claimed;
    },
    async complete({ eventId, leaseToken, now = new Date() }) {
      const event = events.get(eventId);
      if (!event || event.status !== 'processing' || event.leaseToken !== leaseToken) return false;
      event.status = 'processed'; event.processedAt = iso(now); event.leaseToken = null; event.leaseExpiresAt = null; event.updatedAt = iso(now);
      return true;
    },
    async fail({ availableAt, error, eventId, leaseToken, maxAttempts = 5, now = new Date() }) {
      const event = events.get(eventId);
      if (!event || event.status !== 'processing' || event.leaseToken !== leaseToken) return false;
      event.status = event.attempts >= maxAttempts ? 'dead' : 'pending'; event.availableAt = iso(availableAt); event.lastError = String(error ?? '').slice(0, 4000); event.leaseToken = null; event.leaseExpiresAt = null; event.updatedAt = iso(now);
      return true;
    },
    async list() { return [...events.values()].map(clone); },
  };
}

export function createMysqlDomainEventOutboxRepository({ pool }) {
  const buildRepository = (executor, { canClaim = true } = {}) => ({
    async enqueue({ eventType, idempotencyKey, payload = {}, projectId = null, tenantId }) {
      const id = randomUUID(); const now = new Date();
      const [result] = await executor.execute(
        `INSERT IGNORE INTO domain_event_outbox (id, tenant_id, project_id, event_type, idempotency_key, payload_json, status, attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        [id, tenantId, projectId, eventType, idempotencyKey, JSON.stringify(payload), now, now, now],
      );
      const [rows] = await executor.execute('SELECT * FROM domain_event_outbox WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1', [tenantId, idempotencyKey]);
      return { created: Number(result.affectedRows) === 1, event: mapMysqlEvent(rows[0]) };
    },
    async claim({ leaseMs = 30_000, limit = 20, now = new Date() } = {}) {
      if (!canClaim) throw new Error('Domain events cannot be claimed from a transaction-scoped repository.');
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
        const [rows] = await connection.execute(
          `SELECT * FROM domain_event_outbox
           WHERE available_at <= ? AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?))
           ORDER BY created_at, id LIMIT ${boundedLimit} FOR UPDATE SKIP LOCKED`,
          [now, now],
        );
        const claimed = [];
        for (const row of rows) {
          const leaseToken = randomUUID(); const leaseExpiresAt = new Date(now.getTime() + leaseMs);
          await connection.execute(
            `UPDATE domain_event_outbox SET status = 'processing', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`,
            [leaseToken, leaseExpiresAt, now, row.id],
          );
          claimed.push(mapMysqlEvent({ ...row, attempts: Number(row.attempts) + 1, lease_expires_at: leaseExpiresAt, lease_token: leaseToken, status: 'processing', updated_at: now }));
        }
        await connection.commit(); return claimed;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async complete({ eventId, leaseToken, now = new Date() }) {
      const [result] = await executor.execute(
        `UPDATE domain_event_outbox SET status = 'processed', processed_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'processing' AND lease_token = ?`,
        [now, now, eventId, leaseToken],
      );
      return Number(result.affectedRows) === 1;
    },
    async fail({ availableAt, error, eventId, leaseToken, maxAttempts = 5, now = new Date() }) {
      const [result] = await executor.execute(
        `UPDATE domain_event_outbox SET status = IF(attempts >= ?, 'dead', 'pending'), available_at = ?, last_error = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'processing' AND lease_token = ?`,
        [maxAttempts, availableAt, String(error ?? '').slice(0, 4000), now, eventId, leaseToken],
      );
      return Number(result.affectedRows) === 1;
    },
    async list() { const [rows] = await executor.execute('SELECT * FROM domain_event_outbox ORDER BY created_at, id'); return rows.map(mapMysqlEvent); },
    withExecutor(nextExecutor) { return buildRepository(nextExecutor, { canClaim: false }); },
  });
  return buildRepository(pool);
}

export async function dispatchDomainEventOutbox({ handlers, leaseMs = 30_000, limit = 20, maxAttempts = 5, now = new Date(), repository }) {
  const events = await repository.claim({ leaseMs, limit, now });
  const results = [];
  for (const event of events) {
    try {
      const handler = handlers?.[event.eventType];
      if (typeof handler !== 'function') throw new Error(`No domain event handler is registered for ${event.eventType}.`);
      await handler(event);
      await repository.complete({ eventId: event.id, leaseToken: event.leaseToken, now });
      results.push({ eventId: event.id, status: 'processed' });
    } catch (error) {
      const retryDelayMs = Math.min(60_000, 1000 * (2 ** Math.max(0, event.attempts - 1)));
      await repository.fail({ availableAt: new Date(now.getTime() + retryDelayMs), error: error?.message ?? error, eventId: event.id, leaseToken: event.leaseToken, maxAttempts, now });
      results.push({ error: error?.message ?? String(error), eventId: event.id, status: event.attempts >= maxAttempts ? 'dead' : 'retry' });
    }
  }
  return results;
}
