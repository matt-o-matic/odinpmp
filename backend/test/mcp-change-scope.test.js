import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ITEM_LIMIT, withChangeScope } from '../src/mcp/change-scope.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createOdinMcpServer } from '../src/mcp/server.js';
import { projectStanding } from '../src/lib/auth/project-standing.js';

const tasks = Array.from({ length: 12 }, (_, index) => ({ id: `task-${index + 1}`, name: `Task ${index + 1}`, status: 'Not Started', version: 1 }));
const project = { id: 'project-1', name: 'Shop', updatedAt: '2026-10-01T00:00:00.000Z', epics: [{ id: 'epic-1', name: 'Checkout', version: 1, stories: [{ id: 'story-1', name: 'Pay by card', version: 1, tasks }] }] };
const STANDINGS = {
  admin: projectStanding({ projectRole: 'admin', tenantRole: 'user' }),
  contributor: projectStanding({ projectRole: 'contributor', tenantRole: 'user' }),
  user: projectStanding({ projectRole: 'user', tenantRole: 'user' }),
};

// A fake Odin: the project read carries the caller's permissions; writes succeed.
function fakeOdin(role) {
  const requests = [];
  return {
    requests,
    writes: () => requests.filter(([method]) => method !== 'GET'),
    async request(method, path, options = {}) {
      requests.push([method, path, options.body]);
      if (method === 'GET' && path === '/api/projects/project-1') return { ok: true, permissions: STANDINGS[role], project };
      if (method === 'GET') return { ok: true, sprints: [], project_users: [], tenant_users: [], people: [], milestones: [] };
      return { ok: true, item: { id: path.split('/').pop(), name: 'Saved', version: 2 }, project };
    },
  };
}

const rejection = (message) => ({ code: 'needs_project_manager', message, status: 403 });

test('project standing: admins and managers make project-wide changes, editors only plan edits', () => {
  assert.deepEqual(projectStanding({ projectRole: 'admin', tenantRole: 'user' }), { canEditPlan: true, canManage: true, canManageMembers: true, projectRole: 'admin', workspaceRole: 'user' });
  assert.deepEqual(projectStanding({ projectRole: 'Manager', tenantRole: 'user' }), { canEditPlan: true, canManage: true, canManageMembers: false, projectRole: 'manager', workspaceRole: 'user' });
  assert.deepEqual(projectStanding({ projectRole: 'contributor', tenantRole: 'user' }), { canEditPlan: true, canManage: false, canManageMembers: false, projectRole: 'contributor', workspaceRole: 'user' });
  assert.deepEqual(projectStanding({ projectRole: 'user', tenantRole: 'user' }), { canEditPlan: false, canManage: false, canManageMembers: false, projectRole: 'user', workspaceRole: 'user' });
  assert.deepEqual(projectStanding({ projectRole: null, tenantRole: 'admin' }), { canEditPlan: true, canManage: true, canManageMembers: true, projectRole: null, workspaceRole: 'admin' });
  assert.equal(projectStanding({ projectRole: null, tenantRole: 'manager' }).canManage, true);
});

test('an editor below manager cannot change project-wide settings, and nothing is sent', async () => {
  const odin = fakeOdin('contributor');
  const api = withChangeScope(odin);
  for (const [method, path, what] of [
    ['PUT', '/api/projects/project-1', 'the project\'s settings and dates'],
    ['PATCH', '/api/projects/project-1/assistant-brief', 'the project\'s brief'],
    ['POST', '/api/projects/project-1/sprints', 'sprints'],
    ['POST', '/api/projects/project-1/sprints/sprint-1/activate', 'sprints'],
    ['PUT', '/api/projects/project-1/kanban/config', 'the board setup'],
    ['POST', '/api/projects/project-1/governance/milestones', 'milestones, dependencies, the working calendar or schedule baselines'],
    ['PATCH', '/api/projects/project-1/governance/dependencies/dep-1', 'milestones, dependencies, the working calendar or schedule baselines'],
  ]) {
    await assert.rejects(api.request(method, path, { body: {} }), rejection(`Only a project admin or manager can change ${what}. Your role on this project is contributor. A project admin or manager can make this change.`));
  }
  assert.deepEqual(odin.writes(), []);
  assert.equal(odin.requests.length, 1, 'the role is read once');
  // A risk or a comment is not project-wide.
  await api.request('POST', '/api/projects/project-1/governance/items', { body: {} });
  await api.request('POST', '/api/projects/project-1/comments', { body: {} });
  assert.equal(odin.writes().length, 2);
});

