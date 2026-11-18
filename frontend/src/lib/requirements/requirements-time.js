// Short date and time phrases for the Requirements workspace ("today", "6 min ago",
// "due Fri Oct 10"). Every helper takes `now` so tests and live screens agree.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function toDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayDifference(date, now) {
  return Math.round((startOfDay(now).valueOf() - startOfDay(date).valueOf()) / (24 * HOUR_MS));
}

export function formatShortDate(value, { locale, weekday = false } = {}) {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(weekday ? { weekday: 'short' } : {}),
  }).format(date);
}

/** "today", "yesterday", "3 days ago", then "Oct 3" after a week. */
export function formatRelativeDay(value, { locale, now = new Date() } = {}) {
  const date = toDate(value);
  if (!date) return '';
  const days = dayDifference(date, toDate(now) ?? new Date());
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatShortDate(date, { locale });
}

/** "just now", "6 min ago", "3 h ago", then the relative day. */
export function formatAgo(value, { locale, now = new Date() } = {}) {
  const date = toDate(value);
  if (!date) return '';
  const current = toDate(now) ?? new Date();
  const elapsed = current.valueOf() - date.valueOf();
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < 24 * HOUR_MS && dayDifference(date, current) === 0) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return formatRelativeDay(date, { locale, now: current });
}

export function formatDateTime(value, { locale } = {}) {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(date);
}

export function isPast(value, { now = new Date() } = {}) {
  const date = toDate(value);
  return Boolean(date) && date.valueOf() < (toDate(now) ?? new Date()).valueOf();
}

/** `yyyy-mm-dd` for a date input, in local time. */
export function toDateInputValue(value) {
  const date = toDate(value);
  if (!date) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The last millisecond of the chosen local day, as an ISO string, for `until` fields. */
export function endOfLocalDayIso(dateInputValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateInputValue ?? ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}
