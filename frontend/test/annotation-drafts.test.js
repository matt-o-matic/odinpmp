import assert from 'node:assert/strict';
import test from 'node:test';

import { applyDrafts, diffSnapshots, hasDrafts, ownSnapshot, reconcileDrafts, recordDraft } from '../src/lib/requirements/annotation-drafts.js';

const box = (x) => ({ schemaVersion: 1, type: 'box', x, y: 10, w: 40, h: 40, style: { color: '#c2410c', stroke: 3 } });
const mine = (id, x) => ({ id, authorRef: 'me', authorName: 'Ravi Shah', color: '#c2410c', status: 'open', shapes: [box(x)] });
const theirs = (id, x) => ({ id, authorRef: 'jo', authorName: 'Jamie Ortiz', color: '#7c3aed', status: 'open', shapes: [box(x)] });

test('ownSnapshot keeps only the current reviewer\'s marks', () => {
  const marks = [mine('a', 1), theirs('b', 2), mine('c', 3)];
  assert.deepEqual(ownSnapshot(marks, 'me'), [{ id: 'a', shapes: [box(1)] }, { id: 'c', shapes: [box(3)] }]);
  assert.deepEqual(ownSnapshot(marks, ''), []);
});

test('diffSnapshots reports created, updated and deleted annotations', () => {
  const before = [{ id: 'a', shapes: [box(1)] }, { id: 'b', shapes: [box(2)] }];
  const after = [{ id: 'a', shapes: [box(5)] }, { id: 'c', shapes: [box(3)] }];
  assert.deepEqual(diffSnapshots(before, after), {
    created: [{ id: 'c', shapes: [box(3)] }],
    updated: [{ id: 'a', shapes: [box(5)] }],
    deleted: ['b'],
  });
  assert.deepEqual(diffSnapshots(before, before), { created: [], updated: [], deleted: [] });
});

test('a created draft shows at once and settles when the parent adds it', () => {
  const marks = [theirs('b', 2)];
  const drafts = recordDraft({}, marks, { type: 'create', id: 'a', shapes: [box(1)], mark: { authorRef: 'me', authorName: 'Ravi Shah', status: 'open' } });
  const shown = applyDrafts(marks, drafts);
  assert.deepEqual(shown.map((m) => m.id), ['b', 'a']);
  assert.deepEqual(shown[1].shapes, [box(1)]);
  assert.equal(reconcileDrafts(marks, drafts), drafts, 'unchanged while the save is pending');
  assert.equal(hasDrafts(reconcileDrafts([...marks, mine('a', 1)], drafts)), false);
});

test('editing a pending draft keeps it a create; deleting it drops it', () => {
  let drafts = recordDraft({}, [], { type: 'create', id: 'a', shapes: [box(1)], mark: { authorRef: 'me' } });
  drafts = recordDraft(drafts, [], { type: 'update', id: 'a', shapes: [box(9)] });
  assert.equal(drafts.a.kind, 'create');
  assert.deepEqual(applyDrafts([], drafts)[0].shapes, [box(9)]);
  assert.deepEqual(recordDraft(drafts, [], { type: 'delete', id: 'a' }), {});
});

test('an update overrides the stored shapes until the stored shapes change', () => {
  const marks = [mine('a', 1)];
  const drafts = recordDraft({}, marks, { type: 'update', id: 'a', shapes: [box(50)] });
  assert.deepEqual(applyDrafts(marks, drafts)[0].shapes, [box(50)]);
  assert.equal(reconcileDrafts(marks, drafts), drafts, 'the save has not landed');
  assert.equal(hasDrafts(reconcileDrafts([mine('a', 50)], drafts)), false, 'the parent applied it');
  assert.equal(hasDrafts(reconcileDrafts([mine('a', 51)], drafts)), false, 'the server normalized it; the prop wins');
  assert.equal(hasDrafts(reconcileDrafts([], drafts)), false, 'deleted elsewhere');

  const twice = recordDraft(drafts, marks, { type: 'update', id: 'a', shapes: [box(70)] });
  assert.equal(twice.a.base, drafts.a.base, 'the base stays at the first stored version');
  assert.deepEqual(recordDraft({}, [], { type: 'update', id: 'ghost', shapes: [box(1)] }), {}, 'unknown IDs are ignored');
});

test('a delete hides the mark until it leaves the prop, and undo restores it as an update', () => {
  const marks = [mine('a', 1), theirs('b', 2)];
  const drafts = recordDraft({}, marks, { type: 'delete', id: 'a' });
  assert.deepEqual(applyDrafts(marks, drafts).map((m) => m.id), ['b']);
  assert.equal(reconcileDrafts(marks, drafts), drafts);
  assert.equal(hasDrafts(reconcileDrafts([theirs('b', 2)], drafts)), false);

  const restored = recordDraft(drafts, marks, { type: 'create', id: 'a', shapes: [box(1)], mark: {} });
  assert.equal(restored.a.kind, 'update');
  assert.deepEqual(applyDrafts(marks, restored).map((m) => m.id), ['a', 'b']);

  const updatedThenDeleted = recordDraft(recordDraft({}, marks, { type: 'update', id: 'a', shapes: [box(9)] }), marks, { type: 'delete', id: 'a' });
  assert.equal(updatedThenDeleted.a.kind, 'delete');
});
