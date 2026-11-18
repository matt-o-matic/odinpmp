// Builds each built-in Insights card from the loaded project context. A card resolves to one
// of: ready (data, optional notes), thin (partial data plus when it fills in), empty (nothing
// to chart yet, with a next step), forbidden, or error. The service catches a failing builder
// so one card's error never blanks the others.

import {
  evaluatePersonHealth,
  evaluateProjectHealth,
  evaluateSprintHealth,
  summarizeHealth,
  workingDaysBefore,
} from '../../lib/projects/health-signals.js';
import { normalizeWorkingCalendar, workingDaysBetween } from '../governance/schedule-analysis.js';
import {
  addDays,
  burnupTotals,
  dateOnly,
  daysBetween,
  deriveThroughput,
  flowTotals,
  isDone,
  isTicketResolved,
  isWorkLeaf,
  replayAt,
  sampleDates,
  sprintTotals,
  ticketFlow,
  weekStart,
} from './insights-history.js';

export const FORECAST_MIN_HISTORY_DAYS = 14;
export const FORECAST_VELOCITY_WEEKS = 6;
export const FLOW_MIN_HISTORY_DAYS = 7;
export const TICKET_FLOW_MIN_HISTORY_DAYS = 14;
export const VELOCITY_SPRINT_COUNT = 6;
export const VELOCITY_AVERAGE_SPRINTS = 3;
export const MAX_FORECAST_DAYS = 730;
export const THROUGHPUT_ROW_LIMIT = 12;
const CHART_SAMPLE_TARGET = 13;
const MAX_TICKET_BUCKETS = 13;
const MAX_SPRINT_DAYS = 90;
const SEVERITIES = ['S1', 'S2', 'S3', 'S4'];
const CLOSED_RISK_STATUSES = new Set(['closed', 'accepted']);

export function readyCard(data, notes = []) { return { data, notes, status: 'ready' }; }
export function thinCard(data, message, availableOn = null, notes = []) { return { availableOn, data, message, notes, status: 'thin' }; }
export function emptyCard(message, action = null) { return { action, data: null, message, status: 'empty' }; }

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function formatDay(value) {
  const day = dateOnly(value);
  return day ? new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric' }).format(new Date(`${day}T00:00:00.000Z`)) : '';
}

function memo(ctx, key, compute) {
  if (!ctx.memo.has(key)) ctx.memo.set(key, compute());
  return ctx.memo.get(key);
}

function stepFor(start, end) {
  return Math.max(1, Math.ceil(daysBetween(start, end) / CHART_SAMPLE_TARGET));
}

function unitWord(unit) {
  return unit === 'items' ? 'items' : 'points';
}

function hasWorkItems(ctx) {
  return [...ctx.items.values()].some(isWorkLeaf);
}

function noWorkCard() {
  return emptyCard('No work items yet. Add epics, stories and tasks to the project structure.', { label: 'Open project structure', target: 'structure' });
}

function burnupSeries(ctx) {
  return memo(ctx, 'burnup-series', () => {
    const dates = sampleDates(ctx.chartStart, ctx.today, stepFor(ctx.chartStart, ctx.today));
    return replayAt({ dates, events: ctx.events, items: ctx.items, reduce: (states, date) => ({ date, ...burnupTotals(states, ctx.unit) }) });
  });
}

/**
 * Throughput forecast: weighted weekly velocity over up to six recent weeks (later weeks
 * weigh more), with a range of one standard deviation either side. Needs two weeks of
 * history and some completed work.
 */
