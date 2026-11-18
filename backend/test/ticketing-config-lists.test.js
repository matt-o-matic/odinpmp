import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { DEFAULT_TENANT_ENVIRONMENTS, createInMemoryProjectsRepository, ensureMysqlTenantEnvironmentDefaults } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryTenantsRepository, createMysqlTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
import { ticketConfigRevision } from '../src/modules/tenants/ticket-config-revision.js';

async function createConfigTestApp() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      { domains: ['acme.com'], id: 'tenant-acme', name: 'Acme Delivery' },
      { domains: ['other.com'], id: 'tenant-other', name: 'Other Co' },
    ],
    users: [
      {
        authMethod: 'basic',
        email: 'grace@acme.com',
        id: 'user-grace',
        memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
        name: 'Grace Hopper',
        password: 'Secret123!',
        preferences: { twoFactorEnabled: false },
      },
      {
        authMethod: 'basic',
        email: 'ada@acme.com',
        id: 'user-ada',
        memberships: [{ role: 'user', tenantId: 'tenant-acme' }],
        name: 'Ada Lovelace',
        password: 'Secret123!',
        preferences: { twoFactorEnabled: false },
      },
    ],
  });
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  const projectsRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projects: [
        {
          createdAt: '2026-07-01T10:00:00.000Z',
          description: 'Delivery.',
          epics: [],
          id: 'project-launch',
          name: 'Launch Readiness',
          role: 'admin',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          updatedAt: '2026-07-12T08:30:00.000Z',
        },
        {
          createdAt: '2026-07-01T10:00:00.000Z',
          description: 'Restricted.',
          epics: [],
          id: 'project-private',
          name: 'Private Programme',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          updatedAt: '2026-07-12T08:30:00.000Z',
        },
      ],
      projectMemberships: { 'project-private': [{ id: 'user-grace', role: 'admin' }] },
    },
    ticketConfigRepository: tenantsRepository,
  });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    projectRepository: projectsRepository,
    sessionsRepository,
    tenantsRepository,
    tokenService,
  });

  async function tokenFor(user) {
    const token = tokenService.signSessionToken({
      email: user.email,
      id: user.id,
      name: user.name,
      preferences: { twoFactorEnabled: false },
      role: user.role,
      scopes: [`Ttenant-acme-${user.role}`],
      tenantId: 'tenant-acme',
    });
    const expiry = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({
      expiryDate: new Date(expiry.exp * 1000),
      ipAddr: '127.0.0.1',
      locationName: 'Localhost',
      token,
      userAgent: 'test-agent',
      userId: user.id,
    });
    return token;
  }

  return {
    adminToken: await tokenFor({ email: 'grace@acme.com', id: 'user-grace', name: 'Grace Hopper', role: 'admin' }),
    app,
    contributorToken: await tokenFor({ email: 'ada@acme.com', id: 'user-ada', name: 'Ada Lovelace', role: 'user' }),
    tenantsRepository,
  };
}

test('a tenant starts with the four default environments', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const response = await request(app)
    .get('/api/tenants/ticket-config/environments')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.entries.map((entry) => entry.name), DEFAULT_TENANT_ENVIRONMENTS);
  assert.ok(response.body.entries.every((entry) => entry.status === 'active'));
});

test('the release list starts empty and accepts entries', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const initial = await request(app)
    .get('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.entries, []);

  const saved = await request(app)
    .put('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ entries: [{ name: '2026.07.1', sortOrder: 0 }, { name: '2026.08.0', sortOrder: 1 }] });

  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.entries.map((entry) => entry.name), ['2026.07.1', '2026.08.0']);
  assert.ok(saved.body.entries.every((entry) => entry.id));
});

test('a contributor cannot read or write the configuration lists', async () => {
  const { app, contributorToken } = await createConfigTestApp();

  const read = await request(app)
    .get('/api/tenants/ticket-config/environments')
    .set('Authorization', `Bearer ${contributorToken}`);
  assert.equal(read.status, 403);

  const write = await request(app)
    .put('/api/tenants/ticket-config/environments')
    .set('Authorization', `Bearer ${contributorToken}`)
    .send({ entries: [{ name: 'Rogue' }] });
  assert.equal(write.status, 403);
});

test('an unknown list kind is rejected', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const response = await request(app)
    .get('/api/tenants/ticket-config/not-a-list')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(response.status, 400);
});

