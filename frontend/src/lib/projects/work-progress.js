// Work progress is weighted by estimated effort. Mirrors backend/src/lib/projects/work-progress.js:
// every leaf work item (a task, or a story or epic with no children) adds its estimated hours
// to the total and earns a share of them from its status. Completed earns all of it, Not
// Started none, and in-flight statuses earn their percent complete. A Completed story counts
// every task under it as completed. This module also splits the hours into the bar's colors.

export const COMPLETED_STATUS = 'Completed';
export const NOT_STARTED_STATUS = 'Not Started';
export const DEFAULT_ESTIMATE_HOURS = 16;
export const HOURS_PER_POINT = 8;

// In-flight items without a percent complete fall back to these. Unknown statuses count as
// in progress.
export const DEFAULT_IN_FLIGHT_PERCENT = {
  'At Risk': 50,
  'In Progress': 50,
  Review: 80,
};

// Bar order: earned work first, then what is left on in-flight items, then untouched work.
export const WORK_PROGRESS_BUCKETS = [
  { className: 'progress-done', key: 'done', label: 'Done' },
  { className: 'progress-active', key: 'active', label: 'In progress' },
  { className: 'progress-review', key: 'review', label: 'In review' },
  { className: 'progress-risk', key: 'risk', label: 'At risk' },
  { className: 'progress-backlog', key: 'backlog', label: 'Not started' },
];

const IN_FLIGHT_BUCKETS = {
  'At Risk': 'risk',
  'In Progress': 'active',
  Review: 'review',
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

/** Hours of work left, kept as hours spent are; null when nobody has set it. */
export function normalizeRemainingHours(value) {
  return normalizeActualHours(value);
}

/** Hours logged on the work items under a node, and how many of them have any logged. */
export function summarizeActualHours(type, node) {
  let hours = 0;
  let itemCount = 0;
  for (const leaf of collectWorkLeaves(type, node)) {
    const logged = normalizeActualHours(leaf.item.actualHours);
    if (logged == null) continue;
    hours += logged;
    itemCount += 1;
  }
  return { hours: Math.round(hours * 100) / 100, itemCount };
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

/** True when a node is a single work item rather than a rollup of its children. */
export function isLeafWorkItem(type, node) {
  return type !== 'project' && childEntries(type, node).length === 0;
}

// Rounds down to 99 until every hour is earned, so "100%" always means done.
function displayPercent(earnedHours, totalHours) {
  if (totalHours <= 0) return 0;
  if (earnedHours >= totalHours - 1e-9) return 100;
  return Math.min(99, Math.round((earnedHours / totalHours) * 100));
}

/**
 * Estimate-weighted progress for a project, epic, story, or task. `buckets` lists the bar
 * segments in display order with the hours, share of the total, and item count behind each.
 */
export function summarizeWorkProgress(type, node) {
  const hoursByBucket = Object.fromEntries(WORK_PROGRESS_BUCKETS.map((bucket) => [bucket.key, 0]));
  const itemsByBucket = Object.fromEntries(WORK_PROGRESS_BUCKETS.map((bucket) => [bucket.key, 0]));
  const assumptions = { defaultEstimateCount: 0, defaultPercentCount: 0, pointsEstimateCount: 0 };
  let inFlightEarnedHours = 0;
  let totalHours = 0;

  const leaves = collectWorkLeaves(type, node);
  for (const leaf of leaves) {
    const estimate = estimateHoursFor(leaf.item);
    const completion = completionFor(leaf.item, leaf);
    const earned = (estimate.hours * completion.percent) / 100;
    totalHours += estimate.hours;
    if (estimate.source === 'default') assumptions.defaultEstimateCount += 1;
    if (estimate.source === 'points') assumptions.pointsEstimateCount += 1;

    if (completion.status === COMPLETED_STATUS) {
      hoursByBucket.done += estimate.hours;
      itemsByBucket.done += 1;
    } else if (completion.status === NOT_STARTED_STATUS) {
      hoursByBucket.backlog += estimate.hours;
      itemsByBucket.backlog += 1;
    } else {
      const bucketKey = IN_FLIGHT_BUCKETS[completion.status] ?? 'active';
      hoursByBucket.done += earned;
      hoursByBucket[bucketKey] += estimate.hours - earned;
      itemsByBucket[bucketKey] += 1;
      inFlightEarnedHours += earned;
      if (completion.assumed) assumptions.defaultPercentCount += 1;
    }
  }

  const earnedHours = hoursByBucket.done;
  return {
    actual: summarizeActualHours(type, node),
    assumptions,
    buckets: WORK_PROGRESS_BUCKETS.map((bucket) => ({
      ...bucket,
      hours: hoursByBucket[bucket.key],
      itemCount: itemsByBucket[bucket.key],
      share: totalHours > 0 ? (hoursByBucket[bucket.key] / totalHours) * 100 : 0,
    })),
    earnedHours,
    inFlightEarnedHours,
    itemCount: leaves.length,
    percentComplete: displayPercent(earnedHours, totalHours),
    totalHours,
  };
}

/**
 * Sets a work item's status. A story that becomes Completed completes its open tasks, the
 * same way the server does; the task states it replaced are kept in `cascadeMemory` (a Map)
 * so that moving the story off Completed again, before saving, puts them back.
 */
export function applyWorkItemStatus(type, item, status, cascadeMemory = null) {
  if (!item) return;
  const previousStatus = item.status;
  item.status = status;
  if (type !== 'story') return;

  if (status === COMPLETED_STATUS && previousStatus !== COMPLETED_STATUS) {
    const replaced = [];
    for (const task of item.tasks ?? []) {
      if (task.status === COMPLETED_STATUS) continue;
      replaced.push({ boardColumn: task.boardColumn, id: task.id, status: task.status });
      task.status = COMPLETED_STATUS;
      // A status change without a chosen Kanban column releases the old placement.
      task.boardColumn = null;
    }
    cascadeMemory?.set(item.id, replaced);
    return;
  }

  if (previousStatus === COMPLETED_STATUS && status !== COMPLETED_STATUS) {
    for (const replaced of cascadeMemory?.get(item.id) ?? []) {
      const task = (item.tasks ?? []).find((candidate) => candidate.id === replaced.id);
      if (task?.status !== COMPLETED_STATUS) continue;
      task.status = replaced.status;
      task.boardColumn = replaced.boardColumn;
    }
    cascadeMemory?.delete(item.id);
  }
}
