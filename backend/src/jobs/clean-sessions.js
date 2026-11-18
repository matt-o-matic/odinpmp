import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { purgeMysqlItemChangeRequests } from '../modules/changes/item-change-requests.js';
import { CHANGE_LOG_RETENTION_DAYS, purgeMysqlProjectChanges } from '../modules/changes/project-change-log.js';
import { NOTIFICATION_RETENTION_DAYS, purgeOldNotifications } from '../modules/notifications/notifications.service.js';
import { createMysqlNotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { purgeMysqlExpiredOAuthTokens } from '../modules/platform/platform.repository.js';

const JOB_NAME = 'clean-sessions';

async function main() {
  const env = loadEnv(process.env);
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to clean sessions.');
  }

  const pool = createMysqlPool(env.databaseUrl);

  try {
    // Match legacy behavior: tokens expired more than one hour ago are purged.
    const [result] = await pool.execute('DELETE FROM tokens WHERE expiry_date < NOW() - INTERVAL 1 HOUR');
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, {
        deletedCount: result?.affectedRows ?? null,
      }),
      message: 'Expired sessions cleaned.',
    });
    // The project change log keeps 90 days.
    const purged = await purgeMysqlProjectChanges(pool, { days: CHANGE_LOG_RETENTION_DAYS });
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, { deletedCount: purged }),
      message: 'Old project changes purged.',
    });
    // Idempotency keys for odin_apply_item_changes keep 30 days.
    const keys = await purgeMysqlItemChangeRequests(pool);
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, { deletedCount: keys }),
      message: 'Old item change keys purged.',
    });
    // Integration OAuth tokens and codes, such as Bug Reporter's hourly access tokens, keep a week after expiry.
    const oauth = await purgeMysqlExpiredOAuthTokens(pool);
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, { deletedCount: oauth }),
      message: 'Expired OAuth tokens purged.',
    });
    // Notifications keep 90 days.
    const notifications = await purgeOldNotifications(createMysqlNotificationsRepository({ pool }), { days: NOTIFICATION_RETENTION_DAYS });
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, { deletedCount: notifications }),
      message: 'Old notifications purged.',
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logBackendError({
    context: buildJobLogContext(JOB_NAME),
    error,
    message: 'Session cleanup job failed.',
  });
  process.exitCode = 1;
});
