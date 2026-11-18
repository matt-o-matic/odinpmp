import { cloneProject, createProjectSelection } from './project-editor.js';

export function createPlanningEditorModalState() {
  return {
    draftProject: null,
    open: false,
    selection: { type: 'project' },
  };
}

export function openPlanningEditorModal(state, selection, project = null) {
  return {
    ...(state ?? createPlanningEditorModalState()),
    draftProject: project ? cloneProject(project) : null,
    open: true,
    selection: createProjectSelection(selection),
  };
}

export function selectPlanningEditorModalItem(state, selection) {
  return {
    ...(state ?? createPlanningEditorModalState()),
    selection: createProjectSelection(selection),
  };
}

export function updatePlanningEditorModalDraftProject(state, project = null) {
  return {
    ...(state ?? createPlanningEditorModalState()),
    draftProject: project ? cloneProject(project) : null,
  };
}

export function closePlanningEditorModal(state) {
  return {
    ...(state ?? createPlanningEditorModalState()),
    draftProject: null,
    open: false,
    selection: { type: 'project' },
  };
}
