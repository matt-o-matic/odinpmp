import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { matchWorkItems } from '../src/mcp/resource-tools.js';
import { createOdinMcpServer } from '../src/mcp/server.js';

// The resource tools against a fake Odin REST API: the requests they send, what they return, and
// the messages they give for Odin's refusals. The flows over HTTP with OAuth are in
// mcp-resource-e2e.test.js and mcp-collaboration-e2e.test.js; the routes' own rules are in
// resource-finance-project-routes.test.js and resource-finance-api.test.js.

const PATH = '/api/resource-planning/projects/project-1/resources';
const PROJECT = '/api/projects/project-1';
const TIME = '/api/resource-planning/projects/project-1/time-entries';
const ALLOCATIONS = '/api/resource-planning/projects/project-1/allocations';
const NEW_TOOLS = [
  'odin_add_project_allocation', 'odin_update_project_allocation', 'odin_remove_project_allocation', 'odin_move_allocation_hours',
  'odin_log_time', 'odin_list_time_entries', 'odin_update_time_entry', 'odin_delete_time_entry',
  'odin_list_time_off', 'odin_add_time_off', 'odin_delete_time_off', 'odin_get_sprint_capacity', 'odin_set_sprint_capacity',
];
const TREE = { epics: [{ id: 'epic-accounts', name: 'Accounts', stories: [{ id: 'story-login', name: 'Login page', tasks: [{ id: 'task-form', name: 'Build the login form' }] }, { id: 'story-signup', name: 'Signup page', tasks: [] }] }] };

