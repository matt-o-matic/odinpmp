import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createOdinApiClient } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// The assistant's memory and monitor tools against the real Odin routes, called the way the
// in-app assistant calls them: with a session of the user's own. Odin's checks decide who may
// correct or forget a memory and who may watch a project; a monitor's check is an assistant turn
// queued with what to watch for. Repositories are in memory.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-launch';
const DAY = 24 * 60 * 60 * 1000;
const USERS = {
  manager: { id: 'user-manager', projectRole: 'manager' },
  editor: { id: 'user-editor', projectRole: 'editor' },
  member: { id: 'user-member', projectRole: 'member' },
  outsider: { id: 'user-outsider', projectRole: null },
};

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: 'user', tenantId: TENANT_ID }], name: user.id, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT_ID]: Object.values(USERS).filter((user) => user.projectRole).map((user) => ({ id: user.id, role: user.projectRole })) },
    projects: [{ epics: [], id: PROJECT_ID, name: 'Launch', status: 'In Progress', tenantId: TENANT_ID }],
  } });
  const executionRepository = createInMemoryAgentExecutionRepository();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-monitor-fixture', secret: 'disposable-monitor-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    agentExecutionRepository: executionRepository, authRepository, projectRepository, sessionsRepository, tokenService,
  });
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const as = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.id, preferences: {}, role: 'user', tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    const api = createOdinApiClient({ baseUrl: origin, token });
    const catalog = createOdinToolCatalog({ api, extended: true });
    as[key] = {
      api,
      call(name, args) {
        const entry = catalog.find((candidate) => candidate.name === name);
        return entry.handler(entry.schema.parse(args));
      },
    };
  }
  return { app, as, executionRepository };
}

test('the assistant corrects and forgets what it remembers, within Odin\'s memory checks', { timeout: 60_000 }, async (t) => {
  const { as } = await fixture(t);
  await as.member.call('odin_remember', { content: 'Launch is on 1 December.', memoryType: 'decision', title: 'Launch date' });
  await as.manager.call('odin_remember', { content: 'Status reports go out on Fridays.', memoryType: 'preference', projectId: PROJECT_ID, title: 'Report day' });
  const found = (await as.member.call('odin_search_memory', { query: 'launch' })).memories.find((entry) => entry.title === 'Launch date');
  assert.ok(found, 'the memory is found');

  const corrected = await as.member.call('odin_correct_memory', { content: 'Launch moved to 8 December.', expectedVersion: found.version, memoryId: found.id });
  assert.deepEqual([corrected.changed, corrected.memory.content, corrected.memory.version], [true, 'Launch moved to 8 December.', found.version + 1]);
  await assert.rejects(as.member.call('odin_correct_memory', { content: 'Stale edit.', expectedVersion: found.version, memoryId: found.id }), { code: 'version_conflict' });
  await assert.rejects(as.manager.call('odin_forget_memory', { expectedVersion: corrected.memory.version, memoryId: found.id }), { code: 'memory_not_found' }, 'someone else\'s personal memory');

  // A project memory: its author or someone who can edit the project's plan may change it.
  const report = (await as.manager.call('odin_search_memory', { query: 'Fridays', projectId: PROJECT_ID })).memories[0];
  await assert.rejects(as.member.call('odin_correct_memory', { expectedVersion: report.version, memoryId: report.id, title: 'Mine now' }), (error) => ['memory_not_found', 'memory_not_changeable'].includes(error.code));
  await assert.rejects(as.outsider.call('odin_forget_memory', { expectedVersion: report.version, memoryId: report.id }), (error) => ['memory_not_found', 'memory_not_changeable'].includes(error.code));

  // A restricted project memory is its author's (and admins') alone, even to another plan editor.
  await as.manager.call('odin_remember', { content: 'The client may cut scope.', memoryType: 'risk', projectId: PROJECT_ID, sensitivity: 'restricted', title: 'Scope risk' });
  const restricted = (await as.manager.call('odin_search_memory', { query: 'scope', projectId: PROJECT_ID })).memories.find((entry) => entry.title === 'Scope risk');
  await assert.rejects(as.editor.call('odin_forget_memory', { expectedVersion: restricted.version, memoryId: restricted.id }), { code: 'memory_not_found' });
  await assert.rejects(as.editor.call('odin_correct_memory', { expectedVersion: restricted.version, memoryId: restricted.id, title: 'x' }), { code: 'memory_not_found' });
  assert.equal((await as.editor.call('odin_correct_memory', { expectedVersion: report.version, memoryId: report.id, title: 'Report day (Fridays)' })).memory.title, 'Report day (Fridays)', 'an internal project memory is open to plan editors');

  assert.deepEqual(await as.member.call('odin_forget_memory', { expectedVersion: corrected.memory.version, memoryId: found.id }), { forgottenMemoryId: found.id, ok: true });
  const after = (await as.member.call('odin_search_memory', { query: 'launch' })).memories;
  assert.equal(after.some((entry) => entry.id === found.id), false, 'later chats no longer recall it');
});

