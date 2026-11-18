import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAgentMemoryRepository } from '../src/modules/memory/agent-memory.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture({ auditWriter = null, memoryEmbeddingProvider = null } = {}) {
  const projectIds = {
    launch: randomUUID(),
    secret: randomUUID(),
  };
  const users = [
    { authMethod: 'basic', email: 'owner@example.com', id: 'owner', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Owner', password: 'Secret123!' },
    { authMethod: 'basic', email: 'viewer@example.com', id: 'viewer', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Viewer', password: 'Secret123!' },
    { authMethod: 'basic', email: 'other@example.com', id: 'other', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Other', password: 'Secret123!' },
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: {
      [projectIds.launch]: [{ id: 'owner', role: 'editor' }, { id: 'viewer', role: 'viewer' }],
      [projectIds.secret]: [{ id: 'other', role: 'editor' }],
    },
    projects: [
      { epics: [], id: projectIds.launch, name: 'Launch', tenantId: 'tenant-1' },
      { epics: [], id: projectIds.secret, name: 'Secret', tenantId: 'tenant-1' },
    ],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'agent-memory-test-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository(); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const agentMemoryRepository = createInMemoryAgentMemoryRepository();
  return {
    agentMemoryRepository,
    app: createApp({ agentMemoryRepository, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, auditWriter, authRepository, memoryEmbeddingProvider, projectRepository, sessionsRepository, tokenService }),
    authorization: (id) => `Bearer ${tokens.get(id)}`,
    projectIds,
  };
}

const memory = (projectId, title, sensitivity = 'internal') => ({ confidence: 0.9, content: `${title} evidence and rationale`, memoryType: 'decision', projectId, provenance: { sourceId: 'decision-1', sourceType: 'decision_register' }, sensitivity, sourceAt: '2026-07-11T12:00:00Z', title });

test('agent memory search is project-permission aware and hides restricted records', async () => {
  const { app, authorization, projectIds } = await fixture();
  assert.equal((await request(app).post('/api/agent-memory').set('Authorization', authorization('owner')).send(memory(projectIds.launch, 'Launch vendor decision'))).status, 201);
  assert.equal((await request(app).post('/api/agent-memory').set('Authorization', authorization('owner')).send(memory(projectIds.launch, 'Launch restricted decision', 'restricted'))).status, 201);
  assert.equal((await request(app).post('/api/agent-memory').set('Authorization', authorization('other')).send(memory(projectIds.secret, 'Launch confidential program'))).status, 201);

  const viewer = await request(app).get('/api/agent-memory?query=launch').set('Authorization', authorization('viewer'));
  assert.equal(viewer.status, 200);
  assert.deepEqual(viewer.body.memories.map((item) => item.title), ['Launch vendor decision']);
  const owner = await request(app).get(`/api/agent-memory?query=launch&projectIds=${projectIds.launch}`).set('Authorization', authorization('owner'));
  assert.equal(owner.body.memories.length, 2);
  assert.equal((await request(app).get(`/api/agent-memory?query=launch&projectIds=${projectIds.secret}`).set('Authorization', authorization('viewer'))).status, 404);
});

test('agent memory hybrid search retrieves conceptual matches after ACL filtering and never returns vectors', async () => {
  const memoryEmbeddingProvider = { async embed({ content }) { return { contentHash: 'a'.repeat(64), dimensions: 2, embeddedAt: '2026-07-11T12:00:00.000Z', model: 'test-embedding', vector: /unrelated/i.test(content) ? [0, 1] : [1, 0] }; } };
  const { app, authorization, projectIds } = await fixture({ memoryEmbeddingProvider });
  const created = await request(app).post('/api/agent-memory').set('Authorization', authorization('owner')).send(memory(projectIds.launch, 'Vendor fallback decision'));
  assert.equal(created.body.embeddingStatus, 'indexed');
  assert.equal(created.body.memory.embedding.model, 'test-embedding');
  assert.equal('vector' in created.body.memory.embedding, false);
  await request(app).post('/api/agent-memory').set('Authorization', authorization('other')).send(memory(projectIds.secret, 'Supplier contingency'));
  const result = await request(app).get('/api/agent-memory?query=conceptual%20continuity').set('Authorization', authorization('viewer'));
  assert.equal(result.body.retrievalMode, 'hybrid');
  assert.deepEqual(result.body.memories.map((item) => item.title), ['Vendor fallback decision']);
  assert.equal(result.body.memories[0].retrievalMode, 'semantic');
  assert.equal('vector' in result.body.memories[0].embedding, false);
});

test('agent memory forget is soft, versioned, and removes retrieval', async () => {
  const { app, authorization, projectIds } = await fixture();
  const created = await request(app).post('/api/agent-memory').set('Authorization', authorization('owner')).send(memory(projectIds.launch, 'Launch rollback decision'));
  const id = created.body.memory.id;
  const forgotten = await request(app).delete(`/api/agent-memory/${id}`).set('Authorization', authorization('owner')).send({ expectedVersion: 1 });
  assert.equal(forgotten.status, 200);
  assert.equal((await request(app).get('/api/agent-memory?query=rollback').set('Authorization', authorization('owner'))).body.memories.length, 0);
  assert.equal((await request(app).delete(`/api/agent-memory/${id}`).set('Authorization', authorization('owner')).send({ expectedVersion: 1 })).status, 404);
});

test('agent memory retention is admin-governed, legal-hold safe, and purgeable after release', async () => {
  const { app, authorization, projectIds } = await fixture();
  const created = await request(app).post('/api/agent-memory').set('Authorization', authorization('owner')).send(memory(projectIds.launch, 'Retained launch decision'));
  const id = created.body.memory.id;
  const held = await request(app).patch(`/api/agent-memory/${id}/governance`).set('Authorization', authorization('admin')).send({
    expectedVersion: 1, expiresAt: '2026-01-01T00:00:00Z', legalHold: true, retentionPolicyId: 'legal-case-42',
  });
  assert.equal(held.status, 200);
  assert.equal(held.body.memory.legalHold, true);
  assert.equal((await request(app).delete(`/api/agent-memory/${id}`).set('Authorization', authorization('owner')).send({ expectedVersion: 2 })).status, 423);
  assert.equal((await request(app).get('/api/agent-memory?query=retained').set('Authorization', authorization('owner'))).body.memories.length, 1);
  assert.equal((await request(app).post('/api/agent-memory/purge-expired').set('Authorization', authorization('viewer')).send({})).status, 404);

  const released = await request(app).patch(`/api/agent-memory/${id}/governance`).set('Authorization', authorization('admin')).send({ expectedVersion: 2, legalHold: false });
  assert.equal(released.status, 200);
  const purge = await request(app).post('/api/agent-memory/purge-expired').set('Authorization', authorization('admin')).send({ cutoffAt: '2026-07-11T00:00:00Z' });
  assert.equal(purge.status, 200);
  assert.equal(purge.body.purgedCount, 1);
  assert.equal((await request(app).get('/api/agent-memory?query=retained').set('Authorization', authorization('owner'))).body.memories.length, 0);
});

test('agent memory browse lists without a query, filters, paginates, and reports permissions', async () => {
  const { app, authorization, projectIds } = await fixture();
  const post = (user, body) => request(app).post('/api/agent-memory').set('Authorization', authorization(user)).send(body);
  await post('owner', { ...memory(projectIds.launch, 'Vendor decision'), sourceAt: '2026-07-01T00:00:00Z' });
  await post('owner', { ...memory(projectIds.launch, 'Budget risk'), memoryType: 'risk', sensitivity: 'confidential', sourceAt: '2026-07-02T00:00:00Z' });
  await post('owner', { ...memory(projectIds.launch, 'Owner-only note', 'restricted'), sourceAt: '2026-07-03T00:00:00Z' });
  await post('owner', { ...memory(null, 'Prefers short summaries'), memoryType: 'preference', sourceAt: '2026-07-04T00:00:00Z' });
  await post('other', memory(projectIds.secret, 'Secret program'));

  const browse = (user, query = '') => request(app).get(`/api/agent-memory/browse${query}`).set('Authorization', authorization(user));
  const owner = await browse('owner');
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.memories.map((item) => item.title), ['Prefers short summaries', 'Owner-only note', 'Budget risk', 'Vendor decision']);
  assert.equal(owner.body.total, 4);
  assert.deepEqual(owner.body.permissions, { canGovern: false, editableProjectIds: [projectIds.launch] });
  assert.equal(owner.body.memories[2].projectName, 'Launch');
  assert.equal(owner.body.memories[2].canForget, true);
  assert.equal('vector' in (owner.body.memories[2].embedding ?? {}), false);

  const viewer = await browse('viewer');
  assert.deepEqual(viewer.body.memories.map((item) => item.title), ['Budget risk', 'Vendor decision']);
  assert.equal(viewer.body.memories[0].canForget, false);
  assert.deepEqual(viewer.body.permissions.editableProjectIds, []);

  const page = await browse('owner', '?limit=2&offset=2&sort=oldest');
  assert.deepEqual(page.body.memories.map((item) => item.title), ['Owner-only note', 'Prefers short summaries']);
  assert.equal(page.body.total, 4);
  assert.deepEqual((await browse('owner', '?types=risk,decision&sensitivities=confidential')).body.memories.map((item) => item.title), ['Budget risk']);
  assert.deepEqual((await browse('owner', '?project=personal')).body.memories.map((item) => item.title), ['Prefers short summaries']);
  assert.deepEqual((await browse('owner', `?project=${projectIds.launch}&query=VENDOR`)).body.memories.map((item) => item.title), ['Vendor decision']);
  assert.equal((await browse('viewer', `?project=${projectIds.secret}`)).status, 404);
  assert.equal((await browse('owner', '?types=unknown')).status, 400);

  const admin = await browse('admin');
  assert.equal(admin.body.permissions.canGovern, true);
  assert.ok(admin.body.memories.some((item) => item.title === 'Owner-only note'));
  assert.ok(admin.body.memories.some((item) => item.title === 'Secret program'));
  assert.equal(admin.body.memories.some((item) => item.title === 'Prefers short summaries'), false);
});

test('agent memory correction is versioned, re-indexed, permission-checked, hold-safe, and audited', async () => {
  const auditEvents = [];
  const memoryEmbeddingProvider = { async embed({ content }) { return { contentHash: 'b'.repeat(64), dimensions: 2, embeddedAt: '2026-07-11T12:00:00.000Z', model: 'test-embedding', vector: /corrected/i.test(content) ? [0, 1] : [1, 0] }; } };
  const { agentMemoryRepository, app, authorization, projectIds } = await fixture({ auditWriter: { async append(event) { auditEvents.push(event); } }, memoryEmbeddingProvider });
  const created = await request(app).post('/api/agent-memory').set('Authorization', authorization('owner')).send(memory(projectIds.launch, 'Launch date decision'));
  const id = created.body.memory.id;
  const patch = (user, body) => request(app).patch(`/api/agent-memory/${id}`).set('Authorization', authorization(user)).send(body);

  assert.equal((await patch('viewer', { content: 'Viewer rewrite', expectedVersion: 1 })).status, 404);
  assert.equal((await patch('owner', { expectedVersion: 1 })).status, 400);
  const corrected = await patch('owner', { content: 'Corrected: launch moves to September', expectedVersion: 1, memoryType: 'change' });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.memory.version, 2);
  assert.equal(corrected.body.memory.content, 'Corrected: launch moves to September');
  assert.equal(corrected.body.memory.memoryType, 'change');
  assert.equal(corrected.body.embeddingStatus, 'indexed');
  assert.equal('vector' in corrected.body.memory.embedding, false);
  assert.deepEqual(agentMemoryRepository.state.get(id).embedding.vector, [0, 1]);
  assert.deepEqual(corrected.body.memory.provenance.corrections.map((entry) => ({ by: entry.by, fields: entry.fields, previousVersion: entry.previousVersion })), [{ by: 'owner', fields: ['content', 'memoryType'], previousVersion: 1 }]);
  assert.equal(corrected.body.memory.provenance.sourceType, 'decision_register');

  const audit = auditEvents.find((event) => event.action.startsWith('http.patch.') && event.result === 'success:200');
  assert.equal(audit.userId, 'owner');
  assert.deepEqual(audit.detail.after.fields, ['content', 'memoryType']);
  assert.equal(audit.detail.before.version, 1);
  assert.equal(JSON.stringify(audit.detail).includes('September'), false);

  assert.equal((await patch('owner', { content: 'Stale edit', expectedVersion: 1 })).status, 409);
  await request(app).patch(`/api/agent-memory/${id}/governance`).set('Authorization', authorization('admin')).send({ expectedVersion: 2, legalHold: true });
  assert.equal((await patch('owner', { content: 'Edit under hold', expectedVersion: 3 })).status, 423);
  const browse = await request(app).get('/api/agent-memory/browse').set('Authorization', authorization('owner'));
  assert.equal(browse.body.memories[0].canCorrect, false);
  assert.equal(browse.body.memories[0].canForget, false);
});
