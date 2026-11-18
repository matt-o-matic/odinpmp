import { isWorkItemDone } from '../modules/metrics/work-completion-metrics.js';

// Rebuilds contributor metrics for the days before live recording started, from the
// task_log history: 'status_change' rows carry each status and 'assign' rows each assignee.
//
// It follows the live rules in work-completion-metrics.js as far as the history allows:
// - an item's first status is its creation and earns nothing;
// - a leaf moving into done credits its assignee one item and its points, and moving out
//   takes them back; reassigning done work moves the credit;
// - leaf status, item type, and points are today's values, since the log keeps no history
//   of them;
// - unassigned work earns nothing, because the log does not record who made the change;
// - hours are left alone, because actual hours have no history.
//
// Rows are per tenant, user, project, and day. Only days before the cutoff are written, and
// each derived row overwrites its stored row rather than adding to it, so re-running gives the
// same result. The cutoff is the day migration 0067 was applied, or an earlier --before day;
// live recording owns that day and every day after it.

export const METRICS_MIGRATION_ID = '0067_contributor_metrics';

const USAGE = 'Usage: npm --prefix backend run job:backfill-contributor-metrics -- (--tenant=<id> | --all-tenants) [--before=YYYY-MM-DD] [--dry-run]';

export function parseBackfillFlags(argv = []) {
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3).trim() || null;
  const options = {
    allTenants: argv.includes('--all-tenants'),
    before: value('before'),
    dryRun: argv.includes('--dry-run'),
    tenantId: value('tenant'),
  };
  if (options.allTenants === Boolean(options.tenantId)) throw new Error(`Choose exactly one of --tenant=<id> or --all-tenants.\n${USAGE}`);
  return options;
}

function dateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function parseLogData(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value ?? '{}')) ?? {};
  } catch {
    return {};
  }
}

function wholePoints(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * Per tenant, user, project, and day totals from ordered task_log rows.
 * `items`: `{ id, tenantId, projectId, itemType, points, leaf }`; `logs`: `{ taskId, action, data, loggedAt }`
 * sorted by time. Rows on or after `before` (YYYY-MM-DD) are ignored.
 */
export function deriveContributorMetrics({ before, items, logs }) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const states = new Map();
  const totals = new Map();

  const credit = (item, userId, metricDate, sign) => {
    if (!userId || !item.leaf) return;
    const key = `${item.tenantId}|${userId}|${item.projectId}|${metricDate}`;
    const current = totals.get(key) ?? { metricDate, pointsCompleted: 0, projectId: item.projectId, tasksCompleted: 0, tenantId: item.tenantId, userId };
    current.tasksCompleted += sign;
    current.pointsCompleted += sign * wholePoints(item.points);
    totals.set(key, current);
  };

  for (const log of logs) {
    const item = itemsById.get(log.taskId);
    const metricDate = dateOnly(log.loggedAt);
    if (!item || !metricDate || metricDate >= before) continue;

    const state = states.get(log.taskId) ?? { assigneeId: null, done: false, started: false };
    states.set(log.taskId, state);
    const data = parseLogData(log.data);

    if (log.action === 'assign') {
      const assigneeId = String(data.assigned_to ?? '').trim() || null;
      if (state.started && state.done && assigneeId !== state.assigneeId) {
        credit(item, state.assigneeId, metricDate, -1);
        credit(item, assigneeId, metricDate, 1);
      }
      state.assigneeId = assigneeId;
      continue;
    }

    if (log.action !== 'status_change') continue;
    const done = isWorkItemDone(item.itemType, data.status);
    if (state.started && done !== state.done) credit(item, state.assigneeId, metricDate, done ? 1 : -1);
    state.done = done;
    state.started = true;
  }

  return [...totals.values()]
    .filter((row) => row.tasksCompleted || row.pointsCompleted)
    .sort((left, right) => left.tenantId.localeCompare(right.tenantId)
      || left.userId.localeCompare(right.userId)
      || left.projectId.localeCompare(right.projectId)
      || left.metricDate.localeCompare(right.metricDate));
}

