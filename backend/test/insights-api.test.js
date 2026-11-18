import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { createInMemoryMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { DEFAULT_INSIGHTS_CARDS } from '../src/modules/insights/insights-layout.js';
import { REPORT_CARD_FRESH_MS } from '../src/modules/insights/insights-reports.js';

const TENANT = 'tenant-acme';
const PROJECT = 'project-atlas';

function member(id, name, role) {
  return {
    authMethod: 'basic',
    email: `${id.replace('user-', '')}@acme.com`,
    id,
    memberships: [{ role, tenantId: TENANT }],
    name,
    passwordHash: 'unused',
    preferences: { twoFactorEnabled: false },
  };
}

// Tuesday 2026-10-13. Sprint 14 runs Monday 2026-10-05 to Friday 2026-10-16.
function seedProject() {
  return {
    createdAt: '2026-07-01T09:00:00.000Z',
    description: 'Customer portal.',
    endDate: '2026-12-04',
    epics: [{
      id: 'epic-portal',
      name: 'Portal',
      status: 'In Progress',
      stories: [
        {
          assigneeId: 'user-ada',
          id: 'story-pay',
          name: 'Payments',
          sprintId: 'sprint-14',
          status: 'In Progress',
          tasks: [
            { assigneeId: 'user-ada', id: 'task-card', name: 'Card form', points: 5, sprintId: 'sprint-14', status: 'Completed', targetEndDate: '2026-10-08' },
            { assigneeId: 'user-ada', id: 'task-refund', name: 'Refunds', points: 3, sprintId: 'sprint-14', status: 'In Progress', targetEndDate: '2026-10-09' },
          ],
        },
        { assigneeId: 'user-alan', id: 'story-search', name: 'Search', points: 8, sprintId: 'sprint-14', status: 'Not Started', targetEndDate: '2026-10-16' },
        { assigneeId: 'user-alan', id: 'story-docs', name: 'Docs', points: 2, sprintId: 'sprint-13', status: 'Completed' },
      ],
    }],
    id: PROJECT,
    name: 'Atlas Customer Portal',
    rank: 1,
    startDate: '2026-07-01',
    status: 'In Progress',
    tenantId: TENANT,
    tickets: [
      { id: 'ticket-crash', name: 'Checkout crash', severity: 'S1', status: 'open' },
      { id: 'ticket-typo', name: 'Typo', severity: 'S3', status: 'closed' },
      { id: 'ticket-slow', name: 'Slow search', reopenCount: 1, severity: 'S2', status: 'triage' },
    ],
    updatedAt: '2026-10-01T08:30:00.000Z',
  };
}

function revision(itemId, itemType, createdAt, before, after, actorUserId = 'user-grace') {
  const snapshot = (node) => (node ? { itemType, node: { id: itemId, ...node }, parentId: null, position: 0 } : null);
  return { action: before ? (after ? 'update' : 'delete') : 'create', actorUserId, after: snapshot(after), before: snapshot(before), createdAt, id: `rev-${itemId}-${createdAt}`, itemId, itemType, projectId: PROJECT, tenantId: TENANT, versionAfter: 2, versionBefore: 1 };
}

async function signIn({ sessionsRepository, tokenService }, user) {
  const role = user.memberships[0].role;
  const token = tokenService.signSessionToken({ email: user.email, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role, scopes: [`T${TENANT}-${role}`], tenantId: TENANT });
  const expiry = tokenService.verifySessionToken(token);
  await sessionsRepository.createSession({ expiryDate: new Date(expiry.exp * 1000), ipAddr: '127.0.0.1', locationName: 'Localhost', token, userAgent: 'test-agent', userId: user.id });
  return token;
}

async function createInsightsTestApp({ now = new Date('2026-10-13T15:00:00.000Z') } = {}) {
  const users = [
    member('user-grace', 'Grace Hopper', 'manager'),
    member('user-ada', 'Ada Lovelace', 'user'),
    member('user-alan', 'Alan Turing', 'user'),
    member('user-hedy', 'Hedy Lamarr', 'user'),
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }], users });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: { [PROJECT]: [{ id: 'user-ada', role: 'member' }, { id: 'user-alan', role: 'admin' }] },
      projects: [seedProject()],
      sprints: [
        { endDate: '2026-10-02', id: 'sprint-13', name: 'Sprint 13', projectId: PROJECT, sortOrder: 0, startDate: '2026-09-21', status: 'completed' },
        { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', projectId: PROJECT, sortOrder: 1, startDate: '2026-10-05', status: 'active' },
      ],
    },
  });
  projectRepository.state.projectItemRevisions.push(
    revision('story-docs', 'story', '2026-08-03T10:00:00.000Z', null, { points: 2, sprintId: 'sprint-13', status: 'Not Started' }),
    revision('ticket-typo', 'ticket', '2026-09-10T10:00:00.000Z', null, { status: 'new' }),
    revision('ticket-typo', 'ticket', '2026-09-18T10:00:00.000Z', { status: 'new' }, { status: 'closed' }),
    revision('story-docs', 'story', '2026-09-30T10:00:00.000Z', { assigneeId: 'user-alan', points: 2, sprintId: 'sprint-13', status: 'In Progress' }, { assigneeId: 'user-alan', points: 2, sprintId: 'sprint-13', status: 'Completed' }),
    revision('ticket-crash', 'ticket', '2026-10-01T10:00:00.000Z', null, { status: 'new' }),
    revision('task-card', 'task', '2026-10-07T10:00:00.000Z', { assigneeId: 'user-ada', points: 5, sprintId: 'sprint-14', status: 'In Progress' }, { assigneeId: 'user-ada', points: 5, sprintId: 'sprint-14', status: 'Completed' }),
  );
  const governanceRepository = createInMemoryGovernanceRepository();
  await governanceRepository.createMilestone({ input: { status: 'planned', targetDate: '2026-10-20', title: 'Beta release', workItemId: 'story-search' }, projectId: PROJECT, tenantId: TENANT });
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  await resourceFinanceRepository.createFinancialEntry({ input: { amount: 100000, category: 'Delivery', currency: 'USD', effectiveDate: '2026-07-01', entryKind: 'budget', note: '', projectId: PROJECT, sourceId: null, sourceType: 'manual', status: 'approved' }, tenantId: TENANT });
  await resourceFinanceRepository.createFinancialEntry({ input: { amount: 30000, category: 'Delivery', currency: 'USD', effectiveDate: '2026-09-01', entryKind: 'actual_cost', note: '', projectId: PROJECT, sourceId: null, sourceType: 'manual', status: 'approved' }, tenantId: TENANT });
  const metricsRepository = createInMemoryMetricsRepository([
    { hoursLogged: 6, metricDate: '2026-10-07', pointsCompleted: 5, projectId: PROJECT, tasksCompleted: 1, tenantId: TENANT, userId: 'user-ada' },
    { hoursLogged: 2, metricDate: '2026-09-30', pointsCompleted: 2, projectId: PROJECT, tasksCompleted: 1, tenantId: TENANT, userId: 'user-alan' },
  ]);
  const reportingRepository = createInMemoryReportingRepository();
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const clock = { now };
  const app = createApp({
    assistantRepository: createInMemoryAssistantRepository(),
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    governanceRepository,
    insightsClock: () => clock.now,
    metricsRepository,
    projectRepository,
    reportingRepository,
    resourceFinanceRepository,
    sessionsRepository,
    tokenService,
  });
  const context = { sessionsRepository, tokenService };
  const tokens = {};
  for (const user of users) tokens[user.id] = await signIn(context, user);
  return { app, clock, projectRepository, reportingRepository, tokens };
}

