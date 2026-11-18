// The projects list: status filters, text filter, sort orders, and the per-row status,
// "waiting on you" and open-review cells. Archived projects stay out of every view except
// the Archived filter.

export const ARCHIVED_STATUS = 'Archived';

export const PROJECT_STATUS_ORDER = Object.freeze(['Planned', 'In Progress', 'At Risk', 'Review', 'Completed', ARCHIVED_STATUS]);

// Mirrors backend/src/lib/projects/project-statuses.js so legacy names land in a filter.
const STATUS_ALIASES = Object.freeze({
  abandoned: ARCHIVED_STATUS,
  active: 'In Progress',
  archived: ARCHIVED_STATUS,
  'at risk': 'At Risk',
  candidate: 'Planned',
  completed: 'Completed',
  delayed: 'At Risk',
  done: 'Completed',
  'in progress': 'In Progress',
  planned: 'Planned',
  planning: 'Planned',
  rejected: ARCHIVED_STATUS,
  review: 'Review',
  started: 'In Progress',
  'under review': 'Review',
});

export const PROJECT_STATUS_FILTERS = Object.freeze([
  { id: 'active', label: 'All active' },
  { id: 'Planned', label: 'Planned' },
  { id: 'In Progress', label: 'In progress' },
  { id: 'At Risk', label: 'At risk' },
  { id: 'Review', label: 'Review' },
  { id: 'Completed', label: 'Completed' },
  { id: ARCHIVED_STATUS, label: 'Archived' },
]);

export const PROJECT_SORTS = Object.freeze([
  { id: 'rank', label: 'Rank' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'review', label: 'Review closing soonest' },
  { id: 'name', label: 'Name' },
  { id: 'status', label: 'Status' },
  { id: 'end', label: 'End date' },
  { id: 'updated', label: 'Recently updated' },
]);

export const DEFAULT_PROJECT_FILTERS = Object.freeze({ mine: false, q: '', sort: 'rank', status: 'active' });

const STATUS_TONES = Object.freeze({
  [ARCHIVED_STATUS]: { icon: 'bi-archive', tone: 'archived' },
  'At Risk': { icon: 'bi-exclamation-triangle-fill', tone: 'risk' },
  Completed: { icon: 'bi-check-circle-fill', tone: 'done' },
  'In Progress': { icon: 'bi-play-circle-fill', tone: 'active' },
  Planned: { icon: 'bi-circle', tone: 'planned' },
  Review: { icon: 'bi-eye-fill', tone: 'review' },
});

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeProjectStatus(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!key) return 'Planned';
  return STATUS_ALIASES[key] ?? String(value).trim();
}

export function isArchivedProject(project) {
  return normalizeProjectStatus(project?.status) === ARCHIVED_STATUS;
}

/** Projects for the navbar menu: never archived ones. */
export function menuProjects(projects = [], limit = 12) {
  return (projects ?? []).filter((project) => !isArchivedProject(project)).slice(0, limit);
}

export function projectStatusTone(status) {
  const label = normalizeProjectStatus(status);
  return { label, ...(STATUS_TONES[label] ?? { icon: 'bi-circle', tone: 'planned' }) };
}

/** Filter and sort settings from the route query, with unknown values dropped. */
export function projectFiltersFromQuery(query = {}) {
  const status = String(query.status ?? '');
  const sort = String(query.sort ?? '');
  return {
    mine: query.mine === '1',
    q: String(query.q ?? ''),
    sort: PROJECT_SORTS.some((option) => option.id === sort) ? sort : DEFAULT_PROJECT_FILTERS.sort,
    status: PROJECT_STATUS_FILTERS.some((option) => option.id === status) ? status : DEFAULT_PROJECT_FILTERS.status,
  };
}

/** The route query for the settings, leaving defaults out so the plain URL stays clean. */
export function projectFiltersToQuery(filters = {}, baseQuery = {}) {
  const query = { ...baseQuery };
  delete query.mine;
  delete query.q;
  delete query.sort;
  delete query.status;
  if (filters.mine) query.mine = '1';
  // Untrimmed, so syncing the URL back into the filter keeps a space the user just typed.
  if (String(filters.q ?? '').trim()) query.q = String(filters.q);
  if (filters.sort && filters.sort !== DEFAULT_PROJECT_FILTERS.sort) query.sort = filters.sort;
  if (filters.status && filters.status !== DEFAULT_PROJECT_FILTERS.status) query.status = filters.status;
  return query;
}