test('the assistant watches a project for someone who can edit its plan, checks on schedule, and stops', { timeout: 60_000 }, async (t) => {
  const { app, as, executionRepository } = await fixture(t);
  const args = { everyHours: 24, projectId: PROJECT_ID, title: 'Launch date slipping', watchFor: 'Tell me if the Launch milestone moves past 2026-12-01.' };
  await assert.rejects(as.member.call('odin_create_monitor', args), (error) => /plan-edit/.test(error.message), 'members cannot edit the plan');
  await assert.rejects(as.outsider.call('odin_create_monitor', args), (error) => /plan-edit/.test(error.message));

  const created = await as.manager.call('odin_create_monitor', args);
  assert.deepEqual([created.monitor.running, created.monitor.everyHours, created.monitor.checks, created.checks], [true, 24, 0, 30]);
  const listed = await as.manager.call('odin_list_monitors', { projectId: PROJECT_ID });
  assert.deepEqual(listed.monitors.map((entry) => [entry.id, entry.watchFor]), [[created.monitor.id, args.watchFor]]);
  assert.deepEqual((await as.member.call('odin_list_monitors', { projectId: PROJECT_ID })).monitors, [], 'members do not see monitors they cannot change');
  const personal = await as.member.call('odin_create_monitor', { title: 'My reviews', watchFor: 'Tell me when a review round is waiting on me.' });
  assert.deepEqual((await as.member.call('odin_list_monitors', {})).monitors.map((entry) => entry.id), [personal.monitor.id]);

  // The sweep a day later queues the check as an assistant turn for the manager, read-only.
  const fired = await app.locals.materializeDueGoalMonitors({ now: new Date(Date.now() + DAY + 60_000) });
  const queued = fired.find((entry) => entry.monitorId === created.monitor.id);
  assert.equal(queued?.status, 'queued', JSON.stringify(fired));
  const [run] = await executionRepository.listRuns({ goalId: created.monitor.goalId, tenantId: TENANT_ID });
  assert.equal(run.payload.userId, USERS.manager.id);
  assert.match(run.payload.input.message, /moves past 2026-12-01/);
  assert.match(run.payload.input.message, /make no changes/);
  assert.equal((await as.manager.call('odin_list_monitors', { projectId: PROJECT_ID })).monitors[0].checks, 1);

  await assert.rejects(as.member.call('odin_stop_monitor', { goalId: created.monitor.goalId, monitorId: created.monitor.id }), { code: 'monitor_not_found' });
  const stopped = await as.manager.call('odin_stop_monitor', { goalId: created.monitor.goalId, monitorId: created.monitor.id });
  assert.deepEqual([stopped.goalStopped, stopped.monitor.running], [true, false]);
  assert.deepEqual((await as.manager.call('odin_list_monitors', { projectId: PROJECT_ID })).monitors, []);
  const later = await app.locals.materializeDueGoalMonitors({ now: new Date(Date.now() + 3 * DAY) });
  assert.equal(later.some((entry) => entry.monitorId === created.monitor.id && entry.status === 'queued'), false, 'a stopped monitor checks no more');
});
