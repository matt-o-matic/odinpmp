import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createOdinMcpServer } from '../src/mcp/server.js';

// The approval, custom-field, revision, story-split and template tools against a fake Odin REST
// API: the requests they send, what they return, and the messages they give for refusals. The
// flow over HTTP with OAuth is in mcp-workflow-e2e.test.js; the routes' rules in workflows-api.test.js.

const TOOLS = ['odin_list_approvals', 'odin_request_approval', 'odin_decide_approval', 'odin_get_custom_fields', 'odin_set_custom_field', 'odin_restore_item_revision', 'odin_split_story', 'odin_list_project_templates'];
const PERMISSIONS = { canEditPlan: true, canManage: false, canManageMembers: false, projectRole: 'contributor', workspaceRole: 'manager' };
const tasks = Array.from({ length: 11 }, (_, index) => ({ id: `task-${index + 1}`, name: `Task ${index + 1}`, points: 1, status: 'Backlog', version: 1 }));
const PROJECT = {
  id: 'project-1', name: 'Launch', status: 'In Progress',
  epics: [{ id: 'epic-1', name: 'Delivery', status: 'Backlog', version: 2, stories: [
    { id: 'story-1', name: 'Checkout', points: 11, status: 'Review', version: 3, tasks },
    { id: 'story-2', name: 'Receipts', status: 'Backlog', version: 1, tasks: [] },
  ] }],
  tickets: [{ id: 'ticket-1', name: 'Hidden external report', status: 'new', version: 1 }],
};
const WORKFLOW = {
  id: 'wf-1', name: 'Story delivery', itemTypes: ['story'], status: 'active',
  states: [{ initial: true, key: 'Backlog', label: 'Backlog' }, { key: 'Review', label: 'In review' }, { key: 'Done', label: 'Done', terminal: true }],
  transitions: [
    { allowedRoles: [], approvalRequired: false, approverRoles: [], fromState: 'Backlog', key: 'submit', requiredFields: [], toState: 'Review' },
    { allowedRoles: [], approvalRequired: true, approverRoles: ['manager'], fromState: 'Review', key: 'ship', requiredFields: [], toState: 'Done' },
  ],
};
const approval = (overrides = {}) => ({
  createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, decidedBy: null, decisionNote: '', expiresAt: null, fromState: 'Review', id: 'approval-1', itemId: 'story-1', itemType: 'story',
  note: 'Ready to ship', projectId: 'project-1', requestedBy: 'user-ann', status: 'pending', tenantId: 'tenant-1', toState: 'Done', transitionKey: 'ship', version: 1, ...overrides,
});
const FIELDS = [
  { fieldType: 'enum', id: 'field-risk', name: 'Risk', options: ['Low', 'High'], required: false, scope: 'story', status: 'active', tenantId: 'tenant-1', version: 1 },
  { fieldType: 'string', id: 'field-evidence', name: 'Acceptance evidence', options: [], scope: 'story', status: 'active', tenantId: 'tenant-1', version: 1 },
  { fieldType: 'number', id: 'field-cost', name: 'Cost center', options: [], scope: 'project', status: 'active', tenantId: 'tenant-1', version: 1 },
  { fieldType: 'string', id: 'field-old', name: 'Old', options: [], scope: 'story', status: 'inactive', tenantId: 'tenant-1', version: 2 },
  { fieldType: 'string', id: 'field-ticket', name: 'Customer', options: [], scope: 'ticket', status: 'active', tenantId: 'tenant-1', version: 1 },
];
const VALUES = [
  { fieldId: 'field-risk', id: 'value-1', itemId: 'story-1', itemType: 'story', projectId: 'project-1', tenantId: 'tenant-1', value: 'Low', version: 4 },
  { fieldId: 'field-old', id: 'value-2', itemId: 'story-2', itemType: 'story', projectId: 'project-1', tenantId: 'tenant-1', value: 'legacy', version: 1 },
  { fieldId: 'field-ticket', id: 'value-3', itemId: 'ticket-1', itemType: 'ticket', projectId: 'project-1', tenantId: 'tenant-1', value: 'Acme', version: 1 },
];

