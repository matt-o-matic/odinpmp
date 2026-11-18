import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryPortfolioRepository } from '../src/modules/portfolio/portfolio.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// The workspace tools and governance for OAuth MCP clients: they call the real Odin routes on an
// in-process app over loopback HTTP, as the signed-in person, with in-memory repositories. Covers
// governance by project role, the team for people who cannot edit the plan, and the reads that
// span projects under grants for every project and for some.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-pilot';
const OTHER_PROJECT_ID = 'project-other';
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', tenantRole: 'admin' },
  pm: { id: 'user-pm', name: 'Pat Projectadmin', tenantRole: 'user' },
  member: { id: 'user-member', name: 'Mona Member', tenantRole: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', tenantRole: 'user' },
};
const story = (id, name, extra = {}) => ({ id, name, status: 'Not Started', tasks: [], ...extra });

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: {
      [PROJECT_ID]: [{ id: USERS.pm.id, role: 'admin' }, { id: USERS.member.id, role: 'editor' }, { id: USERS.viewer.id, role: 'viewer' }],
      [OTHER_PROJECT_ID]: [{ id: USERS.pm.id, role: 'admin' }],
    },
    projects: [
      { endDate: '2026-12-31', epics: [{ id: 'epic-launch', name: 'Checkout', stories: [
        story('story-pay', 'Pay by card', { targetEndDate: '2026-11-13', targetStartDate: '2026-11-09' }),
        story('story-refunds', 'Refunds', { targetEndDate: '2026-11-20', targetStartDate: '2026-11-16' }),
        story('story-receipts', 'Receipts'),
      ] }], id: PROJECT_ID, name: 'Pilot launch', startDate: '2026-11-02', status: 'In Progress', tenantId: TENANT_ID },
      { epics: [{ id: 'epic-other', name: 'Other launch work', stories: [story('story-other', 'Launch checklist')] }], id: OTHER_PROJECT_ID, name: 'Other launch', status: 'In Progress', tenantId: TENANT_ID },
    ],
  } });
  // A workspace-wide record search finds, which a grant limited to some projects must not see.
  const portfolioRepository = createInMemoryPortfolioRepository();
  await portfolioRepository.createNode({ input: { description: 'Every launch this year', governanceStage: 'intake', kind: 'portfolio', name: 'Launch portfolio', ownerId: null, parentId: null, scoring: {}, sponsorId: null, status: 'active' }, tenantId: TENANT_ID });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-workspace-fixture', secret: 'disposable-workspace-fixture-secret' });

  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, portfolioRepository, projectRepository, sessionsRepository, tokenService,
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

  async function send(path, { body, contentType, headers = {}, method = 'GET', token } = {}) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : contentType === 'form' ? new URLSearchParams(body) : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { body: json, status: response.status };
  }

  async function connect(role, projectIds = []) {
    const registered = await send('/api/mcp/clients', { body: { name: 'Disposable dot', projectIds, redirectUris: ['http://127.0.0.1:54321/callback'], scopes: ['projects.read', 'projects.write'] }, method: 'POST', token: sessions.admin });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.body.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.body.redirect_uris[0], resource, response_type: 'code', scope: registered.body.scope, state: 'fixture-state' };
    const approved = await send('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST', token: sessions[role] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const tokens = await send('/api/mcp/oauth/token', { body: { client_id: registered.body.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST' });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const client = new Client({ name: `${role}-workspace-fixture`, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    async function call(name, args = {}) {
      const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 30_000 });
      const data = JSON.parse(result.content[0].text);
      assert.equal(JSON.stringify(data).includes(TENANT_ID), false, `${name} returned a tenant id`);
      return { data, isError: result.isError === true };
    }
    return {
      accessToken: tokens.body.access_token,
      async ok(name, args) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, false, `${name}: ${JSON.stringify(data)}`);
        return data;
      },
      async fails(name, args, code) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, true, `${name}: ${JSON.stringify(data)}`);
        if (code) assert.equal(data.error.code, code, `${name}: ${JSON.stringify(data)}`);
        return data.error;
      },
    };
  }

  /** A REST call made the way the MCP dispatcher makes it: MCP token plus internal proof. */
  async function asMcpDispatcher(accessToken, method, path) {
    const proof = tokenService.signMcpInternalProof({ method, path, token: accessToken });
    return send(path, { headers: { 'X-Odin-MCP-Internal': proof }, method, token: accessToken });
  }

  return { asMcpDispatcher, connect };
}

