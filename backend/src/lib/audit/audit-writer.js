import { randomUUID } from 'node:crypto';

const MAX_ACTION_LENGTH = 100;
const MAX_RESULT_LENGTH = 200;
// Integrations act as `oauth-application:<uuid>`, longer than a bare user UUID.
export const MAX_AUDIT_USER_ID_LENGTH = 255;

/**
 * Lets `audit_log.user_id` hold actors that are not users. The legacy column is a char(36)
 * foreign key to `users.id`, which rejects integration actors at any length, so the key is
 * dropped and the column widened. Audit rows also outlive the users they mention.
 */
export async function ensureMysqlAuditLogActorSchema(executor) {
  const [foreignKeys] = await executor.execute(
    `
      SELECT CONSTRAINT_NAME AS name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'audit_log'
        AND COLUMN_NAME = 'user_id'
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `,
    [],
  );

  for (const { name } of foreignKeys) {
    await executor.execute(`ALTER TABLE audit_log DROP FOREIGN KEY \`${String(name).replace(/`/g, '``')}\``);
  }

  const [rows] = await executor.execute(
    `
      SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'audit_log'
        AND COLUMN_NAME = 'user_id'
      LIMIT 1
    `,
    [],
  );

  if (!rows[0] || Number(rows[0].maxLength) >= MAX_AUDIT_USER_ID_LENGTH) {
    return;
  }

  await executor.execute(`ALTER TABLE audit_log MODIFY COLUMN user_id VARCHAR(${MAX_AUDIT_USER_ID_LENGTH}) NOT NULL`);
}

function requiredText(value, field, maxLength) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new TypeError(`${field} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new TypeError(`${field} must not exceed ${maxLength} characters.`);
  }
  return normalized;
}

function serializeDetail(detail) {
  if (detail == null || detail === '') {
    return null;
  }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

export function createAuditWriter({ executor, idFactory = randomUUID } = {}) {
  if (!executor?.execute) {
    throw new TypeError('An audit database executor is required.');
  }

  return Object.freeze({
    async append(event, { executor: transactionExecutor = executor } = {}) {
      const record = {
        action: requiredText(event?.action, 'action', MAX_ACTION_LENGTH),
        detail: serializeDetail(event?.detail),
        id: idFactory(),
        ipAddress: requiredText(event?.ipAddress, 'ipAddress', 100),
        projectId: event?.projectId || null,
        result: requiredText(event?.result, 'result', MAX_RESULT_LENGTH),
        tenantId: event?.tenantId || null,
        userId: requiredText(event?.userId, 'userId', MAX_AUDIT_USER_ID_LENGTH),
      };

      await transactionExecutor.execute(
        `
          INSERT INTO audit_log (
            id,
            user_id,
            tenant_id,
            project_id,
            ip_addr,
            action,
            result,
            detail
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          record.id,
          record.userId,
          record.tenantId,
          record.projectId,
          record.ipAddress,
          record.action,
          record.result,
          record.detail,
        ],
      );

      return Object.freeze(record);
    },
  });
}