async function session(t, respond) {
  const calls = [];
  const server = createOdinMcpServer({ api: { request: async (...args) => { calls.push(args); return respond(...args); } } });
  const client = new Client({ name: 'odin-mcp-resource-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
    return { data: result.structuredContent, isError: result.isError === true };
  };
  return { call, calls, client };
}

// A fake Odin that answers `${method} ${path}` from a table and refuses anything else.
function routes(table) {
  return (method, path, options) => {
    const answer = table[`${method} ${path}`];
    if (answer === undefined) throw new Error(`Unexpected ${method} ${path}`);
    return typeof answer === 'function' ? answer(options) : structuredClone(answer);
  };
}
const refuse = (status) => () => { throw new OdinApiError(status, `http_${status}`, 'upstream'); };

test('the tool is a write, sends the person and allocation, and returns only what a client needs', async (t) => {
  const { call, calls, client } = await session(t, () => ({
    added: true, assigneeId: 'resource:res-1', created: true, ok: true,
    allocation: { allocationPercent: 50, billRate: null, endDate: '2027-06-30', hoursPerWeek: 20, id: 'alloc-1', origin: 'manual', projectId: 'project-1', resourceId: 'res-1', role: 'QA', scenario: 'baseline', startDate: '2027-01-01', status: 'active', tenantId: 'tenant-1', version: 1 },
    resource: { billRate: 95, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', id: 'res-1', location: '', minBillRate: null, name: 'Casey Contractor', poolId: null, roles: ['QA engineer'], skills: [], status: 'active', tenantId: 'tenant-1', userId: null, version: 1 },
  }));
  const definition = (await client.listTools()).tools.find(({ name }) => name === 'odin_add_project_resource');
  assert.equal(definition.annotations.readOnlyHint, false);
  assert.equal(definition.annotations.destructiveHint, false);

  const { data, isError } = await call('odin_add_project_resource', { input: { allocation: { hoursPerWeek: 20, role: 'QA' }, billRate: 95, name: ' Casey Contractor ', roles: ['QA engineer'] }, projectId: 'project-1' });
  assert.equal(isError, false);
  assert.deepEqual(calls, [['POST', PATH, { body: {
    allocation: { billRate: null, hoursPerWeek: 20, role: 'QA', status: 'active' },
    billRate: 95, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', name: 'Casey Contractor', roles: ['QA engineer'], skills: [],
  } }]]);
  assert.deepEqual([data.added, data.created, data.assigneeId], [true, true, 'resource:res-1']);
  assert.equal(data.resource.tenantId, undefined);
  assert.equal(data.resource.userId, null);
  assert.deepEqual(Object.keys(data.allocation).sort(), ['allocationPercent', 'billRate', 'endDate', 'hoursPerWeek', 'id', 'projectId', 'resourceId', 'role', 'startDate', 'status', 'version']);
});

test('a profile without a login takes an email, changes it later, and gets task access and its link by email only', async (t) => {
  const TASK_ACCESS = '/api/resource-planning/projects/project-1/task-access';
  const entry = { email: 'casey@vendor.example', link: null, name: 'Casey Contractor', resourceId: 'res-1', scope: 'own' };
  const { call, calls, client } = await session(t, routes({
    [`POST ${PATH}`]: { added: true, assigneeId: 'resource:res-1', created: true, ok: true, allocation: { id: 'alloc-1' }, resource: { email: 'casey@vendor.example', id: 'res-1', name: 'Casey Contractor', userId: null, version: 1 } },
    [`PATCH ${PATH}/res-1`]: { ok: true, resource: { email: 'casey@new.example', id: 'res-1', name: 'Casey C.', tenantId: 'tenant-1', userId: null, version: 2 } },
    [`GET ${TASK_ACCESS}`]: { entries: [{ ...entry, scope: 'off' }], ok: true },
    [`PUT ${TASK_ACCESS}/res-1`]: { entry, ok: true },
    [`POST ${TASK_ACCESS}/res-1/link`]: { emailed: true, ok: true },
  }));

  const added = await call('odin_add_project_resource', { input: { email: 'Casey@Vendor.example', name: 'Casey Contractor' }, projectId: 'project-1' });
  assert.equal(calls[0][2].body.email, 'casey@vendor.example');
  assert.equal(added.data.resource.email, 'casey@vendor.example');
  const changed = await call('odin_update_project_resource', { input: { email: 'casey@new.example', expectedVersion: 1, name: 'Casey C.' }, projectId: 'project-1', resourceId: 'res-1' });
  assert.deepEqual(calls[1], ['PATCH', `${PATH}/res-1`, { body: { email: 'casey@new.example', expectedVersion: 1, name: 'Casey C.' } }]);
  assert.deepEqual([changed.data.resource.email, changed.data.resource.version, changed.data.resource.tenantId], ['casey@new.example', 2, undefined]);
  for (const input of [{ expectedVersion: 1 }, { expectedVersion: 1, userId: 'user-1' }, { email: 'not an email', expectedVersion: 1 }]) {
    assert.equal((await call('odin_update_project_resource', { input, projectId: 'project-1', resourceId: 'res-1' })).isError, true, JSON.stringify(input));
  }

  assert.deepEqual((await call('odin_get_task_access', { projectId: 'project-1' })).data.people, [{ ...entry, scope: 'off' }]);
  const set = await call('odin_set_task_access', { projectId: 'project-1', resourceId: 'res-1', scope: 'own' });
  assert.deepEqual([calls.at(-1), set.data.person.scope], [['PUT', `${TASK_ACCESS}/res-1`, { body: { scope: 'own' } }], 'own']);
  const sent = await call('odin_send_task_access_link', { projectId: 'project-1', resourceId: 'res-1' });
  assert.deepEqual([calls.at(-1), sent.data], [['POST', `${TASK_ACCESS}/res-1/link`, { body: { delivery: 'email' } }], { emailed: true, ok: true }]);

  // Reading access is read-only; sending the link emails someone, so the assistant asks first.
  const listed = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(['odin_get_task_access', 'odin_set_task_access', 'odin_send_task_access_link', 'odin_update_project_resource'].map((name) => listed.get(name)?.annotations.readOnlyHint), [true, false, false, false]);
  const confirms = new Map(createOdinToolCatalog({ api: null, extended: true }).map((tool) => [tool.name, tool.confirm]));
  assert.deepEqual([confirms.get('odin_send_task_access_link'), confirms.get('odin_set_task_access')], [true, false]);
});

test('a dry run sends nothing, and a login or unknown field is refused before Odin is called', async (t) => {
  const { call, calls } = await session(t, () => { throw new Error('Must not call Odin.'); });
  const preview = await call('odin_add_project_resource', { dryRun: true, input: { name: 'Pia Placeholder' }, projectId: 'project-1' });
  assert.deepEqual([preview.isError, preview.data.dryRun, preview.data.request.method, preview.data.request.path], [false, true, 'POST', PATH]);
  for (const input of [{ name: 'Pia', userId: 'user-1' }, { allocation: { hours: 10 }, name: 'Pia' }, { name: '' }]) {
    const refused = await call('odin_add_project_resource', { input, projectId: 'project-1' });
    assert.equal(refused.isError, true, JSON.stringify(input));
    assert.equal(refused.data.error.code, 'validation_error');
  }
  assert.equal(calls.length, 0);
});

test('Odin\'s refusals come back as messages that say what to do next', async (t) => {
  for (const [status, code, pattern] of [
    [409, 'has_login', /odin_add_project_allocation/],
    [404, 'http_404', /workspace admin or manager/],
    [400, 'http_400', /minimum bill rate/],
  ]) {
    const { call } = await session(t, refuse(status));
    const { data, isError } = await call('odin_add_project_resource', { input: { name: 'Pia Placeholder' }, projectId: 'project-1' });
    assert.equal(isError, true);
    assert.equal(data.error.code, code);
    assert.match(data.error.message, pattern);
  }
});

test('MCP clients and the assistant both get the tools; reads are read-only, and deletes ask the user first', async (t) => {
  const { client } = await session(t, () => ({}));
  const listed = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));
  const reads = new Set(['odin_list_time_entries', 'odin_list_time_off', 'odin_get_sprint_capacity']);
  const confirms = new Set(['odin_remove_project_allocation', 'odin_delete_time_entry', 'odin_delete_time_off']);
  const destructive = new Set(['odin_update_project_allocation', 'odin_remove_project_allocation', 'odin_move_allocation_hours', 'odin_update_time_entry', 'odin_delete_time_entry', 'odin_delete_time_off', 'odin_set_sprint_capacity']);
  const assistant = new Map(createOdinToolCatalog({ api: null, extended: true }).map((entry) => [entry.name, entry]));
  for (const name of NEW_TOOLS) {
    const definition = listed.get(name);
    assert.ok(definition, name);
    assert.equal(definition.annotations.readOnlyHint, reads.has(name), name);
    assert.equal(definition.annotations.destructiveHint, destructive.has(name), name);
    assert.equal(assistant.get(name).confirm, confirms.has(name), name);
    assert.match(assistant.get(name).purpose ?? '', /\w{4}/, name);
  }
});

