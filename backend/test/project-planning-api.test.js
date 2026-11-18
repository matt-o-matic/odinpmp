import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function createPlanningTestApp() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      {
        domains: ['acme.com'],
        id: 'tenant-acme',
        name: 'Acme Delivery',
      },
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
        email: 'alan@acme.com',
        id: 'user-alan',
        memberships: [{ role: 'manager', tenantId: 'tenant-acme' }],
        name: 'Alan Turing',
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
      projects: [
        {
          createdAt: '2026-05-01T10:00:00.000Z',
          description: 'Rebuild the onboarding and activation funnel.',
          endDate: '2026-07-15',
          id: 'project-launch',
          name: 'Launch Readiness',
          rank: 1,
          role: 'admin',
          startDate: '2026-05-10',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          updatedAt: '2026-05-12T08:30:00.000Z',
          epics: [
            {
              description: 'Stabilize intake and ownership.',
              id: 'epic-intake',
              name: 'Intake Workflow',
              points: 13,
              priority: 1,
              progress: 62.5,
              status: 'In Progress',
              stories: [
                {
                  assigneeId: 'user-grace',
                  assigneeName: 'Grace Hopper',
                  description: 'Create assignment automation.',
                  id: 'story-routing',
                  name: 'Routing Rules',
                  points: 8,
                  priority: 1,
                  progress: 50,
                  status: 'In Progress',
                  targetHourEstimate: 24,
                  tasks: [
                    {
                      assigneeId: 'user-grace',
                      assigneeName: 'Grace Hopper',
                      description: 'Document assignment conditions.',
                      id: 'task-rules',
                      name: 'Define routing logic',
                      points: 3,
                      progress: 100,
                      status: 'Completed',
                      targetHourEstimate: 8,
                    },
                    {
                      assigneeId: 'user-ada',
                      assigneeName: 'Ada Lovelace',
                      description: 'Add fallback owner selection.',
                      id: 'task-owner',
                      name: 'Fallback ownership',
                      points: 5,
                      progress: 0,
                      status: 'Not Started',
                      targetHourEstimate: 16,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const tokenService = createTokenService({
    issuer: 'odinpmp-test',
    secret: 'test-secret',
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    googleOAuthClient: {
      getAuthorizationUrl() {
        return 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client';
      },
      async getUserInfoFromCode() {
        return {
          email: 'google.user@example.com',
          name: 'Google User',
        };
      },
    },
    projectAiService: {
      async analyzeProject({ project }) {
        return {
          analysis: `Analysis for ${project.name}`,
          provider: 'fallback',
        };
      },
      async enhanceDescription({ description, project }) {
        return {
          provider: 'fallback',
          suggestions: [`Sharper version of ${project.name}: ${description}`],
        };
      },
      async generateStructure() {
        return {
          epics: [],
          provider: 'fallback',
        };
      },
    },
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

  return {
    app,
    projectsRepository,
    token,
  };
}

test('GET /api/projects/:projectId/sprints returns sprint planning state', async () => {
  const { app, token } = await createPlanningTestApp();

  const response = await request(app)
    .get('/api/projects/project-launch/sprints')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.sprints, []);
  assert.equal(Array.isArray(response.body.backlog.items), true);
  assert.equal(response.body.backlog.items.length, 3);
  assert.equal(response.body.backlog.items[0].targetHourEstimate, 24);
  assert.equal(response.body.members.length >= 2, true);
});

test('POST /api/projects/:projectId/sprints creates a sprint and PUT staffing saves overrides', async () => {
  const { app, token } = await createPlanningTestApp();

  const createResponse = await request(app)
    .post('/api/projects/project-launch/sprints')
    .set('Authorization', `Bearer ${token}`)
    .send({
      endDate: '2026-05-31',
      goal: 'Ship intake stabilization.',
      name: 'Sprint 1',
      startDate: '2026-05-15',
      status: 'planned',
    });

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.ok, true);
  assert.equal(createResponse.body.sprint.name, 'Sprint 1');
  assert.equal(createResponse.body.sprint.status, 'planned');

  const sprintId = createResponse.body.sprint.id;
  const staffingResponse = await request(app)
    .put(`/api/projects/project-launch/sprints/${sprintId}/staffing`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      staffing: [
        {
          allocationPctOverride: 50,
          capacityHours: 20,
          notes: 'Focused on story delivery.',
          userId: 'user-grace',
        },
      ],
    });

  assert.equal(staffingResponse.status, 200);
  assert.equal(staffingResponse.body.ok, true);
  assert.equal(staffingResponse.body.staffing.length, 1);
  assert.equal(staffingResponse.body.staffing[0].capacityHours, 20);
  assert.equal(staffingResponse.body.staffing[0].allocationPctOverride, 50);
});

test('POST /api/projects/:projectId/sprints/assign-items assigns story and task into sprint and backlog', async () => {
  const { app, token } = await createPlanningTestApp();

  const sprintResponse = await request(app)
    .post('/api/projects/project-launch/sprints')
    .set('Authorization', `Bearer ${token}`)
    .send({
      endDate: '2026-05-31',
      goal: 'Ship intake stabilization.',
      name: 'Sprint 1',
      startDate: '2026-05-15',
      status: 'planned',
    });

  const sprintId = sprintResponse.body.sprint.id;

  const assignResponse = await request(app)
    .post('/api/projects/project-launch/sprints/assign-items')
    .set('Authorization', `Bearer ${token}`)
    .send({
      assignments: [
        { itemId: 'story-routing', itemType: 'story', sprintId },
        { itemId: 'task-owner', itemType: 'task', sprintId: null },
      ],
    });

  assert.equal(assignResponse.status, 200);
  assert.equal(assignResponse.body.ok, true);
  assert.equal(assignResponse.body.project.epics[0].stories[0].sprintId, sprintId);
  assert.equal(assignResponse.body.project.epics[0].stories[0].tasks[0].sprintId, sprintId);
  assert.equal(assignResponse.body.project.epics[0].stories[0].tasks[1].sprintId, null);
});

test('POST /api/projects/:projectId/stories/:storyId/split creates a follow-on story and moves selected tasks', async () => {
  const { app, token } = await createPlanningTestApp();

  const splitResponse = await request(app)
    .post('/api/projects/project-launch/stories/story-routing/split')
    .set('Authorization', `Bearer ${token}`)
    .send({
      description: 'Remaining scope moved to follow-on story.',
      name: 'Routing Rules - Follow Up',
      sprintId: null,
      taskIds: ['task-owner'],
    });

  assert.equal(splitResponse.status, 200);
  assert.equal(splitResponse.body.ok, true);
  assert.equal(splitResponse.body.project.epics[0].stories.length, 2);
  assert.equal(splitResponse.body.project.epics[0].stories[0].tasks.length, 1);
  assert.equal(splitResponse.body.project.epics[0].stories[1].name, 'Routing Rules - Follow Up');
  assert.equal(splitResponse.body.project.epics[0].stories[1].tasks.length, 1);
  assert.equal(splitResponse.body.project.epics[0].stories[1].tasks[0].id, 'task-owner');
});

test('PUT /api/projects/:projectId/kanban/config stores the per-project config and GET kanban reflects filtered board cards', async () => {
  const { app, token } = await createPlanningTestApp();

  const sprintResponse = await request(app)
    .post('/api/projects/project-launch/sprints')
    .set('Authorization', `Bearer ${token}`)
    .send({
      endDate: '2026-05-31',
      goal: 'Ship intake stabilization.',
      name: 'Sprint 1',
      startDate: '2026-05-15',
      status: 'active',
    });

  const sprintId = sprintResponse.body.sprint.id;

  await request(app)
    .post('/api/projects/project-launch/sprints/assign-items')
    .set('Authorization', `Bearer ${token}`)
    .send({
      assignments: [
        { itemId: 'story-routing', itemType: 'story', sprintId },
        { itemId: 'task-rules', itemType: 'task', sprintId },
      ],
    });

  const configPayload = {
    columns: [
      { defaultStatus: 'Not Started', name: 'Ready', statuses: ['Not Started'] },
      { defaultStatus: 'In Progress', name: 'Doing', statuses: ['In Progress', 'At Risk'] },
      { defaultStatus: 'Completed', name: 'Done', statuses: ['Completed'] },
    ],
    hideDone: false,
    includeBacklog: true,
    issueTypes: ['story', 'task'],
    presets: [
      {
        filters: {
          assigneeIds: ['user-grace'],
          hideDone: false,
          includeBacklog: true,
          issueTypes: ['story', 'task'],
          search: '',
          selectedSprintIds: [sprintId],
          statusValues: [],
        },
        id: 'preset-focus',
        name: 'Grace Focus',
      },
    ],
    search: '',
    selectedSprintIds: [sprintId],
    statusValues: [],
    swimlane: 'assignee',
  };

  const saveResponse = await request(app)
    .put('/api/projects/project-launch/kanban/config')
    .set('Authorization', `Bearer ${token}`)
    .send(configPayload);

  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.body.ok, true);
  assert.equal(saveResponse.body.config.columns.length, 3);
  assert.equal(saveResponse.body.config.presets.length, 1);

  const configResponse = await request(app)
    .get('/api/projects/project-launch/kanban/config')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.body.ok, true);
  assert.equal(configResponse.body.config.swimlane, 'assignee');
  assert.equal(configResponse.body.config.presets[0].name, 'Grace Focus');

  const boardResponse = await request(app)
    .get(`/api/projects/project-launch/kanban?selectedSprintIds=${encodeURIComponent(sprintId)}&includeBacklog=1&issueTypes=story,task`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(boardResponse.status, 200);
  assert.equal(boardResponse.body.ok, true);
  assert.equal(Array.isArray(boardResponse.body.board.cards), true);
  assert.equal(boardResponse.body.board.cards.some((card) => card.id === 'story-routing'), true);
  assert.equal(boardResponse.body.board.cards.some((card) => card.id === 'task-rules'), true);
  assert.equal(boardResponse.body.board.cards.every((card) => card.issueType === 'story' || card.issueType === 'task'), true);
});

test('kanban columns can share a status and items keep the column they were placed in', async () => {
  const { app, token } = await createPlanningTestApp();

  const saveResponse = await request(app)
    .put('/api/projects/project-launch/kanban/config')
    .set('Authorization', `Bearer ${token}`)
    .send({
      columns: [
        { defaultStatus: 'In Progress', name: 'Doing', statuses: ['In Progress'] },
        { defaultStatus: 'At Risk', key: 'blocked-external', name: 'Blocked: external', statuses: ['At Risk'] },
        { defaultStatus: 'At Risk', name: 'Blocked: needs human', statuses: ['At Risk'] },
      ],
    });

  assert.equal(saveResponse.status, 200);
  assert.deepEqual(saveResponse.body.config.columns.map((column) => column.key), ['doing', 'blocked-external', 'blocked-needs-human']);

  const projectResponse = await request(app)
    .get('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`);
  const task = projectResponse.body.project.epics.flatMap((epic) => epic.stories).flatMap((story) => story.tasks).find((entry) => entry.id === 'task-rules');

  const placeResponse = await request(app)
    .patch('/api/projects/project-launch/items/task-rules')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: task.version, patch: { boardColumn: 'blocked-needs-human', status: 'At Risk' } });

  assert.equal(placeResponse.status, 200);
  assert.equal(placeResponse.body.item.boardColumn, 'blocked-needs-human');

  const boardResponse = await request(app)
    .get('/api/projects/project-launch/kanban')
    .set('Authorization', `Bearer ${token}`);
  const placedCard = boardResponse.body.board.cards.find((card) => card.id === 'task-rules');

  assert.equal(placedCard.boardColumn, 'blocked-needs-human');
  assert.equal(placedCard.columnKey, 'blocked-needs-human');

  const statusOnlyResponse = await request(app)
    .patch('/api/projects/project-launch/items/task-rules')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: placeResponse.body.item.version, patch: { status: 'In Progress' } });

  assert.equal(statusOnlyResponse.status, 200);
  assert.equal(statusOnlyResponse.body.item.boardColumn, null);

  const unplacedBlockResponse = await request(app)
    .patch('/api/projects/project-launch/items/task-rules')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: statusOnlyResponse.body.item.version, patch: { status: 'At Risk' } });
  const fallbackBoard = await request(app)
    .get('/api/projects/project-launch/kanban')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(unplacedBlockResponse.status, 200);
  assert.equal(fallbackBoard.body.board.cards.find((card) => card.id === 'task-rules').columnKey, 'blocked-external');
});

