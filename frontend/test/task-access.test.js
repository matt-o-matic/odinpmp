import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ALL_SPRINTS,
  NO_SPRINT,
  applyTaskChange,
  boardColumns,
  boardDropPatch,
  buildNewTask,
  buildTaskUpdate,
  buildTimeEntry,
  canDeleteTimeEntry,
  classifyAccessError,
  describeAccessWriteError,
  directTasksProjectId,
  dueText,
  emptyTasksText,
  filterTasks,
  formatDay,
  groupTasksByStory,
  hoursText,
  hubProjectSummary,
  hubProjects,
  itemParent,
  itemTypeText,
  pageProblemFor,
  showsEveryoneFilter,
  sprintOptions,
  statusChoices,
  statusLabel,
  statusTone,
  storiesForNewTask,
  taskUpdateForm,
  timeEntryForm,
} from '../src/lib/task-access/access-view.js';
import {
  accessLinkStateText,
  canTurnOffLink,
  linkSendBlocker,
  looksLikeEmail,
  resourceProfileErrorMessage,
  taskAccessErrorMessage,
  taskAccessLabel,
  taskAccessScope,
} from '../src/lib/task-access/task-access-admin.js';
import { createVisibleRefresh } from '../src/lib/task-access/visible-refresh.js';

const apiError = (status, data = {}) => Object.assign(new Error(data.error ?? 'Request failed.'), { data, status });

// Synthetic board: two columns share "At Risk", and "Review" has no column.
const COLUMNS = [
  { defaultStatus: 'Not Started', key: 'todo', name: 'To do', statuses: ['Not Started'] },
  { defaultStatus: 'In Progress', key: 'doing', name: 'Doing', statuses: ['In Progress', 'At Risk'] },
  { defaultStatus: 'At Risk', key: 'blocked', name: 'Blocked', statuses: ['At Risk'] },
  { defaultStatus: 'Completed', key: 'done', name: 'Done', statuses: ['Completed'] },
];

// Synthetic board items, shaped as the board's `items`.
function task(id, overrides = {}) {
  return { boardColumn: null, epicId: 'epic-1', epicName: 'Payments', id, itemType: 'task', mine: false, name: `Task ${id}`, parentName: 'Story A', sprintId: 's1', status: 'Not Started', storyId: 'story-a', version: 3, ...overrides };
}

function story(id, overrides = {}) {
  return task(id, { itemType: 'story', name: `Story ${id}`, parentName: 'Payments', storyId: id, ...overrides });
}

function epic(id, overrides = {}) {
  return task(id, { epicId: id, epicName: `Epic ${id}`, itemType: 'epic', mine: true, name: `Epic ${id}`, parentName: null, sprintId: null, storyId: null, ...overrides });
}

test('link problems get the portal screens, and a project no longer shared gets its own', () => {
  assert.deepEqual(classifyAccessError(apiError(404, { details: { code: 'link_not_found' } })), { kind: 'not-found' });
  assert.deepEqual(classifyAccessError(apiError(410, { details: { code: 'link_revoked' } })), { kind: 'revoked' });
  assert.deepEqual(classifyAccessError(apiError(410, { details: { code: 'link_expired', expiredAt: '2026-10-01T00:00:00.000Z' } })), { expiredAt: '2026-10-01T00:00:00.000Z', kind: 'expired' });
  assert.deepEqual(classifyAccessError(apiError(429, { details: { code: 'rate_limited', retryAfterSeconds: 5 } })), { kind: 'rate-limited', retryAfterSeconds: 5 });
  assert.deepEqual(classifyAccessError(apiError(404, { details: { code: 'no_project_access' } })), { kind: 'no-project' });
  assert.deepEqual(classifyAccessError(apiError(500)), { kind: 'failed', status: 500 });
  assert.equal(pageProblemFor(apiError(403, { details: { code: 'not_your_task' } })), null, 'a refused write is not a page problem');
  assert.deepEqual(pageProblemFor(apiError(410, { details: { code: 'link_revoked' } })), { kind: 'revoked' });
});

