import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { generateAccessToken, hashAccessToken } from '../src/modules/access/access-links.js';
import { createInMemoryAccessRepository } from '../src/modules/access/access.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryBillingRepository } from '../src/modules/billing/billing.repository.js';
import { createInMemoryMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryRankingRepository } from '../src/modules/ranking/ranking.repository.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { createInMemoryRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';
import {
  canOutsiderChangePursuitTask,
  listPursuitTasksVisibleTo,
  requireOutsiderPursuitChange,
} from '../src/modules/pursuit/pursuit-visibility.js';

// The pursuit board and insights (docs/engagements/plan.md "Pursuit board", "Pursuit insights";
// AC-20, AC-21, AC-22).

const TENANT = 'tenant-acme';
const DAY_MS = 86_400_000;
const dateIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const users = [
  { authMethod: 'basic', email: 'grace@acme.com', id: 'grace', memberships: [{ role: 'admin', tenantId: TENANT }], name: 'Grace Admin', password: 'Secret123!' },
  { authMethod: 'basic', email: 'alan@acme.com', id: 'alan', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Alan Seller', password: 'Secret123!' },
  { authMethod: 'basic', email: 'carol@acme.com', id: 'carol', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Carol Member', password: 'Secret123!' },
  { authMethod: 'basic', email: 'dev@acme.com', id: 'dev', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Dev Contributor', password: 'Secret123!' },
  { authMethod: 'basic', email: 'oscar@acme.com', id: 'oscar', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Oscar Outsider', password: 'Secret123!' },
];

async function fixture({ sowLinkReader = null } = {}) {
  // invoice-gen's link, as billing stores it (0099_billing); the SOW card reads it unless a test passes its own reader.
  const billingRepository = createInMemoryBillingRepository();
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }], users });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: { 'project-launch': [{ id: 'alan', role: 'admin' }, { id: 'carol', role: 'user' }] },
      projects: [{
        description: 'Delivery work', endDate: null, id: 'project-launch', name: 'Launch', startDate: null, status: 'In Progress', tenantId: TENANT, updatedAt: '2026-07-11T00:00:00.000Z',
        epics: [{ description: '', id: 'epic-1', name: 'Delivery', status: 'Not Started', stories: [{ description: '', id: 'story-1', name: 'Pilot', status: 'Not Started', tasks: [{ id: 'task-delivery', name: 'Delivery task', status: 'Not Started' }] }] }],
      }],
    },
  });
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  const casey = await resourceFinanceRepository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: 'casey@vendor.example', location: '', minBillRate: null, name: 'Casey Contractor', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId: TENANT });
  const dana = await resourceFinanceRepository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: 'dana@vendor.example', location: '', minBillRate: null, name: 'Dana Vendor', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId: TENANT });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const accessRepository = createInMemoryAccessRepository();
  const workflowRepository = createInMemoryWorkflowRepository();
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  const metricsRepository = createInMemoryMetricsRepository();
  const rankingRepository = createInMemoryRankingRepository({ authRepository, projectRepository });
  const tokenService = createTokenService({ issuer: 'test', secret: 'pursuit-api-test-secret-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken({ ...user, tenantId: TENANT });
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  const app = createApp({
    accessRateLimiter: createRequirementsPublicRateLimiter({ ip: { capacity: 10_000, refillPerSecond: 1_000 }, link: { capacity: 10_000, refillPerSecond: 1_000 } }),
    accessRepository, agentMonitorSweepIntervalMs: 0, assistantRepository, assistantStaleRunSweepIntervalMs: 0, authRepository, billingRepository, domainEventSweepIntervalMs: 0,
    metricsRepository, projectRepository, rankingRepository, requirementsRepository, resourceFinanceRepository, sessionsRepository, sowLinkReader, tokenService, workflowRepository, workspaceModulesRepository,
  });
  const as = (id) => `Bearer ${tokens.get(id)}`;
  const api = {
    delete: (id, path, body = {}) => request(app).delete(path).set('Authorization', as(id)).send(body),
    get: (id, path) => request(app).get(path).set('Authorization', as(id)),
    patch: (id, path, body = {}) => request(app).patch(path).set('Authorization', as(id)).send(body),
    post: (id, path, body = {}) => request(app).post(path).set('Authorization', as(id)).send(body),
    put: (id, path, body = {}) => request(app).put(path).set('Authorization', as(id)).send(body),
  };
  const link = (token) => ({
    get: (path = '') => request(app).get(`/api/public/access/${token}${path}`),
    patch: (path, body) => request(app).patch(`/api/public/access/${token}${path}`).send(body),
    post: (path, body = {}) => request(app).post(`/api/public/access/${token}${path}`).send(body),
  });

  async function switchConsulting(enabled) {
    const current = (await api.get('grace', '/api/workspace/modules')).body.modules.find((entry) => entry.key === 'consulting');
    const response = await api.put('grace', '/api/workspace/modules', { enabled, expectedVersion: current.version, key: 'consulting' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  // An engagement Alan owns, with Carol (no plan rights) and Dev (a project manager) on it.
  async function createEngagement() {
    await switchConsulting(true);
    const created = await api.post('alan', '/api/engagements', { customer: 'Northwind', name: 'Northwind data platform' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const members = await api.put('alan', `/api/projects/${projectId}/permissions`, { validUsers: [{ id: 'alan', role: 'admin' }, { id: 'carol', role: 'user' }, { id: 'dev', role: 'manager' }] });
    assert.equal(members.status, 200, JSON.stringify(members.body));
    const pursuit = await api.get('alan', `/api/projects/${projectId}/pursuit`);
    assert.equal(pursuit.status, 200, JSON.stringify(pursuit.body));
    return { projectId, storyId: pursuit.body.storyId };
  }
  async function addTask({ projectId, storyId }, item, as = 'alan') {
    const response = await api.post(as, `/api/projects/${projectId}/items`, { item: { status: 'Not Started', ...item }, itemType: 'task', parentId: storyId });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.item;
  }
  async function linkToken(email) {
    const token = generateAccessToken();
    await accessRepository.issueLinkToken({ createdBy: 'user:alan', email, now: new Date(), purpose: 'manual', tenantId: TENANT, tokenHash: hashAccessToken(token) });
    return token;
  }
  const deps = { assistantRepository, projectRepository, resourceFinanceRepository };
  return { accessRepository, addTask, api, app, assistantRepository, billingRepository, casey, createEngagement, dana, deps, link, linkToken, metricsRepository, projectRepository, switchConsulting, workflowRepository };
}

const cardNames = (board) => board.cards.map((card) => card.name).sort();
const json = (body) => JSON.stringify(body);

test('a new engagement gets a hidden Pursuit story; members add, assign and move pursuit tasks on its board (AC-20)', async () => {
  const f = await fixture();
  const engagement = await f.createEngagement();
  assert.ok(engagement.storyId, 'the Pursuit story exists');
  const pursuit = (await f.api.get('alan', `/api/projects/${engagement.projectId}/pursuit`)).body;
  assert.equal(pursuit.project.epics.length, 1);
  assert.equal(pursuit.project.epics[0].pursuit, true);
  assert.equal(pursuit.viewer.canEdit, true);
  assert.equal(pursuit.viewer.canManageSettings, true);

  const deck = await f.addTask(engagement, { assigneeId: 'carol', name: 'Kickoff deck', targetEndDate: dateIn(3) });
  await f.addTask(engagement, { name: 'Pricing model' }, 'dev');
  assert.equal(deck.pursuit, true, 'a task under the Pursuit story is pursuit work');
  assert.equal((await f.api.post('carol', `/api/projects/${engagement.projectId}/items`, { item: { name: 'No rights', status: 'Not Started' }, itemType: 'task', parentId: engagement.storyId })).status, 404, 'adding needs plan rights, as on any board');

  // The engagement's board is its pursuit board: tasks only, no hidden story card.
  const board = await f.api.get('carol', `/api/projects/${engagement.projectId}/kanban`);
  assert.equal(board.status, 200, json(board.body));
  assert.equal(board.body.board.scope, 'pursuit');
  assert.deepEqual(cardNames(board.body.board), ['Kickoff deck', 'Pricing model']);
  assert.ok(board.body.board.cards.every((card) => card.issueType === 'task'));
  // A saved view that filters sprints or types never hides pursuit cards.
  assert.equal((await f.api.put('alan', `/api/projects/${engagement.projectId}/kanban/config?scope=pursuit`, { columns: [], issueTypes: ['story'], selectedSprintIds: ['sprint-x'] })).status, 200);
  assert.deepEqual(cardNames((await f.api.get('alan', `/api/projects/${engagement.projectId}/kanban?scope=pursuit`)).body.board), ['Kickoff deck', 'Pricing model']);

  // Move: status and assignee, then reorder.
  const moved = await f.api.patch('dev', `/api/projects/${engagement.projectId}/items/${deck.id}`, { expectedVersion: deck.version, patch: { assigneeId: 'dev', status: 'In Progress' } });
  assert.equal(moved.status, 200, json(moved.body));
  assert.equal(moved.body.item.pursuit, true);
  assert.deepEqual(moved.body.project.epics.map((epic) => epic.pursuit), [true], 'a pursuit write answers with the pursuit work');
  const reordered = await f.api.post('alan', `/api/projects/${engagement.projectId}/kanban/reorder?scope=pursuit`, { afterItemId: null, beforeItemId: null, itemId: deck.id });
  assert.equal(reordered.status, 200, json(reordered.body));
  const after = (await f.api.get('alan', `/api/projects/${engagement.projectId}/kanban`)).body.board.cards.find((card) => card.id === deck.id);
  assert.deepEqual([after.status, after.assigneeId], ['In Progress', 'dev']);

  // Comments and attachments work on pursuit tasks as on any task.
  const comment = await f.api.post('carol', `/api/projects/${engagement.projectId}/comments`, { comment: '<p>Draft is up</p>', parentId: null, targetId: deck.id, targetType: 'task' });
  assert.ok([200, 201].includes(comment.status), json(comment.body));
  const file = await f.api.post('carol', `/api/projects/${engagement.projectId}/files`, { fileContentsBase64: Buffer.from('deck').toString('base64'), fileDescription: '', fileName: 'deck.txt', fileType: 'text/plain', targetId: deck.id, targetType: 'task' });
  assert.equal(file.status, 201, json(file.body));

  // The plan of an engagement has no pursuit work in it.
  assert.deepEqual((await f.api.get('alan', `/api/projects/${engagement.projectId}`)).body.project.epics, []);
  assert.equal((await f.api.get('oscar', `/api/projects/${engagement.projectId}/kanban`)).status, 404, 'people outside the engagement see nothing');
});

test('after conversion, pursuit tasks stay off every delivery view and on the Pursuit board (AC-21)', async (t) => {
  const f = await fixture();
  const engagement = await f.createEngagement();
  const { projectId } = engagement;
  const pursuitTask = await f.addTask(engagement, { assigneeId: 'carol', name: 'Zebra pursuit task', targetEndDate: dateIn(2) });
  // Done pursuit work would earn leaderboard credit if pursuit work were not left out.
  const done = await f.api.patch('alan', `/api/projects/${projectId}/items/${pursuitTask.id}`, { expectedVersion: pursuitTask.version, patch: { status: 'Completed' } });
  assert.equal(done.status, 200, json(done.body));
  // Open pursuit work assigned to Carol, which her Home would list.
  await f.addTask(engagement, { assigneeId: 'carol', name: 'Zebra pursuit task, open', targetEndDate: dateIn(1) });
  const converted = await f.api.post('alan', `/api/projects/${projectId}/convert`, {});
  assert.equal(converted.status, 200, json(converted.body));
  assert.deepEqual(converted.body.movedPursuitTaskIds, []);
  // Delivery work beside it, which every view must show.
  const plan = (await f.api.get('alan', `/api/projects/${projectId}`)).body.project;
  const savedTree = await f.api.put('alan', `/api/projects/${projectId}/tree`, {
    epics: [...plan.epics, { description: '', id: 'epic-d', name: 'Build', status: 'Not Started', stories: [{ description: '', id: 'story-d', name: 'Platform', status: 'Not Started', tasks: [{ assigneeId: 'carol', id: 'task-d', name: 'Yak delivery task', status: 'Not Started', targetEndDate: dateIn(2) }, { assigneeId: 'carol', id: 'task-d2', name: 'Yak delivery task, open', status: 'In Progress', targetEndDate: dateIn(1) }] }] }],
    expectedUpdatedAt: plan.updatedAt,
  });
  assert.equal(savedTree.status, 200, json(savedTree.body));
  const deliveryTask = savedTree.body.project.epics[0].stories[0].tasks[0];
  assert.equal((await f.api.patch('carol', `/api/projects/${projectId}/items/task-d`, { expectedVersion: deliveryTask.version, patch: { status: 'In Progress' } })).status, 404, 'carol has no plan rights');
  assert.equal((await f.api.patch('alan', `/api/projects/${projectId}/items/task-d`, { expectedVersion: deliveryTask.version, patch: { status: 'Completed' } })).status, 200);

  const leaks = (body) => json(body).includes('Zebra pursuit task') || json(body).includes(pursuitTask.id);
  const shows = (body) => json(body).includes('Yak delivery task') || json(body).includes('task-d');
  async function view(userId, path, label) {
    const response = await f.api.get(userId, path);
    assert.equal(response.status, 200, `${label}: ${json(response.body)}`);
    assert.equal(leaks(response.body), false, `${label} leaves the pursuit task out`);
    assert.ok(shows(response.body), `${label} shows the delivery task`);
    return response.body;
  }

  await t.test('delivery board', async () => {
    const board = await view('alan', `/api/projects/${projectId}/kanban`, 'delivery board');
    assert.equal(board.board.scope, 'delivery');
    await view('alan', `/api/projects/${projectId}/kanban?scope=delivery`, 'delivery board by name');
  });
  await t.test('plan', async () => {
    const body = await view('alan', `/api/projects/${projectId}`, 'plan');
    assert.deepEqual(body.project.epics.map((epic) => epic.name), ['Build']);
  });
  await t.test('sprint planning backlog', async () => {
    await view('alan', `/api/projects/${projectId}/sprints`, 'sprints');
  });
  await t.test('reports and BI feeds', async () => {
    await view('grace', '/api/reporting/bi/work_items', 'BI work items');
  });
  await t.test('Home', async () => {
    await view('carol', '/api/home', 'Home');
  });
  await t.test('leaderboard', async () => {
    const leaderboard = await f.api.get('grace', '/api/metrics/leaderboard?days=30');
    assert.equal(leaderboard.status, 200);
    assert.deepEqual(leaderboard.body.leaderboard.map((row) => [row.id, row.tasksCompleted]), [['carol', 1]], 'only the delivery task earns credit');
  });
  await t.test('Insights', async () => {
    // History from earlier days: replayed, the pursuit task would count on past days.
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();
    for (const revision of f.projectRepository.state.projectItemRevisions.filter((entry) => entry.itemId === pursuitTask.id && entry.action === 'create')) revision.createdAt = twoDaysAgo;
    const insights = await f.api.get('alan', `/api/projects/${projectId}/insights?days=30&unit=items`);
    assert.equal(insights.status, 200, json(insights.body));
    assert.equal(leaks(insights.body), false, 'Insights leaves the pursuit task out');
    const scopes = insights.body.cards.burnup.data.series.map((point) => point.scope);
    assert.equal(scopes.at(-1), 2, 'burnup counts the delivery tasks');
    // The delivery tasks were made today, so no earlier day has any scope.
    assert.ok(scopes.slice(0, -1).every((scope) => scope === 0), `earlier days: ${json(scopes)}`);
  });
  await t.test('the Pursuit board keeps every pursuit task', async () => {
    const board = (await f.api.get('carol', `/api/projects/${projectId}/kanban?scope=pursuit`)).body.board;
    assert.deepEqual(cardNames(board), ['Zebra pursuit task', 'Zebra pursuit task, open']);
    const pursuit = (await f.api.get('carol', `/api/projects/${projectId}/pursuit`)).body;
    assert.equal(pursuit.taskCount, 2);
  });
  await t.test('saving the plan keeps pursuit work', async () => {
    const current = (await f.api.get('alan', `/api/projects/${projectId}`)).body.project;
    const saved = await f.api.put('alan', `/api/projects/${projectId}/tree`, { epics: current.epics, expectedUpdatedAt: current.updatedAt });
    assert.equal(saved.status, 200);
    assert.equal(leaks(saved.body), false);
    assert.equal((await f.api.get('alan', `/api/projects/${projectId}/pursuit`)).body.taskCount, 2);
  });
});

test('converting moves open pursuit tasks to the project board only when asked (AC-21)', async (t) => {
  for (const moveOpenPursuitTasks of [false, true]) {
    await t.test(moveOpenPursuitTasks ? 'with the option' : 'without the option', async () => {
      const f = await fixture();
      const engagement = await f.createEngagement();
      const open = await f.addTask(engagement, { name: 'Open task', status: 'In Progress' });
      await f.addTask(engagement, { name: 'Done task', status: 'Completed' });
      const converted = await f.api.post('alan', `/api/projects/${engagement.projectId}/convert`, { moveOpenPursuitTasks });
      assert.equal(converted.status, 200, json(converted.body));
      const plan = (await f.api.get('alan', `/api/projects/${engagement.projectId}`)).body.project;
      const pursuitBoard = (await f.api.get('alan', `/api/projects/${engagement.projectId}/kanban?scope=pursuit`)).body.board;
      const deliveryBoard = (await f.api.get('alan', `/api/projects/${engagement.projectId}/kanban`)).body.board;
      if (moveOpenPursuitTasks) {
        assert.deepEqual(converted.body.movedPursuitTaskIds, [open.id]);
        assert.deepEqual(plan.epics.map((epic) => [epic.name, epic.stories.map((story) => [story.name, story.tasks.map((task) => task.name)])]), [['Pursuit handover', [['Open pursuit tasks', ['Open task']]]]]);
        assert.equal(plan.epics[0].stories[0].tasks[0].pursuit, undefined, 'a moved task is delivery work');
        assert.deepEqual(cardNames(pursuitBoard), ['Done task']);
        assert.ok(cardNames(deliveryBoard).includes('Open task'));
      } else {
        assert.deepEqual(plan.epics, []);
        assert.deepEqual(cardNames(pursuitBoard), ['Done task', 'Open task']);
        assert.deepEqual(cardNames(deliveryBoard), []);
      }
    });
  }
});

test('people who can edit the plan move pursuit tasks later, one or several, under a story they choose (AC-21)', async () => {
  const f = await fixture();
  const engagement = await f.createEngagement();
  const first = await f.addTask(engagement, { name: 'Send diagrams' });
  const second = await f.addTask(engagement, { name: 'Book workshop' });
  const third = await f.addTask(engagement, { name: 'Stay on pursuit' });
  assert.equal((await f.api.post('alan', `/api/projects/${engagement.projectId}/convert`, {})).status, 200);
  const plan = (await f.api.get('alan', `/api/projects/${engagement.projectId}`)).body.project;
  const tree = await f.api.put('alan', `/api/projects/${engagement.projectId}/tree`, {
    epics: [{ description: '', id: 'epic-a', name: 'Delivery', status: 'Not Started', stories: [{ description: '', id: 'story-a', name: 'Discovery', status: 'Not Started', tasks: [] }, { description: '', id: 'story-b', name: 'Build', status: 'Not Started', tasks: [] }] }],
    expectedUpdatedAt: plan.updatedAt,
  });
  assert.equal(tree.status, 200, json(tree.body));
  const movePath = `/api/projects/${engagement.projectId}/pursuit/move`;

  assert.equal((await f.api.post('carol', movePath, { storyId: 'story-b', taskIds: [first.id] })).status, 404, 'moving needs plan rights');
  const toPursuit = await f.api.post('alan', movePath, { storyId: engagement.storyId, taskIds: [first.id] });
  assert.deepEqual([toPursuit.status, toPursuit.body.details.code], [400, 'story_not_found'], 'the target is a story on the plan');
  const notPursuit = await f.api.post('alan', movePath, { storyId: 'story-b', taskIds: [first.id, 'task-unknown'] });
  assert.deepEqual([notPursuit.status, notPursuit.body.details.code], [409, 'not_a_pursuit_task']);
  const stale = await f.api.post('alan', movePath, { expectedVersions: { [first.id]: 99 }, storyId: 'story-b', taskIds: [first.id] });
  assert.deepEqual([stale.status, stale.body.details.code], [409, 'project_item_version_conflict']);
  assert.equal((await f.api.get('alan', `/api/projects/${engagement.projectId}/pursuit`)).body.taskCount, 3, 'a refused move moves nothing');

  const moved = await f.api.post('dev', movePath, { storyId: 'story-b', taskIds: [first.id, second.id] });
  assert.equal(moved.status, 200, json(moved.body));
  assert.deepEqual(moved.body.moved.map((entry) => entry.id), [first.id, second.id]);
  const build = moved.body.project.epics[0].stories.find((story) => story.id === 'story-b');
  assert.deepEqual(build.tasks.map((task) => task.name), ['Send diagrams', 'Book workshop']);
  assert.deepEqual(cardNames((await f.api.get('alan', `/api/projects/${engagement.projectId}/kanban?scope=pursuit`)).body.board), ['Stay on pursuit']);
  assert.ok(cardNames((await f.api.get('alan', `/api/projects/${engagement.projectId}/kanban`)).body.board).includes('Send diagrams'));
  const revisions = await f.api.get('alan', `/api/projects/${engagement.projectId}/items/${first.id}/revisions`);
  assert.equal(revisions.body.revisions[0].after.parentId, 'story-b', 'the move is in the task history');
  assert.ok(third.id);
});

test('outside people see their own pursuit tasks, or all of them with "Guests see the whole board", and change only their own (AC-20)', async (t) => {
  const f = await fixture();
  const engagement = await f.createEngagement();
  const { projectId } = engagement;
  const stakeholder = await f.assistantRepository.createProjectStakeholder({ projectId, tenantId: TENANT, value: { email: 'pat@customer.example', name: 'Pat Customer', roleTitle: 'IT lead' } });
  const caseyAsStakeholder = await f.assistantRepository.createProjectStakeholder({ projectId, tenantId: TENANT, value: { email: 'casey@vendor.example', name: 'Casey C.', roleTitle: 'Vendor' } });
  const caseys = await f.addTask(engagement, { assigneeId: `resource:${f.casey.id}`, name: 'Casey: network diagrams' });
  const pats = await f.addTask(engagement, { assigneeId: `stakeholder:${stakeholder.id}`, name: 'Pat: current licences' });
  await f.addTask(engagement, { assigneeId: 'alan', name: 'Internal pricing' });
  const visible = async (principal) => (await listPursuitTasksVisibleTo(f.deps, { principal, projectId, tenantId: TENANT })).tasks.map((task) => [task.name, task.mine, task.canChange.length > 0]).sort();
  const alan = users.find((user) => user.id === 'alan');
  const oscar = users.find((user) => user.id === 'oscar');

  await t.test('members see every task', async () => {
    assert.deepEqual(await visible({ type: 'user', user: alan }), [['Casey: network diagrams', false, true], ['Internal pricing', true, true], ['Pat: current licences', false, true]]);
    await assert.rejects(listPursuitTasksVisibleTo(f.deps, { principal: { type: 'user', user: oscar }, projectId, tenantId: TENANT }), (error) => error.statusCode === 404);
  });
  await t.test('with the setting off, outside people see only their own', async () => {
    assert.deepEqual(await visible({ id: f.casey.id, type: 'resource' }), [['Casey: network diagrams', true, true]]);
    assert.deepEqual(await visible({ id: stakeholder.id, type: 'stakeholder' }), [['Pat: current licences', true, true]]);
    // A stakeholder is the same person as a profile without a login with their email.
    assert.deepEqual(await visible({ id: caseyAsStakeholder.id, type: 'stakeholder' }), [['Casey: network diagrams', true, true]]);
    assert.deepEqual(await visible({ id: f.dana.id, type: 'resource' }), [], 'someone with no tasks sees none');
    assert.deepEqual(await visible({ id: 'stakeholder-elsewhere', type: 'stakeholder' }), [], 'a stakeholder of another project sees none');
  });
  await t.test('with the setting on, they see every task and still change only their own', async () => {
    const settings = (await f.api.get('alan', `/api/projects/${projectId}/settings`)).body.settings;
    assert.equal((await f.api.put('alan', `/api/projects/${projectId}/settings`, { expectedVersion: settings.version, guestsSeeBoard: true })).status, 200);
    assert.deepEqual(await visible({ id: stakeholder.id, type: 'stakeholder' }), [['Casey: network diagrams', false, false], ['Internal pricing', false, false], ['Pat: current licences', true, true]]);
    assert.deepEqual(await visible({ id: 'stakeholder-elsewhere', type: 'stakeholder' }), [], 'only the engagement\'s own outside people');
    const principal = { id: stakeholder.id, type: 'stakeholder' };
    for (const change of ['status', 'comment', 'attachment']) {
      assert.equal((await requireOutsiderPursuitChange(f.deps, { change, principal, projectId, taskId: pats.id, tenantId: TENANT })).id, pats.id);
      await assert.rejects(requireOutsiderPursuitChange(f.deps, { change, principal, projectId, taskId: caseys.id, tenantId: TENANT }), (error) => error.statusCode === 403 && error.details.code === 'not_your_task');
    }
    await assert.rejects(requireOutsiderPursuitChange(f.deps, { change: 'status', principal, projectId, taskId: 'task-delivery', tenantId: TENANT }), (error) => error.statusCode === 404);
    assert.equal(canOutsiderChangePursuitTask({ assigneeIds: new Set([`stakeholder:${stakeholder.id}`]), change: 'delete', task: pats }), false, 'only status, comments and attachments');
  });
});

test('a person without a login sees their assigned pursuit tasks through their task-access link and changes only those (AC-20)', async (t) => {
  const f = await fixture();
  const engagement = await f.createEngagement();
  const { projectId } = engagement;
  const mine = await f.addTask(engagement, { assigneeId: `resource:${f.casey.id}`, name: 'Casey: network diagrams' });
  const others = await f.addTask(engagement, { assigneeId: 'alan', name: 'Internal pricing' });
  const token = await f.linkToken('casey@vendor.example');
  const link = f.link(token);

  await t.test('the hub lists the engagement and its board shows only their task', async () => {
    const hub = await link.get();
    assert.equal(hub.status, 200, json(hub.body));
    assert.deepEqual(hub.body.projects.map((project) => [project.id, project.tasks?.scope ?? null]), [[projectId, 'own']]);
    const board = await link.get(`/projects/${projectId}/tasks`);
    assert.equal(board.status, 200, json(board.body));
    assert.deepEqual(board.body.items.map((item) => [item.name, item.mine]), [['Casey: network diagrams', true]]);
    assert.deepEqual(board.body.stories.map((story) => story.canAddTask), [false], 'nobody adds pursuit tasks from a link');
  });
  await t.test('they change the status of and comment on their own task', async () => {
    const changed = await link.patch(`/projects/${projectId}/tasks/${mine.id}`, { expectedVersion: mine.version, status: 'In Progress' });
    assert.equal(changed.status, 200, json(changed.body));
    assert.equal(changed.body.task.status, 'In Progress');
    const comment = await link.post(`/projects/${projectId}/tasks/${mine.id}/comments`, { text: 'Uploaded the diagrams.' });
    assert.equal(comment.status, 201, json(comment.body));
    const hours = await link.patch(`/projects/${projectId}/tasks/${mine.id}`, { expectedVersion: changed.body.task.version, remainingHours: 2 });
    assert.deepEqual([hours.status, hours.body.details.code], [403, 'not_allowed_on_pursuit_task']);
    const time = await link.post(`/projects/${projectId}/tasks/${mine.id}/time`, { hours: 1, workDate: dateIn(0) });
    assert.deepEqual([time.status, time.body.details?.code], [403, 'not_allowed_on_pursuit_task']);
  });
  await t.test('tasks that are not theirs are refused', async () => {
    const update = await link.patch(`/projects/${projectId}/tasks/${others.id}`, { expectedVersion: others.version, status: 'In Progress' });
    assert.deepEqual([update.status, update.body.details.code], [403, 'not_your_task']);
    const comment = await link.post(`/projects/${projectId}/tasks/${others.id}/comments`, { text: 'hi' });
    assert.deepEqual([comment.status, comment.body.details.code], [403, 'not_your_task']);
    const read = await link.get(`/projects/${projectId}/tasks/${others.id}/comments`);
    assert.deepEqual([read.status, read.body.details.code], [404, 'task_not_found']);
    const story = await link.post(`/projects/${projectId}/stories/${engagement.storyId}/tasks`, { name: 'Sneaky' });
    assert.deepEqual([story.status, story.body.details.code], [403, 'story_not_available']);
  });
  await t.test('with "Guests see the whole board" they see every pursuit task, and still change only theirs', async () => {
    const settings = (await f.api.get('alan', `/api/projects/${projectId}/settings`)).body.settings;
    assert.equal((await f.api.put('alan', `/api/projects/${projectId}/settings`, { expectedVersion: settings.version, guestsSeeBoard: true })).status, 200);
    const board = await link.get(`/projects/${projectId}/tasks`);
    assert.deepEqual(board.body.items.map((item) => [item.name, item.mine]).sort(), [['Casey: network diagrams', true], ['Internal pricing', false]]);
    assert.equal((await link.get(`/projects/${projectId}/tasks/${others.id}/comments`)).status, 200);
    assert.equal((await link.patch(`/projects/${projectId}/tasks/${others.id}`, { expectedVersion: others.version, status: 'In Progress' })).status, 403);
  });
  await t.test('someone with no pursuit task on it is not let in', async () => {
    const dana = f.link(await f.linkToken('dana@vendor.example'));
    assert.deepEqual((await dana.get()).body.projects, []);
    const board = await dana.get(`/projects/${projectId}/tasks`);
    assert.deepEqual([board.status, board.body.details.code], [404, 'no_project_access']);
  });
  await t.test('with the Consulting module off the engagement leaves the link', async () => {
    await f.switchConsulting(false);
    const hub = await link.get();
    assert.ok(hub.status === 410 || !hub.body.projects?.some((project) => project.id === projectId), json(hub.body));
    await f.switchConsulting(true);
    assert.equal((await link.get()).body.projects[0].id, projectId);
  });
});

test('everyone on the project reads the settings; only decision rights change them (AC-25 setting)', async () => {
  const f = await fixture();
  const { projectId } = await f.createEngagement();
  const path = `/api/projects/${projectId}/settings`;
  const read = await f.api.get('carol', path);
  assert.equal(read.status, 200, json(read.body));
  assert.deepEqual([read.body.settings.guestsSeeBoard, 'odinRepliesEnabled' in read.body.settings, read.body.settings.version, read.body.canManage], [false, false, 0, false]);
  assert.equal((await f.api.get('oscar', path)).status, 404, 'outside the project');

  const refused = await f.api.put('carol', path, { expectedVersion: 0, guestsSeeBoard: true });
  assert.deepEqual([refused.status, refused.body.details?.code], [403, 'decision_rights_required'], 'a member without decision rights');
  assert.equal((await f.api.put('oscar', path, { expectedVersion: 0, guestsSeeBoard: true })).status, 404);
  assert.equal((await f.api.put('alan', path, { expectedVersion: 0 })).status, 400, 'a change is needed');
  assert.equal((await f.api.put('alan', path, { expectedVersion: 0, unknown: true })).status, 400);
  // "Let Odin answer when tagged" is each channel's setting, not one of these.
  assert.equal((await f.api.put('alan', path, { expectedVersion: 0, guestsSeeBoard: false, odinRepliesEnabled: false })).status, 400);

  const saved = await f.api.put('alan', path, { expectedVersion: 0, guestsSeeBoard: true });
  assert.equal(saved.status, 200, json(saved.body));
  assert.deepEqual([saved.body.settings.guestsSeeBoard, saved.body.settings.version, saved.body.settings.updatedBy], [true, 1, 'alan']);
  const stale = await f.api.put('grace', path, { expectedVersion: 0, guestsSeeBoard: false });
  assert.deepEqual([stale.status, stale.body.details.code], [409, 'settings_version_conflict']);
  assert.equal((await f.api.put('grace', path, { expectedVersion: 1, guestsSeeBoard: false })).status, 200, 'workspace admins have decision rights');
  assert.deepEqual((await f.api.get('carol', path)).body.settings.guestsSeeBoard, false);

  // Delivery projects have the same settings with the same defaults.
  assert.deepEqual((await f.api.get('carol', '/api/projects/project-launch/settings')).body.settings.guestsSeeBoard, false);
});

test('the engagement Insights tab shows SOW state, tasks, activity, people and age; guests and outsiders cannot reach it (AC-22)', async (t) => {
  const sow = { history: [{ at: '2026-11-01T10:00:00.000Z', status: 'drafting' }, { at: '2026-11-05T10:00:00.000Z', status: 'awaiting_signature' }], status: 'awaiting_signature', title: 'Northwind SOW', url: 'https://invoice.example/sows/7' };
  const readers = { linked: async ({ projectId }) => (projectId ? sow : null), unlinked: async () => null };
  for (const [label, reader] of Object.entries(readers)) {
    await t.test(`${label} SOW`, async () => {
      const f = await fixture({ sowLinkReader: reader });
      const engagement = await f.createEngagement();
      const { projectId } = engagement;
      await f.addTask(engagement, { assigneeId: 'carol', name: 'Overdue', targetEndDate: dateIn(-2) });
      await f.addTask(engagement, { name: 'Next', targetEndDate: dateIn(4) });
      await f.addTask(engagement, { name: 'Soon', targetEndDate: dateIn(1) });
      await f.addTask(engagement, { name: 'Done', status: 'Completed' });
      const upload = await f.api.post('carol', `/api/projects/${projectId}/files`, { fileContentsBase64: Buffer.from('v1').toString('base64'), fileDescription: '', fileName: 'proposal.txt', fileType: 'text/plain', targetId: projectId, targetType: 'project' });
      assert.equal(upload.status, 201, json(upload.body));

      assert.equal((await f.api.get('alan', `/api/projects/${projectId}/insights`)).status, 404, 'an engagement still has no delivery Insights');
      assert.equal((await f.api.get('oscar', `/api/projects/${projectId}/insights/pursuit`)).status, 404);
      const response = await f.api.get('carol', `/api/projects/${projectId}/insights/pursuit`);
      assert.equal(response.status, 200, json(response.body));
      const { cards } = response.body;

      if (label === 'linked') {
        assert.equal(cards.sow.status, 'ready');
        assert.deepEqual([cards.sow.data.state, cards.sow.data.label, cards.sow.data.url], ['awaiting_signature', 'Awaiting signature', 'https://invoice.example/sows/7']);
        assert.deepEqual(cards.sow.data.history.map((entry) => [entry.label, entry.at]), [['Drafting', '2026-11-01T10:00:00.000Z'], ['Awaiting signature', '2026-11-05T10:00:00.000Z']]);
      } else {
        assert.deepEqual([cards.sow.status, cards.sow.message, cards.sow.data.linked], ['empty', 'No SOW is linked to this engagement.', false]);
      }
      assert.equal(cards.tasks.status, 'ready');
      assert.deepEqual(cards.tasks.data.counts, { done: 1, open: 3, overdue: 1, total: 4 });
      assert.deepEqual(cards.tasks.data.nextDue.map((task) => task.name), ['Soon', 'Next']);
      assert.deepEqual(cards.tasks.data.burnup.at(-1), { date: dateIn(0), done: 1, scope: 4 });
      assert.equal(cards.activity.status, 'ready');
      assert.equal(cards.activity.data.weeks.length, 8);
      assert.deepEqual(cards.activity.data.channels.map((channel) => [channel.name, channel.files.reduce((sum, value) => sum + value, 0)]), [['Files', 1]]);
      assert.ok(cards.activity.data.lastActivityAt);
      assert.deepEqual(cards.people.data.counts, { active30: 1, active7: 1, guests: 0, members: 3 });
      assert.deepEqual(cards.people.data.people.filter((person) => person.active7).map((person) => person.id), ['carol']);
      assert.deepEqual([cards.age.data.daysOpen, cards.age.data.daysSinceActivity], [0, 0]);
    });
  }
});


test('the SOW card reads billing\u2019s invoice-gen link: title, status, link and signing date when linked; no SOW otherwise (AC-22)', async () => {
  const f = await fixture();
  const linked = await f.createEngagement();
  const unlinked = await f.createEngagement();
  const sowCard = async (projectId) => {
    const response = await f.api.get('carol', `/api/projects/${projectId}/insights/pursuit`);
    assert.equal(response.status, 200, json(response.body));
    return response.body.cards.sow;
  };
  const putLink = (projectId, agreement, sourceUpdatedAt) => f.billingRepository.putLink({
    link: { agreement, customer: { id: 12, name: 'Northwind' }, lineOfBusiness: { id: 3, name: '' }, sourceUpdatedAt }, projectId, tenantId: TENANT,
  });

  // A link at customer level carries no SOW yet.
  await putLink(linked.projectId, null, '2026-11-01T10:00:00Z');
  assert.deepEqual([(await sowCard(linked.projectId)).status, (await sowCard(linked.projectId)).data.linked], ['empty', false]);

  // Shared for review: the current status, no dates (billing keeps no status history), invoice-gen's `link` field.
  await putLink(linked.projectId, { id: 41, link: 'https://invoices.example/agreements/41', status: 'review', title: 'Northwind phase 2' }, '2026-11-05T10:00:00Z');
  let card = await sowCard(linked.projectId);
  assert.equal(card.status, 'ready');
  assert.deepEqual([card.data.state, card.data.label, card.data.title, card.data.url, card.data.history], ['shared_for_review', 'Shared for review', 'Northwind phase 2', 'https://invoices.example/agreements/41', []]);

  // Executed: Signed, dated by executedAt.
  await putLink(linked.projectId, { executedAt: '2026-11-20T15:00:00Z', id: 41, milestones: [], rateCents: 15000, status: 'executed', title: 'Northwind phase 2', url: 'https://invoices.example/agreements/41' }, '2026-11-20T15:00:01Z');
  card = await sowCard(linked.projectId);
  assert.deepEqual([card.data.state, card.data.label, card.data.url], ['signed', 'Signed', 'https://invoices.example/agreements/41']);
  assert.deepEqual(card.data.history.map((entry) => [entry.label, entry.at]), [['Signed', '2026-11-20T15:00:00.000Z']]);
  assert.ok(!('rateCents' in card.data), 'the card shows no rates');

  // A link that is not http(s) is not offered.
  await putLink(linked.projectId, { id: 41, status: 'executed', title: 'Northwind phase 2', url: 'javascript:alert(1)' }, '2026-11-21T15:00:00Z');
  assert.equal((await sowCard(linked.projectId)).data.url, null);

  const none = await sowCard(unlinked.projectId);
  assert.deepEqual([none.status, none.message, none.data.linked], ['empty', 'No SOW is linked to this engagement.', false]);
  await f.billingRepository.deleteLink({ projectId: linked.projectId, tenantId: TENANT });
  assert.equal((await sowCard(linked.projectId)).status, 'empty', 'an unlinked project has no SOW again');
});

test('the activity and people cards count channel posts per week by channel, the last activity, and who posted in 7 and 30 days (AC-22)', async () => {
  const f = await fixture();
  const engagement = await f.createEngagement();
  const { projectId } = engagement;
  const channels = (await f.api.get('alan', `/api/projects/${projectId}/channels`)).body.channels;
  const general = channels.find((channel) => channel.isGeneral);
  const deal = await f.api.post('alan', `/api/projects/${projectId}/channels`, { name: 'Deal room' });
  assert.equal(deal.status, 201, json(deal.body));
  const post = async (as, channelId, body) => {
    const response = await f.api.post(as, `/api/projects/${projectId}/channels/${channelId}/posts`, { body });
    assert.equal(response.status, 201, json(response.body));
    return response.body.post;
  };
  await post('alan', general.id, 'Kickoff Monday');
  await post('carol', general.id, 'Agenda attached');
  await post('carol', deal.body.channel.id, 'Pricing draft');
  const removed = await post('alan', deal.body.channel.id, 'Wrong channel');
  assert.equal((await f.api.delete('alan', `/api/projects/${projectId}/posts/${removed.id}`)).status, 200);

  const { cards } = (await f.api.get('carol', `/api/projects/${projectId}/insights/pursuit`)).body;
  assert.equal(cards.activity.status, 'ready');
  const weekly = Object.fromEntries(cards.activity.data.channels.map((channel) => [channel.name, channel.posts]));
  assert.deepEqual(Object.keys(weekly).sort(), ['Deal room', 'General'], 'one row per channel, by name');
  assert.equal(weekly.General.at(-1), 2, 'two posts in General this week');
  assert.equal(weekly['Deal room'].at(-1), 1, 'the deleted post does not count');
  assert.equal(weekly.General.slice(0, -1).reduce((sum, value) => sum + value, 0), 0);
  assert.ok(cards.activity.data.lastActivityAt);
  assert.equal(cards.age.data.daysSinceActivity, 0);
  const active = cards.people.data.people.filter((person) => person.active7).map((person) => person.id).sort();
  assert.deepEqual(active, ['alan', 'carol']);
  assert.deepEqual(cards.people.data.people.filter((person) => person.active30).map((person) => person.id).sort(), ['alan', 'carol']);
  assert.equal(cards.people.data.counts.active7, 2);
  // A delivery project's channel posts never reach an engagement's cards.
  const launchGeneral = (await f.api.get('alan', '/api/projects/project-launch/channels')).body.channels.find((channel) => channel.isGeneral);
  assert.equal((await f.api.post('alan', `/api/projects/project-launch/channels/${launchGeneral.id}/posts`, { body: 'Elsewhere' })).status, 201);
  const again = (await f.api.get('carol', `/api/projects/${projectId}/insights/pursuit`)).body.cards.activity.data.channels;
  assert.deepEqual(again.map((channel) => channel.posts.at(-1)).sort(), [1, 2]);
});
