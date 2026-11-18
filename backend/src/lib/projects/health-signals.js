// Health signals say whether a sprint, a person or a project is on track, from fixed rules over
// numbers Odin already holds. Project Insights shows them as its "At risk:" headline and Home
// uses them for "you're behind", so both read the same verdict for the same data.
//
// Every evaluator is pure: callers pass the data and `today` (YYYY-MM-DD, UTC). Each returns
// a signal: { kind, scope, subject, headline, evidence[] }, or null when there is nothing to
// judge. Evidence entries name the rule, the values it compared and a link target
// ({ type: 'sprint' | 'milestone' | 'item' | 'schedule' | 'baseline' | 'burnup', projectId, id })
// that a screen turns into a route.

import { normalizeWorkingCalendar, workingDaysBetween } from '../../modules/governance/schedule-analysis.js';
import { estimateHoursFor } from './work-progress.js';

export const HEALTH_KINDS = Object.freeze({ BEHIND: 'behind', ON_TRACK: 'on-track', WATCH: 'watch' });
export const HEALTH_SCOPES = Object.freeze({ PERSON: 'person', PROJECT: 'project', SPRINT: 'sprint' });

// Behind, for a sprint as a whole and for each person in it (user decision, 2026-10-12): nobody
// is behind before this share of the sprint's working days is gone...
export const BEHIND_FROM_ELAPSED = 0.5;
// ...and from then on, points closed below this share of the points assigned is behind.
export const BEHIND_BELOW_DONE_SHARE = 0.5;
// Person: this many of their own overdue items make them behind; one is a watch.
export const PERSON_OVERDUE_ITEMS_BEHIND = 2;
// Project: milestones due within this many calendar days count when they forecast late.
export const PROJECT_MILESTONE_LOOKAHEAD_DAYS = 30;

const SEVERITY = { [HEALTH_KINDS.ON_TRACK]: 0, [HEALTH_KINDS.WATCH]: 1, [HEALTH_KINDS.BEHIND]: 2 };
const SCOPE_SPECIFICITY = { [HEALTH_SCOPES.PROJECT]: 0, [HEALTH_SCOPES.SPRINT]: 1, [HEALTH_SCOPES.PERSON]: 2 };
const CLOSED_MILESTONE_STATUSES = new Set(['achieved', 'cancelled']);

