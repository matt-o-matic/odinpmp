// Form state for creating a card from the Kanban board. Cards are stories and tasks, so a new
// card uses the same drafts as the plan editor and the same item create call as the rest of
// the app; the board only chooses the starting status and where the card hangs.
import { workItemTemplateDefaults } from '../workflows/workflow-templates.js';
import { createStoryDraft, createTaskDraft } from './project-editor.js';

export const DEFAULT_KANBAN_CARD_STATUS = 'Not Started';
const CARD_NAME_MAX_LENGTH = 200;

/** Project statuses first, then any extra status a board column accepts. */
export function kanbanCardStatusOptions(workStatusOptions = [], columns = []) {
  const statuses = [...(workStatusOptions ?? [])];
  for (const column of columns ?? []) {
    statuses.push(...(column.statuses ?? []));
  }
  return [...new Set(statuses.map((status) => String(status ?? '').trim()).filter(Boolean))];
}

/** Stories hang off an epic and tasks off a story, matching the item create rules. */
export function kanbanCardParentOptions(project, issueType) {
  const epics = project?.epics ?? [];
  if (issueType === 'story') {
    return epics.map((epic) => ({ id: epic.id, label: epic.name || 'Untitled epic' }));
  }

  return epics.flatMap((epic) => (epic.stories ?? []).map((story) => ({
    id: story.id,
    label: `${story.name || 'Untitled story'} (${epic.name || 'Untitled epic'})`,
  })));
}

/**
 * A fresh form for one opening of the dialog. The draft id is sent as the item id, so a
 * retried or repeated submit of the same form cannot create a second card. `taskOnly` is the
 * pursuit board's form: always a task, under the board's one story.
 */
export function createKanbanCardForm(project, statusOptions = [], { taskOnly = false } = {}) {
  const issueType = !taskOnly && kanbanCardParentOptions(project, 'story').length > 0 ? 'story' : 'task';
  const parents = kanbanCardParentOptions(project, issueType);
  const status = statusOptions.includes(DEFAULT_KANBAN_CARD_STATUS)
    ? DEFAULT_KANBAN_CARD_STATUS
    : statusOptions[0] ?? DEFAULT_KANBAN_CARD_STATUS;

  return {
    assigneeId: '',
    description: '',
    draftIds: { story: createStoryDraft().id, task: createTaskDraft().id },
    dueDate: '',
    issueType,
    name: '',
    // With a single possible parent there is nothing to choose.
    parentId: parents.length === 1 ? parents[0].id : '',
    points: '',
    priority: null,
    sprintId: '',
    status,
    templateId: '',
  };
}

/** Prefills the form from a work-item template; clearing the template keeps typed values. */
export function applyKanbanCardTemplate(form, template) {
  if (!template) return { ...form, priority: null, templateId: '' };
  const defaults = workItemTemplateDefaults(template);
  return {
    ...form,
    description: defaults.description,
    points: defaults.points != null ? String(defaults.points) : form.points,
    priority: defaults.priority ?? null,
    templateId: template.id,
  };
}

/** Switching between story and task changes which parents are valid. */
export function changeKanbanCardType(form, project, issueType) {
  const parents = kanbanCardParentOptions(project, issueType);
  const parentStillValid = parents.some((parent) => parent.id === form.parentId);
  return {
    ...form,
    issueType,
    parentId: parentStillValid ? form.parentId : parents.length === 1 ? parents[0].id : '',
    // Templates are per item type, so a type change drops the chosen one.
    priority: null,
    templateId: '',
  };
}

export function validateKanbanCardForm(form, { project, statusOptions = [] } = {}) {
  const errors = {};
  const name = String(form?.name ?? '').trim();
  const parents = kanbanCardParentOptions(project, form?.issueType);

  if (!['story', 'task'].includes(form?.issueType)) {
    errors.issueType = 'Choose story or task.';
  }
  if (!name) {
    errors.name = 'Enter a card name.';
  } else if (name.length > CARD_NAME_MAX_LENGTH) {
    errors.name = `Card names can be up to ${CARD_NAME_MAX_LENGTH} characters.`;
  }
  if (!parents.some((parent) => parent.id === form?.parentId)) {
    errors.parentId = form?.issueType === 'task' ? 'Choose the story this task belongs to.' : 'Choose the epic this story belongs to.';
  }
  if (!statusOptions.includes(form?.status)) {
    errors.status = 'Choose a status.';
  }

  const points = String(form?.points ?? '').trim();
  if (points && !(/^\d+$/.test(points) && Number(points) <= 999)) {
    errors.points = 'Points must be a whole number from 0 to 999.';
  }
  if (form?.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) {
    errors.dueDate = 'Enter the due date as a date.';
  }

  return errors;
}

export function buildKanbanCardCreatePayload(form, { validUsers = [] } = {}) {
  const issueType = form.issueType === 'task' ? 'task' : 'story';
  const { tasks: _tasks, ...draft } = issueType === 'task' ? createTaskDraft() : createStoryDraft();
  const assignee = (validUsers ?? []).find((user) => user.id === form.assigneeId) ?? null;
  const points = String(form.points ?? '').trim();

  const payload = {
    item: {
      ...draft,
      assigneeId: assignee?.id ?? null,
      assigneeName: assignee?.name ?? '',
      description: String(form.description ?? '').trim() || draft.description,
      id: form.draftIds?.[issueType] ?? draft.id,
      name: String(form.name ?? '').trim(),
      points: points ? Number(points) : null,
      sprintId: form.sprintId || null,
      status: form.status,
      ...(form.dueDate ? { targetEndDate: form.dueDate } : {}),
    },
    itemType: issueType,
    parentId: form.parentId,
  };
  if (Number.isInteger(form.priority)) payload.item.priority = form.priority;
  if (form.templateId) payload.templateId = form.templateId;
  return payload;
}