export function waitingCount(signals) {
  return Math.max(0, Number(signals?.waiting?.total) || 0);
}

/** True when something on the project needs the viewer: open items, or a review they owe. */
export function needsViewer(signals) {
  return waitingCount(signals) > 0 || Boolean(signals?.review?.awaitingYou);
}

function toTime(value) {
  if (value == null || value === '') return null;
  const time = new Date(value).valueOf();
  return Number.isNaN(time) ? null : time;
}

function startOfDay(time) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
}

/**
 * The open-review cell: how soon the soonest-closing open round closes, and how urgent that
 * is. `tone` is `overdue`, `soon` (within two days), `open`, or `none` (no due date).
 */
export function reviewDeadline(review, { locale, now = new Date() } = {}) {
  if (!review) return null;
  const due = toTime(review.dueAt);
  const current = now instanceof Date ? now.valueOf() : toTime(now) ?? Date.now();
  const dateText = due == null
    ? ''
    : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', weekday: 'short' }).format(new Date(due));

  if (due == null) return { dateText, label: 'Open, no close date', tone: 'none' };

  const days = Math.round((startOfDay(due) - startOfDay(current)) / DAY_MS);
  // A round stays open past its due date until someone closes it.
  if (due < current) {
    const label = days >= 0 ? 'Overdue since earlier today' : days === -1 ? '1 day overdue' : `${-days} days overdue`;
    return { dateText, label, tone: 'overdue' };
  }
  if (days === 0) {
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(due));
    return { dateText, label: `Closes today, ${time}`, tone: 'soon' };
  }
  if (days === 1) return { dateText, label: 'Closes tomorrow', tone: 'soon' };
  return { dateText, label: `Closes in ${days} days`, tone: days <= 2 ? 'soon' : 'open' };
}

const WAITING_PARTS = Object.freeze([
  ['decide', 'to decide'],
  ['answer', 'to answer'],
  ['review', 'to review'],
  ['drafts', 'unpublished'],
]);

/** "2 to answer · 1 to review": the kinds of item behind the waiting count. */
export function waitingBreakdown(signals) {
  const waiting = signals?.waiting ?? {};
  return WAITING_PARTS
    .filter(([key]) => Number(waiting[key]) > 0)
    .map(([key, label]) => `${Number(waiting[key])} ${label}`)
    .join(' · ');
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/**
 * A note under the dates when the end date is close or behind us on a project that is still
 * running: "Ends in 5 days", "Ends today", "Past end date". Null otherwise.
 */
export function projectEndNote(project, { now = new Date() } = {}) {
  const status = normalizeProjectStatus(project?.status);
  if (status === 'Completed' || status === ARCHIVED_STATUS) return null;
  const end = parseLocalDate(project?.endDate);
  if (!end) return null;
  const days = Math.round((end.valueOf() - startOfDay(now.valueOf())) / DAY_MS);
  if (days < 0) return { text: 'Past end date', tone: 'overdue' };
  if (days === 0) return { text: 'Ends today', tone: 'soon' };
  if (days <= 14) return { text: days === 1 ? 'Ends tomorrow' : `Ends in ${days} days`, tone: days <= 3 ? 'soon' : 'open' };
  return null;
}

/** "Sep 1 – Dec 15, 2026", "Starts Sep 1, 2026", "Ends …", or '' with no dates. */
export function formatProjectDates(startDate, endDate, { locale } = {}) {
  const format = (value) => {
    const date = parseLocalDate(value);
    return date ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date) : '';
  };
  const start = format(startDate);
  const end = format(endDate);
  if (start && end) return `${start} – ${end}`;
  if (start) return `Starts ${start}`;
  if (end) return `Ends ${end}`;
  return '';
}

function matchesText(project, needle) {
  if (!needle) return true;
  return [project.name, project.status, project.role]
    .some((value) => String(value ?? '').toLowerCase().includes(needle));
}

function matchesStatus(project, status) {
  const projectStatus = normalizeProjectStatus(project.status);
  if (status === 'active') return projectStatus !== ARCHIVED_STATUS;
  return projectStatus === status;
}

