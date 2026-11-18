import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyKanbanPreset,
  createKanbanConfigPayload,
  createKanbanPreset,
  hydrateKanbanConfig,
} from '../src/lib/projects/project-kanban-config.js';

test('hydrateKanbanConfig adds stable client ids to editable columns', () => {
  const config = hydrateKanbanConfig({
    columns: [
      {
        defaultStatus: 'In Progress',
        name: 'Doing',
        statuses: ['In Progress', 'At Risk'],
      },
    ],
  }, ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed']);

  assert.equal(config.columns.length, 1);
  assert.equal(typeof config.columns[0].clientId, 'string');
  assert.equal(config.columns[0].clientId.length > 0, true);
  assert.equal(config.columns[0].name, 'Doing');
});

test('createKanbanConfigPayload strips client ids and normalizes legacy preset shapes', () => {
  const payload = createKanbanConfigPayload({
    assigneeIds: ['user-grace'],
    columns: [
      {
        clientId: 'local-column-1',
        defaultStatus: 'Completed',
        name: 'Done Done',
        statuses: ['Completed'],
      },
    ],
    presets: [
      {
        assigneeIds: ['user-ada'],
        id: 'legacy-preset',
        includeBacklog: false,
        issueTypes: ['task'],
        name: 'Tasks only',
        search: 'owner',
        selectedSprintIds: ['sprint-1'],
        statusValues: ['In Progress'],
      },
    ],
    swimlane: 'assignee',
  }, ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed']);

  assert.deepEqual(payload.columns, [
    {
      defaultStatus: 'Completed',
      key: 'done-done',
      name: 'Done Done',
      statuses: ['Completed'],
    },
  ]);
  assert.deepEqual(payload.presets, [
    {
      filters: {
        assigneeIds: ['user-ada'],
        hideDone: false,
        includeBacklog: false,
        issueTypes: ['task'],
        search: 'owner',
        selectedSprintIds: ['sprint-1'],
        statusValues: ['In Progress'],
      },
      id: 'legacy-preset',
      name: 'Tasks only',
    },
  ]);
});

test('createKanbanPreset and applyKanbanPreset preserve the current layout while restoring saved filters', () => {
  const base = hydrateKanbanConfig({
    assigneeIds: ['user-grace'],
    columns: [
      {
        defaultStatus: 'Not Started',
        name: 'Ready',
        statuses: ['Not Started'],
      },
    ],
    search: 'routing',
  }, ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed']);

  const preset = createKanbanPreset('Grace scope', base);
  const next = applyKanbanPreset({
    ...base,
    assigneeIds: [],
    search: '',
  }, preset, ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed']);

  assert.equal(preset.name, 'Grace scope');
  assert.equal(typeof preset.id, 'string');
  assert.deepEqual(next.assigneeIds, ['user-grace']);
  assert.equal(next.search, 'routing');
  assert.equal(next.columns[0].name, 'Ready');
});
