// The guest view's pursuit tasks (docs/engagements/plan.md, Pursuit board; qna.md Q-06). A guest
// sees the tasks assigned to them, or every task while the engagement's "Guests see the whole
// board" is on, and changes the status of, comments on and attaches files to only their own.

/** The guest's own tasks first, then the rest, each group by due date (none last), then name. */
export function sortGuestTasks(tasks = []) {
  return [...tasks].sort((left, right) => Number(Boolean(right.assignedToMe)) - Number(Boolean(left.assignedToMe))
    || String(left.dueDate ?? '9999').localeCompare(String(right.dueDate ?? '9999'))
    || String(left.name ?? '').localeCompare(String(right.name ?? '')));
}

/** "In Progress · due 20 Nov · Otto Outside" for one task's line. */
export function guestTaskMeta(task, { locale = undefined } = {}) {
  const parts = [task.status];
  if (task.dueDate) {
    const at = new Date(`${task.dueDate}T00:00:00Z`);
    parts.push(`due ${Number.isNaN(at.valueOf()) ? task.dueDate : at.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`);
  }
  if (!task.assignedToMe) parts.push(task.assigneeName ? task.assigneeName : 'Unassigned');
  return parts.filter(Boolean).join(' · ');
}

/** The statuses the status picker offers: the board's, with the task's own when it is not one. */
export function guestStatusOptions(statuses = [], current = '') {
  return [...new Set([...(statuses ?? []), ...(current ? [current] : [])])];
}

/** A readable message for a refused task change. */
export function guestTaskErrorMessage(error, fallback) {
  const code = error?.data?.details?.code ?? error?.details?.code;
  if (code === 'not_your_task') return 'Only tasks assigned to you can be changed.';
  if (code === 'engagement_closed') return 'This engagement is read-only.';
  if (code === 'status_not_allowed') return 'That status is not on this board any more. Reload and pick another.';
  if (code === 'version_conflict' || error?.status === 409) return 'Someone else changed this task. Reload to see the latest.';
  if (error?.status === 404) return 'This task is no longer shared with you.';
  return fallback;
}
