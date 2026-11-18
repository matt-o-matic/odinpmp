import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryConnectorRepository } from '../src/modules/connectors/connector.repository.js';
import { createConnectorCredentialVault, createConnectorOAuthService } from '../src/modules/connectors/connector-oauth.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const activeTestServers = new Set();

async function listenForTest(app) {
  const server = http.createServer(app);
  server.locals = app.locals;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  activeTestServers.add(server);
  return server;
}

test.afterEach(async () => {
  const servers = [...activeTestServers]; activeTestServers.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(resolve); server.closeAllConnections?.();
  })));
});

async function fixture() {
  const users = [
    {
      authMethod: 'basic',
      email: 'admin@example.com',
      id: 'admin',
      memberships: [{ role: 'admin', tenantId: 'tenant-1' }],
      name: 'Admin',
      password: 'Secret123!',
    },
    {
      authMethod: 'basic',
      email: 'member@example.com',
      id: 'member',
      memberships: [{ role: 'user', tenantId: 'tenant-1' }],
      name: 'Member',
      password: 'Secret123!',
    },
    { authMethod: 'basic', email: 'reviewer@example.com', id: 'admin-reviewer', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin reviewer', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }],
    users,
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        'project-1': [{ id: 'member', role: 'viewer' }],
        'project-2': [],
      },
      projects: [
        {
          epics: [],
          id: 'project-1',
          name: 'Launch',
          status: 'In Progress',
          tenantId: 'tenant-1',
        },
        {
          epics: [],
          id: 'project-2',
          name: 'Private',
          status: 'Active',
          tenantId: 'tenant-1',
        },
      ],
    },
  });
  const connectorRepository = createInMemoryConnectorRepository();
  process.env.ODIN_TENANT_TENANT1_CONNECTOR_CLIENT_SECRET = 'client-secret'; const connectorCredentialVault = createConnectorCredentialVault({ encryptionKey: 'connector-test-encryption-key-32-characters', repository: connectorRepository }); const connectorOAuthService = createConnectorOAuthService({ backendPublicUrl: 'https://odin.example', credentialVault: connectorCredentialVault, repository: connectorRepository, tokenRequest: async () => ({ body: { access_token: 'provider-token', expires_in: 3600, refresh_token: 'refresh-token' }, status: 200 }) });
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({
    issuer: 'connector-test',
    secret: 'connector-test-secret-that-is-long-enough',
  });
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({
      expiryDate: new Date(decoded.exp * 1000),
      token,
      userId: user.id,
    });
    tokens.set(user.id, token);
  }
  const app = await listenForTest(createApp({
    agentMonitorSweepIntervalMs: 0,
    assistantStaleRunSweepIntervalMs: 0,
    authRepository,
    connectorRepository,
    connectorOAuthService,
    domainEventSweepIntervalMs: 0,
    projectRepository,
    resourceFinanceRepository,
    sessionsRepository,
    tokenService,
  }));
  return {
    app,
    authorization: (userId) => `Bearer ${tokens.get(userId)}`,
    connectorRepository,
    connectorCredentialVault,
    resourceFinanceRepository,
  };
}

test('connector API completes one-use OAuth PKCE consent without exposing stored tokens', async () => {
  const { app, authorization, connectorCredentialVault } = await fixture(); const admin = authorization('admin'); const created = await request(app).post('/api/connectors/connections').set('Authorization', admin).send({ authType: 'oauth2', name: 'GitHub OAuth', projectIds: ['project-1'], provider: 'github', scopes: ['repo'], secretReference: 'env:ODIN_TENANT_TENANT1_CONNECTOR_CLIENT_SECRET', settings: { authorizationUrl: 'https://github.com/login/oauth/authorize', clientId: 'client-1', owner: 'acme', repository: 'odin', tokenUrl: 'https://github.com/login/oauth/access_token' }, status: 'active' }); assert.equal(created.status, 201);
  const started = await request(app).post(`/api/connectors/connections/${created.body.value.id}/oauth/start`).set('Authorization', admin); assert.equal(started.status, 200); const state = new URL(started.body.authorizationUrl).searchParams.get('state'); const callback = await request(app).get(`/api/connectors/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`).set('Authorization', admin); assert.equal(callback.status, 303); assert.equal(callback.headers.location, 'https://odin.example/app/integrations?oauth=connected'); const credential = JSON.parse(await connectorCredentialVault.resolve('', { connectionId: created.body.value.id, tenantId: 'tenant-1' })); assert.equal(credential.accessToken, 'provider-token'); assert.equal((await request(app).get(`/api/connectors/oauth/callback?code=replay&state=${encodeURIComponent(state)}`).set('Authorization', admin)).status, 400);
});

