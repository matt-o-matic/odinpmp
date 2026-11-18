import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// Writes outside /api/projects/:projectId (creating a project, resource planning, workflows)
// reach the screens that show them, and screens that span projects hear of every change on the
// workspace channel without learning which project changed or who changed it.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-pilot';
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t) {
  const users = [
    { id: 'user-ada', name: 'Ada Admin', role: 'admin', tenantId: TENANT_ID },
    { id: 'user-oz', name: 'Oz Outsider', role: 'admin', tenantId: 'tenant-other' },
  ];
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      { domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' },
      { domains: ['other.example'], id: 'tenant-other', name: 'Another workspace' },
    ],
    users: users.map((user) => ({
      authMethod: 'basic', email: `${user.id}@${user.tenantId === TENANT_ID ? 'acme' : 'other'}.example`, id: user.id,
      memberships: [{ role: user.role, tenantId: user.tenantId }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false },
    })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT_ID]: [{ id: 'user-ada', role: 'admin' }] },
    projects: [{ epics: [], id: PROJECT_ID, name: 'Pilot', status: 'In Progress', tenantId: TENANT_ID }],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'workspace-events-fixture', secret: 'disposable-workspace-events-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, frontendAppUrl: 'https://frontend-fixture.example/app', projectRepository,
    resourceFinanceRepository: createInMemoryResourceFinanceRepository(), sessionsRepository, tokenService,
  });
  t.after(async () => {
    app.locals.requirementsSummaries?.stop?.();
    await app.locals.beginDrain({ timeoutMs: 1000 });
  });

  const tokens = {};
  for (const user of users) {
    const email = `${user.id}@${user.tenantId === TENANT_ID ? 'acme' : 'other'}.example`;
    const token = tokenService.signSessionToken({ email, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.role, tenantId: user.tenantId });
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[user.id] = token;
  }

  const events = [];
  for (const channel of [LIVE_EVENT_CHANNELS.workspace(TENANT_ID), LIVE_EVENT_CHANNELS.workspace('tenant-other'), LIVE_EVENT_CHANNELS.project(PROJECT_ID)]) {
    t.after(app.locals.liveEventBus.subscribe(channel, (event) => events.push({ channel, ...event })));
  }
  const send = (method, path, body, token = tokens['user-ada']) => request(app)[method](path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Odin-Client-Id', 'tab-1')
    .send(body);
  const seen = () => events.map((event) => [event.channel, event.type, event.area ?? null]);

  return { app, events, seen, send, tokens };
}

test('writes outside a project\'s own routes publish to the project and to its workspace', async (t) => {
  const { events, seen, send } = await fixture(t);
  const workspace = LIVE_EVENT_CHANNELS.workspace(TENANT_ID);
  const project = LIVE_EVENT_CHANNELS.project(PROJECT_ID);

  await t.test('creating a project tells the workspace, with the tab and nothing else', async () => {
    events.length = 0;
    const created = await send('post', '/api/projects', { name: 'Agent-made project', status: 'Planned' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await settle();
    assert.deepEqual(seen(), [[workspace, 'workspace.changed', 'projects']]);
    assert.deepEqual(Object.keys(events[0]).sort(), ['area', 'at', 'channel', 'id', 'originClientId', 'type']);
    assert.equal(events[0].originClientId, 'tab-1');
  });

  await t.test('a change inside a project also tells the workspace', async () => {
    events.length = 0;
    const sprint = await send('post', `/api/projects/${PROJECT_ID}/sprints`, { endDate: '2026-12-31', goal: '', name: 'Sprint 1', startDate: '2026-12-01', status: 'planned' });
    assert.equal(sprint.status, 201, JSON.stringify(sprint.body));
    await settle();
    assert.deepEqual(seen(), [[project, 'project.assets.invalidated', null], [workspace, 'workspace.changed', 'projects']]);
  });

  await t.test('adding someone to a project refreshes that project and the resource screens', async () => {
    events.length = 0;
    const added = await send('post', `/api/resource-planning/projects/${PROJECT_ID}/resources`, { name: 'Casey Contractor' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    await settle();
    assert.deepEqual(seen(), [[project, 'project.assets.invalidated', null], [workspace, 'workspace.changed', 'resources']]);
    assert.deepEqual(events[0].actor, { id: 'user-ada', name: 'Ada Admin' });
    assert.equal(events[0].originClientId, 'tab-1');
  });

  await t.test('a workspace-wide resource names no project, even when its body claims one', async () => {
    events.length = 0;
    const created = await send('post', '/api/resource-planning/resources', { name: 'Pat Pooled', projectId: PROJECT_ID });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await settle();
    assert.deepEqual(seen(), [[workspace, 'workspace.changed', 'resources']]);
  });

  await t.test('workflow changes tell the workflow screens', async () => {
    events.length = 0;
    const field = await send('post', '/api/workflows/custom-fields', { fieldType: 'string', name: 'Vendor', scope: 'task' });
    assert.equal(field.status, 201, JSON.stringify(field.body));
    await settle();
    assert.deepEqual(seen(), [[workspace, 'workspace.changed', 'workflows']]);
  });

  await t.test('failed writes and reads publish nothing', async () => {
    events.length = 0;
    assert.equal((await send('post', '/api/projects', { name: '' })).status, 400);
    assert.equal((await send('post', `/api/resource-planning/projects/${PROJECT_ID}/resources`, {})).status, 400);
    assert.equal((await send('get', `/api/resource-planning/projects/${PROJECT_ID}/team`)).status, 200);
    await settle();
    assert.deepEqual(seen(), []);
  });
});

async function readUntil(reader, decoder, state, predicate) {
  while (!predicate(state.text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`Stream ended early: ${state.text}`);
    state.text += decoder.decode(value, { stream: true });
  }
}

test('the workspace stream sends the area and tab of each change in the viewer\'s workspace only', async (t) => {
  const { app, tokens } = await fixture(t);
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const origin = `http://127.0.0.1:${http.address().port}`;

  async function open(token) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${origin}/api/workspace/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { text: '' };
    await readUntil(reader, decoder, state, (text) => text.includes('event: connected'));
    return { decoder, reader, state };
  }

  const ada = await open(tokens['user-ada']);
  const oz = await open(tokens['user-oz']);
  app.locals.liveEventBus.publish(LIVE_EVENT_CHANNELS.workspace(TENANT_ID), {
    actor: { id: 'user-ada', name: 'Ada Admin' }, area: 'resources', originClientId: 'tab-9', projectId: PROJECT_ID, type: 'workspace.changed',
  });
  await readUntil(ada.reader, ada.decoder, ada.state, (text) => text.includes('event: workspace.changed'));
  const data = JSON.parse(/event: workspace\.changed\ndata: (.*)\n/.exec(ada.state.text)[1]);
  assert.deepEqual(data, { area: 'resources', originClientId: 'tab-9' });

  // The other workspace's stream stays quiet, and anyone without a session is refused.
  app.locals.liveEventBus.publish(LIVE_EVENT_CHANNELS.workspace('tenant-other'), { area: 'projects', type: 'workspace.changed' });
  await readUntil(oz.reader, oz.decoder, oz.state, (text) => text.includes('event: workspace.changed'));
  assert.ok(!oz.state.text.includes('resources'), oz.state.text);
  assert.equal((await fetch(`${origin}/api/workspace/events`)).status, 401);
});
