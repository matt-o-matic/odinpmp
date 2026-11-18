import assert from 'node:assert/strict';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { createMysqlComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createMysqlConnectorRepository } from '../src/modules/connectors/connector.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL compliance policy is optimistic and evidence rows are immutable', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const parsed = databaseUrl ? new URL(databaseUrl) : null;
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 32)}_compliance_${process.pid}`;
  const options = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(options); await admin.query(`CREATE DATABASE \`${database}\``);
  const isolated = new URL(databaseUrl); isolated.pathname = `/${database}`; const pool = mysql.createPool(isolated.toString());
  try {
    for (const statement of [
      'CREATE TABLE users (id VARCHAR(128) PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) UNIQUE, password VARCHAR(255) NULL, first_name VARCHAR(200) NULL, last_name VARCHAR(200) NULL, job_title VARCHAR(255) NULL, department VARCHAR(255) NULL, bio TEXT NULL, phone VARCHAR(100) NULL, timezone VARCHAR(150) NULL, updated_at DATETIME NULL)',
      'CREATE TABLE user_tenant (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128), tenant_id VARCHAR(36), role VARCHAR(50))',
      'CREATE TABLE tokens (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128))',
      'CREATE TABLE projects (id VARCHAR(128) PRIMARY KEY, tenant_id VARCHAR(36))',
      'CREATE TABLE user_project (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128), project_id VARCHAR(128))',
      'CREATE TABLE preferences (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128), tenant_id VARCHAR(36) NULL, project_id VARCHAR(128) NULL)',
      'CREATE TABLE backup_codes (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128))',
      'CREATE TABLE agent_memory_items (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36), owner_user_id VARCHAR(128), title VARCHAR(255), content TEXT, deleted_at DATETIME(3) NULL, legal_hold BOOLEAN, embedding_model VARCHAR(128) NULL, embedding_dimensions INT NULL, embedding_vector_json JSON NULL, embedding_content_hash CHAR(64) NULL, embedded_at DATETIME(3) NULL, version INT, updated_at DATETIME(3))',
    ]) await pool.execute(statement);
    await applyMysqlMigrations(pool, [
      '0031_connector_platform',
      '0038_connector_marketplace_governance',
      '0039_compliance_evidence',
      '0040_privacy_erasure',
      '0042_connector_erp_posting',
      '0044_compliance_governance',
      '0045_connector_provider_erasure',
    ]);
    const repository = createMysqlComplianceRepository({ pool });
    const tenantId = `tenant-compliance-${process.pid}`;
    const connectorRepository = createMysqlConnectorRepository({ pool }); const connection = await connectorRepository.createConnection({ inboundSecretHash: 'a'.repeat(64), input: { authType: 'oauth2', conflictPolicy: 'manual', name: 'GitHub', projectIds: [], provider: 'github', scopes: ['admin:org'], secretReference: 'env:GITHUB_TOKEN', settings: { organization: 'acme' }, status: 'active', syncDirection: 'bidirectional' }, tenantId, userId: 'admin-1' }); const mapping = await connectorRepository.createMapping({ input: { connectionId: connection.id, externalId: 'external-subject-1', objectType: 'user', odinId: 'subject-1', projectId: 'privacy' }, tenantId });
    const policy = await repository.updatePolicy({
      input: { auditRetentionDays: 730, dataRegion: 'eu', expectedVersion: 0, legalHold: true, privacyDeletionDays: 30, wormRetentionDays: 730 },
      tenantId,
      userId: 'admin-1',
    });
    assert.equal(policy.version, 1); assert.equal(policy.legalHold, true);
    await assert.rejects(repository.updatePolicy({
      input: { auditRetentionDays: 365, dataRegion: 'us', expectedVersion: 0, legalHold: false, privacyDeletionDays: 30, wormRetentionDays: 365 },
      tenantId,
      userId: 'admin-2',
    }), (error) => error.statusCode === 409);
    const evidence = await repository.createAuditExport({
      input: {
        contentHash: 'a'.repeat(64), createdBy: 'admin-1', dataRegion: 'eu', endAt: '2026-07-12T00:00:00.000Z',
        objectKey: 'compliance-evidence-test', objectVersionId: 'version-1', previousExportHash: null, recordCount: 2,
        retentionUntil: '2030-07-11T00:00:00.000Z', rootHash: 'b'.repeat(64), startAt: '2026-07-10T00:00:00.000Z',
      },
      tenantId,
    });
    assert.equal(evidence.recordCount, 2);
    await assert.rejects(pool.execute('UPDATE compliance_evidence_exports SET record_count = 3 WHERE id = ?', [evidence.id]), /immutable/i);
    await assert.rejects(pool.execute('DELETE FROM compliance_evidence_exports WHERE id = ?', [evidence.id]), /immutable/i);
    assert.equal((await repository.listAuditExports({ tenantId })).length, 1);
    await pool.execute("INSERT INTO users (id, name, email, password) VALUES ('subject-1', 'Subject Person', 'subject@example.com', 'hash')");
    await pool.execute("INSERT INTO user_tenant VALUES ('membership-1', 'subject-1', ?, 'user')", [tenantId]);
    await pool.execute("INSERT INTO tokens VALUES ('token-1', 'subject-1')");
    await pool.execute("INSERT INTO agent_memory_items VALUES ('memory-1', ?, 'subject-1', 'Private', 'Personal data', NULL, 0, 'model', 3, '[1,2,3]', ?, NOW(3), 1, NOW(3)), ('memory-held', ?, 'subject-1', 'Held', 'Held data', NULL, 1, 'model', 3, '[1,2,3]', ?, NOW(3), 1, NOW(3))", [tenantId, 'c'.repeat(64), tenantId, 'd'.repeat(64)]);
    await repository.updatePolicy({ input: { auditRetentionDays: 730, dataRegion: 'eu', expectedVersion: 1, legalHold: false, privacyDeletionDays: 30, wormRetentionDays: 730 }, tenantId, userId: 'admin-1' });
    const erasure = await repository.createPrivacyRequest({ input: { reason: 'Verified subject erasure request.', subjectUserId: 'subject-1' }, tenantId, userId: 'admin-1' });
    await assert.rejects(repository.executePrivacyErasure({ expectedVersion: 1, executedBy: 'admin-1', requestId: erasure.id, tenantId }), (error) => error.statusCode === 403);
    const hold = await repository.createLegalHold({ input: { reason: 'Preserve subject for litigation.', resourceId: 'subject-1', resourceType: 'privacy_subject' }, tenantId, userId: 'admin-1' }); await assert.rejects(repository.executePrivacyErasure({ expectedVersion: 1, executedBy: 'admin-2', requestId: erasure.id, tenantId }), /record-scoped legal hold/i); await repository.releaseLegalHold({ expectedVersion: 1, holdId: hold.id, reason: 'Litigation hold released.', tenantId, userId: 'admin-1' });
    const attestation = await repository.createControlAttestation({ input: { controlKey: 'privacy.erasure-review', evidenceRefs: [erasure.id, hold.id], periodEnd: '2026-07-31', periodStart: '2026-07-01', statement: 'Control owner reviewed privacy erasure evidence for the period.' }, tenantId, userId: 'admin-2' }); assert.match(attestation.contentHash, /^[a-f0-9]{64}$/); await assert.rejects(pool.execute('DELETE FROM compliance_control_attestations WHERE id = ?', [attestation.id]), /immutable/i);
    const connectorHold = await repository.createLegalHold({ input: { reason: 'Preserve the provider identity for litigation.', resourceId: mapping.id, resourceType: 'connector_object' }, tenantId, userId: 'admin-1' });
    await assert.rejects(repository.executePrivacyErasure({ expectedVersion: 1, executedBy: 'admin-2', requestId: erasure.id, tenantId }), (error) => error.statusCode === 423 && /connector identity/i.test(error.message));
    await repository.releaseLegalHold({ expectedVersion: 1, holdId: connectorHold.id, reason: 'Provider preservation duty was released.', tenantId, userId: 'admin-1' });
    const completed = await repository.executePrivacyErasure({ expectedVersion: 1, executedBy: 'admin-2', requestId: erasure.id, tenantId });
    assert.equal(completed.status, 'completed'); assert.equal(completed.result.sessionsRevoked, 1); assert.equal(completed.result.memoriesDeleted, 1); assert.equal(completed.result.connectorErasuresQueued, 1); assert.equal((await connectorRepository.listSnapshot({ tenantId })).erasures[0].externalSubjectId, 'external-subject-1');
    const [[subject]] = await pool.execute("SELECT name, email, password FROM users WHERE id = 'subject-1'");
    assert.equal(subject.name, 'Deleted user'); assert.match(subject.email, /^deleted\+[a-f0-9]{24}@privacy\.invalid$/); assert.equal(subject.password, null);
    const [[memory]] = await pool.execute("SELECT deleted_at, embedding_vector_json FROM agent_memory_items WHERE id = 'memory-1'"); assert.ok(memory.deleted_at); assert.equal(memory.embedding_vector_json, null);
    const [[held]] = await pool.execute("SELECT deleted_at FROM agent_memory_items WHERE id = 'memory-held'"); assert.equal(held.deleted_at, null);
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
});
