import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import {
  CANONICAL_TASK_TYPES,
  createInMemoryProjectsRepository,
} from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function createTicketingTestApp() {
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
          description: 'Delivery phase workstream.',
          epics: [
            {
              description: 'Stabilize intake.',
              id: 'epic-intake',
              name: 'Intake Workflow',
              status: 'In Progress',
              stories: [
                {
                  description: 'Routing.',
                  id: 'story-routing',
                  name: 'Routing Rules',
                  status: 'In Progress',
                  tasks: [
                    { description: 'Logic.', id: 'task-rules', name: 'Define routing logic', status: 'Completed' },
                  ],
                },
              ],
            },
          ],
          id: 'project-launch',
          name: 'Launch Readiness',
          role: 'admin',
          status: 'In Progress',
          tenantId: 'tenant-acme',
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
  const tokenExpiry = tokenService.verifySessionToken(token);
  await sessionsRepository.createSession({
    expiryDate: new Date(tokenExpiry.exp * 1000),
    ipAddr: '127.0.0.1',
    locationName: 'Localhost',
    token,
    userAgent: 'test-agent',
    userId: 'user-grace',
  });

  return { app, projectsRepository, token };
}

function createTicket(app, token, body) {
  return request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

test('Ticket is a canonical work-item type alongside epic, story, and task', () => {
  assert.deepEqual(CANONICAL_TASK_TYPES, ['Epic', 'Story', 'Task', 'Ticket']);
});

test('a ticket persists against its project with no parent item', async () => {
  const { app, token } = await createTicketingTestApp();

  const response = await createTicket(app, token, {
    item: {
      category: 'defect',
      name: 'Checkout returns 500 on empty cart',
      reproSteps: '1. Empty the cart\n2. Submit checkout',
      severity: 'S1',
    },
    itemType: 'ticket',
    parentId: null,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.item.issueType, 'ticket');
  assert.equal(response.body.item.parentId, null);
  assert.equal(response.body.item.category, 'defect');
  assert.equal(response.body.item.severity, 'S1');
  assert.equal(response.body.item.reproSteps, '1. Empty the cart\n2. Submit checkout');
  assert.equal(response.body.item.externalReviewState, 'not_external');
  assert.equal(response.body.project.tickets.length, 1);
});

test('a ticket may attach to an epic, a story, or a task', async () => {
  const { app, token } = await createTicketingTestApp();

  for (const [index, parentId] of ['epic-intake', 'story-routing', 'task-rules'].entries()) {
    const response = await createTicket(app, token, {
      item: { name: `Ticket ${index}`, severity: 'S3' },
      itemType: 'ticket',
      parentId,
    });

    assert.equal(response.status, 201, `parent ${parentId} should be accepted`);
    assert.equal(response.body.item.parentId, parentId);
  }
});

test('a ticket rejects a parent that is not a work item in the project', async () => {
  const { app, token } = await createTicketingTestApp();

  const response = await createTicket(app, token, {
    item: { name: 'Orphan parent' },
    itemType: 'ticket',
    parentId: 'does-not-exist',
  });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /existing epic, story, or task parent/);
});

test('epics, stories, and tasks keep their existing nesting rules', async () => {
  const { app, token } = await createTicketingTestApp();

  const parentlessStory = await createTicket(app, token, {
    item: { name: 'Story without a parent' },
    itemType: 'story',
    parentId: null,
  });
  assert.equal(parentlessStory.status, 400);

  const parentedEpic = await createTicket(app, token, {
    item: { name: 'Epic with a parent' },
    itemType: 'epic',
    parentId: 'epic-intake',
  });
  assert.equal(parentedEpic.status, 400);

  const taskUnderEpic = await createTicket(app, token, {
    item: { name: 'Task directly under an epic' },
    itemType: 'task',
    parentId: 'epic-intake',
  });
  assert.equal(taskUnderEpic.status, 400);
});

test('ticket writes are rejected when the project does not exist', async () => {
  const { app, token } = await createTicketingTestApp();

  const response = await request(app)
    .post('/api/projects/project-missing/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ item: { name: 'No project' }, itemType: 'ticket', parentId: null });

  assert.equal(response.status, 404);
});

test('an unknown category or severity is rejected as a validation error', async () => {
  const { app, token } = await createTicketingTestApp();

  const badCategory = await createTicket(app, token, {
    item: { category: 'not-a-category', name: 'Bad category' },
    itemType: 'ticket',
    parentId: null,
  });
  assert.equal(badCategory.status, 400);

  const badSeverity = await createTicket(app, token, {
    item: { name: 'Bad severity', severity: 'S9' },
    itemType: 'ticket',
    parentId: null,
  });
  assert.equal(badSeverity.status, 400);
});

test('ticket fields survive an update and bump the item version', async () => {
  const { app, token } = await createTicketingTestApp();

  const created = await createTicket(app, token, {
    item: { category: 'support', name: 'Slow report export', severity: 'S3' },
    itemType: 'ticket',
    parentId: null,
  });
  assert.equal(created.status, 201);

  const updated = await request(app)
    .patch(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      expectedVersion: created.body.item.version,
      patch: { actualResult: 'Times out at 60s', expectedResult: 'Export completes', severity: 'S2' },
    });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.item.severity, 'S2');
  assert.equal(updated.body.item.expectedResult, 'Export completes');
  assert.equal(updated.body.item.actualResult, 'Times out at 60s');
  assert.equal(updated.body.item.category, 'support');
  assert.equal(updated.body.item.version, created.body.item.version + 1);
});

