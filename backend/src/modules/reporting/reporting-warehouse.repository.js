import { randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);
const iso = (value = new Date()) => new Date(value).toISOString();

function mapSubscription(row) {
  return {
    createdAt: iso(row.created_at),
    deliveryChannel: row.delivery_channel,
    enabled: Boolean(row.enabled),
    format: row.format,
    id: row.id,
    lastRunAt: row.last_run_at ? iso(row.last_run_at) : null,
    nextRunAt: iso(row.next_run_at),
    ownerUserId: row.owner_user_id,
    recipients: typeof row.recipients_json === 'string' ? JSON.parse(row.recipients_json) : row.recipients_json,
    reportId: row.report_id,
    schedule: typeof row.schedule_json === 'string' ? JSON.parse(row.schedule_json) : row.schedule_json,
    tenantId: row.tenant_id,
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export async function ensureMysqlReportingWarehouseSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS reporting_cdc_events (
    sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_event_id VARCHAR(128) NOT NULL,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NULL,
    event_type VARCHAR(128) NOT NULL,
    payload_json JSON NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    processed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_reporting_cdc_source (source_event_id),
    KEY idx_reporting_cdc_pending (processed_at, sequence_id),
    KEY idx_reporting_cdc_tenant (tenant_id, sequence_id)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS reporting_metric_facts (
    tenant_id VARCHAR(36) NOT NULL,
    project_scope VARCHAR(128) NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    metric_date DATE NOT NULL,
    occurrence_count BIGINT UNSIGNED NOT NULL,
    last_sequence_id BIGINT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, project_scope, event_type, metric_date),
    KEY idx_reporting_facts_tenant_date (tenant_id, metric_date, event_type)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS reporting_cache_entries (
    tenant_id VARCHAR(36) NOT NULL,
    cache_key CHAR(64) NOT NULL,
    source_sequence_id BIGINT UNSIGNED NOT NULL,
    value_json JSON NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, cache_key),
    KEY idx_reporting_cache_expiry (expires_at)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS report_subscription_leases (
    subscription_id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    lease_token VARCHAR(36) NULL,
    lease_expires_at DATETIME(3) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
    scheduled_for DATETIME(3) NULL,
    updated_at DATETIME(3) NOT NULL,
    KEY idx_report_subscription_lease (lease_expires_at, tenant_id)
  )`);
  for (const [column, definition] of [
    ['source_hash', 'CHAR(64) NULL'], ['index_generation', 'VARCHAR(36) NULL'], ['embedding_model', 'VARCHAR(128) NULL'], ['embedding_dimensions', 'SMALLINT UNSIGNED NULL'], ['embedding_vector_json', 'JSON NULL'], ['embedding_content_hash', 'CHAR(64) NULL'], ['embedded_at', 'DATETIME(3) NULL'],
  ]) {
    const [rows] = await executor.execute(`SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'search_documents' AND COLUMN_NAME = ?`, [column]);
    if (Number(rows[0]?.count ?? 0) === 0) await executor.execute(`ALTER TABLE search_documents ADD COLUMN ${column} ${definition}`);
  }
}

export function createInMemoryReportingWarehouseRepository() {
  const state = { cache: new Map(), events: [], facts: new Map(), leases: new Map(), sequence: 0 };
  return {
    warehouseState: state,
    async captureWarehouseChange({ event }) {
      const existing = state.events.find((item) => item.sourceEventId === event.id);
      if (existing) return { created: false, sequenceId: existing.sequenceId };
      const record = { createdAt: iso(), eventType: event.eventType, occurredAt: iso(event.createdAt), payload: clone(event.payload ?? {}), processedAt: null, projectId: event.projectId ?? null, sequenceId: ++state.sequence, sourceEventId: event.id, tenantId: event.tenantId };
      state.events.push(record);
      for (const [key, value] of state.cache) if (value.tenantId === event.tenantId) state.cache.delete(key);
      return { created: true, sequenceId: record.sequenceId };
    },
    async claimDueSubscriptions({ leaseMs = 60_000, limit = 50, now = new Date(), subscriptions }) {
      const claimed = [];
      for (const subscription of subscriptions.filter((item) => item.enabled && Date.parse(item.nextRunAt) <= now.getTime()).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))) {
        if (claimed.length >= limit) break;
        const current = state.leases.get(subscription.id);
        if (current?.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > now.getTime()) continue;
        const lease = { fencingToken: Number(current?.fencingToken ?? 0) + 1, leaseExpiresAt: iso(new Date(now.getTime() + leaseMs)), leaseToken: randomUUID(), scheduledFor: subscription.nextRunAt };
        state.leases.set(subscription.id, lease); claimed.push({ ...clone(subscription), ...lease });
      }
      return claimed;
    },
    async completeSubscriptionClaim({ leaseToken, subscriptionId }) { const lease = state.leases.get(subscriptionId); if (!lease || lease.leaseToken !== leaseToken) return false; state.leases.delete(subscriptionId); return true; },
    // `since` (YYYY-MM-DD) limits the facts to recent days; Home reads 30 of them.
    async getReportingAnalytics({ projectIds = [], since = null, tenantId }) {
      const allowed = new Set(projectIds); return [...state.facts.values()].filter((item) => item.tenantId === tenantId && (!item.projectId || allowed.has(item.projectId)) && (!since || item.metricDate >= since)).sort((a, b) => a.metricDate.localeCompare(b.metricDate));
    },
    async getWarehouseSequence({ tenantId }) { return Math.max(0, ...state.events.filter((item) => item.tenantId === tenantId).map((item) => item.sequenceId)); },
    async getWarehouseCheckpoint({ tenantId }) { return Math.max(0, ...state.events.filter((item) => item.tenantId === tenantId && item.processedAt).map((item) => item.sequenceId)); },
    async readReportingCache({ cacheKey, now = new Date(), sourceSequenceId, tenantId }) { const item = state.cache.get(`${tenantId}:${cacheKey}`); return item && item.sourceSequenceId === sourceSequenceId && Date.parse(item.expiresAt) > now.getTime() ? clone(item.value) : null; },
    async writeReportingCache({ cacheKey, sourceSequenceId, tenantId, ttlMs = 30_000, value }) { state.cache.set(`${tenantId}:${cacheKey}`, { expiresAt: iso(new Date(Date.now() + ttlMs)), sourceSequenceId, tenantId, value: clone(value) }); return true; },
    async materializeWarehouseChanges({ limit = 500 } = {}) {
      const pending = state.events.filter((item) => !item.processedAt).slice(0, limit);
      for (const event of pending) {
        const metricDate = event.occurredAt.slice(0, 10); const projectScope = event.projectId ?? ''; const key = `${event.tenantId}:${projectScope}:${event.eventType}:${metricDate}`; const current = state.facts.get(key);
        state.facts.set(key, { eventType: event.eventType, lastSequenceId: event.sequenceId, metricDate, occurrenceCount: Number(current?.occurrenceCount ?? 0) + 1, projectId: event.projectId, tenantId: event.tenantId, updatedAt: iso() }); event.processedAt = iso();
      }
      return { lastSequenceId: pending.at(-1)?.sequenceId ?? null, processed: pending.length };
    },
  };
}

export function createMysqlReportingWarehouseRepository({ pool }) {
  return {
    async captureWarehouseChange({ event }) {
      const [result] = await pool.execute(`INSERT IGNORE INTO reporting_cdc_events
        (source_event_id, tenant_id, project_id, event_type, payload_json, occurred_at, processed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NOW(3))`, [event.id, event.tenantId, event.projectId ?? null, event.eventType, JSON.stringify(event.payload ?? {}), new Date(event.createdAt)]);
      const [rows] = await pool.execute('SELECT sequence_id FROM reporting_cdc_events WHERE source_event_id = ? LIMIT 1', [event.id]);
      if (Number(result.affectedRows) === 1) await pool.execute('DELETE FROM reporting_cache_entries WHERE tenant_id = ?', [event.tenantId]);
      return { created: Number(result.affectedRows) === 1, sequenceId: Number(rows[0].sequence_id) };
    },
    async claimDueSubscriptions({ leaseMs = 60_000, limit = 50, now = new Date() }) {
      const bounded = Math.max(1, Math.min(100, Number(limit) || 50)); const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(`SELECT s.* FROM report_subscriptions s
          LEFT JOIN report_subscription_leases l ON l.subscription_id = s.id
          WHERE s.enabled = 1 AND s.next_run_at <= ? AND (l.lease_expires_at IS NULL OR l.lease_expires_at <= ?)
          ORDER BY s.next_run_at, s.id LIMIT ${bounded} FOR UPDATE SKIP LOCKED`, [now, now]);
        const claimed = [];
        for (const row of rows) {
          const leaseToken = randomUUID(); const leaseExpiresAt = new Date(now.getTime() + leaseMs);
          await connection.execute(`INSERT INTO report_subscription_leases
            (subscription_id, tenant_id, lease_token, lease_expires_at, fencing_token, scheduled_for, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?) ON DUPLICATE KEY UPDATE lease_token = VALUES(lease_token), lease_expires_at = VALUES(lease_expires_at), fencing_token = fencing_token + 1, scheduled_for = VALUES(scheduled_for), updated_at = VALUES(updated_at)`, [row.id, row.tenant_id, leaseToken, leaseExpiresAt, row.next_run_at, now]);
          const [leaseRows] = await connection.execute('SELECT fencing_token FROM report_subscription_leases WHERE subscription_id = ? LIMIT 1', [row.id]);
          claimed.push({ ...mapSubscription(row), fencingToken: Number(leaseRows[0].fencing_token), leaseExpiresAt: iso(leaseExpiresAt), leaseToken, scheduledFor: iso(row.next_run_at) });
        }
        await connection.commit(); return claimed;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async completeSubscriptionClaim({ lastRunAt, leaseToken, nextRunAt, subscriptionId, tenantId }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [leaseRows] = await connection.execute('SELECT lease_token FROM report_subscription_leases WHERE subscription_id = ? AND tenant_id = ? FOR UPDATE', [subscriptionId, tenantId]);
        if (leaseRows[0]?.lease_token !== leaseToken) { await connection.rollback(); return false; }
        const [result] = await connection.execute('UPDATE report_subscriptions SET last_run_at = ?, next_run_at = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ?', [lastRunAt, nextRunAt, subscriptionId, tenantId]);
        await connection.execute('DELETE FROM report_subscription_leases WHERE subscription_id = ? AND lease_token = ?', [subscriptionId, leaseToken]);
        await connection.commit(); return Number(result.affectedRows) === 1;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async getReportingAnalytics({ projectIds = [], since = null, tenantId }) {
      const conditions = ['tenant_id = ?', '(project_scope = ?']; const params = [tenantId, ''];
      if (projectIds.length) { conditions[1] += ` OR project_scope IN (${projectIds.map(() => '?').join(',')})`; params.push(...projectIds); } conditions[1] += ')';
      if (since) { conditions.push('metric_date >= ?'); params.push(since); }
      const [rows] = await pool.execute(`SELECT * FROM reporting_metric_facts WHERE ${conditions.join(' AND ')} ORDER BY metric_date, event_type, project_scope`, params);
      return rows.map((row) => ({ eventType: row.event_type, lastSequenceId: Number(row.last_sequence_id), metricDate: String(row.metric_date).slice(0, 10), occurrenceCount: Number(row.occurrence_count), projectId: row.project_scope || null, tenantId: row.tenant_id, updatedAt: iso(row.updated_at) }));
    },
    async getWarehouseSequence({ tenantId }) { const [rows] = await pool.execute('SELECT COALESCE(MAX(sequence_id), 0) AS sequence_id FROM reporting_cdc_events WHERE tenant_id = ?', [tenantId]); return Number(rows[0].sequence_id); },
    async getWarehouseCheckpoint({ tenantId }) { const [rows] = await pool.execute('SELECT COALESCE(MAX(sequence_id), 0) AS sequence_id FROM reporting_cdc_events WHERE tenant_id = ? AND processed_at IS NOT NULL', [tenantId]); return Number(rows[0].sequence_id); },
    async readReportingCache({ cacheKey, now = new Date(), sourceSequenceId, tenantId }) { const [rows] = await pool.execute('SELECT value_json FROM reporting_cache_entries WHERE tenant_id = ? AND cache_key = ? AND source_sequence_id = ? AND expires_at > ? LIMIT 1', [tenantId, cacheKey, sourceSequenceId, now]); const value = rows[0]?.value_json; return value == null ? null : typeof value === 'string' ? JSON.parse(value) : value; },
    async writeReportingCache({ cacheKey, sourceSequenceId, tenantId, ttlMs = 30_000, value }) { const expiresAt = new Date(Date.now() + ttlMs); await pool.execute(`INSERT INTO reporting_cache_entries (tenant_id, cache_key, source_sequence_id, value_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE source_sequence_id = VALUES(source_sequence_id), value_json = VALUES(value_json), expires_at = VALUES(expires_at), created_at = VALUES(created_at)`, [tenantId, cacheKey, sourceSequenceId, JSON.stringify(value), expiresAt]); return true; },
    async materializeWarehouseChanges({ limit = 500, now = new Date() } = {}) {
      const bounded = Math.max(1, Math.min(5000, Number(limit) || 500)); const connection = await pool.getConnection();
      try {
        await connection.beginTransaction(); const [rows] = await connection.execute(`SELECT * FROM reporting_cdc_events WHERE processed_at IS NULL ORDER BY sequence_id LIMIT ${bounded} FOR UPDATE SKIP LOCKED`); const aggregates = new Map();
        for (const row of rows) { const metricDate = new Date(row.occurred_at).toISOString().slice(0, 10); const key = `${row.tenant_id}\u0000${row.project_id ?? ''}\u0000${row.event_type}\u0000${metricDate}`; const item = aggregates.get(key) ?? { count: 0, eventType: row.event_type, lastSequenceId: 0, metricDate, projectScope: row.project_id ?? '', tenantId: row.tenant_id }; item.count += 1; item.lastSequenceId = Math.max(item.lastSequenceId, Number(row.sequence_id)); aggregates.set(key, item); }
        for (const item of [...aggregates.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value)) await connection.execute(`INSERT INTO reporting_metric_facts
          (tenant_id, project_scope, event_type, metric_date, occurrence_count, last_sequence_id, updated_at)
          VALUES (?, ?, ?, DATE(?), ?, ?, ?) ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + VALUES(occurrence_count), last_sequence_id = GREATEST(last_sequence_id, VALUES(last_sequence_id)), updated_at = VALUES(updated_at)`, [item.tenantId, item.projectScope, item.eventType, item.metricDate, item.count, item.lastSequenceId, now]);
        if (rows.length) await connection.execute(`UPDATE reporting_cdc_events SET processed_at = ? WHERE sequence_id IN (${rows.map(() => '?').join(',')}) AND processed_at IS NULL`, [now, ...rows.map((row) => row.sequence_id)]);
        await connection.commit(); return { lastSequenceId: rows.length ? Number(rows.at(-1).sequence_id) : null, processed: rows.length };
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
  };
}