function getInsights(app, token, query = '') {
  return request(app).get(`/api/projects/${PROJECT}/insights${query}`).set('Authorization', `Bearer ${token}`);
}

test('Insights returns every default card with its data source applied', async () => {
  const { app, tokens } = await createInsightsTestApp();
  const response = await getInsights(app, tokens['user-grace']);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;

  assert.equal(body.layout.isDefault, true);
  assert.deepEqual(body.layout.cards, DEFAULT_INSIGHTS_CARDS.map((card) => ({ ...card })));
  assert.deepEqual(Object.keys(body.cards).sort(), DEFAULT_INSIGHTS_CARDS.map((card) => card.type).sort());
  assert.deepEqual(body.viewer, { canEditLayout: true, canSeeFinance: true, userId: 'user-grace' });
  assert.equal(body.layout.cards[0].type, 'gantt');
  assert.equal(body.cards.gantt.status, 'ready');
  assert.deepEqual(body.cards.gantt.data.sprints.map((sprint) => sprint.id), ['sprint-13', 'sprint-14']);
  assert.equal(body.cards.gantt.data.activeSprintId, 'sprint-14');
  assert.deepEqual(body.cards.gantt.data.resources.map((resource) => resource.name), ['Ada Lovelace', 'Alan Turing']);
  assert.deepEqual(body.filters, { days: 90, sprintId: null, unit: 'points' });
  assert.equal(body.history.coverageStart, '2026-08-03');

  const burnup = body.cards.burnup;
  assert.equal(burnup.status, 'ready');
  assert.deepEqual(burnup.data.series.at(-1), { date: '2026-10-13', done: 7, scope: 18 });
  // Before the card task was completed on Oct 7, only the docs story was done.
  assert.equal(burnup.data.series.find((point) => point.date < '2026-10-07' && point.date >= '2026-10-01').done, 2);
  assert.equal(burnup.data.target, '2026-12-04');
  assert.equal(burnup.data.forecast.method, 'weighted-weekly-velocity');
  assert.ok(burnup.data.forecast.date > '2026-10-13');

  const burndown = body.cards['sprint-burndown'];
  assert.equal(burndown.status, 'ready');
  assert.equal(burndown.data.sprint.id, 'sprint-14');
  assert.equal(burndown.data.committed, 16);
  assert.deepEqual(burndown.data.series.map((point) => [point.date, point.remaining]), [
    ['2026-10-05', 16], ['2026-10-06', 16], ['2026-10-07', 11], ['2026-10-08', 11], ['2026-10-09', 11], ['2026-10-12', 11], ['2026-10-13', 11],
  ]);
  assert.equal(burndown.data.dates.length, 10);
  assert.equal(burndown.data.health.kind, 'behind');

  const velocity = body.cards.velocity;
  assert.equal(velocity.status, 'thin');
  assert.deepEqual(velocity.data.sprints.map(({ committed, completed, id }) => ({ committed, completed, id })), [{ committed: 2, completed: 2, id: 'sprint-13' }]);
  assert.match(velocity.message, /3 completed sprints/);

  assert.equal(body.cards['cumulative-flow'].status, 'ready');
  assert.deepEqual(body.cards['cumulative-flow'].data.series.at(-1), { date: '2026-10-13', done: 7, inProgress: 3, notStarted: 8, review: 0 });

  const flow = body.cards['ticket-flow'];
  assert.equal(flow.status, 'ready');
  assert.equal(flow.data.buckets.reduce((sum, row) => sum + row.opened, 0), 2);
  assert.equal(flow.data.buckets.reduce((sum, row) => sum + row.resolved, 0), 1);

  const severity = body.cards['tickets-by-severity'];
  assert.equal(severity.status, 'ready');
  assert.equal(severity.data.open, 2);
  assert.deepEqual(severity.data.bySeverity.map((row) => row.count), [1, 1, 0, 0]);
  assert.equal(severity.data.reopened, 1);
  assert.equal(severity.data.medianAgeDays, 12);

  const milestones = body.cards.milestones;
  assert.equal(milestones.status, 'ready');
  assert.equal(milestones.data.milestones[0].title, 'Beta release');
  assert.match(milestones.notes[0], /No baseline yet/);

  const earned = body.cards['earned-value'];
  assert.equal(earned.status, 'ready');
  assert.equal(earned.data.currency, 'USD');
  assert.equal(earned.data.budget, 100000);
  assert.equal(earned.data.series.at(-1).ac, 30000);
  assert.equal(typeof earned.data.kpis.cpi, 'number');

  const throughput = body.cards.throughput;
  assert.equal(throughput.status, 'ready');
  assert.equal(throughput.data.source, 'contributor-metrics');
  assert.deepEqual(throughput.data.rows.map((row) => [row.name, row.points, row.tasksCompleted]), [['Ada Lovelace', 5, 1], ['Alan Turing', 2, 1]]);

  assert.deepEqual(body.cards['saved-reports'], { data: { reports: [] }, notes: [], status: 'ready' });

  const headline = body.cards.headline.data;
  assert.deepEqual(headline.tickets, { open: 2, s1: 1, s2: 1 });
  assert.equal(headline.scope.percent, 39);
  assert.equal(headline.sprint.name, 'Sprint 14');
  assert.equal(headline.cost.currency, 'USD');
  assert.deepEqual(headline.velocity, { average: 2, max: 2, min: 2, sprintCount: 1 });

  // The Beta milestone forecasts from the search story, which is not late, so the project
  // holds; Sprint 14 is behind, so the page is at risk.
  assert.equal(body.health.kind, 'behind');
  assert.match(body.health.headline, /^At risk: Sprint 14 is behind/);
  assert.ok(body.health.signals.some((signal) => signal.scope === 'sprint' && signal.evidence[0].link.type === 'sprint'));
});