test('only a version_conflict is a conflict; it reloads and says someone else changed the item', () => {
  const conflict = describeAccessWriteError(apiError(409, { details: { code: 'version_conflict' }, error: 'Someone else changed this since you loaded it. Reload and try again.' }), { itemType: 'task' });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reload, true);
  assert.match(conflict.message, /Someone else changed this task/);
  assert.match(describeAccessWriteError(apiError(409, { details: { code: 'version_conflict' } }), { itemType: 'epic' }).message, /changed this epic/);
  assert.match(describeAccessWriteError(apiError(409, { details: { code: 'version_conflict' } })).message, /changed this item/, 'no type reads as an item');
  const bare = describeAccessWriteError(apiError(409, { error: 'Request failed.' }));
  assert.equal(bare.conflict, false, 'a 409 without the code is not a conflict');
  assert.equal(bare.reload, false);
  assert.equal(bare.message, 'That change wasn’t saved.');
});

test('workflow refusals show the server’s words and change nothing on the page', () => {
  const cases = [
    [409, 'workflow_transition_not_allowed', 'Workflow does not allow in_progress to transition to done.'],
    [409, 'workflow_required_fields_missing', 'Complete required fields before this transition: acceptance.'],
    [409, 'workflow_approval_required', 'This workflow transition requires a current approval.'],
    [403, 'workflow_transition_role_denied', 'Your role cannot perform this workflow transition.'],
  ];
  for (const [status, code, error] of cases) {
    const described = describeAccessWriteError(apiError(status, { details: { code }, error }));
    assert.deepEqual([described.code, described.conflict, described.reload, described.message, described.problem], [code, false, false, error, null], code);
  }
  assert.match(describeAccessWriteError(apiError(409, { details: { code: 'workflow_approval_required' } })).message, /needs approval/, 'own words without a server sentence');
  assert.equal(
    describeAccessWriteError(apiError(409, { details: { code: 'workflow_transition_not_allowed' } }), { itemType: 'story' }).message,
    'The project’s workflow doesn’t allow moving this story to that status.',
    'own words name the item’s type',
  );
});

test('a story with someone else’s open tasks shows the server’s words and changes nothing on the page', () => {
  const error = 'Other people still have 2 open tasks on this story, so it can\'t be completed here. Ask the project team.';
  const described = describeAccessWriteError(apiError(409, { details: { code: 'story_has_others_open_tasks' }, error }), { itemType: 'story' });
  assert.deepEqual(
    [described.code, described.conflict, described.reload, described.message, described.problem],
    ['story_has_others_open_tasks', false, false, error, null],
  );
  assert.match(describeAccessWriteError(apiError(409, { details: { code: 'story_has_others_open_tasks' } })).message, /open tasks on this story, so it can’t be completed here/, 'own words without a server sentence');
});

test('closed periods, board and comment refusals, and missing records read in plain words', () => {
  const locked = describeAccessWriteError(apiError(423, { error: 'The Week 44 timesheet period is locked.' }));
  assert.deepEqual([locked.message, locked.conflict, locked.reload], ['The Week 44 timesheet period is locked.', false, false]);
  assert.match(describeAccessWriteError(apiError(423, {})).message, /period is closed/);
  const statusRefused = describeAccessWriteError(apiError(400, { details: { code: 'status_not_allowed' }, error: 'review is not a status on this board.' }));
  assert.deepEqual([statusRefused.code, statusRefused.reload], ['status_not_allowed', true]);
  assert.match(statusRefused.message, /isn’t on this board/);
  assert.equal(describeAccessWriteError(apiError(400, { details: { code: 'column_not_found' } })).reload, true);
  assert.equal(describeAccessWriteError(apiError(400, { details: { code: 'comment_empty' } })).message, 'Write a comment first.');
  const taskGone = describeAccessWriteError(apiError(404, { details: { code: 'task_not_found' }, error: 'Work item not found.' }), { itemType: 'task' });
  assert.deepEqual([taskGone.message, taskGone.reload, taskGone.problem], ['This task is no longer there.', true, null], 'a missing task is not a broken link');
  assert.equal(describeAccessWriteError(apiError(404, { details: { code: 'task_not_found' } }), { itemType: 'epic' }).message, 'This epic is no longer there.');
  const entryGone = describeAccessWriteError(apiError(404, { details: { code: 'time_entry_not_found' } }));
  assert.deepEqual([entryGone.message, entryGone.reload], ['That time entry is no longer there.', true]);
  const notYours = describeAccessWriteError(apiError(403, { details: { code: 'not_your_task' }, error: 'Only work assigned to you can be changed here.' }), { itemType: 'story' });
  assert.deepEqual([notYours.message, notYours.reload], ['This story is no longer assigned to you, so you can’t change it.', true]);
  assert.match(describeAccessWriteError(apiError(403, { details: { code: 'story_not_available' } }), { itemType: 'task' }).message, /no longer add tasks to this story/);
  assert.equal(describeAccessWriteError(apiError(400, { details: [{ message: 'Number must be less than or equal to 24', path: 'hours' }], error: 'Invalid request payload.' })).message, 'Number must be less than or equal to 24');
  assert.deepEqual(describeAccessWriteError(apiError(410, { details: { code: 'link_expired' } })).problem, { expiredAt: null, kind: 'expired' });
  assert.match(describeAccessWriteError(new TypeError('Failed to fetch')).message, /didn’t save/);
});

