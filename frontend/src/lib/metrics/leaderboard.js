export const LEADERBOARD_PERIODS = Object.freeze([
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]);

export const DEFAULT_LEADERBOARD_DAYS = 30;

// Mirrors backend/src/modules/metrics/work-completion-metrics.js.
export const POINT_RULES = Object.freeze([
  'Marking a task, a ticket, or a story or epic without tasks as done earns its assignee one item and its story points.',
  'Unassigned work counts for whoever marks it done.',
  'Reopening work takes the credit back, and reassigning finished work moves it.',
  'Hours come from the actual hours logged on work items.',
]);

/** The ranked rows to show: the top contributors, then the signed-in user when they rank lower. */
export function leaderboardRows(result = {}) {
  const top = Array.isArray(result.leaderboard) ? result.leaderboard : [];
  const rows = top.map((row) => ({ ...row, detached: false }));
  const current = result.currentUser;
  if (current && !top.some((row) => row.id === current.id)) rows.push({ ...current, detached: true, isCurrentUser: true });
  return rows;
}

export function formatHours(value) {
  const hours = Number(value ?? 0);
  return `${Number.isFinite(hours) ? Math.round(hours * 100) / 100 : 0}h`;
}

export function positionSummary(result = {}) {
  const current = result.currentUser;
  const period = `the last ${result.days ?? DEFAULT_LEADERBOARD_DAYS} days`;
  if (!current) return `You have no completed work in ${period}.`;
  const points = `${current.points} ${current.points === 1 ? 'point' : 'points'}`;
  const items = `${current.tasksCompleted} ${current.tasksCompleted === 1 ? 'item' : 'items'} done`;
  return `You are #${current.rank} of ${result.contributorCount ?? current.rank} with ${points} and ${items} in ${period}.`;
}

/** Absolute URL for a stored avatar path; empty when the user has none. */
export function avatarUrl(picture, apiBaseUrl = '') {
  const value = String(picture ?? '').trim();
  if (!value) return '';
  if (/^(https?:|data:)/i.test(value)) return value;
  const base = String(apiBaseUrl ?? '').replace(/\/$/, '');
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}