test('OAuth MCP clients keep a project\'s governance through Odin routes, each within their project role', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const projectId = PROJECT_ID;
  const pm = await env.connect('pm');

  const milestone = await pm.ok('odin_create_milestone', { input: { targetDate: '2026-11-30', title: 'Go-live', workItemId: 'story-refunds' }, projectId });
  assert.equal(milestone.linkedTo, 'story "Refunds"');
  const created = await pm.ok('odin_create_dependency', { input: { predecessorId: 'story-pay', successorId: 'story-refunds' }, projectId });
  assert.equal(created.waits, 'story "Refunds" waits on story "Pay by card"');
  await pm.fails('odin_create_dependency', { input: { predecessorId: 'story-pay', successorId: 'story-refunds' }, projectId }, 'dependency_exists');
  const moved = await pm.ok('odin_update_dependency', { dependencyId: created.dependency.id, patch: { lagDays: 1, successorId: 'story-receipts' }, projectId });
  assert.deepEqual([moved.dependency.version, moved.dependency.lagDays, moved.waits], [2, 1, 'story "Receipts" waits on story "Pay by card"']);
  const calendar = await pm.ok('odin_update_working_calendar', { patch: { addHolidays: ['2026-11-26'], hoursPerDay: 7 }, projectId });
  assert.deepEqual([calendar.workingCalendar.version, calendar.workingCalendar.holidays, calendar.workingCalendar.hoursPerDay], [1, ['2026-11-26'], 7]);
  const baseline = await pm.ok('odin_create_schedule_baseline', { input: { name: 'Agreed plan', note: 'Signed off by the sponsor.' }, projectId });
  assert.equal(baseline.baseline.covers.items, 4);
  const risk = await pm.ok('odin_create_governance_item', { input: { impact: 'high', kind: 'risk', title: 'Card vendor may slip' }, projectId });

  const governance = await pm.ok('odin_get_governance', { projectId });
  assert.deepEqual(governance.dependencies.map((entry) => [entry.predecessor, entry.successor, entry.lagDays]), [['story "Pay by card"', 'story "Receipts"', 1]]);
  assert.equal(governance.milestones[0].workItem, 'story "Refunds"');
  assert.deepEqual([governance.workingCalendar.isDefault, governance.workingCalendar.hoursPerDay], [undefined, 7]);
  assert.deepEqual(governance.scheduleBaselines.map((entry) => entry.name), ['Agreed plan']);
  const { analysis } = await pm.ok('odin_get_schedule_analysis', { projectId });
  assert.deepEqual([analysis.calendar.hoursPerDay, analysis.baselineVariance.baselineName], [7, 'Agreed plan']);

  // A plan editor who is not a manager keeps the RAID log, but not project-wide governance.
  const member = await env.connect('member');
  await member.ok('odin_update_governance_item', { itemId: risk.item.id, patch: { status: 'monitoring' }, projectId });
  for (const [name, args] of [
    ['odin_delete_milestone', { milestoneId: milestone.milestone.id }], ['odin_delete_dependency', { dependencyId: created.dependency.id }],
    ['odin_update_working_calendar', { patch: { hoursPerDay: 6 } }], ['odin_create_schedule_baseline', { input: { name: 'My plan' } }],
  ]) {
    await member.fails(name, { ...args, projectId }, 'needs_project_manager');
  }

  // A viewer reads governance and the team, which needs only read access, but changes nothing.
  const viewer = await env.connect('viewer');
  assert.equal((await viewer.ok('odin_get_governance', { projectId })).items[0].status, 'monitoring');
  for (const [name, args] of [['odin_delete_governance_item', { itemId: risk.item.id }], ['odin_create_governance_item', { input: { kind: 'issue', title: 'Viewer issue' } }]]) {
    assert.match((await viewer.fails(name, { ...args, projectId }, 'http_404')).message, /plan-edit access/, name);
  }
  await viewer.fails('odin_list_project_members', { projectId });
  const team = await viewer.ok('odin_get_project_team', { projectId });
  assert.deepEqual([team.projectId, Array.isArray(team.people), team.canManage], [projectId, true, false]);

  for (const [name, args] of [['odin_delete_dependency', { dependencyId: created.dependency.id }], ['odin_delete_milestone', { milestoneId: milestone.milestone.id }], ['odin_delete_governance_item', { itemId: risk.item.id }]]) {
    assert.equal((await pm.ok(name, { ...args, projectId })).deleted.id, Object.values(args)[0]);
  }
  const emptied = await pm.ok('odin_get_governance', { projectId });
  assert.deepEqual([emptied.items.length, emptied.milestones.length, emptied.dependencies.length, emptied.scheduleBaselines.length], [0, 0, 0, 1]);
});