test('workflow state keys read as words and keep their status tone', () => {
  assert.equal(statusLabel('in_progress'), 'In progress');
  assert.equal(statusLabel('ready-for-review'), 'Ready for review');
  assert.equal(statusLabel('In Progress'), 'In Progress', 'names stay as they are');
  assert.equal(statusTone('done').tone, 'ok');
  assert.equal(statusTone('not_started').tone, 'neutral');
  assert.equal(statusTone('blocked').tone, 'warn');
  assert.equal(statusTone('in_progress').tone, 'active');
  assert.equal(dueText({ status: 'done', targetEndDate: '2026-10-01' }, { now: new Date(2026, 9, 29) }).overdue, false);
});

test('the hub opens a lone tasks project directly, and lists everything else', () => {
  const tasksOnly = { projects: [{ id: 'p1', name: 'Atlas', requirements: false, tasks: { scope: 'own' } }] };
  assert.equal(directTasksProjectId(tasksOnly), 'p1');
  assert.equal(directTasksProjectId({ projects: [{ id: 'p1', requirements: true, tasks: { scope: 'own' } }] }), null, 'requirements need the hub');
  assert.equal(directTasksProjectId({ projects: [{ id: 'p1', requirements: true, tasks: null }] }), null);
  assert.equal(directTasksProjectId({ projects: [{ id: 'p1', tasks: { scope: 'all' } }, { id: 'p2', tasks: { scope: 'own' } }] }), null);
  assert.deepEqual(hubProjects({ projects: [{ id: 'p1', requirements: false, tasks: null }, { id: 'p2', requirements: true, tasks: null }] }).map((project) => project.id), ['p2']);
  assert.equal(hubProjectSummary({ requirements: true, tasks: { scope: 'all' } }), 'All work (you update yours) · Requirements');
  assert.equal(hubProjectSummary({ requirements: false, tasks: { scope: 'own' } }), 'Your work');
});

test('Mine / Everyone exists only with everyone’s tasks; sprint filters include No sprint', () => {
  assert.equal(showsEveryoneFilter('all'), true);
  assert.equal(showsEveryoneFilter('own'), false);
  const tasks = [task('a', { mine: true }), task('b', { sprintId: 's2' }), task('c', { mine: true, sprintId: null })];
  assert.deepEqual(filterTasks(tasks, { mineOnly: true }).map((entry) => entry.id), ['a', 'c']);
  assert.deepEqual(filterTasks(tasks, { sprintId: 's2' }).map((entry) => entry.id), ['b']);
  assert.deepEqual(filterTasks(tasks, { sprintId: NO_SPRINT }).map((entry) => entry.id), ['c']);
  assert.deepEqual(filterTasks(tasks, { mineOnly: true, sprintId: 's1' }).map((entry) => entry.id), ['a']);
  assert.deepEqual(filterTasks(tasks, { sprintId: ALL_SPRINTS }).length, 3);
  assert.deepEqual(sprintOptions([{ id: 's1', name: 'Sprint 4', status: 'active' }, { id: 's2', name: 'Sprint 5', status: 'planned' }], tasks).map((option) => option.label), ['All sprints', 'Sprint 4 (current)', 'Sprint 5', 'No sprint']);
  assert.deepEqual(sprintOptions([], [task('a')]).map((option) => option.value), [ALL_SPRINTS]);
  assert.equal(emptyTasksText({ mineOnly: true, total: 4 }), 'You have no work on this project. Choose Everyone to see the rest.');
  assert.match(emptyTasksText({ mineOnly: true, sprintId: 's1', total: 4 }), /no work in this sprint/);
  assert.equal(emptyTasksText({ sprintId: 's1', total: 4 }), 'Nothing in this sprint.');
  assert.equal(emptyTasksText({ total: 0 }), 'Nothing here yet.');
  // Epics sit in no sprint.
  assert.deepEqual(filterTasks([epic('e1'), story('s-a')], { sprintId: NO_SPRINT }).map((entry) => entry.id), ['e1']);
});

