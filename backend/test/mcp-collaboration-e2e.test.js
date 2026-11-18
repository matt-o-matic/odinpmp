import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { flushDueClarificationInvitationDigests } from '../src/modules/assistant/clarification-invitation-digest.service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// MCP parity for clarification ownership, stakeholder contacts and invitations, and project
// membership: OAuth MCP clients call the real Odin routes on an in-process app over loopback
// HTTP. Repositories are disposable and in memory. Mail is only queued in an in-memory
// repository; this app has no mail transport, so nothing is delivered. Assignment
// invitations wait in per-stakeholder digests; deliver() runs the mail job's digest step as
// if the quiet period had passed.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-pilot';
const OTHER_PROJECT_ID = 'project-other';
const FRONTEND = 'https://frontend-fixture.example/app';
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', projectRole: null, tenantRole: 'admin' },
  lead: { id: 'user-lead', name: 'Lee Lead', projectRole: null, tenantRole: 'manager' },
  pm: { id: 'user-pm', name: 'Pat Projectadmin', projectRole: 'admin', tenantRole: 'user' },
  member: { id: 'user-member', name: 'Mona Member', projectRole: 'user', tenantRole: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', tenantRole: 'user' },
  former: { id: 'user-former', name: 'Fay Former', projectRole: 'user', tenantRole: 'user' },
  outsider: { id: 'user-outsider', name: 'Olu Outsider', projectRole: null, tenantRole: 'user' },
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
      // The viewer's older role is one Odin's member save does not accept.
      [OTHER_PROJECT_ID]: [{ id: USERS.pm.id, role: 'admin' }, { id: USERS.viewer.id, role: 'viewer' }],
      [PROJECT_ID]: [
        { id: USERS.pm.id, project_allocation: 0.5, project_bill_rate: 150, role: 'admin' },
        { id: USERS.member.id, project_allocation: 0.25, project_bill_rate: 99.5, role: 'user' },
        { id: USERS.former.id, role: 'user' },
      ],
    },
    projects: [PROJECT_ID, OTHER_PROJECT_ID].map((id) => ({ epics: [], id, name: id, status: 'In Progress', tenantId: TENANT_ID })),
  } });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const sessionsRepository = createInMemorySessionsRepository();
  const mailRepository = createInMemoryMailRepository();
  // Every email in send order: queued mail (stakeholder links) and digests sent through the
  // mail job's transport (a fake here; nothing leaves the process).
  const outbox = [];
  const queueMail = mailRepository.queueMail.bind(mailRepository);
  mailRepository.queueMail = async (input) => {
    const queued = await queueMail(input);
    if (queued) outbox.push({ kind: 'queued', recipientEmail: String(input.recipientEmail).trim().toLowerCase(), templateId: input.templateId });
    return queued;
  };
  const digestTransport = {
    sent: [],
    async sendMail(message) {
      digestTransport.sent.push(message);
      outbox.push({ kind: 'digest', recipientEmail: message.to });
      return { messageId: `<digest-${digestTransport.sent.length}@fixture>` };
    },
  };
  const tokenService = createTokenService({ issuer: 'mcp-collaboration-fixture', secret: 'disposable-collaboration-fixture-secret' });

  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    assistantRepository, authRepository, mailRepository, projectRepository, requirementsRepository, sessionsRepository, tokenService,
    backendPublicUrl: origin,
    frontendAppUrl: FRONTEND,
    mailReplyDomain: 'reply.fixture.example',
    mcpOAuthRepository: createInMemoryMcpOAuthRepository(),
    mcpPublicUrl: resource,
  });
  // One-shot interceptors run a step just before a matching request reaches the app, to
  // interleave a native save between an MCP tool's reads and its own save.
  const interceptors = [];
  http.on('request', (request, response) => {
    const index = interceptors.findIndex((entry) => entry.matches(request));
    if (index < 0) return app(request, response);
    const [entry] = interceptors.splice(index, 1);
    Promise.resolve().then(entry.before).then(() => app(request, response), (error) => {
      response.statusCode = 599;
      response.end(String(error?.stack ?? error));
    });
  });
  const intercept = (matches, before) => interceptors.push({ before, matches });
  t.after(async () => {
    app.locals.requirementsSummaries?.stop?.();
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    assert.equal(http.listening, false);
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
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { body: json, status: response.status };
  }

  async function register(scopes, projectIds = []) {
    const response = await send('/api/mcp/clients', { body: { name: 'Disposable dot', projectIds, redirectUris: ['http://127.0.0.1:54321/callback'], scopes }, method: 'POST', token: sessions.admin });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  }
  const responses = [];
  async function connect(role, scopes = ['projects.read', 'projects.write'], projectIds = []) {
    const registered = await register(scopes, projectIds);
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.redirect_uris[0], resource, response_type: 'code', scope: registered.scope, state: 'fixture-state' };
    const approved = await send('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST', token: sessions[role] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const tokens = await send('/api/mcp/oauth/token', { body: { client_id: registered.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST' });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const client = new Client({ name: `${role}-dot-fixture`, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    async function call(name, args = {}) {
      const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 30_000 });
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(result.structuredContent, data);
      responses.push(data);
      return { data, isError: result.isError === true };
    }
    return {
      accessToken: tokens.body.access_token,
      client,
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

  /** A REST call made the way the MCP dispatcher makes it: MCP token plus internal proof. */
  async function asMcpDispatcher(accessToken, method, path, body) {
    const proof = tokenService.signMcpInternalProof({ method, path, token: accessToken });
    return send(path, { body, headers: { 'X-Odin-MCP-Internal': proof }, method, token: accessToken });
  }

  const deliver = (afterMinutes = 21) => flushDueClarificationInvitationDigests({
    assistantRepository, frontendAppUrl: FRONTEND, mailReplyDomain: 'reply.fixture.example', mailRepository,
    now: () => new Date(Date.now() + afterMinutes * 60_000), projectRepository, transport: digestTransport,
  });

  return { asMcpDispatcher, assistantRepository, connect, deliver, digestTransport, intercept, mailRepository, outbox, requirementsRepository, responses, send, sessions };
}

test('OAuth MCP clients manage clarification owners, stakeholder invitations and project members through Odin routes', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  await env.requirementsRepository.createTopics({ projectId: PROJECT_ID, tenantId: TENANT_ID, topics: [
    { id: 'topic-price', prompt: 'Where should the price first appear?', sourceRef: null, topicOrigin: 'manual', track: 'experience' },
    { id: 'topic-sync', prompt: 'Which system owns customer records?', sourceRef: null, topicOrigin: 'manual', track: 'architecture' },
  ] });
  await env.requirementsRepository.createTopics({ projectId: OTHER_PROJECT_ID, tenantId: TENANT_ID, topics: [
    { id: 'topic-other', prompt: 'Who signs off the rollout?', sourceRef: null, topicOrigin: 'manual', track: 'experience' },
  ] });
  const queued = () => env.outbox.map((entry) => entry.recipientEmail);
  const admin = await env.connect('admin');
  const lead = await env.connect('lead');
  const pm = await env.connect('pm');
  const member = await env.connect('member');
  const viewer = await env.connect('viewer');
  const former = await env.connect('former');
  const reader = await env.connect('admin', ['projects.read']);
  const otherOnly = await env.connect('admin', ['projects.read', 'projects.write'], [OTHER_PROJECT_ID]);

  await t.test('discovery lists 151 tools with the new tools\' OAuth scopes', async () => {
    const { tools } = await admin.client.listTools({}, { timeout: 10_000 });
    assert.equal(tools.length, 151);
    const scopes = Object.fromEntries(tools.filter((tool) => /clarification|stakeholder|member/.test(tool.name)).map((tool) => [tool.name, tool._meta.securitySchemes[0].scopes.join(' ')]));
    assert.deepEqual(scopes, {
      odin_add_stakeholder: 'projects.read projects.write',
      odin_assign_clarification: 'projects.read projects.write',
      odin_extend_stakeholder_link: 'projects.read projects.write',
      odin_get_clarification: 'projects.read',
      odin_list_clarifications: 'projects.read',
      odin_list_project_members: 'projects.read',
      odin_list_stakeholder_links: 'projects.read',
      odin_list_stakeholders: 'projects.read',
      odin_preview_clarification_assignment: 'projects.read',
      odin_preview_stakeholder_invitation: 'projects.read',
      odin_revoke_stakeholder_link: 'projects.read projects.write',
      odin_send_stakeholder_invitation: 'projects.read projects.write',
      odin_update_project_members: 'projects.read projects.write',
      odin_update_stakeholder: 'projects.read projects.write',
    });
  });

  await t.test('project members: list with roles, apply a delta, preserve allocation and bill rate, and keep Odin\'s role checks', async () => {
    const listed = await pm.ok('odin_list_project_members', { projectId: PROJECT_ID });
    assert.deepEqual(listed.members.map((entry) => [entry.userId, entry.role]), [['user-former', 'user'], ['user-member', 'user'], ['user-pm', 'admin']]);
    assert.ok(listed.candidates.some((entry) => entry.userId === USERS.outsider.id));
    assert.deepEqual(listed.roles.map((role) => role.role), ['admin', 'manager', 'user']);

    const updated = await pm.ok('odin_update_project_members', { input: { remove: [USERS.former.id], upsert: [{ role: 'user', userId: USERS.outsider.id }, { role: 'manager', userId: USERS.member.id }] }, projectId: PROJECT_ID });
    assert.deepEqual(updated.changes, {
      added: [{ role: 'user', userId: USERS.outsider.id }],
      removed: [{ role: 'user', userId: USERS.former.id }],
      roleChanged: [{ from: 'user', to: 'manager', userId: USERS.member.id }],
    });
    const stored = await env.send(`/api/projects/${PROJECT_ID}/valid-users`, { token: env.sessions.admin });
    const byId = Object.fromEntries(stored.body.project_users.map((entry) => [entry.id, entry]));
    assert.deepEqual(Object.keys(byId).sort(), [USERS.member.id, USERS.outsider.id, USERS.pm.id].sort());
    assert.deepEqual([byId[USERS.member.id].role, byId[USERS.member.id].project_allocation, byId[USERS.member.id].project_bill_rate], ['manager', 0.25, 99.5]);
    assert.deepEqual([byId[USERS.pm.id].role, byId[USERS.pm.id].project_allocation, byId[USERS.pm.id].project_bill_rate], ['admin', 0.5, 150]);
    assert.equal(byId[USERS.outsider.id].role, 'user');

    // A workspace manager can read membership (plan edit) but not change it (project admin).
    await lead.ok('odin_list_project_members', { projectId: PROJECT_ID });
    assert.match((await lead.fails('odin_update_project_members', { input: { upsert: [{ role: 'user', userId: USERS.lead.id }] }, projectId: PROJECT_ID }, 'http_404', 404)).message, /project admin rights/);
    // The removed member loses project access; a read grant cannot write, even as a dry run.
    await former.fails('odin_list_clarifications', { projectId: PROJECT_ID, track: 'experience' }, 'http_404', 404);
    for (const dryRun of [false, true]) {
      await reader.fails('odin_update_project_members', { dryRun, input: { remove: [USERS.outsider.id] }, projectId: PROJECT_ID }, 'insufficient_scope', 403);
    }
    await otherOnly.fails('odin_list_project_members', { projectId: PROJECT_ID }, 'http_404', 404);
    assert.equal((await env.send(`/api/projects/${PROJECT_ID}/valid-users`, { token: env.sessions.admin })).body.project_users.length, 3, 'denied calls changed nothing');
  });

  await t.test('project resources: someone without a login joins the team once, and Odin\'s workspace role checks hold', async () => {
    const team = async () => (await env.send(`/api/resource-planning/projects/${PROJECT_ID}/team`, { token: env.sessions.admin })).body.people;
    const input = { allocation: { hoursPerWeek: 20, role: 'QA' }, name: 'Casey Contractor', roles: ['QA engineer'] };
    const added = await admin.ok('odin_add_project_resource', { input, projectId: PROJECT_ID });
    assert.deepEqual([added.added, added.created, added.resource.userId, added.allocation.hoursPerWeek, added.allocation.status], [true, true, null, 20, 'active']);
    assert.equal(added.assigneeId, `resource:${added.resource.id}`);
    assert.deepEqual((await team()).map((person) => [person.assigneeId, person.resource.name]), [[added.assigneeId, 'Casey Contractor']]);
    const again = await lead.ok('odin_add_project_resource', { input: { name: 'Casey Contractor' }, projectId: PROJECT_ID });
    assert.deepEqual([again.added, again.created, again.resource.id], [false, false, added.resource.id]);

    // A workspace user has a login; a project admin without a workspace role, a read grant and
    // a grant for another project add no one.
    assert.match((await admin.fails('odin_add_project_resource', { input: { name: 'Mona Member' }, projectId: PROJECT_ID }, 'has_login', 409)).message, /odin_update_project_members/);
    assert.match((await pm.fails('odin_add_project_resource', { input: { name: 'Pia Placeholder' }, projectId: PROJECT_ID }, 'http_404', 404)).message, /workspace admin or manager/);
    await reader.fails('odin_add_project_resource', { input: { name: 'Pia Placeholder' }, projectId: PROJECT_ID }, 'insufficient_scope', 403);
    await otherOnly.fails('odin_add_project_resource', { input: { name: 'Pia Placeholder' }, projectId: PROJECT_ID }, 'http_404', 404);
    assert.equal((await team()).length, 1, 'denied calls changed nothing');
    // The grant reaches the resource-planning routes its tools use, not the rest.
    assert.equal((await env.asMcpDispatcher(admin.accessToken, 'GET', `/api/resource-planning/projects/${PROJECT_ID}/team`)).status, 200);
    assert.equal((await env.asMcpDispatcher(admin.accessToken, 'GET', '/api/resource-planning')).status, 403);
  });

  await t.test('the member promoted to manager can now read membership; a plain user cannot', async () => {
    await member.ok('odin_list_project_members', { projectId: PROJECT_ID });
    const outsider = await env.connect('outsider');
    await outsider.fails('odin_list_project_members', { projectId: PROJECT_ID }, 'http_404', 404);
  });

  let sam;
  let tia;
  let uma;
  await t.test('stakeholder contacts: workspace admins and managers add them; reads never carry tokens', async () => {
    sam = (await admin.ok('odin_add_stakeholder', { input: { email: 'sam@client.example', name: 'Sam Stake', roleTitle: 'CFO' }, projectId: PROJECT_ID })).stakeholder;
    tia = (await lead.ok('odin_add_stakeholder', { input: { email: 'tia@client.example', name: 'Tia Two' }, projectId: PROJECT_ID })).stakeholder;
    uma = (await admin.ok('odin_add_stakeholder', { input: { email: 'uma@client.example', name: 'Uma Unassigned' }, projectId: PROJECT_ID })).stakeholder;
    const again = await admin.ok('odin_add_stakeholder', { input: { email: 'sam@client.example', name: 'Sam Stake', roleTitle: 'Finance lead' }, projectId: PROJECT_ID });
    assert.deepEqual([again.stakeholder.id, again.updatedExisting, again.previous.roleTitle, again.stakeholder.roleTitle], [sam.id, true, 'CFO', 'Finance lead']);
    // A project admin who is a workspace user cannot add contacts (Odin's clarification moderator rule).
    await pm.fails('odin_add_stakeholder', { input: { email: 'x@client.example', name: 'X' }, projectId: PROJECT_ID }, 'http_403', 403);
    const listed = await member.ok('odin_list_stakeholders', { projectId: PROJECT_ID });
    assert.deepEqual(listed.items.map((entry) => entry.email).sort(), ['sam@client.example', 'tia@client.example', 'uma@client.example']);
    assert.deepEqual(queued(), [], 'adding contacts sends nothing');
  });

  await t.test('clarification ownership: preview, refuse unconfirmed emails, save owner and also-involve, and email only new stakeholders', async () => {
    const listed = await member.ok('odin_list_clarifications', { projectId: PROJECT_ID, track: 'experience' });
    assert.deepEqual(listed.items.map((entry) => [entry.id, entry.owner]), [['topic-price', null]]);

    const change = { alsoInvolve: [{ actorId: sam.id, actorType: 'stakeholder' }, { actorId: USERS.pm.id, actorType: 'user' }], clarificationId: 'topic-price', owner: { actorId: USERS.member.id, actorType: 'user' }, projectId: PROJECT_ID };
    const preview = await member.ok('odin_preview_clarification_assignment', change);
    assert.deepEqual(preview.invitationEmails.map((entry) => [entry.stakeholderId, entry.email, entry.reason]), [[sam.id, 'sam@client.example', 'new-invitation']]);
    const refused = await member.fails('odin_assign_clarification', change, 'invitation_confirmation_required', 409);
    assert.deepEqual(refused.details.confirmInvitationEmails, [sam.id]);
    assert.deepEqual(queued(), [], 'an unconfirmed save emails nobody');
    assert.deepEqual((await member.ok('odin_get_clarification', { clarificationId: 'topic-price', projectId: PROJECT_ID })).clarification.owner, null, 'and saves nothing');

    const saved = await member.ok('odin_assign_clarification', { ...change, confirmInvitationEmails: preview.confirmInvitationEmails });
    assert.equal(saved.clarification.owner.actorId, USERS.member.id);
    // Odin orders assignments itself; compare the people, not the order.
    assert.deepEqual(saved.clarification.alsoInvolve.map((entry) => `${entry.actorId}:${entry.invitationStatus ?? '-'}`).sort(), [`${sam.id}:scheduled`, `${USERS.pm.id}:-`].sort());
    assert.equal(saved.delivery.mode, 'digest');
    assert.deepEqual(queued(), [], 'the invitation waits in the digest');
    const waiting = (await member.ok('odin_list_stakeholders', { projectId: PROJECT_ID, search: 'sam' })).items[0];
    assert.equal(waiting.pendingDigest.topics, 1);
    assert.equal(waiting.clarifications[0].invitation.status, 'scheduled');
    await env.deliver();
    assert.deepEqual(queued(), ['sam@client.example']);

    const same = await member.ok('odin_assign_clarification', { ...change, confirmInvitationEmails: [] });
    assert.equal(same.changed, false);
    assert.deepEqual(queued(), ['sam@client.example'], 'an unchanged save sends nothing');

    // Hand ownership to Tia, keep the others: only Tia is new, so only Tia is emailed.
    const handover = { clarificationId: 'topic-price', owner: { actorId: tia.id, actorType: 'stakeholder' }, projectId: PROJECT_ID };
    assert.deepEqual((await member.ok('odin_preview_clarification_assignment', handover)).confirmInvitationEmails, [tia.id]);
    await member.ok('odin_assign_clarification', { ...handover, confirmInvitationEmails: [tia.id] });
    await env.deliver();
    assert.deepEqual(queued(), ['sam@client.example', 'tia@client.example']);
    const rest = await env.send(`/api/projects/${PROJECT_ID}/requirements/topics/topic-price`, { token: env.sessions.admin });
    assert.deepEqual(rest.body.topic.assignments.map((entry) => `${entry.actorId}:${entry.role}`).sort(), [`${tia.id}:primary`, `${sam.id}:collaborator`, `${USERS.pm.id}:collaborator`].sort());

    // A read grant cannot save, other projects are out of reach, and Odin validates the people.
    await otherOnly.fails('odin_preview_clarification_assignment', { ...handover, owner: null }, 'clarification_not_found', 404);
    await reader.fails('odin_assign_clarification', { ...handover, owner: null }, 'insufficient_scope', 403);
    await member.fails('odin_assign_clarification', { ...handover, alsoInvolve: [{ actorId: 'stakeholder-unknown', actorType: 'stakeholder' }] }, 'invalid_assignment', 400);
    await member.fails('odin_assign_clarification', { ...handover, owner: { actorId: 'user-unknown', actorType: 'user' } }, 'invalid_assignment', 400);
    assert.deepEqual(queued(), ['sam@client.example', 'tia@client.example']);

    const involvement = await member.ok('odin_list_stakeholders', { projectId: PROJECT_ID, search: 'sam' });
    assert.deepEqual(involvement.items[0].clarifications.map((entry) => [entry.clarificationId, entry.role, entry.invitation?.status]), [['topic-price', 'alsoInvolve', 'sent']]);
  });

  await t.test('a viewer reads clarifications but cannot assign people', async () => {
    await viewer.ok('odin_get_clarification', { clarificationId: 'topic-other', projectId: OTHER_PROJECT_ID });
    const preview = await viewer.ok('odin_preview_clarification_assignment', { clarificationId: 'topic-other', owner: { actorId: USERS.viewer.id, actorType: 'user' }, projectId: OTHER_PROJECT_ID });
    assert.equal(preview.changed, true);
    await viewer.fails('odin_assign_clarification', { clarificationId: 'topic-other', owner: { actorId: USERS.viewer.id, actorType: 'user' }, projectId: OTHER_PROJECT_ID }, 'clarification_not_found', 404);
    assert.deepEqual((await env.send(`/api/projects/${OTHER_PROJECT_ID}/requirements/topics/topic-other`, { token: env.sessions.admin })).body.topic.assignments, []);
  });

  await t.test('stakeholder edits: a rename reaches their topic assignments, an email in use is refused, and only admins and managers edit', async () => {
    await pm.fails('odin_update_stakeholder', { name: 'Sam S', projectId: PROJECT_ID, stakeholderId: sam.id }, 'http_403', 403);
    const renamed = await admin.ok('odin_update_stakeholder', { email: 'samantha@client.example', name: 'Samantha Stake', projectId: PROJECT_ID, roleTitle: 'Chief financial officer', stakeholderId: sam.id });
    assert.deepEqual([renamed.stakeholder.id, renamed.stakeholder.name, renamed.stakeholder.email, renamed.stakeholder.roleTitle, renamed.previous.name], [sam.id, 'Samantha Stake', 'samantha@client.example', 'Chief financial officer', 'Sam Stake']);
    const { clarification } = await member.ok('odin_get_clarification', { clarificationId: 'topic-price', projectId: PROJECT_ID });
    assert.equal(clarification.alsoInvolve.find((person) => person.actorId === sam.id).label, 'Samantha Stake');
    const taken = await lead.fails('odin_update_stakeholder', { email: 'TIA@client.example', projectId: PROJECT_ID, stakeholderId: sam.id }, 'stakeholder_email_taken', 409);
    assert.match(taken.message, /already uses that email/);
    await admin.fails('odin_update_stakeholder', { name: 'Nobody', projectId: PROJECT_ID, stakeholderId: 'missing-stakeholder' }, 'stakeholder_not_found', 404);
    // Put Sam back for the invitation steps that follow.
    await admin.ok('odin_update_stakeholder', { email: 'sam@client.example', name: 'Sam Stake', projectId: PROJECT_ID, roleTitle: 'Finance lead', stakeholderId: sam.id });
  });

  await t.test('a member save never rewrites a role that Odin cannot save; an explicit role change goes through', async () => {
    const listed = await pm.ok('odin_list_project_members', { projectId: OTHER_PROJECT_ID });
    assert.deepEqual(listed.members.map((entry) => [entry.userId, entry.role]), [['user-pm', 'admin'], ['user-viewer', 'viewer']]);
    const refused = await pm.fails('odin_update_project_members', { input: { upsert: [{ role: 'user', userId: USERS.outsider.id }] }, projectId: OTHER_PROJECT_ID }, 'members_need_explicit_change', 409);
    assert.deepEqual(refused.details, { outsideWorkspace: [], unsupportedRoles: [{ role: 'viewer', userId: USERS.viewer.id }] });
    const before = await env.send(`/api/projects/${OTHER_PROJECT_ID}/valid-users`, { token: env.sessions.admin });
    assert.deepEqual(before.body.project_users.map((entry) => `${entry.id}:${entry.role}`).sort(), ['user-pm:admin', 'user-viewer:viewer']);
    const changed = await pm.ok('odin_update_project_members', { input: { upsert: [{ role: 'user', userId: USERS.outsider.id }, { role: 'user', userId: USERS.viewer.id }] }, projectId: OTHER_PROJECT_ID });
    assert.deepEqual(changed.changes.roleChanged, [{ from: 'viewer', to: 'user', userId: USERS.viewer.id }]);
  });

  await t.test('stakeholder invitations: preview, refuse a wrong recipient, send explicitly, extend and revoke, without exposing links', async () => {
    // The outsider was added as a plain project user: no decision rights, so no links.
    const plainUser = await env.connect('outsider');
    await plainUser.fails('odin_list_stakeholder_links', { projectId: PROJECT_ID }, 'http_404', 404);
    const preview = await lead.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT_ID, stakeholderId: uma.id });
    assert.deepEqual([preview.outcome, preview.recipient, preview.link], ['create-link', 'uma@client.example', null]);

    await lead.fails('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'sam@client.example', projectId: PROJECT_ID, stakeholderId: uma.id }, 'recipient_mismatch', 409);
    await reader.fails('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'uma@client.example', projectId: PROJECT_ID, stakeholderId: uma.id }, 'insufficient_scope', 403);
    await plainUser.fails('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'uma@client.example', projectId: PROJECT_ID, stakeholderId: uma.id }, 'http_404', 404);
    assert.deepEqual(queued(), ['sam@client.example', 'tia@client.example'], 'refused sends email nobody');

    const sent = await lead.ok('odin_send_stakeholder_invitation', { confirmRecipientEmail: preview.confirmRecipientEmail, projectId: PROJECT_ID, stakeholderId: uma.id });
    assert.deepEqual([sent.email.sent, sent.email.recipient, sent.outcome], [true, 'uma@client.example', 'created-link']);
    assert.deepEqual(queued(), ['sam@client.example', 'tia@client.example', 'uma@client.example']);

    const links = await lead.ok('odin_list_stakeholder_links', { projectId: PROJECT_ID });
    const umaLink = links.items.find((entry) => entry.stakeholder.id === uma.id);
    assert.equal(umaLink.status, 'active');
    assert.deepEqual(umaLink.tokens.map((token) => token.purpose), ['invitation']);
    assert.equal((await lead.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT_ID, stakeholderId: uma.id })).outcome, 'issue-additional-token');

    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    assert.ok((await lead.ok('odin_extend_stakeholder_link', { linkId: umaLink.id, projectId: PROJECT_ID, until })).link.extendedUntil);
    await lead.fails('odin_extend_stakeholder_link', { linkId: umaLink.id, projectId: PROJECT_ID, until: new Date(Date.now() - 86_400_000).toISOString() }, 'invalid_extension', 400);
    assert.equal((await lead.ok('odin_revoke_stakeholder_link', { linkId: umaLink.id, projectId: PROJECT_ID })).link.status, 'revoked');
    await lead.fails('odin_extend_stakeholder_link', { linkId: umaLink.id, projectId: PROJECT_ID, until }, 'link_revoked', 409);
    assert.equal((await lead.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT_ID, stakeholderId: uma.id })).outcome, 'reactivate-link');
    await lead.fails('odin_revoke_stakeholder_link', { linkId: 'link-missing', projectId: PROJECT_ID }, 'link_not_found', 404);
    assert.deepEqual(queued(), ['sam@client.example', 'tia@client.example', 'uma@client.example'], 'extend and revoke send nothing');
  });

  await t.test('a native save between the tool reads and its save cannot make it email an unconfirmed stakeholder', async () => {
    const topicPath = `/api/projects/${PROJECT_ID}/requirements/topics/topic-price`;
    const people = async () => (await env.send(topicPath, { token: env.sessions.admin })).body.topic.assignments.map((entry) => `${entry.actorId}:${entry.role}`).sort();
    const invited = (stakeholderId) => env.assistantRepository.state.projectClarificationInvitations
      .some((entry) => entry.clarificationId === 'topic-price' && entry.stakeholderId === stakeholderId && !entry.deactivatedAt);
    const mcpSave = (request) => request.method === 'PATCH' && request.url === topicPath && Boolean(request.headers['x-odin-mcp-internal']);
    const nativeSave = (body) => env.send(topicPath, { body, method: 'PATCH', token: env.sessions.admin });
    const tiaOwner = { actorId: tia.id, actorType: 'stakeholder', label: 'Tia Two', role: 'primary' };
    const pmInvolved = { actorId: USERS.pm.id, actorType: 'user', label: USERS.pm.name, role: 'collaborator' };
    const baseline = queued();
    assert.deepEqual(await people(), [`${tia.id}:primary`, `${sam.id}:collaborator`, `${USERS.pm.id}:collaborator`].sort());
    assert.equal(invited(sam.id), true);

    // The owner changes and Sam stays involved. Sam is already invited, so the save emails nobody.
    const handover = { clarificationId: 'topic-price', owner: { actorId: USERS.member.id, actorType: 'user' }, projectId: PROJECT_ID };
    assert.deepEqual((await member.ok('odin_preview_clarification_assignment', handover)).confirmInvitationEmails, []);
    // After the tool has read the clarification, and just before its save reaches Odin, someone
    // removes Sam in Odin, which ends Sam's invitation. Restoring Sam would now email Sam.
    env.intercept(mcpSave, async () => {
      const removed = await nativeSave({ assignments: [tiaOwner, pmInvolved] });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
    });
    const refused = await member.fails('odin_assign_clarification', { ...handover, confirmInvitationEmails: [] }, 'invitation_confirmation_required', 409);
    assert.equal(refused.outcomeUnknown, false);
    assert.deepEqual(queued(), baseline, 'Sam was not emailed');
    assert.equal(invited(sam.id), false, 'and has no new invitation');
    assert.deepEqual(await people(), [`${tia.id}:primary`, `${USERS.pm.id}:collaborator`].sort(), 'the native save stands; the tool saved nothing');
    const restore = { ...handover, alsoInvolve: [{ actorId: sam.id, actorType: 'stakeholder' }, { actorId: USERS.pm.id, actorType: 'user' }] };
    assert.deepEqual((await member.ok('odin_preview_clarification_assignment', restore)).confirmInvitationEmails, [sam.id], 'a fresh preview shows the real recipient');

    // An intervening change that alters nobody's invitation does not block the save: beyond the
    // recipients there is no version precondition, so the tool's list wins.
    env.intercept(mcpSave, async () => {
      assert.equal((await nativeSave({ assignments: [tiaOwner] })).status, 200);
    });
    assert.equal((await member.ok('odin_assign_clarification', { ...handover, confirmInvitationEmails: [] })).changed, true);
    assert.deepEqual(await people(), [`${USERS.member.id}:primary`, `${USERS.pm.id}:collaborator`].sort());
    assert.deepEqual(queued(), baseline);

    // Confirmed recipients go through, and only they are emailed.
    await member.ok('odin_assign_clarification', { ...restore, confirmInvitationEmails: [sam.id] });
    await env.deliver();
    assert.deepEqual(queued(), [...baseline, 'sam@client.example']);
    assert.equal(invited(sam.id), true);
  });

  await t.test('the Odin API keeps the UI save unchanged and offers the precondition to any caller', async () => {
    const topicPath = `/api/projects/${PROJECT_ID}/requirements/topics/topic-price`;
    const current = (await env.send(topicPath, { token: env.sessions.admin })).body.topic.assignments.map(({ actorId, actorType, label, role }) => ({ actorId, actorType, label, role }));
    const withTia = [...current, { actorId: tia.id, actorType: 'stakeholder', label: 'Tia Two', role: 'collaborator' }];
    const baseline = queued();

    const mismatched = await env.send(topicPath, { body: { assignments: withTia, expectedInvitationRecipients: [] }, method: 'PATCH', token: env.sessions.admin });
    assert.deepEqual([mismatched.status, mismatched.body.details.code, mismatched.body.details.recipients], [409, 'invitation_recipients_changed', [tia.id]]);
    assert.equal((await env.send(topicPath, { token: env.sessions.admin })).body.topic.assignments.length, current.length, 'nothing saved');
    const mixed = await env.send(topicPath, { body: { assignments: withTia, expectedInvitationRecipients: [tia.id], prompt: 'Changed too' }, method: 'PATCH', token: env.sessions.admin });
    assert.equal(mixed.status, 400);
    assert.deepEqual(queued(), baseline);

    // The Assign people dialog's shape, without the precondition, saves and invites as before.
    const ui = await env.send(topicPath, { body: { assignments: withTia }, method: 'PATCH', token: env.sessions.admin });
    assert.equal(ui.status, 200, JSON.stringify(ui.body));
    await env.deliver();
    assert.deepEqual(queued(), [...baseline, 'tia@client.example']);
  });

  await t.test('a UI save and an MCP save for the same stakeholder land in one digest after the quiet period', async () => {
    const vera = (await admin.ok('odin_add_stakeholder', { input: { email: 'vera@client.example', name: 'Vera Vale' }, projectId: PROJECT_ID })).stakeholder;
    const baseline = queued();
    const ui = await env.send(`/api/projects/${PROJECT_ID}/requirements/topics/topic-sync`, { body: { assignments: [{ actorId: vera.id, actorType: 'stakeholder', role: 'primary' }] }, method: 'PATCH', token: env.sessions.admin });
    assert.equal(ui.status, 200, JSON.stringify(ui.body));
    const change = { alsoInvolve: [{ actorId: vera.id, actorType: 'stakeholder' }], clarificationId: 'topic-price', projectId: PROJECT_ID };
    const current = (await member.ok('odin_get_clarification', { clarificationId: 'topic-price', projectId: PROJECT_ID })).clarification;
    change.alsoInvolve.push(...current.alsoInvolve.map(({ actorId, actorType }) => ({ actorId, actorType })));
    const preview = await member.ok('odin_preview_clarification_assignment', change);
    assert.deepEqual(preview.confirmInvitationEmails, [vera.id]);
    assert.equal(preview.invitationEmails[0].digest.otherWaitingTopics, 1, 'the UI assignment is already waiting in her digest');
    await member.ok('odin_assign_clarification', { ...change, confirmInvitationEmails: [vera.id] });

    const waiting = (await member.ok('odin_list_stakeholders', { projectId: PROJECT_ID, search: 'vera' })).items[0];
    assert.equal(waiting.pendingDigest.topics, 2);
    assert.equal((await env.deliver(10)).sent, 0, 'not before the quiet period');
    assert.deepEqual(queued(), baseline);
    await env.deliver();
    const sent = env.digestTransport.sent.filter((message) => message.to === 'vera@client.example');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, `2 clarifications need your input in ${PROJECT_ID}`);
    assert.ok(sent[0].html.includes('Where should the price first appear?') && sent[0].html.includes('Which system owns customer records?'));
    assert.equal((await env.deliver(60)).sent, 0, 'and only once');
    assert.equal(env.mailRepository.state.queue.some((row) => row.recipientEmail === 'vera@client.example'), false, 'digests never use the shared queue');
  });

  await t.test('the MCP credential cannot change topic status or text, save people without the recipient check, mint unsent links, or reach neighbouring routes', async () => {
    const topic = `/api/projects/${PROJECT_ID}/requirements/topics/topic-price`;
    for (const [method, path, body] of [
      ['PATCH', topic, { status: 'resolved' }],
      ['PATCH', topic, { assignments: [] }],
      ['PATCH', topic, { assignments: [], expectedInvitationRecipients: [], status: 'resolved' }],
      ['PATCH', topic, { assignments: [], prompt: 'Changed by MCP' }],
      ['POST', `/api/projects/${PROJECT_ID}/requirements/links`, { send: false, stakeholderId: uma.id }],
      ['POST', `/api/projects/${PROJECT_ID}/requirements/links`, { stakeholderId: uma.id }],
      ['GET', '/api/assistant/sessions'],
      ['POST', '/api/assistant/sessions', { mode: 'project-context', projectId: PROJECT_ID }],
      ['PUT', `/api/projects/${PROJECT_ID}/tree`, { epics: [] }],
      ['POST', '/api/tenants/invites', { email: 'new@acme.example' }],
    ]) {
      const response = await env.asMcpDispatcher(admin.accessToken, method, path, body);
      // 403 from the MCP route allowlist; routers that never accept MCP credentials answer 401.
      assert.ok([401, 403].includes(response.status), `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    const stored = await env.send(topic, { token: env.sessions.admin });
    assert.deepEqual([stored.body.topic.status, stored.body.topic.prompt], ['open', 'Where should the price first appear?']);
  });

  await t.test('no tool result carried a stakeholder, invitation or reply token, or a portal link', async () => {
    const state = env.assistantRepository.state;
    const secrets = [
      ...state.projectStakeholders.map((entry) => entry.accessToken),
      ...state.projectClarificationInvitations.flatMap((entry) => [entry.invitationToken, entry.replyToken]),
    ].filter(Boolean);
    assert.ok(secrets.length >= 5, `fixture produced ${secrets.length} tokens`);
    const text = JSON.stringify(env.responses);
    for (const secret of secrets) assert.equal(text.includes(secret), false);
    assert.equal(text.includes(`${FRONTEND}/requirements/`), false);
    assert.equal(text.includes(`${FRONTEND}/clarifications/`), false);
  });
});
