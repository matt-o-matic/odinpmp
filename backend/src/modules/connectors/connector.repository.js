import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

const clone = (value) => structuredClone(value);
const iso = (value = new Date()) => new Date(value).toISOString();
function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
const concurrentSchemaConflictCodes = new Set(['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME']);
async function executeIdempotentSchemaChange(executor, statement) {
  try {
    await executor.execute(statement);
  } catch (error) {
    if (!concurrentSchemaConflictCodes.has(error?.code)) throw error;
  }
}
function conflict(record, expectedVersion) {
  throw new HttpError(409, 'Connector record changed since it was loaded.', {
    details: {
      actualVersion: record.version,
      code: 'connector_version_conflict',
      expectedVersion,
    },
  });
}
function publicConnection(record) {
  if (!record) return record;
  const { inboundSecretHash: _hash, ...value } = record;
  return clone(value);
}

function connectionAllowedByPolicy(connection, policy) {
  if (!policy) return true;
  return Boolean(
    policy.enabled &&
      policy.allowedAuthTypes.includes(connection.authType) &&
      policy.allowedDirections.includes(connection.syncDirection) &&
      (policy.outboundEnabled || connection.syncDirection === 'inbound') &&
      connection.projectIds.length <= policy.maxProjects &&
      (!policy.allowedScopes.length ||
        connection.scopes.every((scope) => policy.allowedScopes.includes(scope))) &&
      (!policy.approvalRequired || connection.approvedAt),
  );
}
function connectionAllowedForLifecycle(connection, policy) { return !policy || Boolean(policy.enabled && policy.allowedAuthTypes.includes(connection.authType) && connection.projectIds.length <= policy.maxProjects && (!policy.approvalRequired || connection.approvedAt)); }

function mappingConflict() {
  throw new HttpError(
    409,
    'This external object already has an Odin mapping.',
    {
      details: { code: 'connector_mapping_conflict' },
    },
  );
}

