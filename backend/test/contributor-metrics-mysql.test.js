import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillContributorMetrics,
  deriveContributorMetrics,
  parseBackfillFlags,
} from '../src/jobs/backfill-contributor-metrics.lib.js';
import {
  createMysqlMetricsRepository,
  ensureMysqlMetricsSchema,
  leaderboardWindowStart,
} from '../src/modules/metrics/metrics.repository.js';

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

function schemaExecutor(present) {
  return recordingExecutor(({ params, sql }) => {
    if (!sql.includes('information_schema')) return [{}];
    return [[{ count: present.has(params.at(-1)) ? 1 : 0 }]];
  });
}

function ddl(executor) {
  return executor.calls.filter((call) => !call.sql.includes('information_schema')).map((call) => call.sql);
}

test('0067 creates the legacy table where missing and adds a project to every day row', async () => {
  const fresh = schemaExecutor(new Set());
  await ensureMysqlMetricsSchema(fresh);
  const statements = ddl(fresh);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS contributor_metrics \(/);
  assert.match(statements[0], /UNIQUE KEY uniq_metric \(tenant_id, user_id, metric_date\)/);
  assert.match(statements[0], /hours_logged DECIMAL\(5,2\) DEFAULT '0.00'/);
  assert.deepEqual(statements.slice(1), [
    'ALTER TABLE contributor_metrics ADD COLUMN project_id CHAR(36) NULL AFTER user_id',
    'ALTER TABLE contributor_metrics ADD UNIQUE KEY uniq_metric_project (tenant_id, user_id, project_id, metric_date)',
    'CREATE INDEX idx_contributor_metrics_project ON contributor_metrics (tenant_id, project_id, metric_date)',
  ], 'the recording executor reports the just-created legacy key as absent');

  // Production has the legacy table from schema parity: the key moves to include the project.
  const legacy = schemaExecutor(new Set(['contributor_metrics', 'uniq_metric']));
  await ensureMysqlMetricsSchema(legacy);
  assert.deepEqual(ddl(legacy), [
    'ALTER TABLE contributor_metrics ADD COLUMN project_id CHAR(36) NULL AFTER user_id',
    'ALTER TABLE contributor_metrics ADD UNIQUE KEY uniq_metric_project (tenant_id, user_id, project_id, metric_date)',
    'ALTER TABLE contributor_metrics DROP INDEX uniq_metric',
    'CREATE INDEX idx_contributor_metrics_project ON contributor_metrics (tenant_id, project_id, metric_date)',
  ]);

  const migrated = schemaExecutor(new Set(['contributor_metrics', 'project_id', 'uniq_metric_project', 'idx_contributor_metrics_project']));
  await ensureMysqlMetricsSchema(migrated);
  assert.deepEqual(ddl(migrated), [], 'a second run changes nothing');
});

test('the MySQL repository upserts signed deltas and clamps hours to the legacy column', async () => {
  const executor = recordingExecutor(({ sql }) => (sql.includes('information_schema') ? [[{ count: 1 }]] : [{}]));
  const repository = createMysqlMetricsRepository({ pool: executor });

  await repository.record({ hoursLogged: 2400, metricDate: '2026-10-09', pointsCompleted: -3, projectId: 'project-1', tasksCompleted: -1, tenantId: 'tenant-1', userId: 'user-1' });
  await repository.record({ hoursLogged: 1, metricDate: '2026-10-09', projectId: 'project-1', tenantId: 'tenant-1', userId: 'user-1' });

  const writes = executor.calls.filter((call) => call.sql.startsWith('INSERT INTO contributor_metrics'));
  assert.deepEqual(executor.calls.map((call) => call.sql.split(' ')[0]), ['INSERT', 'INSERT'], 'writes check no schema');
  assert.deepEqual(writes[0].params, ['user-1', 'tenant-1', 'project-1', '2026-10-09', -1, -3, 999.99]);
  assert.deepEqual(writes[1].params, ['user-1', 'tenant-1', 'project-1', '2026-10-09', 0, 0, 1]);
  assert.match(writes[0].sql, /tasks_completed = tasks_completed \+ VALUES\(tasks_completed\)/);
  assert.match(writes[0].sql, /hours_logged = LEAST\(999.99, GREATEST\(-999.99, hours_logged \+ VALUES\(hours_logged\)\)\)/);
});