test('restoring a revision, reviewing a ticket and splitting a story count toward the work item limit', async () => {
  const odin = fakeOdin('contributor');
  const api = withChangeScope(odin);
  for (let index = 0; index < ITEM_LIMIT - 2; index += 1) await api.request('PATCH', `/api/projects/project-1/items/task-${index + 1}`, { body: {} });
  await api.request('POST', '/api/projects/project-1/items/task-9/restore', { body: {} });
  await api.request('POST', '/api/projects/project-1/items/ticket-1/review', { body: {} });
  await assert.rejects(api.request('POST', '/api/projects/project-1/stories/story-1/split', { body: {} }), rejection(`Only a project admin or manager can change more than ${ITEM_LIMIT} work items at once (${ITEM_LIMIT} changed already). Your role on this project is contributor. A project admin or manager can make this change.`));
  assert.equal(odin.writes().length, ITEM_LIMIT);
});

test(`an editor below manager can change up to ${ITEM_LIMIT} work items; bulk tools are refused whole`, async () => {
  const odin = fakeOdin('contributor');
  const catalog = new Map(createOdinToolCatalog({ api: odin, extended: true }).map((entry) => [entry.name, entry]));
  const update = (ids) => catalog.get('odin_update_items').handler(catalog.get('odin_update_items').schema.parse({ projectId: 'project-1', updates: ids.map((itemId) => ({ itemId, patch: { status: 'In Progress' } })) }));

  await assert.rejects(update(tasks.map((task) => task.id).slice(0, ITEM_LIMIT + 1)), rejection(`Only a project admin or manager can change more than ${ITEM_LIMIT} work items at once. Your role on this project is contributor. A project admin or manager can make this change.`));
  assert.deepEqual(odin.writes(), [], 'refused before its first write');

  assert.equal((await update(tasks.map((task) => task.id).slice(0, 8))).ok, true);
  await assert.rejects(update(['task-9', 'task-10', 'task-11']), rejection(`Only a project admin or manager can change more than ${ITEM_LIMIT} work items at once (8 changed already). Your role on this project is contributor. A project admin or manager can make this change.`));
  // Single-item tools count too.
  const single = catalog.get('odin_update_item');
  for (const itemId of ['task-9', 'task-10']) {
    await single.handler(single.schema.parse({ projectId: 'project-1', itemId, input: { expectedVersion: 1, patch: { status: 'In Progress' } } }));
  }
  await assert.rejects(single.handler(single.schema.parse({ projectId: 'project-1', itemId: 'task-11', input: { expectedVersion: 1, patch: { status: 'In Progress' } } })), { code: 'needs_project_manager' });
  assert.equal(odin.writes().length, ITEM_LIMIT);
});

