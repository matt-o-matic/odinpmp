import 'dotenv/config';
import { loadEnv } from '../src/config/env.js';
import { createMysqlPool } from '../src/lib/db/mysql.js';
import { ensureMysqlPlatformDelegationSchema } from '../src/modules/platform/platform.repository.js';
import { ensureMysqlMailDeliverySchema } from '../src/modules/mail/mail.repository.js';
import { ensureMysqlBugReporterMailSchema } from '../src/modules/bug-reporter/bug-reporter.mail-repository.js';
import { ensureMysqlBugReporterReplySchema } from '../src/modules/bug-reporter/bug-reporter.replies-repository.js';

// Runs the migrations Bug Reporter needs (0037, 0027, 0088 and 0089) without recording them.
const env = loadEnv(process.env);
if (!env.databaseUrl) throw new Error('DATABASE_URL is required for the reporting companion migration.');
const pool = createMysqlPool(env.databaseUrl);
try {
  for (const up of [ensureMysqlPlatformDelegationSchema, ensureMysqlMailDeliverySchema, ensureMysqlBugReporterMailSchema, ensureMysqlBugReporterReplySchema]) await up(pool);
  console.log('Reporting session, mail registry and email reply schema are ready. No mail was queued.');
} finally { await pool.end(); }
