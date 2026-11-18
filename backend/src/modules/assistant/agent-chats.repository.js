import { randomUUID } from 'node:crypto';

// Assistant chats, one JSON document per chat in the preferences table (key `ac:<chatId>`),
// scoped to the user who owns it. The model-facing transcript (tool calls and results included)
// is a separate document (key `act:<chatId>`), so listing chats never parses it.

const KEY_PREFIX = 'ac:';
const TRANSCRIPT_PREFIX = 'act:';
const clone = (value) => JSON.parse(JSON.stringify(value));

export function normalizeChat(value = {}) {
  return {
    createdAt: value.createdAt ?? new Date().toISOString(),
    deletedAt: value.deletedAt ?? null,
    id: value.id,
    messages: Array.isArray(value.messages) ? value.messages : [],
    // A chat another surface started (Odin in channels): its type, its own turn notes and limits.
    ...(value.origin?.type ? { origin: value.origin } : {}),
    pending: value.pending ?? null,
    projectId: value.projectId ?? null,
    run: value.run ?? null,
    settings: { allowWebResearch: value.settings?.allowWebResearch !== false },
    tenantId: value.tenantId,
    title: String(value.title ?? '').trim(),
    // auto: cut from the first message; generated: named by a model once the first reply was in;
    // user: typed by the person, never replaced.
    titleSource: ['generated', 'user'].includes(value.titleSource) ? value.titleSource : 'auto',
    updatedAt: value.updatedAt ?? new Date().toISOString(),
    userId: value.userId,
  };
}

export function createInMemoryAgentChatsRepository() {
  const chats = new Map();
  const transcripts = new Map();
  const owns = (chatId, tenantId, userId) => {
    const chat = chats.get(chatId);
    return Boolean(chat && chat.tenantId === tenantId && chat.userId === userId);
  };
  return {
    async getTranscript({ chatId, tenantId, userId }) {
      return owns(chatId, tenantId, userId) && transcripts.has(chatId) ? clone(transcripts.get(chatId)) : null;
    },
    async saveTranscript({ chatId, tenantId, transcript, userId }) {
      if (owns(chatId, tenantId, userId)) transcripts.set(chatId, clone(transcript));
    },
    async get({ chatId, tenantId, userId }) {
      const chat = chats.get(chatId);
      return chat && chat.tenantId === tenantId && chat.userId === userId && !chat.deletedAt ? clone(chat) : null;
    },
    async list({ tenantId, userId }) {
      return [...chats.values()].filter((chat) => chat.tenantId === tenantId && chat.userId === userId && !chat.deletedAt).map(clone);
    },
    async save(chat) {
      const normalized = normalizeChat(chat);
      chats.set(normalized.id, clone(normalized));
      return clone(normalized);
    },
    async remove({ chatId, tenantId, userId }) {
      const chat = chats.get(chatId);
      if (!chat || chat.tenantId !== tenantId || chat.userId !== userId) return false;
      chats.delete(chatId);
      transcripts.delete(chatId);
      return true;
    },
    // Only the title changes, and only while it is the one cut from the first message: a name the
    // person typed stays, and nothing else in the chat is written back.
    async setGeneratedTitle({ chatId, tenantId, title, userId }) {
      const chat = chats.get(chatId);
      if (!chat || chat.tenantId !== tenantId || chat.userId !== userId || chat.deletedAt || chat.titleSource !== 'auto') return null;
      Object.assign(chat, { title: String(title).trim(), titleSource: 'generated' });
      return clone(chat);
    },
  };
}

export function createMysqlAgentChatsRepository({ pool }) {
  const parse = (value) => {
    try { return normalizeChat(JSON.parse(value)); } catch { return null; }
  };
  async function upsert({ key, tenantId, userId, value }) {
    const [result] = await pool.execute(
      'UPDATE preferences SET value = ?, updated_at = NOW() WHERE tenant_id = ? AND user_id = ? AND `key` = ?',
      [value, tenantId, userId, key],
    );
    if (!result.affectedRows) {
      await pool.execute(
        'INSERT INTO preferences (id, tenant_id, user_id, project_id, `key`, `value`, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NOW())',
        [randomUUID(), tenantId, userId, key, value],
      );
    }
  }
  return {
    async getTranscript({ chatId, tenantId, userId }) {
      const [rows] = await pool.execute(
        'SELECT value FROM preferences WHERE tenant_id = ? AND user_id = ? AND `key` = ? LIMIT 1',
        [tenantId, userId, `${TRANSCRIPT_PREFIX}${chatId}`],
      );
      try { return rows[0] ? JSON.parse(rows[0].value) : null; } catch { return null; }
    },
    async saveTranscript({ chatId, tenantId, transcript, userId }) {
      await upsert({ key: `${TRANSCRIPT_PREFIX}${chatId}`, tenantId, userId, value: JSON.stringify(transcript) });
    },
    async get({ chatId, tenantId, userId }) {
      const [rows] = await pool.execute(
        'SELECT value FROM preferences WHERE tenant_id = ? AND user_id = ? AND `key` = ? LIMIT 1',
        [tenantId, userId, `${KEY_PREFIX}${chatId}`],
      );
      const chat = rows[0] ? parse(rows[0].value) : null;
      return chat && !chat.deletedAt ? chat : null;
    },
    async list({ tenantId, userId }) {
      const [rows] = await pool.execute(
        'SELECT value FROM preferences WHERE tenant_id = ? AND user_id = ? AND `key` LIKE ?',
        [tenantId, userId, `${KEY_PREFIX}%`],
      );
      return rows.map((row) => parse(row.value)).filter((chat) => chat && !chat.deletedAt);
    },
    async save(chat) {
      const normalized = normalizeChat(chat);
      await upsert({ key: `${KEY_PREFIX}${normalized.id}`, tenantId: normalized.tenantId, userId: normalized.userId, value: JSON.stringify(normalized) });
      return normalized;
    },
    async remove({ chatId, tenantId, userId }) {
      const [result] = await pool.execute(
        'DELETE FROM preferences WHERE tenant_id = ? AND user_id = ? AND `key` IN (?, ?)',
        [tenantId, userId, `${KEY_PREFIX}${chatId}`, `${TRANSCRIPT_PREFIX}${chatId}`],
      );
      return result.affectedRows > 0;
    },
    // One statement sets just the title, and only while it is the one cut from the first message,
    // so it never writes over a rename or anything else saved since the reply.
    async setGeneratedTitle({ chatId, tenantId, title, userId }) {
      const [result] = await pool.execute(
        `UPDATE preferences SET value = JSON_SET(value, '$.title', ?, '$.titleSource', 'generated')
          WHERE tenant_id = ? AND user_id = ? AND \`key\` = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(value, '$.titleSource')), 'auto') = 'auto'`,
        [String(title).trim(), tenantId, userId, `${KEY_PREFIX}${chatId}`],
      );
      return result.affectedRows ? this.get({ chatId, tenantId, userId }) : null;
    },
  };
}