test('work items are found by id, by name, or by the words of a name and the type it mentions', () => {
  const items = [
    { id: 'story-login', itemType: 'story', name: 'Login page' },
    { id: 'task-form', itemType: 'task', name: 'Build the login form' },
    { id: 'story-signup', itemType: 'story', name: 'Signup page' },
  ];
  const ids = (text) => matchWorkItems(items, text).map((item) => item.id);
  assert.deepEqual(ids('task-form'), ['task-form']);
  assert.deepEqual(ids('login page'), ['story-login']);
  assert.deepEqual(ids('the login story'), ['story-login']);
  assert.deepEqual(ids('login task'), ['task-form']);
  assert.deepEqual(ids('login'), ['story-login', 'task-form']);
  assert.deepEqual(ids('page'), ['story-login', 'story-signup']);
  assert.deepEqual(ids('checkout'), []);
});

test('logging time finds the work item on the project and sends one entry; Odin\'s refusals say what to do next', async (t) => {
  const logged = { id: 'time-1', version: 1, tenantId: 'tenant-1', workDate: '2026-10-28', hours: 3, billable: false, status: 'submitted', note: '', projectId: 'project-1', resourceId: 'res-me', workItemId: 'story-login', periodId: 'period-1', createdAt: 'x' };
  const { call, calls } = await session(t, routes({ [`GET ${PROJECT}`]: { project: TREE }, [`POST ${TIME}`]: { ok: true, value: logged } }));
  const { data, isError } = await call('odin_log_time', { hours: 3, projectId: 'project-1', workItem: 'the login story' });
  assert.equal(isError, false, JSON.stringify(data));
  assert.deepEqual(calls.at(-1), ['POST', TIME, { body: { billable: false, hours: 3, note: '', workItemId: 'story-login' } }]);
  assert.deepEqual([data.entry.workItemName, data.entry.periodId, data.entry.tenantId, data.entry.createdAt], ['Login page', 'period-1', undefined, undefined]);

  // Without a work item there is nothing to look up; someone else's time and a date pass through.
  calls.length = 0;
  await call('odin_log_time', { billable: true, hours: 1.5, note: 'Pairing', projectId: 'project-1', resourceId: 'res-casey', workDate: '2026-10-27' });
  assert.deepEqual(calls, [['POST', TIME, { body: { billable: true, hours: 1.5, note: 'Pairing', resourceId: 'res-casey', workDate: '2026-10-27', workItemId: null } }]]);

  const ambiguous = await call('odin_log_time', { hours: 1, projectId: 'project-1', workItem: 'page' });
  assert.equal(ambiguous.data.error.code, 'work_item_ambiguous');
  assert.deepEqual(ambiguous.data.error.details.matches.map((item) => item.id), ['story-login', 'story-signup']);
  assert.equal((await call('odin_log_time', { hours: 1, projectId: 'project-1', workItem: 'checkout' })).data.error.code, 'work_item_not_found');

  calls.length = 0;
  const preview = await call('odin_log_time', { dryRun: true, hours: 2, projectId: 'project-1', workItem: 'login' });
  assert.deepEqual([preview.data.dryRun, preview.data.request.path, preview.data.request.workItem, calls.length], [true, TIME, 'login', 0]);
  for (const args of [{ hours: 0, projectId: 'project-1' }, { hours: 25, projectId: 'project-1' }, { hours: 1, projectId: 'project-1', workDate: '28/10/2026' }, { hours: 1, projectId: 'project-1', status: 'approved' }]) {
    assert.equal((await call('odin_log_time', args)).data.error.code, 'validation_error', JSON.stringify(args));
  }

  for (const [status, code, pattern] of [
    [422, 'no_resource_profile', /odin_add_project_allocation/],
    [423, 'period_locked', /locked or closed/],
    [404, 'http_404', /only their own time/],
    [400, 'http_400', /at most 24/],
  ]) {
    const refused = await session(t, refuse(status));
    const { data: error } = await refused.call('odin_log_time', { hours: 1, projectId: 'project-1' });
    assert.equal(error.error.code, code);
    assert.match(error.error.message, pattern);
  }
});

