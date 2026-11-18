import assert from 'node:assert/strict';
import test from 'node:test';

import { buildKanbanCardCreatePayload, createKanbanCardForm, validateKanbanCardForm } from '../src/lib/projects/kanban-card-create.js';
import {
  deliveryStoryOptions,
  findPursuitTask,
  pursuitCardDue,
  pursuitMovePayload,
  pursuitTaskForm,
  pursuitTaskPatch,
  pursuitTasks,
  withAssigneeNames,
  sowSteps,
  tasksBurnup,
  validatePursuitTaskForm,
  weeklyActivity,
} from '../src/lib/pursuit/pursuit.js';

const STATUSES = ['Not Started', 'In Progress', 'Completed'];
const pursuit = {
  epics: [{
    id: 'epic-p', name: 'Pursuit', pursuit: true,
    stories: [{ id: 'story-p', name: 'Pursuit tasks', pursuit: true, tasks: [
      { assigneeId: 'carol', id: 'task-1', name: 'Kickoff deck', priority: 4, pursuit: true, status: 'Not Started', targetEndDate: '2026-11-20', version: 3 },
      { assigneeId: null, id: 'task-2', name: 'Pricing', pursuit: true, status: 'In Progress', version: 1 },
    ] }],
  }],
};

test('the pursuit board\'s card form is always a task under the one Pursuit story, with a due date', () => {
  const form = createKanbanCardForm(pursuit, STATUSES, { taskOnly: true });
  assert.deepEqual([form.issueType, form.parentId, form.dueDate], ['task', 'story-p', '']);
  assert.equal(createKanbanCardForm(pursuit, STATUSES).issueType, 'story', 'the delivery board still starts on a story');
  const named = { ...form, dueDate: '2026-12-01', name: 'Send diagrams' };
  assert.deepEqual(validateKanbanCardForm(named, { project: pursuit, statusOptions: STATUSES }), {});
  assert.equal(validateKanbanCardForm({ ...named, dueDate: 'soon' }, { project: pursuit, statusOptions: STATUSES }).dueDate, 'Enter the due date as a date.');
  const payload = buildKanbanCardCreatePayload(named);
  assert.deepEqual([payload.itemType, payload.parentId, payload.item.name, payload.item.targetEndDate], ['task', 'story-p', 'Send diagrams', '2026-12-01']);
  assert.equal(buildKanbanCardCreatePayload({ ...named, dueDate: '' }).item.targetEndDate, null, 'without a due date the draft keeps its empty one');
});

test('a card shows its due date, and Overdue while it is unfinished and past it', () => {
  assert.equal(pursuitCardDue({ status: 'Not Started', targetEndDate: null }), null);
  assert.deepEqual(pursuitCardDue({ status: 'Not Started', targetEndDate: '2026-11-10' }, '2026-11-14').overdue, true);
  assert.deepEqual(pursuitCardDue({ status: 'Completed', targetEndDate: '2026-11-10' }, '2026-11-14').overdue, false);
  assert.deepEqual(pursuitCardDue({ status: 'In Progress', targetEndDate: '2026-11-14' }, '2026-11-14').overdue, false);
  assert.match(pursuitCardDue({ targetEndDate: '2026-11-10' }).label, /10/);
});

test('pursuit tasks are listed in plan order and found by id', () => {
  assert.deepEqual(pursuitTasks(pursuit).map((task) => [task.id, task.storyId]), [['task-1', 'story-p'], ['task-2', 'story-p']]);
  assert.equal(findPursuitTask(pursuit, 'task-2').name, 'Pricing');
  assert.equal(findPursuitTask(pursuit, 'missing'), null);
});

