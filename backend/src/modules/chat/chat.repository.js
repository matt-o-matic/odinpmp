// What Odin Chat reads and writes (docs/odin-chat/plan.md, Odin Chat): channels across a person's
// projects, posts that mention them, threads they are in, and direct messages (0103). These
// methods are spread into the projects repositories, as the channel methods are, so posts and
// files share the channel tables.
//
// A direct message is a discussion_posts row with target_type 'dm' and the conversation as both
// its target and its project id, so file records, uploads and attachments follow the channel
// patterns with the conversation in the project's place. Direct messages are not project work:
// nothing here writes to the project change log.
import { createHash, randomUUID } from 'node:crypto';

export const DM_TARGET_TYPE = 'dm';
export const MAX_DIRECT_MEMBERS = 8;
export const MENTIONS_PAGE_SIZE = 30;
export const THREADS_LIMIT = 50;

const iso = (value) => (value ? new Date(value).toISOString() : null);
const newestFirst = (left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id));
const oldestFirst = (left, right) => -newestFirst(left, right);
const beforeCursor = (post, cursor) => !cursor || post.createdAt < cursor.createdAt || (post.createdAt === cursor.createdAt && post.id < cursor.id);

/** One key per set of people: the same members always reach the same conversation. */
export function directMemberKey(memberIds) {
  return createHash('sha256').update([...new Set(memberIds.map(String))].sort().join(',')).digest('hex');
}

/** The text a post's body holds when it tags this member: `@[Name](user:<id>)`. */
export function userMentionMarker(userId) {
  return `](user:${userId})`;
}

const escapeLike = (value) => String(value).replace(/[\\%_]/g, (match) => `\\${match}`);

// Which posts a query reads: channel posts in channelIds and direct messages in conversationIds.
function placeFilter({ channelIds = [], conversationIds = [] }) {
  const channels = new Set(channelIds);
  const conversations = new Set(conversationIds);
  return (post) => (post.targetType === 'channel' && channels.has(post.targetId)) || (post.targetType === DM_TARGET_TYPE && conversations.has(post.targetId));
}