test('time lists pass their filters to Odin and return compact entries with versions', async (t) => {
  const { call, calls } = await session(t, () => ({
    ok: true, myResourceId: 'res-me', total: 1, totals: { approvedHours: 0, billableHours: 0, hours: 3, rejectedHours: 0, submittedHours: 3 },
    entries: [{ id: 'time-1', version: 2, tenantId: 'tenant-1', workDate: '2026-10-28', hours: 3, status: 'submitted', projectId: 'project-1', projectName: 'Launch', resourceId: 'res-me', resourceName: 'Mona', workItemId: 'story-login', workItemName: 'Login page' }],
  }));
  const { data } = await call('odin_list_time_entries', { from: '2026-10-01', mine: true, projectId: 'project-1', to: '2026-10-31' });
  assert.deepEqual(calls, [['GET', '/api/resource-planning/time-entries', { query: { from: '2026-10-01', limit: 100, mine: 'true', projectId: 'project-1', resourceId: undefined, to: '2026-10-31' } }]]);
  assert.deepEqual([data.total, data.myResourceId, data.totals.hours, data.entries[0].version, data.entries[0].tenantId], [1, 'res-me', 3, 2, undefined]);
  await call('odin_list_time_entries', {});
  assert.deepEqual(calls[1][2].query, { from: undefined, limit: 100, mine: undefined, projectId: undefined, resourceId: undefined, to: undefined });

  const limited = await session(t, refuse(404));
  assert.match((await limited.call('odin_list_time_entries', {})).data.error.message, /limited to certain projects must pass/);
});

