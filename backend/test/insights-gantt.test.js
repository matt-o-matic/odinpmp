import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWorkingCalendar } from '../src/modules/governance/schedule-analysis.js';
import { buildGanttCard, scheduleGantt } from '../src/modules/insights/insights-gantt.js';

const calendar = normalizeWorkingCalendar(null);

function story(id, fields = {}) {
  return { id, name: id, status: 'Not Started', ...fields };
}

function project(stories, { startDate = '2026-10-05' } = {}) {
  return { epics: [{ id: 'epic-a', name: 'Epic A', stories }], startDate };
}

// Two dated two-week sprints, Monday 2026-10-05 onwards; then one with no dates.
const SPRINTS = [
  { endDate: '2026-10-16', id: 's1', name: 'Sprint 1', startDate: '2026-10-05', status: 'active' },
  { endDate: '2026-10-30', id: 's2', name: 'Sprint 2', startDate: '2026-10-19', status: 'planned' },
  { endDate: null, id: 's3', name: 'Sprint 3', startDate: null, status: 'planned' },
];

const row = (data, id) => data.rows.find((entry) => entry.id === id);
const span = (data, id) => [row(data, id).start, row(data, id).finish];

test('sprints place stories on working-day offsets; undated sprints follow the one before', () => {
  const data = scheduleGantt({
    calendar,
    project: project([
      story('story-1', { assigneeId: 'ada', points: 3, sprintId: 's1' }),
      story('story-2', { assigneeId: 'alan', sprintId: 's2' }),
      story('story-3', { assigneeId: 'ada', sprintId: 's3', targetHourEstimate: 20 }),
    ]),
    sprints: SPRINTS,
    today: '2026-10-07',
  });
  assert.deepEqual(data.sprints.map(({ end, id, start }) => ({ end, id, start })), [
    { end: 10, id: 's1', start: 0 },
    { end: 20, id: 's2', start: 10 },
    { end: 30, id: 's3', start: 20 },
  ]);
  assert.deepEqual([...span(data, 'story-1'), row(data, 'story-1').durationSource], [0, 3, 'points']);
  // No estimate, and alone in Alan's sprint: the whole sprint.
  assert.deepEqual([...span(data, 'story-2'), row(data, 'story-2').durationSource], [10, 20, 'sprint']);
  // 20 hours at 8 hours a day.
  assert.deepEqual(span(data, 'story-3'), [20, 23]);
  assert.deepEqual(span(data, 'epic-a'), [0, 23]);
  assert.equal(data.now, 2);
  assert.equal(data.activeSprintId, 's1');
  assert.deepEqual(data.resources.map(({ finish, id, slot }) => ({ finish, id, slot })), [{ finish: 23, id: 'ada', slot: 1 }, { finish: 20, id: 'alan', slot: 2 }]);
});

test('one person works one story at a time: their stories stack, in priority order', () => {
  const data = scheduleGantt({
    calendar,
    project: project([
      story('low', { assigneeId: 'ada', points: 3, priority: 5, sprintId: 's1' }),
      story('high', { assigneeId: 'ada', points: 3, priority: 1, sprintId: 's1' }),
      story('mid', { assigneeId: 'ada', points: 3, priority: 3, sprintId: 's1' }),
      story('mine', { assigneeId: 'alan', points: 3, sprintId: 's1' }),
    ]),
    sprints: SPRINTS,
    today: '2026-10-05',
  });
  assert.deepEqual(span(data, 'high'), [0, 3]);
  assert.deepEqual(span(data, 'mid'), [3, 6]);
  assert.deepEqual(span(data, 'low'), [6, 9]);
  assert.deepEqual(row(data, 'low').driver, { assigneeId: 'ada', itemId: 'mid', kind: 'resource' });
  assert.equal(row(data, 'low').earliest, 0);
  // Alan works in parallel with Ada.
  assert.deepEqual(span(data, 'mine'), [0, 3]);
  assert.equal(data.counts.leveled, 2);
  assert.deepEqual(data.rows.filter((entry) => entry.critical).map((entry) => entry.id), ['high', 'mid', 'low']);
});

