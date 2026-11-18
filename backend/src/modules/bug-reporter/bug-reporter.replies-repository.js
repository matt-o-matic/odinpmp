import { createHash, randomUUID } from 'node:crypto';
import { builtInTemplates } from '../mail/mail.templates.js';

// Email replies to Bug Reporter's notifications. A reply token belongs to one notification
// (its mail target) and records who the notification was for. Accepted replies wait here
// until Bug Reporter settles them, then their contents are deleted after RETENTION_MS.
export const RETENTION_MS = 30 * 86400000;
export const REPLY_NOT_ADDED_TEMPLATE_ID = 'bug-reporter-reply-not-added-v1';
const messageHash = messageId => createHash('sha256').update(String(messageId).trim()).digest('hex');
const tokenFields = ['applicationId', 'tenantId', 'projectId', 'reportId', 'reporterKind', 'reporterId', 'recipientEmail', 'reportTitle'];
const sizeOf = files => files.reduce((total, file) => total + file.data.length, 0);
// Bug Reporter receives at most this many attachment bytes per page, but always one reply.
export const PAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function page(rows, limit) {
  const result = [];
  let bytes = 0;
  for (const row of rows) {
    if (result.length >= limit) break;
    if (result.length && bytes + row.attachmentBytes > PAGE_ATTACHMENT_BYTES) break;
    bytes += row.attachmentBytes;
    result.push(row);
  }
  return result;
}

const publicReply = (row, files) => ({
  id: row.id, reportId: row.reportId, reporterKind: row.reporterKind, reporterId: row.reporterId,
  receivedAt: new Date(row.receivedAt).toISOString(), text: row.text ?? '',
  attachments: files.map(file => ({ name: file.name, data: Buffer.from(file.data).toString('base64') })),
});

export function createReplyStoreMemory(state) {
  state.replyTokens ??= new Map();
  state.replies ??= new Map();
  const byTarget = targetId => [...state.replyTokens.values()].find(row => row.targetId === targetId);
  function purge(now = Date.now()) {
    for (const row of state.replies.values()) {
      if (row.purgedAt) continue;
      const expired = row.status === 'pending' && now - row.receivedAt > RETENTION_MS;
      if (expired || (row.settledAt && now - row.settledAt > RETENTION_MS)) {
        if (expired) row.status = 'expired';
        row.text = null; row.files = []; row.purgedAt = now;
      }
    }
  }
  return {
    async ensureReplyToken({ targetId, token, ...fields }) {
      const existing = byTarget(targetId);
      if (existing) return existing.token;
      state.replyTokens.set(token, { token, targetId, ...fields });
      return token;
    },
    async updateReplyToken({ targetId, ...fields }) {
      const row = byTarget(targetId);
      if (row) for (const key of tokenFields) if (key in fields) row[key] = fields[key];
    },
    async findReplyToken({ token }) {
      const row = state.replyTokens.get(token);
      return row ? { ...row } : null;
    },
    async saveReply({ token, messageId, text, files }) {
      const hash = messageHash(messageId);
      if ([...state.replies.values()].some(row => row.messageHash === hash)) return { duplicate: true };
      const owner = state.replyTokens.get(token);
      const id = randomUUID();
      const fields = Object.fromEntries(tokenFields.map(key => [key, owner[key]]));
      state.replies.set(id, { id, messageHash: hash, token, ...fields, text, files, attachmentBytes: sizeOf(files), status: 'pending', reason: null, receivedAt: Date.now(), settledAt: null, purgedAt: null });
      return { id };
    },
    async listPendingReplies({ applicationId, tenantId, projectId, limit }) {
      purge();
      const rows = [...state.replies.values()]
        .filter(row => row.status === 'pending' && row.applicationId === applicationId && row.tenantId === tenantId && row.projectId === projectId)
        .sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id));
      return page(rows, limit).map(row => publicReply(row, row.files));
    },
    async settleReply({ applicationId, tenantId, projectId, replyId, outcome, reason }) {
      purge();
      const row = state.replies.get(replyId);
      if (!row || row.applicationId !== applicationId || row.tenantId !== tenantId || row.projectId !== projectId || row.status === 'expired') return { missing: true };
      if (row.status !== 'pending') return { conflict: row.status !== outcome || row.reason !== reason, reply: { ...row } };
      Object.assign(row, { status: outcome, reason, settledAt: Date.now() });
      return { settled: true, reply: { ...row } };
    },
    async purgeReplies() { purge(); },
  };
}

