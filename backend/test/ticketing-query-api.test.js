import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

function ticket(id, overrides = {}) {
  return {
    category: 'defect',
    externalReviewState: 'not_external',
    id,
    issueType: 'ticket',
    name: `Ticket ${id}`,
    parentId: null,
    severity: 'S3',
    status: 'new',
    updatedAt: '2026-07-10T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

async function createQueryTestApp() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme Delivery' }],
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
  const projectsRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        'project-alpha': [{ id: 'user-ada', role: 'user' }, { id: 'user-grace', role: 'admin' }],
        'project-beta': [{ id: 'user-grace', role: 'admin' }],
      },
      projects: [
        {
          createdAt: '2026-07-01T10:00:00.000Z',
          description: 'Alpha.',
          epics: [{ description: '', id: 'epic-a', name: 'Epic A', status: 'In Progress', stories: [] }],
          id: 'project-alpha',
          name: 'Alpha',
          role: 'admin',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          tickets: [
            ticket('t-a1', { assigneeId: 'user-grace', severity: 'S1', status: 'open', updatedAt: '2026-07-14T00:00:00.000Z' }),
            ticket('t-a2', { category: 'support', name: 'Export is slow', updatedAt: '2026-07-13T00:00:00.000Z' }),
            ticket('t-a3', { environmentId: 'env-uat', externalReviewState: 'pending', updatedAt: '2026-07-12T00:00:00.000Z' }),
          ],
          updatedAt: '2026-07-12T08:30:00.000Z',
        },
        {
          createdAt: '2026-07-01T10:00:00.000Z',
          description: 'Beta.',
          epics: [],
          id: 'project-beta',
          name: 'Beta',
          role: 'admin',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          tickets: [ticket('t-b1', { severity: 'S1', updatedAt: '2026-07-11T00:00:00.000Z' })],
          updatedAt: '2026-07-12T08:30:00.000Z',
        },
      ],
    },
  });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    projectRepository: projectsRepository,
    sessionsRepository,
    tokenService,
  });

  async function tokenFor(id, email, name, role) {
    const token = tokenService.signSessionToken({
      email, id, name, preferences: { twoFactorEnabled: false }, role, scopes: [`Ttenant-acme-${role}`], tenantId: 'tenant-acme',
    });
    const expiry = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({
      expiryDate: new Date(expiry.exp * 1000), ipAddr: '127.0.0.1', locationName: 'Localhost', token, userAgent: 'test-agent', userId: id,
    });
    return token;
  }

  return {
    adminToken: await tokenFor('user-grace', 'grace@acme.com', 'Grace Hopper', 'admin'),
    app,
    memberToken: await tokenFor('user-ada', 'ada@acme.com', 'Ada Lovelace', 'user'),
  };
}

function listTickets(app, token, query = '') {
  return request(app).get(`/api/projects/tickets${query}`).set('Authorization', `Bearer ${token}`);
}

test('the cross-project list returns tickets from every readable project, newest first', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const response = await listTickets(app, adminToken);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.tickets.map((entry) => entry.id), ['t-a1', 't-a2', 't-a3', 't-b1']);
  assert.equal(response.body.total, 4);
  assert.equal(response.body.tickets[0].projectName, 'Alpha');
});

test('tickets in projects the caller cannot read are absent, not redacted', async () => {
  const { app, memberToken } = await createQueryTestApp();

  const response = await listTickets(app, memberToken);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.tickets.map((entry) => entry.projectId), ['project-alpha', 'project-alpha', 'project-alpha']);
  assert.equal(response.body.tickets.some((entry) => entry.projectId === 'project-beta'), false);
});

test('each filter works independently', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const bySeverity = await listTickets(app, adminToken, '?severities=S1');
  assert.deepEqual(bySeverity.body.tickets.map((entry) => entry.id), ['t-a1', 't-b1']);

  const byCategory = await listTickets(app, adminToken, '?categories=support');
  assert.deepEqual(byCategory.body.tickets.map((entry) => entry.id), ['t-a2']);

  const byProject = await listTickets(app, adminToken, '?projectIds=project-beta');
  assert.deepEqual(byProject.body.tickets.map((entry) => entry.id), ['t-b1']);

  const byStatus = await listTickets(app, adminToken, '?statusValues=open');
  assert.deepEqual(byStatus.body.tickets.map((entry) => entry.id), ['t-a1']);

  const byAssignee = await listTickets(app, adminToken, '?assigneeIds=user-grace');
  assert.deepEqual(byAssignee.body.tickets.map((entry) => entry.id), ['t-a1']);

  const byEnvironment = await listTickets(app, adminToken, '?environmentIds=env-uat');
  assert.deepEqual(byEnvironment.body.tickets.map((entry) => entry.id), ['t-a3']);

  const byReviewState = await listTickets(app, adminToken, '?externalReviewStates=pending');
  assert.deepEqual(byReviewState.body.tickets.map((entry) => entry.id), ['t-a3']);

  const bySearch = await listTickets(app, adminToken, '?search=export');
  assert.deepEqual(bySearch.body.tickets.map((entry) => entry.id), ['t-a2']);
});

