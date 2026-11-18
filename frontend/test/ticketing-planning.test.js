import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTicketQuery } from '../src/lib/api/client.js';
import { KANBAN_ISSUE_TYPES, hydrateKanbanConfig } from '../src/lib/projects/project-kanban-config.js';
import { buildKanbanLanes, buildPlanningSelection } from '../src/lib/projects/project-planning.js';

const COLUMNS = [
  { clientId: 'c1', defaultStatus: 'new', name: 'New', statuses: ['new'] },
  { clientId: 'c2', defaultStatus: 'open', name: 'Open', statuses: ['open'] },
];

function projectWithTickets(tickets) {
  return {
    epics: [
      {
        id: 'epic-1',
        name: 'Epic One',
        stories: [
          { id: 'story-1', name: 'Story One', tasks: [{ id: 'task-1', issueType: 'task', name: 'Task One' }] },
        ],
      },
    ],
    id: 'project-1',
    tickets,
  };
}

test('AC4.2 selecting a parentless ticket resolves to a ticket selection', () => {
  const project = projectWithTickets([{ id: 'ticket-1', issueType: 'ticket', name: 'Defect', parentId: null }]);

  const selection = buildPlanningSelection(project, { id: 'ticket-1', issueType: 'ticket' });

  assert.deepEqual(selection, { parentId: null, ticketId: 'ticket-1', type: 'ticket' });
});

test('AC4.2 selecting a parented ticket carries its parent reference', () => {
  const project = projectWithTickets([{ id: 'ticket-2', issueType: 'ticket', name: 'Defect', parentId: 'story-1' }]);

  const selection = buildPlanningSelection(project, { id: 'ticket-2', issueType: 'ticket' });

  assert.deepEqual(selection, { parentId: 'story-1', ticketId: 'ticket-2', type: 'ticket' });
});

test('a ticket that is not in the project falls back to the project selection', () => {
  const project = projectWithTickets([]);

  assert.deepEqual(buildPlanningSelection(project, { id: 'ghost', issueType: 'ticket' }), { type: 'project' });
});

test('AC4.5 epic, story, and task selection is unchanged', () => {
  const project = projectWithTickets([{ id: 'ticket-1', issueType: 'ticket', name: 'Defect', parentId: null }]);

  assert.deepEqual(
    buildPlanningSelection(project, { id: 'story-1', issueType: 'story' }),
    { epicId: 'epic-1', storyId: 'story-1', type: 'story' },
  );
  assert.deepEqual(
    buildPlanningSelection(project, { id: 'task-1', issueType: 'task' }),
    { epicId: 'epic-1', storyId: 'story-1', taskId: 'task-1', type: 'task' },
  );
});

test('AC4.3 a parentless ticket lands in the no-epic lane when swimlaning by epic', () => {
  const cards = [
    { epicId: 'epic-1', epicName: 'Epic One', id: 'task-1', issueType: 'task', status: 'new' },
    { epicId: null, id: 'ticket-1', issueType: 'ticket', status: 'new' },
  ];

  const lanes = buildKanbanLanes(cards, COLUMNS, 'epic');
  const noEpicLane = lanes.find((lane) => lane.key === 'no-epic');

  assert.ok(noEpicLane, 'the existing no-epic lane is reused rather than a new key added');
  assert.equal(noEpicLane.label, 'No epic');
  assert.deepEqual(noEpicLane.columns[0].cards.map((card) => card.id), ['ticket-1']);
});

test('AC4.3 an off-sprint ticket lands in the backlog lane when swimlaning by sprint', () => {
  const cards = [
    { id: 'task-1', issueType: 'task', sprintId: 'sprint-1', sprintName: 'Sprint 1', status: 'new' },
    { id: 'ticket-1', issueType: 'ticket', sprintId: null, status: 'new' },
  ];

  const lanes = buildKanbanLanes(cards, COLUMNS, 'sprint');
  const backlog = lanes.find((lane) => lane.key === 'backlog');

  assert.ok(backlog, 'the existing backlog lane is reused');
  assert.equal(backlog.label, 'Backlog');
  assert.deepEqual(backlog.columns[0].cards.map((card) => card.id), ['ticket-1']);
});

test('tickets get their own lane and label when swimlaning by issue type', () => {
  const cards = [
    { id: 'task-1', issueType: 'task', status: 'new' },
    { id: 'ticket-1', issueType: 'ticket', status: 'open' },
  ];

  const lanes = buildKanbanLanes(cards, COLUMNS, 'issueType');
  const ticketLane = lanes.find((lane) => lane.key === 'ticket');

  assert.ok(ticketLane);
  assert.equal(ticketLane.label, 'Ticket');
  assert.deepEqual(ticketLane.columns[1].cards.map((card) => card.id), ['ticket-1']);
});

test('the kanban issue-type filter accepts ticket and rejects unknown types', () => {
  assert.deepEqual(KANBAN_ISSUE_TYPES, ['story', 'task', 'ticket']);

  const config = hydrateKanbanConfig({ issueTypes: ['story', 'ticket', 'epic', ''] }, ['new', 'open']);

  assert.deepEqual(config.issueTypes, ['story', 'ticket']);
});

test('buildTicketQuery omits empty filters and joins arrays as CSV', () => {
  assert.equal(buildTicketQuery({}), '');
  assert.equal(buildTicketQuery({ categories: [], search: '' }), '');
  assert.equal(
    buildTicketQuery({ limit: 25, projectIds: ['a', 'b'], severities: ['S1', 'S2'] }),
    'limit=25&projectIds=a%2Cb&severities=S1%2CS2',
  );
});

test('AC4.1 a project whose only items are tickets still produces lanes', () => {
  const cards = [{ id: 'ticket-1', issueType: 'ticket', status: 'new' }];

  const lanes = buildKanbanLanes(cards, COLUMNS, 'none');

  assert.equal(lanes.length, 1);
  assert.deepEqual(lanes[0].columns[0].cards.map((card) => card.id), ['ticket-1']);
});
