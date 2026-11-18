import { syntheticProject, syntheticUser } from './synthetic-api.js';

// Synthetic Project Insights API: the aggregate payload, layout writes and saved-report cards.
// Install after installSyntheticApi so these handlers take precedence.

const API = `http://localhost:3001/api/projects/${syntheticProject.id}/insights`;
const PROJECT_ID = syntheticProject.id;
const TODAY = '2026-10-09';

export const DEFAULT_CARDS = [
  'headline', 'burnup', 'sprint-burndown', 'velocity', 'cumulative-flow', 'ticket-flow',
  'tickets-by-severity', 'milestones', 'earned-value', 'throughput', 'saved-reports',
].map((type) => ({ type }));

export const SAVED_REPORTS = [
  { dataset: 'work_items', delivery: { channel: 'in_app', enabled: true, format: 'csv', intervalMinutes: 1440, nextRunAt: null }, description: 'Open defects grouped by severity.', id: 'report-defects', lastRunAt: '2026-10-09T10:00:00.000Z', name: 'Open defects by severity', projectScoped: true, status: 'active', visibility: 'project', visualization: 'bar' },
  { dataset: 'executive', delivery: null, description: '', id: 'report-weekly', lastRunAt: null, name: 'Weekly status', projectScoped: false, status: 'active', visibility: 'tenant', visualization: 'summary' },
];

