import assert from 'node:assert/strict';
import test from 'node:test';

import {
  burnupTotals,
  collectProjectItems,
  deriveThroughput,
  flowTotals,
  replayAt,
  sampleDates,
  ticketFlow,
  weekStart,
} from '../src/modules/insights/insights-history.js';
import { normalizeInsightsCards, effectiveInsightsLayout, canEditInsightsLayout } from '../src/modules/insights/insights-layout.js';
import { createMysqlInsightsRepository, ensureMysqlInsightsSchema } from '../src/modules/insights/insights.repository.js';

const project = {
  epics: [{
    id: 'epic-1',
    stories: [
      { id: 'story-1', points: 5, status: 'In Progress', tasks: [{ assigneeId: 'u-1', id: 'task-1', points: 3, status: 'Completed' }, { id: 'task-2', points: 2, status: 'Review' }] },
      { id: 'story-2', points: 8, status: 'Not Started', tasks: [] },
    ],
  }],
  tickets: [{ id: 'ticket-1', status: 'open' }],
};

function event(itemId, itemType, at, before, after, extra = {}) {
  return { actorUserId: 'u-actor', after, at, before, itemId, itemType, parentId: null, ...extra };
}

test('replay undoes newer revisions, including creates and deletes, and counts only leaf work', () => {
  const items = collectProjectItems(project);
  assert.equal(items.get('story-1').leaf, false);
  assert.equal(items.get('story-2').leaf, true);
  const events = [
    event('story-old', 'story', '2026-09-01T10:00:00.000Z', null, { points: 4, status: 'Not Started' }),
    event('story-2', 'story', '2026-09-02T10:00:00.000Z', null, { points: 8, status: 'Not Started' }),
    event('task-1', 'task', '2026-09-03T10:00:00.000Z', { assigneeId: 'u-1', points: 3, status: 'In Progress' }, { assigneeId: 'u-1', points: 3, status: 'Completed' }),
    event('story-old', 'story', '2026-09-04T10:00:00.000Z', { points: 4, status: 'Not Started' }, null),
  ];
  const totals = replayAt({
    dates: ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'],
    events,
    items,
    reduce: (states) => burnupTotals(states, 'points'),
  });
  assert.deepEqual(totals.map((entry) => [entry.scope, entry.done]), [
    [5, 0], // task-1 and task-2 exist; story-2 and the deleted story not yet
    [9, 0],
    [17, 0],
    [17, 3],
    [13, 3],
  ]);
  const flow = replayAt({ dates: ['2026-09-04'], events, items, reduce: (states) => flowTotals(states, 'items') })[0];
  assert.deepEqual(flow, { done: 1, inProgress: 0, notStarted: 1, review: 1 });
});

test('sample dates are evenly spaced and always end on the last day', () => {
  assert.deepEqual(sampleDates('2026-09-01', '2026-09-10', 4), ['2026-09-01', '2026-09-05', '2026-09-09', '2026-09-10']);
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
});

test('ticket flow counts creates as opened and moves into closed, rejected or deferred as resolved', () => {
  const events = [
    event('t-1', 'ticket', '2026-09-01T10:00:00.000Z', null, { status: 'new' }),
    event('t-1', 'ticket', '2026-09-08T10:00:00.000Z', { status: 'new' }, { status: 'closed' }),
    event('t-1', 'ticket', '2026-09-09T10:00:00.000Z', { status: 'closed' }, { status: 'deferred' }),
    event('t-2', 'ticket', '2026-09-09T10:00:00.000Z', null, { status: 'new' }),
    event('t-2', 'ticket', '2026-09-10T10:00:00.000Z', { status: 'new' }, { status: 'resolved' }),
    event('task-1', 'task', '2026-09-10T10:00:00.000Z', null, { status: 'new' }),
  ];
  assert.deepEqual(ticketFlow({ buckets: ['2026-08-31', '2026-09-07'], end: '2026-09-13', events }), [
    { opened: 1, resolved: 0, start: '2026-08-31' },
    { opened: 1, resolved: 1, start: '2026-09-07' },
  ]);
});

