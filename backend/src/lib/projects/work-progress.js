// Work progress is weighted by estimated effort. Every leaf work item (a task, or a story or
// epic with no children) adds its estimated hours to the total and earns a share of them from
// its status: Completed earns all of it, Not Started none, and in-flight statuses earn their
// percent complete. A Completed story counts every task under it as completed.
// Mirrored by frontend/src/lib/projects/work-progress.js, which also builds the bar breakdown.

export const COMPLETED_STATUS = 'Completed';
export const NOT_STARTED_STATUS = 'Not Started';
export const DEFAULT_ESTIMATE_HOURS = 16;
export const HOURS_PER_POINT = 8;

// In-flight items without a percent complete fall back to these. Unknown statuses count as
// in progress.
const DEFAULT_IN_FLIGHT_PERCENT = {
  'At Risk': 50,
  'In Progress': 50,
  Review: 80,
};

function positiveNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizePercentComplete(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : null;
}

export const MAX_ACTUAL_HOURS = 100000;

/** Hours actually spent, to the hundredth of an hour; null when nothing is logged. */
export function normalizeActualHours(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MAX_ACTUAL_HOURS, Math.max(0, Math.round(number * 100) / 100)) : null;
}

/** Hours of work left on an item, kept as hours spent are; null when nobody has set it. */
export function normalizeRemainingHours(value) {
  return normalizeActualHours(value);
}

/** Hours from the hour estimate, else points at 8h each, else the 16h (2 point) default. */
export function estimateHoursFor(item) {
  const hours = positiveNumber(item?.targetHourEstimate);
  if (hours != null) return { hours, source: 'hours' };
  const points = positiveNumber(item?.points);
  if (points != null) return { hours: points * HOURS_PER_POINT, source: 'points' };
  return { hours: DEFAULT_ESTIMATE_HOURS, source: 'default' };
}

export function completionFor(item, { forceCompleted = false } = {}) {
  const status = forceCompleted ? COMPLETED_STATUS : (String(item?.status ?? '').trim() || NOT_STARTED_STATUS);
  if (status === COMPLETED_STATUS) return { assumed: false, percent: 100, status };
  if (status === NOT_STARTED_STATUS) return { assumed: false, percent: 0, status };
  const explicit = normalizePercentComplete(item?.percentComplete);
  if (explicit != null) return { assumed: false, percent: explicit, status };
  return { assumed: true, percent: DEFAULT_IN_FLIGHT_PERCENT[status] ?? DEFAULT_IN_FLIGHT_PERCENT['In Progress'], status };
}

function childEntries(type, node) {
  if (type === 'project') return (node?.epics ?? []).map((epic) => ['epic', epic]);
  if (type === 'epic') return (node?.stories ?? []).map((story) => ['story', story]);
  if (type === 'story') return (node?.tasks ?? []).map((task) => ['task', task]);
  return [];
}

/** Leaf work items under a node, each flagged when a completed story forces it complete. */
export function collectWorkLeaves(type, node, { forceCompleted = false } = {}) {
  if (!node) return [];
  const children = childEntries(type, node);
  if (type === 'project') {
    return children.flatMap(([childType, child]) => collectWorkLeaves(childType, child));
  }
  if (children.length === 0) {
    return [{ forceCompleted, item: node, type }];
  }
  const forceChildren = forceCompleted || (type === 'story' && node.status === COMPLETED_STATUS);
  return children.flatMap(([childType, child]) => collectWorkLeaves(childType, child, { forceCompleted: forceChildren }));
}

/** Percent complete for a node, rounded to one decimal place. */
export function workProgressPercent(type, node) {
  let earnedHours = 0;
  let totalHours = 0;
  for (const leaf of collectWorkLeaves(type, node)) {
    const { hours } = estimateHoursFor(leaf.item);
    totalHours += hours;
    earnedHours += (hours * completionFor(leaf.item, leaf).percent) / 100;
  }
  return totalHours > 0 ? Math.round((earnedHours / totalHours) * 1000) / 10 : 0;
}

/**
 * A story that becomes Completed completes its open tasks. Only the transition cascades, so a
 * task can still be reopened under a story that was already completed.
 */
export function storyCompletionCascades(previousStatus, nextStatus) {
  return nextStatus === COMPLETED_STATUS && previousStatus !== COMPLETED_STATUS;
}

/**
 * Applies the story completion cascade to `nextEpics` in place, comparing each story with its
 * status in `previousEpics`. Returns the ids of the tasks it completed.
 */
export function cascadeStoryCompletion(previousEpics, nextEpics) {
  const previousStatuses = new Map();
  for (const epic of previousEpics ?? []) {
    for (const story of epic.stories ?? []) previousStatuses.set(story.id, story.status);
  }

  const completedTaskIds = [];
  for (const epic of nextEpics ?? []) {
    for (const story of epic.stories ?? []) {
      if (!storyCompletionCascades(previousStatuses.get(story.id), story.status)) continue;
      for (const task of story.tasks ?? []) {
        if (task.status === COMPLETED_STATUS) continue;
        task.status = COMPLETED_STATUS;
        completedTaskIds.push(task.id);
      }
    }
  }
  return completedTaskIds;
}