test('finished stories stay at their dates and do not hold their person\'s open work back', () => {
  // Ada finished a week of overlapping stories; launch prep and launch follow them.
  const data = scheduleGantt({
    calendar,
    project: project([
      story('built', { assigneeId: 'ada', status: 'Completed', targetEndDate: '2026-10-09', targetStartDate: '2026-10-05' }),
      story('audited', { assigneeId: 'ada', status: 'Completed', targetEndDate: '2026-10-08', targetStartDate: '2026-10-06' }),
      story('tooling', { assigneeId: 'ada', status: 'Completed', targetEndDate: '2026-10-09', targetStartDate: '2026-10-09' }),
      story('prep', { assigneeId: 'ada', targetEndDate: '2026-10-15', targetStartDate: '2026-10-12' }),
      story('launch', { assigneeId: 'ada', targetEndDate: '2026-10-16', targetStartDate: '2026-10-16' }),
    ]),
    today: '2026-10-12',
  });
  assert.deepEqual(span(data, 'built'), [0, 5]);
  assert.deepEqual(span(data, 'audited'), [1, 4]);
  assert.deepEqual(span(data, 'tooling'), [4, 5]);
  assert.deepEqual(span(data, 'prep'), [5, 9]);
  assert.deepEqual(span(data, 'launch'), [9, 10]);
  assert.equal(data.counts.leveled, 0);
  assert.equal(data.anchorDate, '2026-10-05');
  assert.deepEqual([row(data, 'launch').startDate, row(data, 'launch').finishDate], ['2026-10-16', '2026-10-16']);
  assert.deepEqual([row(data, 'epic-a').startDate, row(data, 'epic-a').finishDate], ['2026-10-05', '2026-10-16']);
});

test('stories with no estimate share what is left of their person\'s sprint, and overload slips past it', () => {
  const data = scheduleGantt({
    calendar,
    project: project([
      story('sized', { assigneeId: 'ada', points: 4, sprintId: 's1' }),
      story('open-1', { assigneeId: 'ada', sprintId: 's1' }),
      story('open-2', { assigneeId: 'ada', sprintId: 's1' }),
      story('big', { assigneeId: 'ada', points: 8, sprintId: 's1' }),
    ]),
    sprints: SPRINTS,
    today: '2026-10-05',
  });
  // 10 days less 12 estimated leaves nothing to share: a day each.
  assert.equal(row(data, 'open-1').finish - row(data, 'open-1').start, 1);
  assert.equal(data.rows.filter((entry) => entry.leaf).reduce((sum, entry) => sum + entry.finish - entry.start, 0), 14);
  assert.equal(Math.max(...data.rows.filter((entry) => entry.leaf).map((entry) => entry.finish)), 14);
  assert.equal(data.counts.slipping, 1);
});

test('unassigned stories go to whoever is free first, never past the team size', () => {
  const data = scheduleGantt({
    calendar,
    project: project([
      story('ada-1', { assigneeId: 'ada', points: 6, sprintId: 's1' }),
      story('alan-1', { assigneeId: 'alan', points: 2, sprintId: 's1' }),
      story('loose-1', { points: 3, sprintId: 's1' }),
      story('loose-2', { points: 3, sprintId: 's1' }),
    ]),
    sprints: SPRINTS,
    today: '2026-10-05',
  });
  assert.deepEqual([...span(data, 'loose-1'), row(data, 'loose-1').trackId], [2, 5, 'alan']);
  assert.deepEqual([...span(data, 'loose-2'), row(data, 'loose-2').trackId], [5, 8, 'alan']);
  assert.equal(data.counts.unassigned, 2);
});

test('blocking outranks the sprint, and a person fills the gap with other work', () => {
  const data = scheduleGantt({
    calendar,
    dependencies: [{ dependencyType: 'FS', lagDays: 2, predecessorId: 'story-api', successorId: 'story-ui' }],
    project: project([
      story('story-api', { assigneeId: 'alan', points: 8, sprintId: 's1' }),
      story('story-ui', { assigneeId: 'ada', points: 5, sprintId: 's1' }),
      story('story-docs', { assigneeId: 'ada', points: 4, priority: 7, sprintId: 's1' }),
      story('story-qa', { points: 2 }),
    ]),
    relations: [{ fromItemId: 'task-ui-polish', relationType: 'blocks', toItemId: 'story-qa' }],
    sprints: SPRINTS,
    today: '2026-10-07',
  });
  const ui = row(data, 'story-ui');
  assert.deepEqual(span(data, 'story-ui'), [10, 15]);
  assert.deepEqual(ui.driver, { itemId: 'story-api', kind: 'blocker', source: 'dependency', type: 'FS' });
  assert.equal(ui.slipsSprint, true);
  // In the active sprint with its blocker still open: blocked now.
  assert.equal(ui.activelyBlocked, true);
  // Ada does the docs while she waits.
  assert.deepEqual(span(data, 'story-docs'), [0, 4]);
  // The relation names a task that is not in the project, so story-qa stays unplaced.
  assert.deepEqual(data.unscheduled.map((entry) => entry.id), ['story-qa']);
  assert.deepEqual(data.links.map((link) => `${link.from}>${link.to}`), ['story-api>story-ui']);
});

