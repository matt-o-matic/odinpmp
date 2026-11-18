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
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

// Approvals, custom fields, revisions, story splits and templates for OAuth MCP clients: the tools
// call the real Odin routes on an in-process app over loopback HTTP, with in-memory repositories.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-pilot';
const OTHER_PROJECT_ID = 'project-other';
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', tenantRole: 'admin' },
  lead: { id: 'user-lead', name: 'Lee Lead', tenantRole: 'manager' },
  editor: { id: 'user-editor', name: 'Eve Editor', tenantRole: 'user' },
};
const task = (id, name) => ({ id, name, points: 2, status: 'Not Started' });
const STORY_WORKFLOW = {
  itemTypes: ['story'], name: 'Story sign-off',
  states: [{ initial: true, key: 'Backlog', label: 'Backlog' }, { key: 'Review', label: 'In review' }, { category: 'done', key: 'Done', label: 'Done', terminal: true }],
  transitions: [
    { fromState: 'Backlog', key: 'submit', toState: 'Review' },
    { approvalRequired: true, approverRoles: ['manager'], fromState: 'Review', key: 'ship', toState: 'Done' },
  ],
};

async function fixture(t) {
  const users = Object.values(USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: users.map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT_ID]: [{ id: USERS.editor.id, role: 'contributor' }], [OTHER_PROJECT_ID]: [{ id: USERS.editor.id, role: 'contributor' }] },
    projects: [
      { id: PROJECT_ID, name: 'Pilot', status: 'In Progress', tenantId: TENANT_ID, epics: [{ id: 'epic-1', name: 'Checkout', status: 'Not Started', stories: [
        { id: 'story-1', name: 'Pay by card', status: 'Review', tasks: [task('task-1', 'Card form'), task('task-2', 'Receipts')] },
        { id: 'story-2', name: 'Pay later', status: 'Review', tasks: [task('task-3', 'Provider'), task('task-4', 'Reminders')] },
      ] }] },
      { epics: [], id: OTHER_PROJECT_ID, name: 'Other', status: 'In Progress', tenantId: TENANT_ID },
    ],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-workflow-fixture', secret: 'disposable-workflow-fixture-secret' });
  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, projectRepository, sessionsRepository, tokenService, workflowRepository: createInMemoryWorkflowRepository(),
    backendPublicUrl: origin, frontendAppUrl: 'https://frontend-fixture.example/app', mcpOAuthRepository: createInMemoryMcpOAuthRepository(), mcpPublicUrl: resource,
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

  async function send(path, { body, contentType, method = 'GET', token } = {}) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : contentType === 'form' ? new URLSearchParams(body) : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      method, signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { body: json, status: response.status };
  }
  async function asPerson(role, method, path, body) {
    const response = await send(path, { body, method, token: sessions[role] });
    assert.ok(response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }

  async function connect(role, projectIds = []) {
    const registered = await asPerson('admin', 'POST', '/api/mcp/clients', { name: 'Disposable dot', projectIds, redirectUris: ['http://127.0.0.1:54321/callback'], scopes: ['projects.read', 'projects.write'] });
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.redirect_uris[0], resource, response_type: 'code', scope: registered.scope, state: 'fixture-state' };
    const approved = await asPerson(role, 'POST', '/api/mcp/oauth/authorize', { ...params, approved: true });
    const code = new URL(approved.redirectTo).searchParams.get('code');
    const tokens = await send('/api/mcp/oauth/token', { body: { client_id: registered.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST' });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const client = new Client({ name: `${role}-workflow-fixture`, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    async function call(name, args) {
      const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 30_000 });
      return { data: result.structuredContent, isError: result.isError === true };
    }
    return {
      async ok(name, args) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, false, `${name}: ${JSON.stringify(data)}`);
        return data;
      },
      async fails(name, args, code) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, true, `${name}: ${JSON.stringify(data)}`);
        assert.equal(data.error.code, code, `${name}: ${JSON.stringify(data)}`);
        return data.error;
      },
    };
  }
  return { asPerson, connect };
}