test('a batch of checked changes counts the items it changed, and is refused whole past the limit', async () => {
  const odin = fakeOdin('contributor');
  const read = odin.request;
  // Odin's batch route: the first change in each batch is listed as given, the rest applied.
  const outcomes = [];
  odin.request = async (method, path, options = {}) => {
    if (!path.endsWith('/item-changes')) return read(method, path, options);
    odin.requests.push([method, path, options.body]);
    return { ok: false, results: options.body.changes.map((change, index) => ({ itemId: change.itemId, ...(outcomes[index] ?? { status: 'applied' }) })) };
  };
  const tool = createOdinToolCatalog({ api: odin, extended: true }).find((entry) => entry.name === 'odin_apply_item_changes');
  const apply = (ids) => tool.handler(tool.schema.parse({
    projectId: 'project-1',
    changes: ids.map((itemId) => ({ expected: { version: 1 }, idempotencyKey: `key-${itemId}-0001`, itemId, patch: { status: 'In Progress' }, reason: 'Done in the repo.' })),
  }));
  const batches = () => odin.writes().filter(([, path]) => path.endsWith('/item-changes')).length;

  // A stale change wrote nothing, and a replay wrote nothing new: 5 + 4 + 1 items changed.
  outcomes.splice(0, 1, { status: 'stale' });
  await apply(['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6']);
  outcomes.splice(0, 1, { replayed: true, status: 'applied' });
  await apply(['task-7', 'task-8', 'task-9', 'task-10', 'task-11']);
  outcomes.length = 0;
  await apply(['task-12']);
  assert.equal(batches(), 3);

  await assert.rejects(apply(['task-1']), rejection(`Only a project admin or manager can change more than ${ITEM_LIMIT} work items at once (${ITEM_LIMIT} changed already). Your role on this project is contributor. A project admin or manager can make this change.`));
  assert.equal(batches(), 3, 'refused before it was sent');
});

test('a batch is refused before it is sent when earlier writes leave too little room, and a lost reply counts in full', async () => {
  const odin = fakeOdin('contributor');
  const api = withChangeScope(odin);
  for (let index = 0; index < 4; index += 1) await api.request('PATCH', `/api/projects/project-1/items/task-${index + 1}`, { body: {} });
  const body = { changes: ['task-5', 'task-6', 'task-7', 'task-8', 'task-9', 'task-10', 'task-11'].map((itemId) => ({ itemId })) };
  await assert.rejects(api.request('POST', '/api/projects/project-1/item-changes', { body }), rejection(`Only a project admin or manager can change more than ${ITEM_LIMIT} work items at once (4 changed already). Your role on this project is contributor. A project admin or manager can make this change.`));
  assert.equal(odin.writes().length, 4);
  // A batch whose reply was lost counts in full.
  odin.request = async (method, path) => {
    if (method === 'GET') return { ok: true, permissions: STANDINGS.contributor, project };
    throw Object.assign(new Error('Lost'), { outcomeUnknown: true });
  };
  await assert.rejects(api.request('POST', '/api/projects/project-1/item-changes', { body: { changes: body.changes.slice(0, 6) } }), /Lost/);
  await assert.rejects(api.request('PATCH', '/api/projects/project-1/items/task-12', { body: {} }), { code: 'needs_project_manager' });
});

test('admins and managers are not limited, and people who cannot edit the plan are left to Odin', async () => {
  const admin = fakeOdin('admin');
  const asAdmin = withChangeScope(admin);
  await asAdmin.request('PUT', '/api/projects/project-1', { body: {} });
  for (const task of tasks) await asAdmin.request('PATCH', `/api/projects/project-1/items/${task.id}`, { body: {} });
  assert.equal(admin.writes().length, tasks.length + 1);

  const user = fakeOdin('user');
  await withChangeScope(user).request('PUT', '/api/projects/project-1', { body: {} });
  assert.equal(user.writes().length, 1, 'Odin refuses it with its usual 404');
});

test('a long-lived MCP server counts each tool call on its own and reads roles again', async (t) => {
  const odin = fakeOdin('contributor');
  const server = createOdinMcpServer({ api: odin });
  const client = new Client({ name: 'change-scope-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const itemId of tasks.map((task) => task.id)) {
    const result = await client.callTool({ name: 'odin_update_item', arguments: { projectId: 'project-1', itemId, input: { expectedVersion: 1, patch: { status: 'In Progress' } } } });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  }
  assert.equal(odin.writes().length, tasks.length);
  const refused = await client.callTool({ name: 'odin_update_project', arguments: { projectId: 'project-1', input: { name: 'Renamed', status: 'Active', expectedUpdatedAt: project.updatedAt } } });
  assert.equal(refused.structuredContent.error.code, 'needs_project_manager');
  const got = await client.callTool({ name: 'odin_get_project', arguments: { projectId: 'project-1' } });
  assert.deepEqual(got.structuredContent.permissions, STANDINGS.contributor);
});