test('a ticket referencing an unknown environment is rejected', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const response = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ item: { environmentId: 'env-does-not-exist', name: 'Bad environment' }, itemType: 'ticket', parentId: null });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /Unknown environment/);
});

test('a ticket referencing an unknown release is rejected', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const response = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ item: { foundInReleaseId: 'rel-nope', name: 'Bad release' }, itemType: 'ticket', parentId: null });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /Unknown found-in release/);
});

test('a ticket referencing an inactive environment is rejected', async () => {
  const { adminToken, app, tenantsRepository } = await createConfigTestApp();

  await tenantsRepository.saveTicketConfigList({
    entries: [{ id: 'env-uat', name: 'UAT', sortOrder: 0, status: 'inactive' }],
    kind: 'environments',
    tenantId: 'tenant-acme',
  });

  const response = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ item: { environmentId: 'env-uat', name: 'Inactive environment' }, itemType: 'ticket', parentId: null });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /inactive/);
});

test('deactivating an environment does not break tickets already referencing it', async () => {
  const { adminToken, app, tenantsRepository } = await createConfigTestApp();

  const created = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ item: { environmentId: 'env-uat', name: 'Found in UAT' }, itemType: 'ticket', parentId: null });
  assert.equal(created.status, 201);

  await tenantsRepository.saveTicketConfigList({
    entries: [{ id: 'env-uat', name: 'UAT', sortOrder: 0, status: 'inactive' }],
    kind: 'environments',
    tenantId: 'tenant-acme',
  });

  const read = await request(app)
    .get('/api/projects/project-launch')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.project.tickets[0].environmentId, 'env-uat');

  const unrelatedUpdate = await request(app)
    .patch(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ expectedVersion: created.body.item.version, patch: { severity: 'S1' } });

  assert.equal(unrelatedUpdate.status, 200);
  assert.equal(unrelatedUpdate.body.item.environmentId, 'env-uat');
});

test('a valid active environment is accepted', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const response = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ item: { environmentId: 'env-production', name: 'Production defect', severity: 'S1' }, itemType: 'ticket', parentId: null });

  assert.equal(response.status, 201);
  assert.equal(response.body.item.environmentId, 'env-production');
});

