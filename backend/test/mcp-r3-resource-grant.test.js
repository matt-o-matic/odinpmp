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
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// A grant limited to some projects sees only the people on those projects: never the rest of the
// workspace's resource directory, its logins or their rates.

const TENANT_ID = 'tenant-acme';
const PILOT = 'project-pilot';
const OTHER = 'project-other';
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', tenantRole: 'admin' },
  member: { id: 'user-member', name: 'Mona Member', tenantRole: 'user' },
  stranger: { id: 'user-stranger', name: 'Sam Stranger', tenantRole: 'user' },
};

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PILOT]: [{ id: USERS.member.id, role: 'user' }], [OTHER]: [{ id: USERS.stranger.id, role: 'user' }] },
    projects: [
      { epics: [], id: PILOT, name: 'Pilot', status: 'In Progress', tenantId: TENANT_ID },
      { epics: [], id: OTHER, name: 'Other', status: 'In Progress', tenantId: TENANT_ID },
    ],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-r3-resource-grant', secret: 'disposable-r3-resource-grant-secret' });
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

  const user = USERS.admin;
  const session = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.tenantRole, tenantId: TENANT_ID });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(session).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token: session, userAgent: 'fixture', userId: user.id });

  async function send(path, { body, form = false, method = 'GET', token = session } = {}) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }

  async function connect(projectIds = []) {
    const registered = await send('/api/mcp/clients', { body: { name: 'Disposable dot', projectIds, redirectUris: ['http://127.0.0.1:54321/callback'], scopes: ['projects.read', 'projects.write'] }, method: 'POST' });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.body.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.body.redirect_uris[0], resource, response_type: 'code', scope: registered.body.scope, state: 'fixture-state' };
    const approved = await send('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const tokens = await send('/api/mcp/oauth/token', { body: { client_id: params.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, form: true, method: 'POST', token: null });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const client = new Client({ name: 'r3-resource-grant', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    const call = async (name, args) => {
      const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 30_000 });
      return { data: JSON.parse(result.content[0].text), isError: result.isError === true };
    };
    return {
      async ok(name, args) { const { data, isError } = await call(name, args); assert.equal(isError, false, `${name}: ${JSON.stringify(data)}`); return data; },
      async fails(name, args, code) { const { data, isError } = await call(name, args); assert.equal(isError, true, `${name}: ${JSON.stringify(data)}`); assert.equal(data.error.code, code, JSON.stringify(data)); return data.error; },
    };
  }
  return { connect };
}

test('a grant limited to one project sees only the people on its projects, not the workspace directory, logins or rates', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const everyProject = await env.connect();
  const pilotOnly = await env.connect([PILOT]);
  const bothProjects = await env.connect([PILOT, OTHER]);

  // Bea works only on the other project; Mona is on the pilot.
  const bea = (await everyProject.ok('odin_add_project_resource', { input: { allocation: { hoursPerWeek: 20 }, billRate: 210, costRate: 140, name: 'Bea Builder' }, projectId: OTHER })).resource;
  const mona = (await everyProject.ok('odin_add_project_allocation', { input: { hoursPerWeek: 10, userId: USERS.member.id }, projectId: PILOT })).allocation;

  const full = await everyProject.ok('odin_get_project_team', { projectId: PILOT });
  assert.ok(full.directory.some((entry) => entry.id === bea.id && entry.billRate === 210 && entry.costRate === 140), 'a grant on every project keeps the whole directory');
  assert.ok(full.users.some((entry) => entry.id === USERS.stranger.id));
  assert.equal(full.note, undefined);

  const limited = await pilotOnly.ok('odin_get_project_team', { projectId: PILOT });
  const text = JSON.stringify(limited);
  assert.ok(!text.includes(bea.id) && !text.includes('Bea Builder'), `Bea stays out: ${text}`);
  assert.ok(!text.includes(USERS.stranger.id) && !text.includes('Sam Stranger'), 'logins of people on no grant project stay out');
  assert.deepEqual(limited.directory.map((entry) => entry.userId), [USERS.member.id]);
  assert.deepEqual(limited.users.map((entry) => entry.id), [USERS.member.id]);
  assert.match(limited.note, /cannot see the workspace directory/);
  assert.deepEqual(limited.people.map((person) => person.resource.userId), [USERS.member.id]);

  // People on another of the grant's projects are in its directory.
  assert.ok((await bothProjects.ok('odin_get_project_team', { projectId: PILOT })).directory.some((entry) => entry.id === bea.id));

  // Nor can the limited grant pull Bea onto its project by id, or move hours to her.
  assert.match((await pilotOnly.fails('odin_add_project_allocation', { input: { resourceId: bea.id }, projectId: PILOT }, 'http_404')).message, /cannot see the workspace directory/);
  await pilotOnly.fails('odin_move_allocation_hours', { allocationId: mona.id, expectedVersion: mona.version, hours: 2, projectId: PILOT, targetResourceId: bea.id }, 'http_404');
  // Or through a login, which would reuse that person's profile in the same way.
  const sam = (await everyProject.ok('odin_add_project_allocation', { input: { hoursPerWeek: 5, userId: USERS.stranger.id }, projectId: OTHER })).resource;
  assert.equal((await pilotOnly.fails('odin_add_project_allocation', { input: { userId: USERS.stranger.id }, projectId: PILOT }, 'http_404')).details, undefined);
  assert.ok(sam.id);
  // Or by her name, which would reuse her profile and return its rates.
  const byName = await pilotOnly.fails('odin_add_project_resource', { input: { name: 'Bea Builder' }, projectId: PILOT }, 'outside_connection');
  assert.doesNotMatch(JSON.stringify(byName), /210|140/);
  assert.equal((await everyProject.ok('odin_get_project_team', { projectId: PILOT })).people.length, 1, 'the refused calls changed nothing');

  // A grant covering Bea's project still can.
  const added = await bothProjects.ok('odin_add_project_allocation', { input: { hoursPerWeek: 5, resourceId: bea.id }, projectId: PILOT });
  assert.equal(added.added, true);
});