export function createInMemoryConnectorRepository() {
  const state = {
    conflicts: new Map(),
    connections: new Map(),
    credentials: new Map(),
    events: new Map(),
    erasures: new Map(),
    mappings: new Map(),
    objects: new Map(),
    oauthTransactions: new Map(),
    postings: new Map(),
    policies: new Map(),
    runs: new Map(),
  };
  function create(collection, input, tenantId) {
    const now = iso();
    const record = {
      ...clone(input),
      createdAt: now,
      id: randomUUID(),
      tenantId,
      updatedAt: now,
      version: 1,
    };
    collection.set(record.id, record);
    return clone(record);
  }
  function update(collection, id, input, tenantId) {
    const record = collection.get(id);
    if (!record || record.tenantId !== tenantId) return null;
    if (record.version !== input.expectedVersion)
      conflict(record, input.expectedVersion);
    const { expectedVersion: _version, ...changes } = input;
    Object.assign(record, clone(changes), {
      updatedAt: iso(),
      version: record.version + 1,
    });
    return clone(record);
  }
  const list = (collection, tenantId) =>
    [...collection.values()]
      .filter((item) => item.tenantId === tenantId)
      .map(clone);
  return {
    state,
    authenticateInbound: async ({ connectionId, secretHash }) => {
      const record = state.connections.get(connectionId);
      const policy = [...state.policies.values()].find(
        (item) =>
          item.tenantId === record?.tenantId && item.provider === record?.provider,
      );
      return record?.status === 'active' &&
        record.inboundSecretHash === secretHash &&
        connectionAllowedByPolicy(record, policy)
        ? publicConnection(record)
        : null;
    },
    createConnection: async ({ inboundSecretHash, input, tenantId, userId }) =>
      publicConnection(
        create(
          state.connections,
          {
            ...input,
            approvedAt: null,
            approvedBy: null,
            cursor: null,
            inboundSecretHash,
            lastFailureAt: null,
            lastSuccessAt: null,
            userId,
          },
          tenantId,
        ),
      ),
    createConflict: async ({ input, tenantId }) =>
      create(
        state.conflicts,
        {
          ...input,
          resolution: null,
          resolvedAt: null,
          resolvedBy: null,
          status: 'open',
        },
        tenantId,
      ),
    createProviderPolicy: async ({ input, tenantId, userId }) => {
      const existing = [...state.policies.values()].find(
        (item) => item.tenantId === tenantId && item.provider === input.provider,
      );
      if (existing)
        throw new HttpError(409, 'A connector provider policy already exists.');
      return create(state.policies, { ...input, createdBy: userId }, tenantId);
    },
    createMapping: async ({ input, tenantId }) => {
      const existing = [...state.mappings.values()].find(
        (item) =>
          item.connectionId === input.connectionId &&
          item.externalId === input.externalId &&
          item.objectType === input.objectType,
      );
      if (existing) mappingConflict();
      return create(state.mappings, input, tenantId);
    },
    async createSyncRun({ connectionId, direction, idempotencyKey, tenantId }) {
      const existing = [...state.runs.values()].find(
        (item) =>
          item.connectionId === connectionId &&
          item.idempotencyKey === idempotencyKey &&
          item.tenantId === tenantId,
      );
      return existing
        ? { duplicate: true, run: clone(existing) }
        : {
            duplicate: false,
            run: create(
              state.runs,
              {
                attempts: 0,
                availableAt: iso(),
                completedAt: null,
                connectionId,
                counts: {},
                cursorAfter: null,
                cursorBefore:
                  state.connections.get(connectionId)?.cursor ?? null,
                direction,
                error: '',
                idempotencyKey,
                leaseExpiresAt: null,
                leaseToken: null,
                leaseWorkerId: null,
                startedAt: iso(),
                status: 'pending',
              },
              tenantId,
            ),
          };
    },
    async recordInboundEvent({
      connection,
      eventId,
      eventType,
      payload,
      payloadHash,
    }) {
      const existing = [...state.events.values()].find(
        (item) =>
          item.connectionId === connection.id &&
          item.externalEventId === eventId,
      );
      if (existing) return { duplicate: true, event: clone(existing) };
      return {
        duplicate: false,
        event: create(
          state.events,
          {
            attempts: 0,
            availableAt: iso(),
            connectionId: connection.id,
            error: '',
            eventType,
            externalEventId: eventId,
            leaseExpiresAt: null,
            leaseToken: null,
            leaseWorkerId: null,
            payload,
            payloadHash,
            processedAt: null,
            status: 'pending',
          },
          connection.tenantId,
        ),
      };
    },
    async listSnapshot({ tenantId }) {
      return {
        conflicts: list(state.conflicts, tenantId),
        connections: list(state.connections, tenantId).map(publicConnection),
        events: list(state.events, tenantId),
        erasures: list(state.erasures, tenantId),
        mappings: list(state.mappings, tenantId),
        policies: list(state.policies, tenantId),
        postings: list(state.postings, tenantId),
        runs: list(state.runs, tenantId),
      };
    },
    async createErpPosting({ connectionId, financialEntry, idempotencyKey, tenantId, userId }) {
      const existing = [...state.postings.values()].find((item) => item.connectionId === connectionId && item.financialEntryId === financialEntry.id);
      if (existing) return { duplicate: true, posting: clone(existing) };
      return { duplicate: false, posting: create(state.postings, { attempts: 0, availableAt: iso(), connectionId, createdBy: userId, error: '', externalId: null, financialEntryId: financialEntry.id, financialEntryVersion: financialEntry.version, idempotencyKey, leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, reconciliation: null, reconciledAt: null, status: 'pending' }, tenantId) };
    },
    async claimErpPostings({ leaseMs = 30_000, limit = 20, now = new Date(), workerId }) {
      const claimed = []; for (const posting of state.postings.values()) { const connection = state.connections.get(posting.connectionId); const policy = [...state.policies.values()].find((item) => item.tenantId === connection?.tenantId && item.provider === connection?.provider); const expired = posting.status === 'processing' && Date.parse(posting.leaseExpiresAt) <= now.getTime(); if (claimed.length >= limit || !connection || connection.status !== 'active' || !['netsuite', 'sap_s4hana'].includes(connection.provider) || !['outbound', 'bidirectional'].includes(connection.syncDirection) || !connectionAllowedByPolicy(connection, policy) || (posting.status !== 'pending' && !expired) || Date.parse(posting.availableAt) > now.getTime()) continue; Object.assign(posting, { attempts: posting.attempts + 1, leaseExpiresAt: iso(now.getTime() + leaseMs), leaseToken: randomUUID(), leaseWorkerId: workerId, status: 'processing', updatedAt: iso(now), version: posting.version + 1 }); claimed.push({ connection: publicConnection(connection), posting: clone(posting) }); } return claimed;
    },
    async completeErpPosting({ externalId, leaseToken, now = new Date(), postingId, reconciliation, workerId }) { const posting = state.postings.get(postingId); if (!posting || posting.status !== 'processing' || posting.leaseToken !== leaseToken || posting.leaseWorkerId !== workerId) return false; Object.assign(posting, { error: '', externalId, leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, reconciliation: clone(reconciliation), reconciledAt: reconciliation?.matched ? iso(now) : null, status: reconciliation?.matched ? 'reconciled' : 'delivered', updatedAt: iso(now), version: posting.version + 1 }); return true; },
    async failErpPosting({ availableAt, error, leaseToken, maxAttempts = 8, now = new Date(), postingId, workerId }) { const posting = state.postings.get(postingId); if (!posting || posting.status !== 'processing' || posting.leaseToken !== leaseToken || posting.leaseWorkerId !== workerId) return false; Object.assign(posting, { availableAt: iso(availableAt), error: String(error ?? '').slice(0, 4000), leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, status: posting.attempts >= maxAttempts ? 'dead' : 'pending', updatedAt: iso(now), version: posting.version + 1 }); return true; },
    async claimSyncRuns({ leaseMs = 30_000, limit = 10, now = new Date(), workerId }) { const claimed = []; for (const run of state.runs.values()) { const connection = state.connections.get(run.connectionId); const policy = [...state.policies.values()].find((item) => item.tenantId === connection?.tenantId && item.provider === connection?.provider); const expired = run.status === 'processing' && Date.parse(run.leaseExpiresAt) <= now.getTime(); if (claimed.length >= limit || !connection || connection.status !== 'active' || ['netsuite', 'sap_s4hana'].includes(connection.provider) || !connectionAllowedByPolicy(connection, policy) || (run.direction === 'outbound' && !['outbound', 'bidirectional'].includes(connection.syncDirection)) || (run.direction === 'inbound' && !['inbound', 'bidirectional'].includes(connection.syncDirection)) || (run.status !== 'pending' && !expired) || Date.parse(run.availableAt ?? run.createdAt) > now.getTime()) continue; Object.assign(run, { attempts: Number(run.attempts ?? 0) + 1, leaseExpiresAt: iso(now.getTime() + leaseMs), leaseToken: randomUUID(), leaseWorkerId: workerId, status: 'processing', updatedAt: iso(now), version: run.version + 1 }); claimed.push({ connection: publicConnection(connection), run: clone(run) }); } return claimed; },
    async completeSyncRun({ counts, cursorAfter, leaseToken, now = new Date(), runId, workerId }) { const run = state.runs.get(runId); if (!run || run.status !== 'processing' || run.leaseToken !== leaseToken || run.leaseWorkerId !== workerId) return false; Object.assign(run, { completedAt: iso(now), counts: clone(counts), cursorAfter, error: '', leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, status: 'completed', updatedAt: iso(now), version: run.version + 1 }); const connection = state.connections.get(run.connectionId); if (connection) Object.assign(connection, { cursor: cursorAfter, lastSuccessAt: iso(now), updatedAt: iso(now) }); return true; },
    async failSyncRun({ availableAt, error, leaseToken, maxAttempts = 6, now = new Date(), runId, workerId }) { const run = state.runs.get(runId); if (!run || run.status !== 'processing' || run.leaseToken !== leaseToken || run.leaseWorkerId !== workerId) return false; Object.assign(run, { availableAt: iso(availableAt), error: String(error ?? '').slice(0, 4000), leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, status: run.attempts >= maxAttempts ? 'dead' : 'pending', updatedAt: iso(now), version: run.version + 1 }); return true; },
    async enqueueProviderErasure({ connectionId, externalSubjectId, subjectHash, tenantId }) { const existing = [...state.erasures.values()].find((item) => item.connectionId === connectionId && item.externalSubjectId === externalSubjectId); if (existing) return { duplicate: true, job: clone(existing) }; return { duplicate: false, job: create(state.erasures, { attempts: 0, availableAt: iso(), connectionId, error: '', externalSubjectId, leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, providerEvidence: null, status: 'pending', subjectHash }, tenantId) }; },
    async createOAuthTransaction({ input, tenantId, userId }) { const record = { ...clone(input), consumedAt: null, createdAt: iso(), createdBy: userId, id: randomUUID(), tenantId }; state.oauthTransactions.set(record.id, record); return clone(record); },
    async consumeOAuthTransaction({ stateHash }) { const record = [...state.oauthTransactions.values()].find((item) => item.stateHash === stateHash); if (!record || record.consumedAt || Date.parse(record.expiresAt) <= Date.now()) return null; record.consumedAt = iso(); return clone(record); },
    async storeOAuthCredential({ connectionId, encryptedCredential, expiresAt, tenantId }) { const existing = [...state.credentials.values()].find((item) => item.connectionId === connectionId && item.tenantId === tenantId); if (existing) { Object.assign(existing, { encryptedCredential, expiresAt, lastUsedAt: null, revokedAt: null, rotatedAt: iso(), updatedAt: iso(), version: existing.version + 1 }); return clone(existing); } return create(state.credentials, { connectionId, encryptedCredential, expiresAt, lastUsedAt: null, revokedAt: null, rotatedAt: iso() }, tenantId); },
    async getOAuthCredential({ connectionId, tenantId }) { const value = [...state.credentials.values()].find((item) => item.connectionId === connectionId && item.tenantId === tenantId && !item.revokedAt); if (value) value.lastUsedAt = iso(); return value ? clone(value) : null; },
    async claimProviderErasures({ leaseMs = 30_000, limit = 10, now = new Date(), workerId }) { const claimed = []; for (const job of state.erasures.values()) { const connection = state.connections.get(job.connectionId); const policy = [...state.policies.values()].find((item) => item.tenantId === connection?.tenantId && item.provider === connection?.provider); const expired = job.status === 'processing' && Date.parse(job.leaseExpiresAt) <= now.getTime(); if (claimed.length >= limit || !connection || connection.status !== 'active' || !connectionAllowedForLifecycle(connection, policy) || (job.status !== 'pending' && !expired) || Date.parse(job.availableAt) > now.getTime()) continue; Object.assign(job, { attempts: job.attempts + 1, leaseExpiresAt: iso(now.getTime() + leaseMs), leaseToken: randomUUID(), leaseWorkerId: workerId, status: 'processing', updatedAt: iso(now), version: job.version + 1 }); claimed.push({ connection: publicConnection(connection), job: clone(job) }); } return claimed; },
    async completeProviderErasure({ evidence, jobId, leaseToken, now = new Date(), workerId }) { const job = state.erasures.get(jobId); if (!job || job.status !== 'processing' || job.leaseToken !== leaseToken || job.leaseWorkerId !== workerId) return false; Object.assign(job, { error: '', leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, providerEvidence: clone(evidence), status: 'completed', updatedAt: iso(now), version: job.version + 1 }); return true; },
    async failProviderErasure({ availableAt, error, jobId, leaseToken, maxAttempts = 8, now = new Date(), workerId }) { const job = state.erasures.get(jobId); if (!job || job.status !== 'processing' || job.leaseToken !== leaseToken || job.leaseWorkerId !== workerId) return false; Object.assign(job, { availableAt: iso(availableAt), error: String(error ?? '').slice(0, 4000), leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, status: job.attempts >= maxAttempts ? 'dead' : 'pending', updatedAt: iso(now), version: job.version + 1 }); return true; },
    async approveConnection({ approvedBy, connectionId, expectedVersion, tenantId }) {
      const connection = state.connections.get(connectionId);
      if (!connection || connection.tenantId !== tenantId) return null;
      if (connection.userId === approvedBy)
        throw new HttpError(
          403,
          'Connector requester cannot approve the same connection.',
        );
      return publicConnection(
        update(
          state.connections,
          connectionId,
          { approvedAt: iso(), approvedBy, expectedVersion, status: 'active' },
          tenantId,
        ),
      );
    },
    completeInboundEvent: async ({ eventId, expectedVersion, tenantId }) => update(state.events, eventId, { attempts: 1, error: '', expectedVersion, processedAt: iso(), status: 'processed' }, tenantId),
    async claimInboundEvents({ leaseMs = 30_000, limit = 20, now = new Date(), workerId }) {
      const claimed = []; const nowMs = now.getTime();
      for (const event of state.events.values()) {
        const connection = state.connections.get(event.connectionId); const expired = event.status === 'processing' && Date.parse(event.leaseExpiresAt) <= nowMs;
        const policy = [...state.policies.values()].find(
          (item) =>
            item.tenantId === connection?.tenantId &&
            item.provider === connection?.provider,
        );
        if (claimed.length >= limit || !connection || connection.status !== 'active' || !connectionAllowedByPolicy(connection, policy) || event.payload?.kind === 'journal_entry' || (event.status !== 'pending' && !expired) || Date.parse(event.availableAt) > nowMs) continue;
        Object.assign(event, { attempts: event.attempts + 1, leaseExpiresAt: iso(nowMs + leaseMs), leaseToken: randomUUID(), leaseWorkerId: workerId, status: 'processing', updatedAt: iso(now), version: event.version + 1 });
        claimed.push({ connection: publicConnection(connection), event: clone(event) });
      }
      return claimed;
    },
    async completeClaimedInboundEvent({ eventId, leaseToken, now = new Date(), workerId }) {
      const event = state.events.get(eventId); if (!event || event.status !== 'processing' || event.leaseToken !== leaseToken || event.leaseWorkerId !== workerId) return false;
      Object.assign(event, { error: '', leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, processedAt: iso(now), status: 'processed', updatedAt: iso(now), version: event.version + 1 });
      const connection = state.connections.get(event.connectionId); if (connection) Object.assign(connection, { lastSuccessAt: iso(now), updatedAt: iso(now) });
      return true;
    },
    async failClaimedInboundEvent({ availableAt, error, eventId, leaseToken, maxAttempts = 5, now = new Date(), workerId }) {
      const event = state.events.get(eventId); if (!event || event.status !== 'processing' || event.leaseToken !== leaseToken || event.leaseWorkerId !== workerId) return false;
      Object.assign(event, { availableAt: iso(availableAt), error: String(error ?? '').slice(0, 4000), leaseExpiresAt: null, leaseToken: null, leaseWorkerId: null, status: event.attempts >= maxAttempts ? 'dead' : 'pending', updatedAt: iso(now), version: event.version + 1 });
      const connection = state.connections.get(event.connectionId); if (connection) Object.assign(connection, { lastFailureAt: iso(now), updatedAt: iso(now) });
      return true;
    },
    async upsertConnectorObject({ event, projectId = null }) {
      const externalId = String(event.payload?.externalId ?? '').trim(); const kind = String(event.payload?.kind ?? '').trim();
      if (!externalId || !kind) throw new Error('Normalized connector object identity is required.');
      const existing = [...state.objects.values()].find((item) => item.connectionId === event.connectionId && item.kind === kind && item.externalId === externalId);
      if (existing) { const duplicate = existing.payloadHash === event.payloadHash; Object.assign(existing, { payload: clone(event.payload), payloadHash: event.payloadHash, projectId, sourceEventId: event.id, updatedAt: iso(), version: existing.version + (duplicate ? 0 : 1) }); return { duplicate, object: clone(existing) }; }
      return { duplicate: false, object: create(state.objects, { connectionId: event.connectionId, externalId, kind, payload: event.payload, payloadHash: event.payloadHash, projectId, sourceEventId: event.id }, event.tenantId) };
    },
    async listConnectorObjects({ tenantId }) { return list(state.objects, tenantId); },
    resolveConflict: async ({ conflictId, input, tenantId, userId }) =>
      update(
        state.conflicts,
        conflictId,
        { ...input, resolvedAt: iso(), resolvedBy: userId, status: 'resolved' },
        tenantId,
      ),
    updateConnection: async ({ connectionId, input, tenantId }) =>
      publicConnection(
        update(state.connections, connectionId, input, tenantId),
      ),
    updateProviderPolicy: async ({ input, policyId, tenantId }) => {
      const current = state.policies.get(policyId);
      if (!current || current.tenantId !== tenantId) return null;
      const provider = input.provider ?? current.provider;
      const duplicate = [...state.policies.values()].find(
        (item) =>
          item.id !== policyId &&
          item.tenantId === tenantId &&
          item.provider === provider,
      );
      if (duplicate)
        throw new HttpError(409, 'A connector provider policy already exists.');
      return update(state.policies, policyId, input, tenantId);
    },
  };
}

