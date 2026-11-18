import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKanbanCardCreatePayload,
  changeKanbanCardType,
  createKanbanCardForm,
  kanbanCardParentOptions,
  kanbanCardStatusOptions,
  validateKanbanCardForm,
} from '../src/lib/projects/kanban-card-create.js';

const STATUSES = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];

const project = {
  epics: [
    { id: 'epic-1', name: 'Delivery', stories: [{ id: 'story-1', name: 'Release pilot', tasks: [] }] },
    { id: 'epic-2', name: 'Support', stories: [] },
  ],
};

test('kanbanCardStatusOptions lists project statuses, then extra column statuses, without duplicates', () => {
  const columns = [{ statuses: ['In Progress', 'Blocked'] }, { statuses: ['Completed'] }];
  assert.deepEqual(kanbanCardStatusOptions(STATUSES, columns), [...STATUSES, 'Blocked']);
});

test('createKanbanCardForm starts as a story in Not Started with stable draft ids', () => {
  const form = createKanbanCardForm(project, STATUSES);
  assert.equal(form.issueType, 'story');
  assert.equal(form.status, 'Not Started');
  assert.equal(form.parentId, '', 'two epics means the user must choose one');
  assert.match(form.draftIds.story, /^draft-story-/);
  assert.match(form.draftIds.task, /^draft-task-/);
  assert.ok(form.draftIds.story.length <= 36, 'item ids are limited to 36 characters');
  assert.notEqual(createKanbanCardForm(project, STATUSES).draftIds.story, form.draftIds.story);
});

test('createKanbanCardForm preselects the only parent and falls back to tasks when there are no epics', () => {
  const oneEpic = { epics: [project.epics[0]] };
  assert.equal(createKanbanCardForm(oneEpic, STATUSES).parentId, 'epic-1');
  assert.equal(createKanbanCardForm({ epics: [] }, STATUSES).issueType, 'task');
  assert.equal(createKanbanCardForm(project, ['In Progress']).status, 'In Progress');
});

test('kanbanCardParentOptions offers epics for stories and stories for tasks', () => {
  assert.deepEqual(kanbanCardParentOptions(project, 'story').map((option) => option.id), ['epic-1', 'epic-2']);
  assert.deepEqual(kanbanCardParentOptions(project, 'task'), [{ id: 'story-1', label: 'Release pilot (Delivery)' }]);
});

test('changeKanbanCardType keeps a still-valid parent and otherwise resets or preselects', () => {
  const form = { ...createKanbanCardForm(project, STATUSES), parentId: 'epic-1' };
  const asTask = changeKanbanCardType(form, project, 'task');
  assert.equal(asTask.issueType, 'task');
  assert.equal(asTask.parentId, 'story-1', 'the only story is preselected');
  assert.equal(changeKanbanCardType(asTask, project, 'story').parentId, '');
});

test('validateKanbanCardForm requires a name, a parent of the right type and a known status', () => {
  const form = createKanbanCardForm(project, STATUSES);
  assert.deepEqual(Object.keys(validateKanbanCardForm({ ...form, name: '   ' }, { project, statusOptions: STATUSES })).sort(), ['name', 'parentId']);
  assert.ok(validateKanbanCardForm({ ...form, name: 'x'.repeat(201), parentId: 'epic-1' }, { project, statusOptions: STATUSES }).name);
  assert.ok(validateKanbanCardForm({ ...form, name: 'A', parentId: 'story-1' }, { project, statusOptions: STATUSES }).parentId);
  assert.ok(validateKanbanCardForm({ ...form, name: 'A', parentId: 'epic-1', status: 'Bogus' }, { project, statusOptions: STATUSES }).status);
  assert.ok(validateKanbanCardForm({ ...form, name: 'A', parentId: 'epic-1', points: -1 }, { project, statusOptions: STATUSES }).points);
  assert.ok(validateKanbanCardForm({ ...form, name: 'A', parentId: 'epic-1', points: 1.5 }, { project, statusOptions: STATUSES }).points);
  assert.deepEqual(validateKanbanCardForm({ ...form, name: 'A', parentId: 'epic-1', points: 3, status: 'Review' }, { project, statusOptions: STATUSES }), {});
});

test('buildKanbanCardCreatePayload builds the item create request from the draft model', () => {
  const form = {
    ...createKanbanCardForm(project, STATUSES),
    assigneeId: 'user-1',
    name: '  Ship the pilot  ',
    parentId: 'epic-1',
    points: 5,
    sprintId: 'sprint-1',
    status: 'In Progress',
  };
  const payload = buildKanbanCardCreatePayload(form, { validUsers: [{ id: 'user-1', name: 'Pat' }] });

  assert.equal(payload.itemType, 'story');
  assert.equal(payload.parentId, 'epic-1');
  assert.equal(payload.item.id, form.draftIds.story);
  assert.equal(payload.item.name, 'Ship the pilot');
  assert.equal(payload.item.status, 'In Progress');
  assert.equal(payload.item.assigneeName, 'Pat');
  assert.equal(payload.item.points, 5);
  assert.equal(payload.item.sprintId, 'sprint-1');
  assert.equal(payload.item.priority, 4);
  assert.equal('tasks' in payload.item, false, 'a new story card starts without placeholder tasks');

  const taskPayload = buildKanbanCardCreatePayload({ ...form, issueType: 'task', parentId: 'story-1', points: '', sprintId: '', assigneeId: '' });
  assert.equal(taskPayload.itemType, 'task');
  assert.equal(taskPayload.item.id, form.draftIds.task);
  assert.equal(taskPayload.item.points, null);
  assert.equal(taskPayload.item.sprintId, null);
  assert.equal(taskPayload.item.assigneeId, null);
});
