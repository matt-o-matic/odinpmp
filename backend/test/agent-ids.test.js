import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdRepair } from '../src/lib/agent/agent-ids.js';

// From a live chat: the cutover story's id, written with another story's tail.
const PROJECT = '2b1b9596-308e-4ca9-b385-7b4a4d22298b';
const STORY = '97042a21-9906-4f14-bb17-4bfe6b213021';
const OTHER = 'd03dedbb-a62a-4f5a-bc9b-6bbb81a9cec2';
const GARBLED = '97042a21-9906-4f5a-bc9b-6bbb81a9cec2';

test('an id that matches nothing is read as the one item starting the same way, in calls and replies', async () => {
  const loaded = [];
  const repair = createIdRepair({ loadProjectIds: async (id) => { loaded.push(id); return [STORY, OTHER]; }, projectId: PROJECT });

  const call = await repair.repair({ projectId: PROJECT, updates: [{ itemId: GARBLED, patch: { status: 'Done' } }, { itemId: OTHER, patch: { status: 'Done' } }] }, { callProjectId: PROJECT });
  assert.deepEqual(call.value.updates.map((update) => update.itemId), [STORY, OTHER]);
  assert.deepEqual(call.corrected, [{ given: GARBLED, used: STORY }]);

  const reply = await repair.repair(`Moved [Cutover](odin://item/${GARBLED}) and [Leads](odin://item/${OTHER}).`);
  assert.equal(reply.value, `Moved [Cutover](odin://item/${STORY}) and [Leads](odin://item/${OTHER}).`);
  assert.deepEqual(loaded, [PROJECT]);
});

test('a garbled project id is corrected first, and that project\'s items are read', async () => {
  const loaded = [];
  const repair = createIdRepair({ loadProjectIds: async (id) => { loaded.push(id); return [STORY]; } });
  repair.learn({ ok: true, projects: [{ id: PROJECT, name: 'Initech' }] });

  const call = await repair.repair({ itemId: GARBLED, projectId: '2b1b9596-308e-4ca9-b385-7b4a4d222e50' }, { callProjectId: '2b1b9596-308e-4ca9-b385-7b4a4d222e50' });
  assert.deepEqual(call.value, { itemId: STORY, projectId: PROJECT });
  assert.deepEqual(loaded, [PROJECT]);
});

test('known ids are left alone without a read, and a start shared or unknown stays as written', async () => {
  const twin = '97042a21-1111-4aaa-8bbb-cccccccccccc';
  const stranger = '11111111-2222-4333-8444-555555555555';
  let loads = 0;
  const repair = createIdRepair({ loadProjectIds: async () => { loads += 1; return [STORY, twin]; }, projectId: PROJECT });
  repair.learn({ ok: true, item: { id: OTHER } });

  const known = { itemId: OTHER, projectId: PROJECT };
  assert.equal((await repair.repair(known)).value, known);
  assert.equal(loads, 0);

  const unclear = { ids: [GARBLED, stranger] };
  const result = await repair.repair(unclear);
  assert.equal(result.value, unclear);
  assert.deepEqual(result.corrected, []);
  assert.equal(loads, 1);
});
