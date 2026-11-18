import { normalizeWorkingCalendar } from '../governance/schedule-analysis.js';

// Home works in UTC calendar dates (YYYY-MM-DD), like Insights. Working days follow the
// project's working calendar, else Monday to Friday.

const DAY_MS = 86_400_000;

export function dateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00.000Z`)) ? text : null;
}

function toDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function addDays(value, days) {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from, to) {
  return Math.round((toDate(to).valueOf() - toDate(from).valueOf()) / DAY_MS);
}

export function isWorkingDay(value, calendarInput = null) {
  const calendar = normalizeWorkingCalendar(calendarInput);
  return calendar.workingDays.includes(toDate(value).getUTCDay()) && !calendar.holidays.includes(value);
}

/** The date `count` working days after `value`; zero is `value` itself. */
export function addWorkingDays(value, count, calendar = null) {
  let date = value;
  let left = count;
  // A bounded walk: a calendar with no working days would otherwise never end.
  for (let guard = 0; left > 0 && guard < 400; guard += 1) {
    date = addDays(date, 1);
    if (isWorkingDay(date, calendar)) left -= 1;
  }
  return date;
}

export function weekdayShort(value) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(toDate(value));
}

export function shortDate(value) {
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(toDate(value));
}

/** "today", "tomorrow", a weekday within the next six days, else "Oct 14". */
export function dayWord(value, today) {
  const days = daysBetween(today, value);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days < 7) return weekdayShort(value);
  return shortDate(value);
}
