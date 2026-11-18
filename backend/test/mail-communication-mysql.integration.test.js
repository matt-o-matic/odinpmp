import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlMailRepository, ensureMysqlMailDeliverySchema } from '../src/modules/mail/mail.repository.js';
import { GOAL_ATTENTION_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL mail repository returns redacted delivery evidence by opaque target id', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const parsed = databaseUrl ? new URL(databaseUrl) : null;
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_mail_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    await ensureMysqlMailDeliverySchema(pool);
    const repository = createMysqlMailRepository({ pool });
    const queued = await repository.queueMail({
      body: '<p>Private delivery body</p>', recipientEmail: 'communication-proof@example.com',
      subject: 'Communication proof', targetId: 'notification-communication-proof', templateId: GOAL_ATTENTION_TEMPLATE_ID,
    });
    assert.equal(queued, true);
    const [pending] = await repository.listEmailsByTargetIds({ targetIds: ['notification-communication-proof'] });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.recipientEmail, undefined);
    assert.equal(pending.body, undefined);
    await repository.markSent({ id: pending.id });
    const [sent] = await repository.listEmailsByTargetIds({ targetIds: ['notification-communication-proof'] });
    assert.equal(sent.status, 'sent');
    assert.deepEqual(await repository.listEmailsByTargetIds({ targetIds: ['not-authorized'] }), []);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
