import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createOdinApiClient } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { readOnlyApi } from '../src/modules/assistant/agent-chat.service.js';
import { updateAgentGoalForUser } from '../src/modules/assistant/agent-goals.service.js';
import { goalRunsReadOnly } from '../src/modules/assistant/agent-monitors.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { agentAppDeps, listen, scriptedOpenAi } from './helpers/agent-test-utils.js';

// Goal runs as the durable worker runs them (server.js): the queued run's input becomes one
// assistant turn. A monitor's check runs unattended over content anyone could have written, so
// it may read but every change it tries is refused before it reaches Odin. A goal that may make
// changes still makes them.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-launch';
const DAY = 24 * 60 * 60 * 1000;

function seedProject() {
  return {
    description: 'Launch work.', endDate: '2026-12-15', id: PROJECT_ID, name: 'Launch Readiness', rank: 1, role: 'admin', startDate: '2026-05-10', status: 'In Progress', tenantId: TENANT_ID, updatedAt: '2026-05-12T08:30:00.000Z',
    epics: [{
      id: 'epic-launch', name: 'Launch', status: 'In Progress',
      stories: [{ assigneeId: 'user-grace', id: 'story-routing', name: 'Routing', status: 'In Progress', tasks: [{ assigneeId: 'user-grace', id: 'task-rules', name: 'Rules', points: 3, status: 'In Progress' }] }],
    }],
  };
}

async function fixture(t, steps) {
  const scripted = scriptedOpenAi({ steps });
  const grace = { authMethod: 'basic', email: 'grace@acme.com', id: 'user-grace', memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Grace Hopper', passwordHash: 'unused', preferences: { twoFactorEnabled: false } };
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: TENANT_ID, name: 'Acme' }], users: [grace] });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [seedProject()] } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const app = createApp({
    ...agentAppDeps(scripted),
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, frontendAppUrl: 'http://localhost:5173/app', projectRepository, sessionsRepository, tokenService,
  });
  const server = await listen(app);
  t.after(async () => {
    await app.locals.beginDrain?.({ timeoutMs: 1000 });
    await server.close();
  });
  const token = tokenService.signSessionToken({ email: grace.email, id: grace.id, name: grace.name, preferences: {}, role: 'admin', scopes: [], tenantId: TENANT_ID });
  await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Localhost', token, userAgent: 'test', userId: grace.id });
  const catalog = createOdinToolCatalog({ api: createOdinApiClient({ baseUrl: app.locals.agentApiOrigin, token }), extended: true });
  const call = (name, args) => {
    const entry = catalog.find((candidate) => candidate.name === name);
    return entry.handler(entry.schema.parse(args));
  };
  // What the durable worker does with a claimed run.
  const work = async (run) => app.locals.agentChatService.runGoalTurn({
    allowWebResearch: run.payload?.input?.allowWebResearch === true, message: String(run.payload?.input?.message ?? ''), projectId: run.projectId ?? null, readOnly: run.payload?.input?.readOnly, title: String(run.payload?.input?.title ?? ''), user: await authRepository.findUserById(String(run.payload?.userId ?? '')),
  });
  const getChat = async (chatId) => (await request(app).get(`/api/assistant/chats/${chatId}`).set('Authorization', `Bearer ${token}`)).body.chat;
  const project = async () => (await request(app).get(`/api/projects/${PROJECT_ID}`).set('Authorization', `Bearer ${token}`)).body.project;
  const items = (tree) => tree.epics.flatMap((epic) => [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])]);
  return { app, authRepository, call, executionRepository: app.locals.agentExecutionRepository, getChat, items, project, scripted, token, work };
}

const RENAME = { args: { projectId: PROJECT_ID, updates: [{ itemId: 'task-rules', patch: { name: 'Rules engine' } }] }, name: 'odin_update_items' };
const outputs = (scripted, index) => scripted.calls.responses[index].input.filter((item) => item.type === 'function_call_output').map((item) => JSON.parse(item.output));
// Each call's result by call id, since refused calls are answered before reads run.
const outputsById = (scripted, index) => Object.fromEntries(scripted.calls.responses[index].input.filter((item) => item.type === 'function_call_output').map((item) => [item.call_id, JSON.parse(item.output)]));

