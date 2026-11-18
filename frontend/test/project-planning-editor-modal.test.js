import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePlanningEditorModal,
  createPlanningEditorModalState,
  openPlanningEditorModal,
  selectPlanningEditorModalItem,
} from '../src/lib/projects/project-planning-editor-modal.js';

test('createPlanningEditorModalState starts closed on the project selection', () => {
  assert.deepEqual(createPlanningEditorModalState(), {
    draftProject: null,
    open: false,
    selection: { type: 'project' },
  });
});

test('openPlanningEditorModal opens with a normalized planning selection', () => {
  const project = {
    epics: [],
    id: 'project-1',
    name: 'Demo project',
  };
  const state = openPlanningEditorModal(
    createPlanningEditorModalState(),
    {
      epicId: 'epic-1',
      storyId: 'story-1',
      type: 'story',
    },
    project,
  );

  assert.equal(state.open, true);
  assert.deepEqual(state.selection, {
    epicId: 'epic-1',
    storyId: 'story-1',
    type: 'story',
  });
  assert.notEqual(state.draftProject, project);
  assert.deepEqual(state.draftProject, project);
});

test('selectPlanningEditorModalItem updates the local modal selection without closing it', () => {
  const opened = openPlanningEditorModal(
    createPlanningEditorModalState(),
    {
      epicId: 'epic-1',
      storyId: 'story-1',
      type: 'story',
    },
    {
      epics: [],
      id: 'project-1',
      name: 'Demo project',
    },
  );

  const selected = selectPlanningEditorModalItem(opened, {
    epicId: 'epic-1',
    storyId: 'story-1',
    taskId: 'task-1',
    type: 'task',
  });

  assert.equal(selected.open, true);
  assert.deepEqual(selected.selection, {
    epicId: 'epic-1',
    storyId: 'story-1',
    taskId: 'task-1',
    type: 'task',
  });
  assert.deepEqual(selected.draftProject, {
    epics: [],
    id: 'project-1',
    name: 'Demo project',
  });
});

test('closePlanningEditorModal closes and resets selection back to the project', () => {
  const opened = openPlanningEditorModal(
    createPlanningEditorModalState(),
    {
      epicId: 'epic-1',
      type: 'epic',
    },
    {
      epics: [],
      id: 'project-1',
      name: 'Demo project',
    },
  );

  assert.deepEqual(closePlanningEditorModal(opened), {
    draftProject: null,
    open: false,
    selection: { type: 'project' },
  });
});

test('modal draft is isolated from the source project until explicitly applied', () => {
  const project = {
    epics: [
      {
        id: 'epic-1',
        name: 'Epic one',
        stories: [
          {
            id: 'story-1',
            name: 'Original story',
            tasks: [],
          },
        ],
      },
    ],
    id: 'project-1',
    name: 'Demo project',
  };

  const opened = openPlanningEditorModal(
    createPlanningEditorModalState(),
    {
      epicId: 'epic-1',
      storyId: 'story-1',
      type: 'story',
    },
    project,
  );

  opened.draftProject.epics[0].stories[0].name = 'Edited in modal';

  assert.equal(project.epics[0].stories[0].name, 'Original story');
  assert.equal(opened.draftProject.epics[0].stories[0].name, 'Edited in modal');
});