test('the MySQL leaderboard reads current tenant members inside the window', async () => {
  const executor = recordingExecutor(({ sql }) => {
    if (sql.includes('information_schema')) return [[{ count: 1 }]];
    return [[{ hoursLogged: '1.50', id: 'user-1', name: 'Ada', picture: null, points: '8', tasksCompleted: '2' }]];
  });
  const repository = createMysqlMetricsRepository({ pool: executor });
  const now = new Date('2026-10-09T12:00:00.000Z');

  const rows = await repository.listContributorTotals({ days: 7, excludedProjectIds: ['project-gone'], now, tenantId: 'tenant-1' });

  assert.deepEqual(rows, [{ hoursLogged: 1.5, id: 'user-1', name: 'Ada', picture: null, points: 8, tasksCompleted: 2 }]);
  const query = executor.calls.at(-1);
  assert.deepEqual(query.params, ['tenant-1', '2026-10-03', 'project-gone', 'tenant-1']);
  assert.match(query.sql, /AND \(cm.project_id IS NULL OR cm.project_id NOT IN \(\?\)\)/);
  assert.equal(leaderboardWindowStart(7, now), '2026-10-03');
  assert.match(query.sql, /EXISTS \( SELECT 1 FROM user_tenant ut WHERE ut.user_id = totals.user_id AND ut.tenant_id = \? \)/);
  assert.match(query.sql, /p.`key` = 'user_avatar'/);

  await repository.listContributorTotals({ days: 30, now, projectId: 'project-1', tenantId: 'tenant-1' });
  const perProject = executor.calls.at(-1);
  assert.deepEqual(perProject.params, ['tenant-1', '2026-09-10', 'project-1', 'tenant-1']);
  assert.match(perProject.sql, /AND cm.project_id = \?/);
});

const items = [
  { id: 'task-1', itemType: 'task', leaf: true, points: 3, projectId: 'project-1', tenantId: 'tenant-1' },
  { id: 'story-1', itemType: 'story', leaf: false, points: 8, projectId: 'project-1', tenantId: 'tenant-1' },
  { id: 'ticket-1', itemType: 'ticket', leaf: true, points: null, projectId: 'project-2', tenantId: 'tenant-1' },
];

function log(taskId, action, data, loggedAt) {
  return { action, data: JSON.stringify(data), loggedAt: new Date(loggedAt), taskId };
}

test('the backfill replays status history with the live rules and ignores the cutoff day onward', () => {
  const logs = [
    // Creation earns nothing, even when the item starts out done.
    log('ticket-1', 'assign', { assigned_to: 'user-ada' }, '2026-09-01T10:00:00Z'),
    log('ticket-1', 'status_change', { status: 'closed' }, '2026-09-01T10:00:00Z'),
    log('task-1', 'assign', { assigned_to: 'user-ada' }, '2026-09-01T10:00:00Z'),
    log('task-1', 'status_change', { status: 'Not Started' }, '2026-09-01T10:00:00Z'),
    // Repeated tree saves log the same status again.
    log('task-1', 'status_change', { status: 'Not Started' }, '2026-09-02T10:00:00Z'),
    log('task-1', 'status_change', { status: 'Completed' }, '2026-09-03T10:00:00Z'),
    log('task-1', 'status_change', { status: 'Completed' }, '2026-09-03T11:00:00Z'),
    // Reassigning done work moves the credit.
    log('task-1', 'assign', { assigned_to: 'user-alan' }, '2026-09-04T10:00:00Z'),
    log('task-1', 'status_change', { status: 'In Progress' }, '2026-09-05T10:00:00Z'),
    log('story-1', 'assign', { assigned_to: 'user-ada' }, '2026-09-01T10:00:00Z'),
    log('story-1', 'status_change', { status: 'In Progress' }, '2026-09-01T10:00:00Z'),
    log('story-1', 'status_change', { status: 'Completed' }, '2026-09-03T10:00:00Z'),
    log('ticket-1', 'status_change', { status: 'open' }, '2026-09-06T10:00:00Z'),
    log('ticket-1', 'status_change', { status: 'closed' }, '2026-09-07T10:00:00Z'),
    log('task-1', 'status_change', { status: 'Completed' }, '2026-09-10T10:00:00Z'),
  ];

  assert.deepEqual(deriveContributorMetrics({ before: '2026-09-10', items, logs }), [
    { metricDate: '2026-09-03', pointsCompleted: 3, projectId: 'project-1', tasksCompleted: 1, tenantId: 'tenant-1', userId: 'user-ada' },
    { metricDate: '2026-09-04', pointsCompleted: -3, projectId: 'project-1', tasksCompleted: -1, tenantId: 'tenant-1', userId: 'user-ada' },
    { metricDate: '2026-09-06', pointsCompleted: 0, projectId: 'project-2', tasksCompleted: -1, tenantId: 'tenant-1', userId: 'user-ada' },
    { metricDate: '2026-09-07', pointsCompleted: 0, projectId: 'project-2', tasksCompleted: 1, tenantId: 'tenant-1', userId: 'user-ada' },
    { metricDate: '2026-09-04', pointsCompleted: 3, projectId: 'project-1', tasksCompleted: 1, tenantId: 'tenant-1', userId: 'user-alan' },
    { metricDate: '2026-09-05', pointsCompleted: -3, projectId: 'project-1', tasksCompleted: -1, tenantId: 'tenant-1', userId: 'user-alan' },
  ]);
});