/** How many projects each status filter would show, before the text filter. */
export function projectStatusCounts(projects = []) {
  const counts = Object.fromEntries(PROJECT_STATUS_FILTERS.map((option) => [option.id, 0]));
  for (const project of projects ?? []) {
    const status = normalizeProjectStatus(project.status);
    if (status !== ARCHIVED_STATUS) counts.active += 1;
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
}

function compareRank(left, right) {
  const leftRank = left.rank ?? null;
  const rightRank = right.rank ?? null;
  if (leftRank == null && rightRank != null) return 1;
  if (leftRank != null && rightRank == null) return -1;
  if (leftRank != null && rightRank != null && leftRank !== rightRank) return leftRank - rightRank;
  return compareText(left.name, right.name);
}

// Missing values sort last in either direction.
function compareNullable(leftValue, rightValue, direction = 1) {
  if (leftValue == null && rightValue == null) return 0;
  if (leftValue == null) return 1;
  if (rightValue == null) return -1;
  return (leftValue - rightValue) * direction;
}

const SORTERS = {
  end: (left, right) => compareNullable(toTime(left.project.endDate), toTime(right.project.endDate)) || compareRank(left.project, right.project),
  name: (left, right) => compareText(left.project.name, right.project.name),
  rank: (left, right) => compareRank(left.project, right.project),
  review: (left, right) => {
    const leftDue = left.signals?.review ? toTime(left.signals.review.dueAt) ?? Number.MAX_SAFE_INTEGER : null;
    const rightDue = right.signals?.review ? toTime(right.signals.review.dueAt) ?? Number.MAX_SAFE_INTEGER : null;
    return compareNullable(leftDue, rightDue) || compareRank(left.project, right.project);
  },
  status: (left, right) => {
    const order = (entry) => {
      const index = PROJECT_STATUS_ORDER.indexOf(normalizeProjectStatus(entry.project.status));
      return index === -1 ? PROJECT_STATUS_ORDER.length : index;
    };
    return order(left) - order(right) || compareRank(left.project, right.project);
  },
  updated: (left, right) => compareNullable(toTime(left.project.updatedAt), toTime(right.project.updatedAt), -1) || compareRank(left.project, right.project),
  waiting: (left, right) => (
    waitingCount(right.signals) - waitingCount(left.signals)
    || Number(Boolean(right.signals?.review?.awaitingYou)) - Number(Boolean(left.signals?.review?.awaitingYou))
    || compareRank(left.project, right.project)
  ),
};

/**
 * The rows to show: `{ project, signals }` for projects matching the filters, in sort order.
 * `signalsById` maps project ids to their per-viewer signals and may be empty while loading.
 */
export function buildProjectRows(projects = [], signalsById = {}, filters = DEFAULT_PROJECT_FILTERS) {
  const needle = String(filters.q ?? '').trim().toLowerCase();
  const status = filters.status ?? DEFAULT_PROJECT_FILTERS.status;
  const sorter = SORTERS[filters.sort] ?? SORTERS.rank;
  return (projects ?? [])
    .map((project) => ({ project, signals: signalsById?.[project.id] ?? null }))
    .filter((entry) => matchesStatus(entry.project, status))
    .filter((entry) => matchesText(entry.project, needle))
    .filter((entry) => !filters.mine || needsViewer(entry.signals))
    .sort(sorter);
}

/** The line above the table: what is waiting on the viewer across non-archived projects. */
export function summarizeAttention(projects = [], signalsById = {}, { now = new Date() } = {}) {
  let items = 0;
  let projectsWithItems = 0;
  let reviewsOwed = 0;
  let soonestReview = null;
  for (const project of projects ?? []) {
    if (isArchivedProject(project)) continue;
    const signals = signalsById?.[project.id];
    const count = waitingCount(signals);
    items += count;
    if (needsViewer(signals)) projectsWithItems += 1;
    const review = signals?.review;
    if (review?.awaitingYou) {
      reviewsOwed += 1;
      const due = toTime(review.dueAt);
      if (due != null && due >= (now instanceof Date ? now.valueOf() : Date.now()) && (soonestReview == null || due < toTime(soonestReview.review.dueAt))) {
        soonestReview = { project, review };
      }
    }
  }
  return { items, projectsWithItems, reviewsOwed, soonestReview };
}