test('the list carries a revision and a save from a stale revision is refused', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const loaded = await request(app)
    .get('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(loaded.status, 200);
  assert.match(loaded.body.revision, /^[a-f0-9]{32}$/);

  const first = await request(app)
    .put('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ entries: [{ name: '2026.10.0', sortOrder: 0 }], expectedRevision: loaded.body.revision });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.revision, loaded.body.revision);

  const stale = await request(app)
    .put('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ entries: [{ name: 'Clobber', sortOrder: 0 }], expectedRevision: loaded.body.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'ticket_config_revision_conflict');

  const reread = await request(app)
    .get('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.deepEqual(reread.body.entries.map((entry) => entry.name), ['2026.10.0']);
  assert.equal(reread.body.revision, first.body.revision);
});

test('omitting an entry from a save retires it instead of dropping it', async () => {
  const { adminToken, app } = await createConfigTestApp();

  const saved = await request(app)
    .put('/api/tenants/ticket-config/environments')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ entries: [{ id: 'env-production', name: 'Production', sortOrder: 0 }, { id: 'env-staging', name: 'Pre-production', projectId: 'project-launch', sortOrder: 1 }] });

  assert.equal(saved.status, 200);
  const byId = new Map(saved.body.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.size, DEFAULT_TENANT_ENVIRONMENTS.length);
  assert.equal(byId.get('env-staging').name, 'Pre-production');
  assert.equal(byId.get('env-staging').projectId, 'project-launch');
  assert.equal(byId.get('env-development').status, 'inactive');
  assert.equal(byId.get('env-uat').status, 'inactive');
  assert.equal(byId.get('env-production').status, 'active');
});

test('project readers get the active and retired entries in scope for that project', async () => {
  const { adminToken, app, contributorToken } = await createConfigTestApp();

  await request(app)
    .put('/api/tenants/ticket-config/releases')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ entries: [
      { name: '2026.09.0', sortOrder: 2 },
      { name: 'Launch RC1', projectId: 'project-launch', sortOrder: 1 },
      { name: 'Private RC1', projectId: 'project-private', sortOrder: 0 },
      { name: '2026.08.0', sortOrder: 3, status: 'inactive' },
    ] });

  const response = await request(app)
    .get('/api/projects/project-launch/ticket-config')
    .set('Authorization', `Bearer ${contributorToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.releases.map((entry) => [entry.name, entry.status]), [
    ['Launch RC1', 'active'],
    ['2026.09.0', 'active'],
    ['2026.08.0', 'inactive'],
  ]);
  assert.deepEqual(response.body.environments.map((entry) => entry.name), DEFAULT_TENANT_ENVIRONMENTS);
  assert.equal(Object.hasOwn(response.body.releases[0], 'version'), false);
});

test('the project ticket configuration is hidden from users who cannot read the project', async () => {
  const { app, contributorToken } = await createConfigTestApp();

  const hidden = await request(app)
    .get('/api/projects/project-private/ticket-config')
    .set('Authorization', `Bearer ${contributorToken}`);
  assert.equal(hidden.status, 404);

  const unknown = await request(app)
    .get('/api/projects/project-missing/ticket-config')
    .set('Authorization', `Bearer ${contributorToken}`);
  assert.equal(unknown.status, 404);

  const anonymous = await request(app).get('/api/projects/project-launch/ticket-config');
  assert.equal(anonymous.status, 401);
});

function createTicketConfigPool({ rows = [] } = {}) {
  const calls = [];
  const executor = {
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ params, sql: normalized });
      if (normalized.includes('information_schema')) return [[{ count: 1 }]];
      if (normalized.startsWith('SELECT id, version FROM tenant_releases')) return [rows.map(({ id, version }) => ({ id, version }))];
      if (normalized.startsWith('SELECT id, name, project_id')) return [rows];
      return [{ affectedRows: 1 }];
    },
  };
  return {
    calls,
    async getConnection() {
      return { ...executor, async beginTransaction() {}, async commit() {}, async rollback() { calls.push({ sql: 'ROLLBACK' }); }, release() {} };
    },
    execute: executor.execute,
  };
}

test('the MySQL save checks the revision under a row lock before writing', async () => {
  const rows = [{ id: 'rel-1', name: '2026.10.0', projectId: null, sortOrder: 0, status: 'active', version: 3 }];
  const stalePool = createTicketConfigPool({ rows });
  const staleRepository = createMysqlTenantsRepository({ pool: stalePool });

  await assert.rejects(
    staleRepository.saveTicketConfigList({ entries: [{ id: 'rel-1', name: 'Renamed' }], expectedRevision: 'not-the-current-revision', kind: 'releases', tenantId: 'tenant-acme' }),
    (error) => error.statusCode === 409,
  );
  assert.ok(stalePool.calls.some((call) => call.sql.endsWith('FOR UPDATE')));
  assert.equal(stalePool.calls.some((call) => call.sql.startsWith('INSERT INTO tenant_releases')), false);
  assert.ok(stalePool.calls.some((call) => call.sql === 'ROLLBACK'));

  const currentPool = createTicketConfigPool({ rows });
  const currentRepository = createMysqlTenantsRepository({ pool: currentPool });
  await currentRepository.saveTicketConfigList({ entries: [{ id: 'rel-1', name: 'Renamed' }], expectedRevision: ticketConfigRevision(rows), kind: 'releases', tenantId: 'tenant-acme' });
  assert.ok(currentPool.calls.some((call) => call.sql.startsWith('INSERT INTO tenant_releases')));
});

test('MySQL environment defaults seed an empty tenant once and never re-add a renamed default', async () => {
  function seedExecutor(existingRows) {
    const inserts = [];
    return {
      inserts,
      async execute(sql, params = []) {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized.includes('information_schema')) return [[{ count: 1 }]];
        if (normalized.startsWith('SELECT id FROM tenant_environments')) return [existingRows];
        if (normalized.startsWith('INSERT INTO tenant_environments')) inserts.push(params[2]);
        return [[]];
      },
    };
  }

  const empty = seedExecutor([]);
  await ensureMysqlTenantEnvironmentDefaults(empty, 'tenant-acme');
  assert.deepEqual(empty.inserts, DEFAULT_TENANT_ENVIRONMENTS);

  // The tenant renamed UAT to QA; the remaining row must not bring back a fresh UAT.
  const renamed = seedExecutor([{ id: 'env-qa' }]);
  await ensureMysqlTenantEnvironmentDefaults(renamed, 'tenant-acme');
  assert.deepEqual(renamed.inserts, []);
});
