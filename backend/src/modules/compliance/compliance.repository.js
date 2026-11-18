import { createHash, randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

const clone = (value) => structuredClone(value);
const iso = (value = new Date()) => new Date(value).toISOString();

function conflict(actualVersion, expectedVersion) {
  throw new HttpError(409, 'Compliance policy changed since it was loaded.', {
    details: { actualVersion, code: 'compliance_version_conflict', expectedVersion },
  });
}

const defaultPolicy = (tenantId) => ({
  auditRetentionDays: 365,
  createdAt: null,
  dataRegion: 'us',
  legalHold: false,
  privacyDeletionDays: 30,
  tenantId,
  updatedAt: null,
  updatedBy: null,
  version: 0,
  wormRetentionDays: 365,
});

export function createInMemoryComplianceRepository({ auditEvents = [], subjects = [] } = {}) {
  const state = { attestations: new Map(), auditEvents: clone(auditEvents), exports: new Map(), holds: new Map(), policies: new Map(), privacyRequests: new Map(), subjects: new Map(subjects.map((subject) => [subject.id, clone(subject)])) };
  return {
    state,
    async createAuditExport({ input, tenantId }) {
      const record = { ...clone(input), createdAt: iso(), id: randomUUID(), tenantId };
      state.exports.set(record.id, record);
      return clone(record);
    },
    async getAuditExport({ exportId, tenantId }) {
      const record = state.exports.get(exportId);
      return record?.tenantId === tenantId ? clone(record) : null;
    },
    async getPolicy({ tenantId }) {
      return clone(state.policies.get(tenantId) ?? defaultPolicy(tenantId));
    },
    async getActiveLegalHold({ resourceId, resourceType, tenantId }) {
      const record = [...state.holds.values()].find((item) => item.tenantId === tenantId && item.resourceType === resourceType && item.resourceId === resourceId && item.status === 'active');
      return record ? clone(record) : null;
    },
    async createLegalHold({ input, tenantId, userId }) { const duplicate = [...state.holds.values()].find((item) => item.tenantId === tenantId && item.resourceType === input.resourceType && item.resourceId === input.resourceId && item.status === 'active'); if (duplicate) throw new HttpError(409, 'An active legal hold already covers this record.'); const record = { ...clone(input), createdAt: iso(), createdBy: userId, id: randomUUID(), releasedAt: null, releasedBy: null, releaseReason: '', status: 'active', tenantId, updatedAt: iso(), version: 1 }; state.holds.set(record.id, record); return clone(record); },
    async releaseLegalHold({ expectedVersion, holdId, reason, tenantId, userId }) { const hold = state.holds.get(holdId); if (!hold || hold.tenantId !== tenantId) return null; if (hold.version !== expectedVersion) conflict(hold.version, expectedVersion); if (hold.status !== 'active') throw new HttpError(409, 'Legal hold is already released.'); Object.assign(hold, { releasedAt: iso(), releasedBy: userId, releaseReason: reason, status: 'released', updatedAt: iso(), version: hold.version + 1 }); return clone(hold); },
    async createControlAttestation({ input, tenantId, userId }) { const canonical = JSON.stringify({ ...input, ownerUserId: userId, tenantId }); const record = { ...clone(input), attestedAt: iso(), contentHash: createHash('sha256').update(canonical).digest('hex'), createdAt: iso(), id: randomUUID(), ownerUserId: userId, tenantId }; state.attestations.set(record.id, record); return clone(record); },
    async createPrivacyRequest({ input, tenantId, userId }) {
      const subject = state.subjects.get(input.subjectUserId);
      if (!subject || subject.tenantId !== tenantId || subject.erasedAt) return null;
      if ([...state.privacyRequests.values()].some((request) => request.tenantId === tenantId && request.subjectUserId === subject.id && request.status === 'pending')) throw new HttpError(409, 'A pending privacy erasure request already exists.');
      const record = { completedAt: null, completedBy: null, createdAt: iso(), id: randomUUID(), reason: input.reason, requestedBy: userId, result: null, status: 'pending', subjectUserId: subject.id, tenantId, updatedAt: iso(), version: 1 };
      state.privacyRequests.set(record.id, record); return clone(record);
    },
    async executePrivacyErasure({ expectedVersion, executedBy, requestId, tenantId }) {
      const request = state.privacyRequests.get(requestId); if (!request || request.tenantId !== tenantId) return null;
      if (request.version !== expectedVersion) conflict(request.version, expectedVersion);
      if (request.status !== 'pending') throw new HttpError(409, 'Privacy erasure request is no longer pending.');
      if (request.requestedBy === executedBy) throw new HttpError(403, 'A different tenant administrator must execute privacy erasure.');
      const policy = state.policies.get(tenantId) ?? defaultPolicy(tenantId); if (policy.legalHold) throw new HttpError(409, 'Tenant legal hold blocks privacy erasure.');
      if ([...state.holds.values()].some((item) => item.tenantId === tenantId && item.resourceType === 'privacy_subject' && item.resourceId === request.subjectUserId && item.status === 'active')) throw new HttpError(409, 'A record-scoped legal hold blocks privacy erasure.');
      const subject = state.subjects.get(request.subjectUserId); if (!subject || subject.tenantId !== tenantId || subject.erasedAt) return null;
      if (subject.membershipCount > 1) throw new HttpError(409, 'Cross-tenant identity requires a platform privacy review.');
      if (subject.role === 'admin' && [...state.subjects.values()].filter((item) => item.tenantId === tenantId && item.role === 'admin' && !item.erasedAt).length <= 1) throw new HttpError(409, 'The last tenant administrator cannot be erased.');
      subject.email = `deleted+${shaSubject(tenantId, subject.id)}@privacy.invalid`; subject.erasedAt = iso(); subject.name = 'Deleted user'; subject.sessions = 0;
      Object.assign(request, { completedAt: iso(), completedBy: executedBy, result: { identityPseudonymized: true, sessionsRevoked: true }, status: 'completed', updatedAt: iso(), version: request.version + 1 });
      return clone(request);
    },
    async listAuditEvents({ endDate, limit, startDate, tenantId }) {
      return state.auditEvents
        .filter((event) => event.tenantId === tenantId && event.timestamp >= startDate && event.timestamp < endDate)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone);
    },
    async listSiemEvents({ afterId = '', afterTimestamp, limit, tenantId }) {
      return state.auditEvents
        .filter((event) => event.tenantId === tenantId && (event.timestamp > afterTimestamp || (event.timestamp === afterTimestamp && event.id > afterId)))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone);
    },
    async listAuditExports({ tenantId }) {
      return [...state.exports.values()].filter((record) => record.tenantId === tenantId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
    },
    async listControlAttestations({ tenantId }) { return [...state.attestations.values()].filter((item) => item.tenantId === tenantId).map(clone); },
    async listLegalHolds({ tenantId }) { return [...state.holds.values()].filter((item) => item.tenantId === tenantId).map(clone); },
    async listPrivacyRequests({ tenantId }) { return [...state.privacyRequests.values()].filter((record) => record.tenantId === tenantId).map(clone); },
    async updatePolicy({ input, tenantId, userId }) {
      const current = state.policies.get(tenantId) ?? defaultPolicy(tenantId);
      if (current.version !== input.expectedVersion) conflict(current.version, input.expectedVersion);
      const now = iso();
      const { expectedVersion: _expectedVersion, ...changes } = input;
      const next = { ...current, ...clone(changes), createdAt: current.createdAt ?? now, updatedAt: now, updatedBy: userId, version: current.version + 1 };
      state.policies.set(tenantId, next);
      return clone(next);
    },
  };
}

