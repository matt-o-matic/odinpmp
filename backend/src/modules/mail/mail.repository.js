import { randomUUID } from 'node:crypto';
import { getReportingMailMemory, queueReportingMailMemory, getReportingMailMysql, queueReportingMailMysql } from '../bug-reporter/bug-reporter.mail-repository.js';
import { createReplyStoreMemory, createReplyStoreMysql } from '../bug-reporter/bug-reporter.replies-repository.js';

import { MENTION_TEMPLATE_ID, builtInTemplates } from './mail.templates.js';

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [tableName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function getColumnDefinition(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    `
      SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength, IS_NULLABLE AS isNullable
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return rows[0] ?? null;
}

async function getForeignKeyConstraintName(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    `
      SELECT CONSTRAINT_NAME AS constraintName
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return String(rows[0]?.constraintName ?? '').trim() || null;
}

// Writes the built-in template a queued email names, so that its mail_queue row can reference it.
async function ensureBuiltInTemplateRow(executor, templateId) {
  const id = String(templateId ?? '').trim();
  if (!id || !builtInTemplates[id]) {
    return;
  }

  const template = builtInTemplates[id];
  await executor.execute(
    `
      INSERT INTO mail_templates (id, template_name, template_contents, template_styles)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE id = id
    `,
    [
      id,
      String(template.name ?? id).slice(0, 100),
      String(template.contents ?? ''),
      String(template.styles ?? ''),
    ],
  );
}

export async function ensureMysqlMailSchema(executor) {
  if (!await tableExists(executor, 'mail_queue')) {
    return;
  }

  if (await tableExists(executor, 'mail_templates')) {
    const templateContentsColumn = await getColumnDefinition(executor, 'mail_templates', 'template_contents');
    const templateContentsMaxLength = Number(templateContentsColumn?.maxLength ?? 0);
    if (templateContentsMaxLength > 0 && templateContentsMaxLength < 4000) {
      await executor.execute('ALTER TABLE mail_templates MODIFY COLUMN template_contents TEXT NOT NULL');
    }
  }

  if (!await columnExists(executor, 'mail_queue', 'reply_to')) {
    await executor.execute('ALTER TABLE mail_queue ADD COLUMN reply_to VARCHAR(255) NULL AFTER body');
  }

  const mailTemplateIdColumn = await getColumnDefinition(executor, 'mail_queue', 'mail_template_id');
  const maxLength = Number(mailTemplateIdColumn?.maxLength ?? 0);
  if (maxLength > 0 && maxLength < 128) {
    const mailTemplatesIdColumn = await getColumnDefinition(executor, 'mail_templates', 'id');
    const mailTemplatesIdMaxLength = Number(mailTemplatesIdColumn?.maxLength ?? 0);
    const foreignKeyName = await getForeignKeyConstraintName(executor, 'mail_queue', 'mail_template_id');
    const nullability = String(mailTemplateIdColumn?.isNullable ?? '').toUpperCase() === 'YES'
      ? 'NULL'
      : 'NOT NULL';

    if (foreignKeyName) {
      await executor.execute(`ALTER TABLE mail_queue DROP FOREIGN KEY \`${foreignKeyName}\``);
    }

    if (mailTemplatesIdMaxLength > 0 && mailTemplatesIdMaxLength < 128) {
      await executor.execute('ALTER TABLE mail_templates MODIFY COLUMN id VARCHAR(128) NOT NULL');
    }

    await executor.execute(`ALTER TABLE mail_queue MODIFY COLUMN mail_template_id VARCHAR(128) ${nullability}`);

    if (foreignKeyName) {
      await executor.execute(
        `ALTER TABLE mail_queue ADD CONSTRAINT \`${foreignKeyName}\` FOREIGN KEY (mail_template_id) REFERENCES mail_templates (id)`,
      );
    }
  }
}

export async function ensureMysqlMailDeliverySchema(executor) {
  if (await tableExists(executor, 'mail_queue')) {
    await ensureMysqlMailSchema(executor);
  } else {
    if (!await tableExists(executor, 'mail_templates')) {
      await executor.execute(`CREATE TABLE mail_templates (id VARCHAR(128) PRIMARY KEY, template_name VARCHAR(100) NOT NULL, template_contents TEXT NOT NULL, template_styles TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    } else {
      const templateIdColumn = await getColumnDefinition(executor, 'mail_templates', 'id');
      if (Number(templateIdColumn?.maxLength ?? 0) > 0 && Number(templateIdColumn.maxLength) < 128) await executor.execute('ALTER TABLE mail_templates MODIFY COLUMN id VARCHAR(128) NOT NULL');
    }
    await executor.execute(`CREATE TABLE mail_queue (id BIGINT AUTO_INCREMENT PRIMARY KEY, recipient_email VARCHAR(255) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, reply_to VARCHAR(255) NULL, status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, mail_template_id VARCHAR(128) NOT NULL, mail_target_id VARCHAR(128) NULL, created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY idx_mail_queue_status (status), KEY idx_mail_queue_created_at (created_at), KEY idx_mail_queue_target (mail_target_id), CONSTRAINT fk_mail_queue_template FOREIGN KEY (mail_template_id) REFERENCES mail_templates(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  await executor.execute(`CREATE TABLE IF NOT EXISTS email_opt_out (id BIGINT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL, opted_out TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_email_opt_out_email (email), KEY idx_email_opt_out_status (opted_out)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS email_bounces (id BIGINT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL, bounce_type ENUM('hard','soft') NOT NULL, reason TEXT NULL, created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_email_bounces_email (email), KEY idx_email_bounces_created_at (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export function createInMemoryMailRepository(seed = {}) {
  const state = {
    bounces: [],
    optOut: new Map(),
    queue: [],
    templates: new Map(Object.entries(builtInTemplates)),
  };

  for (const email of seed.optOut ?? []) {
    state.optOut.set(normalizeEmail(email), true);
  }

  return {
    state,
    async queueReportingMail(input) { return queueReportingMailMemory(state, input); },
    async getReportingMail({ targetId }) { return getReportingMailMemory(state, targetId); },
    ...createReplyStoreMemory(state),
    async getTemplate({ templateId }) {
      const id = String(templateId ?? '').trim() || MENTION_TEMPLATE_ID;
      return state.templates.get(id) ?? null;
    },
    async isOptedOut({ email }) {
      return Boolean(state.optOut.get(normalizeEmail(email)));
    },
    async optOutEmail({ email }) {
      state.optOut.set(normalizeEmail(email), true);
      return true;
    },
    async logBounce({ email, bounceType, reason }) {
      state.bounces.push({
        bounceType,
        createdAt: new Date().toISOString(),
        email: normalizeEmail(email),
        reason: String(reason ?? '').slice(0, 4000),
      });
      return true;
    },
    async queueMail({ recipientEmail, replyTo, subject, body, templateId, targetId }) {
      const email = normalizeEmail(recipientEmail);
      const tpl = String(templateId ?? '').trim() || MENTION_TEMPLATE_ID;
      const tgt = String(targetId ?? '').trim() || null;

      const exists = state.queue.some((row) =>
        row.recipientEmail === email
        && row.templateId === tpl
        && String(row.targetId ?? '') === String(tgt ?? ''));

      if (exists) {
        return false;
      }

      state.queue.push({
        attempts: 0,
        body: String(body ?? ''),
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        recipientEmail: email,
        replyTo: String(replyTo ?? '').trim(),
        status: 'pending',
        subject: String(subject ?? ''),
        targetId: tgt,
        templateId: tpl,
        updatedAt: new Date().toISOString(),
      });

      return true;
    },
    async listPendingEmails({ limit = 10 } = {}) {
      return state.queue
        .filter((row) => row.status === 'pending' && !state.optOut.get(row.recipientEmail))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
    },
    async listEmailsByTargetIds({ limit = 200, targetIds = [] } = {}) {
      const targets = new Set((targetIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 200));
      return state.queue.filter((row) => targets.has(String(row.targetId ?? ''))).slice(0, Math.max(1, Math.min(Number(limit) || 200, 500))).map((row) => ({
        attempts: row.attempts, createdAt: row.createdAt, id: row.id, status: row.status,
        targetId: row.targetId, templateId: row.templateId, updatedAt: row.updatedAt,
      }));
    },
    async markProcessing({ id }) {
      const row = state.queue.find((item) => item.id === id);
      if (!row) return false;
      row.status = 'processing';
      row.updatedAt = new Date().toISOString();
      return true;
    },
    async markSent({ id }) {
      const row = state.queue.find((item) => item.id === id);
      if (!row) return false;
      row.status = 'sent';
      row.updatedAt = new Date().toISOString();
      return true;
    },
    async markFailed({ id }) {
      const row = state.queue.find((item) => item.id === id);
      if (!row) return false;
      row.status = 'failed';
      row.updatedAt = new Date().toISOString();
      return true;
    },
    async retrySoftBounce({ id }) {
      const row = state.queue.find((item) => item.id === id);
      if (!row) return false;
      row.attempts = Number(row.attempts ?? 0) + 1;
      row.status = 'pending';
      row.updatedAt = new Date().toISOString();
      return true;
    },
    async failSoftBouncesOverAttempts({ maxAttempts = 3 } = {}) {
      const threshold = Number(maxAttempts ?? 3);
      let updated = 0;

      for (const row of state.queue) {
        if (row.status === 'pending' && Number(row.attempts ?? 0) > threshold) {
          state.optOut.set(row.recipientEmail, true);
          row.status = 'failed';
          row.updatedAt = new Date().toISOString();
          updated += 1;
        }
      }

      return { updated };
    },
  };
}

export function createMysqlMailRepository({ pool } = {}) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the mail repository.');
  }

  function toDbEmail(email) {
    return normalizeEmail(email);
  }

  return {
    async queueReportingMail(input) { return queueReportingMailMysql(pool, input); },
    async getReportingMail({ targetId }) { return getReportingMailMysql(pool, targetId); },
    ...createReplyStoreMysql(pool),
    async getTemplate({ templateId }) {
      const id = String(templateId ?? '').trim() || MENTION_TEMPLATE_ID;

      try {
        const [rows] = await pool.execute(
          'SELECT id, template_contents AS contents, template_styles AS styles FROM mail_templates WHERE id = ? LIMIT 1',
          [id],
        );
        return rows[0] ?? null;
      } catch {
        return null;
      }
    },
    async isOptedOut({ email }) {
      const normalized = toDbEmail(email);
      const [rows] = await pool.execute(
        'SELECT opted_out AS optedOut FROM email_opt_out WHERE email = ? LIMIT 1',
        [normalized],
      );
      return Number(rows[0]?.optedOut ?? 0) === 1;
    },
    async optOutEmail({ email }) {
      const normalized = toDbEmail(email);
      await pool.execute(
        `
          INSERT INTO email_opt_out (email, opted_out)
          VALUES (?, 1)
          ON DUPLICATE KEY UPDATE opted_out = 1, updated_at = NOW()
        `,
        [normalized],
      );
      return true;
    },
    async logBounce({ email, bounceType, reason }) {
      const normalized = toDbEmail(email);
      await pool.execute(
        'INSERT INTO email_bounces (email, bounce_type, reason) VALUES (?, ?, ?)',
        [normalized, bounceType === 'hard' ? 'hard' : 'soft', String(reason ?? '').slice(0, 4000)],
      );
      return true;
    },
    async queueMail({ recipientEmail, replyTo, subject, body, templateId, targetId }) {
      const email = toDbEmail(recipientEmail);
      const tpl = String(templateId ?? '').trim() || MENTION_TEMPLATE_ID;
      const tgt = String(targetId ?? '').trim() || null;
      const normalizedReplyTo = String(replyTo ?? '').trim() || null;

      await ensureBuiltInTemplateRow(pool, tpl);

      const [rows] = await pool.execute(
        `
          SELECT COUNT(*) AS count
          FROM mail_queue
          WHERE recipient_email = ?
            AND mail_template_id = ?
            AND ((mail_target_id IS NULL AND ? IS NULL) OR mail_target_id = ?)
          LIMIT 1
        `,
        [email, tpl, tgt, tgt],
      );

      if (Number(rows[0]?.count ?? 0) > 0) {
        return false;
      }

      await pool.execute(
        `
          INSERT INTO mail_queue (recipient_email, subject, body, reply_to, mail_template_id, mail_target_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [email, String(subject ?? ''), String(body ?? ''), normalizedReplyTo, tpl, tgt],
      );

      return true;
    },
    async listPendingEmails({ limit = 10 } = {}) {
      const effectiveLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
      const [rows] = await pool.execute(
        `
          SELECT
            id,
            recipient_email AS recipientEmail,
            subject,
            body,
            reply_to AS replyTo,
            status,
            attempts,
            mail_template_id AS templateId,
            mail_target_id AS targetId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM mail_queue
          WHERE status = 'pending'
            AND recipient_email NOT IN (SELECT email FROM email_opt_out WHERE opted_out = TRUE)
          ORDER BY created_at ASC
          LIMIT ${effectiveLimit}
        `,
      );

      return rows ?? [];
    },
    async listEmailsByTargetIds({ limit = 200, targetIds = [] } = {}) {
      const targets = [...new Set((targetIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 200);
      if (targets.length === 0) return [];
      const effectiveLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const [rows] = await pool.execute(
        `SELECT id, status, attempts, mail_template_id AS templateId, mail_target_id AS targetId, created_at AS createdAt, updated_at AS updatedAt FROM mail_queue WHERE mail_target_id IN (${targets.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT ${effectiveLimit}`,
        targets,
      );
      return rows ?? [];
    },
    async markProcessing({ id }) {
      const [result] = await pool.execute(
        'UPDATE mail_queue SET status = ? WHERE id = ?',
        ['processing', id],
      );
      return result.affectedRows > 0;
    },
    async markSent({ id }) {
      const [result] = await pool.execute(
        'UPDATE mail_queue SET status = ? WHERE id = ?',
        ['sent', id],
      );
      return result.affectedRows > 0;
    },
    async markFailed({ id }) {
      const [result] = await pool.execute(
        'UPDATE mail_queue SET status = ? WHERE id = ?',
        ['failed', id],
      );
      return result.affectedRows > 0;
    },
    async retrySoftBounce({ id }) {
      const [result] = await pool.execute(
        "UPDATE mail_queue SET attempts = attempts + 1, status = 'pending' WHERE id = ?",
        [id],
      );
      return result.affectedRows > 0;
    },
    async failSoftBouncesOverAttempts({ maxAttempts = 3 } = {}) {
      const threshold = Number(maxAttempts ?? 3);

      const [rows] = await pool.execute(
        "SELECT id, recipient_email AS recipientEmail FROM mail_queue WHERE status='pending' AND attempts > ?",
        [threshold],
      );

      for (const row of rows ?? []) {
        await pool.execute(
          `
            INSERT INTO email_opt_out (email, opted_out)
            VALUES (?, 1)
            ON DUPLICATE KEY UPDATE opted_out = 1, updated_at = NOW()
          `,
          [row.recipientEmail],
        );
        await pool.execute('UPDATE mail_queue SET status = ? WHERE id = ?', ['failed', row.id]);
      }

      return { updated: rows?.length ?? 0 };
    },
  };
}
