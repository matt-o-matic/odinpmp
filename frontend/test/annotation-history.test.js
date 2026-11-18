import assert from 'node:assert/strict';
import test from 'node:test';

import { AnnotationHistory, HISTORY_LIMIT } from '../src/lib/requirements/annotation-history.js';

const snap = (...ids) => ids.map((id) => ({ id, shapes: [] }));

test('undo and redo walk back and forward through committed steps', () => {
  const history = new AnnotationHistory();
  const a = snap();
  const b = snap('1');
  const c = snap('1', '2');
  assert.equal(history.commit(a, b), true);
  assert.equal(history.commit(b, c), true);
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);

  assert.deepEqual(history.undo(c), b);
  assert.deepEqual(history.undo(b), a);
  assert.equal(history.undo(a), null, 'nothing left to undo');
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(a), b);
  assert.deepEqual(history.redo(b), c);
  assert.equal(history.redo(c), null);
});

test('a new commit clears the redo stack', () => {
  const history = new AnnotationHistory();
  history.commit(snap(), snap('1'));
  history.undo(snap('1'));
  assert.equal(history.canRedo, true);
  history.commit(snap(), snap('2'));
  assert.equal(history.canRedo, false);
});

test('commits that change nothing are ignored and identical steps are stored once', () => {
  const history = new AnnotationHistory();
  assert.equal(history.commit(snap('1'), snap('1')), false);
  assert.equal(history.canUndo, false);

  history.commit(snap(), snap('1'));
  history.commit(snap(), snap('2'));
  assert.equal(history.past.length, 1, 'the same before-state is not pushed twice');
});

test('undo skips steps equal to the current state', () => {
  const history = new AnnotationHistory();
  history.commit(snap(), snap('1'));
  history.commit(snap('1'), snap('1', '2'));
  // The second change was reverted elsewhere, so the top undo step matches what is on screen.
  assert.deepEqual(history.undo(snap('1')), snap());
});

test('history keeps at most 100 steps and drops the oldest', () => {
  const history = new AnnotationHistory();
  for (let i = 0; i < 150; i += 1) history.commit(snap(String(i)), snap(String(i + 1)));
  assert.equal(HISTORY_LIMIT, 100);
  assert.equal(history.past.length, 100);
  let current = snap('150');
  let steps = 0;
  for (;;) {
    const previous = history.undo(current);
    if (!previous) break;
    current = previous;
    steps += 1;
  }
  assert.equal(steps, 100);
  assert.deepEqual(current, snap('50'));
  assert.equal(new AnnotationHistory({ limit: 3 }).limit, 3);
});

test('returned snapshots are copies that later edits cannot change', () => {
  const history = new AnnotationHistory();
  const before = [{ id: '1', shapes: [{ type: 'box', x: 1 }] }];
  history.commit(before, []);
  before[0].shapes[0].x = 999;
  const restored = history.undo([]);
  assert.equal(restored[0].shapes[0].x, 1);
  restored[0].shapes[0].x = 5;
  assert.equal(history.redo(restored).length, 0);
  assert.equal(history.undo([])[0].shapes[0].x, 5, 'redo stored the edited copy, not a shared reference');
});

test('clear empties both stacks', () => {
  const history = new AnnotationHistory();
  history.commit(snap(), snap('1'));
  history.undo(snap('1'));
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});
