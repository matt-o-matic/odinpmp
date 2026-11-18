// A work item with children takes its points and hours from its direct children, unless
// someone overrode them (estimateOverride). Only entered values count, so an unestimated
// child adds nothing. An item without children always keeps its own estimate.
// Mirrors backend/src/lib/projects/work-estimates.js, which applies the same rule on load.

import { watch } from 'vue';

function enteredNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function childrenOf(item) {
  return item?.stories ?? item?.tasks ?? [];
}

/** Points and hours entered on a set of children, null where none of them has a value. */
export function childEstimateTotals(children = []) {
  let hours = null;
  let points = null;
  let unestimatedCount = 0;
  for (const child of children ?? []) {
    const childPoints = enteredNumber(child?.points);
    const childHours = enteredNumber(child?.targetHourEstimate);
    if (childPoints != null) points = (points ?? 0) + childPoints;
    if (childHours != null) hours = (hours ?? 0) + childHours;
    if (childPoints == null && childHours == null) unestimatedCount += 1;
  }
  return { childCount: children?.length ?? 0, hours, points, unestimatedCount };
}

/** True when an item's points and hours come from its children. */
export function usesChildEstimates(item) {
  return childrenOf(item).length > 0 && item?.estimateOverride !== true;
}

// Writes only real changes, so recomputing inside a watcher settles instead of looping.
function applyChildEstimates(item) {
  if (!usesChildEstimates(item)) return;
  const totals = childEstimateTotals(childrenOf(item));
  if (item.points !== totals.points) item.points = totals.points;
  if (item.targetHourEstimate !== totals.hours) item.targetHourEstimate = totals.hours;
}

/** Recomputes every rolled-up estimate in a project tree, tasks first. */
export function applyEstimateRollups(project) {
  for (const epic of project?.epics ?? []) {
    for (const story of epic.stories ?? []) applyChildEstimates(story);
    applyChildEstimates(epic);
  }
  return project;
}

/** Keeps rolled-up estimates current while a draft project is edited. */
export function watchEstimateRollups(getProject) {
  return watch(getProject, (project) => applyEstimateRollups(project), { deep: true, immediate: true });
}
