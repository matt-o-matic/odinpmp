import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  RELATION_CHOICES,
  flattenProjectItems,
  groupRelations,
  projectSelectionForItem,
  relatedItemRoute,
  relationCandidates,
  relationCreateRequest,
} from '../src/lib/projects/work-item-relations.js';

const componentSource = readFileSync(new URL('../src/components/projects/WorkItemRelations.vue', import.meta.url), 'utf8');
const ticketsViewSource = readFileSync(new URL('../src/views/TicketsView.vue', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../src/components/projects/ProjectWorkbenchEditor.vue', import.meta.url), 'utf8');

const project = {
  epics: [{ id: 'epic-1', name: 'Checkout', status: 'In Progress', stories: [{ id: 'story-1', name: 'Pay by card', status: 'In Progress', tasks: [{ id: 'task-1', name: 'Card form', status: 'Not Started' }] }] }],
  tickets: [{ id: 'ticket-1', name: 'Card declined twice', status: 'open' }, { id: 'ticket-2', name: 'Double charge', status: 'new' }],
};

function described(id, relationType, direction, relatedItem) {
  return { direction, id, relatedItem: { available: true, ...relatedItem }, relationType };
}

test('relations group under human labels in both directions', () => {
  const groups = groupRelations([
    described('r1', 'caused_by', 'outgoing', { id: 'story-1', itemType: 'story', name: 'Pay by card' }),
    described('r2', 'blocks', 'incoming', { id: 'task-1', itemType: 'task', name: 'Card form' }),
    described('r3', 'duplicate_of', 'incoming', { id: 'ticket-2', itemType: 'ticket', name: 'Double charge' }),
    described('r4', 'blocks', 'outgoing', { id: 'epic-1', itemType: 'epic', name: 'Checkout' }),
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.relations.map((relation) => relation.id)]), [
    ['Blocks', ['r4']], ['Blocked by', ['r2']], ['Caused by', ['r1']], ['Duplicated by', ['r3']],
  ]);
  assert.deepEqual(RELATION_CHOICES.map((choice) => choice.label), [
    'blocks', 'is blocked by', 'is caused by', 'causes', 'affects', 'is affected by', 'is a duplicate of', 'is duplicated by',
  ]);
});

test('the item picker lists the project items except this one and items already linked the same way', () => {
  const items = flattenProjectItems(project);
  assert.deepEqual(items.map((item) => [item.id, item.itemType]), [['epic-1', 'epic'], ['story-1', 'story'], ['task-1', 'task'], ['ticket-1', 'ticket'], ['ticket-2', 'ticket']]);
  const relations = [described('r1', 'caused_by', 'outgoing', { id: 'story-1', itemType: 'story' })];
  const ids = (choiceKey, query = '') => relationCandidates({ choiceKey, itemId: 'ticket-1', items, query, relations }).map((item) => item.id);
  assert.deepEqual(ids('caused_by:outgoing'), ['epic-1', 'task-1', 'ticket-2']);
  assert.deepEqual(ids('caused_by:incoming'), ['epic-1', 'story-1', 'task-1', 'ticket-2'], 'the other direction is a different link');
  assert.deepEqual(ids('blocks:outgoing', 'card'), ['story-1', 'task-1']);
  assert.deepEqual(ids('blocks:outgoing', 'ticket double'), ['ticket-2'], 'type names match too');
});

test('an incoming choice is stored from the other item, and related items open where they live', () => {
  assert.deepEqual(relationCreateRequest({ choiceKey: 'blocks:outgoing', itemId: 'story-1', otherItemId: 'task-1' }), { fromItemId: 'story-1', payload: { relationType: 'blocks', toItemId: 'task-1' } });
  assert.deepEqual(relationCreateRequest({ choiceKey: 'caused_by:incoming', itemId: 'story-1', otherItemId: 'ticket-1' }), { fromItemId: 'ticket-1', payload: { relationType: 'caused_by', toItemId: 'story-1' } });
  assert.deepEqual(relatedItemRoute('project-1', { id: 'ticket-1', itemType: 'ticket' }), { name: 'tickets', query: { project: 'project-1', ticket: 'ticket-1' } });
  assert.deepEqual(relatedItemRoute('project-1', { id: 'task-1', itemType: 'task' }), { name: 'project-detail', params: { projectId: 'project-1' }, query: { item: 'task-1' } });
  assert.deepEqual(projectSelectionForItem(project, 'task-1'), { epicId: 'epic-1', storyId: 'story-1', taskId: 'task-1', type: 'task' });
  assert.deepEqual(projectSelectionForItem(project, 'story-1'), { epicId: 'epic-1', storyId: 'story-1', type: 'story' });
  assert.equal(projectSelectionForItem(project, 'ticket-1'), null);
});

test('the relations section uses app dialogs, labels its icon buttons and hides edits without plan-edit rights', () => {
  assert.match(componentSource, /RequirementsDialog/);
  assert.match(componentSource, /RequirementsConfirmDialog/);
  assert.doesNotMatch(componentSource, /window\.confirm|\balert\(/);
  assert.doesNotMatch(componentSource, /<(?:a|button|i|span|RouterLink)\b[^>]*\stitle=/, 'no title-attribute tooltips');
  assert.match(componentSource, /:aria-label="`Remove relation: /);
  assert.match(componentSource, /v-if="canEdit"/);
  assert.match(componentSource, /result\.canEdit === true/);
  assert.match(componentSource, /width: 2\.75rem; height: 2\.75rem/);
});

test('ticket detail and the work-item editor both show the relations section, not raw item ids', () => {
  assert.match(ticketsViewSource, /<WorkItemRelations /);
  assert.doesNotMatch(ticketsViewSource, /relation\.toItemId === detail\.id/);
  assert.match(editorSource, /<WorkItemRelations/);
});