test('kanban reorder sets a board-only order that leaves sprint order untouched', async () => {
  const { app, token } = await createPlanningTestApp();
  const getBoard = () => request(app)
    .get('/api/projects/project-launch/kanban')
    .set('Authorization', `Bearer ${token}`);
  const reorder = (payload) => request(app)
    .post('/api/projects/project-launch/kanban/reorder')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);

  const initialBoard = await getBoard();
  const initialIds = initialBoard.body.board.cards.map((card) => card.id);
  const sprintOrderBefore = Object.fromEntries(initialBoard.body.board.cards.map((card) => [card.id, card.sprintSortOrder]));
  assert.ok(initialIds.length >= 3, 'fixture needs at least three board cards');

  const [first, second] = initialIds;
  const last = initialIds.at(-1);

  const toTop = await reorder({ beforeItemId: first, itemId: last });
  assert.equal(toTop.status, 200);
  assert.deepEqual((await getBoard()).body.board.cards.map((card) => card.id), [last, ...initialIds.slice(0, -1)]);

  const afterSecond = await reorder({ afterItemId: second, itemId: last });
  assert.equal(afterSecond.status, 200);
  const reorderedBoard = await getBoard();
  assert.deepEqual(reorderedBoard.body.board.cards.map((card) => card.id), [first, second, last, ...initialIds.slice(2, -1)]);
  assert.deepEqual(
    Object.fromEntries(reorderedBoard.body.board.cards.map((card) => [card.id, card.sprintSortOrder])),
    sprintOrderBefore,
  );

  const staleAnchor = await reorder({ afterItemId: 'missing-card', itemId: last });
  assert.equal(staleAnchor.status, 409);

  const missingItem = await reorder({ beforeItemId: first, itemId: 'missing-card' });
  assert.equal(missingItem.status, 404);
});

