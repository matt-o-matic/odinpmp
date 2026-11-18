import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { backfillContributorMetrics, parseBackfillFlags } from './backfill-contributor-metrics.lib.js';

const JOB_NAME = 'backfill-contributor-metrics';

async function main() {
  const options = parseBackfillFlags(process.argv.slice(2));
  const env = loadEnv(process.env);
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to backfill contributor metrics.');
  }

  const pool = createMysqlPool(env.databaseUrl);

  try {
    const result = await backfillContributorMetrics({
      before: options.before,
      dryRun: options.dryRun,
      executor: pool,
      onTenant: (summary) => console.log(
        `${options.dryRun ? 'Would write' : 'Wrote'} ${summary.rows} rows for ${summary.users} users in tenant ${summary.tenantId}: `
        + `${summary.tasksCompleted} items, ${summary.pointsCompleted} points`
        + (summary.skippedRowsForMissingUsers ? `; skipped ${summary.skippedRowsForMissingUsers} rows for deleted users.` : '.'),
      ),
      tenantId: options.tenantId,
    });

    console.log(`Contributor metrics ${options.dryRun ? 'dry run' : 'backfill'} complete for days before ${result.before}.`);
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, {
        before: result.before,
        dryRun: options.dryRun,
        tenantCount: result.tenants.length,
      }),
      message: 'Contributor metrics backfill completed.',
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logBackendError({
    context: buildJobLogContext(JOB_NAME),
    error,
    message: 'Contributor metrics backfill failed.',
  });
  process.exitCode = 1;
});
