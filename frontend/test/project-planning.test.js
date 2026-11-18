import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKanbanLanes,
  buildPlanningSelection,
  createDefaultKanbanConfig,
  mergeSprintStaffingMembers,
  summarizeSprintHealth,
} from '../src/lib/projects/project-planning.js';

test('createDefaultKanbanConfig builds one column per status', () => {
  const config = createDefaultKanbanConfig(['Not Started', 'In Progress', 'Completed']);

  assert.equal(config.columns.length, 3);
  assert.deepEqual(config.columns[1], {
    defaultStatus: 'In Progress',
    key: 'in-progress',
    name: 'In Progress',
    statuses: ['In Progress'],
  });
  assert.equal(config.includeBacklog, true);
});

test('mergeSprintStaffingMembers overlays sprint staffing onto project members', () => {
  const rows = mergeSprintStaffingMembers(
    {
      staffing: [
        {
          allocationPctOverride: 50,
          capacityHours: 20,
          notes: 'Focused sprint',
          userId: 'user-1',
        },
      ],
    },
    [
      { id: 'user-1', name: 'Grace Hopper', projectAllocation: 75, role: 'admin' },
      { id: 'user-2', name: 'Ada Lovelace', projectAllocation: 40, role: 'user' },
    ],
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].capacityHours, 20);
  assert.equal(rows[0].defaultAllocation, 75);
  assert.equal(rows[1].capacityHours, null);
});

test('summarizeSprintHealth reports over-capacity and understaffed states', () => {
  const overCapacity = summarizeSprintHealth({
    summary: {
      capacityHours: 20,
      completedPercent: 40,
      totalHours: 28,
      totalItems: 4,
      totalPoints: 8,
    },
  });
  const understaffed = summarizeSprintHealth({
    summary: {
      capacityHours: 0,
      totalHours: 12,
      totalItems: 2,
      totalPoints: 3,
    },
  });

  assert.equal(overCapacity.isOverCapacity, true);
  assert.equal(overCapacity.remainingHours, -8);
  assert.equal(understaffed.isUnderstaffed, true);
});

test('buildKanbanLanes groups cards by swimlane and status column', () => {
  const lanes = buildKanbanLanes(
    [
      { assigneeId: 'user-1', assigneeName: 'Grace Hopper', id: 'story-1', issueType: 'story', status: 'In Progress' },
      { assigneeId: 'user-1', assigneeName: 'Grace Hopper', id: 'task-1', issueType: 'task', status: 'Completed' },
      { assigneeId: 'user-2', assigneeName: 'Ada Lovelace', id: 'task-2', issueType: 'task', status: 'In Progress' },
    ],
    [
      { defaultStatus: 'Not Started', name: 'Todo', statuses: ['Not Started'] },
      { defaultStatus: 'In Progress', name: 'Doing', statuses: ['In Progress'] },
      { defaultStatus: 'Completed', name: 'Done', statuses: ['Completed'] },
    ],
    'assignee',
  );

  assert.equal(lanes.length, 2);
  assert.equal(lanes[0].columns[1].cards.length, 1);
  assert.equal(lanes[0].columns[2].cards.length, 1);
});

test('buildPlanningSelection resolves story and task items back into editor selections', () => {
  const project = {
    epics: [
      {
        id: 'epic-1',
        stories: [
          {
            id: 'story-1',
            tasks: [{ id: 'task-1' }],
          },
        ],
      },
    ],
  };

  assert.deepEqual(
    buildPlanningSelection(project, { id: 'story-1', issueType: 'story' }),
    { epicId: 'epic-1', storyId: 'story-1', type: 'story' },
  );
  assert.deepEqual(
    buildPlanningSelection(project, { id: 'task-1', issueType: 'task' }),
    { epicId: 'epic-1', storyId: 'story-1', taskId: 'task-1', type: 'task' },
  );
});