// A fake Odin. `routes` answers by "METHOD path" first; reads fall back to the fixture above.
function fakeOdin({ approvals = [approval()], permissions = PERMISSIONS, routes = {} } = {}) {
  return (method, path, options = {}) => {
    const handler = routes[`${method} ${path}`];
    if (handler) return typeof handler === 'function' ? handler(options) : handler;
    if (method === 'GET' && path === '/api/projects/project-1') return { ok: true, permissions, project: PROJECT };
    if (method === 'GET' && path === '/api/projects/project-1/valid-users') return { project_users: [{ email: 'ann@x.example', id: 'user-ann', name: 'Ann Analyst' }], tenant_users: [] };
    if (method === 'GET' && path === '/api/workflows') {
      return { approvals, baselines: [], bindings: [{ id: 'binding-1', itemType: 'story', projectId: 'project-1', workflowId: 'wf-1' }], customFields: FIELDS, customValues: VALUES, histories: [], limit: options.query.limit, offset: options.query.offset, templates: [], total: 1, workflows: [WORKFLOW] };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
}

async function session(t, respond) {
  const calls = [];
  const server = createOdinMcpServer({ api: { request: async (...args) => { calls.push(args); return respond(...args); } } });
  const client = new Client({ name: 'odin-mcp-workflow-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
    return { data: result.structuredContent, isError: result.isError === true };
  };
  const writes = () => calls.filter(([method]) => method !== 'GET');
  return { call, calls, client, writes };
}

test('MCP clients and the assistant both get the tools; reads are read-only and deciding asks first', async (t) => {
  const { client } = await session(t, fakeOdin());
  const listed = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry.annotations]));
  for (const name of TOOLS) assert.ok(listed.has(name), name);
  for (const name of ['odin_list_approvals', 'odin_get_custom_fields', 'odin_list_project_templates']) assert.equal(listed.get(name).readOnlyHint, true, name);
  assert.deepEqual(['odin_request_approval', 'odin_decide_approval', 'odin_set_custom_field', 'odin_restore_item_revision', 'odin_split_story'].map((name) => [listed.get(name).readOnlyHint, listed.get(name).destructiveHint]),
    [[false, false], [false, true], [false, true], [false, true], [false, true]]);
  const assistant = new Map(createOdinToolCatalog({ api: null, extended: true }).map((entry) => [entry.name, entry]));
  for (const name of TOOLS) assert.ok(assistant.get(name)?.purpose, name);
  // Deciding always asks; setting a field asks only when it clears one, and a split only when its
  // description mentions someone.
  assert.deepEqual(TOOLS.filter((name) => assistant.get(name).confirm), ['odin_decide_approval', 'odin_set_custom_field', 'odin_split_story']);
  assert.equal(assistant.get('odin_split_story').confirm({ input: { description: 'Card fraud rules.' } }), false);
  assert.equal(assistant.get('odin_set_custom_field').confirm({ value: 'Acme' }), false);
});

test('requesting an approval reads the item\'s status and workflow and sends the whole request', async (t) => {
  const { call, writes } = await session(t, fakeOdin({ approvals: [], routes: { 'POST /api/workflows/approvals': ({ body }) => ({ ok: true, value: approval({ ...body, requestedBy: 'user-me' }) }) } }));
  const { data, isError } = await call('odin_request_approval', { itemId: 'story-1', note: 'Ready to ship', projectId: 'project-1', toState: 'done' });
  assert.equal(isError, false, JSON.stringify(data));
  assert.deepEqual(writes(), [['POST', '/api/workflows/approvals', { body: {
    expiresAt: null, fromState: 'Review', itemId: 'story-1', itemType: 'story', note: 'Ready to ship', projectId: 'project-1', toState: 'Done', transitionKey: 'ship',
  } }]]);
  assert.deepEqual([data.approval.status, data.approval.toLabel, data.approval.approverRoles, data.approval.tenantId], ['pending', 'Done', ['manager'], undefined]);
});