function dateOnly(value) {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00.000Z`)) ? text : null;
}

function addCalendarDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

function shortDate(value) {
  const date = dateOnly(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
}

function pointsLabel(value) {
  return plural(round(value, 1), 'point');
}

function signal({ evidence = [], headline, kind, metrics = {}, scope, subject }) {
  return { evidence, headline, kind, metrics, scope, subject };
}

/** Working days in [start, end), counting with the project calendar. */
export function workingDaysBefore(start, end, calendarInput = null) {
  const from = dateOnly(start);
  const to = dateOnly(end);
  if (!from || !to || to <= from) return 0;
  const inclusive = workingDaysBetween(from, to, calendarInput, { inclusive: true }) ?? 0;
  const lastIsWorking = (workingDaysBetween(to, to, calendarInput, { inclusive: true }) ?? 0) === 1;
  return Math.max(0, inclusive - (lastIsWorking ? 1 : 0));
}

/**
 * The share of a sprint's working days gone before `today` (with the project calendar, else
 * Monday to Friday), or null when the sprint has no usable dates. A sprint past its end date
 * has all of its time gone; one that has not started has none.
 */
export function sprintTimeElapsed({ calendar = null, sprint, today }) {
  const start = dateOnly(sprint?.startDate);
  const end = dateOnly(sprint?.endDate);
  const day = dateOnly(today);
  if (!start || !end || !day || end < start) return null;
  const workingCalendar = normalizeWorkingCalendar(calendar);
  const sprintDays = Math.max(1, workingDaysBetween(start, end, workingCalendar, { inclusive: true }) ?? 1);
  const daysGone = day < start ? 0 : day > end ? sprintDays : Math.min(sprintDays, workingDaysBefore(start, day, workingCalendar));
  return { daysGone, elapsed: daysGone / sprintDays, sprintDays, started: day >= start };
}

/** The behind rule: from BEHIND_FROM_ELAPSED of the time onward, closed below BEHIND_BELOW_DONE_SHARE of assigned. */
export function isBehindPace({ assigned, closed, elapsed }) {
  return elapsed >= BEHIND_FROM_ELAPSED && assigned > 0 && closed < assigned * BEHIND_BELOW_DONE_SHARE;
}

/** Points (or items, when nothing in the sprint is estimated) for a list of sprint leaves. */
function sprintWeights(items) {
  const estimated = items.some((item) => Number(item.points) > 0);
  return {
    unit: estimated ? 'points' : 'items',
    weight: (item) => (estimated ? Math.max(0, Number(item.points) || 0) : 1),
  };
}

/**
 * Each person's standing in one sprint. `items` are the sprint's leaf work items:
 * { assigneeId, done, points }. Assigned is the current points of the items assigned to the
 * person, so moving scope out of the sprint lowers it. Returns the sprint total and one entry
 * per assignee, each with the threshold the rule compares against, or null when the sprint
 * cannot be judged.
 */
export function evaluateSprintPeople({ calendar = null, items = [], sprint, today }) {
  const time = sprintTimeElapsed({ calendar, sprint, today });
  if (!sprint?.id || !time || items.length === 0) return null;
  const { unit, weight } = sprintWeights(items);
  const people = new Map();
  let committed = 0;
  let done = 0;
  for (const item of items) {
    const points = weight(item);
    committed += points;
    if (item.done) done += points;
    const personId = String(item.assigneeId ?? '').trim();
    if (!personId) continue;
    const entry = people.get(personId) ?? { assigned: 0, closed: 0, id: personId };
    entry.assigned += points;
    if (item.done) entry.closed += points;
    people.set(personId, entry);
  }
  const judge = (assigned, closed) => ({
    assigned: round(assigned, 1),
    behind: isBehindPace({ assigned, closed, elapsed: time.elapsed }),
    closed: round(closed, 1),
    threshold: round(assigned * BEHIND_BELOW_DONE_SHARE, 1),
  });
  return {
    ...time,
    people: [...people.values()].map((entry) => ({ id: entry.id, ...judge(entry.assigned, entry.closed) })),
    total: judge(committed, done),
    unit,
  };
}

/**
 * Sprint scope. `items` are the sprint's leaf work items: { points, done }. Elapsed is the
 * share of the sprint's working days gone before today; done is done points over committed
 * points. The sprint is behind once half of its time is gone and less than half of its points
 * are done (isBehindPace); before halfway every sprint is on track, because little is ever
 * done in its first days. Without any estimated points the rule counts items instead.
 */
export function evaluateSprintHealth({ calendar = null, items = [], projectId = null, sprint, today }) {
  const time = sprintTimeElapsed({ calendar, sprint, today });
  if (!sprint?.id || !time || items.length === 0) return null;

  const start = dateOnly(sprint.startDate);
  const { unit, weight } = sprintWeights(items);
  const committed = items.reduce((sum, item) => sum + weight(item), 0);
  const done = items.filter((item) => item.done).reduce((sum, item) => sum + weight(item), 0);
  const { daysGone, elapsed, sprintDays } = time;
  const doneShare = committed > 0 ? done / committed : 0;
  const kind = time.started && isBehindPace({ assigned: committed, closed: done, elapsed }) ? HEALTH_KINDS.BEHIND : HEALTH_KINDS.ON_TRACK;
  const projected = elapsed > 0 ? Math.min(committed, done / elapsed) : committed;
  const willNotFinish = Math.max(0, committed - projected);
  const unitLabel = (value) => (unit === 'points' ? pointsLabel(value) : plural(round(value, 1), 'item'));
  const name = sprint.name || 'The sprint';
  const metrics = {
    committed: round(committed, 1),
    dayOfSprint: Math.min(sprintDays, daysGone + 1),
    daysGone,
    done: round(done, 1),
    doneShare: round(doneShare, 4),
    elapsed: round(elapsed, 4),
    projected: round(projected, 1),
    sprintDays,
    unit,
    willNotFinish: round(willNotFinish, 1),
  };
  const evidence = [{
    label: `${plural(daysGone, 'working day')} of ${sprintDays} gone (${percent(elapsed)}); ${unitLabel(done)} of ${round(committed, 1)} done (${percent(doneShare)})`,
    link: { id: sprint.id, projectId, type: 'sprint' },
    rule: 'sprint.elapsed_vs_done',
    values: { behindBelowDoneShare: BEHIND_BELOW_DONE_SHARE, behindFromElapsed: BEHIND_FROM_ELAPSED, doneShare: metrics.doneShare, elapsed: metrics.elapsed },
  }];
  let headline;
  if (!time.started) headline = `${name} starts ${shortDate(start)}`;
  else if (kind === HEALTH_KINDS.BEHIND) headline = `${name} is behind: about ${unitLabel(willNotFinish)} may not finish`;
  else headline = `${name} is on track: ${percent(doneShare)} done with ${percent(elapsed)} of the time gone`;
  return signal({ evidence, headline, kind, metrics, scope: HEALTH_SCOPES.SPRINT, subject: { id: sprint.id, name: sprint.name ?? '' } });
}

/**
 * Person scope. `items` are the person's own leaf items: { id, name, done, targetEndDate,
 * points, targetHourEstimate, inActiveSprint }. Behind when an overdue item is on the critical
 * path or blocks someone else, when two or more of their items are overdue, or when the hours
 * left on their active-sprint work exceed their remaining sprint capacity. One overdue item
 * on its own is a watch. `remainingCapacityHours` is null when capacity is unknown.
 */
export function evaluatePersonHealth({
  blockingItemIds = new Set(),
  criticalPathIds = new Set(),
  items = [],
  person,
  projectId = null,
  remainingCapacityHours = null,
  today,
}) {
  const day = dateOnly(today);
  if (!person?.id || !day) return null;
  const overdue = items.filter((item) => !item.done && dateOnly(item.targetEndDate) && dateOnly(item.targetEndDate) < day);
  const flagged = overdue.filter((item) => criticalPathIds.has(item.id) || blockingItemIds.has(item.id));
  const remainingHours = items.filter((item) => item.inActiveSprint && !item.done).reduce((sum, item) => sum + estimateHoursFor(item).hours, 0);
  const overCapacity = remainingCapacityHours != null && remainingHours > remainingCapacityHours;
  const itemLink = (item) => ({ id: item.id, projectId, type: 'item' });
  const evidence = [];

  for (const item of flagged) {
    const reasons = [criticalPathIds.has(item.id) ? 'on the critical path' : null, blockingItemIds.has(item.id) ? 'blocks other people' : null].filter(Boolean).join(' and ');
    evidence.push({ label: `${item.name || 'An item'} is overdue (due ${shortDate(item.targetEndDate)}) and ${reasons}`, link: itemLink(item), rule: 'person.overdue_blocking', values: { dueDate: dateOnly(item.targetEndDate) } });
  }
  for (const item of overdue.filter((entry) => !flagged.includes(entry))) {
    evidence.push({ label: `${item.name || 'An item'} is overdue (due ${shortDate(item.targetEndDate)})`, link: itemLink(item), rule: 'person.overdue', values: { dueDate: dateOnly(item.targetEndDate) } });
  }
  if (overCapacity) {
    evidence.push({ label: `${round(remainingHours, 1)}h of sprint work left against ${round(remainingCapacityHours, 1)}h of capacity`, link: null, rule: 'person.over_capacity', values: { remainingCapacityHours: round(remainingCapacityHours, 1), remainingHours: round(remainingHours, 1) } });
  }

  let kind = HEALTH_KINDS.ON_TRACK;
  if (flagged.length > 0 || overdue.length >= PERSON_OVERDUE_ITEMS_BEHIND || overCapacity) kind = HEALTH_KINDS.BEHIND;
  else if (overdue.length === 1) kind = HEALTH_KINDS.WATCH;

  // `self` marks the viewer's own signal, which reads "You have" rather than "Ada has".
  const name = person.self ? 'You' : person.name || 'This person';
  const has = person.self ? 'have' : 'has';
  let headline;
  if (flagged.length > 0) headline = `${name} ${has} overdue work that holds others up`;
  else if (overdue.length >= PERSON_OVERDUE_ITEMS_BEHIND) headline = `${name} ${has} ${plural(overdue.length, 'overdue item')}`;
  else if (overCapacity) headline = `${name} ${has} more sprint work left than time`;
  else if (overdue.length === 1) headline = `${name} ${has} 1 overdue item`;
  else headline = `${name} ${person.self ? 'are' : 'is'} on track`;

  return signal({
    evidence,
    headline,
    kind,
    metrics: { overdueCount: overdue.length, remainingCapacityHours: remainingCapacityHours == null ? null : round(remainingCapacityHours, 1), remainingHours: round(remainingHours, 1) },
    scope: HEALTH_SCOPES.PERSON,
    subject: { id: person.id, name: person.name ?? '' },
  });
}

/**
 * Project scope, from the governance schedule analysis. Behind when the critical-path
 * forecast finishes after the project end date, when an open milestone due in the next 30
 * days forecasts late, or when the plan finishes later than its baseline. A delivery-pace
 * forecast (`throughputForecast`: { date }) that lands after the end date is a watch.
 */
export function evaluateProjectHealth({ analysis = null, milestones = [], project, throughputForecast = null, today }) {
  const day = dateOnly(today);
  if (!project?.id || !day) return null;
  const evidence = [];
  const projectId = project.id;
  const target = dateOnly(project.endDate);
  let behind = false;
  let watch = false;

  const forecastVariance = Number(analysis?.forecastVarianceDays);
  if (Number.isFinite(forecastVariance) && forecastVariance > 0) {
    behind = true;
    evidence.push({
      label: `Critical-path forecast ${shortDate(analysis.forecastFinish)} is ${plural(forecastVariance, 'working day')} after the ${shortDate(target)} target`,
      link: { id: projectId, projectId, type: 'schedule' },
      rule: 'project.forecast_variance',
      values: { forecastFinish: dateOnly(analysis.forecastFinish), forecastVarianceDays: forecastVariance, target },
    });
  }

  const closed = new Set(milestones.filter((milestone) => CLOSED_MILESTONE_STATUSES.has(String(milestone.status ?? '').toLowerCase())).map((milestone) => milestone.id));
  const horizon = addCalendarDays(day, PROJECT_MILESTONE_LOOKAHEAD_DAYS);
  for (const milestone of analysis?.milestoneForecasts ?? []) {
    const due = dateOnly(milestone.targetDate);
    const variance = Number(milestone.varianceWorkingDays);
    if (closed.has(milestone.id) || !due || due < day || due > horizon || !(variance > 0)) continue;
    behind = true;
    evidence.push({
      label: `${milestone.title || 'A milestone'} due ${shortDate(due)} forecasts ${plural(variance, 'working day')} late`,
      link: { id: milestone.id, projectId, type: 'milestone' },
      rule: 'project.milestone_variance',
      values: { forecastDate: dateOnly(milestone.forecastDate), targetDate: due, varianceWorkingDays: variance },
    });
  }

  const baselineVariance = Number(analysis?.baselineVariance?.projectFinishVarianceWorkingDays);
  if (Number.isFinite(baselineVariance) && baselineVariance > 0) {
    behind = true;
    evidence.push({
      label: `The plan finishes ${plural(baselineVariance, 'working day')} later than baseline "${analysis.baselineVariance.baselineName ?? ''}"`.replace(' ""', ''),
      link: { id: analysis.baselineVariance.baselineId ?? projectId, projectId, type: 'baseline' },
      rule: 'project.baseline_variance',
      values: { projectFinishVarianceWorkingDays: baselineVariance },
    });
  }

  const paceDate = dateOnly(throughputForecast?.date);
  if (paceDate && target && paceDate > target) {
    watch = true;
    evidence.push({
      label: `Delivery pace points to ${shortDate(paceDate)}, after the ${shortDate(target)} target`,
      link: { id: projectId, projectId, type: 'burnup' },
      rule: 'project.throughput_forecast',
      values: { forecastDate: paceDate, target },
    });
  }

  const kind = behind ? HEALTH_KINDS.BEHIND : watch ? HEALTH_KINDS.WATCH : HEALTH_KINDS.ON_TRACK;
  let headline;
  if (behind || watch) headline = evidence[0].label;
  else if (target) headline = `The schedule holds for the ${shortDate(target)} target`;
  else headline = 'No schedule rule is failing';

  return signal({
    evidence,
    headline,
    kind,
    metrics: { baselineVarianceDays: Number.isFinite(baselineVariance) ? baselineVariance : null, forecastVarianceDays: Number.isFinite(forecastVariance) ? forecastVariance : null },
    scope: HEALTH_SCOPES.PROJECT,
    subject: { id: projectId, name: project.name ?? '' },
  });
}

function bySeverityThenScope(left, right) {
  return SEVERITY[right.kind] - SEVERITY[left.kind] || SCOPE_SPECIFICITY[left.scope] - SCOPE_SPECIFICITY[right.scope];
}

/**
 * One verdict for a set of signals: the worst kind wins, and the headline leads with the
 * broadest failing scope (project, then sprint, then person), prefixed "At risk:", "Watch:"
 * or "On track:". Signals come back worst first.
 */
export function summarizeHealth(signals = []) {
  const present = signals.filter(Boolean).sort(bySeverityThenScope);
  if (present.length === 0) return { headline: '', kind: HEALTH_KINDS.ON_TRACK, signals: [] };
  const lead = present[0];
  const prefix = lead.kind === HEALTH_KINDS.BEHIND ? 'At risk' : lead.kind === HEALTH_KINDS.WATCH ? 'Watch' : 'On track';
  const others = present.filter((entry) => entry !== lead && entry.kind === lead.kind).length;
  const suffix = lead.kind !== HEALTH_KINDS.ON_TRACK && others > 0 ? ` (and ${plural(others, 'other signal')})` : '';
  return { headline: `${prefix}: ${lead.headline}${suffix}`, kind: lead.kind, signals: present };
}

/**
 * The signal a personal screen leads with: the most specific scope that is not on track
 * (person, then sprint, then project), or null when everything is on track.
 */
export function mostSpecificSignal(signals = []) {
  return signals
    .filter((entry) => entry && entry.kind !== HEALTH_KINDS.ON_TRACK)
    .sort((left, right) => SCOPE_SPECIFICITY[right.scope] - SCOPE_SPECIFICITY[left.scope] || SEVERITY[right.kind] - SEVERITY[left.kind])[0] ?? null;
}