test('connector API governs configuration, inbound authentication, mappings, and idempotent sync', async () => {
  const { app, authorization, connectorRepository } = await fixture();
  const admin = authorization('admin');

  const empty = await request(app)
    .get('/api/connectors')
    .set('Authorization', admin);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.catalog.length, 12);
  assert.equal(empty.body.total, 0);

  const created = await request(app)
    .post('/api/connectors/connections')
    .set('Authorization', admin)
    .send({
      authType: 'webhook',
      name: 'Engineering GitHub',
      projectIds: ['project-1'],
      provider: 'github',
      status: 'active',
    });
  assert.equal(created.status, 201);
  assert.match(created.body.inboundSecret, /^odin_connector_/);
  const connectionId = created.body.value.id;

  const workspace = await request(app)
    .get('/api/connectors')
    .set('Authorization', admin);
  assert.equal(workspace.body.connections.length, 1);
  assert.equal(workspace.body.connections[0].inboundSecret, undefined);
  assert.equal(workspace.body.connections[0].inboundSecretHash, undefined);
  assert.equal(workspace.body.health[0].status, 'healthy');

  const rejected = await request(app)
    .post(`/api/public/connectors/${connectionId}/events`)
    .set('X-Odin-Connector-Secret', 'wrong')
    .send({
      eventId: 'evt-1',
      eventType: 'issues.updated',
      payload: { id: 42, title: 'Launch issue' },
    });
  assert.equal(rejected.status, 401);
  const accepted = await request(app)
    .post(`/api/public/connectors/${connectionId}/events`)
    .set('X-Odin-Connector-Secret', created.body.inboundSecret)
    .send({
      eventId: 'evt-1',
      eventType: 'issues.updated',
      payload: { id: 42, title: 'Launch issue' },
    });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.accepted, true);
  const duplicate = await request(app)
    .post(`/api/public/connectors/${connectionId}/events`)
    .set('X-Odin-Connector-Secret', created.body.inboundSecret)
    .send({
      eventId: 'evt-1',
      eventType: 'issues.updated',
      payload: { id: 42, title: 'Launch issue' },
    });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const normalizedEvent = (await connectorRepository.listSnapshot({ tenantId: 'tenant-1' })).events[0];
  assert.equal(normalizedEvent.payload.kind, 'source_work');
  assert.equal(normalizedEvent.payload.externalId, '42');
  assert.equal(normalizedEvent.payload.fields.title, 'Launch issue');
  assert.match(normalizedEvent.payload.sourcePayloadHash, /^[a-f0-9]{64}$/);

  const mapping = await request(app)
    .post('/api/connectors/mappings')
    .set('Authorization', admin)
    .send({
      connectionId,
      externalId: 'issue-42',
      objectType: 'issue',
      odinId: 'task-42',
      projectId: 'project-1',
    });
  assert.equal(mapping.status, 201);
  assert.equal(
    (
      await request(app)
        .post('/api/connectors/mappings')
        .set('Authorization', admin)
        .send({
          connectionId,
          externalId: 'issue-42',
          objectType: 'issue',
          odinId: 'task-other',
          projectId: 'project-1',
        })
    ).status,
    409,
  );
  const conflict = await connectorRepository.createConflict({
    input: {
      connectionId,
      externalPayloadHash: 'a'.repeat(64),
      mappingId: mapping.body.value.id,
      note: 'Both sides changed.',
      objectType: 'issue',
      odinPayloadHash: 'b'.repeat(64),
    },
    tenantId: 'tenant-1',
  });
  const resolved = await request(app)
    .post(`/api/connectors/conflicts/${conflict.id}/resolve`)
    .set('Authorization', admin)
    .send({ expectedVersion: 1, note: 'Keep Odin.', resolution: 'odin_wins' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.value.status, 'resolved');
  const runBody = {
    direction: 'inbound',
    idempotencyKey: 'sync-2026-07-11-001',
  };
  const firstRun = await request(app)
    .post(`/api/connectors/connections/${connectionId}/sync-runs`)
    .set('Authorization', admin)
    .send(runBody);
  const duplicateRun = await request(app)
    .post(`/api/connectors/connections/${connectionId}/sync-runs`)
    .set('Authorization', admin)
    .send(runBody);
  assert.equal(firstRun.status, 202);
  assert.equal(firstRun.body.duplicate, false);
  assert.equal(duplicateRun.body.duplicate, true);

  const updated = await request(app)
    .patch(`/api/connectors/connections/${connectionId}`)
    .set('Authorization', admin)
    .send({ expectedVersion: 1, status: 'paused' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.value.version, 2);
  assert.equal(
    (
      await request(app)
        .patch(`/api/connectors/connections/${connectionId}`)
        .set('Authorization', admin)
        .send({ expectedVersion: 1, status: 'active' })
    ).status,
    409,
  );
});

