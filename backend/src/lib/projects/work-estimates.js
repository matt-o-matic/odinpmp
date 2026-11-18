// A work item with children takes its points and hours from its direct children, unless
// someone overrode them (estimateOverride). Only entered values count, so an unestimated
// child adds nothing. An item without children always keeps its own estimate.
// Mirrored by frontend/src/lib/projects/work-estimates.js.

function enteredNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

export function usesChildEstimates(node, children) {
  return (children?.length ?? 0) > 0 && node?.estimateOverride !== true;
}

/** Sets an item's points and hours to its children's totals when it rolls up. */
export function applyChildEstimates(node, children) {
  if (!usesChildEstimates(node, children)) return node;
  const totals = childEstimateTotals(children);
  node.points = totals.points;
  node.targetHourEstimate = totals.hours;
  return node;
}

/** Recomputes every rolled-up estimate in a project tree, tasks first. */
export function applyProjectEstimateRollups(project) {
  for (const epic of project?.epics ?? []) {
    for (const story of epic.stories ?? []) applyChildEstimates(story, story.tasks);
    applyChildEstimates(epic, epic.stories);
  }
  return project;
}

export function estimateOverrideFlag(value) {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}
