// Odin's replies in channels (docs/engagements/plan.md, Odin in channels): one record per post
// that tags @odin. Spread into the projects repositories, as the channel methods are. Each
// channel's "Let Odin answer when tagged" setting is project_channels.odin_enabled
// (channels.repository.js, 0105_channel_odin).
import { randomUUID } from 'node:crypto';

export const ODIN_REPLY_STATUSES = Object.freeze(['queued', 'running', 'awaiting_confirmation', 'replied', 'failed', 'screened']);
// Odin is still working on these.
export const ODIN_REPLY_ACTIVE = new Set(['queued', 'running']);

const iso = (value) => (value ? new Date(value).toISOString() : null);
const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

const UPDATABLE = { chatId: 'chat_id', error: 'error', replyPostId: 'reply_post_id', status: 'status' };

function replyFromRow(row) {
  return {
    channelId: row.channel_id,
    chatId: row.chat_id ?? null,
    createdAt: iso(row.created_at),
    error: row.error ?? null,
    id: row.id,
    postId: row.post_id,
    projectId: row.project_id,
    replyPostId: row.reply_post_id ?? null,
    requesterId: row.requester_id,
    requesterType: row.requester_type,
    status: row.status,
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    updatedAt: iso(row.updated_at),
  };
}

export function createInMemoryOdinReplyMethods({ state }) {
  state.odinReplies ??= [];
  const clone = (value) => structuredClone(value);
  const find = (predicate) => state.odinReplies.find(predicate) ?? null;

  return {
    // One record per tagging post: a second call for the same post returns the first.
    async createOdinReply({ reply }) {
      const existing = find((entry) => entry.postId === reply.postId);
      if (existing) return { created: false, reply: clone(existing) };
      const now = new Date().toISOString();
      const stored = { chatId: null, error: null, replyPostId: null, ...clone(reply), createdAt: now, id: reply.id ?? randomUUID(), updatedAt: now };
      state.odinReplies.push(stored);
      return { created: true, reply: clone(stored) };
    },
    async getOdinReply({ replyId, tenantId }) {
      const reply = find((entry) => entry.id === replyId && entry.tenantId === tenantId);
      return reply ? clone(reply) : null;
    },
    // Records for tagging posts (postIds) and for Odin's own posts (replyIds, their author ids).
    async listOdinReplies({ postIds = [], replyIds = [], tenantId }) {
      const posts = new Set(postIds);
      const ids = new Set(replyIds);
      return state.odinReplies.filter((entry) => entry.tenantId === tenantId && (posts.has(entry.postId) || ids.has(entry.id))).map(clone);
    },
    async updateOdinReply({ changes, replyId, tenantId }) {
      const reply = find((entry) => entry.id === replyId && entry.tenantId === tenantId);
      if (!reply) return null;
      for (const key of Object.keys(UPDATABLE)) if (changes[key] !== undefined) reply[key] = changes[key];
      reply.updatedAt = new Date().toISOString();
      return clone(reply);
    },
  };
}

export function createMysqlOdinReplyMethods({ pool }) {
  async function readReply(executor, where, values) {
    const [rows] = await executor.execute(`SELECT * FROM odin_replies WHERE ${where} LIMIT 1`, values);
    return rows[0] ? replyFromRow(rows[0]) : null;
  }

  return {
    async createOdinReply({ reply }) {
      const id = reply.id ?? randomUUID();
      try {
        await pool.execute(
          `INSERT INTO odin_replies (id, tenant_id, project_id, channel_id, post_id, thread_id, requester_type, requester_id, chat_id, reply_post_id, status, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NOW(3), NOW(3))`,
          [id, reply.tenantId, reply.projectId, reply.channelId, reply.postId, reply.threadId, reply.requesterType, reply.requesterId, reply.chatId ?? null, reply.status],
        );
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        return { created: false, reply: await readReply(pool, 'post_id = ?', [reply.postId]) };
      }
      return { created: true, reply: await readReply(pool, 'id = ?', [id]) };
    },
    async getOdinReply({ replyId, tenantId }) {
      return readReply(pool, 'id = ? AND tenant_id = ?', [replyId, tenantId]);
    },
    async listOdinReplies({ postIds = [], replyIds = [], tenantId }) {
      if (!postIds.length && !replyIds.length) return [];
      const clauses = [];
      const values = [tenantId];
      if (postIds.length) { clauses.push('post_id IN (?)'); values.push(postIds); }
      if (replyIds.length) { clauses.push('id IN (?)'); values.push(replyIds); }
      const [rows] = await pool.query(`SELECT * FROM odin_replies WHERE tenant_id = ? AND (${clauses.join(' OR ')})`, values);
      return rows.map(replyFromRow);
    },
    async updateOdinReply({ changes, replyId, tenantId }) {
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(UPDATABLE)) {
        if (changes[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(changes[key]);
      }
      if (!sets.length) return readReply(pool, 'id = ? AND tenant_id = ?', [replyId, tenantId]);
      await pool.execute(`UPDATE odin_replies SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ? AND tenant_id = ?`, [...values, replyId, tenantId]);
      return readReply(pool, 'id = ? AND tenant_id = ?', [replyId, tenantId]);
    },
  };
}