test('throughput from history credits the assignee, or whoever saved unassigned work, and reopening takes it back', () => {
  const items = collectProjectItems(project);
  const events = [
    event('task-1', 'task', '2026-09-03T10:00:00.000Z', { assigneeId: 'u-1', points: 3, status: 'In Progress' }, { assigneeId: 'u-1', points: 3, status: 'Completed' }),
    event('task-2', 'task', '2026-09-04T10:00:00.000Z', { points: 2, status: 'Review' }, { points: 2, status: 'Completed' }),
    event('task-2', 'task', '2026-09-05T10:00:00.000Z', { points: 2, status: 'Completed' }, { points: 2, status: 'Review' }),
    event('story-1', 'story', '2026-09-05T10:00:00.000Z', { points: 5, status: 'In Progress' }, { points: 5, status: 'Completed' }),
    event('ticket-1', 'ticket', '2026-09-06T10:00:00.000Z', { assigneeId: 'u-2', status: 'open' }, { assigneeId: 'u-2', status: 'closed' }),
    event('task-1', 'task', '2026-08-01T10:00:00.000Z', { status: 'Not Started' }, { status: 'Completed' }),
  ].sort((left, right) => left.at.localeCompare(right.at));
  assert.deepEqual(deriveThroughput({ events, items, since: '2026-09-01' }), [
    { hoursLogged: 0, id: 'u-1', points: 3, tasksCompleted: 1 },
    { hoursLogged: 0, id: 'u-2', points: 0, tasksCompleted: 1 },
  ]);
});

test('layouts keep known cards once, in order, and only admins and managers edit them', () => {
  assert.deepEqual(normalizeInsightsCards([{ type: 'velocity' }, { type: 'nope' }, { reportId: 'r-1', type: 'report' }, { type: 'report' }, { type: 'velocity' }, { reportId: 'r-1', type: 'report' }]), [{ type: 'velocity' }, { reportId: 'r-1', type: 'report' }]);
  assert.equal(effectiveInsightsLayout(null).isDefault, true);
  assert.equal(effectiveInsightsLayout({ cards: [{ type: 'burnup' }], version: 3 }).version, 3);
  const user = (role) => ({ id: 'u', memberships: [{ role, tenantId: 't' }] });
  assert.equal(canEditInsightsLayout({ projectRole: null, tenantId: 't', user: user('manager') }), true);
  assert.equal(canEditInsightsLayout({ projectRole: 'admin', tenantId: 't', user: user('user') }), true);
  assert.equal(canEditInsightsLayout({ projectRole: 'manager', tenantId: 't', user: user('user') }), true);
  assert.equal(canEditInsightsLayout({ projectRole: 'member', tenantId: 't', user: user('user') }), false);
  assert.equal(canEditInsightsLayout({ projectRole: 'editor', tenantId: 't', user: user('viewer') }), false);
});

function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function recordingExecutor(respond = () => [[]]) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      const call = { params, sql: normalize(sql) };
      calls.push(call);
      return respond(call);
    },
  };
}

