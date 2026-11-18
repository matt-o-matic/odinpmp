import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { createMysqlAssigneeResourceStore, ensureAssigneeResources } from '../modules/resource-finance/assignee-resources.js';

// Gives everyone who already owns work a resource profile and an allocation on each project they
// own work in, the way assigning work does now. Safe to run again. `--dry-run` reports what it
// would add and rolls back.

async function currentAssignments(pool) {
  const [rows] = await pool.execute(`
    SELECT ranked.projectId, ranked.tenantId, ranked.logData
    FROM (
      SELECT t.project_id AS projectId, p.tenant_id AS tenantId, l.log_data AS logData,
        ROW_NUMBER() OVER (PARTITION BY l.task_id ORDER BY l.log_date DESC, l.id DESC) AS position
      FROM task_log l
      INNER JOIN tasks t ON t.id = l.task_id
      INNER JOIN projects p ON p.id = t.project_id
      WHERE t.deleted = 0 AND COALESCE(p.deleted, 0) = 0 AND l.log_action = 'assign'
    ) ranked
    WHERE ranked.position = 1
  `);
  const byTenant = new Map();
  for (const row of rows) {
    let userId = null;
    try { userId = JSON.parse(row.logData ?? '{}').assigned_to ?? null; } catch { userId = null; }
    if (!userId) continue;
    const pairs = byTenant.get(row.tenantId) ?? new Map();
    pairs.set(`${row.projectId}\u0000${userId}`, { projectId: row.projectId, userId: String(userId) });
    byTenant.set(row.tenantId, pairs);
  }
  return byTenant;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv(process.env);
  if (!env.databaseUrl) throw new Error('DATABASE_URL is required to backfill assignee resources.');
  const pool = createMysqlPool(env.databaseUrl);
  try {
    const byTenant = await currentAssignments(pool);
    for (const [tenantId, pairs] of byTenant) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await ensureAssigneeResources(createMysqlAssigneeResourceStore(connection, tenantId), { assignments: [...pairs.values()] });
        if (dryRun) await connection.rollback();
        else await connection.commit();
        const verb = dryRun ? 'Would add' : 'Added';
        console.log(`Tenant ${tenantId}: ${pairs.size} person-project assignments. ${verb} ${result.createdResources.length} resource profiles `
          + `(${result.createdResources.map((resource) => resource.name).join(', ') || 'none'}), linked ${result.linkedResources.length} existing `
          + `(${result.linkedResources.map((resource) => resource.name).join(', ') || 'none'}), and ${result.createdAllocations.length} project allocations.`);
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    }
    console.log(`Assignee resource ${dryRun ? 'dry run' : 'backfill'} complete.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
