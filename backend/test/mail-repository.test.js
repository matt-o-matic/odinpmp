import assert from 'node:assert/strict';
import test from 'node:test';

import { createMysqlMailRepository, ensureMysqlMailSchema } from '../src/modules/mail/mail.repository.js';
import { CLARIFICATION_INVITATION_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';

function createMailQueuePool({
  existingTemplateIds = [],
  foreignKeyName = 'mail_queue_mail_templates_FK',
  mailTemplateIdLength = 36,
  replyToExists = true,
} = {}) {
  const executed = [];
  const templateIds = new Set(existingTemplateIds);

  async function execute(sql, params = []) {
    executed.push({ params, sql });

    if (sql.includes('FROM information_schema.TABLES')) {
      return [[{ count: 1 }]];
    }

    if (sql.includes('SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength')) {
      return [[{ isNullable: 'NO', maxLength: mailTemplateIdLength }]];
    }

    if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) {
      return [[{ constraintName: foreignKeyName }]];
    }

    if (sql.includes('FROM information_schema.COLUMNS') && sql.includes('COLUMN_NAME = ?')) {
      const [, columnName] = params;
      if (columnName === 'reply_to') {
        return [[{ count: replyToExists ? 1 : 0 }]];
      }
      if (columnName === 'mail_template_id') {
        return [[{ count: 1 }]];
      }
      return [[{ count: 0 }]];
    }

    if (sql.includes('SELECT COUNT(*) AS count') && sql.includes('FROM mail_queue')) {
      return [[{ count: 0 }]];
    }

    if (sql.includes('FROM mail_templates WHERE id = ? LIMIT 1')) {
      return [[templateIds.has(params[0]) ? { id: params[0] } : undefined].filter(Boolean)];
    }

    if (sql.startsWith('ALTER TABLE mail_queue ADD COLUMN reply_to')) {
      return [{ affectedRows: 1 }];
    }

    if (sql.startsWith('ALTER TABLE mail_queue MODIFY COLUMN mail_template_id')) {
      return [{ affectedRows: 1 }];
    }

    if (sql.startsWith('ALTER TABLE mail_templates MODIFY COLUMN id')) {
      return [{ affectedRows: 1 }];
    }

    if (sql.startsWith('ALTER TABLE mail_templates MODIFY COLUMN template_contents')) {
      return [{ affectedRows: 1 }];
    }

    if (sql.startsWith('ALTER TABLE mail_queue DROP FOREIGN KEY')) {
      return [{ affectedRows: 1 }];
    }

    if (sql.startsWith('ALTER TABLE mail_queue ADD CONSTRAINT')) {
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('INSERT INTO mail_templates')) {
      templateIds.add(params[0]);
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('INSERT INTO mail_queue')) {
      return [{ affectedRows: 1 }];
    }

    throw new Error(`Unexpected SQL in mail repository test double: ${sql}`);
  }

  return {
    executed,
    execute,
  };
}

test('migration 0002 widens both sides of the template foreign key; queueing mail changes no schema', async () => {
  const pool = createMailQueuePool({ mailTemplateIdLength: 36 });
  const repository = createMysqlMailRepository({ pool });

  const queued = await repository.queueMail({
    body: '<p>Hello</p>',
    recipientEmail: 'stakeholder@example.com',
    subject: 'Clarification needed',
    targetId: 'invitation-1',
    templateId: '1d7d0b7a-4f7e-4f39-bb07-clarification-mail',
  });

  assert.equal(queued, true);
  assert.deepEqual(pool.executed.filter((entry) => /ALTER TABLE|information_schema/i.test(entry.sql)), []);

  await ensureMysqlMailSchema(pool);
  assert.equal(
    pool.executed.some((entry) => entry.sql.startsWith('ALTER TABLE mail_queue DROP FOREIGN KEY `mail_queue_mail_templates_FK`')),
    true,
  );
  assert.equal(
    pool.executed.some((entry) => entry.sql.startsWith('ALTER TABLE mail_templates MODIFY COLUMN id VARCHAR(128) NOT NULL')),
    true,
  );
  assert.equal(
    pool.executed.some((entry) => entry.sql.startsWith('ALTER TABLE mail_queue MODIFY COLUMN mail_template_id VARCHAR(128) NOT NULL')),
    true,
  );
  assert.equal(
    pool.executed.some((entry) => entry.sql.startsWith('ALTER TABLE mail_queue ADD CONSTRAINT `mail_queue_mail_templates_FK` FOREIGN KEY (mail_template_id) REFERENCES mail_templates (id)')),
    true,
  );
});

test('mysql mail repository seeds a missing built-in clarification template row before queueing', async () => {
  const pool = createMailQueuePool({ existingTemplateIds: [] });
  const repository = createMysqlMailRepository({ pool });

  const queued = await repository.queueMail({
    body: '<p>Hello</p>',
    recipientEmail: 'stakeholder@example.com',
    subject: 'Clarification needed',
    targetId: 'invitation-1',
    templateId: CLARIFICATION_INVITATION_TEMPLATE_ID,
  });

  assert.equal(queued, true);
  const templateInsertIndex = pool.executed.findIndex((entry) => entry.sql.includes('INSERT INTO mail_templates'));
  const queueInsertIndex = pool.executed.findIndex((entry) => entry.sql.includes('INSERT INTO mail_queue'));
  assert.equal(templateInsertIndex >= 0, true);
  assert.equal(queueInsertIndex >= 0, true);
  assert.equal(templateInsertIndex < queueInsertIndex, true);
  assert.equal(pool.executed[templateInsertIndex].params[0], CLARIFICATION_INVITATION_TEMPLATE_ID);
});