test('changing time resolves a new work item, clears one with null, and deleting asks for the version', async (t) => {
  const entry = { id: 'time-1', version: 3, hours: 2, workItemId: 'task-form', projectId: 'project-1' };
  const { call, calls } = await session(t, routes({
    [`GET ${PROJECT}`]: { project: TREE },
    [`PATCH ${TIME}/time-1`]: ({ body }) => ({ ok: true, value: { ...entry, ...body } }),
    [`DELETE ${TIME}/time-1`]: { ok: true },
  }));
  const moved = await call('odin_update_time_entry', { input: { expectedVersion: 2, hours: 2, workItem: 'login task' }, projectId: 'project-1', timeEntryId: 'time-1' });
  assert.deepEqual(calls.at(-1), ['PATCH', `${TIME}/time-1`, { body: { expectedVersion: 2, hours: 2, workItemId: 'task-form' } }]);
  assert.equal(moved.data.entry.workItemName, 'Build the login form');
  calls.length = 0;
  await call('odin_update_time_entry', { input: { expectedVersion: 3, workItem: null }, projectId: 'project-1', timeEntryId: 'time-1' });
  await call('odin_update_time_entry', { input: { expectedVersion: 4, status: 'approved' }, projectId: 'project-1', timeEntryId: 'time-1' });
  assert.deepEqual(calls.filter(([method]) => method !== 'GET').map(([method, , options]) => [method, options.body]), [['PATCH', { expectedVersion: 3, workItemId: null }], ['PATCH', { expectedVersion: 4, status: 'approved' }]]);
  assert.equal((await call('odin_update_time_entry', { input: { expectedVersion: 4 }, projectId: 'project-1', timeEntryId: 'time-1' })).data.error.code, 'validation_error');

  const deleted = await call('odin_delete_time_entry', { expectedVersion: 5, projectId: 'project-1', timeEntryId: 'time-1' });
  assert.deepEqual([deleted.data.deleted, calls.at(-1)], [true, ['DELETE', `${TIME}/time-1`, { body: { expectedVersion: 5 } }]]);

  // Time a person logged against a ticket from outside that nobody has validated doesn't name it.
  const hidden = await session(t, routes({
    [`GET ${PROJECT}`]: { project: TREE },
    [`PATCH ${TIME}/time-2`]: ({ body }) => ({ ok: true, value: { hours: 1, id: 'time-2', note: body.note, projectId: 'project-1', version: 2, workItemId: 'ticket-hidden' } }),
  }));
  const noted = await hidden.call('odin_update_time_entry', { input: { expectedVersion: 1, note: 'Reproduced it' }, projectId: 'project-1', timeEntryId: 'time-2' });
  assert.equal(noted.data.entry.workItemId, null);
  assert.doesNotMatch(JSON.stringify(noted.data), /ticket-hidden/);

  const stale = await session(t, refuse(409));
  assert.equal((await stale.call('odin_update_time_entry', { input: { expectedVersion: 1, hours: 1 }, projectId: 'project-1', timeEntryId: 'time-1' })).data.error.code, 'version_conflict');
  const denied = await session(t, refuse(404));
  assert.match((await denied.call('odin_delete_time_entry', { expectedVersion: 1, projectId: 'project-1', timeEntryId: 'time-1' })).data.error.message, /delete only their own time while it is still submitted/);
});

