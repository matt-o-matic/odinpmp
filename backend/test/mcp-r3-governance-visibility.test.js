import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createOdinApiClient, OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// D-027 in schedule analysis and governance: a ticket from outside the team that nobody has
// validated, live or deleted, adds nothing an agent sees, not even its id. A milestone tracking one
// tracks nothing and a dependency on one is not there, in reads and in what each write answers
// with. People still see everything.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-launch';
const P = `/api/projects/${PROJECT_ID}`;
const USERS = { grace: { id: 'user-grace', name: 'Grace Hopper', tenantRole: 'admin' } };

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT_ID]: [] },
    projects: [{
      epics: [{ id: 'epic-launch', name: 'Launch', status: 'In Progress', stories: [
        { id: 'story-refunds', name: 'Refunds', status: 'In Progress', targetEndDate: '2030-03-10', targetStartDate: '2030-03-01', tasks: [] },
        { id: 'story-payouts', name: 'Payouts', status: 'Not Started', targetEndDate: '2030-03-20', targetStartDate: '2030-03-11', tasks: [] },
      ] }],
      endDate: '2030-04-30', id: PROJECT_ID, name: 'Launch', startDate: '2030-03-01', status: 'In Progress', tenantId: TENANT_ID,
    }],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-r3-governance-fixture', secret: 'disposable-r3-governance-secret' });
  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, projectRepository, sessionsRepository, tokenService,
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

  const user = USERS.grace;
  const session = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.tenantRole, tenantId: TENANT_ID });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(session).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token: session, userAgent: 'fixture', userId: user.id });

  async function send(path, { body, form = false, headers = {}, method = 'GET', token = session } = {}) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function ok(path, options) {
    const response = await send(path, options);
    assert.ok(response.status < 300, `${options?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const version = async (itemId) => (await ok(P)).project.tickets.find((ticket) => ticket.id === itemId).version;
  const people = {
    async submit(name) {
      const { invitation } = await ok(`${P}/ticket-intake-invitations`, { body: { reporterEmail: 'client@customer.example', reporterName: 'Client Tester' }, method: 'POST' });
      return (await ok(`/api/public/ticket-intake/${invitation.intakeToken}`, { body: { attachments: [], description: `${name}, as the reporter tells it.`, name }, method: 'POST', token: null })).ticket.id;
    },
    async remove(itemId) {
      await ok(`${P}/items/${itemId}`, { body: { expectedVersion: await version(itemId), patch: { status: 'closed' } }, method: 'PATCH' });
      await ok(`${P}/items/${itemId}`, { body: { expectedVersion: await version(itemId) }, method: 'DELETE' });
    },
  };

  // The tools as the in-app assistant runs them: through Odin's routes, on the person's session.
  const catalog = createOdinToolCatalog({ api: createOdinApiClient({ baseUrl: origin, token: session }), extended: true });
  async function tool(name, args) {
    const entry = catalog.find((candidate) => candidate.name === name);
    try {
      return await entry.handler(entry.schema.parse(args));
    } catch (error) {
      if (!(error instanceof OdinApiError)) throw error;
      return { error: { code: error.code, message: error.message, status: error.status }, ok: false };
    }
  }

  // An MCP credential, used as the hosted MCP dispatcher uses it, straight on the routes.
  async function mcpRoutes() {
    const registered = await ok('/api/mcp/clients', { body: { name: 'Disposable agent', projectIds: [], redirectUris: ['http://127.0.0.1:54321/callback'], scopes: ['projects.read', 'projects.write'] }, method: 'POST' });
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.redirect_uris[0], resource, response_type: 'code', scope: registered.scope, state: 'fixture-state' };
    const approved = await ok('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST' });
    const code = new URL(approved.redirectTo).searchParams.get('code');
    const tokens = await ok('/api/mcp/oauth/token', { body: { client_id: registered.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, form: true, method: 'POST', token: null });
    return (method, path, body) => send(path, { body, headers: { 'X-Odin-MCP-Internal': tokenService.signMcpInternalProof({ method, path, token: tokens.access_token }) }, method, token: tokens.access_token });
  }
  return { mcpRoutes, ok, people, tool };
}

test('schedule analysis and every governance answer leave out tickets nobody validated, live or deleted', { timeout: 90_000 }, async (t) => {
  const env = await fixture(t);
  const hidden = await env.people.submit('Wire the refund to account 99-1234');
  const gone = await env.people.submit('Old crash, never reviewed');
  // People link governance to both, then the second ticket is deleted unreviewed.
  const launch = (await env.ok(`${P}/governance/milestones`, { body: { targetDate: '2030-04-01', title: 'Refunds live', workItemId: hidden }, method: 'POST' })).value;
  const crash = (await env.ok(`${P}/governance/milestones`, { body: { targetDate: '2030-04-02', title: 'Crash fixed', workItemId: gone }, method: 'POST' })).value;
  const waits = (await env.ok(`${P}/governance/dependencies`, { body: { predecessorId: hidden, successorId: 'story-refunds' }, method: 'POST' })).value;
  const waitsOnGone = (await env.ok(`${P}/governance/dependencies`, { body: { predecessorId: gone, successorId: 'story-payouts' }, method: 'POST' })).value;
  const planned = (await env.ok(`${P}/governance/dependencies`, { body: { predecessorId: 'story-refunds', successorId: 'story-payouts' }, method: 'POST' })).value;
  await env.people.remove(gone);
  const secret = new RegExp(`${hidden}|${gone}|Wire the refund|Old crash`);

  // People see every link.
  const human = await env.ok(`${P}/governance/schedule-analysis`);
  assert.equal(human.analysis.milestoneForecasts.find((entry) => entry.id === launch.id).workItemId, hidden);
  assert.equal((await env.ok(`${P}/governance`)).dependencies.length, 3);

  // The assistant's reads.
  const analysis = await env.tool('odin_get_schedule_analysis', { projectId: PROJECT_ID });
  assert.equal(analysis.ok, true);
  assert.doesNotMatch(JSON.stringify(analysis), secret);
  assert.deepEqual(analysis.analysis.milestoneForecasts.map((entry) => [entry.title, entry.workItemId]).sort(), [['Crash fixed', null], ['Refunds live', null]]);
  const governance = await env.tool('odin_get_governance', { projectId: PROJECT_ID });
  assert.doesNotMatch(JSON.stringify(governance), secret);
  assert.deepEqual(governance.dependencies.map((entry) => entry.id), [planned.id]);

  // What the writes answer with: changing only a date, or the title, names no hidden ticket.
  for (const [name, args] of [
    ['odin_update_milestone', { milestoneId: launch.id, patch: { targetDate: '2030-04-03' }, projectId: PROJECT_ID }],
    ['odin_update_milestone', { milestoneId: crash.id, patch: { title: 'Crash gone' }, projectId: PROJECT_ID }],
    ['odin_create_milestone', { input: { targetDate: '2030-04-10', title: 'Go live', workItemId: 'story-payouts' }, projectId: PROJECT_ID }],
    ['odin_update_dependency', { dependencyId: planned.id, patch: { lagDays: 2 }, projectId: PROJECT_ID }],
    ['odin_create_governance_item', { input: { kind: 'risk', title: 'Refund fraud' }, projectId: PROJECT_ID }],
    ['odin_create_schedule_baseline', { input: { name: 'Agreed plan' }, projectId: PROJECT_ID }],
  ]) {
    const result = await env.tool(name, args);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    assert.doesNotMatch(JSON.stringify(result), secret, name);
  }
  assert.equal((await env.tool('odin_update_milestone', { milestoneId: launch.id, patch: { status: 'at_risk' }, projectId: PROJECT_ID })).milestone.workItemId, null);
  assert.equal((await env.tool('odin_create_schedule_baseline', { input: { name: 'Second plan' }, projectId: PROJECT_ID })).baseline.covers.dependencies, 1, 'a baseline counts only the dependencies agents see');

  // Dependencies on hidden tickets are not there to change or delete, and the refusal says nothing of them.
  for (const dependency of [waits, waitsOnGone]) {
    for (const [name, args] of [['odin_update_dependency', { dependencyId: dependency.id, patch: { lagDays: 1 }, projectId: PROJECT_ID }], ['odin_delete_dependency', { dependencyId: dependency.id, projectId: PROJECT_ID }]]) {
      const refused = await env.tool(name, args);
      assert.equal(refused.error?.code, 'dependency_not_found', `${name}: ${JSON.stringify(refused)}`);
      assert.doesNotMatch(JSON.stringify(refused), secret);
    }
  }
  assert.equal((await env.ok(`${P}/governance`)).dependencies.length, 3, 'the refused calls changed nothing');

  // An MCP credential gets the agent view straight from the routes, asked for or not.
  const mcp = await env.mcpRoutes();
  for (const [method, path, body] of [
    ['GET', `${P}/governance/schedule-analysis`],
    ['GET', `${P}/governance`],
    ['PATCH', `${P}/governance/milestones/${launch.id}`, { expectedVersion: (await env.ok(`${P}/governance`)).milestones.find((entry) => entry.id === launch.id).version, targetDate: '2030-04-04' }],
    ['PATCH', `${P}/governance/dependencies/${waits.id}`, { dependencyType: 'FS', expectedVersion: waits.version, lagDays: 3, predecessorId: hidden, successorId: 'story-refunds' }],
  ]) {
    const response = await mcp(method, path, body);
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
    assert.doesNotMatch(JSON.stringify(response.body), secret, `${method} ${path}`);
  }
  // People still see the link the agent's date change kept.
  assert.equal((await env.ok(`${P}/governance`)).milestones.find((entry) => entry.id === launch.id).workItemId, hidden);
});