test('project-scoped writes publish one live event with the actor and originating tab', async () => {
  const { app, token } = await createPlanningTestApp();
  const events = [];
  const unsubscribe = app.locals.liveEventBus.subscribe('project:project-launch', (event) => events.push(event));
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    const projectResponse = await request(app)
      .get('/api/projects/project-launch')
      .set('Authorization', `Bearer ${token}`);
    const task = projectResponse.body.project.epics.flatMap((epic) => epic.stories).flatMap((story) => story.tasks).find((entry) => entry.id === 'task-rules');

    await request(app)
      .patch('/api/projects/project-launch/items/task-rules')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Odin-Client-Id', 'tab-123')
      .send({ expectedVersion: task.version, patch: { name: 'Define routing rules' } });
    await settle();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'project.assets.invalidated');
    assert.equal(events[0].originClientId, 'tab-123');
    assert.deepEqual(events[0].actor, { id: 'user-grace', name: 'Grace Hopper' });

    await request(app)
      .put('/api/projects/project-launch/kanban/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ columns: [] });
    await request(app)
      .patch('/api/projects/project-launch/items/task-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1, patch: { name: 'Stale write' } });
    await settle();

    assert.equal(events.length, 1, 'per-user view config and failed writes do not publish');

    await request(app)
      .post('/api/projects/project-launch/sprints')
      .set('Authorization', `Bearer ${token}`)
      .send({ endDate: '2026-05-31', goal: '', name: 'Sprint 9', startDate: '2026-05-15', status: 'planned' });
    await settle();

    assert.equal(events.length, 2);
    assert.equal(events[1].originClientId, null);
  } finally {
    unsubscribe();
  }
});
