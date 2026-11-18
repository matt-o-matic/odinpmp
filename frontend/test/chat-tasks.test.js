import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assigneeInitials,
  columnForCard,
  filterTaskCards,
  findItemVersion,
  normalizeTaskFilter,
  quickAddPayload,
  quickAddPlan,
  backlogEpicPayload,
  taskCardMeta,
  taskColumns,
  taskLocation,
} from '../src/lib/chat/chat-tasks.js';

const cards = [
  { assigneeId: 'u1', id: 'a', issueType: 'story', name: 'Draft plan', status: 'Not Started' },
  { assigneeId: 'u2', id: 'b', issueType: 'task', name: 'Book room', status: 'In Progress' },
  { assigneeId: 'u1', id: 'c', issueType: 'task', name: 'Send notes', status: 'Completed' },
];

test('Tasks shows open work by default, the viewer\'s open work for Mine, and everything for All', () => {
  assert.deepEqual(filterTaskCards(cards).map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(filterTaskCards(cards, { filter: 'mine', userId: 'u1' }).map(({ id }) => id), ['a']);
  assert.deepEqual(filterTaskCards(cards, { filter: 'mine', userId: '' }), []);
  assert.deepEqual(filterTaskCards(cards, { filter: 'all' }).map(({ id }) => id), ['a', 'b', 'c']);
  assert.equal(normalizeTaskFilter('nonsense'), 'open');
  assert.equal(normalizeTaskFilter('mine'), 'mine');
});

test('a card shows its type, due date or sprint, and a raised priority', () => {
  assert.deepEqual(taskCardMeta({ issueType: 'story', priority: 1, status: 'In Progress', targetEndDate: '2026-11-10' }, '2026-11-15'), {
    due: '2026-11-10', overdue: true, priority: { label: 'Highest priority', level: 1 }, sprint: '', type: 'Story',
  });
  const plain = taskCardMeta({ issueType: 'task', priority: 4, sprintName: 'Sprint 3', status: 'Completed', targetEndDate: null }, '2026-11-15');
  assert.equal(plain.sprint, 'Sprint 3');
  assert.equal(plain.priority, null);
  assert.equal(plain.overdue, false);
  assert.equal(assigneeInitials('Pat Seller'), 'PS');
  assert.equal(assigneeInitials('Odin'), 'OD');
  assert.equal(assigneeInitials(''), '');
});

test('cards fall into the column they were dropped in, else the first that takes their status', () => {
  const columns = [
    { key: 'todo', statuses: ['Not Started'] },
    { key: 'doing', statuses: ['In Progress', 'Review'] },
    { key: 'review', statuses: ['Review'] },
    { key: 'done', statuses: ['Completed'] },
  ];
  assert.equal(columnForCard(columns, { boardColumn: 'review', status: 'Review' }).key, 'review');
  assert.equal(columnForCard(columns, { boardColumn: 'gone', status: 'Review' }).key, 'doing');
  assert.equal(columnForCard(columns, { status: 'Unknown' }), null);
  assert.deepEqual(taskColumns(columns, cards).map((column) => column.cards.map(({ id }) => id)), [['a'], ['b'], [], ['c']]);
});

const project = {
  epics: [
    { id: 'e1', name: 'Discovery', stories: [{ id: 's1', name: 'Interviews', tasks: [{ id: 't1', version: 7 }], version: 3 }] },
    { id: 'e2', name: 'Build', stories: [] },
  ],
};

test('the item version comes from the project tree', () => {
  assert.equal(findItemVersion(project, 's1'), 3);
  assert.equal(findItemVersion(project, 't1'), 7);
  assert.equal(findItemVersion(project, 'missing'), null);
});

test('quick add makes a story under an epic, a pursuit task under the board story, or nothing without a parent', () => {
  const delivery = quickAddPlan(project);
  assert.equal(delivery.issueType, 'story');
  assert.deepEqual(delivery.parents.map(({ id }) => id), ['e1', 'e2']);
  // With no epic and no story, the first quick add starts a "Backlog" epic.
  assert.deepEqual(quickAddPlan({ epics: [] }), { issueType: 'story', parents: [], pursuit: false, startsBacklog: true });
  assert.deepEqual(backlogEpicPayload('To Do'), { item: { name: 'Backlog', status: 'To Do' }, itemType: 'epic', parentId: null });
  const pursuit = quickAddPlan(null, { kind: 'engagement', storyId: 'story-pursuit' });
  assert.deepEqual(pursuit, { issueType: 'task', parents: [{ id: 'story-pursuit', label: 'Pursuit' }], pursuit: true });

  const payload = quickAddPayload({ name: '  Call the client ', parentId: 'e2', plan: delivery, project });
  assert.equal(payload.itemType, 'story');
  assert.equal(payload.parentId, 'e2');
  assert.equal(payload.item.name, 'Call the client');
  assert.equal(payload.item.status, 'Not Started');
  assert.match(payload.item.id, /story/);
  const task = quickAddPayload({ name: 'Prep deck', parentId: 'story-pursuit', plan: pursuit, project: null });
  assert.equal(task.itemType, 'task');
  assert.equal(task.parentId, 'story-pursuit');
});

test('a card opens its item in the project, or the engagement\'s board', () => {
  assert.deepEqual(taskLocation('p1', { id: 'a' }), { name: 'project-detail', params: { projectId: 'p1' }, query: { item: 'a' } });
  assert.deepEqual(taskLocation('p1', { id: 'a' }, { kind: 'engagement' }), { name: 'engagement-detail', params: { projectId: 'p1', section: 'board' } });
});
