import { NOT_STARTED_STATUS } from '../../lib/projects/work-progress.js';
import { isWorkItemDone } from '../metrics/work-completion-metrics.js';
import { TICKET_WORKFLOW_STATES } from '../workflows/ticket-workflow.js';
import { dateOnly } from './home-dates.js';

// One flat list of a project's work items with the states Home ranks on. Done follows the
// workflow the project binds to the item's type (isWorkItemDone), so custom workflows count.
// Not started is "Not Started" or a backlog-category state; cancelled tickets are closed.

const DEFAULT_PRIORITY = 4;
const TICKET_STATES_BY_CATEGORY = (category) => new Set(TICKET_WORKFLOW_STATES.filter((state) => state.category === category).map((state) => state.key));
const DEFAULT_TICKET_BACKLOG = TICKET_STATES_BY_CATEGORY('backlog');
const DEFAULT_TICKET_CANCELLED = TICKET_STATES_BY_CATEGORY('cancelled');

function itemState(itemType, status, doneStates) {
  const value = String(status ?? '').trim();
  const bound = doneStates?.get(itemType);
  const known = Boolean(bound?.states.has(value));
  const done = isWorkItemDone(itemType, value, doneStates);
  const cancelled = known ? bound.cancelled.has(value) : itemType === 'ticket' && DEFAULT_TICKET_CANCELLED.has(value);
  const backlog = known ? bound.backlog.has(value) : itemType === 'ticket' && DEFAULT_TICKET_BACKLOG.has(value);
  const notStarted = !done && !cancelled && (value === NOT_STARTED_STATUS || value === '' || backlog);
  return { cancelled, done, inProgress: !done && !cancelled && !notStarted, notStarted, open: !done && !cancelled };
}

function positivePoints(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function priorityOf(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 7 ? number : DEFAULT_PRIORITY;
}

/** Every epic, story, task and ticket in a project detail, in tree order. */
export function flattenProjectItems(project, doneStates = null) {
  const items = [];
  const add = (node, itemType, extra) => {
    if (!node?.id) return;
    items.push({
      assigneeId: String(node.assigneeId ?? '').trim() || null,
      assigneeName: String(node.assigneeName ?? '').trim(),
      id: node.id,
      itemType,
      name: String(node.name ?? '').trim() || 'Untitled item',
      points: positivePoints(node.points),
      priority: priorityOf(node.priority),
      severity: itemType === 'ticket' ? String(node.severity ?? '') : null,
      sprintId: node.sprintId ?? null,
      status: String(node.status ?? '').trim(),
      targetEndDate: dateOnly(node.targetEndDate),
      targetHourEstimate: node.targetHourEstimate ?? null,
      updatedAt: node.updatedAt ?? null,
      version: Number(node.version) || 1,
      ...itemState(itemType, node.status, doneStates),
      ...extra,
    });
  };
  for (const epic of project?.epics ?? []) {
    const stories = epic.stories ?? [];
    add(epic, 'epic', { epicId: epic.id, leaf: stories.length === 0, storyId: null, taskCount: 0 });
    for (const story of stories) {
      const tasks = story.tasks ?? [];
      add(story, 'story', { epicId: epic.id, leaf: tasks.length === 0, storyId: story.id, taskCount: tasks.length });
      for (const task of tasks) add(task, 'task', { epicId: epic.id, leaf: true, storyId: story.id, taskCount: 0 });
    }
  }
  for (const ticket of project?.tickets ?? []) add(ticket, 'ticket', { epicId: null, leaf: true, storyId: null, taskCount: 0 });
  return items;
}

/** The leaves a sprint's points count: stories without tasks, and tasks. */
export function sprintLeaves(items, sprintId) {
  return items.filter((item) => item.leaf && (item.itemType === 'story' || item.itemType === 'task') && item.sprintId === sprintId && !item.cancelled);
}

/** The route a client opens for an item: plan items by ?item=, tickets in the ticket list. */
export function itemLink(projectId, item) {
  if (item.itemType === 'ticket') return { name: 'tickets', query: { ticket: item.id } };
  return { name: 'project-detail', params: { projectId }, query: { item: item.id } };
}
