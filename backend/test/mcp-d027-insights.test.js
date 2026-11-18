import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createOdinQuery } from '../src/lib/agent/odin-query.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createOdinApiClient, OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// D-027 in Insights and the reads built on it: a ticket submitted from outside the team that nobody
// has validated adds nothing an agent sees, not to today's counts, signals or links, and not to
// history. Whether a ticket counts is decided by its state now (or, once deleted, by the state it
// was deleted in), so one validated since counts in history too. Tickets come in through the
// public intake form and people work them through Odin's routes, on an in-process app with
// in-memory repositories. People still see everything.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-launch';
const P = `/api/projects/${PROJECT_ID}`;
const USERS = {
  grace: { id: 'user-grace', name: 'Grace Hopper', projectRole: null, tenantRole: 'admin' },
  pia: { id: 'user-pia', name: 'Pia Manager', projectRole: 'manager', tenantRole: 'user' },
  sam: { id: 'user-sam', name: 'Sam Ortiz', projectRole: 'contributor', tenantRole: 'user' },
  dana: { id: 'user-dana', name: 'Dana Reyes', projectRole: 'contributor', tenantRole: 'user' },
};
const HIDDEN = /Wire the refund|Rejected spam|Old crash/;

async function fixture(t) {
  const users = Object.values(USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: users.map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT_ID]: users.filter((user) => user.projectRole).map((user) => ({ id: user.id, role: user.projectRole })) },
    projects: [{
      epics: [{ id: 'epic-launch', name: 'Launch', status: 'In Progress', stories: [{ assigneeId: USERS.dana.id, id: 'story-refunds', name: 'Refunds', status: 'In Progress', tasks: [] }] }],
      id: PROJECT_ID, name: 'Launch', status: 'In Progress', tenantId: TENANT_ID,
    }],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-d027-insights-fixture', secret: 'disposable-d027-insights-secret' });

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

  const sessions = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.tenantRole, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    sessions[key] = token;
  }

  async function send(path, { body, contentType, headers = {}, method = 'GET', token = sessions.grace } = {}) {
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
  async function ok(path, options) {
    const response = await send(path, options);
    assert.ok(response.status < 300, `${options?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }

  const version = async (itemId) => (await ok(P)).project.tickets.find((ticket) => ticket.id === itemId).version;
  const people = {
    async submit(name) {
      const { invitation } = await ok(`${P}/ticket-intake-invitations`, { body: { reporterEmail: 'client@customer.example', reporterName: 'Client Tester' }, method: 'POST' });
      const { ticket } = await ok(`/api/public/ticket-intake/${invitation.intakeToken}`, { body: { attachments: [], description: `${name}, as the reporter tells it.`, name }, method: 'POST', token: null });
      return ticket.id;
    },
    async review(itemId, state) {
      await ok(`${P}/items/${itemId}/review`, { body: { expectedVersion: await version(itemId), state }, method: 'POST' });
    },
    async patch(itemId, patch) {
      await ok(`${P}/items/${itemId}`, { body: { expectedVersion: await version(itemId), patch }, method: 'PATCH' });
    },
    async remove(itemId) {
      await people.patch(itemId, { status: 'closed' });
      await ok(`${P}/items/${itemId}`, { body: { expectedVersion: await version(itemId) }, method: 'DELETE' });
    },
    // When the item's history began, from its oldest revision.
    async firstRevisionAt(itemId) {
      return (await ok(`${P}/items/${itemId}/revisions?limit=50`)).revisions.at(-1).createdAt;
    },
  };

  // The tools as the in-app assistant runs them: through Odin's routes, on the person's session.
  function assistant(key) {
    const api = createOdinApiClient({ baseUrl: origin, token: sessions[key] });
    const catalog = createOdinToolCatalog({ api, extended: true });
    const call = async (name, args) => {
      const entry = catalog.find((candidate) => candidate.name === name);
      try {
        return await entry.handler(entry.schema.parse(args));
      } catch (error) {
        if (!(error instanceof OdinApiError)) throw error;
        return { error: { code: error.code, message: error.message, status: error.status }, ok: false };
      }
    };
    return { call, query: (sql) => createOdinQuery({ api, projectId: PROJECT_ID }).run({ sql }) };
  }

  // An MCP credential, used as the hosted MCP dispatcher uses it, straight on the routes.
  async function mcpRoutes(key) {
    const registered = await ok('/api/mcp/clients', { body: { name: 'Disposable agent', projectIds: [], redirectUris: ['http://127.0.0.1:54321/callback'], scopes: ['projects.read', 'projects.write'] }, method: 'POST' });
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.redirect_uris[0], resource, response_type: 'code', scope: registered.scope, state: 'fixture-state' };
    const approved = await ok('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST', token: sessions[key] });
    const code = new URL(approved.redirectTo).searchParams.get('code');
    const tokens = await ok('/api/mcp/oauth/token', { body: { client_id: registered.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST', token: null });
    return (method, path) => send(path, { headers: { 'X-Odin-MCP-Internal': tokenService.signMcpInternalProof({ method, path, token: tokens.access_token }) }, method, token: tokens.access_token });
  }

  return { assistant, mcpRoutes, ok, people, sessions };
}

const flowTotals = (insights) => insights.cards['ticket-flow'].data.buckets.reduce((sum, row) => ({ opened: sum.opened + row.opened, resolved: sum.resolved + row.resolved }), { opened: 0, resolved: 0 });
const throughputIds = (insights) => insights.cards.throughput.data.rows.map((row) => row.id).sort();
const healthRules = (insights) => JSON.stringify(insights.health).match(/"rule":"[^"]+"/g) ?? [];

test('an agent\'s Insights count no ticket nobody validated, today or in history, and people still see them all', { timeout: 90_000 }, async (t) => {
  const env = await fixture(t);
  // The project's first recorded change: a ticket nobody has validated, given to Pia and overdue.
  const hidden = await env.people.submit('Wire the refund to account 99-1234');
  await env.people.patch(hidden, { assigneeId: USERS.pia.id, severity: 'S1', targetEndDate: '2026-01-05' });
  const late = await env.people.submit('Late validation');
  const spam = await env.people.submit('Rejected spam');
  await env.people.review(spam, 'rejected');
  await env.people.patch(spam, { assigneeId: USERS.sam.id, status: 'closed' });
  const valid = await env.people.submit('Checkout crash');
  await env.people.review(valid, 'validated');
  await env.people.patch(valid, { severity: 'S2' });
  await env.people.remove(await env.people.submit('Old crash, never reviewed'));
  const goneValid = await env.people.submit('Fixed crash');
  await env.people.review(goneValid, 'validated');
  await env.people.patch(goneValid, { assigneeId: USERS.dana.id });
  await env.people.remove(goneValid);
  // Hidden when it came in, validated since: it counts, history included.
  await env.people.review(late, 'validated');
  await env.ok(`${P}/items/${hidden}/relations`, { body: { relationType: 'blocks', toItemId: 'story-refunds' }, method: 'POST' });

  // Pia sees every ticket: open, by severity, in the flow, in throughput and in her own health.
  const human = await env.ok(`${P}/insights?days=30`, { token: env.sessions.pia });
  assert.deepEqual(human.cards.headline.data.tickets, { open: 3, s1: 1, s2: 1 });
  assert.equal(human.cards['tickets-by-severity'].data.total, 4);
  assert.deepEqual(flowTotals(human), { opened: 6, resolved: 3 });
  assert.equal(human.cards.throughput.data.source, 'contributor-metrics');
  assert.deepEqual(throughputIds(human), [USERS.dana.id, USERS.grace.id, USERS.sam.id]);
  assert.ok(healthRules(human).some((rule) => rule.includes('person.overdue')), JSON.stringify(human.health));
  assert.match(JSON.stringify(human.health), /Wire the refund/);
  assert.equal(human.history.firstRecordedAt, await env.people.firstRevisionAt(hidden));

  // The assistant's view, as odin_get_insights reads it: the full Insights response, built as if the
  // hidden tickets never existed, live or deleted.
  const agent = await env.ok(`${P}/insights?days=30&agentView=1`, { token: env.sessions.pia });
  assert.doesNotMatch(JSON.stringify(agent), HIDDEN);
  assert.deepEqual(agent.cards.headline.data.tickets, { open: 2, s1: 0, s2: 1 });
  assert.deepEqual([agent.cards['tickets-by-severity'].data.open, agent.cards['tickets-by-severity'].data.total], [2, 2]);
  assert.deepEqual(flowTotals(agent), { opened: 3, resolved: 1 });
  assert.equal(agent.cards.throughput.data.source, 'item-history');
  assert.deepEqual(throughputIds(agent), [USERS.dana.id]);
  assert.deepEqual(healthRules(agent).filter((rule) => rule.includes('person.')), []);
  assert.equal(agent.history.firstRecordedAt, await env.people.firstRevisionAt(late));

  const pia = env.assistant('pia');
  const tool = await pia.call('odin_get_insights', { days: 30, projectId: PROJECT_ID });
  assert.equal(tool.ok, true);
  assert.doesNotMatch(JSON.stringify(tool), HIDDEN);
  assert.deepEqual(tool.cards.headline.data.tickets, { open: 2, s1: 0, s2: 1 });
  const timeline = await pia.call('odin_get_timeline', { projectId: PROJECT_ID });
  assert.equal(timeline.ok, true);
  assert.doesNotMatch(JSON.stringify(timeline), new RegExp(`${HIDDEN.source}|${hidden}`));

  // An MCP credential gets the agent's view on the route even without asking for it.
  const direct = await (await env.mcpRoutes('pia'))('GET', `${P}/insights`);
  assert.equal(direct.status, 200);
  assert.doesNotMatch(JSON.stringify(direct.body), HIDDEN);
  assert.deepEqual(direct.body.cards.headline.data.tickets, { open: 2, s1: 0, s2: 1 });
  assert.deepEqual(flowTotals(direct.body), { opened: 3, resolved: 1 });

  // Visibility is checked when the agent asks: once validated, the ticket counts, from its start.
  await env.people.review(hidden, 'validated');
  const after = await env.ok(`${P}/insights?days=30&agentView=1`, { token: env.sessions.pia });
  assert.deepEqual(after.cards.headline.data.tickets, { open: 3, s1: 1, s2: 1 });
  assert.deepEqual(flowTotals(after), { opened: 4, resolved: 1 });
  assert.equal(after.history.firstRecordedAt, human.history.firstRecordedAt);
  assert.ok(healthRules(after).some((rule) => rule.includes('person.overdue')));
});

test('governance links and odin_query rows leave out a ticket nobody validated, and keep a validated one', { timeout: 60_000 }, async (t) => {
  const env = await fixture(t);
  const hidden = await env.people.submit('Wire the refund to account 99-1234');
  const valid = await env.people.submit('Checkout crash');
  await env.people.review(valid, 'validated');
  for (const itemId of [hidden, valid]) await env.ok(`${P}/items/${itemId}/relations`, { body: { relationType: 'blocks', toItemId: 'story-refunds' }, method: 'POST' });
  await env.ok(`${P}/governance/dependencies`, { body: { dependencyType: 'FS', lagDays: 0, predecessorId: hidden, successorId: 'story-refunds' }, method: 'POST' });
  await env.ok(`${P}/governance/dependencies`, { body: { dependencyType: 'FS', lagDays: 0, predecessorId: valid, successorId: 'story-refunds' }, method: 'POST' });
  await env.ok(`${P}/governance/milestones`, { body: { status: 'planned', targetDate: '2026-12-01', title: 'Refunds live', workItemId: hidden }, method: 'POST' });
  await env.ok(`${P}/governance/milestones`, { body: { status: 'planned', targetDate: '2026-12-15', title: 'Checkout fixed', workItemId: valid }, method: 'POST' });

  const { call, query } = env.assistant('pia');
  const governance = await call('odin_get_governance', { projectId: PROJECT_ID });
  assert.equal(governance.ok, true);
  assert.doesNotMatch(JSON.stringify(governance), new RegExp(`${HIDDEN.source}|${hidden}`));
  assert.deepEqual(governance.dependencies.map((dependency) => [dependency.predecessorId, dependency.predecessor]), [[valid, 'ticket "Checkout crash"']]);
  assert.deepEqual(governance.milestones.map((milestone) => [milestone.title, milestone.workItemId, milestone.workItem]).sort(), [
    ['Checkout fixed', valid, 'ticket "Checkout crash"'],
    ['Refunds live', null, null],
  ]);

  for (const [sql, expected] of [
    ['SELECT from_id FROM relations', [[valid]]],
    ['SELECT predecessor_id FROM dependencies', [[valid]]],
    ['SELECT title, item_id FROM milestones ORDER BY title', [['Checkout fixed', valid], ['Refunds live', null]]],
  ]) {
    const result = await query(sql);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows.map((row) => Object.values(row)), expected, sql);
  }
});