export async function ensureMysqlConnectorSchema(executor) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS connector_connections (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, provider VARCHAR(64) NOT NULL, name VARCHAR(160) NOT NULL, auth_type VARCHAR(32) NOT NULL, secret_reference VARCHAR(500) NOT NULL, inbound_secret_hash CHAR(64) NOT NULL, scopes_json JSON NOT NULL, project_ids_json JSON NOT NULL, settings_json JSON NOT NULL, sync_direction VARCHAR(24) NOT NULL, conflict_policy VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL, cursor_value TEXT NULL, last_success_at DATETIME(3) NULL, last_failure_at DATETIME(3) NULL, created_by VARCHAR(128) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_connector_connection_tenant (tenant_id, provider, status))`,
    `CREATE TABLE IF NOT EXISTS connector_mappings (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, object_type VARCHAR(120) NOT NULL, external_id VARCHAR(255) NOT NULL, odin_id VARCHAR(255) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_connector_external_mapping (connection_id, object_type, external_id), KEY idx_connector_odin_mapping (tenant_id, project_id, object_type, odin_id))`,
    `CREATE TABLE IF NOT EXISTS connector_conflicts (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL, mapping_id VARCHAR(36) NULL, object_type VARCHAR(120) NOT NULL, external_payload_hash CHAR(64) NOT NULL, odin_payload_hash CHAR(64) NOT NULL, status VARCHAR(24) NOT NULL, resolution VARCHAR(24) NULL, note TEXT NOT NULL, resolved_by VARCHAR(128) NULL, resolved_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_connector_conflict_status (tenant_id, connection_id, status, created_at))`,
    `CREATE TABLE IF NOT EXISTS connector_inbound_events (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL, external_event_id VARCHAR(500) NOT NULL, event_type VARCHAR(160) NOT NULL, payload_json JSON NOT NULL, payload_hash CHAR(64) NOT NULL, status VARCHAR(24) NOT NULL, attempts INT NOT NULL DEFAULT 0, processed_at DATETIME(3) NULL, error TEXT NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_connector_inbound_event (connection_id, external_event_id), KEY idx_connector_inbound_pending (tenant_id, status, created_at))`,
    `CREATE TABLE IF NOT EXISTS connector_sync_runs (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL, idempotency_key VARCHAR(200) NOT NULL, direction VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL, cursor_before TEXT NULL, cursor_after TEXT NULL, counts_json JSON NOT NULL, error TEXT NOT NULL, started_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_connector_sync_idempotency (connection_id, idempotency_key), KEY idx_connector_sync_status (tenant_id, status, started_at))`,
  ];
  for (const statement of statements) await executor.execute(statement);
}

export async function ensureMysqlConnectorWorkerSchema(executor) {
  await ensureMysqlConnectorSchema(executor);
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_inbound_events' AND column_name IN ('available_at', 'lease_worker_id', 'lease_token', 'lease_expires_at')");
  const names = new Set(columns.map((row) => row.column_name ?? row.COLUMN_NAME));
  const addedAvailableAt = !names.has('available_at');
  if (addedAvailableAt) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_inbound_events ADD COLUMN available_at DATETIME(3) NULL AFTER attempts');
  if (!names.has('lease_worker_id')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_inbound_events ADD COLUMN lease_worker_id VARCHAR(128) NULL AFTER available_at');
  if (!names.has('lease_token')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_inbound_events ADD COLUMN lease_token VARCHAR(36) NULL AFTER lease_worker_id');
  if (!names.has('lease_expires_at')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_inbound_events ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER lease_token');
  if (addedAvailableAt) {
    await executor.execute('UPDATE connector_inbound_events SET available_at = created_at WHERE available_at IS NULL');
    await executor.execute('ALTER TABLE connector_inbound_events MODIFY COLUMN available_at DATETIME(3) NOT NULL');
  }
  const [indexes] = await executor.execute("SELECT index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'connector_inbound_events' AND index_name = 'idx_connector_inbound_claim'");
  if (!indexes.length) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_inbound_events ADD KEY idx_connector_inbound_claim (status, available_at, lease_expires_at, created_at)');
  await executor.execute(`CREATE TABLE IF NOT EXISTS connector_objects (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NULL, object_kind VARCHAR(80) NOT NULL, external_id VARCHAR(255) NOT NULL,
    payload_json JSON NOT NULL, payload_hash CHAR(64) NOT NULL, source_event_id VARCHAR(36) NOT NULL,
    version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_connector_object_identity (connection_id, object_kind, external_id),
    KEY idx_connector_object_project (tenant_id, project_id, object_kind, updated_at)
  )`);
}

export async function ensureMysqlConnectorMarketplaceSchema(executor) {
  await ensureMysqlConnectorSchema(executor);
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_connections' AND column_name IN ('approved_by', 'approved_at')");
  const names = new Set(columns.map((row) => row.column_name ?? row.COLUMN_NAME));
  if (!names.has('approved_by')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_connections ADD COLUMN approved_by VARCHAR(128) NULL AFTER created_by');
  if (!names.has('approved_at')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_connections ADD COLUMN approved_at DATETIME(3) NULL AFTER approved_by');
  await executor.execute(`CREATE TABLE IF NOT EXISTS connector_provider_policies (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, provider VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL, allowed_auth_types_json JSON NOT NULL, allowed_directions_json JSON NOT NULL,
    allowed_scopes_json JSON NOT NULL, data_classification VARCHAR(32) NOT NULL, max_projects INT NOT NULL,
    outbound_enabled BOOLEAN NOT NULL, approval_required BOOLEAN NOT NULL, created_by VARCHAR(128) NOT NULL,
    version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_connector_provider_policy (tenant_id, provider), KEY idx_connector_provider_policy_status (tenant_id, enabled, provider)
  )`);
}

export async function ensureMysqlConnectorErpPostingSchema(executor) {
  await ensureMysqlConnectorMarketplaceSchema(executor);
  await executor.execute(`CREATE TABLE IF NOT EXISTS connector_erp_postings (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL,
    financial_entry_id VARCHAR(36) NOT NULL, financial_entry_version INT NOT NULL, idempotency_key VARCHAR(200) NOT NULL,
    status VARCHAR(24) NOT NULL, attempts INT NOT NULL DEFAULT 0, available_at DATETIME(3) NOT NULL,
    lease_worker_id VARCHAR(128) NULL, lease_token VARCHAR(36) NULL, lease_expires_at DATETIME(3) NULL,
    external_id VARCHAR(255) NULL, reconciliation_json JSON NULL, reconciled_at DATETIME(3) NULL,
    error TEXT NOT NULL, created_by VARCHAR(128) NOT NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_connector_erp_entry (connection_id, financial_entry_id),
    UNIQUE KEY uq_connector_erp_idempotency (connection_id, idempotency_key),
    KEY idx_connector_erp_claim (status, available_at, lease_expires_at, created_at),
    KEY idx_connector_erp_tenant (tenant_id, connection_id, created_at)
  )`);
}

export async function ensureMysqlConnectorSyncWorkerSchema(executor) {
  await ensureMysqlConnectorMarketplaceSchema(executor);
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_sync_runs' AND column_name IN ('attempts', 'available_at', 'lease_worker_id', 'lease_token', 'lease_expires_at')"); const names = new Set(columns.map((row) => row.column_name ?? row.COLUMN_NAME));
  if (!names.has('attempts')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_sync_runs ADD COLUMN attempts INT NOT NULL DEFAULT 0 AFTER status');
  if (!names.has('available_at')) { await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_sync_runs ADD COLUMN available_at DATETIME(3) NULL AFTER attempts'); await executor.execute('UPDATE connector_sync_runs SET available_at = created_at WHERE available_at IS NULL'); await executor.execute('ALTER TABLE connector_sync_runs MODIFY COLUMN available_at DATETIME(3) NOT NULL'); }
  if (!names.has('lease_worker_id')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_sync_runs ADD COLUMN lease_worker_id VARCHAR(128) NULL AFTER available_at');
  if (!names.has('lease_token')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_sync_runs ADD COLUMN lease_token VARCHAR(36) NULL AFTER lease_worker_id');
  if (!names.has('lease_expires_at')) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_sync_runs ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER lease_token');
  const [indexes] = await executor.execute("SELECT index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'connector_sync_runs' AND index_name = 'idx_connector_sync_claim'"); if (!indexes.length) await executeIdempotentSchemaChange(executor, 'ALTER TABLE connector_sync_runs ADD KEY idx_connector_sync_claim (status, available_at, lease_expires_at, created_at)');
}

export async function ensureMysqlConnectorErasureSchema(executor) {
  await ensureMysqlConnectorMarketplaceSchema(executor);
  await executor.execute(`CREATE TABLE IF NOT EXISTS connector_provider_erasure_jobs (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL,
    external_subject_id VARCHAR(255) NOT NULL, subject_hash CHAR(64) NOT NULL, status VARCHAR(24) NOT NULL,
    attempts INT NOT NULL DEFAULT 0, available_at DATETIME(3) NOT NULL, lease_worker_id VARCHAR(128) NULL,
    lease_token VARCHAR(36) NULL, lease_expires_at DATETIME(3) NULL, provider_evidence_json JSON NULL,
    error TEXT NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_connector_erasure_subject (connection_id, external_subject_id),
    KEY idx_connector_erasure_claim (status, available_at, lease_expires_at, created_at),
    KEY idx_connector_erasure_tenant (tenant_id, connection_id, created_at)
  )`);
}

export async function ensureMysqlConnectorOAuthSchema(executor) {
  await ensureMysqlConnectorMarketplaceSchema(executor);
  await executor.execute(`CREATE TABLE IF NOT EXISTS connector_oauth_transactions (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL,
    state_hash CHAR(64) NOT NULL, code_verifier VARCHAR(128) NOT NULL, redirect_uri VARCHAR(1000) NOT NULL,
    expires_at DATETIME(3) NOT NULL, consumed_at DATETIME(3) NULL, created_by VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_connector_oauth_state (state_hash), KEY idx_connector_oauth_expiry (expires_at, consumed_at)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS connector_oauth_credentials (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NOT NULL,
    encrypted_credential TEXT NOT NULL, expires_at DATETIME(3) NULL, rotated_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL, last_used_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_connector_oauth_credential (connection_id), KEY idx_connector_oauth_credential_tenant (tenant_id, revoked_at)
  )`);
}

const rowBase = (row) => ({
  createdAt: iso(row.created_at),
  id: row.id,
  tenantId: row.tenant_id,
  updatedAt: iso(row.updated_at),
  version: Number(row.version),
});
const mapConnection = (row) =>
  row && {
    ...rowBase(row),
    approvedAt: row.approved_at ? iso(row.approved_at) : null,
    approvedBy: row.approved_by ?? null,
    authType: row.auth_type,
    conflictPolicy: row.conflict_policy,
    cursor: row.cursor_value,
    inboundSecretHash: row.inbound_secret_hash,
    lastFailureAt: row.last_failure_at ? iso(row.last_failure_at) : null,
    lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
    name: row.name,
    projectIds: parseJson(row.project_ids_json, []),
    provider: row.provider,
    scopes: parseJson(row.scopes_json, []),
    secretReference: row.secret_reference,
    settings: parseJson(row.settings_json, {}),
    status: row.status,
    syncDirection: row.sync_direction,
    userId: row.created_by,
  };
const mapMapping = (row) =>
  row && {
    ...rowBase(row),
    connectionId: row.connection_id,
    externalId: row.external_id,
    objectType: row.object_type,
    odinId: row.odin_id,
    projectId: row.project_id,
  };
const mapEvent = (row) =>
  row && {
    ...rowBase(row),
    attempts: Number(row.attempts),
    availableAt: row.available_at ? iso(row.available_at) : iso(row.created_at),
    connectionId: row.connection_id,
    error: row.error,
    eventType: row.event_type,
    externalEventId: row.external_event_id,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    leaseToken: row.lease_token ?? null,
    leaseWorkerId: row.lease_worker_id ?? null,
    payload: parseJson(row.payload_json, {}),
    payloadHash: row.payload_hash,
    processedAt: row.processed_at ? iso(row.processed_at) : null,
    status: row.status,
  };
const mapObject = (row) => row && ({
  ...rowBase(row), connectionId: row.connection_id, externalId: row.external_id, kind: row.object_kind,
  payload: parseJson(row.payload_json, {}), payloadHash: row.payload_hash, projectId: row.project_id, sourceEventId: row.source_event_id,
});
const mapRun = (row) =>
  row && {
    ...rowBase(row),
    attempts: Number(row.attempts ?? 0),
    availableAt: row.available_at ? iso(row.available_at) : iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    connectionId: row.connection_id,
    counts: parseJson(row.counts_json, {}),
    cursorAfter: row.cursor_after,
    cursorBefore: row.cursor_before,
    direction: row.direction,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    leaseToken: row.lease_token ?? null,
    leaseWorkerId: row.lease_worker_id ?? null,
    startedAt: iso(row.started_at),
    status: row.status,
  };
const mapConflict = (row) =>
  row && {
    ...rowBase(row),
    connectionId: row.connection_id,
    externalPayloadHash: row.external_payload_hash,
    mappingId: row.mapping_id,
    note: row.note,
    objectType: row.object_type,
    odinPayloadHash: row.odin_payload_hash,
    resolution: row.resolution,
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
    resolvedBy: row.resolved_by,
    status: row.status,
  };
const mapPolicy = (row) => row && ({
  ...rowBase(row), allowedAuthTypes: parseJson(row.allowed_auth_types_json, []), allowedDirections: parseJson(row.allowed_directions_json, []),
  allowedScopes: parseJson(row.allowed_scopes_json, []), approvalRequired: Boolean(row.approval_required), createdBy: row.created_by,
  dataClassification: row.data_classification, enabled: Boolean(row.enabled), maxProjects: Number(row.max_projects), outboundEnabled: Boolean(row.outbound_enabled), provider: row.provider,
});
const mapPosting = (row) => row && ({ ...rowBase(row), attempts: Number(row.attempts), availableAt: iso(row.available_at), connectionId: row.connection_id, createdBy: row.created_by, error: row.error, externalId: row.external_id, financialEntryId: row.financial_entry_id, financialEntryVersion: Number(row.financial_entry_version), idempotencyKey: row.idempotency_key, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null, leaseToken: row.lease_token, leaseWorkerId: row.lease_worker_id, reconciliation: parseJson(row.reconciliation_json, null), reconciledAt: row.reconciled_at ? iso(row.reconciled_at) : null, status: row.status });
const mapErasure = (row) => row && ({ ...rowBase(row), attempts: Number(row.attempts), availableAt: iso(row.available_at), connectionId: row.connection_id, error: row.error, externalSubjectId: row.external_subject_id, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null, leaseToken: row.lease_token, leaseWorkerId: row.lease_worker_id, providerEvidence: parseJson(row.provider_evidence_json, null), status: row.status, subjectHash: row.subject_hash });
const mapOAuthTransaction = (row) => row && ({ codeVerifier: row.code_verifier, connectionId: row.connection_id, consumedAt: row.consumed_at ? iso(row.consumed_at) : null, createdAt: iso(row.created_at), createdBy: row.created_by, expiresAt: iso(row.expires_at), id: row.id, redirectUri: row.redirect_uri, stateHash: row.state_hash, tenantId: row.tenant_id });
const mapOAuthCredential = (row) => row && ({ connectionId: row.connection_id, createdAt: iso(row.created_at), encryptedCredential: row.encrypted_credential, expiresAt: row.expires_at ? iso(row.expires_at) : null, id: row.id, lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null, revokedAt: row.revoked_at ? iso(row.revoked_at) : null, rotatedAt: iso(row.rotated_at), tenantId: row.tenant_id, updatedAt: iso(row.updated_at), version: Number(row.version) });

export function createMysqlConnectorRepository({ pool }) {
  async function select(table, id, tenantId, mapper) {
    const [rows] = await pool.execute(
      `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, tenantId],
    );
    return mapper(rows[0]);
  }
  return {
    async authenticateInbound({ connectionId, secretHash }) {
      const [rows] = await pool.execute(
        "SELECT * FROM connector_connections WHERE id = ? AND inbound_secret_hash = ? AND status = 'active' LIMIT 1",
        [connectionId, secretHash],
      );
      const connection = mapConnection(rows[0]);
      if (!connection) return null;
      const [policyRows] = await pool.execute(
        'SELECT * FROM connector_provider_policies WHERE tenant_id = ? AND provider = ? LIMIT 1',
        [connection.tenantId, connection.provider],
      );
      return connectionAllowedByPolicy(connection, mapPolicy(policyRows[0]))
        ? publicConnection(connection)
        : null;
    },
    async createConnection({ inboundSecretHash, input, tenantId, userId }) {
      const id = randomUUID();
      await pool.execute(
        'INSERT INTO connector_connections (id, tenant_id, provider, name, auth_type, secret_reference, inbound_secret_hash, scopes_json, project_ids_json, settings_json, sync_direction, conflict_policy, status, cursor_value, last_success_at, last_failure_at, created_by, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, NOW(3), NOW(3))',
        [
          id,
          tenantId,
          input.provider,
          input.name,
          input.authType,
          input.secretReference,
          inboundSecretHash,
          JSON.stringify(input.scopes),
          JSON.stringify(input.projectIds),
          JSON.stringify(input.settings),
          input.syncDirection,
          input.conflictPolicy,
          input.status,
          userId,
        ],
      );
      return publicConnection(
        await select('connector_connections', id, tenantId, mapConnection),
      );
    },
    async createOAuthTransaction({ input, tenantId, userId }) { const id = randomUUID(); await pool.execute('INSERT INTO connector_oauth_transactions (id, tenant_id, connection_id, state_hash, code_verifier, redirect_uri, expires_at, consumed_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NOW(3))', [id, tenantId, input.connectionId, input.stateHash, input.codeVerifier, input.redirectUri, new Date(input.expiresAt), userId]); const [rows] = await pool.execute('SELECT * FROM connector_oauth_transactions WHERE id = ?', [id]); return mapOAuthTransaction(rows[0]); },
    async consumeOAuthTransaction({ stateHash }) { const connection = await pool.getConnection(); try { await connection.beginTransaction(); const [rows] = await connection.execute('SELECT * FROM connector_oauth_transactions WHERE state_hash = ? FOR UPDATE', [stateHash]); const record = mapOAuthTransaction(rows[0]); if (!record || record.consumedAt || Date.parse(record.expiresAt) <= Date.now()) { await connection.rollback(); return null; } await connection.execute('UPDATE connector_oauth_transactions SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL', [record.id]); await connection.commit(); return { ...record, consumedAt: iso() }; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } },
    async storeOAuthCredential({ connectionId, encryptedCredential, expiresAt, tenantId }) { const id = randomUUID(); await pool.execute(`INSERT INTO connector_oauth_credentials (id, tenant_id, connection_id, encrypted_credential, expires_at, rotated_at, revoked_at, last_used_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(3), NULL, NULL, 1, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE encrypted_credential = VALUES(encrypted_credential), expires_at = VALUES(expires_at), rotated_at = NOW(3), revoked_at = NULL, last_used_at = NULL, version = version + 1, updated_at = NOW(3)`, [id, tenantId, connectionId, encryptedCredential, expiresAt ? new Date(expiresAt) : null]); const [rows] = await pool.execute('SELECT * FROM connector_oauth_credentials WHERE connection_id = ? LIMIT 1', [connectionId]); return mapOAuthCredential(rows[0]); },
    async getOAuthCredential({ connectionId, tenantId }) { const [rows] = await pool.execute('SELECT * FROM connector_oauth_credentials WHERE connection_id = ? AND tenant_id = ? AND revoked_at IS NULL LIMIT 1', [connectionId, tenantId]); if (!rows[0]) return null; await pool.execute('UPDATE connector_oauth_credentials SET last_used_at = NOW(3) WHERE id = ?', [rows[0].id]); return mapOAuthCredential(rows[0]); },
    async createConflict({ input, tenantId }) {
      const id = randomUUID();
      await pool.execute(
        "INSERT INTO connector_conflicts (id, tenant_id, connection_id, mapping_id, object_type, external_payload_hash, odin_payload_hash, status, resolution, note, resolved_by, resolved_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, 1, NOW(3), NOW(3))",
        [
          id,
          tenantId,
          input.connectionId,
          input.mappingId,
          input.objectType,
          input.externalPayloadHash,
          input.odinPayloadHash,
          input.note,
        ],
      );
      return select('connector_conflicts', id, tenantId, mapConflict);
    },
    async createProviderPolicy({ input, tenantId, userId }) {
      const id = randomUUID();
      try { await pool.execute('INSERT INTO connector_provider_policies (id, tenant_id, provider, enabled, allowed_auth_types_json, allowed_directions_json, allowed_scopes_json, data_classification, max_projects, outbound_enabled, approval_required, created_by, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))', [id, tenantId, input.provider, input.enabled, JSON.stringify(input.allowedAuthTypes), JSON.stringify(input.allowedDirections), JSON.stringify(input.allowedScopes), input.dataClassification, input.maxProjects, input.outboundEnabled, input.approvalRequired, userId]); }
      catch (error) { if (error?.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A connector provider policy already exists.'); throw error; }
      return select('connector_provider_policies', id, tenantId, mapPolicy);
    },
    async createMapping({ input, tenantId }) {
      const id = randomUUID();
      try {
        await pool.execute(
          'INSERT INTO connector_mappings (id, tenant_id, connection_id, project_id, object_type, external_id, odin_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))',
          [
            id,
            tenantId,
            input.connectionId,
            input.projectId,
            input.objectType,
            input.externalId,
            input.odinId,
          ],
        );
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') mappingConflict();
        throw error;
      }
      return select('connector_mappings', id, tenantId, mapMapping);
    },
    async createSyncRun({ connectionId, direction, idempotencyKey, tenantId }) {
      const id = randomUUID();
      const [result] = await pool.execute(
        "INSERT IGNORE INTO connector_sync_runs (id, tenant_id, connection_id, idempotency_key, direction, status, attempts, available_at, lease_worker_id, lease_token, lease_expires_at, cursor_before, cursor_after, counts_json, error, started_at, completed_at, version, created_at, updated_at) SELECT ?, tenant_id, id, ?, ?, 'pending', 0, NOW(3), NULL, NULL, NULL, cursor_value, NULL, '{}', '', NOW(3), NULL, 1, NOW(3), NOW(3) FROM connector_connections WHERE id = ? AND tenant_id = ?",
        [id, idempotencyKey, direction, connectionId, tenantId],
      );
      const [rows] = await pool.execute(
        'SELECT * FROM connector_sync_runs WHERE connection_id = ? AND idempotency_key = ? LIMIT 1',
        [connectionId, idempotencyKey],
      );
      return {
        duplicate: Number(result.affectedRows) === 0,
        run: mapRun(rows[0]),
      };
    },
    async createErpPosting({ connectionId, financialEntry, idempotencyKey, tenantId, userId }) {
      const id = randomUUID(); const [result] = await pool.execute(`INSERT IGNORE INTO connector_erp_postings (id, tenant_id, connection_id, financial_entry_id, financial_entry_version, idempotency_key, status, attempts, available_at, lease_worker_id, lease_token, lease_expires_at, external_id, reconciliation_json, reconciled_at, error, created_by, version, created_at, updated_at) SELECT ?, tenant_id, id, ?, ?, ?, 'pending', 0, NOW(3), NULL, NULL, NULL, NULL, NULL, NULL, '', ?, 1, NOW(3), NOW(3) FROM connector_connections WHERE id = ? AND tenant_id = ?`, [id, financialEntry.id, financialEntry.version, idempotencyKey, userId, connectionId, tenantId]);
      const [rows] = await pool.execute('SELECT * FROM connector_erp_postings WHERE connection_id = ? AND financial_entry_id = ? LIMIT 1', [connectionId, financialEntry.id]); return { duplicate: Number(result.affectedRows) === 0, posting: mapPosting(rows[0]) };
    },
    async recordInboundEvent({
      connection,
      eventId,
      eventType,
      payload,
      payloadHash,
    }) {
      const id = randomUUID();
      const [result] = await pool.execute(
        "INSERT IGNORE INTO connector_inbound_events (id, tenant_id, connection_id, external_event_id, event_type, payload_json, payload_hash, status, attempts, available_at, processed_at, error, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NOW(3), NULL, '', 1, NOW(3), NOW(3))",
        [
          id,
          connection.tenantId,
          connection.id,
          eventId,
          eventType,
          JSON.stringify(payload),
          payloadHash,
        ],
      );
      const [rows] = await pool.execute(
        'SELECT * FROM connector_inbound_events WHERE connection_id = ? AND external_event_id = ? LIMIT 1',
        [connection.id, eventId],
      );
      return {
        duplicate: Number(result.affectedRows) === 0,
        event: mapEvent(rows[0]),
      };
    },
    async listSnapshot({ tenantId }) {
      const result = {};
      for (const [name, table, mapper] of [
        ['connections', 'connector_connections', mapConnection],
        ['mappings', 'connector_mappings', mapMapping],
        ['conflicts', 'connector_conflicts', mapConflict],
        ['events', 'connector_inbound_events', mapEvent],
        ['erasures', 'connector_provider_erasure_jobs', mapErasure],
        ['runs', 'connector_sync_runs', mapRun],
        ['policies', 'connector_provider_policies', mapPolicy],
        ['postings', 'connector_erp_postings', mapPosting],
      ]) {
        const [rows] = await pool.execute(
          `SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY created_at, id`,
          [tenantId],
        );
        result[name] = rows.map(mapper);
      }
      result.connections = result.connections.map(publicConnection);
      return result;
    },
    async claimErpPostings({ leaseMs = 30_000, limit = 20, now = new Date(), workerId }) {
      const connection = await pool.getConnection(); const claimed = [];
      try { await connection.beginTransaction(); const bounded = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20)); const [rows] = await connection.execute(`SELECT p.* FROM connector_erp_postings p INNER JOIN connector_connections c ON c.id = p.connection_id LEFT JOIN connector_provider_policies policy ON policy.tenant_id = c.tenant_id AND policy.provider = c.provider WHERE p.available_at <= ? AND (p.status = 'pending' OR (p.status = 'processing' AND p.lease_expires_at <= ?)) AND c.status = 'active' AND c.provider IN ('netsuite', 'sap_s4hana') AND c.sync_direction IN ('outbound', 'bidirectional') AND (policy.id IS NULL OR (policy.enabled = TRUE AND policy.outbound_enabled = TRUE AND JSON_CONTAINS(policy.allowed_auth_types_json, JSON_QUOTE(c.auth_type)) AND JSON_CONTAINS(policy.allowed_directions_json, JSON_QUOTE(c.sync_direction)) AND JSON_LENGTH(c.project_ids_json) <= policy.max_projects AND (JSON_LENGTH(policy.allowed_scopes_json) = 0 OR JSON_CONTAINS(policy.allowed_scopes_json, c.scopes_json)) AND (policy.approval_required = FALSE OR c.approved_at IS NOT NULL))) ORDER BY p.created_at, p.id LIMIT ${bounded} FOR UPDATE SKIP LOCKED`, [now, now]);
        for (const row of rows) { const leaseToken = randomUUID(); const leaseExpiresAt = new Date(now.getTime() + leaseMs); await connection.execute("UPDATE connector_erp_postings SET status = 'processing', attempts = attempts + 1, lease_worker_id = ?, lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?", [workerId, leaseToken, leaseExpiresAt, now, row.id]); claimed.push(mapPosting({ ...row, attempts: Number(row.attempts) + 1, lease_expires_at: leaseExpiresAt, lease_token: leaseToken, lease_worker_id: workerId, status: 'processing', updated_at: now, version: Number(row.version) + 1 })); }
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      return Promise.all(claimed.map(async (posting) => ({ connection: publicConnection(await select('connector_connections', posting.connectionId, posting.tenantId, mapConnection)), posting })));
    },
    async completeErpPosting({ externalId, leaseToken, now = new Date(), postingId, reconciliation, workerId }) { const matched = Boolean(reconciliation?.matched); const [result] = await pool.execute("UPDATE connector_erp_postings SET status = ?, external_id = ?, reconciliation_json = ?, reconciled_at = ?, error = '', lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [matched ? 'reconciled' : 'delivered', externalId, JSON.stringify(reconciliation ?? {}), matched ? now : null, now, postingId, workerId, leaseToken]); return Number(result.affectedRows) === 1; },
    async failErpPosting({ availableAt, error, leaseToken, maxAttempts = 8, now = new Date(), postingId, workerId }) { const [result] = await pool.execute("UPDATE connector_erp_postings SET status = IF(attempts >= ?, 'dead', 'pending'), available_at = ?, error = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [maxAttempts, availableAt, String(error ?? '').slice(0, 4000), now, postingId, workerId, leaseToken]); return Number(result.affectedRows) === 1; },
    async claimSyncRuns({ leaseMs = 30_000, limit = 10, now = new Date(), workerId }) { const connection = await pool.getConnection(); const claimed = []; try { await connection.beginTransaction(); const bounded = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10)); const [rows] = await connection.execute(`SELECT r.* FROM connector_sync_runs r INNER JOIN connector_connections c ON c.id = r.connection_id LEFT JOIN connector_provider_policies p ON p.tenant_id = c.tenant_id AND p.provider = c.provider WHERE r.available_at <= ? AND (r.status = 'pending' OR (r.status = 'processing' AND r.lease_expires_at <= ?)) AND c.status = 'active' AND c.provider NOT IN ('netsuite', 'sap_s4hana') AND ((r.direction = 'inbound' AND c.sync_direction IN ('inbound', 'bidirectional')) OR (r.direction = 'outbound' AND c.sync_direction IN ('outbound', 'bidirectional'))) AND (p.id IS NULL OR (p.enabled = TRUE AND JSON_CONTAINS(p.allowed_auth_types_json, JSON_QUOTE(c.auth_type)) AND JSON_CONTAINS(p.allowed_directions_json, JSON_QUOTE(c.sync_direction)) AND (r.direction = 'inbound' OR p.outbound_enabled = TRUE) AND JSON_LENGTH(c.project_ids_json) <= p.max_projects AND (JSON_LENGTH(p.allowed_scopes_json) = 0 OR JSON_CONTAINS(p.allowed_scopes_json, c.scopes_json)) AND (p.approval_required = FALSE OR c.approved_at IS NOT NULL))) ORDER BY r.created_at, r.id LIMIT ${bounded} FOR UPDATE SKIP LOCKED`, [now, now]); for (const row of rows) { const leaseToken = randomUUID(); const leaseExpiresAt = new Date(now.getTime() + leaseMs); await connection.execute("UPDATE connector_sync_runs SET status = 'processing', attempts = attempts + 1, lease_worker_id = ?, lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?", [workerId, leaseToken, leaseExpiresAt, now, row.id]); claimed.push(mapRun({ ...row, attempts: Number(row.attempts) + 1, lease_expires_at: leaseExpiresAt, lease_token: leaseToken, lease_worker_id: workerId, status: 'processing', updated_at: now, version: Number(row.version) + 1 })); } await connection.commit(); } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } return Promise.all(claimed.map(async (run) => ({ connection: publicConnection(await select('connector_connections', run.connectionId, run.tenantId, mapConnection)), run }))); },
    async completeSyncRun({ counts, cursorAfter, leaseToken, now = new Date(), runId, workerId }) { const connection = await pool.getConnection(); try { await connection.beginTransaction(); const [result] = await connection.execute("UPDATE connector_sync_runs SET status = 'completed', cursor_after = ?, counts_json = ?, error = '', completed_at = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [cursorAfter, JSON.stringify(counts), now, now, runId, workerId, leaseToken]); if (Number(result.affectedRows) !== 1) { await connection.rollback(); return false; } await connection.execute('UPDATE connector_connections c INNER JOIN connector_sync_runs r ON r.connection_id = c.id SET c.cursor_value = ?, c.last_success_at = ?, c.updated_at = ? WHERE r.id = ?', [cursorAfter, now, now, runId]); await connection.commit(); return true; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } },
    async failSyncRun({ availableAt, error, leaseToken, maxAttempts = 6, now = new Date(), runId, workerId }) { const [result] = await pool.execute("UPDATE connector_sync_runs SET status = IF(attempts >= ?, 'dead', 'pending'), available_at = ?, error = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [maxAttempts, availableAt, String(error ?? '').slice(0, 4000), now, runId, workerId, leaseToken]); if (Number(result.affectedRows) === 1) await pool.execute('UPDATE connector_connections c INNER JOIN connector_sync_runs r ON r.connection_id = c.id SET c.last_failure_at = ?, c.updated_at = ? WHERE r.id = ?', [now, now, runId]); return Number(result.affectedRows) === 1; },
    async enqueueProviderErasure({ connectionId, externalSubjectId, subjectHash, tenantId }) { const id = randomUUID(); const [result] = await pool.execute("INSERT IGNORE INTO connector_provider_erasure_jobs (id, tenant_id, connection_id, external_subject_id, subject_hash, status, attempts, available_at, lease_worker_id, lease_token, lease_expires_at, provider_evidence_json, error, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, NOW(3), NULL, NULL, NULL, NULL, '', 1, NOW(3), NOW(3))", [id, tenantId, connectionId, externalSubjectId, subjectHash]); const [rows] = await pool.execute('SELECT * FROM connector_provider_erasure_jobs WHERE connection_id = ? AND external_subject_id = ? LIMIT 1', [connectionId, externalSubjectId]); return { duplicate: Number(result.affectedRows) === 0, job: mapErasure(rows[0]) }; },
    async claimProviderErasures({ leaseMs = 30_000, limit = 10, now = new Date(), workerId }) { const connection = await pool.getConnection(); const claimed = []; try { await connection.beginTransaction(); const bounded = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10)); const [rows] = await connection.execute(`SELECT e.* FROM connector_provider_erasure_jobs e INNER JOIN connector_connections c ON c.id = e.connection_id LEFT JOIN connector_provider_policies p ON p.tenant_id = c.tenant_id AND p.provider = c.provider WHERE e.available_at <= ? AND (e.status = 'pending' OR (e.status = 'processing' AND e.lease_expires_at <= ?)) AND c.status = 'active' AND (p.id IS NULL OR (p.enabled = TRUE AND JSON_CONTAINS(p.allowed_auth_types_json, JSON_QUOTE(c.auth_type)) AND JSON_LENGTH(c.project_ids_json) <= p.max_projects AND (p.approval_required = FALSE OR c.approved_at IS NOT NULL))) ORDER BY e.created_at, e.id LIMIT ${bounded} FOR UPDATE SKIP LOCKED`, [now, now]); for (const row of rows) { const leaseToken = randomUUID(); const leaseExpiresAt = new Date(now.getTime() + leaseMs); await connection.execute("UPDATE connector_provider_erasure_jobs SET status = 'processing', attempts = attempts + 1, lease_worker_id = ?, lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?", [workerId, leaseToken, leaseExpiresAt, now, row.id]); claimed.push(mapErasure({ ...row, attempts: Number(row.attempts) + 1, lease_expires_at: leaseExpiresAt, lease_token: leaseToken, lease_worker_id: workerId, status: 'processing', updated_at: now, version: Number(row.version) + 1 })); } await connection.commit(); } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } return Promise.all(claimed.map(async (job) => ({ connection: publicConnection(await select('connector_connections', job.connectionId, job.tenantId, mapConnection)), job }))); },
    async completeProviderErasure({ evidence, jobId, leaseToken, now = new Date(), workerId }) { const [result] = await pool.execute("UPDATE connector_provider_erasure_jobs SET status = 'completed', provider_evidence_json = ?, error = '', lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [JSON.stringify(evidence ?? {}), now, jobId, workerId, leaseToken]); return Number(result.affectedRows) === 1; },
    async failProviderErasure({ availableAt, error, jobId, leaseToken, maxAttempts = 8, now = new Date(), workerId }) { const [result] = await pool.execute("UPDATE connector_provider_erasure_jobs SET status = IF(attempts >= ?, 'dead', 'pending'), available_at = ?, error = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [maxAttempts, availableAt, String(error ?? '').slice(0, 4000), now, jobId, workerId, leaseToken]); return Number(result.affectedRows) === 1; },
    async approveConnection({ approvedBy, connectionId, expectedVersion, tenantId }) {
      const current = await select('connector_connections', connectionId, tenantId, mapConnection); if (!current) return null;
      if (current.userId === approvedBy) throw new HttpError(403, 'Connector requester cannot approve the same connection.');
      const [result] = await pool.execute("UPDATE connector_connections SET status = 'active', approved_by = ?, approved_at = NOW(3), version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?", [approvedBy, connectionId, tenantId, expectedVersion]);
      if (Number(result.affectedRows) !== 1) conflict(current, expectedVersion); return publicConnection(await select('connector_connections', connectionId, tenantId, mapConnection));
    },
    async claimInboundEvents({ leaseMs = 30_000, limit = 20, now = new Date(), workerId }) {
      const connection = await pool.getConnection(); const claimed = [];
      try {
        await connection.beginTransaction(); const bounded = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
        const [rows] = await connection.execute(
          `SELECT e.* FROM connector_inbound_events e
           INNER JOIN connector_connections c ON c.id = e.connection_id
           LEFT JOIN connector_provider_policies p ON p.tenant_id = c.tenant_id AND p.provider = c.provider
           WHERE JSON_UNQUOTE(JSON_EXTRACT(e.payload_json, '$.kind')) <> 'journal_entry'
             AND e.available_at <= ?
             AND (e.status = 'pending' OR (e.status = 'processing' AND e.lease_expires_at <= ?))
             AND c.status = 'active'
             AND (p.id IS NULL OR (
               p.enabled = TRUE
               AND JSON_CONTAINS(p.allowed_auth_types_json, JSON_QUOTE(c.auth_type))
               AND JSON_CONTAINS(p.allowed_directions_json, JSON_QUOTE(c.sync_direction))
               AND (p.outbound_enabled = TRUE OR c.sync_direction = 'inbound')
               AND JSON_LENGTH(c.project_ids_json) <= p.max_projects
               AND (JSON_LENGTH(p.allowed_scopes_json) = 0 OR JSON_CONTAINS(p.allowed_scopes_json, c.scopes_json))
               AND (p.approval_required = FALSE OR c.approved_at IS NOT NULL)
             ))
           ORDER BY e.created_at, e.id LIMIT ${bounded} FOR UPDATE SKIP LOCKED`,
          [now, now],
        );
        for (const row of rows) {
          const leaseToken = randomUUID(); const leaseExpiresAt = new Date(now.getTime() + leaseMs);
          await connection.execute("UPDATE connector_inbound_events SET status = 'processing', attempts = attempts + 1, lease_worker_id = ?, lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?", [workerId, leaseToken, leaseExpiresAt, now, row.id]);
          claimed.push(mapEvent({ ...row, attempts: Number(row.attempts) + 1, lease_expires_at: leaseExpiresAt, lease_token: leaseToken, lease_worker_id: workerId, status: 'processing', updated_at: now, version: Number(row.version) + 1 }));
        }
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      return Promise.all(claimed.map(async (event) => ({ connection: publicConnection(await select('connector_connections', event.connectionId, event.tenantId, mapConnection)), event })));
    },
    async completeClaimedInboundEvent({ eventId, leaseToken, now = new Date(), workerId }) {
      const [result] = await pool.execute("UPDATE connector_inbound_events SET status = 'processed', processed_at = ?, error = '', lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [now, now, eventId, workerId, leaseToken]);
      if (Number(result.affectedRows) === 1) await pool.execute('UPDATE connector_connections c INNER JOIN connector_inbound_events e ON e.connection_id = c.id SET c.last_success_at = ?, c.updated_at = ? WHERE e.id = ?', [now, now, eventId]);
      return Number(result.affectedRows) === 1;
    },
    async failClaimedInboundEvent({ availableAt, error, eventId, leaseToken, maxAttempts = 5, now = new Date(), workerId }) {
      const [result] = await pool.execute("UPDATE connector_inbound_events SET status = IF(attempts >= ?, 'dead', 'pending'), available_at = ?, error = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_worker_id = ? AND lease_token = ?", [maxAttempts, availableAt, String(error ?? '').slice(0, 4000), now, eventId, workerId, leaseToken]);
      if (Number(result.affectedRows) === 1) await pool.execute('UPDATE connector_connections c INNER JOIN connector_inbound_events e ON e.connection_id = c.id SET c.last_failure_at = ?, c.updated_at = ? WHERE e.id = ?', [now, now, eventId]);
      return Number(result.affectedRows) === 1;
    },
    async upsertConnectorObject({ event, projectId = null }) {
      const externalId = String(event.payload?.externalId ?? '').trim(); const kind = String(event.payload?.kind ?? '').trim();
      if (!externalId || !kind) throw new Error('Normalized connector object identity is required.');
      const [existingRows] = await pool.execute('SELECT * FROM connector_objects WHERE connection_id = ? AND object_kind = ? AND external_id = ? LIMIT 1', [event.connectionId, kind, externalId]);
      const id = existingRows[0]?.id ?? randomUUID();
      await pool.execute('INSERT INTO connector_objects (id, tenant_id, connection_id, project_id, object_kind, external_id, payload_json, payload_hash, source_event_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE project_id = VALUES(project_id), version = version + IF(payload_hash = VALUES(payload_hash), 0, 1), payload_json = VALUES(payload_json), payload_hash = VALUES(payload_hash), source_event_id = VALUES(source_event_id), updated_at = NOW(3)', [id, event.tenantId, event.connectionId, projectId, kind, externalId, JSON.stringify(event.payload), event.payloadHash, event.id]);
      const [rows] = await pool.execute('SELECT * FROM connector_objects WHERE connection_id = ? AND object_kind = ? AND external_id = ? LIMIT 1', [event.connectionId, kind, externalId]);
      return { duplicate: Boolean(existingRows[0] && existingRows[0].payload_hash === event.payloadHash), object: mapObject(rows[0]) };
    },
    async listConnectorObjects({ tenantId }) { const [rows] = await pool.execute('SELECT * FROM connector_objects WHERE tenant_id = ? ORDER BY updated_at, id', [tenantId]); return rows.map(mapObject); },
    async completeInboundEvent({ eventId, expectedVersion, tenantId }) {
      const [result] = await pool.execute("UPDATE connector_inbound_events SET status = 'processed', attempts = attempts + 1, processed_at = NOW(3), error = '', version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'pending'", [eventId, tenantId, expectedVersion]);
      if (Number(result.affectedRows) !== 1) { const current = await select('connector_inbound_events', eventId, tenantId, mapEvent); if (!current) return null; conflict(current, expectedVersion); }
      return select('connector_inbound_events', eventId, tenantId, mapEvent);
    },
    async resolveConflict({ conflictId, input, tenantId, userId }) {
      const [result] = await pool.execute(
        "UPDATE connector_conflicts SET status = 'resolved', resolution = ?, note = ?, resolved_by = ?, resolved_at = NOW(3), version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?",
        [
          input.resolution,
          input.note,
          userId,
          conflictId,
          tenantId,
          input.expectedVersion,
        ],
      );
      if (Number(result.affectedRows) !== 1) {
        const current = await select(
          'connector_conflicts',
          conflictId,
          tenantId,
          mapConflict,
        );
        if (!current) return null;
        conflict(current, input.expectedVersion);
      }
      return select('connector_conflicts', conflictId, tenantId, mapConflict);
    },
    async updateConnection({ connectionId, input, tenantId }) {
      const current = await select(
        'connector_connections',
        connectionId,
        tenantId,
        mapConnection,
      );
      if (!current) return null;
      if (current.version !== input.expectedVersion)
        conflict(current, input.expectedVersion);
      const next = { ...current, ...input };
      const [result] = await pool.execute(
        'UPDATE connector_connections SET provider = ?, name = ?, auth_type = ?, secret_reference = ?, scopes_json = ?, project_ids_json = ?, settings_json = ?, sync_direction = ?, conflict_policy = ?, status = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?',
        [
          next.provider,
          next.name,
          next.authType,
          next.secretReference,
          JSON.stringify(next.scopes),
          JSON.stringify(next.projectIds),
          JSON.stringify(next.settings),
          next.syncDirection,
          next.conflictPolicy,
          next.status,
          connectionId,
          tenantId,
          input.expectedVersion,
        ],
      );
      if (Number(result.affectedRows) !== 1) {
        const changed = await select(
          'connector_connections',
          connectionId,
          tenantId,
          mapConnection,
        );
        if (!changed) return null;
        conflict(changed, input.expectedVersion);
      }
      return publicConnection(
        await select(
          'connector_connections',
          connectionId,
          tenantId,
          mapConnection,
        ),
      );
    },
    async updateProviderPolicy({ input, policyId, tenantId }) {
      const current = await select('connector_provider_policies', policyId, tenantId, mapPolicy); if (!current) return null; const next = { ...current, ...input };
      let result;
      try {
        [result] = await pool.execute('UPDATE connector_provider_policies SET provider = ?, enabled = ?, allowed_auth_types_json = ?, allowed_directions_json = ?, allowed_scopes_json = ?, data_classification = ?, max_projects = ?, outbound_enabled = ?, approval_required = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?', [next.provider, next.enabled, JSON.stringify(next.allowedAuthTypes), JSON.stringify(next.allowedDirections), JSON.stringify(next.allowedScopes), next.dataClassification, next.maxProjects, next.outboundEnabled, next.approvalRequired, policyId, tenantId, input.expectedVersion]);
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY')
          throw new HttpError(409, 'A connector provider policy already exists.');
        throw error;
      }
      if (Number(result.affectedRows) !== 1) conflict(current, input.expectedVersion); return select('connector_provider_policies', policyId, tenantId, mapPolicy);
    },
  };
}