test('0073 creates the layout table idempotently', async () => {
  const executor = recordingExecutor(() => [{}]);
  await ensureMysqlInsightsSchema(executor);
  assert.equal(executor.calls.length, 1);
  assert.match(executor.calls[0].sql, /^CREATE TABLE IF NOT EXISTS project_insights_layouts \(/);
  assert.match(executor.calls[0].sql, /PRIMARY KEY \(tenant_id, project_id\)/);
});

test('the MySQL repository versions layouts and reads compact revision history', async () => {
  const stored = { cards_json: '[{"type":"burnup"}]', created_at: new Date('2026-10-01T00:00:00Z'), project_id: 'p-1', tenant_id: 't-1', updated_at: new Date('2026-10-02T00:00:00Z'), updated_by: 'u-1', version: 2 };
  const executor = recordingExecutor(({ sql }) => {
    if (sql.startsWith('CREATE TABLE')) return [{}];
    if (sql.startsWith('UPDATE project_insights_layouts')) return [{ affectedRows: 0 }];
    if (sql.startsWith('SELECT * FROM project_insights_layouts')) return [[stored]];
    if (sql.startsWith('SELECT MIN(created_at)')) return [[{ first_recorded_at: new Date('2026-08-03T10:00:00Z') }]];
    if (sql.startsWith('SELECT id, item_id')) {
      return [[
        { actor_user_id: 'u-1', after_assignee_id: 'null', after_points: '3', after_sprint_id: 's-1', after_status: 'Completed', before_assignee_id: null, before_points: 'null', before_sprint_id: null, before_status: 'Review', created_at: new Date('2026-10-05T10:00:00Z'), has_after: 1, has_before: 1, id: 'r-2', item_id: 'task-1', item_type: 'task', parent_id: 'story-1' },
        { actor_user_id: '', after_assignee_id: null, after_points: null, after_sprint_id: null, after_status: 'new', before_assignee_id: null, before_points: null, before_sprint_id: null, before_status: null, created_at: new Date('2026-10-01T10:00:00Z'), has_after: 1, has_before: 0, id: 'r-1', item_id: 'ticket-1', item_type: 'ticket', parent_id: 'null' },
      ]];
    }
    return [[]];
  });
  const repository = createMysqlInsightsRepository({ pool: executor });

  await assert.rejects(
    () => repository.saveLayout({ cards: [{ type: 'velocity' }], expectedVersion: 1, projectId: 'p-1', tenantId: 't-1', userId: 'u-1' }),
    (error) => error.statusCode === 409 && error.details.actualVersion === 2,
  );
  const update = executor.calls.find((call) => call.sql.startsWith('UPDATE project_insights_layouts'));
  assert.deepEqual(update.params, ['[{"type":"velocity"}]', 'u-1', 't-1', 'p-1', 1]);
  assert.deepEqual((await repository.getLayout({ projectId: 'p-1', tenantId: 't-1' })).cards, [{ type: 'burnup' }]);

  const history = await repository.listItemHistory({ limit: 1, projectId: 'p-1', since: '2026-07-01', tenantId: 't-1' });
  const select = executor.calls.find((call) => call.sql.startsWith('SELECT id, item_id'));
  assert.match(select.sql, /ORDER BY created_at DESC, id DESC LIMIT 2$/);
  assert.match(select.sql, /JSON_UNQUOTE\(JSON_EXTRACT\(after_json, '\$\.node\.status'\)\) AS after_status/);
  assert.equal(history.truncated, true);
  assert.equal(history.firstRecordedAt, '2026-08-03T10:00:00.000Z');
  assert.deepEqual(history.events, [{
    actorUserId: 'u-1',
    after: { assigneeId: null, points: 3, sprintId: 's-1', status: 'Completed' },
    at: '2026-10-05T10:00:00.000Z',
    before: { assigneeId: null, points: null, sprintId: null, status: 'Review' },
    itemId: 'task-1',
    itemType: 'task',
    parentId: 'story-1',
  }]);
});

test('the MySQL repository leaves given items out of history and reads each ticket\'s last review state', async () => {
  const executor = recordingExecutor(({ sql }) => {
    if (sql.startsWith('SELECT MIN(created_at)')) return [[{ first_recorded_at: new Date('2026-08-04T10:00:00Z') }]];
    if (sql.startsWith('SELECT item_id, review_state')) return [[{ item_id: 'ticket-1', review_state: 'pending' }, { item_id: 'ticket-2', review_state: 'null' }, { item_id: 'ticket-3', review_state: null }]];
    return [[]];
  });
  const repository = createMysqlInsightsRepository({ pool: executor });

  const history = await repository.listItemHistory({ excludeItemIds: ['ticket-1', 'ticket-2', 'ticket-1'], projectId: 'p-1', since: '2026-07-01', tenantId: 't-1' });
  assert.equal(history.firstRecordedAt, '2026-08-04T10:00:00.000Z');
  const [first, select] = executor.calls;
  assert.match(first.sql, /WHERE tenant_id = \? AND project_id = \? AND item_id NOT IN \(\?, \?\)$/);
  assert.deepEqual(first.params, ['t-1', 'p-1', 'ticket-1', 'ticket-2']);
  assert.match(select.sql, /AND created_at >= \? AND item_id NOT IN \(\?, \?\) ORDER BY/);
  assert.deepEqual(select.params, ['t-1', 'p-1', new Date('2026-07-01'), 'ticket-1', 'ticket-2']);

  assert.deepEqual(await repository.listTicketReviewStates({ projectId: 'p-1', tenantId: 't-1' }), [
    { externalReviewState: 'pending', itemId: 'ticket-1' },
    { externalReviewState: null, itemId: 'ticket-2' },
    { externalReviewState: null, itemId: 'ticket-3' },
  ]);
  const states = executor.calls.at(-1);
  assert.match(states.sql, /ROW_NUMBER\(\) OVER \(PARTITION BY item_id ORDER BY created_at DESC, id DESC\) AS position/);
  assert.match(states.sql, /JSON_EXTRACT\(COALESCE\(after_json, before_json\), '\$\.node\.externalReviewState'\)/);
  assert.match(states.sql, /WHERE tenant_id = \? AND project_id = \? AND item_type = 'ticket' \) latest WHERE position = 1$/);
  assert.deepEqual(states.params, ['t-1', 'p-1']);
});