// 0089_bug_reporter_replies: reply tokens, the replies Bug Reporter has yet to settle, their
// files, and the template of the email that says a reply was not added.
export async function ensureMysqlBugReporterReplySchema(executor) {
  await executor.execute('CREATE TABLE IF NOT EXISTS bug_reporter_reply_tokens (token CHAR(40) PRIMARY KEY, target_id VARCHAR(128) NOT NULL, application_id VARCHAR(128) NOT NULL, tenant_id VARCHAR(128) NOT NULL, project_id VARCHAR(128) NOT NULL, report_id VARCHAR(100) NOT NULL, reporter_kind VARCHAR(20) NOT NULL, reporter_id VARCHAR(200) NOT NULL, recipient_email VARCHAR(255) NOT NULL, report_title VARCHAR(300) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_reply_token_target(target_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await executor.execute("CREATE TABLE IF NOT EXISTS bug_reporter_replies (id CHAR(36) PRIMARY KEY, message_hash CHAR(64) NOT NULL, token CHAR(40) NOT NULL, application_id VARCHAR(128) NOT NULL, tenant_id VARCHAR(128) NOT NULL, project_id VARCHAR(128) NOT NULL, report_id VARCHAR(100) NOT NULL, reporter_kind VARCHAR(20) NOT NULL, reporter_id VARCHAR(200) NOT NULL, recipient_email VARCHAR(255) NOT NULL, report_title VARCHAR(300) NOT NULL, body MEDIUMTEXT NULL, attachment_bytes INT NOT NULL DEFAULT 0, status ENUM('pending','added','rejected','expired') NOT NULL DEFAULT 'pending', reason VARCHAR(40) NULL, received_at DATETIME(3) NOT NULL, settled_at DATETIME(3) NULL, purged_at DATETIME(3) NULL, UNIQUE KEY uq_reply_message(message_hash), KEY idx_reply_pending(application_id, project_id, status, received_at), KEY idx_reply_purge(status, settled_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  await executor.execute('CREATE TABLE IF NOT EXISTS bug_reporter_reply_files (reply_id CHAR(36) NOT NULL, position INT NOT NULL, file_name VARCHAR(255) NOT NULL, data LONGBLOB NOT NULL, PRIMARY KEY(reply_id, position)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  const template = builtInTemplates[REPLY_NOT_ADDED_TEMPLATE_ID];
  await executor.execute('INSERT INTO mail_templates(id,template_name,template_contents,template_styles) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [REPLY_NOT_ADDED_TEMPLATE_ID, template.name, template.contents, template.styles]);
}

const replyColumns = 'id,report_id AS reportId,reporter_kind AS reporterKind,reporter_id AS reporterId,recipient_email AS recipientEmail,report_title AS reportTitle,body AS text,attachment_bytes AS attachmentBytes,status,reason,received_at AS receivedAt';

export function createReplyStoreMysql(pool) {
  async function purge() {
    const cutoff = new Date(Date.now() - RETENTION_MS), now = new Date();
    await pool.execute("UPDATE bug_reporter_replies SET status='expired' WHERE status='pending' AND received_at < ?", [cutoff]);
    const [rows] = await pool.execute("SELECT id FROM bug_reporter_replies WHERE purged_at IS NULL AND (status='expired' OR (settled_at IS NOT NULL AND settled_at < ?)) LIMIT 500", [cutoff]);
    for (const { id } of rows) {
      await pool.execute('DELETE FROM bug_reporter_reply_files WHERE reply_id=?', [id]);
      await pool.execute('UPDATE bug_reporter_replies SET body=NULL,purged_at=? WHERE id=?', [now, id]);
    }
  }
  return {
    async ensureReplyToken({ targetId, token, ...fields }) {
      await pool.execute('INSERT IGNORE INTO bug_reporter_reply_tokens(token,target_id,application_id,tenant_id,project_id,report_id,reporter_kind,reporter_id,recipient_email,report_title) VALUES(?,?,?,?,?,?,?,?,?,?)', [token, targetId, ...tokenFields.map(key => fields[key])]);
      const [rows] = await pool.execute('SELECT token FROM bug_reporter_reply_tokens WHERE target_id=? LIMIT 1', [targetId]);
      // Only a collision with another notification's random token leaves no row.
      if (!rows[0]) throw new Error('Could not store the Bug Reporter reply token.');
      return rows[0].token;
    },
    async updateReplyToken({ targetId, ...fields }) {
      await pool.execute('UPDATE bug_reporter_reply_tokens SET report_id=?,reporter_kind=?,reporter_id=?,recipient_email=?,report_title=? WHERE target_id=?', [fields.reportId, fields.reporterKind, fields.reporterId, fields.recipientEmail, fields.reportTitle, targetId]);
    },
    async findReplyToken({ token }) {
      const [rows] = await pool.execute('SELECT token,target_id AS targetId,application_id AS applicationId,tenant_id AS tenantId,project_id AS projectId,report_id AS reportId,reporter_kind AS reporterKind,reporter_id AS reporterId,recipient_email AS recipientEmail,report_title AS reportTitle FROM bug_reporter_reply_tokens WHERE token=? LIMIT 1', [token]);
      return rows[0] ?? null;
    },
    async saveReply({ token, messageId, text, files }) {
      const id = randomUUID(), connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [inserted] = await connection.execute('INSERT IGNORE INTO bug_reporter_replies(id,message_hash,token,application_id,tenant_id,project_id,report_id,reporter_kind,reporter_id,recipient_email,report_title,body,attachment_bytes,received_at) SELECT ?,?,token,application_id,tenant_id,project_id,report_id,reporter_kind,reporter_id,recipient_email,report_title,?,?,? FROM bug_reporter_reply_tokens WHERE token=?', [id, messageHash(messageId), text, sizeOf(files), new Date(), token]);
        if (!inserted.affectedRows) { await connection.rollback(); return { duplicate: true }; }
        for (const [position, file] of files.entries()) await connection.execute('INSERT INTO bug_reporter_reply_files(reply_id,position,file_name,data) VALUES(?,?,?,?)', [id, position, file.name, file.data]);
        await connection.commit();
        return { id };
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async listPendingReplies({ applicationId, tenantId, projectId, limit }) {
      await purge();
      const [rows] = await pool.execute(`SELECT ${replyColumns} FROM bug_reporter_replies WHERE application_id=? AND tenant_id=? AND project_id=? AND status='pending' ORDER BY received_at,id LIMIT ${Number(limit)}`, [applicationId, tenantId, projectId]);
      const result = [];
      for (const row of page(rows.map(value => ({ ...value, attachmentBytes: Number(value.attachmentBytes) })), limit)) {
        const [files] = await pool.execute('SELECT file_name AS name,data FROM bug_reporter_reply_files WHERE reply_id=? ORDER BY position', [row.id]);
        result.push(publicReply(row, files));
      }
      return result;
    },
    async settleReply({ applicationId, tenantId, projectId, replyId, outcome, reason }) {
      await purge();
      const [updated] = await pool.execute("UPDATE bug_reporter_replies SET status=?,reason=?,settled_at=? WHERE id=? AND application_id=? AND tenant_id=? AND project_id=? AND status='pending'", [outcome, reason, new Date(), replyId, applicationId, tenantId, projectId]);
      const [rows] = await pool.execute(`SELECT ${replyColumns} FROM bug_reporter_replies WHERE id=? AND application_id=? AND tenant_id=? AND project_id=? LIMIT 1`, [replyId, applicationId, tenantId, projectId]);
      const reply = rows[0];
      if (!reply || reply.status === 'expired') return { missing: true };
      if (updated.affectedRows) return { settled: true, reply };
      return { conflict: reply.status !== outcome || reply.reason !== reason, reply };
    },
    async purgeReplies() { await purge(); },
  };
}
