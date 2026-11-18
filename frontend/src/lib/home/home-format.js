// Display helpers for Home (views/HomeView.vue). The server ranks and words the reasons
// (backend/src/modules/home); these only format dates, labels and the sparkline.

export const LENSES = Object.freeze({
  'my-work': { icon: 'bi-person', label: 'My work' },
  team: { icon: 'bi-people', label: 'Team' },
  workspace: { icon: 'bi-building-gear', label: 'Workspace' },
});

const REASON_ICONS = Object.freeze({
  approval: 'bi-hourglass-split',
  blocks: 'bi-people-fill',
  'critical-risk': 'bi-exclamation-octagon',
  'dead-webhook': 'bi-plug',
  decision: 'bi-signpost-split',
  'due-soon': 'bi-calendar-event',
  expires: 'bi-hourglass-split',
  'high-priority': 'bi-arrow-up-circle',
  'high-risk': 'bi-exclamation-circle',
  'in-progress': 'bi-play-circle',
  'items-left': 'bi-person-check',
  'odin-alert': 'bi-robot',
  overdue: 'bi-exclamation-triangle-fill',
  'past-sla': 'bi-hourglass-bottom',
  question: 'bi-chat-left-text',
  'required-reviewer': 'bi-person-check',
  'review-open': 'bi-eye',
  s1: 'bi-bug-fill',
  s2: 'bi-bug',
  'schedule-slip': 'bi-calendar-x',
  'second-admin': 'bi-person-badge',
  'sprint-ends': 'bi-flag',
  'sync-conflict': 'bi-arrow-left-right',
});

const COUNT_ICONS = Object.freeze({
  'access-review': 'bi-person-check',
  'active-sprints': 'bi-lightning-charge',
  alerts: 'bi-robot',
  approvals: 'bi-hourglass-split',
  'critical-risks': 'bi-exclamation-octagon',
  'dead-webhooks': 'bi-plug',
  'due-week': 'bi-calendar-week',
  'in-review': 'bi-eye',
  overallocated: 'bi-people',
  'sync-conflicts': 'bi-arrow-left-right',
  waiting: 'bi-hand-index-thumb',
  'without-2fa': 'bi-shield-exclamation',
});

const PROPOSAL_ICONS = Object.freeze({
  'move-scope': 'bi-box-arrow-right',
  'raise-risk': 'bi-exclamation-diamond',
  reassign: 'bi-person-gear',
  'shift-milestone': 'bi-calendar2-range',
  'split-story': 'bi-scissors',
});

export function reasonIcon(code) {
  return REASON_ICONS[code] ?? 'bi-dot';
}

export function countIcon(key) {
  return COUNT_ICONS[key] ?? 'bi-dot';
}

export function proposalIcon(type) {
  return PROPOSAL_ICONS[type] ?? 'bi-lightbulb';
}

// Sources whose failure can leave items out of the ranked lists. The rail's own panels
// report the rest.
const SOURCE_LABELS = Object.freeze({
  alerts: 'Odin alerts',
  connectors: 'Connectors',
  governance: 'Risks, milestones and schedules',
  identity: 'Identity',
  integrations: 'Webhooks',
  projects: 'Projects',
  relations: 'Item links',
  requirements: 'Requirements items',
  sprints: 'Sprints',
  workflows: 'Workflow approvals',
});

function dateOnly(value) {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function utcDate(day) {
  return new Date(`${day}T00:00:00.000Z`);
}

function daysBetween(from, to) {
  return Math.round((utcDate(to) - utcDate(from)) / 86_400_000);
}

export function shortDate(day) {
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(utcDate(day));
}

function weekday(day) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(utcDate(day));
}

/** "Today", "Tomorrow", a weekday within the week ahead, else "Oct 14". */
export function dayLabel(day, today) {
  const days = daysBetween(today, day);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return weekday(day);
  return shortDate(day);
}

function lowerFirst(text) {
  return /^(Today|Tomorrow)$/.test(text) ? text.toLowerCase() : text;
}