function shaSubject(tenantId, userId) {
  return createHash('sha256').update(`${tenantId}:${userId}`).digest('hex').slice(0, 24);
}

export async function ensureMysqlComplianceSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS tenant_compliance_policies (
    tenant_id VARCHAR(36) PRIMARY KEY, data_region VARCHAR(16) NOT NULL, audit_retention_days INT NOT NULL,
    privacy_deletion_days INT NOT NULL, worm_retention_days INT NOT NULL, legal_hold BOOLEAN NOT NULL,
    updated_by VARCHAR(128) NOT NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS compliance_evidence_exports (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, object_key VARCHAR(255) NOT NULL,
    object_version_id VARCHAR(255) NULL, start_at DATETIME(3) NOT NULL, end_at DATETIME(3) NOT NULL,
    record_count INT NOT NULL, content_hash CHAR(64) NOT NULL, root_hash CHAR(64) NOT NULL,
    previous_export_hash CHAR(64) NULL, retention_until DATETIME(3) NOT NULL, data_region VARCHAR(16) NOT NULL,
    created_by VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_compliance_export_object (tenant_id, object_key),
    KEY idx_compliance_export_created (tenant_id, created_at),
    KEY idx_compliance_export_retention (tenant_id, retention_until)
  )`);
  const [triggers] = await executor.execute("SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('compliance_exports_no_update', 'compliance_exports_no_delete')");
  const names = new Set(triggers.map((row) => row.trigger_name ?? row.TRIGGER_NAME));
  const runTriggerDdl = (sql) => executor.query ? executor.query(sql) : executor.execute(sql);
  if (!names.has('compliance_exports_no_update')) {
    await runTriggerDdl("CREATE TRIGGER compliance_exports_no_update BEFORE UPDATE ON compliance_evidence_exports FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Compliance evidence exports are immutable'");
  }
  if (!names.has('compliance_exports_no_delete')) {
    await runTriggerDdl("CREATE TRIGGER compliance_exports_no_delete BEFORE DELETE ON compliance_evidence_exports FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Compliance evidence exports are immutable'");
  }
}

export async function ensureMysqlPrivacyErasureSchema(executor) {
  await ensureMysqlComplianceSchema(executor);
  await executor.execute(`CREATE TABLE IF NOT EXISTS privacy_erasure_requests (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, subject_user_id VARCHAR(128) NOT NULL,
    requested_by VARCHAR(128) NOT NULL, reason TEXT NOT NULL, status VARCHAR(24) NOT NULL,
    completed_by VARCHAR(128) NULL, completed_at DATETIME(3) NULL, result_json JSON NULL,
    version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_privacy_erasure_subject (tenant_id, subject_user_id, status),
    KEY idx_privacy_erasure_status (tenant_id, status, created_at)
  )`);
}

export async function ensureMysqlComplianceGovernanceSchema(executor) {
  await ensureMysqlPrivacyErasureSchema(executor);
  await executor.execute(`CREATE TABLE IF NOT EXISTS compliance_legal_holds (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(255) NOT NULL, reason TEXT NOT NULL, status VARCHAR(24) NOT NULL,
    created_by VARCHAR(128) NOT NULL, released_by VARCHAR(128) NULL, released_at DATETIME(3) NULL,
    release_reason TEXT NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_compliance_hold_resource (tenant_id, resource_type, resource_id, status),
    KEY idx_compliance_hold_status (tenant_id, status, created_at)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS compliance_control_attestations (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, control_key VARCHAR(128) NOT NULL,
    period_start DATE NOT NULL, period_end DATE NOT NULL, statement TEXT NOT NULL, evidence_refs_json JSON NOT NULL,
    owner_user_id VARCHAR(128) NOT NULL, content_hash CHAR(64) NOT NULL, attested_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_compliance_attestation (tenant_id, control_key, period_start, period_end, owner_user_id),
    KEY idx_compliance_attestation_period (tenant_id, period_end, control_key)
  )`);
  const [triggers] = await executor.execute("SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('compliance_attestations_no_update', 'compliance_attestations_no_delete')"); const names = new Set(triggers.map((row) => row.trigger_name ?? row.TRIGGER_NAME)); const runTriggerDdl = (sql) => executor.query ? executor.query(sql) : executor.execute(sql);
  if (!names.has('compliance_attestations_no_update')) await runTriggerDdl("CREATE TRIGGER compliance_attestations_no_update BEFORE UPDATE ON compliance_control_attestations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Compliance control attestations are immutable'");
  if (!names.has('compliance_attestations_no_delete')) await runTriggerDdl("CREATE TRIGGER compliance_attestations_no_delete BEFORE DELETE ON compliance_control_attestations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Compliance control attestations are immutable'");
}

const mapPolicy = (row, tenantId) => row ? ({
  auditRetentionDays: Number(row.audit_retention_days), createdAt: iso(row.created_at), dataRegion: row.data_region,
  legalHold: Boolean(row.legal_hold), privacyDeletionDays: Number(row.privacy_deletion_days), tenantId: row.tenant_id,
  updatedAt: iso(row.updated_at), updatedBy: row.updated_by, version: Number(row.version), wormRetentionDays: Number(row.worm_retention_days),
}) : defaultPolicy(tenantId);
const mapExport = (row) => row && ({
  contentHash: row.content_hash, createdAt: iso(row.created_at), createdBy: row.created_by, dataRegion: row.data_region,
  endAt: iso(row.end_at), id: row.id, objectKey: row.object_key, objectVersionId: row.object_version_id,
  previousExportHash: row.previous_export_hash, recordCount: Number(row.record_count), retentionUntil: iso(row.retention_until),
  rootHash: row.root_hash, startAt: iso(row.start_at), tenantId: row.tenant_id,
});
const mapPrivacyRequest = (row) => row && ({ completedAt: row.completed_at ? iso(row.completed_at) : null, completedBy: row.completed_by,
  createdAt: iso(row.created_at), id: row.id, reason: row.reason, requestedBy: row.requested_by,
  result: parseJson(row.result_json), status: row.status, subjectUserId: row.subject_user_id, tenantId: row.tenant_id,
  updatedAt: iso(row.updated_at), version: Number(row.version) });
const mapLegalHold = (row) => row && ({ createdAt: iso(row.created_at), createdBy: row.created_by, id: row.id, reason: row.reason, releaseReason: row.release_reason, releasedAt: row.released_at ? iso(row.released_at) : null, releasedBy: row.released_by, resourceId: row.resource_id, resourceType: row.resource_type, status: row.status, tenantId: row.tenant_id, updatedAt: iso(row.updated_at), version: Number(row.version) });
const mapAttestation = (row) => row && ({ attestedAt: iso(row.attested_at), contentHash: row.content_hash, controlKey: row.control_key, createdAt: iso(row.created_at), evidenceRefs: parseJson(row.evidence_refs_json) ?? [], id: row.id, ownerUserId: row.owner_user_id, periodEnd: String(row.period_end).slice(0, 10), periodStart: String(row.period_start).slice(0, 10), statement: row.statement, tenantId: row.tenant_id });

function parseJson(value) { if (value == null) return null; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return null; } }

export function createMysqlComplianceRepository({ pool }) {
  return {
    async createAuditExport({ input, tenantId }) {
      const id = randomUUID();
      await pool.execute('INSERT INTO compliance_evidence_exports (id, tenant_id, object_key, object_version_id, start_at, end_at, record_count, content_hash, root_hash, previous_export_hash, retention_until, data_region, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))', [id, tenantId, input.objectKey, input.objectVersionId, new Date(input.startAt), new Date(input.endAt), input.recordCount, input.contentHash, input.rootHash, input.previousExportHash, new Date(input.retentionUntil), input.dataRegion, input.createdBy]);
      return this.getAuditExport({ exportId: id, tenantId });
    },
    async getAuditExport({ exportId, tenantId }) {
      const [rows] = await pool.execute('SELECT * FROM compliance_evidence_exports WHERE id = ? AND tenant_id = ? LIMIT 1', [exportId, tenantId]); return mapExport(rows[0]);
    },
    async getPolicy({ tenantId }) {
      const [rows] = await pool.execute('SELECT * FROM tenant_compliance_policies WHERE tenant_id = ? LIMIT 1', [tenantId]); return mapPolicy(rows[0], tenantId);
    },
    async getActiveLegalHold({ resourceId, resourceType, tenantId }) {
      const [rows] = await pool.execute("SELECT * FROM compliance_legal_holds WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND status = 'active' LIMIT 1", [tenantId, resourceType, resourceId]);
      return mapLegalHold(rows[0]);
    },
    async createLegalHold({ input, tenantId, userId }) { const [existing] = await pool.execute("SELECT id FROM compliance_legal_holds WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND status = 'active' LIMIT 1", [tenantId, input.resourceType, input.resourceId]); if (existing[0]) throw new HttpError(409, 'An active legal hold already covers this record.'); const id = randomUUID(); await pool.execute("INSERT INTO compliance_legal_holds (id, tenant_id, resource_type, resource_id, reason, status, created_by, released_by, released_at, release_reason, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, '', 1, NOW(3), NOW(3))", [id, tenantId, input.resourceType, input.resourceId, input.reason, userId]); const [rows] = await pool.execute('SELECT * FROM compliance_legal_holds WHERE id = ?', [id]); return mapLegalHold(rows[0]); },
    async releaseLegalHold({ expectedVersion, holdId, reason, tenantId, userId }) { const [result] = await pool.execute("UPDATE compliance_legal_holds SET status = 'released', released_by = ?, released_at = NOW(3), release_reason = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND status = 'active' AND version = ?", [userId, reason, holdId, tenantId, expectedVersion]); if (Number(result.affectedRows) !== 1) { const [rows] = await pool.execute('SELECT * FROM compliance_legal_holds WHERE id = ? AND tenant_id = ?', [holdId, tenantId]); if (!rows[0]) return null; conflict(Number(rows[0].version), expectedVersion); } const [rows] = await pool.execute('SELECT * FROM compliance_legal_holds WHERE id = ?', [holdId]); return mapLegalHold(rows[0]); },
    async createControlAttestation({ input, tenantId, userId }) { const canonical = JSON.stringify({ ...input, ownerUserId: userId, tenantId }); const contentHash = createHash('sha256').update(canonical).digest('hex'); const id = randomUUID(); try { await pool.execute('INSERT INTO compliance_control_attestations (id, tenant_id, control_key, period_start, period_end, statement, evidence_refs_json, owner_user_id, content_hash, attested_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))', [id, tenantId, input.controlKey, input.periodStart, input.periodEnd, input.statement, JSON.stringify(input.evidenceRefs), userId, contentHash]); } catch (error) { if (error?.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'This control owner already attested the control period.'); throw error; } const [rows] = await pool.execute('SELECT * FROM compliance_control_attestations WHERE id = ?', [id]); return mapAttestation(rows[0]); },
    async createPrivacyRequest({ input, tenantId, userId }) {
      const [memberships] = await pool.execute('SELECT 1 FROM user_tenant WHERE tenant_id = ? AND user_id = ? LIMIT 1', [tenantId, input.subjectUserId]); if (!memberships[0]) return null;
      const [pending] = await pool.execute("SELECT id FROM privacy_erasure_requests WHERE tenant_id = ? AND subject_user_id = ? AND status = 'pending' LIMIT 1", [tenantId, input.subjectUserId]);
      if (pending[0]) throw new HttpError(409, 'A pending privacy erasure request already exists.');
      const id = randomUUID(); await pool.execute("INSERT INTO privacy_erasure_requests (id, tenant_id, subject_user_id, requested_by, reason, status, completed_by, completed_at, result_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 1, NOW(3), NOW(3))", [id, tenantId, input.subjectUserId, userId, input.reason]);
      const [rows] = await pool.execute('SELECT * FROM privacy_erasure_requests WHERE id = ? AND tenant_id = ?', [id, tenantId]); return mapPrivacyRequest(rows[0]);
    },
    async executePrivacyErasure({ expectedVersion, executedBy, requestId, tenantId }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute('SELECT * FROM privacy_erasure_requests WHERE id = ? AND tenant_id = ? FOR UPDATE', [requestId, tenantId]); const request = mapPrivacyRequest(rows[0]);
        if (!request) { await connection.rollback(); return null; }
        if (request.version !== expectedVersion) conflict(request.version, expectedVersion);
        if (request.status !== 'pending') throw new HttpError(409, 'Privacy erasure request is no longer pending.');
        if (request.requestedBy === executedBy) throw new HttpError(403, 'A different tenant administrator must execute privacy erasure.');
        const [policyRows] = await connection.execute('SELECT legal_hold FROM tenant_compliance_policies WHERE tenant_id = ?', [tenantId]); if (Boolean(policyRows[0]?.legal_hold)) throw new HttpError(409, 'Tenant legal hold blocks privacy erasure.');
        const [holdRows] = await connection.execute("SELECT id FROM compliance_legal_holds WHERE tenant_id = ? AND resource_type = 'privacy_subject' AND resource_id = ? AND status = 'active' LIMIT 1", [tenantId, request.subjectUserId]); if (holdRows[0]) throw new HttpError(409, 'A record-scoped legal hold blocks privacy erasure.');
        const [membershipRows] = await connection.execute('SELECT tenant_id, role FROM user_tenant WHERE user_id = ? FOR UPDATE', [request.subjectUserId]);
        const membership = membershipRows.find((row) => row.tenant_id === tenantId); if (!membership) { await connection.rollback(); return null; }
        if (membershipRows.length > 1) throw new HttpError(409, 'Cross-tenant identity requires a platform privacy review.');
        if (membership.role === 'admin') { const [adminRows] = await connection.execute("SELECT COUNT(*) AS count FROM user_tenant WHERE tenant_id = ? AND role = 'admin'", [tenantId]); if (Number(adminRows[0].count) <= 1) throw new HttpError(409, 'The last tenant administrator cannot be erased.'); }
        const counts = {};
        const [connectorHoldRows] = await connection.execute(`SELECT h.id FROM compliance_legal_holds h INNER JOIN connector_mappings m ON m.tenant_id = h.tenant_id AND m.object_type = 'user' AND m.odin_id = ? WHERE h.tenant_id = ? AND h.resource_type = 'connector_object' AND h.status = 'active' AND h.resource_id IN (m.id, m.external_id, CONCAT(m.connection_id, ':', m.external_id)) LIMIT 1`, [request.subjectUserId, tenantId]);
        if (connectorHoldRows[0]) throw new HttpError(423, 'A held connector identity blocks privacy erasure.');
        [counts.connectorErasures] = await connection.execute(`INSERT IGNORE INTO connector_provider_erasure_jobs (id, tenant_id, connection_id, external_subject_id, subject_hash, status, attempts, available_at, lease_worker_id, lease_token, lease_expires_at, provider_evidence_json, error, version, created_at, updated_at) SELECT UUID(), m.tenant_id, m.connection_id, m.external_id, SHA2(CONCAT(?, ':', ?), 256), 'pending', 0, NOW(3), NULL, NULL, NULL, NULL, '', 1, NOW(3), NOW(3) FROM connector_mappings m INNER JOIN connector_connections c ON c.id = m.connection_id AND c.tenant_id = m.tenant_id WHERE m.tenant_id = ? AND m.object_type = 'user' AND m.odin_id = ? AND c.status = 'active'`, [tenantId, request.subjectUserId, tenantId, request.subjectUserId]);
        [counts.sessions] = await connection.execute('DELETE FROM tokens WHERE user_id = ?', [request.subjectUserId]);
        [counts.projectMemberships] = await connection.execute('DELETE up FROM user_project up INNER JOIN projects p ON p.id = up.project_id WHERE up.user_id = ? AND p.tenant_id = ?', [request.subjectUserId, tenantId]);
        [counts.preferences] = await connection.execute('DELETE FROM preferences WHERE user_id = ? AND (tenant_id = ? OR project_id IN (SELECT id FROM projects WHERE tenant_id = ?))', [request.subjectUserId, tenantId, tenantId]);
        [counts.memories] = await connection.execute('UPDATE agent_memory_items SET title = ?, content = ?, deleted_at = NOW(3), embedding_model = NULL, embedding_dimensions = NULL, embedding_vector_json = NULL, embedding_content_hash = NULL, embedded_at = NULL, version = version + 1, updated_at = NOW(3) WHERE tenant_id = ? AND owner_user_id = ? AND legal_hold = 0 AND deleted_at IS NULL', ['Deleted by privacy request', '', tenantId, request.subjectUserId]);
        await connection.execute('DELETE FROM user_tenant WHERE tenant_id = ? AND user_id = ?', [tenantId, request.subjectUserId]);
        await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [request.subjectUserId]);
        await connection.execute('DELETE FROM preferences WHERE user_id = ?', [request.subjectUserId]);
        const pseudonym = `deleted+${shaSubject(tenantId, request.subjectUserId)}@privacy.invalid`;
        await connection.execute("UPDATE users SET name = 'Deleted user', email = ?, password = NULL, first_name = NULL, last_name = NULL, job_title = NULL, department = NULL, bio = NULL, phone = NULL, timezone = NULL, updated_at = NOW() WHERE id = ?", [pseudonym, request.subjectUserId]);
        const result = { connectorErasuresQueued: Number(counts.connectorErasures?.affectedRows ?? 0), identityPseudonymized: true, memoriesDeleted: Number(counts.memories.affectedRows), projectMembershipsRemoved: Number(counts.projectMemberships.affectedRows), sessionsRevoked: Number(counts.sessions.affectedRows) };
        await connection.execute("UPDATE privacy_erasure_requests SET status = 'completed', completed_by = ?, completed_at = NOW(3), result_json = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND version = ?", [executedBy, JSON.stringify(result), requestId, expectedVersion]);
        await connection.commit(); const [completed] = await pool.execute('SELECT * FROM privacy_erasure_requests WHERE id = ? AND tenant_id = ?', [requestId, tenantId]); return mapPrivacyRequest(completed[0]);
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async listAuditEvents({ endDate, limit, startDate, tenantId }) {
      const bounded = Math.max(1, Math.min(100_001, Number(limit) || 100_001));
      const [rows] = await pool.execute(`SELECT a.id, a.dt_stamp, a.user_id, a.project_id, a.ip_addr, a.action, a.result, a.detail
        FROM audit_log a WHERE a.dt_stamp >= ? AND a.dt_stamp < ? AND (
          a.tenant_id = ? OR a.user_id IN (SELECT user_id FROM user_tenant WHERE tenant_id = ?)
          OR a.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
        ) ORDER BY a.dt_stamp, a.id LIMIT ${bounded}`, [new Date(startDate), new Date(endDate), tenantId, tenantId, tenantId]);
      return rows.map((row) => ({ action: row.action, detail: row.detail ?? null, id: row.id, ipAddress: row.ip_addr, projectId: row.project_id, result: row.result, tenantId, timestamp: iso(row.dt_stamp), userId: row.user_id }));
    },
    async listSiemEvents({ afterId = '', afterTimestamp, limit, tenantId }) {
      const bounded = Math.max(1, Math.min(1000, Number(limit) || 100)); const after = new Date(afterTimestamp);
      const [rows] = await pool.execute(`SELECT a.id, a.dt_stamp, a.user_id, a.project_id, a.ip_addr, a.action, a.result, a.detail
        FROM audit_log a WHERE (a.dt_stamp > ? OR (a.dt_stamp = ? AND a.id > ?)) AND (
          a.tenant_id = ? OR a.user_id IN (SELECT user_id FROM user_tenant WHERE tenant_id = ?)
          OR a.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
        ) ORDER BY a.dt_stamp, a.id LIMIT ${bounded}`, [after, after, afterId, tenantId, tenantId, tenantId]);
      return rows.map((row) => ({ action: row.action, detail: row.detail ?? null, id: row.id, ipAddress: row.ip_addr, projectId: row.project_id, result: row.result, tenantId, timestamp: iso(row.dt_stamp), userId: row.user_id }));
    },
    async listAuditExports({ tenantId }) {
      const [rows] = await pool.execute('SELECT * FROM compliance_evidence_exports WHERE tenant_id = ? ORDER BY created_at, id', [tenantId]); return rows.map(mapExport);
    },
    async listPrivacyRequests({ tenantId }) { const [rows] = await pool.execute('SELECT * FROM privacy_erasure_requests WHERE tenant_id = ? ORDER BY created_at, id', [tenantId]); return rows.map(mapPrivacyRequest); },
    async listControlAttestations({ tenantId }) { const [rows] = await pool.execute('SELECT * FROM compliance_control_attestations WHERE tenant_id = ? ORDER BY period_end, control_key, id', [tenantId]); return rows.map(mapAttestation); },
    async listLegalHolds({ tenantId }) { const [rows] = await pool.execute('SELECT * FROM compliance_legal_holds WHERE tenant_id = ? ORDER BY created_at, id', [tenantId]); return rows.map(mapLegalHold); },
    async updatePolicy({ input, tenantId, userId }) {
      const current = await this.getPolicy({ tenantId }); const { expectedVersion, ...next } = input;
      if (current.version !== expectedVersion) conflict(current.version, expectedVersion);
      if (current.version === 0) {
        try { await pool.execute('INSERT INTO tenant_compliance_policies (tenant_id, data_region, audit_retention_days, privacy_deletion_days, worm_retention_days, legal_hold, updated_by, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))', [tenantId, next.dataRegion, next.auditRetentionDays, next.privacyDeletionDays, next.wormRetentionDays, next.legalHold, userId]); }
        catch (error) { if (error?.code === 'ER_DUP_ENTRY') conflict(1, expectedVersion); throw error; }
      } else {
        const [result] = await pool.execute('UPDATE tenant_compliance_policies SET data_region = ?, audit_retention_days = ?, privacy_deletion_days = ?, worm_retention_days = ?, legal_hold = ?, updated_by = ?, version = version + 1, updated_at = NOW(3) WHERE tenant_id = ? AND version = ?', [next.dataRegion, next.auditRetentionDays, next.privacyDeletionDays, next.wormRetentionDays, next.legalHold, userId, tenantId, expectedVersion]);
        if (Number(result.affectedRows) !== 1) { const changed = await this.getPolicy({ tenantId }); conflict(changed.version, expectedVersion); }
      }
      return this.getPolicy({ tenantId });
    },
  };
}
