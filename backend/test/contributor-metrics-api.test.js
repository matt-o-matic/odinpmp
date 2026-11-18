import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMetricsRepository, leaderboardWindowStart, metricDateFor } from '../src/modules/metrics/metrics.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { agentAppDeps, listen, runChatTurn, scriptedOpenAi } from './helpers/agent-test-utils.js';

function member(id, name, tenantId = 'tenant-acme', role = 'user') {
  return {
    authMethod: 'basic',
    email: `${id.replace('user-', '')}@${tenantId === 'tenant-acme' ? 'acme.com' : 'globex.com'}`,
    id,
    memberships: [{ role, tenantId }],
    name,
    // Sessions are signed directly, so no password needs hashing.
    passwordHash: 'unused',
    preferences: { twoFactorEnabled: false },
  };
}

function seedProject() {
  return {
    createdAt: '2026-05-01T10:00:00.000Z',
    description: 'Launch work.',
    endDate: '2026-12-15',
    epics: [{
      id: 'epic-launch',
      name: 'Launch',
      status: 'In Progress',
      stories: [
        {
          assigneeId: 'user-ada',
          id: 'story-routing',
          name: 'Routing',
          status: 'In Progress',
          tasks: [
            { assigneeId: 'user-ada', id: 'task-rules', name: 'Rules', points: 3, status: 'In Progress' },
            { assigneeId: 'user-alan', id: 'task-owner', name: 'Owner', points: 5, status: 'Not Started' },
          ],
        },
        { id: 'story-docs', name: 'Docs', points: 2, status: 'In Progress', tasks: [] },
      ],
    }],
    id: 'project-launch',
    name: 'Launch Readiness',
    rank: 1,
    role: 'admin',
    startDate: '2026-05-10',
    status: 'In Progress',
    tenantId: 'tenant-acme',
    updatedAt: '2026-05-12T08:30:00.000Z',
  };
}

async function signIn({ sessionsRepository, tokenService }, user, role) {
  const token = tokenService.signSessionToken({
    email: user.email,
    id: user.id,
    name: user.name,
    preferences: { twoFactorEnabled: false },
    role,
    scopes: [`T${user.memberships[0].tenantId}-${role}`],
    tenantId: user.memberships[0].tenantId,
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

async function createMetricsTestApp({ extraUsers = [], metricsRepository = createInMemoryMetricsRepository(), openAi = null, workflowRepository = undefined } = {}) {
  const grace = member('user-grace', 'Grace Hopper', 'tenant-acme', 'admin');
  const users = [
    grace,
    member('user-ada', 'Ada Lovelace'),
    member('user-alan', 'Alan Turing'),
    member('user-hedy', 'Hedy Lamarr', 'tenant-globex'),
    ...extraUsers,
  ];
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      { domains: ['acme.com'], id: 'tenant-acme', name: 'Acme' },
      { domains: ['globex.com'], id: 'tenant-globex', name: 'Globex' },
    ],
    users,
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [seedProject()] } });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const assistantRepository = createInMemoryAssistantRepository();
  const app = createApp({
    ...(openAi ? agentAppDeps(openAi) : {}),
    assistantRepository,
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    metricsRepository,
    projectRepository,
    sessionsRepository,
    tokenService,
    workflowRepository,
  });
  const context = { sessionsRepository, tokenService };
  return {
    app,
    assistantRepository,
    metricsRepository,
    projectRepository,
    token: await signIn(context, grace, 'admin'),
    tokenFor: (id, role = 'user') => signIn(context, users.find((user) => user.id === id), role),
  };
}

function totalsByUser(metricsRepository) {
  const totals = {};
  for (const row of metricsRepository.rows) {
    const current = totals[row.userId] ?? { hours: 0, points: 0, tasks: 0 };
    current.tasks += row.tasksCompleted;
    current.points += row.pointsCompleted;
    current.hours += row.hoursLogged;
    totals[row.userId] = current;
  }
  return totals;
}

async function loadProject(app, token) {
  const response = await request(app).get('/api/projects/project-launch').set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.project;
}

