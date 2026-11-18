import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { runSchemaParityMigration } from './migrate-prod-schema-parity.lib.js';

const JOB_NAME = 'migrate-prod-schema-parity';

function parseCliFlags(argv = process.argv.slice(2)) {
  return {
    allowProduction: argv.includes('--allow-production'),
    apply: argv.includes('--apply'),
  };
}

function logStatus({ message, operation, type }) {
  const prefix = type === 'apply' ? 'Applying' : 'Pending';
  console.log(`${prefix}: ${message}`);

  if (operation?.sql) {
    console.log(operation.sql.trim().replace(/\s+/g, ' '));
  }
}

async function main() {
  const env = loadEnv(process.env);
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to run schema parity migration.');
  }

  const options = parseCliFlags();
  const pool = createMysqlPool(env.databaseUrl);

  try {
    const result = await runSchemaParityMigration({
      allowProduction: options.allowProduction,
      apply: options.apply,
      executor: pool,
      onStatus: logStatus,
    });

    const mode = options.apply ? 'apply' : 'dry-run';
    console.log(
      `Schema parity ${mode} complete for ${result.databaseName}. `
      + `Applied ${result.applied.length}; pending ${result.pending.length}; skipped ${result.skipped.length}.`,
    );

    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, {
        applied: result.applied.length,
        databaseName: result.databaseName,
        mode,
        pending: result.pending.length,
        skipped: result.skipped.length,
      }),
      message: 'Schema parity migration completed.',
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logBackendError({
    context: buildJobLogContext(JOB_NAME),
    error,
    message: 'Schema parity migration failed.',
  });
  process.exitCode = 1;
});