test('allocation tools add, change, move and remove through the project\'s routes', async (t) => {
  const allocation = { id: 'alloc-1', version: 1, tenantId: 'tenant-1', projectId: 'project-1', resourceId: 'res-1', hoursPerWeek: 20, allocationPercent: 50, role: 'QA', startDate: '2026-11-01', endDate: '2027-01-31', status: 'active', billRate: null, origin: 'manual', scenario: 'baseline' };
  const { call, calls } = await session(t, routes({
    [`POST ${ALLOCATIONS}`]: { ok: true, added: true, created: true, assigneeId: 'user-sam', allocation, resource: { id: 'res-1', name: 'Sam', userId: 'user-sam', tenantId: 'tenant-1', minBillRate: 80 } },
    [`PATCH ${ALLOCATIONS}/alloc-1`]: ({ body }) => ({ ok: true, value: { ...allocation, ...body, version: 2 } }),
    [`POST ${ALLOCATIONS}/alloc-1/level`]: { ok: true, value: { movedHours: 5, sourceAllocation: { ...allocation, hoursPerWeek: 15 }, targetAllocation: { ...allocation, id: 'alloc-2', resourceId: 'res-2', hoursPerWeek: 5 } } },
    [`DELETE ${ALLOCATIONS}/alloc-1`]: { ok: true },
  }));
  const added = await call('odin_add_project_allocation', { input: { hoursPerWeek: 20, role: 'QA', userId: 'user-sam' }, projectId: 'project-1' });
  assert.deepEqual(calls.at(-1), ['POST', ALLOCATIONS, { body: { billRate: null, hoursPerWeek: 20, role: 'QA', status: 'active', userId: 'user-sam' } }]);
  assert.deepEqual([added.data.created, added.data.assigneeId, added.data.allocation.tenantId, added.data.allocation.origin, added.data.resource.minBillRate], [true, 'user-sam', undefined, undefined, undefined]);
  for (const input of [{ resourceId: 'res-1', userId: 'user-sam' }, {}, { resourceId: 'res-1', scenario: 'optimistic' }, { hoursPerWeek: 200, resourceId: 'res-1' }]) {
    assert.equal((await call('odin_add_project_allocation', { input, projectId: 'project-1' })).data.error.code, 'validation_error', JSON.stringify(input));
  }

  const changed = await call('odin_update_project_allocation', { allocationId: 'alloc-1', input: { endDate: '2026-12-31', expectedVersion: 1, status: 'completed' }, projectId: 'project-1' });
  assert.deepEqual([changed.data.allocation.endDate, changed.data.allocation.status, changed.data.allocation.version], ['2026-12-31', 'completed', 2]);
  assert.equal((await call('odin_update_project_allocation', { allocationId: 'alloc-1', input: { expectedVersion: 1 }, projectId: 'project-1' })).data.error.code, 'validation_error');
  assert.equal((await call('odin_update_project_allocation', { allocationId: 'alloc-1', input: { expectedVersion: 1, projectId: 'project-2' }, projectId: 'project-1' })).data.error.code, 'validation_error');

  const moved = await call('odin_move_allocation_hours', { allocationId: 'alloc-1', expectedVersion: 2, hours: 5, projectId: 'project-1', targetResourceId: 'res-2' });
  assert.deepEqual(calls.at(-1), ['POST', `${ALLOCATIONS}/alloc-1/level`, { body: { expectedVersion: 2, hours: 5, targetResourceId: 'res-2' } }]);
  assert.deepEqual([moved.data.movedHours, moved.data.from.hoursPerWeek, moved.data.to.resourceId], [5, 15, 'res-2']);

  const removed = await call('odin_remove_project_allocation', { allocationId: 'alloc-1', expectedVersion: 3, projectId: 'project-1' });
  assert.deepEqual([removed.data.deleted, calls.at(-1)], [true, ['DELETE', `${ALLOCATIONS}/alloc-1`, { body: { expectedVersion: 3 } }]]);

  for (const [status, code, pattern] of [[400, 'http_400', /minimum bill rate/], [404, 'http_404', /workspace admin or manager role and plan-edit/], [409, 'version_conflict', /odin_get_project_team/]]) {
    const refused = await session(t, refuse(status));
    const { data } = await refused.call('odin_update_project_allocation', { allocationId: 'alloc-1', input: { billRate: 10, expectedVersion: 1 }, projectId: 'project-1' });
    assert.equal(data.error.code, code);
    assert.match(data.error.message, pattern);
  }
});