test('requesting an approval explains moves that need none, are not allowed or are already asked for', async (t) => {
  for (const [args, approvals, code, pattern] of [
    [{ itemId: 'epic-1', toState: 'Done' }, [], 'no_workflow', /No workflow governs epic/],
    [{ itemId: 'story-2', toState: 'Done' }, [], 'transition_not_allowed', /allows: Review/],
    [{ itemId: 'story-2', toState: 'In review' }, [], 'approval_not_required', /needs no approval/],
    [{ itemId: 'story-1', toState: 'Done' }, [approval()], 'already_requested', /already waiting/],
    [{ itemId: 'story-1', toState: 'Done' }, [approval({ status: 'approved' })], 'already_requested', /already approved/],
    [{ itemId: 'ticket-1', toState: 'Done' }, [], 'item_not_found', /No epic, story or task/],
  ]) {
    const { call, writes } = await session(t, fakeOdin({ approvals }));
    const { data, isError } = await call('odin_request_approval', { projectId: 'project-1', ...args });
    assert.equal(isError, true);
    assert.equal(data.error.code, code, JSON.stringify(data));
    assert.match(data.error.message, pattern);
    assert.deepEqual(writes(), []);
  }
  const { call } = await session(t, fakeOdin({ approvals: [], routes: { 'POST /api/workflows/approvals': () => { throw new OdinApiError(403, 'http_403', 'upstream'); } } }));
  const refused = await call('odin_request_approval', { itemId: 'story-1', projectId: 'project-1', toState: 'Done' });
  assert.deepEqual([refused.data.error.code, /allowedRoles/.test(refused.data.error.message)], ['role_denied', true]);
});

test('listing approvals names the item, the requester and whether the user\'s role may decide', async (t) => {
  const approvals = [
    approval(), approval({ id: 'approval-2', status: 'approved', decidedBy: 'user-ann', decidedAt: '2026-10-02T00:00:00.000Z' }),
    approval({ id: 'approval-3', itemId: 'ticket-1', itemType: 'ticket' }), approval({ id: 'approval-4', projectId: 'project-2' }),
  ];
  const { call, writes } = await session(t, fakeOdin({ approvals }));
  const { data } = await call('odin_list_approvals', { projectId: 'project-1' });
  assert.deepEqual(data.approvals.map((entry) => entry.id), ['approval-1']);
  assert.deepEqual(pickKeys(data.approvals[0], ['itemName', 'requestedBy', 'fromLabel', 'toLabel', 'approverRoles', 'yourRoleMayDecide']),
    { approverRoles: ['manager'], fromLabel: 'In review', itemName: 'Checkout', requestedBy: 'Ann Analyst', toLabel: 'Done', yourRoleMayDecide: true });
  assert.equal(data.approvals[0].tenantId, undefined);
  const all = await call('odin_list_approvals', { projectId: 'project-1', status: 'all' });
  assert.deepEqual(all.data.approvals.map((entry) => entry.id), ['approval-1', 'approval-2']);
  assert.equal(all.data.approvals[1].decidedBy, 'Ann Analyst');
  assert.deepEqual(writes(), []);

  const viewer = await session(t, fakeOdin({ permissions: { ...PERMISSIONS, canEditPlan: false } }));
  assert.equal((await viewer.call('odin_list_approvals', { projectId: 'project-1' })).data.approvals[0].yourRoleMayDecide, false);
});

test('deciding an approval reads its version when omitted and names the project', async (t) => {
  const decided = ({ body }) => ({ ok: true, value: approval({ decidedBy: 'user-me', decisionNote: body.decisionNote, status: body.status, version: 2 }) });
  const routes = { 'POST /api/workflows/approvals/approval-1/decision': decided };
  const { call, calls, writes } = await session(t, fakeOdin({ approvals: [approval({ version: 3 })], routes }));
  const { data } = await call('odin_decide_approval', { approvalId: 'approval-1', decision: 'approved', note: 'Looks good', projectId: 'project-1' });
  assert.deepEqual(writes(), [['POST', '/api/workflows/approvals/approval-1/decision', { body: { decisionNote: 'Looks good', expectedVersion: 3, projectId: 'project-1', status: 'approved' } }]]);
  assert.equal(data.approval.status, 'approved');
  assert.match(data.next, /from Review to Done, once/);

  calls.length = 0;
  await call('odin_decide_approval', { approvalId: 'approval-1', decision: 'rejected', expectedVersion: 7, projectId: 'project-1' });
  assert.deepEqual(writes().map(([method, path]) => `${method} ${path}`), ['POST /api/workflows/approvals/approval-1/decision']);
  assert.equal(writes()[0][2].body.expectedVersion, 7);

  const before = calls.length;
  const preview = await call('odin_decide_approval', { approvalId: 'approval-1', decision: 'approved', dryRun: true, projectId: 'project-1' });
  assert.equal(preview.data.dryRun, true);
  assert.equal(calls.length, before);
});

