import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignmentAllocationWindow, ensureAssigneeResources, namesMatch, resourceIdFromAssignee, treeAssigneeIds,
} from '../src/modules/resource-finance/assignee-resources.js';

function memoryStore({ projects = [], resources = [], allocations = [], users = [] } = {}) {
  let next = 0;
  const state = { allocations: [...allocations], resources: [...resources] };
  return {
    state,
    async createAllocation(input) { const record = { ...input, id: `alloc-${++next}` }; state.allocations.push(record); return record; },
    async createResource(input) { const record = { ...input, id: `res-${++next}` }; state.resources.push(record); return record; },
    async getProject(id) { return projects.find((project) => project.id === id) ?? null; },
    async getUser(id) { return users.find((user) => user.id === id) ?? null; },
    async hasAllocation(resourceId, projectId) { return state.allocations.some((record) => record.resourceId === resourceId && record.projectId === projectId && record.status !== 'completed'); },
    async linkResource(resource, userId) { const record = state.resources.find((entry) => entry.id === resource.id); record.userId = userId; return { ...record }; },
    async listResources() { return state.resources.map((record) => ({ ...record })); },
  };
}

test('names match exactly or by a short first name with the same surname', () => {
  assert.equal(namesMatch('Matt Bradford', 'Matthew Bradford'), true);
  assert.equal(namesMatch('  ROSA  okafor ', 'Rosa Okafor'), true);
  assert.equal(namesMatch('José Núñez', 'Jose Nunez'), true);
  assert.equal(namesMatch('Ro Bradford', 'Rosa Bradford'), false);
  assert.equal(namesMatch('Matt Bradford', 'Matthew Smith'), false);
  assert.equal(namesMatch('Riri', 'Riri Lane'), false);
  assert.equal(resourceIdFromAssignee('resource:abc'), 'abc');
  assert.equal(resourceIdFromAssignee('user-1'), null);
});

test('giving a user work creates their profile and a project allocation once', async () => {
  const store = memoryStore({
    projects: [{ endDate: '2026-12-31', id: 'p1', startDate: '2026-10-01' }, { endDate: null, id: 'p2', startDate: null }],
    users: [{ email: 'ada@example.com', id: 'ada', name: 'Ada Lovelace' }],
  });
  const first = await ensureAssigneeResources(store, {
    assignments: [{ projectId: 'p1', userId: 'ada' }, { projectId: 'p1', userId: 'ada' }, { projectId: 'p2', userId: 'ada' }, { projectId: 'p1', userId: 'resource:x' }, { projectId: 'p1', userId: 'stranger' }],
    today: '2026-10-24',
  });
  assert.equal(first.createdResources.length, 1);
  assert.deepEqual(store.state.resources.map(({ name, userId }) => ({ name, userId })), [{ name: 'Ada Lovelace', userId: 'ada' }]);
  assert.deepEqual(store.state.allocations.map(({ endDate, hoursPerWeek, origin, projectId, startDate, status }) => ({ endDate, hoursPerWeek, origin, projectId, startDate, status })), [
    { endDate: '2026-12-31', hoursPerWeek: 0, origin: 'assignment', projectId: 'p1', startDate: '2026-10-01', status: 'active' },
    { endDate: '2027-10-24', hoursPerWeek: 0, origin: 'assignment', projectId: 'p2', startDate: '2026-10-24', status: 'active' },
  ]);
  const again = await ensureAssigneeResources(store, { assignments: [{ projectId: 'p1', userId: 'ada' }], today: '2026-10-24' });
  assert.deepEqual([again.createdResources.length, again.createdAllocations.length], [0, 0]);
});

test('an unlinked profile with the same name is linked instead of duplicated', async () => {
  const store = memoryStore({
    allocations: [{ id: 'a0', projectId: 'p1', resourceId: 'manual', status: 'completed' }],
    projects: [{ id: 'p1', startDate: '2026-10-01' }],
    resources: [{ id: 'manual', name: 'Matt Bradford', status: 'active', userId: null }, { id: 'other', name: 'Matt Bradford Sr', status: 'active', userId: null }],
    users: [{ id: 'mb', name: 'Matthew Bradford' }],
  });
  const result = await ensureAssigneeResources(store, { assignments: [{ projectId: 'p1', userId: 'mb' }], today: '2026-10-24' });
  assert.deepEqual(result.linkedResources.map((resource) => [resource.id, resource.userId]), [['manual', 'mb']]);
  assert.equal(result.createdResources.length, 0);
  // The old allocation was completed, so a live one is added.
  assert.equal(result.createdAllocations[0].resourceId, 'manual');
});

test('allocation windows and tree assignees', () => {
  assert.deepEqual(assignmentAllocationWindow({ endDate: '2026-01-01', startDate: '2026-03-01' }, '2026-10-24'), { endDate: '2027-03-01', startDate: '2026-03-01' });
  assert.deepEqual(treeAssigneeIds([{ assigneeId: 'a', stories: [{ assigneeId: 'b', tasks: [{ assigneeId: 'a' }, { assigneeId: null }] }] }]), ['a', 'b']);
});