function addDays(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weeklyDates(start, count) {
  return Array.from({ length: count }, (_, index) => addDays(start, index * 7));
}

const ready = (data, notes = []) => ({ data, notes, status: 'ready' });

function healthPayload() {
  return {
    headline: 'At risk: Payments integration due Oct 20 forecasts 3 working days late (and 1 other signal)',
    kind: 'behind',
    signals: [
      {
        evidence: [{ label: 'Payments integration due Oct 20 forecasts 3 working days late', link: { id: 'milestone-payments', projectId: PROJECT_ID, type: 'milestone' }, rule: 'project.milestone_variance', values: {} }],
        headline: 'Payments integration due Oct 20 forecasts 3 working days late',
        kind: 'behind',
        metrics: {},
        scope: 'project',
        subject: { id: PROJECT_ID, name: syntheticProject.name },
      },
      {
        evidence: [{ label: '6 working days of 10 gone (60%); 15 points of 33 done (45%)', link: { id: 'sprint-14', projectId: PROJECT_ID, type: 'sprint' }, rule: 'sprint.elapsed_vs_done', values: {} }],
        headline: 'Sprint 14 is behind: about 9 points may not finish',
        kind: 'behind',
        metrics: {},
        scope: 'sprint',
        subject: { id: 'sprint-14', name: 'Sprint 14' },
      },
      {
        evidence: [{ label: 'Validate rollout is overdue (due Aug 28)', link: { id: 'task-synthetic', projectId: PROJECT_ID, type: 'item' }, rule: 'person.overdue', values: {} }],
        headline: 'You have 1 overdue item',
        kind: 'watch',
        metrics: {},
        scope: 'person',
        subject: { id: syntheticUser.id, name: 'You' },
      },
    ],
  };
}

function cardsPayload({ finance }) {
  const burnupDates = [...weeklyDates('2026-07-13', 13), TODAY];
  const burnupSeries = burnupDates.map((date, index) => ({ date, done: Math.round(40 + (146 * index) / (burnupDates.length - 1)), scope: Math.min(300, 250 + index * 4) }));
  const sprintDates = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'];
  const remaining = [30, 30, 27, 25, 28, 21, 18];
  const flowDates = weeklyDates('2026-07-13', 13);
  const ticketWeeks = weeklyDates('2026-08-17', 8);
  const opened = [6, 9, 7, 12, 10, 8, 14, 11];
  const resolved = [5, 7, 9, 8, 9, 10, 9, 8];
  return {
    burnup: ready({
      criticalPathForecast: '2026-12-03',
      forecast: { date: '2026-12-07', earliest: '2026-11-30', latest: '2026-12-14', method: 'weighted-weekly-velocity', remaining: 114, unit: 'points', weekly: [12, 13, 11, 14, 12, 13], weeklyVelocity: 12.8 },
      notEstimated: 14,
      remaining: 114,
      scopeAdded: 50,
      series: burnupSeries,
      since: '2026-07-13',
      target: '2026-12-04',
      today: TODAY,
      unit: 'points',
    }, ['14 items have no points and are left out of point totals.']),
    'cumulative-flow': ready({
      series: flowDates.map((date, index) => ({ date, done: 20 + index * 6, inProgress: 8 + (index % 3), notStarted: 90 - index * 4, review: 3 + Math.floor(index * 0.7) })),
      unit: 'points',
    }),
    'earned-value': finance
      ? ready({
        budget: 420000,
        currency: 'USD',
        kpis: { ac: 270000, cpi: 0.94, eac: 447000, ev: 254000, pv: 262000, spi: 0.97 },
        otherCurrencies: [],
        series: weeklyDates('2026-07-13', 13).map((date, index) => ({ ac: 20000 + index * 20800, date, ev: 18000 + index * 19700, pv: 19000 + index * 20250 })),
      })
      : { data: null, message: 'Cost and earned value are visible to managers and admins.', status: 'forbidden' },
    headline: ready({
      cost: finance ? { budget: 420000, cpi: 0.94, currency: 'USD', eac: 447000 } : null,
      forecast: { criticalPath: '2026-12-03', date: '2026-12-07', earliest: '2026-11-30', late: true, latest: '2026-12-14', method: 'throughput', target: '2026-12-04' },
      risks: { critical: 1, open: 7 },
      scope: { added: 50, done: 186, percent: 62, scope: 300, since: '2026-07-13', unit: 'points' },
      sprint: { committed: 33, dayOfSprint: 7, done: 15, id: 'sprint-14', kind: 'behind', name: 'Sprint 14', sprintDays: 10, unit: 'points' },
      tickets: { open: 18, s1: 1, s2: 4 },
      velocity: { average: 26, max: 29, min: 23, sprintCount: 3 },
    }),
    milestones: ready({
      baseline: { capturedAt: '2026-08-28T12:00:00.000Z', id: 'baseline-v2', name: 'Plan v2' },
      milestones: [
        { baselineDate: '2026-10-01', forecastDate: '2026-10-05', id: 'milestone-beta', status: 'achieved', targetDate: '2026-10-05', title: 'Beta release', varianceWorkingDays: 2 },
        { baselineDate: '2026-10-28', forecastDate: '2026-11-02', id: 'milestone-payments', status: 'planned', targetDate: '2026-10-30', title: 'Payments integration', varianceWorkingDays: 3 },
        { baselineDate: '2026-11-18', forecastDate: '2026-11-20', id: 'milestone-uat', status: 'planned', targetDate: '2026-11-18', title: 'UAT sign-off', varianceWorkingDays: 2 },
        { baselineDate: '2026-12-04', forecastDate: '2026-12-03', id: 'milestone-golive', status: 'planned', targetDate: '2026-12-04', title: 'Go-live', varianceWorkingDays: -1 },
      ],
      today: TODAY,
    }),
    'saved-reports': ready({ reports: SAVED_REPORTS }),
    'sprint-burndown': ready({
      committed: 30,
      dates: sprintDates,
      health: { headline: 'Sprint 14 is behind: about 9 points may not finish', kind: 'behind', metrics: {} },
      ideal: sprintDates.map((date, index) => ({ date, value: Math.round(30 * (1 - index / 9) * 10) / 10 })),
      remaining: 18,
      scopeChanges: [{ date: '2026-10-07', delta: 3 }],
      series: remaining.map((value, index) => ({ date: sprintDates[index], remaining: value, scope: index >= 4 ? 33 : 30 })),
      sprint: { endDate: '2026-10-14', id: 'sprint-14', name: 'Sprint 14', startDate: '2026-10-01', status: 'active' },
      today: TODAY,
      unit: 'points',
    }),
    throughput: ready({
      contributorCount: 3,
      days: 90,
      rows: [
        { hoursLogged: 64, id: 'user-ada', name: 'Ada Lovelace', points: 58, tasksCompleted: 14 },
        { hoursLogged: 41.5, id: syntheticUser.id, name: syntheticUser.name, points: 37, tasksCompleted: 9 },
        { hoursLogged: 12, id: 'user-alan', name: 'Alan Turing', points: 12, tasksCompleted: 4 },
      ],
      source: 'contributor-metrics',
    }),
    'ticket-flow': ready({
      bucketDays: 7,
      buckets: ticketWeeks.map((start, index) => ({ end: addDays(start, 6), opened: opened[index], resolved: resolved[index], start })),
      overflowWeeks: 3,
      recentCount: 4,
    }),
    'tickets-by-severity': ready({
      bySeverity: [{ count: 1, severity: 'S1' }, { count: 4, severity: 'S2' }, { count: 9, severity: 'S3' }, { count: 4, severity: 'S4' }],
      knownAgeCount: 18,
      medianAgeDays: 5,
      open: 18,
      reopened: 2,
      total: 49,
    }),
    velocity: ready({
      sprints: ['9', '10', '11', '12', '13'].map((number, index) => ({ approximate: false, committed: [28, 30, 28, 32, 30][index], completed: [24, 27, 26, 23, 29][index], endDate: addDays('2026-08-14', index * 14), id: `sprint-${number}`, name: `Sprint ${number}`, startDate: addDays('2026-08-03', index * 14) })),
      summary: { average: 26, max: 29, min: 23, sprintCount: 3 },
      unit: 'points',
    }),
  };
}

/** Card payloads for the state board: thin history, empty, error, permission and no data. */
export function stateCards({ finance = false } = {}) {
  return {
    burnup: {
      availableOn: '2026-10-15',
      data: { criticalPathForecast: null, forecast: null, notEstimated: 0, remaining: 89, scopeAdded: 0, series: ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', TODAY].map((date, index) => ({ date, done: 3 + index * 2, scope: 100 })), since: '2026-10-01', target: '2026-12-04', today: TODAY, unit: 'points' },
      message: 'The forecast appears after 2 weeks of history.',
      notes: [],
      status: 'thin',
    },
    'sprint-burndown': { action: { label: 'Plan a sprint', target: 'sprints' }, data: null, message: 'No active sprint. The burndown appears once a sprint is started.', status: 'empty' },
    'ticket-flow': { data: null, message: 'This card could not be loaded. Other cards are unaffected.', status: 'error' },
    throughput: { action: null, data: null, message: 'No completed work in the last 90 days.', status: 'empty' },
    velocity: {
      availableOn: null,
      data: { sprints: [{ approximate: false, committed: 24, completed: 19, endDate: '2026-09-30', id: 'sprint-1', name: 'Sprint 1', startDate: '2026-09-17' }], summary: null, unit: 'points' },
      message: 'The average and a suggested commitment need 3 completed sprints.',
      notes: [],
      status: 'thin',
    },
    ...(finance ? {} : { 'earned-value': { data: null, message: 'Cost and earned value are visible to managers and admins.', status: 'forbidden' } }),
  };
}

export function insightsPayload({ cards = {}, editor = true, finance = true, layout = null } = {}) {
  return {
    asOf: `${TODAY}T13:40:00.000Z`,
    cards: { ...cardsPayload({ finance }), ...cards },
    filters: { days: 90, sprintId: null, unit: 'points' },
    health: healthPayload(),
    history: { coverageStart: '2026-07-13', firstRecordedAt: '2026-07-13T10:00:00.000Z', historyDays: 88, truncated: false },
    layout: layout ?? { cards: DEFAULT_CARDS, isDefault: true, updatedAt: null, updatedBy: null, version: 0 },
    ok: true,
    project: { endDate: '2026-12-04', id: PROJECT_ID, name: syntheticProject.name, startDate: '2026-07-10' },
    reports: SAVED_REPORTS,
    sprints: [
      { endDate: '2026-10-14', id: 'sprint-14', name: 'Sprint 14', startDate: '2026-10-01', status: 'active' },
      { endDate: '2026-09-30', id: 'sprint-13', name: 'Sprint 13', startDate: '2026-09-17', status: 'completed' },
    ],
    viewer: { canEditLayout: editor, canSeeFinance: finance, userId: syntheticUser.id },
  };
}

export const DEFECT_REPORT_ROWS = [
  { count: 1, severity: 'S1' },
  { count: 4, severity: 'S2' },
  { count: 9, severity: 'S3' },
  { count: 4, severity: 'S4' },
];

function reportCard(report, { cache = 'hit', refreshing = false, rows = DEFECT_REPORT_ROWS } = {}) {
  return {
    asOf: `${TODAY}T13:30:00.000Z`,
    cache,
    ok: true,
    refreshing,
    report: { columns: Object.keys(rows[0] ?? { value: 0 }), dataset: report.dataset, description: report.description, id: report.id, name: report.name, projectId: PROJECT_ID, status: 'active', visualization: report.visualization },
    rowCount: rows.length,
    rows,
    truncated: false,
  };
}

/**
 * `payload` builds the GET response from the current layout. `reportCards` maps a report id
 * to a list of responses served in order (the last repeats); a number is an error status.
 * `delayNextLoad(ms)` holds the next Insights load so a refresh can be observed.
 */
export async function installInsightsApi(page, { payload = (layout) => insightsPayload({ layout }), reportCards = {} } = {}) {
  let layout = null;
  let delayMs = 0;
  const calls = { insights: [], layoutWrites: [], reportCards: [] };
  const served = new Map();

  await page.route(`${API}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });

    if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/insights`) {
      calls.insights.push(Object.fromEntries(url.searchParams));
      if (delayMs) {
        const wait = delayMs;
        delayMs = 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      return json(payload(layout, Object.fromEntries(url.searchParams)));
    }
    if (path === `/api/projects/${PROJECT_ID}/insights/layout`) {
      const body = request.postDataJSON();
      calls.layoutWrites.push({ body, method });
      if (method === 'PUT') {
        layout = { cards: body.cards, isDefault: false, updatedAt: `${TODAY}T14:00:00.000Z`, updatedBy: syntheticUser.id, version: body.expectedVersion + 1 };
        return json({ layout, ok: true });
      }
      if (method === 'DELETE') {
        layout = null;
        return json({ layout: { cards: DEFAULT_CARDS, isDefault: true, updatedAt: null, updatedBy: null, version: 0 }, ok: true });
      }
    }
    const reportMatch = path.match(new RegExp(`^/api/projects/${PROJECT_ID}/insights/reports/([^/]+)$`));
    if (method === 'GET' && reportMatch) {
      const reportId = decodeURIComponent(reportMatch[1]);
      calls.reportCards.push(reportId);
      const responses = reportCards[reportId] ?? [{}];
      const index = served.get(reportId) ?? 0;
      served.set(reportId, index + 1);
      const next = responses[Math.min(index, responses.length - 1)];
      if (typeof next === 'number') return json({ error: 'Report not found.' }, next);
      const report = SAVED_REPORTS.find((entry) => entry.id === reportId) ?? SAVED_REPORTS[0];
      return json(reportCard(report, next));
    }
    return route.fallback();
  });

  return {
    calls,
    delayNextLoad(ms) {
      delayMs = ms;
    },
  };
}
