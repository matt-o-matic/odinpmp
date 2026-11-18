import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryIdentityRepository } from '../src/modules/identity/identity.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryPlatformRepository } from '../src/modules/platform/platform.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture() {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'member@example.com', id: 'member', memberships: [{ role: 'user', tenantId }], name: 'Member', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ id: tenantId, name: 'Tenant' }], users });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'platform-test', secret: 'platform-test-secret-is-long-enough' });
  const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken({ ...user, tenantId }); const payload = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(payload.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const platformRepository = createInMemoryPlatformRepository();
  const complianceRepository = createInMemoryComplianceRepository({ auditEvents: [
    { action: 'project.update', detail: null, id: 'audit-1', ipAddress: '127.0.0.1', projectId: 'project-1', result: 'success:200', tenantId, timestamp: '2026-07-10T12:00:00.000Z', userId: 'admin' },
    { action: 'connector.approve', detail: null, id: 'audit-2', ipAddress: '127.0.0.1', projectId: null, result: 'success:200', tenantId, timestamp: '2026-07-11T12:00:00.000Z', userId: 'admin' },
    { action: 'other.tenant', detail: null, id: 'audit-3', ipAddress: '127.0.0.1', projectId: null, result: 'success:200', tenantId: 'other-tenant', timestamp: '2026-07-11T13:00:00.000Z', userId: 'other' },
  ] });
  const identityRepository = createInMemoryIdentityRepository();
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [{ epics: [], id: 'project-1', name: 'Allowed', status: 'In Progress', tenantId }, { epics: [], id: 'project-2', name: 'Excluded', status: 'At Risk', tenantId }] } });
  const calls = [];
  const app = createApp({ authRepository, complianceRepository, identityRepository, platformRepository, postWebhook: async (call) => { calls.push(call); return { status: calls.length === 1 ? 503 : 204 }; }, projectRepository, sessionsRepository, tokenService, webhookSigningMasterSecret: 'platform-test-webhook-master-secret', webhookSweepIntervalMs: 0 });
  return { admin: `Bearer ${tokens.get('admin')}`, app, calls, identityRepository, member: `Bearer ${tokens.get('member')}`, platformRepository, tenantId };
}

