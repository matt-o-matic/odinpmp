import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// Time, allocations, time off and sprint capacity for OAuth MCP clients: the tools call the real
// Odin routes on an in-process app over loopback HTTP, with disposable in-memory repositories.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-pilot';
const OTHER_PROJECT_ID = 'project-other';
const today = new Date().toISOString().slice(0, 10);
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', tenantRole: 'admin' },
  lead: { id: 'user-lead', name: 'Lee Lead', tenantRole: 'manager' },
  pm: { id: 'user-pm', name: 'Pat Projectadmin', tenantRole: 'user' },
  member: { id: 'user-member', name: 'Mona Member', tenantRole: 'user' },
  newbie: { id: 'user-newbie', name: 'Nina Newbie', tenantRole: 'user' },
};

async function fixture(t) {
  const users = Object.values(USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: users.map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: {
      [OTHER_PROJECT_ID]: [{ id: USERS.pm.id, role: 'admin' }],
      [PROJECT_ID]: [{ id: USERS.pm.id, role: 'admin' }, { id: USERS.member.id, role: 'user' }, { id: USERS.newbie.id, role: 'user' }],
    },
    projects: [
      { epics: [{ id: 'epic-accounts', name: 'Accounts', status: 'In Progress', stories: [{ id: 'story-login', name: 'Login page', status: 'In Progress', tasks: [{ id: 'task-form', name: 'Build the login form', status: 'Not Started' }] }] }], id: PROJECT_ID, name: 'Pilot', status: 'In Progress', tenantId: TENANT_ID },
      { epics: [], id: OTHER_PROJECT_ID, name: 'Other', status: 'In Progress', tenantId: TENANT_ID },
    ],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-resource-fixture', secret: 'disposable-resource-fixture-secret' });

  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, projectRepository, resourceFinanceRepository: createInMemoryResourceFinanceRepository(), sessionsRepository, tokenService,
    backendPublicUrl: origin, frontendAppUrl: 'https://frontend-fixture.example/app',
    mcpOAuthRepository: createInMemoryMcpOAuthRepository(), mcpPublicUrl: resource,
  });
  http.on('request', app);
  t.after(async () => {
    app.locals.requirementsSummaries?.stop?.();
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  const sessions = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.tenantRole, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    sessions[key] = token;
  }

  async function send(path, { body, contentType, method = 'GET', token = sessions.admin } = {}) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : contentType === 'form' ? new URLSearchParams(body) : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { body: json, status: response.status };
  }

  async function connect(role, scopes = ['projects.read', 'projects.write'], projectIds = []) {
    const registered = await send('/api/mcp/clients', { body: { name: 'Disposable dot', projectIds, redirectUris: ['http://127.0.0.1:54321/callback'], scopes }, method: 'POST' });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.body.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.body.redirect_uris[0], resource, response_type: 'code', scope: registered.body.scope, state: 'fixture-state' };
    const approved = await send('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST', token: sessions[role] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const tokens = await send('/api/mcp/oauth/token', { body: { client_id: params.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST', token: null });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const client = new Client({ name: `${role}-resource-fixture`, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    async function call(name, args = {}) {
      const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 30_000 });
      return { data: JSON.parse(result.content[0].text), isError: result.isError === true };
    }
    return {
      async ok(name, args) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, false, `${name}: ${JSON.stringify(data)}`);
        return data;
      },
      async fails(name, args, code, status) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, true, `${name}: ${JSON.stringify(data)}`);
        assert.equal(data.error.code, code, `${name}: ${JSON.stringify(data)}`);
        if (status) assert.equal(data.error.status, status);
        return data.error;
      },
    };
  }

  return { app, connect, send, sessions };
}