test('an approval on a ticket cannot be decided, even with its version', async (t) => {
  const { call, writes } = await session(t, fakeOdin({ approvals: [approval({ itemId: 'ticket-1', itemType: 'ticket', version: 3 })] }));
  for (const args of [{}, { expectedVersion: 3 }]) {
    const { data } = await call('odin_decide_approval', { approvalId: 'approval-1', decision: 'approved', projectId: 'project-1', ...args });
    assert.equal(data.error.code, 'approval_not_found');
  }
  assert.deepEqual(writes(), []);
});

test('deciding an approval explains who may decide and what is already decided', async (t) => {
  for (const [approvals, status, code, pattern] of [
    [[approval({ status: 'approved' })], null, 'already_decided', /already approved/],
    [[approval({ projectId: 'project-2' })], null, 'approval_not_found', /odin_list_approvals/],
    [[approval()], 403, 'not_an_approver', /you asked for it/],
    [[approval()], 404, 'approval_not_found', /decided already/],
    [[approval()], 409, 'http_409', /Read it again/],
  ]) {
    const routes = { 'POST /api/workflows/approvals/approval-1/decision': () => { throw new OdinApiError(status, `http_${status}`, 'upstream'); } };
    const { call } = await session(t, fakeOdin({ approvals, routes }));
    const { data, isError } = await call('odin_decide_approval', { approvalId: 'approval-1', decision: 'approved', projectId: 'project-1' });
    assert.equal(isError, true);
    assert.equal(data.error.code, code, JSON.stringify(data));
    assert.match(data.error.message, pattern);
  }
});

test('reading custom fields lists the item type\'s fields and the values set, without tickets', async (t) => {
  const { call } = await session(t, fakeOdin());
  const project = (await call('odin_get_custom_fields', { projectId: 'project-1' })).data;
  assert.deepEqual(project.fields.map((field) => field.name), ['Risk', 'Acceptance evidence', 'Cost center']);
  assert.deepEqual(project.values.map((value) => [value.itemName, value.field, value.value, value.fieldInactive ?? false]), [['Checkout', 'Risk', 'Low', false], ['Receipts', 'Old', 'legacy', true]]);
  assert.equal(project.fields[0].tenantId, undefined);
  const story = (await call('odin_get_custom_fields', { itemId: 'story-1', projectId: 'project-1' })).data;
  assert.deepEqual([story.fields.map((field) => field.appliesTo), story.values.length, story.values[0].version], [['story', 'story'], 1, 4]);
  const root = (await call('odin_get_custom_fields', { itemId: 'project-1', projectId: 'project-1' })).data;
  assert.deepEqual(root.fields.map((field) => field.name), ['Cost center']);
  assert.equal((await call('odin_get_custom_fields', { itemId: 'ticket-1', projectId: 'project-1' })).data.error.code, 'item_not_found');
});