test('a stale expectedVersion on a ticket update is a conflict, not a silent overwrite', async () => {
  const { app, token } = await createTicketingTestApp();

  const created = await createTicket(app, token, {
    item: { name: 'Conflict candidate' },
    itemType: 'ticket',
    parentId: null,
  });

  const first = await request(app)
    .patch(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: created.body.item.version, patch: { severity: 'S1' } });
  assert.equal(first.status, 200);

  const stale = await request(app)
    .patch(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: created.body.item.version, patch: { severity: 'S4' } });

  assert.equal(stale.status, 409);
});

test('tickets do not alter epic or story progress rollups', async () => {
  const { app, projectsRepository, token } = await createTicketingTestApp();

  const before = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const epicProgressBefore = before.epics[0].progress;
  const storyProgressBefore = before.epics[0].stories[0].progress;

  const response = await createTicket(app, token, {
    item: { name: 'Blocking defect', severity: 'S1', status: 'Not Started' },
    itemType: 'ticket',
    parentId: 'story-routing',
  });
  assert.equal(response.status, 201);

  const after = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.equal(after.epics[0].progress, epicProgressBefore);
  assert.equal(after.epics[0].stories[0].progress, storyProgressBefore);
  assert.equal(after.epics[0].stories[0].tasks.length, 1);
});

test('ticket create and update produce item revisions', async () => {
  const { app, token } = await createTicketingTestApp();

  const created = await createTicket(app, token, {
    item: { name: 'Audited ticket' },
    itemType: 'ticket',
    parentId: null,
  });

  await request(app)
    .patch(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: created.body.item.version, patch: { severity: 'S1' } });

  const revisions = await request(app)
    .get(`/api/projects/project-launch/items/${created.body.item.id}/revisions`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(revisions.status, 200);
  const actions = revisions.body.revisions.map((revision) => revision.action);
  assert.ok(actions.includes('create'));
  assert.ok(actions.includes('update'));
  assert.ok(revisions.body.revisions.every((revision) => revision.itemType === 'ticket'));
});

test('a ticket can be deleted and leaves the project tree intact', async () => {
  const { app, token } = await createTicketingTestApp();

  const created = await createTicket(app, token, {
    item: { name: 'Disposable' },
    itemType: 'ticket',
    parentId: 'story-routing',
  });

  const deleted = await request(app)
    .delete(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: created.body.item.version });

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.project.tickets.length, 0);
  assert.equal(deleted.body.project.epics[0].stories[0].tasks.length, 1);
});
