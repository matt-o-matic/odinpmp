import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { isPursuitItem } from '../../lib/projects/pursuit.js';
import { COMPLETED_STATUS, normalizeActualHours } from '../../lib/projects/work-progress.js';
import { TICKET_WORKFLOW_STATES } from '../workflows/ticket-workflow.js';

// Contributor metrics are recorded from project snapshots taken before and after a write.
//
// Done work: an item whose status is a done-category state of the workflow its project binds to
// its type. Without such a binding (or for a status that workflow doesn't define), an epic,
// story, or task is done when Completed, and a ticket when in the default ticket workflow's done
// category. Only leaf items earn credit (a task, or a story or epic with no children), because a
// parent's points roll up from its children.
//
// Credit for a done leaf sits with its owner: the assignee, or the person who saved the change
// when nobody is assigned. Comparing what each owner held before and after the write keeps the
// totals consistent: completing credits the owner, reopening takes the credit back, reassigning
// done work moves it, and a save that changes nothing records nothing. Items created or deleted
// by the write are ignored, so creating work already done earns nothing and deleting done work
// keeps its credit.
//
// Hours follow tasks.actual_hours: an increase or decrease is recorded against the item's owner
// after the write.

const DONE_TICKET_STATES = new Set(
  TICKET_WORKFLOW_STATES.filter((state) => state.category === 'done').map((state) => state.key),
);

/** `doneStates` comes from loadWorkflowDoneStates; without it the default rule applies. */
export function isWorkItemDone(itemType, status, doneStates = null) {
  const value = String(status ?? '').trim();
  const bound = doneStates?.get(itemType);
  if (bound?.states.has(value)) return bound.done.has(value);
  return itemType === 'ticket' ? DONE_TICKET_STATES.has(value) : value === COMPLETED_STATUS;
}

/**
 * The states of the workflows a project binds to each item type, keyed by item type as
 * `{ states, done, backlog, cancelled }` sets of state keys. Null when there is no workflow
 * repository.
 */
export async function loadWorkflowDoneStates({ projectId, tenantId, workflowRepository }) {
  if (!workflowRepository?.listSnapshot || !projectId || !tenantId) return null;
  return workflowDoneStatesFromSnapshot(await workflowRepository.listSnapshot({ tenantId }), projectId);
}

/** loadWorkflowDoneStates for one project, from a tenant workflow snapshot already read. */
export function workflowDoneStatesFromSnapshot({ bindings = [], workflows = [] } = {}, projectId) {
  const byType = new Map();
  const keysIn = (workflow, category) => new Set(workflow.states.filter((state) => state.category === category).map((state) => state.key));
  for (const binding of bindings) {
    if (binding.projectId !== projectId) continue;
    const workflow = workflows.find((candidate) => candidate.id === binding.workflowId);
    if (!workflow) continue;
    byType.set(binding.itemType, {
      backlog: keysIn(workflow, 'backlog'),
      cancelled: keysIn(workflow, 'cancelled'),
      done: keysIn(workflow, 'done'),
      states: new Set(workflow.states.map((state) => state.key)),
    });
  }
  return byType;
}

/**
 * Work items in a project detail (or `{ epics, tickets }`), keyed by id. Pursuit work earns no
 * credit (src/lib/projects/pursuit.js), so it never reaches the leaderboard, even after the
 * engagement converts.
 */
export function collectWorkItems(project) {
  const items = new Map();
  const add = (itemType, item, leaf) => {
    if (item?.id && !isPursuitItem(item)) items.set(item.id, { item, itemType, leaf });
  };

  for (const epic of project?.epics ?? []) {
    const stories = epic.stories ?? [];
    add('epic', epic, stories.length === 0);
    for (const story of stories) {
      const tasks = story.tasks ?? [];
      add('story', story, tasks.length === 0);
      for (const task of tasks) add('task', task, true);
    }
  }
  for (const ticket of project?.tickets ?? []) add('ticket', ticket, true);
  return items;
}