test('time off is listed, added with a full day off by default, and deleted by version', async (t) => {
  const entry = { id: 'cal-1', version: 1, tenantId: 'tenant-1', resourceId: 'res-1', resourceName: 'Sam', entryType: 'leave', startDate: '2026-12-21', endDate: '2026-12-24', hoursPerDay: 8, weekdays: [1, 2, 3, 4, 5], timezone: 'UTC', status: 'approved', note: '' };
  const { call, calls } = await session(t, routes({
    'GET /api/resource-planning/calendar-entries': { ok: true, entries: [entry], myResourceId: null, total: 1 },
    'POST /api/resource-planning/calendar-entries': ({ body }) => ({ ok: true, value: { ...entry, ...body } }),
    'DELETE /api/resource-planning/calendar-entries/cal-1': { ok: true },
  }));
  const listed = await call('odin_list_time_off', { from: '2026-12-01', resourceId: 'res-1' });
  assert.deepEqual(calls.at(-1)[2].query, { from: '2026-12-01', limit: 100, mine: undefined, resourceId: 'res-1', to: undefined });
  assert.deepEqual([listed.data.total, listed.data.entries[0].resourceName, listed.data.entries[0].tenantId], [1, 'Sam', undefined]);

  await call('odin_add_time_off', { input: { endDate: '2026-12-24', entryType: 'leave', resourceId: 'res-1', startDate: '2026-12-21' } });
  assert.deepEqual(calls.at(-1)[2].body, { endDate: '2026-12-24', entryType: 'leave', hoursPerDay: 8, note: '', resourceId: 'res-1', startDate: '2026-12-21', status: 'approved', timezone: 'UTC', weekdays: [1, 2, 3, 4, 5] });
  await call('odin_add_time_off', { input: { endDate: '2026-12-31', entryType: 'working_override', hoursPerDay: 4, resourceId: 'res-1', startDate: '2026-12-01', weekdays: [5] } });
  assert.deepEqual([calls.at(-1)[2].body.hoursPerDay, calls.at(-1)[2].body.weekdays], [4, [5]]);
  for (const input of [
    { endDate: '2026-12-31', entryType: 'working_override', resourceId: 'res-1', startDate: '2026-12-01' },
    { endDate: '2026-12-01', entryType: 'leave', resourceId: 'res-1', startDate: '2026-12-31' },
    { endDate: '2026-12-31', entryType: 'sabbatical', resourceId: 'res-1', startDate: '2026-12-01' },
  ]) {
    assert.equal((await call('odin_add_time_off', { input })).data.error.code, 'validation_error', JSON.stringify(input));
  }
  const deleted = await call('odin_delete_time_off', { calendarEntryId: 'cal-1', expectedVersion: 1 });
  assert.deepEqual([deleted.data.deleted, calls.at(-1)], [true, ['DELETE', '/api/resource-planning/calendar-entries/cal-1', { body: { expectedVersion: 1 } }]]);

  const refused = await session(t, refuse(404));
  assert.match((await refused.call('odin_list_time_off', {})).data.error.message, /belongs to a person rather than a project/);
});