export function throughputForecast(ctx) {
  return memo(ctx, 'forecast', () => {
    if (ctx.historyDays < FORECAST_MIN_HISTORY_DAYS) return null;
    const weeks = Math.min(FORECAST_VELOCITY_WEEKS, Math.floor(ctx.historyDays / 7));
    const dates = Array.from({ length: weeks + 1 }, (_, index) => addDays(ctx.today, -7 * (weeks - index)));
    const totals = replayAt({ dates, events: ctx.events, items: ctx.items, reduce: (states) => burnupTotals(states, ctx.unit) });
    const weekly = totals.slice(1).map((entry, index) => entry.done - totals[index].done);
    const weights = weekly.map((_, index) => index + 1);
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const mean = Math.max(0, weekly.reduce((sum, value, index) => sum + value * weights[index], 0) / weightTotal);
    const average = weekly.reduce((sum, value) => sum + value, 0) / weekly.length;
    const deviation = Math.sqrt(weekly.reduce((sum, value) => sum + (value - average) ** 2, 0) / weekly.length);
    const current = totals.at(-1);
    const remaining = Math.max(0, current.scope - current.done);
    const base = { method: 'weighted-weekly-velocity', remaining: round(remaining), unit: ctx.unit, weeklyVelocity: round(mean), weekly: weekly.map((value) => round(value)) };
    if (remaining === 0) return { ...base, complete: true, date: ctx.today, latest: ctx.today, earliest: ctx.today };
    if (mean <= 0) return { ...base, date: null, reason: 'no-recent-progress' };
    const finishIn = (velocity) => Math.ceil((remaining / velocity) * 7);
    const likelyDays = finishIn(mean);
    if (likelyDays > MAX_FORECAST_DAYS) return { ...base, date: null, reason: 'beyond-horizon' };
    return {
      ...base,
      date: addDays(ctx.today, likelyDays),
      earliest: addDays(ctx.today, finishIn(mean + deviation)),
      latest: addDays(ctx.today, Math.min(MAX_FORECAST_DAYS, finishIn(Math.max(mean - deviation, mean / 2)))),
    };
  });
}

export function buildBurnupCard(ctx) {
  if (!hasWorkItems(ctx)) return noWorkCard();
  const series = burnupSeries(ctx);
  const current = series.at(-1);
  if (current.scope === 0) return emptyCard('None of the work has points yet. Switch to Items, or add points to see the burnup.');
  const data = {
    criticalPathForecast: ctx.analysis?.forecastFinish ?? null,
    forecast: throughputForecast(ctx),
    notEstimated: current.notEstimated,
    remaining: round(current.scope - current.done),
    scopeAdded: round(current.scope - series[0].scope),
    series: series.map(({ date, done, scope }) => ({ date, done: round(done), scope: round(scope) })),
    since: series[0].date,
    target: dateOnly(ctx.project.endDate),
    today: ctx.today,
    unit: ctx.unit,
  };
  const notes = [];
  if (ctx.unit === 'points' && current.notEstimated > 0) notes.push(`${current.notEstimated} item${current.notEstimated === 1 ? ' has' : 's have'} no points and ${current.notEstimated === 1 ? 'is' : 'are'} left out of point totals.`);
  if (ctx.historyDays < FORECAST_MIN_HISTORY_DAYS) {
    return thinCard(data, 'The forecast appears after 2 weeks of history.', addDays(ctx.coverageStart, FORECAST_MIN_HISTORY_DAYS), notes);
  }
  return readyCard(data, notes);
}

function sprintById(ctx, sprintId) {
  return ctx.sprints.find((sprint) => sprint.id === sprintId) ?? null;
}

/** The sprint the filter names, else the active sprint that started last. */
export function selectedSprint(ctx) {
  return memo(ctx, 'sprint', () => {
    if (ctx.sprintId) return sprintById(ctx, ctx.sprintId);
    return ctx.sprints
      .filter((sprint) => String(sprint.status ?? '').toLowerCase() === 'active')
      .sort((left, right) => String(right.startDate ?? '').localeCompare(String(left.startDate ?? '')))[0] ?? null;
  });
}

function isWorkingDate(date, calendar) {
  return (workingDaysBetween(date, date, calendar, { inclusive: true }) ?? 0) === 1;
}

function sprintWorkingDates(sprint, calendar) {
  const start = dateOnly(sprint.startDate);
  const end = dateOnly(sprint.endDate);
  const dates = [];
  for (let day = start; day <= end && dates.length < MAX_SPRINT_DAYS; day = addDays(day, 1)) {
    if (isWorkingDate(day, calendar)) dates.push(day);
  }
  return dates;
}

function currentSprintItems(ctx, sprintId) {
  return [...ctx.items.values()]
    .filter((item) => isWorkLeaf(item) && item.sprintId === sprintId)
    .map((item) => ({ done: isDone(item), points: ctx.unit === 'items' ? 1 : item.points }));
}

export function sprintSignal(ctx) {
  return memo(ctx, 'sprint-signal', () => {
    const sprint = selectedSprint(ctx);
    if (!sprint) return null;
    const items = [...ctx.items.values()].filter((item) => isWorkLeaf(item) && item.sprintId === sprint.id).map((item) => ({ done: isDone(item), points: item.points }));
    return evaluateSprintHealth({ calendar: ctx.calendar, items, projectId: ctx.project.id, sprint, today: ctx.today });
  });
}

