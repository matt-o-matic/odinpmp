import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import {
  filterProjectTicketsForAssistant,
  isTicketVisibleToAssistant,
  wrapProjectRepositoryForAssistant,
} from '../src/modules/assistant/assistant-ticket-visibility.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

function ticket(id, externalReviewState) {
  return { externalReviewState, id, issueType: 'ticket', name: `Ticket ${id}`, parentId: null, status: 'new' };
}

async function createReviewTestApp() {
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
    ],
  });
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
          tickets: [
            { ...ticket('ticket-internal', 'not_external'), reporterExternalId: null },
            { ...ticket('ticket-pending', 'pending'), reporterExternalId: 'reporter-1' },
            { ...ticket('ticket-validated', 'validated'), reporterExternalId: 'reporter-2' },
            { ...ticket('ticket-rejected', 'rejected'), reporterExternalId: 'reporter-3' },
          ],
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
  const token = tokenService.signSessionToken({
    email: 'grace@acme.com',
    id: 'user-grace',
    name: 'Grace Hopper',
    preferences: { twoFactorEnabled: false },
    role: 'admin',
    scopes: ['Ttenant-acme-admin'],
    tenantId: 'tenant-acme',
  });
  const expiry = tokenService.verifySessionToken(token);
  await sessionsRepository.createSession({
    expiryDate: new Date(expiry.exp * 1000),
    ipAddr: '127.0.0.1',
    locationName: 'Localhost',
    token,
    userAgent: 'test-agent',
    userId: 'user-grace',
  });

  return { app, projectsRepository, token };
}

test('only internal and validated tickets are visible to the assistant', () => {
  assert.equal(isTicketVisibleToAssistant({ externalReviewState: 'not_external' }), true);
  assert.equal(isTicketVisibleToAssistant({ externalReviewState: 'validated' }), true);
  assert.equal(isTicketVisibleToAssistant({ externalReviewState: 'pending' }), false);
  assert.equal(isTicketVisibleToAssistant({ externalReviewState: 'rejected' }), false);
  // An absent state is treated as internal, matching the column default.
  assert.equal(isTicketVisibleToAssistant({}), true);
});

test('the project filter strips pending and rejected tickets', () => {
  const project = {
    epics: [{ id: 'epic-1', name: 'E', stories: [] }],
    id: 'project-launch',
    tickets: [ticket('a', 'not_external'), ticket('b', 'pending'), ticket('c', 'validated'), ticket('d', 'rejected')],
  };

  const filtered = filterProjectTicketsForAssistant(project);

  assert.deepEqual(filtered.tickets.map((entry) => entry.id), ['a', 'c']);
  assert.deepEqual(filtered.epics, project.epics, 'the rest of the project is untouched');
});

test('the filter leaves projects without tickets identical', () => {
  const project = { epics: [], id: 'project-1' };
  assert.equal(filterProjectTicketsForAssistant(project), project);

  const empty = { epics: [], id: 'project-2', tickets: [] };
  assert.equal(filterProjectTicketsForAssistant(empty), empty);

  const allVisible = { id: 'project-3', tickets: [ticket('a', 'validated')] };
  assert.equal(filterProjectTicketsForAssistant(allVisible), allVisible, 'no copy when nothing is stripped');
});

test('the assistant repository wrapper filters every getProjectDetail call', async () => {
  const calls = [];
  const wrapped = wrapProjectRepositoryForAssistant({
    async getProjectDetail(args) {
      calls.push(args);
      return { id: 'project-launch', tickets: [ticket('a', 'pending'), ticket('b', 'validated')] };
    },
    async someOtherMethod() {
      return 'passthrough';
    },
  });

  const project = await wrapped.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });

  assert.deepEqual(project.tickets.map((entry) => entry.id), ['b']);
  assert.deepEqual(calls, [{ projectId: 'project-launch', tenantId: 'tenant-acme' }]);
  assert.equal(await wrapped.someOtherMethod(), 'passthrough', 'other methods pass through');
});