test('connector marketplace policy constrains configuration and requires separate-admin activation', async () => {
  const { app, authorization } = await fixture(); const admin = authorization('admin'); const reviewer = authorization('admin-reviewer');
  const policy = await request(app).post('/api/connectors/provider-policies').set('Authorization', admin).send({ allowedAuthTypes: ['webhook'], allowedDirections: ['inbound'], allowedScopes: ['issues:read'], approvalRequired: true, dataClassification: 'restricted', enabled: true, maxProjects: 1, outboundEnabled: false, provider: 'github' });
  assert.equal(policy.status, 201); assert.equal(policy.body.value.dataClassification, 'restricted');
  assert.equal((await request(app).post('/api/connectors/connections').set('Authorization', admin).send({ authType: 'webhook', name: 'Blocked outbound', projectIds: ['project-1'], provider: 'github', scopes: ['issues:read'], status: 'active', syncDirection: 'bidirectional' })).status, 403);
  const created = await request(app).post('/api/connectors/connections').set('Authorization', admin).send({ authType: 'webhook', name: 'Reviewed inbound', projectIds: ['project-1'], provider: 'github', scopes: ['issues:read'], status: 'active', syncDirection: 'inbound' });
  assert.equal(created.status, 201); assert.equal(created.body.value.status, 'draft');
  assert.equal((await request(app).post(`/api/connectors/connections/${created.body.value.id}/approve`).set('Authorization', admin).send({ expectedVersion: 1 })).status, 403);
  const approved = await request(app).post(`/api/connectors/connections/${created.body.value.id}/approve`).set('Authorization', reviewer).send({ expectedVersion: 1 });
  assert.equal(approved.status, 200); assert.equal(approved.body.value.status, 'active'); assert.equal(approved.body.value.approvedBy, 'admin-reviewer');
  assert.equal(
    (
      await request(app)
        .post('/api/connectors/provider-policies')
        .set('Authorization', reviewer)
        .send({
          allowedAuthTypes: ['webhook'],
          allowedDirections: ['inbound'],
          provider: 'github',
        })
    ).status,
    409,
  );
  const disabled = await request(app)
    .patch(`/api/connectors/provider-policies/${policy.body.value.id}`)
    .set('Authorization', reviewer)
    .send({ enabled: false, expectedVersion: 1 });
  assert.equal(disabled.status, 200);
  assert.equal(
    (
      await request(app)
        .post(`/api/public/connectors/${created.body.value.id}/events`)
        .set('X-Odin-Connector-Secret', created.body.inboundSecret)
        .send({ eventId: 'blocked-by-policy', eventType: 'issues.updated', payload: {} })
    ).status,
    401,
  );
});