test('unassigned completions earn nothing in the backfill', () => {
  const logs = [
    log('task-1', 'assign', { assigned_to: null }, '2026-09-01T10:00:00Z'),
    log('task-1', 'status_change', { status: 'Not Started' }, '2026-09-01T10:00:00Z'),
    log('task-1', 'status_change', { status: 'Completed' }, '2026-09-02T10:00:00Z'),
  ];
  assert.deepEqual(deriveContributorMetrics({ before: '2026-10-01', items, logs }), []);
});

test('the backfill overwrites derived days, skips deleted users, and writes nothing on a dry run', async () => {
  const respond = ({ sql }) => {
    if (sql.startsWith('SELECT applied_at')) return [[{ appliedAt: new Date('2026-09-20T08:00:00Z') }]];
    if (sql.includes('FROM tasks t INNER JOIN projects p')) return [[{ id: 'task-1', itemType: 'task', leaf: 1, points: 3, projectId: 'project-1', tenantId: 'tenant-1' }]];
    if (sql.includes('FROM task_log l')) {
      return [[
        log('task-1', 'assign', { assigned_to: 'user-ada' }, '2026-09-01T10:00:00Z'),
        log('task-1', 'status_change', { status: 'Not Started' }, '2026-09-01T10:00:00Z'),
        log('task-1', 'status_change', { status: 'Completed' }, '2026-09-02T10:00:00Z'),
        log('task-1', 'assign', { assigned_to: 'user-gone' }, '2026-09-03T10:00:00Z'),
      ]];
    }
    if (sql.startsWith('SELECT id FROM users')) return [[{ id: 'user-ada' }]];
    return [{}];
  };

  const dry = recordingExecutor(respond);
  const preview = await backfillContributorMetrics({ dryRun: true, executor: dry, tenantId: 'tenant-1' });
  assert.equal(preview.before, '2026-09-20');
  assert.deepEqual(preview.tenants, [{ pointsCompleted: 0, rows: 2, skippedRowsForMissingUsers: 1, tasksCompleted: 0, tenantId: 'tenant-1', users: 1 }]);
  assert.equal(dry.calls.some((call) => call.sql.startsWith('INSERT')), false);

  const applied = recordingExecutor(respond);
  await backfillContributorMetrics({ dryRun: false, executor: applied, tenantId: 'tenant-1' });
  const writes = applied.calls.filter((call) => call.sql.startsWith('INSERT INTO contributor_metrics'));
  assert.deepEqual(writes.map((call) => call.params), [
    ['user-ada', 'tenant-1', 'project-1', '2026-09-02', 1, 3],
    ['user-ada', 'tenant-1', 'project-1', '2026-09-03', -1, -3],
  ]);
  assert.match(writes[0].sql, /ON DUPLICATE KEY UPDATE tasks_completed = VALUES\(tasks_completed\), points_completed = VALUES\(points_completed\)/);
});

test('the backfill refuses to guess a cutoff or overlap live recording, and requires an explicit tenant choice', async () => {
  const executor = recordingExecutor(() => [[]]);
  await assert.rejects(backfillContributorMetrics({ executor, tenantId: 'tenant-1' }), /0067_contributor_metrics has not been applied/);
  await assert.rejects(backfillContributorMetrics({ before: '20260901', executor, tenantId: 'tenant-1' }), /YYYY-MM-DD/);
  const applied = recordingExecutor(() => [[{ appliedAt: new Date('2026-09-20T08:00:00Z') }]]);
  await assert.rejects(backfillContributorMetrics({ before: '2026-09-21', executor: applied, tenantId: 'tenant-1' }), /cannot be later than 2026-09-20/);

  assert.throws(() => parseBackfillFlags([]), /exactly one of --tenant=<id> or --all-tenants/);
  assert.throws(() => parseBackfillFlags(['--tenant=t-1', '--all-tenants']), /exactly one/);
  assert.deepEqual(parseBackfillFlags(['--tenant=t-1', '--dry-run', '--before=2026-09-01']), { allTenants: false, before: '2026-09-01', dryRun: true, tenantId: 't-1' });
});
