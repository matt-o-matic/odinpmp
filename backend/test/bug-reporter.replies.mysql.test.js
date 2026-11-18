import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createMysqlMailRepository } from '../src/modules/mail/mail.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

// Runs only against a disposable database named by this variable, e.g.
// mysql://root:password@127.0.0.1:33099/replies_scratch
const url = process.env.BUGREPORTER_REPLIES_MYSQL_URL;
test('MySQL reply store keeps one token per notification, dedupes messages, settles once and purges', { skip: !url }, async t => {
  const pool = mysql.createPool(url);
  t.after(() => pool.end());
  await applyMysqlMigrations(pool, ['0027_mail_delivery_schema', '0088_bug_reporter_mail_deliveries', '0089_bug_reporter_replies']);
  const repository = createMysqlMailRepository({ pool });
  const fields = { applicationId: 'app-1', tenantId: 'tenant-1', projectId: 'project-a', reportId: 'report-1', reporterKind: 'collaborator', reporterId: 'stakeholder-1', recipientEmail: 'tester@example.test', reportTitle: 'Import fails' };
  const targetId = 'reportupdate:' + Date.now();
  const tokens = await Promise.all([randomBytes(20), randomBytes(20)].map(bytes => repository.ensureReplyToken({ targetId, token: bytes.toString('hex'), ...fields })));
  assert.equal(tokens[0], tokens[1]);
  const token = tokens[0];
  await repository.updateReplyToken({ targetId, ...fields, reportTitle: 'Import still fails' });
  assert.equal((await repository.findReplyToken({ token })).reportTitle, 'Import still fails');
  assert.equal(await repository.findReplyToken({ token: 'c'.repeat(40) }), null);
  const replyTo = `bugreport+${token}@reply.odinpmp.com`;
  assert.equal((await repository.queueReportingMail({ subject: 'Update', body: '<p>Update</p>', recipientEmail: fields.recipientEmail, replyTo, templateId: 'bug-reporter-update-reply-v1', targetId, requestHash: 'f'.repeat(64), retryVersion: 0 })).status, 'queued');
  assert.equal((await pool.execute('SELECT reply_to AS replyTo FROM mail_queue WHERE mail_target_id=?', [targetId]))[0][0].replyTo, replyTo);

  const messageId = `<mysql-${Date.now()}@example.test>`;
  const files = [{ name: 'shot.png', data: Buffer.from('png-bytes') }, { name: 'log.pdf', data: Buffer.alloc(1024, 7) }];
  const saved = await repository.saveReply({ token, messageId, text: 'Still broken', files });
  assert.ok(saved.id);
  assert.deepEqual(await repository.saveReply({ token, messageId, text: 'again', files: [] }), { duplicate: true });
  await repository.saveReply({ token, messageId: messageId + '-2', text: 'Second', files: [] });

  const scope = { applicationId: 'app-1', tenantId: 'tenant-1', projectId: 'project-a' };
  const listed = await repository.listPendingReplies({ ...scope, limit: 10 });
  assert.deepEqual(listed.map(value => value.text), ['Still broken', 'Second']);
  assert.deepEqual(listed[0].attachments, files.map(file => ({ name: file.name, data: file.data.toString('base64') })));
  assert.equal(listed[0].reportId, 'report-1');
  assert.equal(new Date(listed[0].receivedAt).toISOString(), listed[0].receivedAt);
  assert.equal((await repository.listPendingReplies({ ...scope, projectId: 'project-b', limit: 10 })).length, 0);

  const settle = (outcome, reason = null, replyId = saved.id) => repository.settleReply({ ...scope, replyId, outcome, reason });
  const first = await settle('rejected', 'report_deleted');
  assert.equal(first.settled, true);
  assert.equal(first.reply.recipientEmail, 'tester@example.test');
  assert.equal(first.reply.reportTitle, 'Import still fails');
  assert.equal((await settle('rejected', 'report_deleted')).conflict, false);
  assert.equal((await settle('added')).conflict, true);
  assert.equal((await settle('added', null, '00000000-0000-4000-8000-000000000000')).missing, true);
  assert.deepEqual((await repository.listPendingReplies({ ...scope, limit: 10 })).map(value => value.text), ['Second']);

  // Move both replies 31 days into the past, then purge.
  await pool.execute('UPDATE bug_reporter_replies SET received_at=received_at - INTERVAL 31 DAY, settled_at=settled_at - INTERVAL 31 DAY WHERE token=?', [token]);
  await repository.purgeReplies();
  const [rows] = await pool.execute('SELECT body,status,purged_at AS purgedAt FROM bug_reporter_replies WHERE token=? ORDER BY received_at', [token]);
  assert.deepEqual(rows.map(row => [row.body, row.status, Boolean(row.purgedAt)]), [[null, 'rejected', true], [null, 'expired', true]]);
  assert.equal((await pool.execute('SELECT COUNT(*) AS count FROM bug_reporter_reply_files WHERE reply_id=?', [saved.id]))[0][0].count, 0);
  assert.equal((await repository.listPendingReplies({ ...scope, limit: 10 })).length, 0);
  assert.equal((await settle('rejected', 'report_deleted')).conflict, false);
  assert.equal((await pool.execute("SELECT COUNT(*) AS count FROM mail_templates WHERE id='bug-reporter-reply-not-added-v1'"))[0][0].count, 1);
});
