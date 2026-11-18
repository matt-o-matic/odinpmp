// Contributor metrics: one row per tenant, user, project, and day, holding what that user's
// work in that project added to the leaderboard that day. Rows are written by
// work-completion-metrics.js and can carry negative values when completed work is reopened.
// Rows written before project tracking have no project_id.
//
// 0067_contributor_metrics is registered in src/jobs/bootstrap-schema.lib.js. The migration
// runner checksums its body: never edit it; add a new migration instead.

// hours_logged is DECIMAL(5,2) in the legacy table.
const MAX_DAILY_HOURS = 999.99;

export function metricDateFor(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** The first day inside a window of `days` days that ends today. */
export function leaderboardWindowStart(days, now = new Date()) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (Math.max(1, days) - 1));
  return metricDateFor(start);
}

function clampHours(value) {
  return Math.min(MAX_DAILY_HOURS, Math.max(-MAX_DAILY_HOURS, Math.round(Number(value ?? 0) * 100) / 100));
}

function wholeNumber(value) {
  const number = Math.round(Number(value ?? 0));
  return Number.isFinite(number) ? number : 0;
}

function hasActivity(row) {
  return row.points > 0 || row.tasksCompleted > 0 || row.hoursLogged > 0;
}

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [tableName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, columnName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [tableName, indexName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

// 0067_contributor_metrics: the legacy table for databases built without the legacy schema,
// then a nullable project_id so metrics can be totalled per project. The day key gains the
// project. The new key is added before the old one is dropped, because the tenant foreign
// key needs an index that starts with tenant_id.
export async function ensureMysqlMetricsSchema(executor) {
  if (!await tableExists(executor, 'contributor_metrics')) {
    await executor.execute(`
      CREATE TABLE IF NOT EXISTS contributor_metrics (
        id CHAR(36) NOT NULL DEFAULT (uuid()),
        tenant_id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        metric_date DATE NOT NULL,
        tasks_completed INT DEFAULT '0',
        points_completed INT DEFAULT '0',
        hours_logged DECIMAL(5,2) DEFAULT '0.00',
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_metric (tenant_id, user_id, metric_date),
        KEY user_id (user_id),
        CONSTRAINT contributor_metrics_ibfk_1 FOREIGN KEY (tenant_id) REFERENCES tenants (id),
        CONSTRAINT contributor_metrics_ibfk_2 FOREIGN KEY (user_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!await columnExists(executor, 'contributor_metrics', 'project_id')) {
    await executor.execute('ALTER TABLE contributor_metrics ADD COLUMN project_id CHAR(36) NULL AFTER user_id');
  }
  if (!await indexExists(executor, 'contributor_metrics', 'uniq_metric_project')) {
    await executor.execute('ALTER TABLE contributor_metrics ADD UNIQUE KEY uniq_metric_project (tenant_id, user_id, project_id, metric_date)');
  }
  if (await indexExists(executor, 'contributor_metrics', 'uniq_metric')) {
    await executor.execute('ALTER TABLE contributor_metrics DROP INDEX uniq_metric');
  }
  if (!await indexExists(executor, 'contributor_metrics', 'idx_contributor_metrics_project')) {
    await executor.execute('CREATE INDEX idx_contributor_metrics_project ON contributor_metrics (tenant_id, project_id, metric_date)');
  }
}

function includesRow(row, { cutoff, excluded, projectId, tenantId }) {
  if (row.tenantId !== tenantId || row.metricDate < cutoff) return false;
  if (projectId) return row.projectId === projectId;
  return !row.projectId || !excluded.has(row.projectId);
}

export function createInMemoryMetricsRepository(seed = []) {
  const rows = seed.map((row) => ({ projectId: null, ...row }));

  function findRow({ metricDate, projectId, tenantId, userId }) {
    return rows.find(
      (row) => row.userId === userId && row.tenantId === tenantId && row.projectId === projectId && row.metricDate === metricDate,
    );
  }

  return {
    rows,
    async record({ hoursLogged = 0, metricDate = metricDateFor(), pointsCompleted = 0, projectId = null, tasksCompleted = 0, tenantId, userId }) {
      const existing = findRow({ metricDate, projectId, tenantId, userId });

      if (!existing) {
        rows.push({
          hoursLogged: clampHours(hoursLogged),
          metricDate,
          pointsCompleted: wholeNumber(pointsCompleted),
          projectId,
          tasksCompleted: wholeNumber(tasksCompleted),
          tenantId,
          userId,
        });
        return true;
      }

      existing.tasksCompleted += wholeNumber(tasksCompleted);
      existing.pointsCompleted += wholeNumber(pointsCompleted);
      existing.hoursLogged = clampHours(existing.hoursLogged + Number(hoursLogged ?? 0));
      return true;
    },
    // Every current tenant member with net positive activity in the window, unsorted. With
    // `projectId`, only that project counts; otherwise every project but the excluded ones.
    async listContributorTotals({ days = 30, excludedProjectIds = [], now = new Date(), projectId = null, tenantId, users = [] }) {
      const scope = { cutoff: leaderboardWindowStart(days, now), excluded: new Set(excludedProjectIds), projectId, tenantId };
      const totals = new Map();

      for (const row of rows) {
        if (!includesRow(row, scope)) continue;
        const current = totals.get(row.userId) ?? { hoursLogged: 0, points: 0, tasksCompleted: 0 };
        current.points += Number(row.pointsCompleted ?? 0);
        current.tasksCompleted += Number(row.tasksCompleted ?? 0);
        current.hoursLogged += Number(row.hoursLogged ?? 0);
        totals.set(row.userId, current);
      }

      const members = new Map(users
        .filter((user) => (user.memberships ?? []).some((membership) => membership.tenantId === tenantId))
        .map((user) => [user.id, user]));

      return [...totals.entries()]
        .filter(([userId]) => members.has(userId))
        .map(([userId, value]) => ({
          hoursLogged: Math.round(value.hoursLogged * 100) / 100,
          id: userId,
          name: members.get(userId).name ?? 'Unknown user',
          picture: members.get(userId).picture ?? null,
          points: value.points,
          tasksCompleted: value.tasksCompleted,
        }))
        .filter(hasActivity);
    },
  };
}

export function createMysqlMetricsRepository({ pool }) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the metrics repository.');
  }

  return {
    async record({ hoursLogged = 0, metricDate = metricDateFor(), pointsCompleted = 0, projectId = null, tasksCompleted = 0, tenantId, userId }) {
      await pool.execute(
        `
          INSERT INTO contributor_metrics (
            user_id,
            tenant_id,
            project_id,
            metric_date,
            tasks_completed,
            points_completed,
            hours_logged
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            tasks_completed = tasks_completed + VALUES(tasks_completed),
            points_completed = points_completed + VALUES(points_completed),
            hours_logged = LEAST(${MAX_DAILY_HOURS}, GREATEST(-${MAX_DAILY_HOURS}, hours_logged + VALUES(hours_logged))),
            updated_at = CURRENT_TIMESTAMP
        `,
        [userId, tenantId, projectId, metricDate, wholeNumber(tasksCompleted), wholeNumber(pointsCompleted), clampHours(hoursLogged)],
      );

      return true;
    },
    async listContributorTotals({ days = 30, excludedProjectIds = [], now = new Date(), projectId = null, tenantId }) {
      const params = [tenantId, leaderboardWindowStart(days, now)];
      let projectFilter = '';
      if (projectId) {
        projectFilter = 'AND cm.project_id = ?';
        params.push(projectId);
      } else if (excludedProjectIds.length > 0) {
        projectFilter = `AND (cm.project_id IS NULL OR cm.project_id NOT IN (${excludedProjectIds.map(() => '?').join(', ')}))`;
        params.push(...excludedProjectIds);
      }
      params.push(tenantId);

      const [rows] = await pool.execute(
        `
          SELECT
            totals.user_id AS id,
            u.name,
            (
              SELECT p.value
              FROM preferences p
              WHERE p.user_id = totals.user_id
                AND p.tenant_id IS NULL
                AND p.project_id IS NULL
                AND p.\`key\` = 'user_avatar'
              LIMIT 1
            ) AS picture,
            totals.points,
            totals.tasksCompleted,
            totals.hoursLogged
          FROM (
            SELECT
              cm.user_id,
              SUM(cm.points_completed) AS points,
              SUM(cm.tasks_completed) AS tasksCompleted,
              SUM(cm.hours_logged) AS hoursLogged
            FROM contributor_metrics cm
            WHERE cm.tenant_id = ?
              AND cm.metric_date >= ?
              ${projectFilter}
            GROUP BY cm.user_id
          ) totals
          JOIN users u ON u.id = totals.user_id
          WHERE EXISTS (
            SELECT 1 FROM user_tenant ut WHERE ut.user_id = totals.user_id AND ut.tenant_id = ?
          )
            AND (totals.points > 0 OR totals.tasksCompleted > 0 OR totals.hoursLogged > 0)
        `,
        params,
      );

      return rows.map((row) => ({
        hoursLogged: Math.round(Number(row.hoursLogged ?? 0) * 100) / 100,
        id: row.id,
        name: row.name,
        picture: row.picture ?? null,
        points: Number(row.points ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
      }));
    },
  };
}