test('board columns place cards by boardColumn, then status; cards no column takes are unplaced', () => {
  const { columns, unplaced } = boardColumns(COLUMNS, [
    task('placed', { boardColumn: 'blocked', status: 'At Risk' }),
    task('by-status', { status: 'At Risk' }),
    task('stale', { boardColumn: 'done', status: 'In Progress' }),
    task('review', { status: 'Review' }),
  ]);
  const byColumn = Object.fromEntries(columns.map((column) => [column.key, column.items.map((entry) => entry.id)]));
  assert.deepEqual(byColumn, { blocked: ['placed'], doing: ['by-status', 'stale'], done: [], todo: [] });
  assert.deepEqual(unplaced.map((entry) => entry.id), ['review']);
});

test('stories and epics are cards in the status columns like tasks', () => {
  const { columns, unplaced } = boardColumns(COLUMNS, [
    epic('e1', { status: 'In Progress' }),
    story('s-a', { boardColumn: 'blocked', status: 'At Risk' }),
    story('s-b', { status: 'Completed' }),
    task('t1', { status: 'Not Started' }),
    epic('e2', { status: 'Review' }),
  ]);
  const byColumn = Object.fromEntries(columns.map((column) => [column.key, column.items.map((entry) => `${entry.itemType}:${entry.id}`)]));
  assert.deepEqual(byColumn, { blocked: ['story:s-a'], doing: ['epic:e1'], done: ['story:s-b'], todo: ['task:t1'] });
  assert.deepEqual(unplaced.map((entry) => entry.id), ['e2']);
  assert.deepEqual(boardDropPatch(story('s-a', { mine: true, status: 'Not Started', version: 5 }), COLUMNS[3], 'todo'), { boardColumn: 'done', expectedVersion: 5, status: 'Completed' }, 'the person’s story moves like a task');
  assert.equal(boardDropPatch(story('s-c', { mine: false }), COLUMNS[3], 'todo'), null, 'someone else’s story');
});

test('each card names its type with the app’s icon, and what it sits under', () => {
  assert.deepEqual(itemTypeText('epic'), { icon: 'bi-collection', label: 'Epic', noun: 'epic' });
  assert.deepEqual(itemTypeText('story'), { icon: 'bi-journal-text', label: 'Story', noun: 'story' });
  assert.deepEqual(itemTypeText('task'), { icon: 'bi-check2-square', label: 'Task', noun: 'task' });
  assert.equal(itemTypeText(undefined).noun, 'item');
  assert.deepEqual(itemParent(task('t1')), { epicName: 'Payments', icon: 'bi-journal-text', label: 'Story', name: 'Story A', noun: 'story' }, 'a task sits under its story');
  assert.deepEqual(itemParent(story('s-a')), { epicName: '', icon: 'bi-collection', label: 'Epic', name: 'Payments', noun: 'epic' }, 'a story sits under its epic');
  assert.equal(itemParent(epic('e1')), null, 'an epic has no parent');
  assert.equal(itemParent(task('t2', { parentName: '' })), null);
});

