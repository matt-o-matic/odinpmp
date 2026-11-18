import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKanbanDrawerState,
  toggleKanbanDrawer,
} from '../src/lib/projects/project-kanban-shell.js';

test('createKanbanDrawerState starts with both drawers closed', () => {
  assert.deepEqual(createKanbanDrawerState(), {
    filtersOpen: false,
    layoutOpen: false,
  });
});

test('toggleKanbanDrawer opens one drawer at a time and toggles the same drawer closed', () => {
  const initial = createKanbanDrawerState();
  const filtersOpen = toggleKanbanDrawer(initial, 'filters');
  const layoutOpen = toggleKanbanDrawer(filtersOpen, 'layout');
  const layoutClosed = toggleKanbanDrawer(layoutOpen, 'layout');

  assert.deepEqual(filtersOpen, {
    filtersOpen: true,
    layoutOpen: false,
  });
  assert.deepEqual(layoutOpen, {
    filtersOpen: false,
    layoutOpen: true,
  });
  assert.deepEqual(layoutClosed, {
    filtersOpen: false,
    layoutOpen: false,
  });
});
