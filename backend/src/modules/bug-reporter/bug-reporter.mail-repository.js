import { randomUUID } from 'node:crypto';
import { builtInTemplates } from '../mail/mail.templates.js';

export const REPORTING_UPDATE_TEMPLATE_ID = 'bug-reporter-update-v2';
export const REPORTING_KEY_TEMPLATE_ID = 'bug-reporter-key-v2';
export const ASSIGNEE_NOTICE_TEMPLATE_ID = 'bug-reporter-assignee-v1';
// Template used in place of each update template when the email carries a reply address.
export const REPLY_TEMPLATE_IDS = { 'bug-reporter-update-v1': 'bug-reporter-status-reply-v1', [REPORTING_UPDATE_TEMPLATE_ID]: 'bug-reporter-update-reply-v1' };
const seededTemplates = new WeakMap();
const publicDelivery = (row, retryVersion, optedOut = false) => ({
  status: row.status === 'sent' ? 'sent' : row.status === 'failed' || optedOut ? 'failed' : 'queued',
  retryVersion,
  error: row.status === 'failed' || optedOut ? 'Odin could not deliver this email. Check its mail service and recipient settings before retrying.' : null,
});

export function getReportingMailMemory(state, targetId) {
  const delivery = state.reportingDeliveries?.get(targetId);
  if (!delivery) return null;
  const row = state.queue.find(value => value.id === delivery.queueId);
  return row ? publicDelivery(row, delivery.retryVersion, state.optOut.get(row.recipientEmail)) : null;
}

export function queueReportingMailMemory(state, input) {
  state.reportingDeliveries ??= new Map();
  const current = state.reportingDeliveries.get(input.targetId);
  if (current && current.requestHash !== input.requestHash) return { conflict: true };
  const email = String(input.recipientEmail).trim().toLowerCase();
  if (!current) {
    if (input.retryVersion !== 0) return { conflict: true };
    const row = { id: randomUUID(), recipientEmail: email, subject: input.subject, body: input.body, templateId: input.templateId ?? REPORTING_KEY_TEMPLATE_ID, targetId: input.targetId, replyTo: input.replyTo ?? '', status: state.optOut.get(email) ? 'failed' : 'pending', attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.queue.push(row);
    state.reportingDeliveries.set(input.targetId, { queueId: row.id, requestHash: input.requestHash, retryVersion: 0 });
  } else if (input.retryVersion > current.retryVersion) {
    if (input.retryVersion !== current.retryVersion + 1) return { conflict: true };
    const row = state.queue.find(value => value.id === current.queueId);
    if (row.status === 'failed') {
      current.retryVersion = input.retryVersion;
      row.status = state.optOut.get(email) ? 'failed' : 'pending';
      row.attempts = 0;
      row.updatedAt = new Date().toISOString();
    }
  }
  return getReportingMailMemory(state, input.targetId);
}

// 0088_bug_reporter_mail_deliveries: one delivery per reporting email target, and a mail_queue
// target column long enough for those targets.
export async function ensureMysqlBugReporterMailSchema(executor) {
  // Older Odin databases have a UUID-sized target column; reporting targets include a SHA-256 hash.
  const [targetColumns] = await executor.execute("SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength, IS_NULLABLE AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='mail_queue' AND column_name='mail_target_id'");
  const targetColumn = targetColumns[0];
  if (Number(targetColumn?.maxLength) > 0 && Number(targetColumn.maxLength) < 128) {
    const nullability = targetColumn.nullable === 'YES' ? 'NULL' : 'NOT NULL';
    await executor.execute(`ALTER TABLE mail_queue MODIFY COLUMN mail_target_id VARCHAR(128) ${nullability}`);
  }
  await executor.execute('CREATE TABLE IF NOT EXISTS bug_reporter_mail_deliveries (target_id VARCHAR(128) PRIMARY KEY, request_hash CHAR(64) NOT NULL, queue_id BIGINT NULL, retry_version INT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_reporting_queue_id(queue_id)) ENGINE=InnoDB');
}

// The built-in templates reporting mail is queued with, written once per pool so that
// mail_queue rows can reference them.
async function seedTemplates(pool) {
  if (!seededTemplates.has(pool)) seededTemplates.set(pool, (async () => {
    for (const templateId of [REPORTING_KEY_TEMPLATE_ID, 'bug-reporter-update-v1', REPORTING_UPDATE_TEMPLATE_ID, ...Object.values(REPLY_TEMPLATE_IDS), ASSIGNEE_NOTICE_TEMPLATE_ID]) {
    const template = builtInTemplates[templateId];
    await pool.execute('INSERT INTO mail_templates(id,template_name,template_contents,template_styles) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [templateId, template.name, template.contents, template.styles]);
    }
  })().catch(error => { seededTemplates.delete(pool); throw error; }));
  await seededTemplates.get(pool);
}

export async function getReportingMailMysql(pool, targetId) {
  const [rows] = await pool.execute('SELECT q.status,q.recipient_email AS recipientEmail,d.retry_version AS retryVersion,COALESCE(o.opted_out,0) AS optedOut FROM bug_reporter_mail_deliveries d JOIN mail_queue q ON q.id=d.queue_id LEFT JOIN email_opt_out o ON o.email=q.recipient_email WHERE d.target_id=? LIMIT 1', [targetId]);
  return rows[0] ? publicDelivery(rows[0], rows[0].retryVersion, Boolean(rows[0].optedOut)) : null;
}

export async function queueReportingMailMysql(pool, input) {
  await seedTemplates(pool);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO bug_reporter_mail_deliveries(target_id,request_hash) VALUES(?,?) ON DUPLICATE KEY UPDATE target_id=target_id', [input.targetId, input.requestHash]);
    const [records] = await connection.execute('SELECT request_hash AS requestHash,queue_id AS queueId,retry_version AS retryVersion FROM bug_reporter_mail_deliveries WHERE target_id=? FOR UPDATE', [input.targetId]);
    const current = records[0];
    if (current.requestHash !== input.requestHash || input.retryVersion > current.retryVersion + 1 || current.queueId === null && input.retryVersion !== 0) { await connection.rollback(); return { conflict: true }; }
    const email = String(input.recipientEmail).trim().toLowerCase();
    const [optOut] = await connection.execute('SELECT opted_out FROM email_opt_out WHERE email=? LIMIT 1', [email]);
    const blocked = Boolean(optOut[0]?.opted_out);
    if (current.queueId === null) {
      const [inserted] = await connection.execute('INSERT INTO mail_queue(recipient_email,subject,body,reply_to,mail_template_id,mail_target_id,status) VALUES(?,?,?,?,?,?,?)', [email, input.subject, input.body, input.replyTo || null, input.templateId ?? REPORTING_KEY_TEMPLATE_ID, input.targetId, blocked ? 'failed' : 'pending']);
      await connection.execute('UPDATE bug_reporter_mail_deliveries SET queue_id=? WHERE target_id=?', [inserted.insertId, input.targetId]);
    } else if (input.retryVersion > current.retryVersion) {
      const [rows] = await connection.execute('SELECT status FROM mail_queue WHERE id=? FOR UPDATE', [current.queueId]);
      if (rows[0]?.status === 'failed') {
        await connection.execute('UPDATE mail_queue SET status=?,attempts=0 WHERE id=?', [blocked ? 'failed' : 'pending', current.queueId]);
        await connection.execute('UPDATE bug_reporter_mail_deliveries SET retry_version=? WHERE target_id=?', [input.retryVersion, input.targetId]);
      }
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return getReportingMailMysql(pool, input.targetId);
}