test('platform APIs govern OAuth clients, scoped project access, signed webhook retries, DLQ, and replay', async () => {
  const { admin, app, calls, identityRepository, member, platformRepository, tenantId } = await fixture();
  assert.equal((await request(app).get('/api/integrations').set('Authorization', member)).status, 404);
  const delegatedRole = await identityRepository.createRole({ input: { capabilities: ['integrations.manage'], description: 'Manage integrations.', key: 'integration_admin', name: 'Integration administrator' }, tenantId });
  const delegatedGroup = await identityRepository.createGroup({ input: { description: 'Delegated integration administrators.', externalId: '', name: 'Integration administrators', roleKeys: [delegatedRole.key] }, tenantId });
  await identityRepository.addGroupMember({ groupId: delegatedGroup.id, tenantId, userId: 'member' });
  assert.equal((await request(app).get('/api/integrations').set('Authorization', member)).status, 200);

  const created = await request(app).post('/api/integrations/oauth-applications').set('Authorization', admin).send({ name: 'Project reader', projectIds: ['project-1'], scopes: ['projects.read'] });
  assert.equal(created.status, 201); assert.match(created.body.clientSecret, /^odin_oauth_secret_/); assert.match(created.body.value.clientId, /^odin_client_/);
  const basic = Buffer.from(`${created.body.value.clientId}:${created.body.clientSecret}`).toString('base64');
  const deniedScope = await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${basic}`).type('form').send({ grant_type: 'client_credentials', scope: 'reporting.read' });
  assert.equal(deniedScope.status, 400);
  const exchanged = await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${basic}`).type('form').send({ grant_type: 'client_credentials', scope: 'projects.read' });
  assert.equal(exchanged.status, 200); assert.match(exchanged.body.access_token, /^odin_oauth_/); assert.equal(exchanged.headers['cache-control'], 'no-store');
  const oauth = `Bearer ${exchanged.body.access_token}`;
  const projects = await request(app).get('/api/v1/projects').set('Authorization', oauth);
  assert.equal(projects.status, 200); assert.deepEqual(projects.body.data.map((project) => project.id), ['project-1']);
  assert.equal((await request(app).get('/api/v1/audit-events').set('Authorization', oauth)).status, 403);
  assert.equal((await request(app).get('/api/v1/platform/me').set('Authorization', oauth)).body.application.name, 'Project reader');

  const siem = await request(app).post('/api/integrations/oauth-applications').set('Authorization', admin).send({ name: 'SIEM reader', projectIds: [], scopes: ['audit.read'] });
  const siemBasic = Buffer.from(`${siem.body.value.clientId}:${siem.body.clientSecret}`).toString('base64');
  const siemExchange = await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${siemBasic}`).type('form').send({ grant_type: 'client_credentials', scope: 'audit.read' });
  const siemOauth = `Bearer ${siemExchange.body.access_token}`;
  const firstAuditPage = await request(app).get('/api/v1/audit-events?limit=1').set('Authorization', siemOauth);
  assert.equal(firstAuditPage.status, 200); assert.deepEqual(firstAuditPage.body.data.map((event) => event.id), ['audit-1']); assert.ok(firstAuditPage.body.nextCursor);
  const secondAuditPage = await request(app).get(`/api/v1/audit-events?limit=10&cursor=${encodeURIComponent(firstAuditPage.body.nextCursor)}`).set('Authorization', siemOauth);
  assert.deepEqual(secondAuditPage.body.data.map((event) => event.id), ['audit-2']);
  assert.equal((await request(app).get('/api/v1/audit-events?cursor=invalid').set('Authorization', siemOauth)).status, 400);

  const redirectUri = 'https://client.example.com/oauth/callback';
  const writer = await request(app).post('/api/integrations/oauth-applications').set('Authorization', admin).send({ name: 'Project writer', projectIds: ['project-1'], redirectUris: [redirectUri], scopes: ['projects.read', 'projects.write'] });
  const writerBasic = Buffer.from(`${writer.body.value.clientId}:${writer.body.clientSecret}`).toString('base64');
  const verifier = 'pkce-verifier-value-that-is-at-least-forty-three-characters-long'; const challenge = createHash('sha256').update(verifier).digest('base64url');
  const consent = await request(app).post('/api/v1/oauth/authorize').set('Authorization', admin).send({ approved: true, clientId: writer.body.value.clientId, codeChallenge: challenge, codeChallengeMethod: 'S256', redirectUri, scope: 'projects.read', state: 'state-123456' });
  assert.equal(consent.status, 200); assert.equal(consent.headers['cache-control'], 'no-store');
  const code = new URL(consent.body.redirectTo).searchParams.get('code'); assert.match(code, /^odin_code_/);
  assert.equal((await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${writerBasic}`).type('form').send({ code, code_verifier: 'wrong-verifier-value-that-is-at-least-forty-three-characters', grant_type: 'authorization_code', redirect_uri: redirectUri })).status, 400);
  const delegatedExchange = await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${writerBasic}`).type('form').send({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
  assert.equal(delegatedExchange.status, 200); const delegated = `Bearer ${delegatedExchange.body.access_token}`;
  const delegatedMe = await request(app).get('/api/v1/platform/me').set('Authorization', delegated); assert.equal(delegatedMe.body.delegatedUserId, 'admin');
  assert.deepEqual((await request(app).get('/api/v1/projects').set('Authorization', delegated)).body.data.map((project) => project.id), ['project-1']);
  assert.equal((await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${writerBasic}`).type('form').send({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri })).status, 400);
  const writerExchange = await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${writerBasic}`).type('form').send({ grant_type: 'client_credentials', scope: 'projects.write' });
  const writerOauth = `Bearer ${writerExchange.body.access_token}`; const mutation = { impact: 'high', kind: 'risk', title: 'Vendor capacity' };
  const firstMutation = await request(app).post('/api/v1/projects/project-1/governance-items').set('Authorization', writerOauth).set('Idempotency-Key', 'risk-create-001').send(mutation);
  assert.equal(firstMutation.status, 201);
  const replayMutation = await request(app).post('/api/v1/projects/project-1/governance-items').set('Authorization', writerOauth).set('Idempotency-Key', 'risk-create-001').send(mutation);
  assert.equal(replayMutation.status, 201); assert.equal(replayMutation.headers['idempotency-replayed'], 'true'); assert.equal(replayMutation.body.data.id, firstMutation.body.data.id);
  assert.equal((await request(app).post('/api/v1/projects/project-1/governance-items').set('Authorization', writerOauth).set('Idempotency-Key', 'risk-create-001').send({ ...mutation, title: 'Different risk' })).status, 409);
  assert.equal((await request(app).post('/api/v1/projects/project-2/governance-items').set('Authorization', writerOauth).set('Idempotency-Key', 'risk-create-002').send(mutation)).status, 404);
  assert.equal((await request(app).post('/api/v1/projects/project-1/governance-items').set('Authorization', writerOauth).send(mutation)).status, 400);

  const rotated = await request(app).post(`/api/integrations/oauth-applications/${created.body.value.id}/rotate`).set('Authorization', admin).send({ expectedVersion: 1 });
  assert.equal(rotated.status, 200); assert.notEqual(rotated.body.clientSecret, created.body.clientSecret);
  assert.equal((await request(app).get('/api/v1/platform/me').set('Authorization', oauth)).status, 401);
  assert.equal((await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${basic}`).type('form').send({ grant_type: 'client_credentials' })).status, 401);

  const webhook = await request(app).post('/api/integrations/webhooks').set('Authorization', admin).send({ description: 'Governance, workflow, and goal-attention events.', eventTypes: ['governance.changed', 'agent.goal.attention', 'workflow.transitioned', 'workflow.sla.overdue'], name: 'Governance receiver', url: 'https://hooks.example.com/odin' });
  assert.equal(webhook.status, 201); assert.match(webhook.body.signingSecret, /^odin_whsec_/);
  assert.deepEqual(webhook.body.value.eventTypes, ['governance.changed', 'agent.goal.attention', 'workflow.transitioned', 'workflow.sla.overdue']);
  await platformRepository.materializeWebhookDeliveries({ event: { eventType: 'governance.changed', id: '22222222-2222-4222-8222-222222222222', payload: { action: 'created', entityType: 'governance_item', projectId: 'project-1' }, tenantId } });
  const dispatchStart = new Date();
  const firstDispatch = await app.locals.dispatchWebhookDeliveries({ maxAttempts: 1, now: dispatchStart });
  assert.equal(firstDispatch[0].status, 'dead'); assert.match(calls[0].headers['x-odin-signature'], /^t=\d+,v1=[a-f0-9]{64}$/);
  const cloudEvent = JSON.parse(calls[0].body); assert.equal(cloudEvent.dataschema, 'urn:odin:event-schema:governance.changed:1.0.0'); assert.equal(cloudEvent.subject, 'project/project-1'); assert.equal(cloudEvent.data.schemaVersion, '1.0.0');
  let workspace = await request(app).get('/api/integrations').set('Authorization', admin);
  assert.equal(workspace.body.health[0].status, 'degraded'); assert.equal(workspace.body.deliveries[0].status, 'dead'); assert.doesNotMatch(JSON.stringify(workspace.body), /clientSecretHash|tokenHash|odin_oauth_secret_/);
  const replayed = await request(app).post(`/api/integrations/webhook-deliveries/${workspace.body.deliveries[0].id}/replay`).set('Authorization', admin).send({ expectedVersion: workspace.body.deliveries[0].version });
  assert.equal(replayed.status, 200); assert.equal(replayed.body.value.status, 'pending');
  const secondDispatch = await app.locals.dispatchWebhookDeliveries({ now: new Date(dispatchStart.getTime() + 60_000) });
  assert.equal(secondDispatch[0].status, 'delivered');
  workspace = await request(app).get('/api/integrations').set('Authorization', admin);
  assert.equal(workspace.body.deliveries[0].status, 'delivered'); assert.equal(workspace.body.health[0].status, 'healthy');
});