export function buildSprintBurndownCard(ctx) {
  const sprint = selectedSprint(ctx);
  const planAction = { label: 'Plan a sprint', target: 'sprints' };
  if (!sprint) return emptyCard(ctx.sprintId ? 'That sprint no longer exists.' : 'No active sprint. The burndown appears once a sprint is started.', planAction);
  const start = dateOnly(sprint.startDate);
  const end = dateOnly(sprint.endDate);
  if (!start || !end || end < start) return emptyCard(`Set start and end dates on ${sprint.name} to see its burndown.`, { label: 'Open sprints', target: 'sprints' });
  if (currentSprintItems(ctx, sprint.id).length === 0) return emptyCard(`No work is planned in ${sprint.name} yet.`, { label: 'Open sprints', target: 'sprints' });
  if (ctx.today < start) return emptyCard(`${sprint.name} starts ${formatDay(start)}. Its burndown begins on the first day.`, { label: 'Open sprints', target: 'sprints' });

  const calendar = normalizeWorkingCalendar(ctx.calendar);
  const dates = sprintWorkingDates(sprint, calendar);
  const pastDates = dates.filter((date) => date <= ctx.today);
  const replayDates = pastDates.length ? pastDates : [start];
  const series = replayAt({
    dates: replayDates,
    events: ctx.events,
    items: ctx.items,
    reduce: (states, date) => {
      const totals = sprintTotals(states, sprint.id, ctx.unit);
      return { date, remaining: round(totals.committed - totals.done), scope: round(totals.committed) };
    },
  });
  const committed = series[0].scope;
  const lastIndex = Math.max(1, dates.length - 1);
  const scopeChanges = series.slice(1)
    .map((point, index) => ({ date: point.date, delta: round(point.scope - series[index].scope) }))
    .filter((change) => change.delta !== 0);
  const signal = sprintSignal(ctx);
  const data = {
    committed,
    dates,
    health: signal ? { headline: signal.headline, kind: signal.kind, metrics: signal.metrics } : null,
    ideal: dates.map((date, index) => ({ date, value: round(committed * (1 - index / lastIndex)) })),
    remaining: series.at(-1).remaining,
    scopeChanges,
    series,
    sprint: { endDate: end, id: sprint.id, name: sprint.name, startDate: start, status: sprint.status ?? null },
    today: ctx.today,
    unit: ctx.unit,
  };
  const notes = start < ctx.coverageStart ? [`Days before ${formatDay(ctx.coverageStart)} use the sprint's current items; Odin has no earlier history for them.`] : [];
  return readyCard(data, notes);
}

function completedSprints(ctx) {
  return ctx.sprints
    .filter((sprint) => {
      const start = dateOnly(sprint.startDate);
      const end = dateOnly(sprint.endDate);
      if (!start || !end || end < start) return false;
      const status = String(sprint.status ?? '').toLowerCase();
      return status === 'completed' || (end < ctx.today && status !== 'planned');
    })
    .sort((left, right) => String(left.endDate).localeCompare(String(right.endDate)))
    .slice(-VELOCITY_SPRINT_COUNT);
}

/** Committed counts a sprint's items on its first day; completed counts those done on its last. */
export function velocityRows(ctx) {
  return memo(ctx, 'velocity', () => {
    const sprints = completedSprints(ctx);
    if (sprints.length === 0) return [];
    const ids = new Set(sprints.map((sprint) => sprint.id));
    const dates = [...new Set(sprints.flatMap((sprint) => [dateOnly(sprint.startDate), dateOnly(sprint.endDate)]))];
    const dateIndex = new Map(dates.map((date, index) => [date, index]));
    const snapshots = replayAt({
      dates,
      events: ctx.events,
      items: ctx.items,
      reduce: (states) => {
        const result = new Map();
        for (const sprintId of ids) result.set(sprintId, sprintTotals(states, sprintId, ctx.unit));
        return result;
      },
    });
    return sprints.map((sprint) => {
      const atStart = snapshots[dateIndex.get(dateOnly(sprint.startDate))].get(sprint.id);
      const atEnd = snapshots[dateIndex.get(dateOnly(sprint.endDate))].get(sprint.id);
      return {
        approximate: dateOnly(sprint.startDate) < ctx.coverageStart,
        // A sprint filled after its first day (its items created later) counts what it ended with.
        committed: round(atStart.count > 0 ? atStart.committed : atEnd.committed),
        completed: round(atEnd.done),
        endDate: dateOnly(sprint.endDate),
        id: sprint.id,
        name: sprint.name,
        startDate: dateOnly(sprint.startDate),
      };
    });
  });
}