test('the wrapper tolerates a repository without getProjectDetail', () => {
  const repository = { other: () => 'ok' };
  assert.equal(wrapProjectRepositoryForAssistant(repository), repository);
  assert.equal(wrapProjectRepositoryForAssistant(null), null);
});

test('pending tickets stay fully visible to humans on the project surface', async () => {
  const { app, token } = await createReviewTestApp();

  const response = await request(app)
    .get('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.project.tickets.map((entry) => entry.id).sort(),
    ['ticket-internal', 'ticket-pending', 'ticket-rejected', 'ticket-validated'],
  );
});

test('a pending ticket can still be assigned and scheduled by a human', async () => {
  const { app, projectsRepository, token } = await createReviewTestApp();

  const before = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const pending = before.tickets.find((entry) => entry.id === 'ticket-pending');

  const response = await request(app)
    .patch('/api/projects/project-launch/items/ticket-pending')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: pending.version, patch: { assigneeId: 'user-grace', sprintId: 'sprint-1' } });

  assert.equal(response.status, 200);
  assert.equal(response.body.item.sprintId, 'sprint-1');
  assert.equal(response.body.item.externalReviewState, 'pending', 'scheduling does not validate the ticket');
});

test('validating a ticket records the decision and makes it assistant-visible', async () => {
  const { app, projectsRepository, token } = await createReviewTestApp();

  const before = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const pending = before.tickets.find((entry) => entry.id === 'ticket-pending');

  const decision = await request(app)
    .post('/api/projects/project-launch/items/ticket-pending/review')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: pending.version, state: 'validated' });

  assert.equal(decision.status, 200);
  assert.equal(decision.body.item.externalReviewState, 'validated');

  const revisions = await request(app)
    .get('/api/projects/project-launch/items/ticket-pending/revisions')
    .set('Authorization', `Bearer ${token}`);
  const latest = revisions.body.revisions.find((revision) => revision.action === 'update');
  assert.ok(latest, 'the decision is recorded as an item revision');
  assert.equal(latest.actorUserId, 'user-grace');

  const wrapped = wrapProjectRepositoryForAssistant(projectsRepository);
  const visible = await wrapped.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.ok(visible.tickets.some((entry) => entry.id === 'ticket-pending'));
});

test('a rejected ticket stays permanently invisible to the assistant', async () => {
  const { app, projectsRepository, token } = await createReviewTestApp();

  const before = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const pending = before.tickets.find((entry) => entry.id === 'ticket-pending');

  const decision = await request(app)
    .post('/api/projects/project-launch/items/ticket-pending/review')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: pending.version, state: 'rejected' });
  assert.equal(decision.status, 200);

  const wrapped = wrapProjectRepositoryForAssistant(projectsRepository);
  const visible = await wrapped.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.equal(visible.tickets.some((entry) => entry.id === 'ticket-pending'), false);

  const humanView = await request(app)
    .get('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`);
  assert.ok(humanView.body.project.tickets.some((entry) => entry.id === 'ticket-pending'), 'humans still see it');
});

test('an internally created ticket cannot be sent through review', async () => {
  const { app, projectsRepository, token } = await createReviewTestApp();

  const before = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const internal = before.tickets.find((entry) => entry.id === 'ticket-internal');

  const response = await request(app)
    .post('/api/projects/project-launch/items/ticket-internal/review')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: internal.version, state: 'validated' });

  assert.equal(response.status, 409);
  assert.match(JSON.stringify(response.body), /externally submitted/);
});

test('the review queue lists only pending external tickets', async () => {
  const { app, token } = await createReviewTestApp();

  const response = await request(app)
    .get('/api/projects/ticket-review-queue')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.tickets.map((entry) => entry.id), ['ticket-pending']);
  assert.equal(response.body.tickets[0].projectId, 'project-launch');
  assert.equal(response.body.tickets[0].projectName, 'Launch Readiness');
});

test('a review decision on a non-ticket item is rejected', async () => {
  const { app, token } = await createReviewTestApp();

  const response = await request(app)
    .post('/api/projects/project-launch/items/does-not-exist/review')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 1, state: 'validated' });

  assert.equal(response.status, 404);
});
