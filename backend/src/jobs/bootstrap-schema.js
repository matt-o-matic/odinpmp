import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { bootstrapMysqlSchema } from './bootstrap-schema.lib.js';

const JOB_NAME = 'bootstrap-schema';

async function main() {
  const env = loadEnv(process.env);
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to bootstrap the schema.');
  }

  const pool = createMysqlPool(env.databaseUrl);
  // `--reconcile`: migrations edited after they ran are applied again and re-recorded
  // instead of stopping the run. Use it only when those migrations are safe to re-run, as the
  // ensure-schema steps (add what is missing) are.
  const reconcile = process.argv.includes('--reconcile');

  try {
    const result = await bootstrapMysqlSchema({ executor: pool, reconcile });
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, {
        applied: result.applied,
        reconciled: result.reconciled ?? [],
        restamped: result.restamped ?? [],
        total: result.total,
      }),
      message: 'Schema bootstrap completed.',
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logBackendError({
    context: buildJobLogContext(JOB_NAME),
    error,
    message: 'Schema bootstrap job failed.',
  });
  process.exitCode = 1;
});
