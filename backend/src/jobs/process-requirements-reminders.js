import 'dotenv/config';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { createMysqlAssistantRepository } from '../modules/assistant/assistant.repository.js';
import { createMysqlMailRepository } from '../modules/mail/mail.repository.js';
import { createMysqlProjectsRepository } from '../modules/projects/projects.repository.js';
import { createMysqlPackagesRepository } from '../modules/requirements/packages/packages.repository.js';
import { createMysqlRequirementsRepository } from '../modules/requirements/requirements.repository.js';
import { processRoundReminders } from '../modules/requirements/rounds/round-reminders.js';
import { createMysqlRoundsRepository } from '../modules/requirements/rounds/rounds.repository.js';

// Emails review reminders that are due (npm run job:requirements-reminders). Cron runs it
// every 15 minutes.

export const JOB_NAME = 'requirements-reminders';
const LOCK_STALE_MS = 15 * 60 * 1000;

async function acquireLock(lockName) {
  const lockPath = path.join(os.tmpdir(), lockName);
  const existing = await fs.readFile(lockPath, 'utf8').catch(() => '');
  if (existing) {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < LOCK_STALE_MS) return { acquired: false, lockPath };
  }
  await fs.writeFile(lockPath, String(process.pid), 'utf8');
  return { acquired: true, lockPath };
}

export async function main() {
  const env = loadEnv(process.env);
  if (!env.databaseUrl) throw new Error('DATABASE_URL is required to send review reminders.');

  const { acquired, lockPath } = await acquireLock('odinpmp-requirements-reminders.lock');
  if (!acquired) {
    logBackendEvent({ context: buildJobLogContext(JOB_NAME, { lockPath }), message: 'Review reminder run skipped because another worker holds the lock.' });
    return;
  }

  const pool = createMysqlPool(env.databaseUrl);
  try {
    const summary = await processRoundReminders({
      assistantRepository: createMysqlAssistantRepository({ pool }),
      frontendAppUrl: env.frontendAppUrl,
      mailRepository: createMysqlMailRepository({ pool }),
      packagesRepository: createMysqlPackagesRepository({ pool }),
      projectRepository: createMysqlProjectsRepository({ pool }),
      requirementsRepository: createMysqlRequirementsRepository({ pool }),
      roundsRepository: createMysqlRoundsRepository({ pool }),
    }, { now: new Date() });
    logBackendEvent({ context: buildJobLogContext(JOB_NAME, summary), message: 'Review reminder run completed.' });
  } finally {
    await fs.unlink(lockPath).catch(() => {});
    await pool.end();
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error) => {
    logBackendError({ context: buildJobLogContext(JOB_NAME), error, message: 'Review reminder job failed.' });
    process.exitCode = 1;
  });
}