function wholePoints(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function completionCredit(entry, doneStates) {
  if (!entry.leaf || !isWorkItemDone(entry.itemType, entry.item.status, doneStates)) return { points: 0, tasks: 0 };
  return { points: wholePoints(entry.item.points), tasks: 1 };
}

function ownerOf(entry, actorUserId) {
  return String(entry.item.assigneeId ?? '').trim() || actorUserId || null;
}

/**
 * Per-user metric changes caused by moving from `before` to `after`. Each entry is
 * `{ userId, tasksCompleted, pointsCompleted, hoursLogged }`; values can be negative.
 */
export function diffWorkCompletion({ actorUserId = null, after, before, doneStates = null }) {
  const totals = new Map();
  const add = (userId, tasks, points, hours) => {
    if (!userId || (!tasks && !points && !hours)) return;
    const current = totals.get(userId) ?? { hoursLogged: 0, pointsCompleted: 0, tasksCompleted: 0 };
    current.tasksCompleted += tasks;
    current.pointsCompleted += points;
    current.hoursLogged += hours;
    totals.set(userId, current);
  };

  const beforeItems = collectWorkItems(before);
  for (const [id, next] of collectWorkItems(after)) {
    const previous = beforeItems.get(id);
    if (!previous) continue;

    const previousCredit = completionCredit(previous, doneStates);
    const nextCredit = completionCredit(next, doneStates);
    add(ownerOf(previous, actorUserId), -previousCredit.tasks, -previousCredit.points, 0);
    add(ownerOf(next, actorUserId), nextCredit.tasks, nextCredit.points, 0);

    const hours = (normalizeActualHours(next.item.actualHours) ?? 0) - (normalizeActualHours(previous.item.actualHours) ?? 0);
    add(ownerOf(next, actorUserId), 0, 0, Math.round(hours * 100) / 100);
  }

  return [...totals.entries()]
    .map(([userId, value]) => ({ ...value, hoursLogged: Math.round(value.hoursLogged * 100) / 100, userId }))
    .filter((entry) => entry.tasksCompleted || entry.pointsCompleted || entry.hoursLogged)
    .sort((left, right) => left.userId.localeCompare(right.userId));
}

/**
 * Records the metric changes between two snapshots of one project, against that project.
 * Metrics never block the write that caused them: failures are logged and the caller
 * carries on.
 */
export async function recordWorkCompletionMetrics({ actorUserId = null, after, before, metricsRepository, projectId, tenantId, workflowRepository = null }) {
  if (!metricsRepository?.record || !tenantId || !projectId || !before || !after) return [];

  let deltas = [];
  try {
    const doneStates = await loadWorkflowDoneStates({ projectId, tenantId, workflowRepository });
    deltas = diffWorkCompletion({ actorUserId, after, before, doneStates });
  } catch (error) {
    logWorkCompletionMetricsFailure({ actorUserId, error, projectId, tenantId });
    return [];
  }

  for (const delta of deltas) {
    try {
      await metricsRepository.record({ ...delta, projectId, tenantId });
    } catch (error) {
      logWorkCompletionMetricsFailure({ actorUserId, error, projectId, tenantId, userId: delta.userId });
    }
  }
  return deltas;
}

/** The current project, read before a write whose caller holds no fresh copy. Null on failure. */
export async function readWorkCompletionBaseline({ metricsRepository, projectId, projectRepository, tenantId }) {
  if (!metricsRepository?.record || !projectId || !tenantId) return null;
  try {
    return await projectRepository.getProjectDetail({ projectId, tenantId });
  } catch (error) {
    logWorkCompletionMetricsFailure({ error, projectId, tenantId });
    return null;
  }
}

function logWorkCompletionMetricsFailure({ actorUserId = null, error, projectId, tenantId, userId = null }) {
  logBackendError({
    context: buildOperationLogContext('metrics.recordWorkCompletion', { actorUserId, projectId, tenantId, userId }),
    error,
    level: 'warn',
    message: 'Contributor metrics could not be recorded.',
  });
}