/** The right-hand date on a row, relative to the payload's `asOf`. */
export function dueLabel(due, asOf) {
  if (!due) return '';
  if (due.kind === 'owner') return 'Owner';
  const day = dateOnly(due.at);
  const today = dateOnly(asOf);
  if (!day || !today) return '';
  if (due.kind === 'since') return `Since ${shortDate(day)}`;
  const hasTime = String(due.at).length > 10;
  const nowMs = Date.parse(asOf);
  if (hasTime && Date.parse(due.at) < nowMs && day === today) {
    return `Overdue ${Math.max(1, Math.floor((nowMs - Date.parse(due.at)) / 3_600_000))}h`;
  }
  if (day < today) {
    const ago = daysBetween(day, today);
    return `Was due ${ago < 7 ? weekday(day) : shortDate(day)}`;
  }
  return dayLabel(day, today);
}

export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function firstNameOf(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || 'there';
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

/** "Manager on 4 projects", "Member on 2 projects", or "Tenant admin, Acme". */
export function roleSummary(viewer = {}, tenantName = '') {
  if (viewer.tenantRole === 'admin') return tenantName ? `Tenant admin, ${tenantName}` : 'Tenant admin';
  if (viewer.managedProjectCount > 0) return `Manager on ${plural(viewer.managedProjectCount, 'project')}`;
  if (viewer.projectCount > 0) return `Member on ${plural(viewer.projectCount, 'project')}`;
  return tenantName ? `Member of ${tenantName}` : 'Not on a project yet';
}

/** The date line under the greeting, long on desktop and short on phones. */
export function dateLine(date = new Date(), { short = false } = {}) {
  return new Intl.DateTimeFormat('en-US', short
    ? { day: 'numeric', month: 'short', weekday: 'short' }
    : { day: 'numeric', month: 'long', weekday: 'long' }).format(date);
}

export function unitShort(unit) {
  return unit === 'points' ? 'pts' : 'items';
}

/** "ends Fri", "ends today", or "12 days left" for a sprint's end date. */
export function sprintEndLabel(endDate, asOf) {
  const day = dateOnly(endDate);
  const today = dateOnly(asOf);
  if (!day || !today) return '';
  const days = daysBetween(today, day);
  if (days < 0) return `ended ${shortDate(day)}`;
  if (days >= 7) return `${days} days left`;
  return `ends ${lowerFirst(dayLabel(day, today))}`;
}

export function percentWidth(part, whole) {
  if (!(whole > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * The message for sources that failed in a way that can leave items out of the ranking, or
 * '' when none did.
 */
export function failedSourcesMessage(sources = [], projectCount = 0) {
  const failing = sources.filter((source) => source.status === 'error' && SOURCE_LABELS[source.key]);
  if (failing.length === 0) return '';
  const labels = failing.map((source) => SOURCE_LABELS[source.key]);
  const subject = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1).toLowerCase()}`;
  const projectIds = new Set(failing.flatMap((source) => source.failedProjectIds ?? []));
  const scope = projectIds.size > 0 && projectCount > 0 ? ` for ${projectIds.size} of ${plural(projectCount, 'project')}` : '';
  return `${subject} could not load${scope}, so the ranking may be missing items.`;
}

export function sourceFailed(sources = [], key) {
  return sources.some((source) => source.key === key && source.status === 'error');
}

/** The items a tab lists, in rank order. */
export function itemsForTab(payload, key) {
  if (!payload) return [];
  if (key === 'focus') return payload.focus?.items ?? [];
  return (payload.items ?? []).filter((item) => item.tabs?.includes(key));
}

/** Line and area paths for a sparkline of daily counts, in a `width` × `height` box. */
export function sparklinePaths(series = [], width = 320, height = 56) {
  if (series.length === 0) return { area: '', last: null, line: '' };
  const values = series.map((point) => Number(point.count) || 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  const points = values.map((value, index) => [index * step, height - 6 - ((value - min) / (max - min || 1)) * (height - 14)]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = points.at(-1);
  return { area: `${line} L${width},${height} L0,${height} Z`, last: { x: lastX, y: lastY }, line };
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || '?';
}