export function createInMemoryChatMethods({ authRepository = null, state }) {
  state.channels ??= [];
  state.discussionPosts ??= [];
  state.discussionPostFiles ??= [];
  state.channelReads ??= [];
  state.directConversations ??= [];
  state.directConversationMembers ??= [];
  const clone = (value) => structuredClone(value);
  const users = () => authRepository?.state?.users ?? [];
  const userOf = (userId) => users().find((user) => user.id === userId) ?? null;
  const authorName = (post) => (post.authorType === 'user' ? userOf(post.authorId)?.name ?? null : (state.channelGuests ?? []).find((guest) => guest.stakeholderId === post.authorId)?.name ?? null);
  const present = (post) => ({ ...clone(post), authorName: authorName(post) });
  // The channel methods' clock, so posts made either way keep one order.
  const stamp = () => {
    const now = Math.max(Date.now(), (state.lastChannelStamp ?? 0) + 1);
    state.lastChannelStamp = now;
    return new Date(now).toISOString();
  };
  const livePosts = (tenantId) => state.discussionPosts.filter((post) => post.tenantId === tenantId && !post.deletedAt);
  const membersOf = (conversationId) => state.directConversationMembers
    .filter((member) => member.conversationId === conversationId)
    .map((member) => ({ email: userOf(member.userId)?.email ?? '', lastReadAt: member.lastReadAt ?? null, name: userOf(member.userId)?.name ?? '', userId: member.userId }));
  const conversationOf = (conversation) => ({ createdAt: conversation.createdAt, createdBy: conversation.createdBy, id: conversation.id, members: membersOf(conversation.id), tenantId: conversation.tenantId });

  return {
    async listChannelsInProjects({ projectIds, tenantId }) {
      const ids = new Set(projectIds);
      return state.channels.filter((channel) => channel.tenantId === tenantId && ids.has(channel.projectId)).map(clone);
    },
    // Unread posts by others that tag this member, per channel.
    async countUnreadChannelMentions({ channelIds, tenantId, userId }) {
      const counts = new Map(channelIds.map((id) => [id, 0]));
      const marker = userMentionMarker(userId);
      for (const post of livePosts(tenantId)) {
        if (post.targetType !== 'channel' || !counts.has(post.targetId) || (post.authorType === 'user' && post.authorId === userId)) continue;
        if (!String(post.body ?? '').includes(marker)) continue;
        const read = state.channelReads.find((entry) => entry.channelId === post.targetId && entry.principalType === 'user' && entry.principalId === userId);
        if (!read || post.createdAt > read.lastReadAt) counts.set(post.targetId, counts.get(post.targetId) + 1);
      }
      return counts;
    },
    async listChannelReads({ channelIds, userId }) {
      const ids = new Set(channelIds);
      return new Map(state.channelReads.filter((entry) => ids.has(entry.channelId) && entry.principalType === 'user' && entry.principalId === userId).map((entry) => [entry.channelId, entry.lastReadAt]));
    },
    // Posts and replies that tag this member, newest first, before the cursor.
    async listMentionPosts({ before = null, channelIds = [], conversationIds = [], limit = MENTIONS_PAGE_SIZE, tenantId, userId }) {
      const inPlace = placeFilter({ channelIds, conversationIds });
      const marker = userMentionMarker(userId);
      const found = livePosts(tenantId)
        .filter((post) => inPlace(post) && !(post.authorType === 'user' && post.authorId === userId) && String(post.body ?? '').includes(marker) && beforeCursor(post, before))
        .sort(newestFirst);
      return { hasMore: found.length > limit, posts: found.slice(0, limit).map(present) };
    },
    // Threads with replies that this member started or replied in, by latest reply.
    async listThreadsForMember({ channelIds = [], conversationIds = [], limit = THREADS_LIMIT, tenantId, userId }) {
      const inPlace = placeFilter({ channelIds, conversationIds });
      const posts = livePosts(tenantId);
      const mine = (post) => post.authorType === 'user' && post.authorId === userId;
      const threads = [];
      for (const root of state.discussionPosts.filter((post) => post.tenantId === tenantId && !post.parentId && inPlace(post))) {
        const replies = posts.filter((post) => post.parentId === root.id).sort(oldestFirst);
        if (!replies.length || !(mine(root) || replies.some(mine))) continue;
        threads.push({ lastReplyAt: replies.at(-1).createdAt, replies: replies.map(present), root: present(root) });
      }
      return threads.sort((left, right) => right.lastReplyAt.localeCompare(left.lastReplyAt)).slice(0, limit);
    },

    // --- workspace members ---------------------------------------------------------------------
    async listWorkspaceMembers({ tenantId }) {
      return users()
        .filter((user) => user.memberships?.some((membership) => membership.tenantId === tenantId))
        .map((user) => ({ email: user.email ?? '', id: user.id, name: user.name ?? '', role: user.memberships.find((membership) => membership.tenantId === tenantId).role ?? 'user' }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    // --- direct messages -----------------------------------------------------------------------
    async createDirectConversation({ createdBy, memberIds, tenantId }) {
      const key = directMemberKey(memberIds);
      const existing = state.directConversations.find((entry) => entry.tenantId === tenantId && entry.memberKey === key);
      if (existing) return { conversation: conversationOf(existing), created: false };
      const at = stamp();
      const conversation = { createdAt: at, createdBy, id: randomUUID(), memberKey: key, tenantId };
      state.directConversations.push(conversation);
      for (const userId of new Set(memberIds)) state.directConversationMembers.push({ conversationId: conversation.id, joinedAt: at, lastReadAt: userId === createdBy ? at : null, tenantId, userId });
      return { conversation: conversationOf(conversation), created: true };
    },
    async getDirectConversation({ conversationId, tenantId }) {
      const conversation = state.directConversations.find((entry) => entry.id === conversationId && entry.tenantId === tenantId);
      return conversation ? conversationOf(conversation) : null;
    },
    // The member's conversations, each with its last post time and their unread and mention counts.
    async listDirectConversationsForUser({ tenantId, userId }) {
      const marker = userMentionMarker(userId);
      const ids = new Set(state.directConversationMembers.filter((member) => member.tenantId === tenantId && member.userId === userId).map((member) => member.conversationId));
      return state.directConversations.filter((conversation) => ids.has(conversation.id)).map((conversation) => {
        const lastReadAt = state.directConversationMembers.find((member) => member.conversationId === conversation.id && member.userId === userId)?.lastReadAt ?? null;
        const posts = livePosts(tenantId).filter((post) => post.targetType === DM_TARGET_TYPE && post.targetId === conversation.id);
        const unread = posts.filter((post) => !(post.authorType === 'user' && post.authorId === userId) && (!lastReadAt || post.createdAt > lastReadAt));
        return {
          ...conversationOf(conversation),
          lastPostAt: posts.map((post) => post.createdAt).sort().at(-1) ?? null,
          mentionCount: unread.filter((post) => String(post.body ?? '').includes(marker)).length,
          unreadCount: unread.length,
        };
      });
    },
    async markDirectConversationRead({ conversationId, userId }) {
      const member = state.directConversationMembers.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
      if (!member) return null;
      const at = stamp();
      member.lastReadAt = !member.lastReadAt || at > member.lastReadAt ? at : member.lastReadAt;
      return member.lastReadAt;
    },
    async createDirectPost({ fileIds = [], post }) {
      const stored = { deletedAt: null, deletedBy: null, editedAt: null, fileVersion: null, parentId: null, replyToId: null, ...clone(post), createdAt: stamp(), id: post.id ?? randomUUID(), projectId: post.targetId, targetType: DM_TARGET_TYPE };
      state.discussionPosts.push(stored);
      for (const fileId of new Set(fileIds)) state.discussionPostFiles.push({ fileId, postId: stored.id });
      return present(stored);
    },
    async updateDirectPost({ body, postId, tenantId }) {
      const post = state.discussionPosts.find((entry) => entry.id === postId && entry.tenantId === tenantId && entry.targetType === DM_TARGET_TYPE && !entry.deletedAt);
      if (!post) return null;
      Object.assign(post, { body, editedAt: stamp() });
      return present(post);
    },
    async deleteDirectPost({ postId, tenantId, userId }) {
      const post = state.discussionPosts.find((entry) => entry.id === postId && entry.tenantId === tenantId && entry.targetType === DM_TARGET_TYPE && !entry.deletedAt);
      if (!post) return null;
      Object.assign(post, { body: '', deletedAt: stamp(), deletedBy: userId });
      state.discussionPostFiles = state.discussionPostFiles.filter((link) => link.postId !== postId);
      return present(post);
    },
  };
}

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

function postFromRow(row, names) {
  return {
    authorId: row.author_id,
    authorName: names.get(`${row.author_type}:${row.author_id}`) ?? null,
    authorType: row.author_type,
    body: row.body_markdown ?? '',
    createdAt: iso(row.created_at),
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by ?? null,
    editedAt: iso(row.edited_at),
    fileVersion: row.file_version == null ? null : Number(row.file_version),
    id: row.id,
    parentId: row.parent_id ?? null,
    projectId: row.project_id,
    replyToId: row.reply_to_id ?? null,
    targetId: row.target_id,
    targetType: row.target_type,
    tenantId: row.tenant_id,
  };
}

// The SQL for posts in channelIds or conversationIds, with its values; null when there are none.
function placeSql(alias, { channelIds = [], conversationIds = [] }) {
  const parts = [];
  const values = [];
  if (channelIds.length) { parts.push(`(${alias}.target_type = 'channel' AND ${alias}.target_id IN (?))`); values.push(channelIds); }
  if (conversationIds.length) { parts.push(`(${alias}.target_type = '${DM_TARGET_TYPE}' AND ${alias}.target_id IN (?))`); values.push(conversationIds); }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, values } : null;
}

export function createMysqlChatMethods({ pool }) {
  // Names are read by id rather than joined: users and project_stakeholders may not share these
  // tables' collation.
  async function namesFor(executor, rows) {
    const names = new Map();
    const userIds = [...new Set(rows.filter((row) => row.author_type === 'user').map((row) => row.author_id))];
    const stakeholderIds = [...new Set(rows.filter((row) => row.author_type === 'stakeholder').map((row) => row.author_id))];
    if (userIds.length) {
      const [found] = await executor.query('SELECT id, name FROM users WHERE id IN (?)', [userIds]);
      for (const user of found) names.set(`user:${user.id}`, user.name);
    }
    if (stakeholderIds.length) {
      const [found] = await executor.query('SELECT id, name FROM project_stakeholders WHERE id IN (?)', [stakeholderIds]);
      for (const stakeholder of found) names.set(`stakeholder:${stakeholder.id}`, stakeholder.name);
    }
    return names;
  }

  async function presentPosts(executor, rows) {
    const names = await namesFor(executor, rows);
    return rows.map((row) => postFromRow(row, names));
  }

  async function readPost(executor, postId, tenantId) {
    const [rows] = await executor.execute('SELECT * FROM discussion_posts WHERE id = ? AND tenant_id = ? LIMIT 1', [postId, tenantId]);
    return rows[0] ?? null;
  }

  async function membersOf(executor, conversationIds) {
    const byConversation = new Map(conversationIds.map((id) => [id, []]));
    if (!conversationIds.length) return byConversation;
    const [rows] = await executor.query('SELECT conversation_id AS conversationId, user_id AS userId, last_read_at AS lastReadAt FROM direct_conversation_members WHERE conversation_id IN (?) ORDER BY joined_at, user_id', [conversationIds]);
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const people = new Map();
    if (userIds.length) {
      const [found] = await executor.query('SELECT id, name, email FROM users WHERE id IN (?)', [userIds]);
      for (const user of found) people.set(user.id, user);
    }
    for (const row of rows) byConversation.get(row.conversationId)?.push({ email: people.get(row.userId)?.email ?? '', lastReadAt: iso(row.lastReadAt), name: people.get(row.userId)?.name ?? '', userId: row.userId });
    return byConversation;
  }

  async function readConversation(executor, conversationId, tenantId) {
    const [rows] = await executor.execute('SELECT id, tenant_id AS tenantId, created_by AS createdBy, created_at AS createdAt FROM direct_conversations WHERE id = ? AND tenant_id = ? LIMIT 1', [conversationId, tenantId]);
    if (!rows[0]) return null;
    return { createdAt: iso(rows[0].createdAt), createdBy: rows[0].createdBy, id: rows[0].id, members: (await membersOf(executor, [rows[0].id])).get(rows[0].id), tenantId: rows[0].tenantId };
  }

  return {
    async listChannelsInProjects({ projectIds, tenantId }) {
      if (!projectIds.length) return [];
      const [rows] = await pool.query('SELECT * FROM project_channels WHERE tenant_id = ? AND project_id IN (?)', [tenantId, projectIds]);
      return rows.map((row) => ({
        archivedAt: iso(row.archived_at),
        archivedBy: row.archived_by ?? null,
        createdAt: iso(row.created_at),
        createdBy: row.created_by,
        description: row.description ?? '',
        id: row.id,
        isGeneral: Number(row.is_general) === 1,
        name: row.name,
        projectId: row.project_id,
        tenantId: row.tenant_id,
        updatedAt: iso(row.updated_at),
      }));
    },
    async countUnreadChannelMentions({ channelIds, tenantId, userId }) {
      const counts = new Map(channelIds.map((id) => [id, 0]));
      if (!channelIds.length) return counts;
      const [rows] = await pool.query(
        `SELECT p.target_id AS channelId, COUNT(*) AS n
         FROM discussion_posts p
         LEFT JOIN channel_reads r ON r.channel_id = p.target_id AND r.principal_type = 'user' AND r.principal_id = ?
         WHERE p.tenant_id = ? AND p.target_type = 'channel' AND p.target_id IN (?) AND p.deleted_at IS NULL
           AND NOT (p.author_type = 'user' AND p.author_id = ?)
           AND p.body_markdown LIKE ?
           AND (r.last_read_at IS NULL OR p.created_at > r.last_read_at)
         GROUP BY p.target_id`,
        [userId, tenantId, channelIds, userId, `%${escapeLike(userMentionMarker(userId))}%`],
      );
      for (const row of rows) counts.set(row.channelId, Number(row.n));
      return counts;
    },
    async listChannelReads({ channelIds, userId }) {
      if (!channelIds.length) return new Map();
      const [rows] = await pool.query("SELECT channel_id AS channelId, last_read_at AS at FROM channel_reads WHERE principal_type = 'user' AND principal_id = ? AND channel_id IN (?)", [userId, channelIds]);
      return new Map(rows.map((row) => [row.channelId, iso(row.at)]));
    },
    async listMentionPosts({ before = null, channelIds = [], conversationIds = [], limit = MENTIONS_PAGE_SIZE, tenantId, userId }) {
      const place = placeSql('p', { channelIds, conversationIds });
      if (!place) return { hasMore: false, posts: [] };
      const bounded = Math.max(1, Math.min(100, Number(limit) || MENTIONS_PAGE_SIZE));
      const cursorSql = before ? ' AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))' : '';
      const cursorValues = before ? [new Date(before.createdAt), new Date(before.createdAt), before.id] : [];
      const [rows] = await pool.query(
        `SELECT p.* FROM discussion_posts p
         WHERE p.tenant_id = ? AND ${place.sql} AND p.deleted_at IS NULL
           AND NOT (p.author_type = 'user' AND p.author_id = ?)
           AND p.body_markdown LIKE ?${cursorSql}
         ORDER BY p.created_at DESC, p.id DESC LIMIT ${bounded + 1}`,
        [tenantId, ...place.values, userId, `%${escapeLike(userMentionMarker(userId))}%`, ...cursorValues],
      );
      return { hasMore: rows.length > bounded, posts: await presentPosts(pool, rows.slice(0, bounded)) };
    },
    async listThreadsForMember({ channelIds = [], conversationIds = [], limit = THREADS_LIMIT, tenantId, userId }) {
      const place = placeSql('r', { channelIds, conversationIds });
      if (!place) return [];
      const bounded = Math.max(1, Math.min(200, Number(limit) || THREADS_LIMIT));
      const [roots] = await pool.query(
        `SELECT r.*, MAX(c.created_at) AS last_reply_at
         FROM discussion_posts r
         INNER JOIN discussion_posts c ON c.parent_id = r.id AND c.tenant_id = r.tenant_id AND c.deleted_at IS NULL
         WHERE r.tenant_id = ? AND r.parent_id IS NULL AND ${place.sql}
           AND ((r.author_type = 'user' AND r.author_id = ?)
             OR EXISTS (SELECT 1 FROM discussion_posts m WHERE m.parent_id = r.id AND m.tenant_id = r.tenant_id AND m.author_type = 'user' AND m.author_id = ? AND m.deleted_at IS NULL))
         GROUP BY r.id
         ORDER BY last_reply_at DESC, r.id DESC
         LIMIT ${bounded}`,
        [tenantId, ...place.values, userId, userId],
      );
      if (!roots.length) return [];
      const [replies] = await pool.query('SELECT * FROM discussion_posts WHERE tenant_id = ? AND parent_id IN (?) AND deleted_at IS NULL ORDER BY created_at ASC, id ASC', [tenantId, roots.map((row) => row.id)]);
      const presented = await presentPosts(pool, [...roots, ...replies]);
      const rootPosts = presented.slice(0, roots.length);
      const replyPosts = presented.slice(roots.length);
      return rootPosts.map((root, index) => ({ lastReplyAt: iso(roots[index].last_reply_at), replies: replyPosts.filter((reply) => reply.parentId === root.id), root }));
    },

    async listWorkspaceMembers({ tenantId }) {
      const [rows] = await pool.execute('SELECT u.id, u.name, u.email, ut.role FROM user_tenant ut INNER JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = ? ORDER BY u.name ASC', [tenantId]);
      return rows.map((row) => ({ email: row.email ?? '', id: row.id, name: row.name ?? '', role: row.role ?? 'user' }));
    },

    async createDirectConversation({ createdBy, memberIds, tenantId }) {
      const key = directMemberKey(memberIds);
      const find = async () => {
        const [rows] = await pool.execute('SELECT id FROM direct_conversations WHERE tenant_id = ? AND member_key = ? LIMIT 1', [tenantId, key]);
        return rows[0]?.id ?? null;
      };
      const existing = await find();
      if (existing) return { conversation: await readConversation(pool, existing, tenantId), created: false };
      const id = randomUUID();
      try {
        await withTransaction(pool, async (connection) => {
          await connection.execute('INSERT INTO direct_conversations (id, tenant_id, member_key, created_by, created_at) VALUES (?, ?, ?, ?, NOW(3))', [id, tenantId, key, createdBy]);
          for (const userId of new Set(memberIds)) {
            await connection.execute(
              `INSERT INTO direct_conversation_members (conversation_id, user_id, tenant_id, joined_at, last_read_at) VALUES (?, ?, ?, NOW(3), ${userId === createdBy ? 'NOW(3)' : 'NULL'})`,
              [id, userId, tenantId],
            );
          }
        });
      } catch (error) {
        // The same people started it at the same moment; theirs is the one.
        if (!isDuplicate(error)) throw error;
        return { conversation: await readConversation(pool, await find(), tenantId), created: false };
      }
      return { conversation: await readConversation(pool, id, tenantId), created: true };
    },
    async getDirectConversation({ conversationId, tenantId }) {
      return readConversation(pool, conversationId, tenantId);
    },
    async listDirectConversationsForUser({ tenantId, userId }) {
      const marker = `%${escapeLike(userMentionMarker(userId))}%`;
      const [rows] = await pool.query(
        `SELECT c.id, c.created_by AS createdBy, c.created_at AS createdAt,
           (SELECT MAX(p.created_at) FROM discussion_posts p WHERE p.tenant_id = c.tenant_id AND p.target_type = '${DM_TARGET_TYPE}' AND p.target_id = c.id AND p.deleted_at IS NULL) AS lastPostAt,
           (SELECT COUNT(*) FROM discussion_posts p WHERE p.tenant_id = c.tenant_id AND p.target_type = '${DM_TARGET_TYPE}' AND p.target_id = c.id AND p.deleted_at IS NULL
              AND NOT (p.author_type = 'user' AND p.author_id = ?) AND (me.last_read_at IS NULL OR p.created_at > me.last_read_at)) AS unreadCount,
           (SELECT COUNT(*) FROM discussion_posts p WHERE p.tenant_id = c.tenant_id AND p.target_type = '${DM_TARGET_TYPE}' AND p.target_id = c.id AND p.deleted_at IS NULL
              AND NOT (p.author_type = 'user' AND p.author_id = ?) AND (me.last_read_at IS NULL OR p.created_at > me.last_read_at) AND p.body_markdown LIKE ?) AS mentionCount
         FROM direct_conversations c
         INNER JOIN direct_conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
         WHERE c.tenant_id = ?`,
        [userId, userId, marker, userId, tenantId],
      );
      const members = await membersOf(pool, rows.map((row) => row.id));
      return rows.map((row) => ({
        createdAt: iso(row.createdAt),
        createdBy: row.createdBy,
        id: row.id,
        lastPostAt: iso(row.lastPostAt),
        members: members.get(row.id) ?? [],
        mentionCount: Number(row.mentionCount ?? 0),
        tenantId,
        unreadCount: Number(row.unreadCount ?? 0),
      }));
    },
    async markDirectConversationRead({ conversationId, userId }) {
      const [result] = await pool.execute('UPDATE direct_conversation_members SET last_read_at = GREATEST(COALESCE(last_read_at, NOW(3)), NOW(3)) WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
      if (!result.affectedRows) return null;
      const [rows] = await pool.execute('SELECT last_read_at AS at FROM direct_conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
      return iso(rows[0]?.at);
    },
    async createDirectPost({ fileIds = [], post }) {
      const id = post.id ?? randomUUID();
      await withTransaction(pool, async (connection) => {
        await connection.execute(
          `INSERT INTO discussion_posts (id, tenant_id, project_id, target_type, target_id, parent_id, reply_to_id, file_version, author_type, author_id, body_markdown, created_at)
           VALUES (?, ?, ?, '${DM_TARGET_TYPE}', ?, ?, ?, NULL, ?, ?, ?, NOW(3))`,
          [id, post.tenantId, post.targetId, post.targetId, post.parentId ?? null, post.replyToId ?? null, post.authorType, post.authorId, post.body],
        );
        for (const fileId of new Set(fileIds)) {
          await connection.execute('INSERT INTO discussion_post_files (post_id, file_id) VALUES (?, ?)', [id, fileId]);
        }
      });
      return (await presentPosts(pool, [await readPost(pool, id, post.tenantId)]))[0];
    },
    async updateDirectPost({ body, postId, tenantId }) {
      const [result] = await pool.execute(`UPDATE discussion_posts SET body_markdown = ?, edited_at = NOW(3) WHERE id = ? AND tenant_id = ? AND target_type = '${DM_TARGET_TYPE}' AND deleted_at IS NULL`, [body, postId, tenantId]);
      if (!result.affectedRows) return null;
      return (await presentPosts(pool, [await readPost(pool, postId, tenantId)]))[0];
    },
    async deleteDirectPost({ postId, tenantId, userId }) {
      return withTransaction(pool, async (connection) => {
        const [result] = await connection.execute(`UPDATE discussion_posts SET body_markdown = '', deleted_at = NOW(3), deleted_by = ? WHERE id = ? AND tenant_id = ? AND target_type = '${DM_TARGET_TYPE}' AND deleted_at IS NULL`, [userId, postId, tenantId]);
        if (!result.affectedRows) return null;
        await connection.execute('DELETE FROM discussion_post_files WHERE post_id = ?', [postId]);
        return (await presentPosts(connection, [await readPost(connection, postId, tenantId)]))[0];
      });
    },
  };
}