test('OAuth MCP clients plan with the workspace tools and read across projects only under a grant for every project', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const projectId = PROJECT_ID;
  const pm = await env.connect('pm');

  // Assigning by name reads the members, the team and the project to find Mona.
  const updated = await pm.ok('odin_update_items', { projectId, updates: [{ itemId: 'story-pay', patch: { assignee: 'Mona Member', status: 'In Progress' } }] });
  assert.equal(updated.results[0].ok, true, JSON.stringify(updated));
  const revisions = await pm.ok('odin_list_item_revisions', { itemId: 'story-pay', projectId });
  assert.deepEqual(revisions.revisions[0].changes.assigneeId, { from: null, to: USERS.member.id });
  const found = await pm.ok('odin_find_items', { assignee: 'mona', projectId, state: 'open' });
  assert.deepEqual(found.items.map((item) => item.id), ['story-pay']);
  assert.equal((await pm.ok('odin_project_overview', { projectId })).overview.counts.stories, 3);

  const sprint = await pm.ok('odin_create_sprint', { input: { endDate: '2026-11-20', name: 'Sprint 1', startDate: '2026-11-09' }, projectId });
  const sprintId = sprint.sprint?.id ?? sprint.value?.id ?? sprint.id;
  assert.ok(sprintId, JSON.stringify(sprint));
  const assigned = await pm.ok('odin_assign_items_to_sprint', { itemIds: ['story-pay', 'story-refunds', 'epic-launch'], projectId, sprintId });
  assert.deepEqual([assigned.assigned, assigned.skipped.map((entry) => entry.itemId)], [2, ['epic-launch']]);
  const member = await env.connect('member');
  await member.fails('odin_assign_items_to_sprint', { itemIds: ['story-receipts'], projectId, sprintId }, 'needs_project_manager');

  const insights = await pm.ok('odin_get_insights', { days: 14, projectId });
  assert.equal(insights.ok, true);
  await pm.ok('odin_get_timeline', { projectId });

  // A grant for every project reads home, every project's tickets, and the whole workspace's search.
  const home = await pm.ok('odin_get_my_work', {});
  assert.equal(home.viewer.id, USERS.pm.id);
  assert.deepEqual((await pm.ok('odin_list_tickets', {})).tickets, []);
  const everywhere = await pm.ok('odin_search', { query: 'launch' });
  assert.ok(everywhere.records.some((record) => record.type === 'portfolio'), JSON.stringify(everywhere.records));
  assert.ok(everywhere.records.some((record) => record.projectId === OTHER_PROJECT_ID));

  // A grant limited to the pilot is held to it, even where Pat may see the other project in Odin.
  const limited = await env.connect('pm', [PROJECT_ID]);
  assert.equal((await limited.ok('odin_get_governance', { projectId })).ok, true);
  await limited.fails('odin_get_governance', { projectId: OTHER_PROJECT_ID }, 'http_404');
  await limited.fails('odin_get_insights', { projectId: OTHER_PROJECT_ID }, 'http_404');
  await limited.fails('odin_get_my_work', {}, 'needs_every_project');
  assert.match((await limited.fails('odin_list_tickets', {}, 'http_404')).message, /pass its projectId/);
  assert.match((await limited.fails('odin_search', { query: 'launch' }, 'http_404')).message, /pass its projectId/);
  await limited.fails('odin_search', { projectId: OTHER_PROJECT_ID, query: 'launch' }, 'http_404');
  const pilotOnly = await limited.ok('odin_search', { projectId, query: 'launch' });
  assert.ok(pilotOnly.records.length > 0);
  assert.deepEqual([...new Set(pilotOnly.records.map((record) => record.projectId))], [PROJECT_ID], JSON.stringify(pilotOnly.records));

  // The same limited credential, sent straight to the routes with a second project tucked into
  // the query, is refused rather than answered for both.
  const twice = await env.asMcpDispatcher(limited.accessToken, 'GET', `/api/reporting/search?query=launch&projectId=${PROJECT_ID}&projectId=${OTHER_PROJECT_ID}`);
  assert.equal(twice.status, 400, JSON.stringify(twice.body));
  const homeDirect = await env.asMcpDispatcher(limited.accessToken, 'GET', '/api/home');
  assert.equal(homeDirect.status, 404);
  for (const path of ['/api/reporting', `/api/projects/${PROJECT_ID}/insights/reports/report-1`]) {
    assert.equal((await env.asMcpDispatcher(pm.accessToken, 'GET', path)).status, 403, path);
  }
});