test('a drop sends the column, and the column’s default status only when the task’s status doesn’t fit', () => {
  const mine = task('a', { mine: true, status: 'Not Started', version: 7 });
  assert.deepEqual(boardDropPatch(mine, COLUMNS[1], 'todo'), { boardColumn: 'doing', expectedVersion: 7, status: 'In Progress' });
  const atRisk = task('b', { mine: true, status: 'At Risk', version: 2 });
  assert.deepEqual(boardDropPatch(atRisk, COLUMNS[2], 'doing'), { boardColumn: 'blocked', expectedVersion: 2 }, 'Blocked accepts At Risk, so only the placement changes');
  assert.equal(boardDropPatch(mine, COLUMNS[0], 'todo'), null, 'same column');
  assert.equal(boardDropPatch(task('c', { mine: false }), COLUMNS[1], 'todo'), null, 'someone else’s task');
  assert.deepEqual(applyTaskChange([mine, atRisk], 'a', { boardColumn: 'doing', status: 'In Progress' }).map((entry) => `${entry.id}:${entry.status}:${entry.boardColumn}`), ['a:In Progress:doing', 'b:At Risk:null']);
  assert.deepEqual(statusChoices(COLUMNS, 'Review'), ['Not Started', 'In Progress', 'At Risk', 'Completed', 'Review']);
});

test('the list groups tasks under their stories in story order and skips empty stories', () => {
  const stories = [{ canAddTask: true, id: 'story-b', name: 'B' }, { canAddTask: false, id: 'story-a', name: 'A' }, { canAddTask: true, id: 'story-c', name: 'C' }];
  const groups = groupTasksByStory(stories, [task('1', { storyId: 'story-a' }), task('2', { storyId: 'story-b' }), task('3', { storyId: 'story-a' }), task('4', { storyId: 'gone' })]);
  assert.deepEqual(groups.map((group) => [group.key, group.title, group.items.map((entry) => entry.id)]), [['story-b', 'B', ['2']], ['story-a', 'A', ['1', '3']], ['no-story', 'Other work', ['4']]]);
  assert.deepEqual(storiesForNewTask(stories).map((entry) => entry.id), ['story-b', 'story-c']);
});

test('the list puts epics in their own group first, and a story’s own row first in its group', () => {
  const stories = [{ canAddTask: true, id: 'story-a', name: 'A' }, { canAddTask: true, id: 'story-b', name: 'B' }, { canAddTask: true, id: 'story-c', name: 'C' }];
  const groups = groupTasksByStory(stories, [
    task('1', { storyId: 'story-a' }),
    story('story-a', { mine: true }),
    epic('e1'),
    story('story-b'),
    task('2', { storyId: 'story-a' }),
    epic('e2'),
  ]);
  assert.deepEqual(groups.map((group) => [group.key, group.title, group.items.map((entry) => `${entry.itemType}:${entry.id}`)]), [
    ['epics', 'Epics', ['epic:e1', 'epic:e2']],
    ['story-a', 'A', ['story:story-a', 'task:1', 'task:2']],
    ['story-b', 'B', ['story:story-b']],
  ], 'story C has nothing to show');
  assert.equal(groups[0].story, null);
  assert.equal(groups[1].story.id, 'story-a');
  assert.deepEqual(groupTasksByStory(stories, [task('1', { storyId: 'story-c' })]).map((group) => group.key), ['story-c'], 'no epics, no epics group');
});

test('due dates read as calendar days and say overdue in words', () => {
  const now = new Date(2026, 9, 29, 12);
  assert.equal(formatDay('2026-11-03', { locale: 'en-US' }), 'Nov 3');
  assert.deepEqual(dueText({ status: 'In Progress', targetEndDate: '2026-10-28' }, { locale: 'en-US', now }), { overdue: true, text: 'Overdue, due Oct 28' });
  assert.deepEqual(dueText({ status: 'Completed', targetEndDate: '2026-10-28' }, { locale: 'en-US', now }), { overdue: false, text: 'Due Oct 28' });
  assert.deepEqual(dueText({ status: 'In Progress', targetEndDate: '2026-10-29' }, { locale: 'en-US', now }), { overdue: false, text: 'Due Oct 29' });
  assert.deepEqual(dueText({ targetEndDate: null }), { overdue: false, text: '' });
  assert.equal(hoursText({ remainingHours: 3, targetHourEstimate: 8 }), '8 h estimate · 3 h left');
  assert.equal(hoursText({ remainingHours: 0.25 }), '0.25 h left');
  assert.equal(hoursText({}), '');
  assert.equal(statusTone('Completed').tone, 'ok');
  assert.equal(statusTone('At Risk').tone, 'warn');
  assert.equal(statusTone('Not Started').tone, 'neutral');
  assert.equal(statusTone('In Progress').tone, 'active');
});