test('setting a custom field finds it by name, checks the value and sends the current version', async (t) => {
  const saved = ({ body }) => ({ ok: true, value: { ...body, id: 'value-new', tenantId: 'tenant-1', version: (body.expectedVersion ?? 0) + 1 } });
  const routes = { 'PUT /api/workflows/custom-values': saved, 'DELETE /api/workflows/custom-values/value-1': { ok: true } };
  const { call, writes } = await session(t, fakeOdin({ permissions: { ...PERMISSIONS, canManage: true }, routes }));
  const changed = await call('odin_set_custom_field', { field: 'risk', itemId: 'story-1', projectId: 'project-1', value: 'High' });
  assert.deepEqual([changed.data.changed, changed.data.value, changed.data.version], [true, 'High', 5]);
  const created = await call('odin_set_custom_field', { field: 'Cost center', itemId: 'project-1', projectId: 'project-1', value: 4200 });
  assert.deepEqual([created.data.itemType, created.data.version], ['project', 1]);
  const cleared = await call('odin_set_custom_field', { field: 'field-risk', itemId: 'story-1', projectId: 'project-1', value: null });
  assert.equal(cleared.data.changed, true);
  const unchanged = await call('odin_set_custom_field', { field: 'Risk', itemId: 'story-1', projectId: 'project-1', value: 'Low' });
  const nothingToClear = await call('odin_set_custom_field', { field: 'Acceptance evidence', itemId: 'story-1', projectId: 'project-1', value: null });
  assert.deepEqual([unchanged.data.changed, nothingToClear.data.changed], [false, false]);
  assert.deepEqual(writes(), [
    ['PUT', '/api/workflows/custom-values', { body: { expectedVersion: 4, fieldId: 'field-risk', itemId: 'story-1', itemType: 'story', projectId: 'project-1', value: 'High' } }],
    ['PUT', '/api/workflows/custom-values', { body: { expectedVersion: null, fieldId: 'field-cost', itemId: 'project-1', itemType: 'project', projectId: 'project-1', value: 4200 } }],
    ['DELETE', '/api/workflows/custom-values/value-1', { body: { expectedVersion: 4, projectId: 'project-1' } }],
  ]);

  // The project's own fields are a project setting: editors below manager change only their items'.
  const editor = await session(t, fakeOdin({ routes }));
  const refused = await editor.call('odin_set_custom_field', { field: 'Cost center', itemId: 'project-1', projectId: 'project-1', value: 4200 });
  assert.deepEqual([refused.data.error.code, /role on this project is contributor/.test(refused.data.error.message)], ['needs_project_manager', true]);
  assert.equal((await editor.call('odin_set_custom_field', { field: 'Risk', itemId: 'story-1', projectId: 'project-1', value: 'High' })).isError, false);
  assert.deepEqual(editor.writes().map(([method, path]) => `${method} ${path}`), ['PUT /api/workflows/custom-values']);
});

test('setting a custom field refuses unknown fields and wrong values before writing', async (t) => {
  const { call, writes } = await session(t, fakeOdin({ permissions: { ...PERMISSIONS, canManage: true }, routes: { 'PUT /api/workflows/custom-values': () => { throw new OdinApiError(409, 'http_409', 'upstream'); } } }));
  for (const [args, code, pattern] of [
    [{ field: 'Owner', itemId: 'story-1', value: 'x' }, 'field_not_found', /story fields: Risk, Acceptance evidence/],
    [{ field: 'Old', itemId: 'story-1', value: 'x' }, 'field_not_found', /No active story custom field/],
    [{ field: 'Risk', itemId: 'epic-1', value: 'Low' }, 'field_not_found', /No custom fields apply to epic/],
    [{ field: 'Risk', itemId: 'story-1', value: 'Medium' }, 'invalid_value', /Options: Low, High/],
    [{ field: 'Cost center', itemId: 'project-1', value: '12' }, 'invalid_value', /must be a number/],
  ]) {
    const { data, isError } = await call('odin_set_custom_field', { projectId: 'project-1', ...args });
    assert.equal(isError, true);
    assert.equal(data.error.code, code, JSON.stringify(data));
    assert.match(data.error.message, pattern);
  }
  assert.deepEqual(writes(), []);
  const conflict = await call('odin_set_custom_field', { field: 'Risk', itemId: 'story-1', projectId: 'project-1', value: 'High' });
  assert.equal(conflict.data.error.code, 'version_conflict');
});