test('OAuth MCP clients request and decide approvals, set custom fields, restore revisions, split stories and find templates', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const workflow = await env.asPerson('lead', 'POST', '/api/workflows/definitions', STORY_WORKFLOW);
  await env.asPerson('lead', 'POST', '/api/workflows/bindings', { itemType: 'story', projectId: PROJECT_ID, workflowId: workflow.value.id });
  await env.asPerson('lead', 'POST', '/api/workflows/custom-fields', { fieldType: 'enum', name: 'Risk', options: ['Low', 'High'], scope: 'story' });
  await env.asPerson('lead', 'POST', '/api/workflows/templates', { kind: 'project', name: 'Delivery', payload: { outline: { epics: [{ name: 'Discovery', stories: [{ name: 'Interviews' }] }] } } });
  const editor = await env.connect('editor');
  const lead = await env.connect('lead');
  const item = async (itemId) => (await editor.ok('odin_get_item', { itemId, projectId: PROJECT_ID })).item;

  // Shipping story-1 needs a manager's sign-off. The editor asks; they cannot approve their own request.
  await editor.fails('odin_update_item', { input: { expectedVersion: (await item('story-1')).version, patch: { status: 'Done' } }, itemId: 'story-1', projectId: PROJECT_ID }, 'http_409');
  const requested = await editor.ok('odin_request_approval', { itemId: 'story-1', note: 'Card payments pass QA', projectId: PROJECT_ID, toState: 'done' });
  assert.deepEqual([requested.approval.status, requested.approval.transitionKey, requested.approval.approverRoles], ['pending', 'ship', ['manager']]);
  await editor.fails('odin_request_approval', { itemId: 'story-1', projectId: PROJECT_ID, toState: 'Done' }, 'already_requested');
  await editor.fails('odin_decide_approval', { approvalId: requested.approval.id, decision: 'approved', projectId: PROJECT_ID }, 'not_an_approver');
  const pending = await lead.ok('odin_list_approvals', { projectId: PROJECT_ID });
  assert.deepEqual(pending.approvals.map((entry) => [entry.itemName, entry.requestedBy, entry.yourRoleMayDecide]), [['Pay by card', 'Eve Editor', true]]);
  const decided = await lead.ok('odin_decide_approval', { approvalId: requested.approval.id, decision: 'approved', note: 'Ship it', projectId: PROJECT_ID });
  assert.equal(decided.approval.status, 'approved');
  await lead.fails('odin_decide_approval', { approvalId: requested.approval.id, decision: 'rejected', projectId: PROJECT_ID }, 'already_decided');
  await editor.ok('odin_update_item', { input: { expectedVersion: (await item('story-1')).version, patch: { status: 'Done' } }, itemId: 'story-1', projectId: PROJECT_ID });
  assert.equal((await item('story-1')).status, 'Done');
  assert.deepEqual((await lead.ok('odin_list_approvals', { projectId: PROJECT_ID, status: 'all' })).approvals.map((entry) => entry.status), ['consumed']);

  // A grant limited to the other project reaches neither this project's approvals nor its templates.
  const second = await editor.ok('odin_request_approval', { itemId: 'story-2', projectId: PROJECT_ID, toState: 'Done' });
  const limited = await env.connect('lead', [OTHER_PROJECT_ID]);
  await limited.fails('odin_list_approvals', { projectId: PROJECT_ID }, 'http_404');
  await limited.fails('odin_decide_approval', { approvalId: second.approval.id, decision: 'approved', projectId: PROJECT_ID }, 'http_404');
  await limited.fails('odin_decide_approval', { approvalId: second.approval.id, decision: 'approved', expectedVersion: 1, projectId: OTHER_PROJECT_ID }, 'approval_not_found');
  await limited.fails('odin_list_project_templates', {}, 'http_404');
  assert.equal((await lead.ok('odin_list_approvals', { projectId: PROJECT_ID })).approvals[0].status, 'pending');
  await lead.ok('odin_decide_approval', { approvalId: second.approval.id, decision: 'rejected', projectId: PROJECT_ID });

  // Custom fields: set by name, read back, refuse a value outside the options, clear.
  await editor.ok('odin_set_custom_field', { field: 'risk', itemId: 'story-2', projectId: PROJECT_ID, value: 'Low' });
  const raised = await editor.ok('odin_set_custom_field', { field: 'Risk', itemId: 'story-2', projectId: PROJECT_ID, value: 'High' });
  assert.deepEqual([raised.changed, raised.version], [true, 2]);
  await editor.fails('odin_set_custom_field', { field: 'Risk', itemId: 'story-2', projectId: PROJECT_ID, value: 'Severe' }, 'invalid_value');
  const fields = await editor.ok('odin_get_custom_fields', { itemId: 'story-2', projectId: PROJECT_ID });
  assert.deepEqual([fields.fields.map((field) => field.name), fields.values.map((value) => [value.field, value.value])], [['Risk'], [['Risk', 'High']]]);
  await editor.ok('odin_set_custom_field', { field: 'Risk', itemId: 'story-2', projectId: PROJECT_ID, value: null });
  assert.deepEqual((await editor.ok('odin_get_custom_fields', { projectId: PROJECT_ID })).values, []);

  // Revisions: undo a rename, then bring back a deleted task.
  const renamed = await item('task-1');
  await editor.ok('odin_update_item', { input: { expectedVersion: renamed.version, patch: { name: 'Card form v2' } }, itemId: 'task-1', projectId: PROJECT_ID });
  const [rename] = (await env.asPerson('editor', 'GET', `/api/projects/${PROJECT_ID}/items/task-1/revisions`)).revisions;
  const reverted = await editor.ok('odin_restore_item_revision', { itemId: 'task-1', projectId: PROJECT_ID, revisionId: rename.id, state: 'before' });
  assert.deepEqual([reverted.undeleted, reverted.item.name, (await item('task-1')).name], [false, 'Card form', 'Card form']);
  await editor.ok('odin_delete_item', { expectedVersion: (await item('task-2')).version, itemId: 'task-2', projectId: PROJECT_ID });
  await editor.fails('odin_get_item', { itemId: 'task-2', projectId: PROJECT_ID }, 'item_not_found');
  const [deletion] = (await env.asPerson('editor', 'GET', `/api/projects/${PROJECT_ID}/items/task-2/revisions`)).revisions;
  assert.equal(deletion.action, 'delete');
  const undeleted = await editor.ok('odin_restore_item_revision', { itemId: 'task-2', projectId: PROJECT_ID, revisionId: deletion.id });
  assert.deepEqual([undeleted.undeleted, (await item('task-2')).name], [true, 'Receipts']);

  // Splitting story-2 starts the new story in the workflow's starting status.
  await editor.fails('odin_split_story', { input: { name: 'Pay later reminders', status: 'Review', taskIds: ['task-4'] }, projectId: PROJECT_ID, storyId: 'story-2' }, 'workflow_initial_state_required');
  const split = await editor.ok('odin_split_story', { input: { name: 'Pay later reminders', taskIds: ['task-4'] }, projectId: PROJECT_ID, storyId: 'story-2' });
  assert.deepEqual([split.story.status, split.story.taskIds, split.story.points, split.original.taskIds, split.original.points], ['Backlog', ['task-4'], 2, ['task-3'], 2]);
  assert.equal((await item(split.story.id)).parentId, 'epic-1');

  // Templates, for odin_create_project's templateId.
  const templates = await editor.ok('odin_list_project_templates', {});
  assert.deepEqual(templates.templates.map((template) => [template.name, template.usable, template.contents.outline.stories]), [['Delivery', true, 1]]);
});