test('the task form sends only what changed, against the version it started from', () => {
  const form = taskUpdateForm({ remainingHours: 5, status: 'In Progress', version: 4 });
  assert.deepEqual(buildTaskUpdate(form), { errors: {}, payload: null });
  assert.deepEqual(buildTaskUpdate({ ...form, status: 'Completed' }).payload, { expectedVersion: 4, status: 'Completed' });
  assert.deepEqual(buildTaskUpdate({ ...form, remainingHours: '2.5' }).payload, { expectedVersion: 4, remainingHours: 2.5 });
  assert.deepEqual(buildTaskUpdate({ ...form, remainingHours: '' }).payload, { expectedVersion: 4, remainingHours: null }, 'blank clears it');
  assert.deepEqual(buildTaskUpdate({ ...form, remainingHours: '-1' }).errors, { remainingHours: 'Remaining hours must be a number, 0 or more.' });
  assert.deepEqual(buildTaskUpdate(taskUpdateForm({ remainingHours: null, status: 'Not Started', version: 1 })), { errors: {}, payload: null });
});

test('logging time needs a day and hours; the note and remaining hours are optional', () => {
  assert.match(timeEntryForm(new Date(2026, 9, 29)).workDate, /^2026-10-29$/);
  assert.deepEqual(buildTimeEntry({ hours: '1.5', note: '  Fixed the header ', remainingHours: '', workDate: '2026-10-29' }), {
    errors: {},
    payload: { hours: 1.5, note: 'Fixed the header', workDate: '2026-10-29' },
  });
  assert.deepEqual(buildTimeEntry({ hours: '2', remainingHours: '6', workDate: '2026-10-28' }).payload, { hours: 2, remainingHours: 6, workDate: '2026-10-28' });
  const invalid = buildTimeEntry({ hours: '0', remainingHours: 'x', workDate: '' });
  assert.equal(invalid.payload, null);
  assert.deepEqual(Object.keys(invalid.errors).sort(), ['hours', 'remainingHours', 'workDate']);
  assert.match(buildTimeEntry({ hours: '30', workDate: '2026-10-28' }).errors.hours, /at most 24/);
  assert.equal(canDeleteTimeEntry({ status: 'submitted' }), true);
  assert.equal(canDeleteTimeEntry({ status: 'approved' }), false);
});

test('a new task needs an allowed story and a name; the estimate is whole hours', () => {
  const stories = [{ canAddTask: true, id: 'story-a' }];
  assert.deepEqual(buildNewTask({ description: '', estimate: '', name: ' Wire the form ', storyId: 'story-a' }, stories), { errors: {}, payload: { name: 'Wire the form' } });
  assert.deepEqual(buildNewTask({ description: 'Details', estimate: '6', name: 'X', storyId: 'story-a' }, stories).payload, { description: 'Details', name: 'X', targetHourEstimate: 6 });
  assert.deepEqual(Object.keys(buildNewTask({ estimate: '1.5', name: '', storyId: 'story-z' }, stories).errors).sort(), ['estimate', 'name', 'storyId']);
});

test('the page refreshes on an interval only while visible, and once on coming back', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    visibilityState: 'visible',
  };
  const intervals = new Map();
  let nextId = 1;
  const timers = {
    clearInterval: (id) => intervals.delete(id),
    setInterval: (run, ms) => { const id = nextId++; intervals.set(id, { ms, run }); return id; },
  };
  let refreshes = 0;
  const poller = createVisibleRefresh({ intervalMs: 30_000, refresh: () => { refreshes += 1; }, target, timers });

  poller.start();
  assert.equal(poller.running, true);
  assert.equal([...intervals.values()][0].ms, 30_000);
  [...intervals.values()][0].run();
  assert.equal(refreshes, 1);

  target.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  assert.equal(poller.running, false, 'hidden pages stop polling');
  assert.equal(intervals.size, 0);

  target.visibilityState = 'visible';
  listeners.get('visibilitychange')();
  assert.equal(refreshes, 2, 'coming back refreshes at once');
  assert.equal(intervals.size, 1);

  poller.stop();
  assert.equal(intervals.size, 0);
  assert.equal(listeners.has('visibilitychange'), false);
});