test('restoring a revision reads the item\'s version, or a deleted item\'s from its delete revision', async (t) => {
  const revisions = {
    'story-1': [{ action: 'update', id: 'rev-2', itemType: 'story', versionAfter: 3 }, { action: 'create', id: 'rev-1', itemType: 'story', versionAfter: 1 }],
    'task-gone': [{ action: 'delete', id: 'rev-9', itemType: 'task', versionAfter: 5 }, { action: 'create', id: 'rev-8', itemType: 'task', versionAfter: 1 }],
    'ticket-1': [{ action: 'update', id: 'rev-t', itemType: 'ticket', versionAfter: 2 }],
  };
  const routes = {};
  for (const [itemId, list] of Object.entries(revisions)) {
    routes[`GET /api/projects/project-1/items/${itemId}/revisions`] = { itemId, revisions: list };
    routes[`POST /api/projects/project-1/items/${itemId}/restore`] = ({ body }) => ({
      item: { id: itemId, name: 'Restored', status: 'Backlog', tasks: [], tenantId: 'tenant-1', version: body.expectedVersion + 1 }, ok: true, project: PROJECT,
      revision: { action: 'restore', id: 'rev-new', itemId, tenantId: 'tenant-1', versionAfter: body.expectedVersion + 1, versionBefore: body.expectedVersion },
    });
  }
  const { call, writes } = await session(t, fakeOdin({ routes }));
  const reverted = await call('odin_restore_item_revision', { itemId: 'story-1', projectId: 'project-1', revisionId: 'rev-1' });
  assert.deepEqual([reverted.data.undeleted, reverted.data.item.version, reverted.data.item.tasks, reverted.data.revision.tenantId], [false, 4, undefined, undefined]);
  const undeleted = await call('odin_restore_item_revision', { itemId: 'task-gone', projectId: 'project-1', revisionId: 'rev-9' });
  assert.deepEqual([undeleted.data.undeleted, undeleted.data.item.itemType], [true, 'task']);
  assert.deepEqual(writes().map(([, path, { body }]) => [path, body]), [
    ['/api/projects/project-1/items/story-1/restore', { expectedVersion: 3, revisionId: 'rev-1', state: 'after' }],
    ['/api/projects/project-1/items/task-gone/restore', { expectedVersion: 5, revisionId: 'rev-9', state: 'after' }],
  ]);
  for (const [args, code] of [
    [{ itemId: 'story-1', revisionId: 'rev-404' }, 'revision_not_found'],
    [{ itemId: 'ticket-1', revisionId: 'rev-t' }, 'unsupported_item'],
  ]) {
    assert.equal((await call('odin_restore_item_revision', { projectId: 'project-1', ...args })).data.error.code, code);
  }
  assert.equal(writes().length, 2);
});

test('a refused restore says what Odin checks', async (t) => {
  const routes = {
    'GET /api/projects/project-1/items/story-1/revisions': { revisions: [{ action: 'update', id: 'rev-2', itemType: 'story', versionAfter: 3 }] },
    'POST /api/projects/project-1/items/story-1/restore': () => { throw new OdinApiError(409, 'http_409', 'upstream'); },
  };
  const { call } = await session(t, fakeOdin({ routes }));
  const { data } = await call('odin_restore_item_revision', { itemId: 'story-1', projectId: 'project-1', revisionId: 'rev-2' });
  assert.match(data.error.message, /workflow does not allow the status/);
});