export function velocitySummary(ctx) {
  const rows = velocityRows(ctx);
  const recent = rows.slice(-VELOCITY_AVERAGE_SPRINTS).map((row) => row.completed);
  if (recent.length === 0) return null;
  return {
    average: round(recent.reduce((sum, value) => sum + value, 0) / recent.length),
    max: Math.max(...recent),
    min: Math.min(...recent),
    sprintCount: recent.length,
  };
}

export function buildVelocityCard(ctx) {
  const rows = velocityRows(ctx);
  if (rows.length === 0) return emptyCard('Velocity appears once a sprint is completed.', { label: 'Open sprints', target: 'sprints' });
  const summary = velocitySummary(ctx);
  const data = { sprints: rows, summary: rows.length >= VELOCITY_AVERAGE_SPRINTS ? summary : null, unit: ctx.unit };
  const notes = rows.some((row) => row.approximate) ? [`Sprints that started before ${formatDay(ctx.coverageStart)} use their current items, because Odin has no earlier history.`] : [];
  if (rows.length < VELOCITY_AVERAGE_SPRINTS) return thinCard(data, `The average and a suggested commitment need ${VELOCITY_AVERAGE_SPRINTS} completed sprints.`, null, notes);
  return readyCard(data, notes);
}

export function buildCumulativeFlowCard(ctx) {
  if (!hasWorkItems(ctx)) return noWorkCard();
  const dates = sampleDates(ctx.chartStart, ctx.today, stepFor(ctx.chartStart, ctx.today));
  const series = replayAt({ dates, events: ctx.events, items: ctx.items, reduce: (states, date) => ({ date, ...flowTotals(states, ctx.unit) }) })
    .map((point) => ({ date: point.date, done: round(point.done), inProgress: round(point.inProgress), notStarted: round(point.notStarted), review: round(point.review) }));
  const data = { series, unit: ctx.unit };
  if (ctx.historyDays < FLOW_MIN_HISTORY_DAYS) return thinCard(data, 'Flow over time appears after a week of history.', addDays(ctx.coverageStart, FLOW_MIN_HISTORY_DAYS));
  return readyCard(data);
}

function hasTickets(ctx) {
  return (ctx.project.tickets ?? []).length > 0 || ctx.events.some((event) => event.itemType === 'ticket');
}