test('sprint capacity reads the sprints and saves one sprint\'s whole list with only the requested changes', async (t) => {
  const sprints = {
    members: [{ id: 'user-ann', name: 'Ann' }, { id: 'user-bo', name: 'Bo' }, { id: 'user-cy', name: 'Cy' }],
    sprints: [
      { id: 'sprint-1', name: 'Sprint 1', status: 'completed', staffing: [], summary: { capacityHours: 0 } },
      { id: 'sprint-2', name: 'Sprint 2', status: 'active', startDate: '2026-10-20', endDate: '2026-11-02', items: [{ id: 'story-login' }],
        staffing: [{ userId: 'user-ann', capacityHours: 10, allocationPctOverride: null, notes: 'Part time', sprintId: 'sprint-2' }, { userId: 'user-bo', capacityHours: 20, allocationPctOverride: 50, notes: '', sprintId: 'sprint-2' }],
        summary: { capacityHours: 30, totalHours: 42, totalItems: 6, totalPoints: 13 } },
      { id: 'sprint-3', name: 'Sprint 3', status: 'planned', staffing: [], summary: { capacityHours: 0, totalHours: 0, totalItems: 0, totalPoints: 0 } },
    ],
  };
  const permissions = { canEditPlan: true, canManage: true };
  const { call, calls } = await session(t, routes({
    [`GET ${PROJECT}/sprints`]: sprints,
    [`GET ${PROJECT}`]: () => ({ permissions, project: {} }),
    [`PUT ${PROJECT}/sprints/sprint-2/staffing`]: ({ body }) => ({ ok: true, sprint: {}, staffing: body.staffing }),
  }));
  const read = await call('odin_get_sprint_capacity', { projectId: 'project-1' });
  assert.deepEqual(read.data.sprints.map((sprint) => sprint.id), ['sprint-2', 'sprint-3']);
  assert.deepEqual(read.data.sprints[0], {
    id: 'sprint-2', name: 'Sprint 2', status: 'active', startDate: '2026-10-20', endDate: '2026-11-02', capacityHours: 30, plannedHours: 42, plannedPoints: 13, plannedItems: 6,
    staffing: [{ userId: 'user-ann', name: 'Ann', capacityHours: 10, allocationPctOverride: null, notes: 'Part time' }, { userId: 'user-bo', name: 'Bo', capacityHours: 20, allocationPctOverride: 50, notes: '' }],
  });
  assert.equal(read.data.members.length, 3);
  assert.deepEqual((await call('odin_get_sprint_capacity', { projectId: 'project-1', sprintId: 'sprint-1' })).data.sprints.map((sprint) => sprint.id), ['sprint-1']);
  assert.equal((await call('odin_get_sprint_capacity', { projectId: 'project-1', sprintId: 'sprint-9' })).data.error.code, 'sprint_not_found');

  calls.length = 0;
  const saved = await call('odin_set_sprint_capacity', { projectId: 'project-1', remove: ['user-ann'], set: [{ capacityHours: 25, userId: 'user-bo' }, { capacityHours: 5, notes: 'Reviews', userId: 'user-cy' }], sprintId: 'sprint-2' });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  assert.deepEqual(calls.find(([method]) => method === 'PUT'), ['PUT', `${PROJECT}/sprints/sprint-2/staffing`, { body: { staffing: [
    { allocationPctOverride: 50, capacityHours: 25, notes: '', userId: 'user-bo' },
    { allocationPctOverride: null, capacityHours: 5, notes: 'Reviews', userId: 'user-cy' },
  ] } }]);
  assert.deepEqual([saved.data.capacityHours, saved.data.staffing.map((entry) => entry.name)], [30, ['Bo', 'Cy']]);

  calls.length = 0;
  assert.equal((await call('odin_set_sprint_capacity', { projectId: 'project-1', set: [{ capacityHours: 5, userId: 'user-zed' }], sprintId: 'sprint-2' })).data.error.code, 'not_project_member');
  assert.equal((await call('odin_set_sprint_capacity', { projectId: 'project-1', sprintId: 'sprint-2' })).data.error.code, 'nothing_to_change');
  assert.equal((await call('odin_set_sprint_capacity', { projectId: 'project-1', set: [{ capacityHours: 5, userId: 'user-ann' }], sprintId: 'sprint-9' })).data.error.code, 'sprint_not_found');
  const preview = await call('odin_set_sprint_capacity', { dryRun: true, projectId: 'project-1', remove: ['user-ann'], sprintId: 'sprint-2' });
  assert.deepEqual([preview.data.dryRun, preview.data.request.change.remove], [true, ['user-ann']]);
  assert.equal(calls.some(([method]) => method === 'PUT'), false);

  // Sprints are project-wide: someone who edits the plan but does not manage the project is refused before the save.
  permissions.canManage = false;
  const refused = await call('odin_set_sprint_capacity', { projectId: 'project-1', set: [{ capacityHours: 5, userId: 'user-ann' }], sprintId: 'sprint-2' });
  assert.equal(refused.data.error.code, 'needs_project_manager');
  assert.equal(calls.some(([method]) => method === 'PUT'), false);
});
