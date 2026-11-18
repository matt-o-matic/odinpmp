// The Tasks tab of a channel in Odin Chat: the project's work as
// a small board or list. A delivery project shows its stories and tasks, an engagement its
// pursuit tasks. These helpers read the kanban API's cards and the project tree the item API
// returns; they never call the server.
import { buildKanbanCardCreatePayload, createKanbanCardForm, kanbanCardParentOptions } from '../projects/kanban-card-create.js';

export const DONE_STATUS = 'Completed';

export const TASK_FILTERS = Object.freeze([
  { id: 'open', label: 'Open' },
  { id: 'mine', label: 'Mine' },
  { id: 'all', label: 'All' },
]);

export function normalizeTaskFilter(value) {
  return TASK_FILTERS.some((filter) => filter.id === value) ? value : 'open';
}

/** Open work by default, open work assigned to the viewer for Mine, everything for All. */
export function filterTaskCards(cards = [], { filter = 'open', userId = '' } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  if (filter === 'all') return list;
  const open = list.filter((card) => card.status !== DONE_STATUS);
  return filter === 'mine' ? open.filter((card) => userId && card.assigneeId === userId) : open;
}

/** Up to two initials for an assignee, or '' when nobody is assigned. */
export function assigneeInitials(name = '') {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts.at(-1)[0]}`).toUpperCase();
}

const PRIORITY_LABELS = { 1: 'Highest priority', 2: 'High priority', 3: 'Raised priority' };

/** What a card shows besides its name: type, when it's due (or its sprint), and a raised priority. */
export function taskCardMeta(card, today = new Date().toISOString().slice(0, 10)) {
  const due = card?.targetEndDate ? String(card.targetEndDate).slice(0, 10) : '';
  const done = card?.status === DONE_STATUS;
  const priority = Number(card?.priority);
  return {
    due,
    overdue: Boolean(due) && !done && due < today,
    priority: PRIORITY_LABELS[priority] ? { label: PRIORITY_LABELS[priority], level: priority } : null,
    sprint: due ? '' : String(card?.sprintName ?? ''),
    type: card?.issueType === 'story' ? 'Story' : 'Task',
  };
}

/** Each column with the cards that show in it, in board order. */
export function taskColumns(columns = [], cards = []) {
  return (columns ?? []).map((column) => ({
    ...column,
    cards: cards.filter((card) => columnForCard(columns, card)?.key === column.key),
  }));
}

/** The column a card sits in: the one it was dropped in, else the first that takes its status. */
export function columnForCard(columns = [], card) {
  const list = columns ?? [];
  return list.find((column) => card?.boardColumn && column.key === card.boardColumn && (column.statuses ?? []).includes(card.status))
    ?? list.find((column) => (column.statuses ?? []).includes(card?.status))
    ?? null;
}

/** The current version of a story or task in the project tree, for the item API's precondition. */
export function findItemVersion(project, itemId) {
  for (const epic of project?.epics ?? []) {
    for (const story of epic.stories ?? []) {
      if (story.id === itemId) return Number(story.version ?? 1);
      for (const task of story.tasks ?? []) {
        if (task.id === itemId) return Number(task.version ?? 1);
      }
    }
  }
  return null;
}

/**
 * What quick add creates. An engagement adds a pursuit task under its board's story. A delivery
 * project adds a story under an epic, or a task under a story when it has stories but, oddly, no
 * epic to choose. A project with neither starts a "Backlog" epic with its first story, since every
 * story needs an epic.
 */
export const BACKLOG_EPIC_NAME = 'Backlog';

export function quickAddPlan(project, { kind = 'delivery', storyId = '' } = {}) {
  if (kind === 'engagement') {
    return storyId ? { issueType: 'task', parents: [{ id: storyId, label: 'Pursuit' }], pursuit: true } : { issueType: 'task', parents: [], pursuit: true };
  }
  const epics = kanbanCardParentOptions(project, 'story');
  if (epics.length) return { issueType: 'story', parents: epics, pursuit: false };
  const stories = kanbanCardParentOptions(project, 'task');
  if (stories.length) return { issueType: 'task', parents: stories, pursuit: false };
  return { issueType: 'story', parents: [], pursuit: false, startsBacklog: true };
}

/** The item API's create body for the "Backlog" epic a project's first quick add starts. */
export function backlogEpicPayload(status = 'Not Started') {
  return { item: { name: BACKLOG_EPIC_NAME, status }, itemType: 'epic', parentId: null };
}

/** The item API's create body for a quick-added card, as the board's own New card sends it. */
export function quickAddPayload({ name, parentId, plan, project, status = 'Not Started' }) {
  const form = {
    ...createKanbanCardForm(project, [status], { taskOnly: plan.issueType === 'task' }),
    issueType: plan.issueType,
    name: String(name ?? '').trim(),
    parentId,
    status,
  };
  return buildKanbanCardCreatePayload(form);
}

/** Where a card opens in Odin proper. */
export function taskLocation(projectId, card, { kind = 'delivery' } = {}) {
  if (kind === 'engagement') return { name: 'engagement-detail', params: { projectId, section: 'board' } };
  return { name: 'project-detail', params: { projectId }, query: { item: card.id } };
}