test('OAuth MCP clients log time, staff projects, record time off and set sprint capacity through Odin routes', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const planning = (path, body, method = 'POST') => env.send(`/api/resource-planning${path}`, { body, method });
  const mona = (await planning('/resources', { name: 'Mona Member', userId: USERS.member.id })).body.value;
  const open = (await planning('/timesheet-periods', { endDate: '2099-12-31', name: 'Open', startDate: today })).body.value;
  await planning('/timesheet-periods', { endDate: '2001-01-31', name: 'January 2001', startDate: '2001-01-01', status: 'locked' });
  const sprint = (await env.send(`/api/projects/${PROJECT_ID}/sprints`, { body: { name: 'Sprint 1', status: 'active' }, method: 'POST' })).body.sprint;
  assert.ok(sprint?.id, 'sprint created');

  const lead = await env.connect('lead');
  const pm = await env.connect('pm');
  const member = await env.connect('member');
  const newbie = await env.connect('newbie');
  const reader = await env.connect('admin', ['projects.read']);
  const pilotOnly = await env.connect('lead', ['projects.read', 'projects.write'], [PROJECT_ID]);
  const otherOnly = await env.connect('lead', ['projects.read', 'projects.write'], [OTHER_PROJECT_ID]);

  await t.test('logging time: one call finds the user, the story and the period; Odin keeps its rules', async () => {
    const logged = await member.ok('odin_log_time', { hours: 3, projectId: PROJECT_ID, workItem: 'the login story' });
    assert.deepEqual(
      [logged.entry.resourceId, logged.entry.workItemId, logged.entry.workItemName, logged.entry.workDate, logged.entry.periodId, logged.entry.status],
      [mona.id, 'story-login', 'Login page', today, open.id, 'submitted'],
    );
    const mine = await member.ok('odin_list_time_entries', { mine: true });
    assert.deepEqual([mine.total, mine.totals.hours, mine.myResourceId, mine.entries[0].projectName], [1, 3, mona.id, 'Pilot']);
    const edited = await member.ok('odin_update_time_entry', { input: { expectedVersion: logged.entry.version, hours: 2.5, workItem: 'login form' }, projectId: PROJECT_ID, timeEntryId: logged.entry.id });
    assert.deepEqual([edited.entry.hours, edited.entry.workItemId], [2.5, 'task-form']);

    // Approving takes a resource manager; locked periods and other projects refuse.
    await member.fails('odin_update_time_entry', { input: { expectedVersion: edited.entry.version, status: 'approved' }, projectId: PROJECT_ID, timeEntryId: logged.entry.id }, 'http_404', 404);
    await member.fails('odin_log_time', { hours: 1, projectId: PROJECT_ID, workDate: '2001-01-15' }, 'period_locked', 423);
    await member.fails('odin_log_time', { hours: 1, projectId: OTHER_PROJECT_ID }, 'http_404', 404);
    assert.match((await newbie.fails('odin_log_time', { hours: 1, projectId: PROJECT_ID }, 'no_resource_profile', 422)).message, /odin_add_project_allocation/);

    // People delete their own time while it is submitted; approved time takes a resource manager.
    const approved = await lead.ok('odin_update_time_entry', { input: { expectedVersion: edited.entry.version, status: 'approved' }, projectId: PROJECT_ID, timeEntryId: logged.entry.id });
    assert.equal(approved.entry.status, 'approved');
    assert.match((await member.fails('odin_delete_time_entry', { expectedVersion: approved.entry.version, projectId: PROJECT_ID, timeEntryId: logged.entry.id }, 'http_404', 404)).message, /delete only their own time while it is still submitted/);
    const slip = await member.ok('odin_log_time', { hours: 1, projectId: PROJECT_ID });
    await member.ok('odin_delete_time_entry', { expectedVersion: slip.entry.version, projectId: PROJECT_ID, timeEntryId: slip.entry.id });
    await lead.ok('odin_delete_time_entry', { expectedVersion: approved.entry.version, projectId: PROJECT_ID, timeEntryId: logged.entry.id });
    assert.equal((await lead.ok('odin_list_time_entries', { projectId: PROJECT_ID })).total, 0);
  });

  await t.test('allocations: a workspace manager adds a workspace user, changes and removes their allocation; a project admin cannot', async () => {
    const added = await lead.ok('odin_add_project_allocation', { input: { hoursPerWeek: 10, role: 'Developer', userId: USERS.newbie.id }, projectId: PROJECT_ID });
    assert.deepEqual([added.added, added.created, added.assigneeId, added.resource.userId, added.allocation.allocationPercent], [true, true, USERS.newbie.id, USERS.newbie.id, 25]);
    // With a profile, the newcomer can log time.
    const logged = await newbie.ok('odin_log_time', { hours: 1, projectId: PROJECT_ID });
    assert.equal(logged.entry.resourceId, added.resource.id);

    const changed = await lead.ok('odin_update_project_allocation', { allocationId: added.allocation.id, input: { expectedVersion: added.allocation.version, hoursPerWeek: 20 }, projectId: PROJECT_ID });
    assert.deepEqual([changed.allocation.hoursPerWeek, changed.allocation.allocationPercent], [20, 50]);
    assert.match((await pm.fails('odin_add_project_allocation', { input: { resourceId: mona.id }, projectId: PROJECT_ID }, 'http_404', 404)).message, /workspace admin or manager/);
    await otherOnly.fails('odin_update_project_allocation', { allocationId: added.allocation.id, input: { expectedVersion: changed.allocation.version, hoursPerWeek: 5 }, projectId: PROJECT_ID }, 'http_404', 404);
    await reader.fails('odin_remove_project_allocation', { allocationId: added.allocation.id, expectedVersion: changed.allocation.version, projectId: PROJECT_ID }, 'insufficient_scope', 403);

    await lead.ok('odin_remove_project_allocation', { allocationId: added.allocation.id, expectedVersion: changed.allocation.version, projectId: PROJECT_ID });
    const team = await env.send(`/api/resource-planning/projects/${PROJECT_ID}/team`);
    assert.deepEqual(team.body.people.map((person) => person.resource.id), []);
  });

  await t.test('time off: managers record and delete it, people see their own, and project-limited grants cannot reach it', async () => {
    const added = await lead.ok('odin_add_time_off', { input: { endDate: '2026-12-24', entryType: 'leave', resourceId: mona.id, startDate: '2026-12-21' } });
    assert.deepEqual([added.timeOff.hoursPerDay, added.timeOff.status], [8, 'approved']);
    const listed = await member.ok('odin_list_time_off', { mine: true });
    assert.deepEqual(listed.entries.map((entry) => [entry.resourceName, entry.startDate]), [['Mona Member', '2026-12-21']]);
    await member.fails('odin_add_time_off', { input: { endDate: '2026-12-31', entryType: 'leave', resourceId: mona.id, startDate: '2026-12-30' } }, 'http_404', 404);
    assert.match((await pilotOnly.fails('odin_list_time_off', {}, 'http_404', 404)).message, /belongs to a person/);
    await lead.ok('odin_delete_time_off', { calendarEntryId: added.timeOff.id, expectedVersion: added.timeOff.version });
    assert.equal((await lead.ok('odin_list_time_off', {})).total, 0);
  });

  await t.test('project-limited grants list and log time only on their projects', async () => {
    assert.equal((await pilotOnly.ok('odin_list_time_entries', { projectId: PROJECT_ID })).total, 1);
    assert.match((await pilotOnly.fails('odin_list_time_entries', {}, 'http_404', 404)).message, /must pass one of their projectIds/);
    await otherOnly.fails('odin_list_time_entries', { projectId: PROJECT_ID }, 'http_404', 404);
    await otherOnly.fails('odin_log_time', { hours: 1, projectId: PROJECT_ID, resourceId: mona.id }, 'http_404', 404);
    await reader.fails('odin_log_time', { hours: 1, projectId: PROJECT_ID }, 'insufficient_scope', 403);
  });

  await t.test('sprint capacity: a project admin sets members\' hours; someone who cannot edit the plan cannot', async () => {
    const saved = await pm.ok('odin_set_sprint_capacity', { projectId: PROJECT_ID, set: [{ capacityHours: 30, userId: USERS.member.id }, { capacityHours: 12, notes: 'Reviews', userId: USERS.pm.id }], sprintId: sprint.id });
    assert.deepEqual([saved.capacityHours, saved.staffing.map((entry) => entry.name).sort()], [42, ['Mona Member', 'Pat Projectadmin']]);
    const trimmed = await pm.ok('odin_set_sprint_capacity', { projectId: PROJECT_ID, remove: [USERS.pm.id], sprintId: sprint.id });
    assert.deepEqual(trimmed.staffing.map((entry) => [entry.userId, entry.capacityHours]), [[USERS.member.id, 30]]);
    const read = await member.ok('odin_get_sprint_capacity', { projectId: PROJECT_ID });
    assert.deepEqual([read.sprints[0].id, read.sprints[0].capacityHours, read.sprints[0].staffing[0].name], [sprint.id, 30, 'Mona Member']);
    assert.match((await member.fails('odin_set_sprint_capacity', { projectId: PROJECT_ID, set: [{ capacityHours: 40, userId: USERS.member.id }], sprintId: sprint.id }, 'http_404', 404)).message, /cannot edit the plan/);
    await otherOnly.fails('odin_set_sprint_capacity', { projectId: PROJECT_ID, remove: [USERS.member.id], sprintId: sprint.id }, 'http_404', 404);
    assert.equal((await member.ok('odin_get_sprint_capacity', { projectId: PROJECT_ID, sprintId: sprint.id })).sprints[0].capacityHours, 30, 'denied calls changed nothing');
  });
});