export function buildTicketFlowCard(ctx) {
  if (!hasTickets(ctx)) return emptyCard('No tickets yet.', { label: 'Open tickets', target: 'tickets' });
  const first = weekStart(ctx.chartStart);
  const weeks = Math.floor(daysBetween(first, ctx.today) / 7) + 1;
  const bucketDays = 7 * Math.ceil(weeks / MAX_TICKET_BUCKETS);
  const starts = [];
  for (let start = first; start <= ctx.today; start = addDays(start, bucketDays)) starts.push(start);
  const buckets = ticketFlow({ buckets: starts, end: ctx.today, events: ctx.events })
    .map((row, index) => ({ ...row, end: index + 1 < starts.length ? addDays(starts[index + 1], -1) : ctx.today }));
  const recent = buckets.slice(-4);
  const overflow = recent.filter((row) => row.opened > row.resolved).length;
  const data = { bucketDays, buckets, overflowWeeks: overflow, recentCount: recent.length };
  if (ctx.historyDays < TICKET_FLOW_MIN_HISTORY_DAYS) return thinCard(data, 'Ticket flow fills in after 2 weeks of history.', addDays(ctx.coverageStart, TICKET_FLOW_MIN_HISTORY_DAYS));
  return readyCard(data);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function openTicketStats(ctx) {
  return memo(ctx, 'tickets', () => {
    const tickets = ctx.project.tickets ?? [];
    const open = tickets.filter((ticket) => !isTicketResolved(ticket.status));
    const openedAt = new Map();
    for (const event of ctx.events) if (event.itemType === 'ticket' && !event.before && event.after) openedAt.set(event.itemId, dateOnly(event.at));
    const ages = open.map((ticket) => openedAt.get(ticket.id)).filter(Boolean).map((day) => daysBetween(day, ctx.today));
    return {
      bySeverity: SEVERITIES.map((severity) => ({ count: open.filter((ticket) => (ticket.severity ?? 'S3') === severity).length, severity })),
      knownAgeCount: ages.length,
      medianAgeDays: median(ages),
      open: open.length,
      reopened: tickets.reduce((sum, ticket) => sum + (Number(ticket.reopenCount) || 0), 0),
      total: tickets.length,
    };
  });
}

export function buildTicketsBySeverityCard(ctx) {
  const stats = openTicketStats(ctx);
  if (stats.total === 0) return emptyCard('No tickets yet.', { label: 'Open tickets', target: 'tickets' });
  if (stats.open === 0) return emptyCard('No open tickets. Every ticket is closed, rejected or deferred.', { label: 'Open tickets', target: 'tickets' });
  const notes = stats.knownAgeCount < stats.open && stats.knownAgeCount > 0 ? [`Median age covers the ${stats.knownAgeCount} open tickets opened since ${formatDay(ctx.coverageStart)}.`] : [];
  return readyCard(stats, notes);
}

export function buildThroughputCard(ctx) {
  if (ctx.metricsRows instanceof Error) throw ctx.metricsRows;
  let rows = (ctx.metricsRows ?? []).filter((row) => row.points > 0 || row.tasksCompleted > 0);
  let source = 'contributor-metrics';
  if (rows.length === 0) {
    rows = deriveThroughput({ events: ctx.events, items: ctx.items, since: ctx.windowStart }).map((row) => ({ ...row, name: ctx.memberNames.get(row.id) ?? 'Former member' }));
    source = 'item-history';
  }
  if (rows.length === 0) return emptyCard(`No completed work in the last ${ctx.days} days.`);
  const sorted = rows
    .map((row) => ({ hoursLogged: round(row.hoursLogged ?? 0, 2), id: row.id, name: row.name ?? ctx.memberNames.get(row.id) ?? 'Unknown', points: row.points, tasksCompleted: row.tasksCompleted }))
    .sort((left, right) => right.points - left.points || right.tasksCompleted - left.tasksCompleted || left.name.localeCompare(right.name));
  const data = { contributorCount: sorted.length, days: ctx.days, rows: sorted.slice(0, THROUGHPUT_ROW_LIMIT), source };
  const notes = source === 'item-history' && ctx.coverageStart > ctx.windowStart ? [`Counted from item history since ${formatDay(ctx.coverageStart)}.`] : [];
  return readyCard(data, notes);
}

export function buildMilestonesCard(ctx) {
  const milestones = ctx.governance?.milestones ?? [];
  if (milestones.length === 0) return emptyCard('No milestones yet. Add milestones in Governance to track them against the plan.', { label: 'Open Governance', target: 'governance' });
  const calendar = ctx.calendar;
  const forecasts = new Map((ctx.analysis?.milestoneForecasts ?? []).map((entry) => [entry.id, entry]));
  const baseline = ctx.governance?.scheduleBaselines?.[0] ?? null;
  const baselineDates = new Map((baseline?.snapshot?.milestones ?? []).map((entry) => [entry.id, dateOnly(entry.targetDate)]));
  const rows = milestones
    .map((milestone) => {
      const forecast = forecasts.get(milestone.id);
      const targetDate = dateOnly(milestone.targetDate);
      const forecastDate = dateOnly(forecast?.forecastDate) ?? targetDate;
      const baselineDate = baselineDates.get(milestone.id) ?? null;
      const reference = baselineDate ?? targetDate;
      return {
        baselineDate,
        forecastDate,
        id: milestone.id,
        status: milestone.status ?? null,
        targetDate,
        title: milestone.title ?? '',
        varianceWorkingDays: reference && forecastDate ? workingDaysBetween(reference, forecastDate, calendar) : null,
      };
    })
    .sort((left, right) => String(left.targetDate ?? '9999').localeCompare(String(right.targetDate ?? '9999')));
  const data = { baseline: baseline ? { capturedAt: baseline.capturedAt ?? null, id: baseline.id, name: baseline.name ?? '' } : null, milestones: rows, today: ctx.today };
  const notes = baseline ? [] : ['No baseline yet, so forecasts compare with the current target dates. Capture a baseline in Governance to compare against the committed plan.'];
  return readyCard(data, notes);
}

function openRiskStats(ctx) {
  const risks = (ctx.governance?.items ?? []).filter((item) => item.kind === 'risk' && !CLOSED_RISK_STATUSES.has(String(item.status ?? '').toLowerCase()));
  return { critical: risks.filter((item) => item.impact === 'critical').length, open: risks.length };
}

function blockingItemIds(ctx) {
  const ids = new Set();
  for (const dependency of ctx.governance?.dependencies ?? []) {
    const predecessor = ctx.items.get(dependency.predecessorId);
    const successor = ctx.items.get(dependency.successorId);
    if (predecessor?.assigneeId && successor?.assigneeId && predecessor.assigneeId !== successor.assigneeId) ids.add(predecessor.id);
  }
  return ids;
}

function viewerSignal(ctx) {
  const viewerId = ctx.viewer?.id;
  if (!viewerId) return null;
  const sprint = selectedSprint(ctx);
  const own = [...ctx.items.values()].filter((item) => item.exists && item.leaf && item.itemType !== 'epic' && item.assigneeId === viewerId);
  if (own.length === 0) return null;
  let remainingCapacityHours = null;
  const staffing = (sprint?.staffing ?? []).find((entry) => entry.userId === viewerId);
  const capacity = Number(staffing?.capacityHours);
  const start = dateOnly(sprint?.startDate);
  const end = dateOnly(sprint?.endDate);
  if (Number.isFinite(capacity) && capacity > 0 && start && end && ctx.today >= start && ctx.today <= end) {
    const sprintDays = Math.max(1, workingDaysBetween(start, end, ctx.calendar, { inclusive: true }) ?? 1);
    const gone = workingDaysBefore(start, ctx.today, ctx.calendar);
    remainingCapacityHours = capacity * Math.max(0, sprintDays - gone) / sprintDays;
  }
  return evaluatePersonHealth({
    blockingItemIds: blockingItemIds(ctx),
    criticalPathIds: new Set(ctx.analysis?.criticalPathIds ?? []),
    items: own.map((item) => ({ ...item, done: isDone(item), inActiveSprint: Boolean(sprint && item.sprintId === sprint.id) })),
    person: { id: viewerId, name: 'You', self: true },
    projectId: ctx.project.id,
    remainingCapacityHours,
    today: ctx.today,
  });
}

/** The page verdict: project, selected sprint and the viewer's own work, summarized. */
export function buildHealth(ctx) {
  const project = evaluateProjectHealth({
    analysis: ctx.analysis,
    milestones: ctx.governance?.milestones ?? [],
    project: ctx.project,
    throughputForecast: throughputForecast(ctx),
    today: ctx.today,
  });
  return summarizeHealth([project, sprintSignal(ctx), viewerSignal(ctx)]);
}

/** The headline row. Each tile is null when its source has nothing to say. */
export function buildHeadlineCard(ctx, { earnedValue = null } = {}) {
  const forecast = throughputForecast(ctx);
  const series = hasWorkItems(ctx) ? burnupSeries(ctx) : [];
  const current = series.at(-1) ?? null;
  const signal = sprintSignal(ctx);
  const sprint = selectedSprint(ctx);
  const tickets = openTicketStats(ctx);
  const target = dateOnly(ctx.project.endDate);
  const criticalPath = dateOnly(ctx.analysis?.forecastFinish);
  const likely = dateOnly(forecast?.date);
  const finish = likely ?? criticalPath;
  return readyCard({
    cost: earnedValue?.status === 'ready' ? { cpi: earnedValue.data.kpis.cpi, currency: earnedValue.data.currency, eac: earnedValue.data.kpis.eac, budget: earnedValue.data.budget } : null,
    forecast: finish ? { criticalPath, date: finish, earliest: forecast?.earliest ?? null, late: Boolean(target && finish > target), latest: forecast?.latest ?? null, method: likely ? 'throughput' : 'critical-path', target } : null,
    risks: openRiskStats(ctx),
    scope: current && current.scope > 0 ? { added: round(current.scope - series[0].scope), done: round(current.done), percent: Math.round((current.done / current.scope) * 100), scope: round(current.scope), since: series[0].date, unit: unitWord(ctx.unit) } : null,
    sprint: sprint && signal ? { id: sprint.id, kind: signal.kind, name: sprint.name, ...signal.metrics } : null,
    tickets: { open: tickets.open, s1: tickets.bySeverity[0].count, s2: tickets.bySeverity[1].count },
    velocity: velocitySummary(ctx),
  });
}
