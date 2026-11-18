import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainOf,
  dayLabel,
  driverLabel,
  ganttTableRows,
  ganttTicks,
  groupRowsByPerson,
  linkPath,
  resourceColor,
  resourceIndex,
  spanLabel,
  visibleAnchor,
  visibleGanttRows,
} from '../src/lib/insights/gantt.js';

const leaf = (id, fields = {}) => ({ assigneeId: null, blockedBy: [], done: false, driver: { kind: 'start' }, finish: 3, id, leaf: true, level: 1, name: id, parentId: 'epic', start: 0, status: 'Not Started', type: 'story', ...fields });
const ROWS = [
  { blockedBy: [], doneCount: 1, finish: 9, id: 'epic', leaf: false, leafCount: 3, level: 0, name: 'Epic', parentId: null, start: 0, type: 'epic' },
  leaf('a', { assigneeId: 'ada', finish: 3 }),
  leaf('b', { assigneeId: 'ada', driver: { assigneeId: 'ada', itemId: 'a', kind: 'resource' }, finish: 6, start: 3 }),
  leaf('c', { done: true, finish: 9, start: 6 }),
  { blockedBy: [], doneCount: 0, finish: 12, id: 'epic-2', leaf: false, leafCount: 1, level: 0, name: 'Epic 2', parentId: null, start: 9, type: 'epic' },
  leaf('d', { assigneeId: 'alan', finish: 12, parentId: 'epic-2', start: 9 }),
];
const RESOURCES = [{ finish: 6, id: 'ada', name: 'Ada Lovelace', slot: 1 }, { finish: 12, id: 'alan', name: 'Alan Turing', slot: null }];

test('labels count days from one and say why a story starts when it does', () => {
  assert.equal(dayLabel(0), 'Day 1');
  assert.equal(spanLabel({ finish: 5, start: 2 }), 'Day 3–Day 5 · 3 working days');
  const names = new Map(ROWS.map((row) => [row.id, row.name]));
  assert.equal(driverLabel(ROWS[2], { names, resources: resourceIndex(RESOURCES), sprints: new Map() }), 'waits for Ada to finish a');
  assert.equal(driverLabel({ driver: { itemId: 'a', kind: 'blocker', source: 'dependency', type: 'SS' } }, { names, sprints: new Map() }), 'waits on (start-to-start) a');
  assert.equal(resourceColor(resourceIndex(RESOURCES).get('ada')), 'var(--gantt-r1)');
  assert.equal(resourceColor(resourceIndex(RESOURCES).get('alan')), 'var(--gantt-other)');
  assert.equal(resourceColor(undefined), 'var(--gantt-unassigned)');
});

test('collapsed groups and hidden done work drop out; links land on the nearest visible row', () => {
  assert.deepEqual(visibleGanttRows(ROWS, { collapsed: new Set(['epic']) }).map((row) => row.id), ['epic', 'epic-2', 'd']);
  assert.deepEqual(visibleGanttRows(ROWS, { hideDone: true }).map((row) => row.id), ['epic', 'a', 'b', 'epic-2', 'd']);
  const anchor = visibleAnchor(ROWS, new Set(['epic', 'epic-2', 'd']));
  assert.equal(anchor('b'), 'epic');
  assert.equal(anchor('d'), 'd');
});

test('grouping by person gives each person a summary row and their stories in start order', () => {
  const grouped = groupRowsByPerson(ROWS, RESOURCES);
  assert.deepEqual(grouped.map((row) => [row.id, row.level]), [
    ['person:ada', 0], ['a', 1], ['b', 1],
    ['person:alan', 0], ['d', 1],
    ['person:unassigned', 0], ['c', 1],
  ]);
  assert.deepEqual([grouped[0].start, grouped[0].finish, grouped[0].leafCount], [0, 6, 2]);
  assert.equal(grouped[5].done, true);
});

test('a chain runs upstream and downstream through links and epics', () => {
  const links = [{ from: 'a', to: 'epic-2' }];
  assert.deepEqual([...chainOf('d', links, ROWS)].sort(), ['a', 'd', 'epic', 'epic-2']);
  assert.deepEqual([...chainOf('b', links, ROWS)].sort(), ['b', 'epic']);
});

test('links route straight when there is room and double back when there is not', () => {
  assert.equal(linkPath({ fromX: 10, fromY: 5, toX: 60, toY: 40 }), 'M10,5 H18 V40 H60');
  assert.equal(linkPath({ fromX: 50, fromY: 5, toX: 40, toY: 40 }), 'M50,5 h8 V25 H32 V40 H40');
  assert.deepEqual(ganttTicks(20, 10), [0, 5, 10, 15, 20]);
});

test('the table view has a row per timeline row', () => {
  const data = { resources: RESOURCES, rows: ROWS, sprints: [] };
  const table = ganttTableRows(data);
  assert.equal(table.length, ROWS.length);
  assert.deepEqual(table[2], {
    assignee: 'Ada Lovelace', blockedBy: '—', days: 3, finish: 'Day 6', flags: '—', item: '  b', key: 'b',
    placedBy: 'waits for Ada to finish a', sprint: '', start: 'Day 4', status: 'Not Started', type: 'Story',
  });
  assert.equal(table[0].placedBy, '1 of 3 stories done');
});
