import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture({ region = '' } = {}) {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'reviewer@example.com', id: 'reviewer', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Reviewer', password: 'Secret123!' },
    { authMethod: 'basic', email: 'member@example.com', id: 'member', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Member', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }],
    users,
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'compliance-test', secret: 'compliance-test-secret-that-is-long-enough' });
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token);
  }
  const complianceRepository = createInMemoryComplianceRepository({ auditEvents: [
    { action: 'project.update', detail: '{"fields":["name"]}', id: 'audit-1', ipAddress: '127.0.0.1', projectId: 'project-1', result: 'success:200', tenantId: 'tenant-1', timestamp: '2026-07-10T12:00:00.000Z', userId: 'admin' },
    { action: 'connector.approve', detail: null, id: 'audit-2', ipAddress: '127.0.0.1', projectId: null, result: 'success:200', tenantId: 'tenant-1', timestamp: '2026-07-11T12:00:00.000Z', userId: 'admin' },
  ], subjects: [{ email: 'member@example.com', id: 'member', membershipCount: 1, name: 'Member', role: 'user', sessions: 2, tenantId: 'tenant-1' }] });
  const objects = new Map();
  const fileStorage = {
    region,
    async read(key) { const bytes = objects.get(key); if (!bytes) throw new Error('missing'); return { bytes, size: bytes.length, versionId: 'version-1' }; },
    async verifyImmutable() { return { objectLock: 'Enabled' }; },
    async writeImmutable(key, bytes) { objects.set(key, Buffer.from(bytes)); return { versionId: 'version-1' }; },
  };
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, complianceRepository, domainEventSweepIntervalMs: 0, fileStorage, sessionsRepository, tokenService });
  return { app, authorization: (id) => `Bearer ${tokens.get(id)}`, complianceRepository, objects };
}

test('compliance API creates immutable hash-chained audit evidence under tenant policy', async () => {
  const { app, authorization, complianceRepository, objects } = await fixture(); const admin = authorization('admin'); const reviewer = authorization('reviewer');
  assert.equal((await request(app).get('/api/compliance').set('Authorization', authorization('member'))).status, 404);
  const initial = await request(app).get('/api/compliance').set('Authorization', admin);
  assert.equal(initial.status, 200); assert.equal(initial.body.policy.version, 0);
  const policy = await request(app).put('/api/compliance/policy').set('Authorization', admin).send({ auditRetentionDays: 730, dataRegion: 'eu', expectedVersion: 0, legalHold: true, privacyDeletionDays: 30, wormRetentionDays: 730 });
  assert.equal(policy.status, 200); assert.equal(policy.body.value.dataRegion, 'eu'); assert.equal(policy.body.value.version, 1);
  assert.equal((await request(app).put('/api/compliance/policy').set('Authorization', admin).send({ auditRetentionDays: 365, dataRegion: 'us', expectedVersion: 0, legalHold: false, privacyDeletionDays: 30, wormRetentionDays: 365 })).status, 409);
  const created = await request(app).post('/api/compliance/audit-exports').set('Authorization', admin).send({ endDate: '2026-07-11', startDate: '2026-07-10' });
  assert.equal(created.status, 201); assert.equal(created.body.manifest.recordCount, 2); assert.equal(created.body.manifest.dataRegion, 'eu');
  const bytes = objects.get(created.body.manifest.objectKey); const artifact = JSON.parse(bytes.toString('utf8'));
  assert.equal(artifact.manifest.format, 'odin.audit-evidence.v1'); assert.equal(artifact.records.length, 2);
  assert.equal(artifact.records[0].previousHash, '0'.repeat(64)); assert.equal(artifact.records[1].previousHash, artifact.records[0].hash);
  const downloaded = await request(app).get(`/api/compliance/audit-exports/${created.body.manifest.id}/content`).set('Authorization', admin);
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, artifact);
  const chained = await request(app).post('/api/compliance/audit-exports').set('Authorization', admin).send({ endDate: '2026-07-11', startDate: '2026-07-10' });
  assert.equal(chained.status, 201); assert.equal(chained.body.manifest.previousExportHash, created.body.manifest.contentHash);
  const erasure = await request(app).post('/api/compliance/privacy-erasure-requests').set('Authorization', admin).send({ reason: 'Verified data subject erasure request.', subjectUserId: 'member' });
  assert.equal(erasure.status, 201); assert.equal(erasure.body.value.status, 'pending');
  assert.equal((await request(app).post(`/api/compliance/privacy-erasure-requests/${erasure.body.value.id}/execute`).set('Authorization', admin).send({ expectedVersion: 1 })).status, 403);
  assert.equal((await request(app).post(`/api/compliance/privacy-erasure-requests/${erasure.body.value.id}/execute`).set('Authorization', reviewer).send({ expectedVersion: 1 })).status, 409);
  const released = await request(app).put('/api/compliance/policy').set('Authorization', admin).send({ auditRetentionDays: 730, dataRegion: 'eu', expectedVersion: 1, legalHold: false, privacyDeletionDays: 30, wormRetentionDays: 730 });
  assert.equal(released.status, 200);
  const hold = await request(app).post('/api/compliance/legal-holds').set('Authorization', admin).send({ reason: 'Preserve the subject record for active litigation.', resourceId: 'member', resourceType: 'privacy_subject' }); assert.equal(hold.status, 201);
  assert.equal((await request(app).post(`/api/compliance/privacy-erasure-requests/${erasure.body.value.id}/execute`).set('Authorization', reviewer).send({ expectedVersion: 1 })).status, 409);
  const attestation = await request(app).post('/api/compliance/control-attestations').set('Authorization', reviewer).send({ controlKey: 'privacy.erasure-review', evidenceRefs: [erasure.body.value.id, hold.body.value.id], periodEnd: '2026-07-11', periodStart: '2026-07-01', statement: 'I reviewed the privacy erasure and active legal-hold evidence for this control period.' }); assert.equal(attestation.status, 201); assert.match(attestation.body.value.contentHash, /^[a-f0-9]{64}$/);
  assert.equal((await request(app).post(`/api/compliance/legal-holds/${hold.body.value.id}/release`).set('Authorization', admin).send({ expectedVersion: 1, reason: 'Litigation preservation requirement was formally released.' })).status, 200);
  const erased = await request(app).post(`/api/compliance/privacy-erasure-requests/${erasure.body.value.id}/execute`).set('Authorization', reviewer).send({ expectedVersion: 1 });
  assert.equal(erased.status, 200); assert.equal(erased.body.value.status, 'completed'); assert.equal(erased.body.value.completedBy, 'reviewer');
  assert.equal(complianceRepository.state.subjects.get('member').name, 'Deleted user'); assert.equal(complianceRepository.state.subjects.get('member').sessions, 0);
  objects.set(created.body.manifest.objectKey, Buffer.from('{}'));
  assert.equal((await request(app).get(`/api/compliance/audit-exports/${created.body.manifest.id}/content`).set('Authorization', admin)).status, 409);
});

test('compliance export fails closed when object storage conflicts with tenant residency policy', async () => {
  const { app, authorization } = await fixture({ region: 'us-east-1' }); const admin = authorization('admin');
  await request(app).put('/api/compliance/policy').set('Authorization', admin).send({ auditRetentionDays: 365, dataRegion: 'eu', expectedVersion: 0, legalHold: false, privacyDeletionDays: 30, wormRetentionDays: 365 });
  assert.equal((await request(app).post('/api/compliance/audit-exports').set('Authorization', admin).send({ endDate: '2026-07-11', startDate: '2026-07-10' })).status, 409);
});