test('normalized ERP journal events require mapping and explicit admin apply before creating a draft ledger entry', async () => {
  const { app, authorization, connectorRepository, resourceFinanceRepository } = await fixture(); const admin = authorization('admin');
  const created = await request(app).post('/api/connectors/connections').set('Authorization', admin).send({ authType: 'webhook', name: 'Finance NetSuite', projectIds: ['project-1'], provider: 'netsuite', status: 'active' });
  const connectionId = created.body.value.id;
  await request(app).post('/api/connectors/mappings').set('Authorization', admin).send({ connectionId, externalId: 'ERP-PROJECT-1', objectType: 'project', odinId: 'project-1', projectId: 'project-1' });
  const received = await request(app).post(`/api/public/connectors/${connectionId}/events`).set('X-Odin-Connector-Secret', created.body.inboundSecret).send({ eventId: 'journal-event-1', eventType: 'journal.changed', payload: { amount: 1250, currency: 'USD', date: '2026-07-11', entryKind: 'actual_cost', id: 'JOURNAL-100', memo: 'Implementation accrual', projectId: 'ERP-PROJECT-1' } });
  assert.equal(received.status, 202);
  const pending = (await connectorRepository.listSnapshot({ tenantId: 'tenant-1' })).events[0];
  assert.equal(pending.payload.kind, 'journal_entry');
  const applied = await request(app).post(`/api/connectors/events/${pending.id}/apply`).set('Authorization', admin).send({ expectedVersion: 1 });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.value.status, 'draft');
  assert.equal(applied.body.value.sourceType, 'connector:netsuite');
  assert.equal(applied.body.value.projectId, 'project-1');
  assert.equal((await resourceFinanceRepository.listSnapshot({ tenantId: 'tenant-1' })).financialEntries.length, 1);
  assert.equal((await connectorRepository.listSnapshot({ tenantId: 'tenant-1' })).events[0].status, 'processed');
  assert.equal((await request(app).post(`/api/connectors/events/${pending.id}/apply`).set('Authorization', admin).send({ expectedVersion: 1 })).status, 404);
});

test('ERP outbound posting API accepts only approved in-scope ledger entries and is idempotent', async () => {
  const { app, authorization, connectorRepository, resourceFinanceRepository } = await fixture(); const admin = authorization('admin');
  const created = await request(app).post('/api/connectors/connections').set('Authorization', admin).send({ authType: 'oauth2', name: 'Finance SAP', projectIds: ['project-1'], provider: 'sap_s4hana', scopes: ['journal_entries'], secretReference: 'env:ODIN_TENANT_TENANT1_SAP_TOKEN', settings: { baseUrl: 'https://acme.s4hana.ondemand.com' }, status: 'active', syncDirection: 'outbound' }); assert.equal(created.status, 201);
  const entry = await resourceFinanceRepository.createFinancialEntry({ input: { amount: 100, category: 'Accrual', currency: 'USD', effectiveDate: '2026-07-11', entryKind: 'actual_cost', note: '', projectId: 'project-1', sourceId: null, sourceType: 'manual', status: 'approved' }, tenantId: 'tenant-1' });
  const first = await request(app).post(`/api/connectors/connections/${created.body.value.id}/erp-postings`).set('Authorization', admin).send({ financialEntryId: entry.id, idempotencyKey: 'erp-post-entry-1' }); assert.equal(first.status, 202); assert.equal(first.body.duplicate, false);
  const duplicate = await request(app).post(`/api/connectors/connections/${created.body.value.id}/erp-postings`).set('Authorization', admin).send({ financialEntryId: entry.id, idempotencyKey: 'erp-post-entry-1' }); assert.equal(duplicate.status, 202); assert.equal(duplicate.body.duplicate, true);
  assert.equal((await connectorRepository.listSnapshot({ tenantId: 'tenant-1' })).postings.length, 1);
  assert.equal((await request(app).post(`/api/connectors/connections/${created.body.value.id}/erp-postings`).set('Authorization', authorization('member')).send({ financialEntryId: entry.id, idempotencyKey: 'erp-post-entry-2' })).status, 404);
});

test('connector API conceals administration and rejects out-of-scope projects', async () => {
  const { app, authorization } = await fixture();
  assert.equal(
    (
      await request(app)
        .get('/api/connectors')
        .set('Authorization', authorization('member'))
    ).status,
    404,
  );
  const invalid = await request(app)
    .post('/api/connectors/connections')
    .set('Authorization', authorization('admin'))
    .send({
      authType: 'pat',
      name: 'Invalid project',
      projectIds: ['missing-project'],
      provider: 'jira',
    });
  assert.equal(invalid.status, 400);
});