test('a project an MCP client creates, and a person it adds, reach the screens that show them', { timeout: 60_000 }, async (t) => {
  const env = await fixture(t);
  const events = [];
  for (const channel of [LIVE_EVENT_CHANNELS.workspace(TENANT_ID), LIVE_EVENT_CHANNELS.project(PROJECT_ID)]) {
    t.after(env.app.locals.liveEventBus.subscribe(channel, (event) => events.push([channel, event.type, event.area ?? null, event.actor?.id ?? null])));
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const admin = await env.connect('admin');

  const created = await admin.ok('odin_create_project', { input: { name: 'Agent-made project', status: 'Planned' } });
  assert.ok(created.project.id);
  await settle();
  assert.deepEqual(events, [[LIVE_EVENT_CHANNELS.workspace(TENANT_ID), 'workspace.changed', 'projects', null]]);

  events.length = 0;
  await admin.ok('odin_add_project_resource', { input: { name: 'Casey Contractor' }, projectId: PROJECT_ID });
  await settle();
  assert.deepEqual(events, [
    [LIVE_EVENT_CHANNELS.project(PROJECT_ID), 'project.assets.invalidated', null, USERS.admin.id],
    [LIVE_EVENT_CHANNELS.workspace(TENANT_ID), 'workspace.changed', 'resources', null],
  ]);
});