test('splitting a story checks its tasks, keeps to the item limit and returns both stories', async (t) => {
  const split = ({ body }) => {
    const moved = tasks.filter((task) => body.taskIds.includes(task.id));
    const story = { id: 'story-new', name: body.name, points: moved.length, status: body.status, tasks: moved, tenantId: 'tenant-1', version: 1 };
    const original = { ...PROJECT.epics[0].stories[0], points: 11 - moved.length, tasks: tasks.filter((task) => !body.taskIds.includes(task.id)) };
    return { ok: true, project: { ...PROJECT, epics: [{ ...PROJECT.epics[0], stories: [original, story, PROJECT.epics[0].stories[1]] }] }, story };
  };
  const routes = { 'POST /api/projects/project-1/stories/story-1/split': split };
  const { call, writes } = await session(t, fakeOdin({ permissions: { ...PERMISSIONS, canManage: false }, routes }));
  const { data } = await call('odin_split_story', { input: { name: 'Checkout, part 2', taskIds: ['task-2', 'task-3'] }, projectId: 'project-1', storyId: 'story-1' });
  assert.deepEqual([data.story.id, data.story.taskIds, data.story.tenantId, data.original.points, data.original.taskIds.length], ['story-new', ['task-2', 'task-3'], undefined, 9, 9]);
  assert.deepEqual(writes()[0][2].body.taskIds, ['task-2', 'task-3']);
  assert.equal(writes()[0][2].body.status, 'Backlog', 'the story workflow\'s starting status');

  for (const [args, code] of [
    [{ storyId: 'story-1', input: { name: 'Other', status: 'Review', taskIds: ['task-1'] } }, 'workflow_initial_state_required'],
    [{ storyId: 'story-1', input: { name: 'Other', taskIds: ['task-1', 'task-99'] } }, 'tasks_not_in_story'],
    [{ storyId: 'epic-1', input: { name: 'Other', taskIds: ['task-1'] } }, 'story_not_found'],
    [{ storyId: 'story-1', input: { name: 'Most of it', taskIds: tasks.slice(0, 10).map((task) => task.id) } }, 'needs_project_manager'],
    [{ storyId: 'story-1', input: { name: 'Other', taskIds: ['task-1'], sourceTopic: 'x' } }, 'validation_error'],
  ]) {
    const { data: refused } = await call('odin_split_story', { projectId: 'project-1', ...args });
    assert.equal(refused.error.code, code, JSON.stringify(refused));
  }
  assert.equal(writes().length, 1);

  const unbound = await session(t, (method, path, options) => (method === 'GET' && path === '/api/workflows'
    ? { approvals: [], bindings: [], customFields: [], customValues: [], total: 0, workflows: [] }
    : fakeOdin({ routes })(method, path, options)));
  await unbound.call('odin_split_story', { input: { name: 'Part 2', taskIds: ['task-1'] }, projectId: 'project-1', storyId: 'story-1' });
  assert.equal(unbound.writes()[0][2].body.status, 'Not Started');
});

test('listing templates asks Odin for active ones of a kind and summarizes their contents', async (t) => {
  const templates = [
    { description: 'Our delivery setup', id: 'tpl-1', kind: 'project', name: 'Delivery', payloadIssues: [], payloadStatus: 'valid', status: 'active', tenantId: 'tenant-1', payload: {
      customFields: [{ fieldType: 'string', name: 'Evidence', scope: 'story' }],
      outline: { epics: [{ name: 'Discovery', stories: [{ name: 'Interviews', tasks: [{ name: 'Book' }, { name: 'Run' }] }] }, { name: 'Build', stories: [] }] },
      workflowBindings: [{ itemType: 'story', sourceId: 'wf-1', sourceKind: 'workflow_definition' }],
    } },
    { description: '', id: 'tpl-2', kind: 'project', name: 'Legacy', payload: { anything: true }, payloadIssues: ['Add a workflow binding, a starter outline, or a custom field.'], payloadStatus: 'needs_update', status: 'active' },
  ];
  const { call, calls } = await session(t, fakeOdin({ routes: { 'GET /api/workflows/templates': { templates } } }));
  const { data } = await call('odin_list_project_templates', {});
  assert.deepEqual(calls, [['GET', '/api/workflows/templates', { query: { kind: 'project', status: 'active' } }]]);
  assert.deepEqual(data.templates[0], {
    contents: { customFields: ['Evidence (story)'], outline: { epicNames: ['Discovery', 'Build'], epics: 2, stories: 1, tasks: 2 }, workflowsFor: ['story'] },
    description: 'Our delivery setup', id: 'tpl-1', name: 'Delivery', usable: true,
  });
  assert.deepEqual([data.templates[1].usable, data.templates[1].issues.length], [false, 1]);
  await call('odin_list_project_templates', { includeInactive: true, kind: 'work_item' });
  assert.deepEqual(calls[1][2], { query: { kind: 'work_item', status: undefined } });
});

function pickKeys(record, keys) {
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}