test('members see no cost, cannot change the layout, and keep per-person throughput', async () => {
  const { app, tokens } = await createInsightsTestApp();
  const response = await getInsights(app, tokens['user-ada'], '?unit=items&days=30');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.viewer, { canEditLayout: false, canSeeFinance: false, userId: 'user-ada' });
  assert.deepEqual(response.body.cards['earned-value'], { data: null, message: 'Cost and earned value are visible to managers and admins.', status: 'forbidden' });
  assert.equal(response.body.cards.headline.data.cost, null);
  assert.equal(response.body.cards.throughput.status, 'ready');
  assert.equal(response.body.cards.burnup.data.unit, 'items');
  assert.deepEqual(response.body.cards.burnup.data.series.at(-1), { date: '2026-10-13', done: 2, scope: 4 });
  // Ada owns the overdue refunds task, so her own signal is a watch.
  const personal = response.body.health.signals.find((signal) => signal.scope === 'person');
  assert.equal(personal.kind, 'watch');
  assert.deepEqual(personal.evidence[0].link, { id: 'task-refund', projectId: PROJECT, type: 'item' });

  const outsider = await getInsights(app, tokens['user-hedy']);
  assert.equal(outsider.status, 404);
  assert.equal((await request(app).get('/api/projects/missing/insights').set('Authorization', `Bearer ${tokens['user-grace']}`)).status, 404);
  assert.equal((await getInsights(app, tokens['user-grace'], '?days=45')).status, 400);
});

