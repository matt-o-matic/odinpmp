import assert from 'node:assert/strict';
import test from 'node:test';

import { createChangeRecorder, presentChanges, snapshotVersions, undoChanges, undoSummary } from '../src/lib/agent/agent-changes.js';

// A small Odin: one story in a sprint, a relation, a risk, and a log of every request.
function fakeOdin() {
  const state = {
    governance: [{ id: 'risk-1', kind: 'risk', status: 'open', title: 'Vendor delay', version: 1 }],
    relations: [{ fromItemId: 'story-1', id: 'rel-1', relationType: 'blocks', toItemId: 'story-2' }],
    stories: [{ id: 'story-1', name: 'Checkout', sprintId: 'sprint-1', status: 'In Progress', version: 4 }, { id: 'story-2', name: 'Receipts', sprintId: null, status: 'Not Started', version: 2 }],
  };
  const log = [];
  const project = () => structuredClone({ epics: [{ id: 'epic-1', name: 'Shop', stories: state.stories.map((story) => ({ ...story, tasks: [] })), version: 1 }], id: 'p1', updatedAt: 'u1' });
  const api = {
    async request(method, path, { body } = {}) {
      log.push(`${method} ${path}`);
      if (method === 'GET' && path === '/api/projects/p1') return { project: project() };
      if (method === 'GET' && path === '/api/projects/p1/relations') return { relations: state.relations };
      if (method === 'GET' && path === '/api/projects/p1/governance') return { items: state.governance };
      if (method === 'GET' && path === '/api/projects/p1/sprints') return { sprints: [] };
      if (method === 'POST' && path === '/api/projects/p1/sprints/assign-items') {
        for (const assignment of body.assignments) { const story = state.stories.find((entry) => entry.id === assignment.itemId); story.sprintId = assignment.sprintId; story.version += 1; }
        return { ok: true, project: project() };
      }
      if (method === 'DELETE' && path === '/api/projects/p1/relations/rel-1') { state.relations = state.relations.filter((relation) => relation.id !== 'rel-1'); return { ok: true }; }
      if (method === 'POST' && path === '/api/projects/p1/items/story-1/relations') { const relation = { ...body, fromItemId: 'story-1', id: `rel-${state.relations.length + 2}` }; state.relations.push(relation); return { ok: true, relation }; }
      if (method === 'PATCH' && path === '/api/projects/p1/governance/items/risk-1') { Object.assign(state.governance[0], body, { version: state.governance[0].version + 1 }); delete state.governance[0].expectedVersion; return { item: state.governance[0] }; }
      if (method === 'POST' && path === '/api/projects/p1/kanban/reorder') return { ok: true };
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  return { api, log, state };
}

test('sprint moves, relations and governance edits are reversed; other writes are listed as not undoable', async () => {
  const { api, state } = fakeOdin();
  const recorder = createChangeRecorder({ api });
  recorder.setContext({ label: 'Reorder board card' });
  await recorder.api.request('POST', '/api/projects/p1/sprints/assign-items', { body: { assignments: [{ itemId: 'story-1', itemType: 'story', sprintId: 'sprint-2' }, { itemId: 'story-2', itemType: 'story', sprintId: 'sprint-2' }] } });
  await recorder.api.request('DELETE', '/api/projects/p1/relations/rel-1');
  await recorder.api.request('PATCH', '/api/projects/p1/governance/items/risk-1', { body: { expectedVersion: 1, status: 'closed' } });
  await recorder.api.request('POST', '/api/projects/p1/kanban/reorder', { body: { itemId: 'story-1' } });
  await recorder.api.request('GET', '/api/projects/p1');
  const records = recorder.records();
  assert.deepEqual(records.map((record) => [record.label, record.undoable]), [
    ['Moved 2 items between sprints', true],
    ['Unlinked two items (blocks)', true],
    ['Updated risk "Vendor delay": status', true],
    ['Moved "Checkout" on the board', false],
  ]);

  const changes = { records, status: 'applied', versions: await snapshotVersions({ api, records }) };
  assert.deepEqual(changes.versions, { 'governance:risk-1': 2, 'item:story-1': '[5,"sprint-2"]', 'item:story-2': '[3,"sprint-2"]' });
  const undone = await undoChanges({ api, changes });
  assert.deepEqual(undone.records.map((record) => record.status), ['undone', 'undone', 'undone', 'not_undoable']);
  assert.equal(undone.status, 'partly_undone');
  assert.deepEqual(state.stories.map((story) => story.sprintId), ['sprint-1', null]);
  assert.deepEqual(state.relations.map(({ fromItemId, relationType, toItemId }) => [fromItemId, relationType, toItemId]), [['story-1', 'blocks', 'story-2']]);
  assert.equal(state.governance[0].status, 'open');
  assert.equal(undoSummary(undone), 'Undid 3 changes; 1 can\'t be undone here.');
  assert.deepEqual(presentChanges(undone).records.map((record) => Object.keys(record).sort()), [['id', 'label', 'status', 'undoable'], ['id', 'label', 'status', 'undoable'], ['id', 'label', 'status', 'undoable'], ['id', 'label', 'note', 'status', 'undoable']]);
});

test('a failed write is not recorded, and a record whose item changed since is kept', async () => {
  const { api, state } = fakeOdin();
  const recorder = createChangeRecorder({ api });
  await assert.rejects(recorder.api.request('POST', '/api/projects/p1/nowhere', { body: {} }));
  assert.equal(recorder.records().length, 0);
  await recorder.api.request('POST', '/api/projects/p1/sprints/assign-items', { body: { assignments: [{ itemId: 'story-2', itemType: 'story', sprintId: 'sprint-1' }] } });
  const changes = { records: recorder.records(), status: 'applied', versions: await snapshotVersions({ api, records: recorder.records() }) };
  state.stories[1].version += 1;
  const undone = await undoChanges({ api, changes });
  assert.equal(undone.records[0].status, 'kept');
  assert.equal(state.stories[1].sprintId, 'sprint-1');
  assert.equal(undone.status, 'undo_failed');
});

test('a link Odin does not say is new is not reversed, and one it says was there is no change', async () => {
  const { api } = fakeOdin();
  let created;
  const recorder = createChangeRecorder({ api: { request: async (...args) => ({ ...await api.request(...args), ...(created === undefined ? {} : { created }) }) } });
  const link = () => recorder.api.request('POST', '/api/projects/p1/items/story-1/relations', { body: { relationType: 'blocks', toItemId: 'story-2' } });
  await link();
  created = false;
  await link();
  created = true;
  await link();
  assert.deepEqual(recorder.records().map((record) => [record.label, record.undoable]), [['Linked two items (blocks)', false], ['Linked two items (blocks)', true]]);
});

test('a write whose reply gives no version for what it changed is listed, not reversed', async () => {
  const { api, state } = fakeOdin();
  const recorder = createChangeRecorder({ api: { request: async (method, path, options) => {
    const result = await api.request(method, path, options);
    return method === 'PATCH' ? { ok: true } : result;
  } } });
  await recorder.api.request('PATCH', '/api/projects/p1/governance/items/risk-1', { body: { expectedVersion: 1, status: 'closed' } });
  const records = recorder.records();
  assert.deepEqual(records.map((record) => [record.label, record.undoable, record.undo]), [['Updated risk "Vendor delay": status', false, undefined]]);
  const undone = await undoChanges({ api, changes: { records, status: 'applied', versions: await snapshotVersions({ api, records }) } });
  assert.deepEqual(undone.records.map((record) => record.status), ['not_undoable']);
  assert.equal(state.governance[0].status, 'closed');
});