test('the task drawer sends only what changed', () => {
  const task = findPursuitTask(pursuit, 'task-1');
  const form = pursuitTaskForm(task);
  assert.deepEqual(form, { assigneeId: 'carol', description: '', dueDate: '2026-11-20', name: 'Kickoff deck', priority: 4, status: 'Not Started' });
  assert.deepEqual(pursuitTaskPatch(task, form), {});
  const people = [{ id: 'resource:r-1', name: 'Casey Contractor' }];
  assert.deepEqual(pursuitTaskPatch(task, { ...form, assigneeId: 'resource:r-1', dueDate: '', name: ' Kickoff deck v2 ', status: 'In Progress' }, people), {
    assigneeId: 'resource:r-1', assigneeName: 'Casey Contractor', name: 'Kickoff deck v2', status: 'In Progress', targetEndDate: null,
  });
  assert.deepEqual(validatePursuitTaskForm({ ...form, name: '  ' }), { name: 'Enter a task name.' });
});

test('a move goes under a delivery story and carries the versions the tasks were loaded at', () => {
  const plan = { epics: [...pursuit.epics, { id: 'epic-d', name: 'Delivery', stories: [{ id: 'story-d', name: 'Build', tasks: [] }] }] };
  assert.deepEqual(deliveryStoryOptions(plan), [{ id: 'story-d', label: 'Build (Delivery)' }]);
  assert.deepEqual(pursuitMovePayload({ project: pursuit, storyId: 'story-d', taskIds: ['task-2', 'task-1', 'gone'] }), {
    expectedVersions: { 'task-1': 3, 'task-2': 1 }, storyId: 'story-d', taskIds: ['task-1', 'task-2'],
  });
});

test('the SOW card marks each step done, current or ahead, with the latest date Odin heard of it', () => {
  const steps = sowSteps({ history: [{ at: '2026-11-01', state: 'drafting' }, { at: '2026-11-03', state: 'drafting' }, { at: '2026-11-05', state: 'awaiting_signature' }], state: 'awaiting_signature' });
  assert.deepEqual(steps.map((step) => [step.state, step.progress, step.at]), [
    ['drafting', 'done', '2026-11-03'], ['shared_for_review', 'done', null], ['awaiting_signature', 'current', '2026-11-05'], ['signed', 'ahead', null],
  ]);
});

test('the tasks burnup and weekly activity become chart series and table rows', () => {
  const burnup = tasksBurnup({ burnup: [{ date: '2026-11-01', done: 0, scope: 2 }, { date: '2026-11-08', done: 1, scope: 3 }] });
  assert.equal(burnup.ariaLabel, 'Tasks burnup: 1 of 3 tasks done.');
  assert.deepEqual(burnup.series.map((series) => series.points.map((point) => point.value)), [[2, 3], [0, 1]]);
  const activity = weeklyActivity({ channels: [{ files: [1, 0], id: 'c1', name: 'General', posts: [2, 3] }, { files: [0, 4], id: 'files', name: 'Files', posts: [0, 0] }], weeks: ['2026-11-02', '2026-11-09'] });
  assert.deepEqual(activity.series.map((series) => series.values), [[2, 3], [1, 4]]);
  assert.deepEqual(activity.channels.map((channel) => [channel.name, channel.posts, channel.files]), [['General', 5, 1], ['Files', 0, 4]]);
});

test('the board names a guest or stakeholder assignee that a board write returned unnamed, and leaves names it has', () => {
  const project = { epics: [{ id: 'e', stories: [{ id: 's', tasks: [
    { assigneeId: 'stakeholder:g1', assigneeName: '', id: 't1' },
    { assigneeId: 'user-1', assigneeName: 'Mo Member', id: 't2' },
    { assigneeId: 'stakeholder:gone', assigneeName: '', id: 't3' },
    { assigneeId: null, assigneeName: '', id: 't4' },
  ] }] }] };
  const people = [{ id: 'stakeholder:g1', name: 'Gina Guest', outside: true }, { id: 'user-1', name: 'Someone else' }];
  const named = withAssigneeNames(project, people).epics[0].stories[0].tasks.map((task) => task.assigneeName);
  assert.deepEqual(named, ['Gina Guest', 'Mo Member', '', '']);
  assert.equal(withAssigneeNames(null, people), null);
  assert.equal(project.epics[0].stories[0].tasks[0].assigneeName, '', 'the input is not changed');
});