test('thin history, no sprint and no tickets resolve to their own card states', async () => {
  const { app, projectRepository, tokens } = await createInsightsTestApp();
  projectRepository.state.projectItemRevisions.length = 0;
  projectRepository.state.projects[0].tickets = [];
  const response = await getInsights(app, tokens['user-grace'], '?sprintId=sprint-gone');
  const { cards } = response.body;
  assert.equal(response.body.history.historyDays, 0);
  assert.equal(cards.burnup.status, 'thin');
  assert.equal(cards.burnup.availableOn, '2026-10-27');
  assert.equal(cards.burnup.data.forecast, null);
  assert.equal(cards['cumulative-flow'].status, 'thin');
  assert.equal(cards['ticket-flow'].status, 'empty');
  assert.equal(cards['tickets-by-severity'].status, 'empty');
  // An unknown sprint filter falls back to the active sprint.
  assert.equal(cards['sprint-burndown'].data.sprint.id, 'sprint-14');
});

test('project admins and managers save, reorder and reset the layout; others may not', async () => {
  const { app, reportingRepository, tokens } = await createInsightsTestApp();
  const report = await reportingRepository.createReport({ input: { columns: ['itemId', 'name', 'status'], dataset: 'work_items', description: '', filters: {}, groupBy: [], name: 'Open work', projectId: PROJECT, status: 'active', visibility: 'project', visualization: 'table' }, ownerUserId: 'user-grace', tenantId: TENANT });
  const layoutUrl = `/api/projects/${PROJECT}/insights/layout`;
  const cards = [{ type: 'velocity' }, { reportId: report.id, type: 'report' }, { type: 'burnup' }, { type: 'velocity' }];

  const denied = await request(app).put(layoutUrl).set('Authorization', `Bearer ${tokens['user-ada']}`).send({ cards, expectedVersion: 0 });
  assert.equal(denied.status, 403);

  // Alan is a project admin with a plain tenant role.
  const saved = await request(app).put(layoutUrl).set('Authorization', `Bearer ${tokens['user-alan']}`).send({ cards, expectedVersion: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.layout.cards, [{ type: 'velocity' }, { reportId: report.id, type: 'report' }, { type: 'burnup' }]);
  assert.equal(saved.body.layout.version, 1);
  assert.equal(saved.body.layout.isDefault, false);

  const stale = await request(app).put(layoutUrl).set('Authorization', `Bearer ${tokens['user-grace']}`).send({ cards: [{ type: 'burnup' }], expectedVersion: 0 });
  assert.equal(stale.status, 409);

  const unknownReport = await request(app).put(layoutUrl).set('Authorization', `Bearer ${tokens['user-grace']}`).send({ cards: [{ reportId: 'nope', type: 'report' }], expectedVersion: 1 });
  assert.equal(unknownReport.status, 400);
  const badType = await request(app).put(layoutUrl).set('Authorization', `Bearer ${tokens['user-grace']}`).send({ cards: [{ type: 'pie-of-the-day' }], expectedVersion: 1 });
  assert.equal(badType.status, 400);

  const reordered = await request(app).put(layoutUrl).set('Authorization', `Bearer ${tokens['user-grace']}`).send({ cards: [{ type: 'burnup' }, { type: 'velocity' }], expectedVersion: 1 });
  assert.equal(reordered.status, 200);
  const view = await getInsights(app, tokens['user-ada']);
  assert.deepEqual(view.body.layout.cards, [{ type: 'burnup' }, { type: 'velocity' }]);
  assert.equal(view.body.layout.version, 2);

  const reset = await request(app).delete(layoutUrl).set('Authorization', `Bearer ${tokens['user-grace']}`).send({ expectedVersion: 2 });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.layout.isDefault, true);
  assert.equal((await getInsights(app, tokens['user-ada'])).body.layout.isDefault, true);
});