test('managers see the grant and the link state in plain words', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  assert.equal(taskAccessScope({ scope: 'own' }), 'own');
  assert.equal(taskAccessScope({ scope: 'off' }), 'off');
  assert.equal(taskAccessScope(null), 'off');
  assert.equal(taskAccessLabel('all'), 'Everyone’s work');
  assert.equal(accessLinkStateText(null), 'No link sent yet');
  assert.equal(accessLinkStateText({ status: 'revoked' }), 'Link turned off');
  assert.equal(accessLinkStateText({ expiresAt: '2026-10-20T12:00:00.000Z', status: 'expired' }, { locale: 'en-US' }), 'Link expired Oct 20');
  assert.equal(accessLinkStateText({ expiresAt: null, lastUsedAt: null, status: 'active' }, { now }), 'Link active · not opened yet');
  assert.equal(accessLinkStateText({ expiresAt: '2026-11-12T12:00:00.000Z', lastUsedAt: '2026-10-29T11:00:00.000Z', status: 'active' }, { locale: 'en-US', now }), 'Link active until Nov 12 · opened 1 h ago');
  assert.equal(linkSendBlocker({ email: '', scope: 'own' }), 'no-email');
  assert.equal(linkSendBlocker({ email: 'kim@example.com', scope: 'off' }), 'off');
  assert.equal(linkSendBlocker({ email: 'kim@example.com', scope: 'all' }), '');
  assert.equal(canTurnOffLink(undefined), false);
  assert.equal(canTurnOffLink(null), false, 'no link, nothing to turn off');
  assert.equal(canTurnOffLink({ status: 'revoked' }), false);
  assert.equal(canTurnOffLink({ status: 'active' }), true);
  assert.equal(canTurnOffLink({ status: 'expired' }), true);
  assert.equal(looksLikeEmail('kim@example.com'), true);
  assert.equal(looksLikeEmail('kim@'), false);
  assert.match(resourceProfileErrorMessage(apiError(409, { details: { code: 'email_has_login' }, error: 'email_has_login' })), /member of this workspace/);
  assert.match(resourceProfileErrorMessage(apiError(409, { details: { code: 'email_in_use' } })), /already uses that email/);
  assert.equal(resourceProfileErrorMessage(apiError(400, { error: 'Name is required.' })), 'Name is required.');
});

test('the server’s reasons for refusing task access or a link read in plain words', () => {
  const codes = {
    resource_has_login: /sign in instead/,
    resource_inactive: /profile is inactive/,
    resource_needs_email: /Add an email/,
    resource_not_on_project: /no longer allocated to this project/,
    task_access_off: /Task access is off/,
  };
  for (const [code, pattern] of Object.entries(codes)) {
    const described = taskAccessErrorMessage(apiError(409, { details: { code }, error: 'Server sentence.' }));
    assert.equal(described.known, true, code);
    assert.match(described.message, pattern, code);
  }
  assert.deepEqual(taskAccessErrorMessage(apiError(409, { error: 'Someone else changed this.' })), { known: false, message: 'Someone else changed this.' });
  assert.deepEqual(taskAccessErrorMessage(Object.assign(new Error(''), { status: 500 }), 'Unable to save.'), { known: false, message: 'Unable to save.' });
});

test('the access routes hide the app chrome like the client portal', async () => {
  const source = await readFile(new URL('../src/router/index.js', import.meta.url), 'utf8');
  assert.match(source, /path: '\/access\/:token',\s*name: 'task-access-hub',\s*component: AccessHubView,\s*meta: \{ portal: true \}/);
  assert.match(source, /path: '\/access\/:token\/projects\/:projectId',\s*name: 'task-access-project',\s*component: AccessTasksView,\s*meta: \{ portal: true \}/);
});
