import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProjects, mergeRecord } from '../src/lib/projects/project-merge.js';

const task = (id, name, extra = {}) => ({ id, name, status: 'Not Started', version: 1, ...extra });
const clone = (value) => JSON.parse(JSON.stringify(value));

function baseProject() {
  return {
    assistantState: { brief: { objective: 'Ship it' } },
    description: 'Original',
    epics: [{
      id: 'e1',
      name: 'Epic',
      stories: [{
        id: 's1',
        name: 'Story',
        tasks: [task('t1', 'One'), task('t2', 'Two'), task('t3', 'Three')],
      }],
    }],
    id: 'p1',
    name: 'Project',
    status: 'In Progress',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
}

const tasksOf = (project) => project.epics[0].stories[0].tasks;

test('non-overlapping edits from both sides merge without conflicts', () => {
  const base = baseProject();
  const mine = clone(base);
  const theirs = clone(base);
  tasksOf(mine)[0].name = 'One (mine)';
  tasksOf(mine).push(task('draft-t4', 'Local task'));
  tasksOf(theirs)[1].status = 'In Progress';
  tasksOf(theirs)[1].version = 2;
  theirs.description = 'Updated remotely';
  theirs.updatedAt = '2026-10-01T11:00:00.000Z';

  const { conflicts, merged } = mergeProjects({ base, mine, theirs });

  assert.deepEqual(conflicts, []);
  assert.deepEqual(tasksOf(merged).map((entry) => entry.name), ['One (mine)', 'Two', 'Three', 'Local task']);
  assert.equal(tasksOf(merged)[1].status, 'In Progress');
  assert.equal(tasksOf(merged)[1].version, 2, 'keeps the latest server version so the save is not rejected');
  assert.equal(merged.description, 'Updated remotely');
  assert.equal(merged.updatedAt, '2026-10-01T11:00:00.000Z');
});

test('the same field changed on both sides is a conflict resolved by the caller', () => {
  const base = baseProject();
  const mine = clone(base);
  const theirs = clone(base);
  tasksOf(mine)[0].status = 'At Risk';
  tasksOf(theirs)[0].status = 'Completed';
  mine.name = 'Mine';
  theirs.name = 'Theirs';

  const first = mergeProjects({ base, mine, theirs });
  assert.deepEqual(first.conflicts.map((conflict) => conflict.key).sort(), ['project:name', 't1:status']);
  assert.equal(tasksOf(first.merged)[0].status, 'At Risk', 'defaults to keeping my edit');

  const second = mergeProjects({ base, mine, resolutions: { 'project:name': 'theirs', 't1:status': 'theirs' }, theirs });
  assert.equal(second.merged.name, 'Theirs');
  assert.equal(tasksOf(second.merged)[0].status, 'Completed');
});

test('an untouched item deleted remotely disappears; an edited one becomes a conflict', () => {
  const base = baseProject();
  const mine = clone(base);
  const theirs = clone(base);
  tasksOf(theirs).splice(1, 2);
  tasksOf(mine)[2].name = 'Three (edited)';

  const kept = mergeProjects({ base, mine, theirs });
  assert.deepEqual(kept.conflicts.map((conflict) => conflict.key), ['t3:__deleted']);
  assert.deepEqual(tasksOf(kept.merged).map((entry) => entry.name), ['One', 'Three (edited)']);
  assert.match(tasksOf(kept.merged)[1].id, /^draft-restored-/, 'a kept item is re-created under a new id');

  const dropped = mergeProjects({ base, mine, resolutions: { 't3:__deleted': 'theirs' }, theirs });
  assert.deepEqual(tasksOf(dropped.merged).map((entry) => entry.name), ['One']);
});

test('deleting locally while someone edits the item asks before discarding their work', () => {
  const base = baseProject();
  const mine = clone(base);
  const theirs = clone(base);
  tasksOf(mine).splice(0, 1);
  tasksOf(mine).splice(0, 1);
  tasksOf(theirs)[1].name = 'Two (theirs)';

  const { conflicts, merged } = mergeProjects({ base, mine, theirs });
  assert.deepEqual(conflicts.map((conflict) => conflict.key), ['t2:__deleted']);
  assert.deepEqual(tasksOf(merged).map((entry) => entry.name), ['Three']);

  const keepTheirs = mergeProjects({ base, mine, resolutions: { 't2:__deleted': 'theirs' }, theirs });
  assert.deepEqual(tasksOf(keepTheirs.merged).map((entry) => entry.name), ['Two (theirs)', 'Three']);
});

test('a local reorder survives a remote insert', () => {
  const base = baseProject();
  const mine = clone(base);
  const theirs = clone(base);
  tasksOf(mine).reverse();
  tasksOf(theirs).splice(1, 0, task('t9', 'Remote insert'));

  const { conflicts, merged } = mergeProjects({ base, mine, theirs });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(tasksOf(merged).map((entry) => entry.id), ['t3', 't2', 't1', 't9']);
});

test('mergeRecord merges a flat form draft field by field', () => {
  const { conflicts, merged } = mergeRecord({
    base: { goal: 'A', name: 'Sprint 1' },
    fields: ['goal', 'name'],
    keyPrefix: 'sprint',
    mine: { goal: 'Mine', name: 'Sprint 1' },
    theirs: { goal: 'Theirs', name: 'Sprint One' },
  });

  assert.equal(merged.name, 'Sprint One');
  assert.deepEqual(conflicts.map((conflict) => conflict.key), ['sprint:goal']);
});