test('saved-report cards run on their own, serve a cache, and refresh stale results in the background', async () => {
  // Snapshots carry real timestamps, so this test's clock starts at the real time.
  const { app, clock, reportingRepository, tokens } = await createInsightsTestApp({ now: new Date() });
  const report = await reportingRepository.createReport({ input: { columns: ['itemId', 'name', 'status'], dataset: 'work_items', description: 'Everything in flight.', filters: {}, groupBy: [], name: 'Open work', projectId: PROJECT, status: 'active', visibility: 'project', visualization: 'table' }, ownerUserId: 'user-grace', tenantId: TENANT });
  const hidden = await reportingRepository.createReport({ input: { columns: ['projectId'], dataset: 'project', description: '', filters: {}, groupBy: [], name: 'Private', projectId: PROJECT, status: 'active', visibility: 'private', visualization: 'table' }, ownerUserId: 'user-grace', tenantId: TENANT });
  const cardUrl = (id) => `/api/projects/${PROJECT}/insights/reports/${id}`;

  const first = await request(app).get(cardUrl(report.id)).set('Authorization', `Bearer ${tokens['user-ada']}`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.cache, 'miss');
  assert.equal(first.body.refreshing, false);
  assert.equal(first.body.report.name, 'Open work');
  assert.equal(first.body.rowCount, 6);
  assert.deepEqual(Object.keys(first.body.rows[0]), ['itemId', 'name', 'status']);

  const second = await request(app).get(cardUrl(report.id)).set('Authorization', `Bearer ${tokens['user-ada']}`);
  assert.equal(second.body.cache, 'hit');
  let runs = (await reportingRepository.listSnapshot({ tenantId: TENANT })).runs;
  assert.equal(runs.length, 1, 'a fresh cached result does not run the report again');

  // Another person gets their own run rather than Ada's snapshot.
  const other = await request(app).get(cardUrl(report.id)).set('Authorization', `Bearer ${tokens['user-grace']}`);
  assert.equal(other.body.cache, 'miss');

  clock.now = new Date(clock.now.getTime() + REPORT_CARD_FRESH_MS + 1000);
  const stale = await request(app).get(cardUrl(report.id)).set('Authorization', `Bearer ${tokens['user-ada']}`);
  assert.equal(stale.body.cache, 'stale');
  assert.equal(stale.body.refreshing, true);
  assert.equal(stale.body.rowCount, 6, 'the stale result shows while the refresh runs');
  await new Promise((resolve) => setTimeout(resolve, 50));
  runs = (await reportingRepository.listSnapshot({ tenantId: TENANT })).runs.filter((run) => run.requestedBy === 'user-ada');
  assert.equal(runs.length, 2);
  clock.now = new Date();
  const refreshed = await request(app).get(cardUrl(report.id)).set('Authorization', `Bearer ${tokens['user-ada']}`);
  assert.equal(refreshed.body.cache, 'hit');

  assert.equal((await request(app).get(cardUrl(hidden.id)).set('Authorization', `Bearer ${tokens['user-ada']}`)).status, 404);
  assert.equal((await request(app).get(cardUrl(report.id)).set('Authorization', `Bearer ${tokens['user-hedy']}`)).status, 404);

  const listing = await getInsights(app, tokens['user-ada']);
  assert.deepEqual(listing.body.reports.map((entry) => entry.name), ['Open work']);
  assert.ok(listing.body.reports[0].lastRunAt);
});

test('a revision recorded through the item API shows up on today', async () => {
  const { app, tokens } = await createInsightsTestApp({ now: new Date() });
  const project = (await request(app).get(`/api/projects/${PROJECT}`).set('Authorization', `Bearer ${tokens['user-grace']}`)).body.project;
  const task = project.epics[0].stories[0].tasks.find((entry) => entry.id === 'task-refund');
  const patched = await request(app).patch(`/api/projects/${PROJECT}/items/task-refund`).set('Authorization', `Bearer ${tokens['user-grace']}`).send({ expectedVersion: task.version, patch: { status: 'Completed' } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const response = await getInsights(app, tokens['user-grace'], '?days=30');
  const series = response.body.cards.burnup.data.series;
  assert.equal(series.at(-1).done, 10);
  assert.ok(series.at(-2).done <= 7, 'before today the refunds task was still open');
});