function findItem(project, id) {
  for (const epic of project.epics) {
    if (epic.id === id) return epic;
    for (const story of epic.stories) {
      if (story.id === id) return story;
      const task = story.tasks.find((candidate) => candidate.id === id);
      if (task) return task;
    }
  }
  return null;
}

async function patchItem(app, token, id, patch) {
  const project = await loadProject(app, token);
  const response = await request(app)
    .patch(`/api/projects/project-launch/items/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: findItem(project, id).version, patch });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('completing an item credits its assignee and reopening it takes the credit back', async () => {
  const { app, metricsRepository, token } = await createMetricsTestApp();

  await patchItem(app, token, 'task-rules', { status: 'Completed' });
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-ada': { hours: 0, points: 3, tasks: 1 } });

  // An unrelated edit to the completed item records nothing more.
  await patchItem(app, token, 'task-rules', { name: 'Routing rules' });
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-ada': { hours: 0, points: 3, tasks: 1 } });

  await patchItem(app, token, 'task-rules', { status: 'In Progress' });
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-ada': { hours: 0, points: 0, tasks: 0 } });
});

test('completing a story through the item API credits each task the cascade completes', async () => {
  const { app, metricsRepository, token } = await createMetricsTestApp();

  await patchItem(app, token, 'story-routing', { status: 'Completed' });

  assert.deepEqual(totalsByUser(metricsRepository), {
    'user-ada': { hours: 0, points: 3, tasks: 1 },
    'user-alan': { hours: 0, points: 5, tasks: 1 },
  });
});

test('unassigned work credits the person who completed it, and logged hours count for the owner', async () => {
  const { app, metricsRepository, token } = await createMetricsTestApp();

  await patchItem(app, token, 'story-docs', { actualHours: 1.5, status: 'Completed' });
  await patchItem(app, token, 'task-owner', { actualHours: 2.25 });

  assert.deepEqual(totalsByUser(metricsRepository), {
    'user-alan': { hours: 2.25, points: 0, tasks: 0 },
    'user-grace': { hours: 1.5, points: 2, tasks: 1 },
  });
});

test('tree saves record completions once, including the story cascade, and repeated saves add nothing', async () => {
  const { app, metricsRepository, token } = await createMetricsTestApp();
  const before = await loadProject(app, token);
  const epics = structuredClone(before.epics);
  epics[0].stories[0].status = 'Completed';

  const saved = await request(app)
    .put('/api/projects/project-launch/tree')
    .set('Authorization', `Bearer ${token}`)
    .send({ epics, expectedUpdatedAt: before.updatedAt });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const resaved = await request(app)
    .put('/api/projects/project-launch/tree')
    .set('Authorization', `Bearer ${token}`)
    .send({ epics: saved.body.project.epics, expectedUpdatedAt: saved.body.project.updatedAt });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));

  assert.deepEqual(totalsByUser(metricsRepository), {
    'user-ada': { hours: 0, points: 3, tasks: 1 },
    'user-alan': { hours: 0, points: 5, tasks: 1 },
  });
});

test('a metrics failure is logged and never fails the change that caused it', async () => {
  const metricsRepository = {
    async listContributorTotals() { return []; },
    async record() { throw new Error('metrics record exploded'); },
  };
  const { app, token } = await createMetricsTestApp({ metricsRepository });
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (entry) => logged.push(JSON.parse(entry));
  try {
    const result = await patchItem(app, token, 'task-rules', { status: 'Completed' });
    assert.equal(result.item.status, 'Completed');
  } finally {
    console.error = originalConsoleError;
  }

  const entry = logged.find((item) => item.message === 'Contributor metrics could not be recorded.');
  assert.ok(entry);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.context.operation, 'metrics.recordWorkCompletion');
  assert.equal(entry.context.projectId, 'project-launch');
  assert.equal(entry.context.userId, 'user-ada');
  assert.equal(entry.error.message, 'metrics record exploded');
});

test('nobody can post their own metrics any more', async () => {
  const { app, token } = await createMetricsTestApp();
  const response = await request(app)
    .post('/api/metrics/record')
    .set('Authorization', `Bearer ${token}`)
    .send({ hoursLogged: 4, pointsCompleted: 800, tasksCompleted: 3 });
  assert.equal(response.status, 404);
});

// The assistant's writes go through the same item API as a person's, so they earn the same credit.
const completeWith = (itemId, status) => scriptedOpenAi({ steps: [
  { calls: [{ args: { projectId: 'project-launch', updates: [{ itemId, patch: { status } }] }, name: 'odin_update_items' }] },
  { text: 'Done.' },
] });

test('completions the assistant makes are recorded against the assignee', async (context) => {
  const { app, metricsRepository, token } = await createMetricsTestApp({ openAi: completeWith('task-owner', 'Completed') });
  const server = await listen(app);
  context.after(server.close);

  const chat = await runChatTurn(app, token, { message: 'Mark the owner task completed.', projectId: 'project-launch' });
  assert.equal(chat.run.status, 'completed', JSON.stringify(chat.messages.at(-1)));
  assert.equal(findItem(await loadProject(app, token), 'task-owner').status, 'Completed');
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-alan': { hours: 0, points: 5, tasks: 1 } });
});

// A custom task workflow for the launch project whose done state is "Shipped".
async function shippedTaskWorkflow() {
  const workflowRepository = createInMemoryWorkflowRepository();
  const state = (key, category, extra = {}) => ({ category, initial: false, key, label: key, requiredFields: [], slaHours: 0, terminal: false, ...extra });
  const transition = (fromState, toState) => ({ allowedRoles: [], approvalRequired: false, approverRoles: [], fromState, key: `${fromState}-${toState}`, requiredFields: [], toState });
  const workflow = await workflowRepository.createWorkflow({
    input: {
      description: '', itemTypes: ['task'], name: 'Ship flow', status: 'active',
      states: [state('Not Started', 'backlog', { initial: true }), state('In Progress', 'active'), state('Shipped', 'done', { terminal: true })],
      transitions: [transition('Not Started', 'In Progress'), transition('In Progress', 'Shipped'), transition('Shipped', 'In Progress')],
    },
    tenantId: 'tenant-acme',
  });
  await workflowRepository.createBinding({ input: { itemType: 'task', projectId: 'project-launch', workflowId: workflow.id }, tenantId: 'tenant-acme' });
  return workflowRepository;
}

test('a custom workflow done state earns credit through the item API and the assistant', async (context) => {
  const { app, metricsRepository, token } = await createMetricsTestApp({ openAi: completeWith('task-rules', 'Shipped'), workflowRepository: await shippedTaskWorkflow() });

  await patchItem(app, token, 'task-rules', { status: 'Shipped' });
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-ada': { hours: 0, points: 3, tasks: 1 } });
  await patchItem(app, token, 'task-rules', { status: 'In Progress' });
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-ada': { hours: 0, points: 0, tasks: 0 } });

  const server = await listen(app);
  context.after(server.close);
  const chat = await runChatTurn(app, token, { message: 'Ship the rules task.', projectId: 'project-launch' });
  assert.equal(chat.run.status, 'completed', JSON.stringify(chat.messages.at(-1)));
  assert.deepEqual(totalsByUser(metricsRepository), { 'user-ada': { hours: 0, points: 3, tasks: 1 } });
});

test('the leaderboard ranks current tenant members by points in the chosen period', async () => {
  const today = metricDateFor();
  const metricsRepository = createInMemoryMetricsRepository([
    { hoursLogged: 2, metricDate: today, pointsCompleted: 8, tasksCompleted: 2, tenantId: 'tenant-acme', userId: 'user-ada' },
    { hoursLogged: 0, metricDate: today, pointsCompleted: 5, tasksCompleted: 1, tenantId: 'tenant-acme', userId: 'user-alan' },
    { hoursLogged: 0, metricDate: leaderboardWindowStart(30), pointsCompleted: 5, tasksCompleted: 3, tenantId: 'tenant-acme', userId: 'user-grace' },
    { hoursLogged: 0, metricDate: leaderboardWindowStart(31), pointsCompleted: 50, tasksCompleted: 9, tenantId: 'tenant-acme', userId: 'user-alan' },
    { hoursLogged: 0, metricDate: today, pointsCompleted: 99, tasksCompleted: 9, tenantId: 'tenant-globex', userId: 'user-hedy' },
    { hoursLogged: 0, metricDate: today, pointsCompleted: 70, tasksCompleted: 7, tenantId: 'tenant-acme', userId: 'user-removed' },
  ]);
  const { app, token } = await createMetricsTestApp({ metricsRepository });

  const month = await request(app).get('/api/metrics/leaderboard?days=30').set('Authorization', `Bearer ${token}`);
  assert.equal(month.status, 200, JSON.stringify(month.body));
  assert.equal(month.body.days, 30);
  assert.deepEqual(month.body.leaderboard.map((row) => [row.rank, row.id, row.points, row.tasksCompleted, row.hoursLogged, row.isCurrentUser]), [
    [1, 'user-ada', 8, 2, 2, false],
    [2, 'user-grace', 5, 3, 0, true],
    [2, 'user-alan', 5, 1, 0, false],
  ]);
  assert.equal(month.body.leaderboard[0].name, 'Ada Lovelace');
  assert.equal(month.body.currentUser.rank, 2);

  const week = await request(app).get('/api/metrics/leaderboard?days=7').set('Authorization', `Bearer ${token}`);
  assert.deepEqual(week.body.leaderboard.map((row) => row.id), ['user-ada', 'user-alan']);
  assert.equal(week.body.currentUser, null);
});

test('metrics are recorded per project, and deleted projects drop out of the leaderboard until restored', async () => {
  const { app, metricsRepository, projectRepository, token } = await createMetricsTestApp();
  await patchItem(app, token, 'task-rules', { status: 'Completed' });
  assert.deepEqual(metricsRepository.rows.map((row) => [row.userId, row.projectId, row.tasksCompleted]), [['user-ada', 'project-launch', 1]]);

  const perProject = await metricsRepository.listContributorTotals({ projectId: 'project-launch', tenantId: 'tenant-acme', users: [{ id: 'user-ada', memberships: [{ tenantId: 'tenant-acme' }], name: 'Ada Lovelace' }] });
  assert.deepEqual(perProject.map((row) => [row.id, row.points]), [['user-ada', 3]]);
  assert.deepEqual(await metricsRepository.listContributorTotals({ projectId: 'project-other', tenantId: 'tenant-acme', users: [] }), []);

  const leaderboard = async () => (await request(app).get('/api/metrics/leaderboard').set('Authorization', `Bearer ${token}`)).body.leaderboard.map((row) => row.id);
  assert.deepEqual(await leaderboard(), ['user-ada']);

  const deleted = await request(app).delete('/api/projects/project-launch').set('Authorization', `Bearer ${token}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(await projectRepository.getProjectDeletionState({ projectId: 'project-launch', tenantId: 'tenant-acme' }), 'deleted');
  assert.deepEqual(await leaderboard(), []);

  const restored = await request(app).post('/api/projects/project-launch/restore').set('Authorization', `Bearer ${token}`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(await leaderboard(), ['user-ada']);
});

test('the current user sees their own position when it falls outside the top ten', async () => {
  const today = metricDateFor();
  const extraUsers = Array.from({ length: 11 }, (_, index) => member(`user-extra-${index}`, `Extra ${index}`));
  const metricsRepository = createInMemoryMetricsRepository([
    ...extraUsers.map((user, index) => ({ hoursLogged: 0, metricDate: today, pointsCompleted: 20 + index, tasksCompleted: 1, tenantId: 'tenant-acme', userId: user.id })),
    { hoursLogged: 0, metricDate: today, pointsCompleted: 1, tasksCompleted: 1, tenantId: 'tenant-acme', userId: 'user-grace' },
  ]);
  const { app, token } = await createMetricsTestApp({ extraUsers, metricsRepository });

  const response = await request(app).get('/api/metrics/leaderboard').set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.leaderboard.length, 10);
  assert.equal(response.body.contributorCount, 12);
  assert.equal(response.body.leaderboard.some((row) => row.isCurrentUser), false);
  assert.deepEqual(
    [response.body.currentUser.rank, response.body.currentUser.id, response.body.currentUser.points],
    [12, 'user-grace', 1],
  );
});