// Live recording starts with migration 0067, so a later cutoff would overwrite live rows.
export async function resolveBackfillCutoff({ before = null, executor }) {
  if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) throw new Error('--before must be a YYYY-MM-DD date.');

  const [rows] = await executor.execute('SELECT applied_at AS appliedAt FROM schema_migrations WHERE id = ? LIMIT 1', [METRICS_MIGRATION_ID]);
  const appliedOn = dateOnly(rows[0]?.appliedAt);
  if (!appliedOn) throw new Error(`Migration ${METRICS_MIGRATION_ID} has not been applied. Run the schema bootstrap first.`);
  if (before && before > appliedOn) throw new Error(`--before cannot be later than ${appliedOn}, the day live recording started.`);
  return before ?? appliedOn;
}

async function listTenantIds(executor, tenantId) {
  if (tenantId) return [tenantId];
  const [rows] = await executor.execute('SELECT DISTINCT tenant_id AS tenantId FROM projects ORDER BY tenant_id');
  return rows.map((row) => row.tenantId);
}

// Pursuit work earns no credit (src/lib/projects/pursuit.js), so its items are left out.
async function loadTenantHistory(executor, tenantId) {
  const [items] = await executor.execute(
    `
      SELECT
        t.id,
        p.tenant_id AS tenantId,
        t.project_id AS projectId,
        LOWER(tt.task_type_name) AS itemType,
        t.points,
        NOT EXISTS (
          SELECT 1
          FROM tasks child
          INNER JOIN task_types child_type ON child_type.id = child.task_type
          WHERE child.parent_task_id = t.id
            AND child.deleted = 0
            AND LOWER(child_type.task_type_name) <> 'ticket'
        ) AS leaf
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      INNER JOIN task_types tt ON tt.id = t.task_type
      WHERE p.tenant_id = ?
        AND t.pursuit = 0
    `,
    [tenantId],
  );
  const [logs] = await executor.execute(
    `
      SELECT l.task_id AS taskId, l.log_action AS action, l.log_data AS data, l.log_date AS loggedAt
      FROM task_log l
      INNER JOIN tasks t ON t.id = l.task_id
      INNER JOIN projects p ON p.id = t.project_id
      WHERE p.tenant_id = ?
        AND l.log_action IN ('assign', 'status_change')
      ORDER BY l.log_date, l.log_action = 'status_change', l.id
    `,
    [tenantId],
  );
  return {
    items: items.map((item) => ({ ...item, leaf: Boolean(Number(item.leaf)) })),
    logs,
  };
}

async function existingUserIds(executor, userIds) {
  const found = new Set();
  for (let index = 0; index < userIds.length; index += 500) {
    const chunk = userIds.slice(index, index + 500);
    const [rows] = await executor.execute(`SELECT id FROM users WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
    for (const row of rows) found.add(row.id);
  }
  return found;
}

async function writeDay(executor, row) {
  await executor.execute(
    `
      INSERT INTO contributor_metrics (user_id, tenant_id, project_id, metric_date, tasks_completed, points_completed, hours_logged)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        tasks_completed = VALUES(tasks_completed),
        points_completed = VALUES(points_completed),
        updated_at = CURRENT_TIMESTAMP
    `,
    [row.userId, row.tenantId, row.projectId, row.metricDate, row.tasksCompleted, row.pointsCompleted],
  );
}

export async function backfillContributorMetrics({ before = null, dryRun = true, executor, onTenant = () => {}, tenantId = null }) {
  const cutoff = await resolveBackfillCutoff({ before, executor });
  const tenants = [];

  for (const currentTenantId of await listTenantIds(executor, tenantId)) {
    const history = await loadTenantHistory(executor, currentTenantId);
    const derived = deriveContributorMetrics({ ...history, before: cutoff });
    const known = await existingUserIds(executor, [...new Set(derived.map((row) => row.userId))]);
    const rows = derived.filter((row) => known.has(row.userId));

    if (!dryRun) {
      for (const row of rows) await writeDay(executor, row);
    }

    const summary = {
      rows: rows.length,
      pointsCompleted: rows.reduce((sum, row) => sum + row.pointsCompleted, 0),
      skippedRowsForMissingUsers: derived.length - rows.length,
      tasksCompleted: rows.reduce((sum, row) => sum + row.tasksCompleted, 0),
      tenantId: currentTenantId,
      users: new Set(rows.map((row) => row.userId)).size,
    };
    tenants.push(summary);
    onTenant(summary);
  }

  return { before: cutoff, dryRun, tenants };
}