test('a monitor check reads, but every change it tries is refused before it reaches Odin', { timeout: 30_000 }, async (t) => {
  const harness = await fixture(t, [
    { calls: [
      { args: { projectId: PROJECT_ID }, id: 'read', name: 'odin_project_overview' },
      { ...RENAME, id: 'rename' },
      { args: { args: { projectId: PROJECT_ID, input: { name: 'Routing v2' }, itemId: 'story-routing' }, operation: 'odin_update_item' }, id: 'run-update', name: 'odin_run' },
      { args: { args: { itemId: 'task-rules', projectId: PROJECT_ID }, operation: 'odin_delete_item' }, id: 'run-delete', name: 'odin_run' },
      { args: { content: 'Launch looks late.', itemId: 'story-routing', projectId: PROJECT_ID }, id: 'comment', name: 'odin_add_comment' },
      { args: {}, id: 'undo', name: 'odin_undo_turn' },
    ] },
    { text: 'The launch has not slipped. I could not change anything in this check.' },
  ]);
  const created = await harness.call('odin_create_monitor', { everyHours: 24, projectId: PROJECT_ID, title: 'Launch date slipping', watchFor: 'Tell me if the Launch epic is not done by 2026-12-01.' });
  await harness.app.locals.materializeDueGoalMonitors({ now: new Date(Date.now() + DAY + 60_000) });
  const [run] = await harness.executionRepository.listRuns({ goalId: created.monitor.goalId, tenantId: TENANT_ID });
  assert.equal(run.payload.input.readOnly, true);
  assert.match(run.payload.input.message, /This check is read-only/);
  const before = await harness.project();

  const result = await harness.work(run);
  assert.equal(result.status, 'completed', 'a delete in a read-only check is refused, not left waiting for confirmation');
  const { read, ...writes } = outputsById(harness.scripted, 1);
  assert.equal(read.ok, true, 'reads still work');
  assert.match(JSON.stringify(read), /Launch Readiness/);
  assert.deepEqual(Object.keys(writes).sort(), ['comment', 'rename', 'run-delete', 'run-update', 'undo']);
  for (const output of Object.values(writes)) assert.deepEqual([output.ok, output.error.code], [false, 'read_only']);
  assert.match(writes.rename.error.message, /monitor check, which can only read/);

  const after = await harness.project();
  assert.deepEqual(harness.items(after).map(({ id, name }) => [id, name]), harness.items(before).map(({ id, name }) => [id, name]), 'nothing was renamed or deleted');
  const listed = await request(harness.app).get(`/api/projects/${PROJECT_ID}/comments`).query({ targetId: 'story-routing', targetType: 'story' }).set('Authorization', `Bearer ${harness.token}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.comments, [], 'no comment was posted');
  const chat = await harness.getChat(result.chatId);
  assert.equal(chat.title, 'Watch: Launch date slipping', 'the chat is named for the monitor, not "Goal run"');
  const reply = chat.messages.at(-1);
  assert.equal(reply.changes ?? null, null);
  assert.deepEqual(reply.activity.filter((entry) => entry.ok).map((entry) => entry.name), ['odin_project_overview']);
});

test('a goal run is read-only unless its run says the goal may make changes', { timeout: 30_000 }, async (t) => {
  const harness = await fixture(t, [{ calls: [RENAME] }, { text: 'Not changed.' }]);
  const user = await harness.authRepository.findUserById('user-grace');
  await harness.app.locals.agentChatService.runGoalTurn({ message: 'Rename the rules task to Rules engine.', projectId: PROJECT_ID, user });
  assert.equal(outputs(harness.scripted, 1)[0].error.code, 'read_only');
  assert.equal(harness.items(await harness.project()).find((item) => item.id === 'task-rules').name, 'Rules');
});

test('a goal whose owner allows changes still makes them in its runs', { timeout: 30_000 }, async (t) => {
  const harness = await fixture(t, [{ calls: [RENAME] }, { text: 'Renamed the rules task.' }]);
  const created = await request(harness.app).post('/api/agent-goals').set('Authorization', `Bearer ${harness.token}`).send({ constraints: { autoApply: true }, projectId: PROJECT_ID, success: { measure: 'The rules task is named Rules engine.' }, title: 'Tidy the plan' });
  const queued = await request(harness.app).post(`/api/agent-goals/${created.body.goal.id}/runs`).set('Authorization', `Bearer ${harness.token}`).send({});
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const [run] = await harness.executionRepository.listRuns({ goalId: created.body.goal.id, tenantId: TENANT_ID });
  assert.equal(run.payload.input.readOnly, false);

  const result = await harness.work(run);
  assert.equal(outputs(harness.scripted, 1)[0].ok, true);
  assert.equal(harness.items(await harness.project()).find((item) => item.id === 'task-rules').name, 'Rules engine');
  assert.equal((await harness.getChat(result.chatId)).title, 'Tidy the plan');
});

test('a goal run searches the web only when the goal allows it', { timeout: 30_000 }, async (t) => {
  const harness = await fixture(t, [{ text: 'Checked.' }, { text: 'Checked.' }]);
  const webSearch = (index) => harness.scripted.calls.responses[index].tools.some((tool) => tool.type === 'web_search');
  for (const allowWebResearch of [true, false]) {
    const created = await request(harness.app).post('/api/agent-goals').set('Authorization', `Bearer ${harness.token}`).send({ constraints: { allowWebResearch }, projectId: PROJECT_ID, success: { measure: 'Launch is on track.' }, title: `Research ${allowWebResearch}` });
    await request(harness.app).post(`/api/agent-goals/${created.body.goal.id}/runs`).set('Authorization', `Bearer ${harness.token}`).send({});
    const [run] = await harness.executionRepository.listRuns({ goalId: created.body.goal.id, tenantId: TENANT_ID });
    const result = await harness.work(run);
    assert.equal((await harness.getChat(result.chatId)).settings.allowWebResearch, allowWebResearch);
  }
  assert.deepEqual([webSearch(0), webSearch(1)], [true, false]);
});

test('editing a read-only goal keeps it read-only', { timeout: 30_000 }, async (t) => {
  const harness = await fixture(t, []);
  const created = await harness.call('odin_create_monitor', { projectId: PROJECT_ID, title: 'Launch date slipping', watchFor: 'Tell me if the launch slips.' });
  const goalPath = `/api/agent-goals/${created.monitor.goalId}`;
  const goal = (await request(harness.app).get(goalPath).set('Authorization', `Bearer ${harness.token}`)).body.goal;
  // The governance screen saves constraints whole, without readOnly.
  const edited = await request(harness.app).patch(goalPath).set('Authorization', `Bearer ${harness.token}`).send({ constraints: { allowWebResearch: false, maxAttempts: 3 }, expectedVersion: goal.version, title: 'Watch: launch' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.goal.constraints, { allowWebResearch: false, autoApply: false, maxAttempts: 3, readOnly: true });
  const loosened = await request(harness.app).patch(goalPath).set('Authorization', `Bearer ${harness.token}`).send({ constraints: { readOnly: false }, expectedVersion: edited.body.goal.version });
  assert.equal(loosened.status, 400);
  assert.match(JSON.stringify(loosened.body), /read-only/, JSON.stringify(loosened.body));
});

test('a read-only turn\'s client sends reads only, so a write tool labelled as a read still cannot write', async () => {
  const sent = [];
  const api = readOnlyApi({ request: async (method, path) => { sent.push(`${method} ${path}`); return { ok: true }; } });
  assert.deepEqual(await api.request('GET', `/api/projects/${PROJECT_ID}`), { ok: true });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'post']) {
    await assert.rejects(api.request(method, `/api/projects/${PROJECT_ID}/items`, { body: {} }), { code: 'read_only', status: 403 });
  }
  assert.deepEqual(sent, [`GET /api/projects/${PROJECT_ID}`]);
});

test('a goal without autoApply, like every goal set up before it existed, runs read-only', { timeout: 30_000 }, async (t) => {
  const harness = await fixture(t, []);
  const created = await request(harness.app).post('/api/agent-goals').set('Authorization', `Bearer ${harness.token}`).send({ projectId: PROJECT_ID, success: { measure: 'The plan is tidy.' }, title: 'Tidy the plan' });
  const queued = await request(harness.app).post(`/api/agent-goals/${created.body.goal.id}/runs`).set('Authorization', `Bearer ${harness.token}`).send({});
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const [run] = await harness.executionRepository.listRuns({ goalId: created.body.goal.id, tenantId: TENANT_ID });
  assert.equal(run.payload.input.readOnly, true);
  assert.equal(goalRunsReadOnly({ constraints: {} }), true);
  assert.equal(goalRunsReadOnly({ constraints: { autoApply: true, readOnly: true } }), true);
});

test("only a goal's owner lets its runs make changes, and anyone else's edit takes that away", async () => {
  const goal = { constraints: { autoApply: true, maxAttempts: 3 }, id: 'goal-1', ownerUserId: 'user-owner', projectId: null, tenantId: TENANT_ID, title: 'Tidy', version: 1 };
  const saved = [];
  const executionRepository = { getGoal: async () => structuredClone(goal), updateGoal: async ({ patch }) => { saved.push(patch); return { ...goal, ...patch }; } };
  const as = (id) => ({ id, memberships: [{ role: 'admin', tenantId: TENANT_ID }] });
  const update = (user, input) => updateAgentGoalForUser({ executionRepository, goalId: goal.id, input: { expectedVersion: 1, ...input }, projectRepository: null, user });

  // The owner's screen edit keeps autoApply; another admin's edit of any field drops it.
  assert.equal((await update(as('user-owner'), { constraints: { maxAttempts: 4 } })).goal.constraints.autoApply, true);
  assert.equal((await update(as('user-admin'), { title: 'Delete everything' })).goal.constraints.autoApply, false);
  assert.deepEqual(saved.at(-1).constraints, { autoApply: false, maxAttempts: 3 });
  await assert.rejects(update(as('user-admin'), { constraints: { autoApply: true } }), (error) => error.statusCode === 403);
});