test('filters combine', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const combined = await listTickets(app, adminToken, '?severities=S1&projectIds=project-alpha');
  assert.deepEqual(combined.body.tickets.map((entry) => entry.id), ['t-a1']);

  const contradictory = await listTickets(app, adminToken, '?severities=S1&categories=support');
  assert.deepEqual(contradictory.body.tickets, []);
});

test('pagination is stable and does not repeat or skip rows', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const first = await listTickets(app, adminToken, '?limit=2');
  assert.deepEqual(first.body.tickets.map((entry) => entry.id), ['t-a1', 't-a2']);
  assert.ok(first.body.nextCursor);

  const second = await listTickets(app, adminToken, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
  assert.deepEqual(second.body.tickets.map((entry) => entry.id), ['t-a3', 't-b1']);
  assert.equal(second.body.nextCursor, null);
});

test('the per-project list is scoped to one project', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const response = await request(app)
    .get('/api/projects/project-beta/tickets')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.tickets.map((entry) => entry.id), ['t-b1']);
});

test('the per-project list does not disclose a project the caller cannot read', async () => {
  const { app, memberToken } = await createQueryTestApp();

  const response = await request(app)
    .get('/api/projects/project-beta/tickets')
    .set('Authorization', `Bearer ${memberToken}`);

  // Not-found rather than forbidden: the capability layer does not disclose project existence.
  assert.equal(response.status, 404);
});

test('an invalid filter value is a validation error', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const response = await listTickets(app, adminToken, '?severities=S9');
  assert.equal(response.status, 400);
});

test('typed relations can be created, listed, and deleted', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const created = await request(app)
    .post('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'caused_by', toItemId: 'epic-a' });

  assert.equal(created.status, 201);
  assert.equal(created.body.relation.relationType, 'caused_by');
  assert.equal(created.body.relation.fromItemId, 't-a1');

  const listed = await request(app)
    .get('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(listed.body.relations.length, 1);

  const deleted = await request(app)
    .delete(`/api/projects/project-alpha/relations/${created.body.relation.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(deleted.status, 200);

  const after = await request(app)
    .get('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.deepEqual(after.body.relations, []);
});

test('a self-relation is rejected', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const response = await request(app)
    .post('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'blocks', toItemId: 't-a1' });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /cannot relate to itself/);
});

test('creating the same relation twice is idempotent', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const first = await request(app)
    .post('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'duplicate_of', toItemId: 't-a2' });
  const second = await request(app)
    .post('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'duplicate_of', toItemId: 't-a2' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.relation.id, first.body.relation.id);
  assert.deepEqual([first.body.created, second.body.created], [true, false]);

  const listed = await request(app)
    .get('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(listed.body.relations.length, 1);
});

test('a relation to a work item in another project is rejected', async () => {
  const { adminToken, app } = await createQueryTestApp();

  const response = await request(app)
    .post('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'affects', toItemId: 't-b1' });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /same project/);
});

test('deleting a ticket removes its relations in both directions', async () => {
  const { adminToken, app } = await createQueryTestApp();

  await request(app)
    .post('/api/projects/project-alpha/items/t-a1/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'blocks', toItemId: 't-a2' });
  await request(app)
    .post('/api/projects/project-alpha/items/t-a2/relations')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ relationType: 'affects', toItemId: 't-a1' });

  const deleted = await request(app)
    .delete('/api/projects/project-alpha/items/t-a1')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ expectedVersion: 1 });
  assert.equal(deleted.status, 200);

  const remaining = await request(app)
    .get('/api/projects/project-alpha/items/t-a2/relations')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.deepEqual(remaining.body.relations, [], 'no orphan rows point at the deleted ticket');
});