test('links on tasks land on their stories; links on epics cover every story in them', () => {
  const data = scheduleGantt({
    calendar,
    project: {
      epics: [
        { id: 'epic-a', name: 'A', stories: [story('a1', { assigneeId: 'ada', targetHourEstimate: 16 }), story('a2', { assigneeId: 'alan', targetHourEstimate: 40 })] },
        { id: 'epic-b', name: 'B', stories: [{ id: 'b1', name: 'b1', tasks: [{ assigneeId: 'ada', id: 'b1-t1', name: 't' }], targetHourEstimate: 8 }] },
        { id: 'epic-c', name: 'C', stories: [story('c1'), { id: 'c2', name: 'c2', points: 2, tasks: [{ id: 'c2-t1', name: 't' }] }] },
      ],
      startDate: null,
    },
    relations: [
      { fromItemId: 'epic-a', relationType: 'blocks', toItemId: 'epic-b' },
      { fromItemId: 'b1-t1', relationType: 'blocks', toItemId: 'c2-t1' },
    ],
    sprints: [],
    today: '2026-10-07',
  });
  assert.deepEqual(data.rows.map((entry) => [entry.id, entry.level, entry.start, entry.finish]), [
    ['epic-a', 0, 0, 5],
    ['a1', 1, 0, 2],
    ['a2', 1, 0, 5],
    ['epic-b', 0, 5, 6],
    ['b1', 1, 5, 6],
    ['epic-c', 0, 6, 8],
    ['c2', 1, 6, 8],
  ]);
  // b1 takes the assignee of its only task.
  assert.equal(row(data, 'b1').assigneeId, 'ada');
  assert.equal(row(data, 'b1').blockedBy[0].viaId, 'epic-b');
  assert.deepEqual(data.unscheduled.map((entry) => entry.id), ['c1']);
  // Nothing dated: no today line.
  assert.equal(data.now, null);
});

test('loops fall back to the sprint and are reported; done blockers no longer block', () => {
  const looped = scheduleGantt({
    calendar,
    project: project([story('x', { points: 2, sprintId: 's2' }), story('y', { points: 2, sprintId: 's2' })]),
    relations: [
      { fromItemId: 'x', relationType: 'blocks', toItemId: 'y' },
      { fromItemId: 'y', relationType: 'blocks', toItemId: 'x' },
    ],
    sprints: SPRINTS,
    today: '2026-10-07',
  });
  assert.deepEqual([row(looped, 'x').start, row(looped, 'y').start], [10, 10]);
  assert.equal(looped.counts.cyclic, 2);

  const data = scheduleGantt({
    calendar,
    project: project([
      story('done-api', { points: 1, sprintId: 's1', status: 'Completed' }),
      story('open-ui', { points: 1, sprintId: 's1', status: 'In Progress' }),
      story('late', { points: 1, sprintId: 's1' }),
    ]),
    relations: [{ fromItemId: 'done-api', relationType: 'blocks', toItemId: 'open-ui' }],
    sprints: SPRINTS,
    today: '2026-10-09',
  });
  assert.equal(row(data, 'open-ui').activelyBlocked, false);
  assert.equal(row(data, 'late').late, true);
  assert.equal(row(data, 'done-api').late, false);
  assert.equal(row(data, 'epic-a').lateCount, 2);
});

test('the card is empty until sprints or blocking can place anything', () => {
  const ctx = { calendar, memberNames: new Map(), project: project([story('loose')]), relations: [], sprints: [], today: '2026-10-07' };
  const card = buildGanttCard(ctx);
  assert.equal(card.status, 'empty');
  assert.equal(card.action.target, 'sprints');
  assert.equal(buildGanttCard({ ...ctx, project: { epics: [] } }).action.target, 'structure');
  const ready = buildGanttCard({ ...ctx, project: project([story('loose'), story('planned', { sprintId: 's1' })]), sprints: SPRINTS });
  assert.equal(ready.status, 'ready');
  assert.match(ready.notes[0], /1 story is in no sprint/);
  assert.match(ready.notes[1], /Nobody is assigned/);
});
