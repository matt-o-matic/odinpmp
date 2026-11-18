// Channels, discussion posts (channel posts and file comments), unread markers and library
// folders (docs/engagements/plan.md, Channels and conversation, Files). These methods are spread
// into the projects repositories, as the engagement methods are, so channel files share the
// project's file records and change log.
import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { appendMysqlProjectChanges } from '../changes/project-change-log.js';

export const GENERAL_CHANNEL_NAME = 'General';
/** An editing marker older than this is gone (docs/engagements/plan.md, Library). */
export const EDITING_MARKER_MS = 24 * 60 * 60 * 1000;

const sameName = (left, right) => String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
const iso = (value) => (value ? new Date(value).toISOString() : null);

export function channelNameTaken() {
  return new HttpError(409, 'A channel with this name is already here.', { details: { code: 'channel_name_taken' } });
}

export function folderNameTaken() {
  return new HttpError(409, 'A folder with this name is already here.', { details: { code: 'folder_name_taken' } });
}

export function folderNotEmpty() {
  return new HttpError(409, 'Only an empty folder can be deleted. Move or delete what is in it first.', { details: { code: 'folder_not_empty' } });
}

/** The change log entries. They carry no message text, as live events carry none. */
export function channelChange({ action, actorId, channel }) {
  return { action, actorId, detail: { channelId: channel.id, name: channel.name }, entityId: channel.id, entityType: 'channel', itemId: null, projectId: channel.projectId, tenantId: channel.tenantId };
}

export function postChange({ action, actorId, post }) {
  return {
    action,
    actorId,
    detail: { parentId: post.parentId ?? null, targetId: post.targetId, targetType: post.targetType, ...(post.fileVersion ? { fileVersion: post.fileVersion } : {}) },
    entityId: post.id,
    entityType: 'post',
    itemId: null,
    projectId: post.projectId,
    tenantId: post.tenantId,
  };
}

/** A guest invited to or removed from a channel. No names or addresses go in the log. */
export function guestChange({ action, actorId, channel, stakeholderId }) {
  return { action, actorId, detail: { channelId: channel.id, stakeholderId }, entityId: stakeholderId, entityType: 'channel_guest', itemId: null, projectId: channel.projectId, tenantId: channel.tenantId };
}

export function folderChange({ action, actorId, folder }) {
  return { action, actorId, detail: { channelId: folder.channelId, name: folder.name, parentId: folder.parentId ?? null }, entityId: folder.id, entityType: 'folder', itemId: null, projectId: folder.projectId, tenantId: folder.tenantId };
}

/** The editing marker as readers see it: null once it is 24 hours old. */
export function editingMarker({ editingBy, editingName = null, editingSince }, now = Date.now()) {
  if (!editingBy || !editingSince) return null;
  const since = new Date(editingSince);
  if (Number.isNaN(since.valueOf()) || now - since.getTime() >= EDITING_MARKER_MS) return null;
  return { name: editingName ?? null, since: since.toISOString(), userId: editingBy };
}

// Newest first, as pages are read: by creation time, then id.
const newestFirst = (left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id));
const oldestFirst = (left, right) => -newestFirst(left, right);
const beforeCursor = (post, cursor) => !cursor || post.createdAt < cursor.createdAt || (post.createdAt === cursor.createdAt && post.id < cursor.id);

export function createInMemoryChannelMethods({ authRepository = null, changeLog, state }) {
  state.channels ??= [];
  state.channelGuests ??= [];
  state.discussionPosts ??= [];
  state.discussionPostFiles ??= [];
  state.discussionPostReactions ??= [];
  state.channelReads ??= [];
  state.fileFolders ??= [];
  const clone = (value) => structuredClone(value);
  const userName = (userId) => authRepository?.state?.users?.find((user) => user.id === userId)?.name ?? null;
  const stamp = () => {
    // Strictly increasing, so two posts in the same millisecond still order.
    const now = Math.max(Date.now(), (state.lastChannelStamp ?? 0) + 1);
    state.lastChannelStamp = now;
    return new Date(now).toISOString();
  };
  const findChannel = (channelId, projectId, tenantId) => state.channels.find((entry) => entry.id === channelId && entry.tenantId === tenantId && (!projectId || entry.projectId === projectId)) ?? null;
  const authorName = (post) => (post.authorType === 'user' ? userName(post.authorId) : state.channelGuests.find((guest) => guest.stakeholderId === post.authorId)?.name ?? null);
  const present = (post) => ({ ...clone(post), authorName: authorName(post) });

  return {
    async ensureGeneralChannel({ projectId, tenantId, userId }) {
      const existing = state.channels.find((entry) => entry.projectId === projectId && entry.tenantId === tenantId && entry.isGeneral);
      if (existing) return clone(existing);
      const at = stamp();
      const channel = { archivedAt: null, archivedBy: null, createdAt: at, createdBy: userId, description: '', id: randomUUID(), isGeneral: true, name: GENERAL_CHANNEL_NAME, odinEnabled: true, projectId, tenantId, updatedAt: at };
      state.channels.push(channel);
      return clone(channel);
    },
    async listChannels({ projectId, tenantId }) {
      return state.channels.filter((entry) => entry.projectId === projectId && entry.tenantId === tenantId).map(clone);
    },
    async getChannel({ channelId, projectId = null, tenantId }) {
      const channel = findChannel(channelId, projectId, tenantId);
      return channel ? clone(channel) : null;
    },
    async createChannel({ description = '', name, projectId, tenantId, user }) {
      if (state.channels.some((entry) => entry.projectId === projectId && entry.tenantId === tenantId && sameName(entry.name, name))) throw channelNameTaken();
      const at = stamp();
      const channel = { archivedAt: null, archivedBy: null, createdAt: at, createdBy: user.id, description, id: randomUUID(), isGeneral: false, name, odinEnabled: true, projectId, tenantId, updatedAt: at };
      state.channels.push(channel);
      changeLog.append([channelChange({ action: 'create', actorId: user.id, channel })]);
      return clone(channel);
    },
    async updateChannel({ channelId, changes, projectId, tenantId, user }) {
      const channel = findChannel(channelId, projectId, tenantId);
      if (!channel) return null;
      if (changes.name !== undefined && !sameName(changes.name, channel.name) && state.channels.some((entry) => entry.id !== channel.id && entry.projectId === projectId && entry.tenantId === tenantId && sameName(entry.name, changes.name))) throw channelNameTaken();
      Object.assign(channel, changes, { updatedAt: stamp() });
      changeLog.append([channelChange({ action: 'update', actorId: user.id, channel })]);
      return clone(channel);
    },
    async setChannelArchived({ archived, channelId, projectId, tenantId, user }) {
      const channel = findChannel(channelId, projectId, tenantId);
      if (!channel) return null;
      Object.assign(channel, archived ? { archivedAt: stamp(), archivedBy: user.id } : { archivedAt: null, archivedBy: null }, { updatedAt: stamp() });
      changeLog.append([channelChange({ action: archived ? 'archive' : 'restore', actorId: user.id, channel })]);
      return clone(channel);
    },
    // Guests invited to a channel and not removed.
    async listChannelGuests({ channelId, tenantId }) {
      return state.channelGuests.filter((guest) => guest.channelId === channelId && guest.tenantId === tenantId && !guest.removedAt).map(clone);
    },
    // Invites a stakeholder of the channel's project, or brings back one who was removed.
    // In memory the row keeps a copy of the name and address, which MySQL reads from
    // project_stakeholders. `added` is false when they were in the channel already.
    async addChannelGuest({ channel, invitedBy, stakeholder }) {
      const existing = state.channelGuests.find((guest) => guest.channelId === channel.id && guest.stakeholderId === stakeholder.id);
      if (existing && !existing.removedAt) return { added: false, guest: clone(existing) };
      const at = stamp();
      const row = existing ?? { channelId: channel.id, stakeholderId: stakeholder.id };
      Object.assign(row, { email: stakeholder.email ?? '', invitedAt: at, invitedBy, name: stakeholder.name ?? '', projectId: channel.projectId, removedAt: null, removedBy: null, tenantId: channel.tenantId });
      if (!existing) state.channelGuests.push(row);
      changeLog.append([guestChange({ action: 'invite', actorId: invitedBy, channel, stakeholderId: stakeholder.id })]);
      return { added: true, guest: clone(row) };
    },
    async removeChannelGuest({ channel, removedBy, stakeholderId }) {
      const row = state.channelGuests.find((guest) => guest.channelId === channel.id && guest.stakeholderId === stakeholderId && !guest.removedAt);
      if (!row) return false;
      Object.assign(row, { removedAt: stamp(), removedBy });
      changeLog.append([guestChange({ action: 'remove', actorId: removedBy, channel, stakeholderId })]);
      return true;
    },
    // The channels these stakeholders are guests in now, with each channel's project.
    async listGuestMemberships({ stakeholderIds, tenantId }) {
      const ids = new Set(stakeholderIds);
      return state.channelGuests
        .filter((guest) => guest.tenantId === tenantId && ids.has(guest.stakeholderId) && !guest.removedAt)
        .map((guest) => ({ channelId: guest.channelId, invitedAt: guest.invitedAt, projectId: state.channels.find((channel) => channel.id === guest.channelId)?.projectId ?? null, stakeholderId: guest.stakeholderId }))
        .filter((membership) => membership.projectId);
    },
    // Every current guest of the project's channels.
    async listProjectChannelGuests({ projectId, tenantId }) {
      const channelIds = new Set(state.channels.filter((channel) => channel.projectId === projectId && channel.tenantId === tenantId).map((channel) => channel.id));
      return state.channelGuests.filter((guest) => channelIds.has(guest.channelId) && !guest.removedAt).map(clone);
    },

    // --- posts and file comments ---------------------------------------------------------
    // A page of top-level posts on a target, newest first, before the cursor; each with every
    // reply, oldest first.
    async listPosts({ before = null, limit = 30, targetId, targetType, tenantId }) {
      const onTarget = state.discussionPosts.filter((post) => post.tenantId === tenantId && post.targetType === targetType && post.targetId === targetId);
      const roots = onTarget.filter((post) => !post.parentId && beforeCursor(post, before)).sort(newestFirst);
      const page = roots.slice(0, limit);
      const ids = new Set(page.map((post) => post.id));
      const replies = onTarget.filter((post) => ids.has(post.parentId)).sort(oldestFirst);
      return { hasMore: roots.length > limit, posts: page.map(present), replies: replies.map(present) };
    },
    // Every reply to one post, oldest first (Odin reads a whole thread).
    async listThreadReplies({ parentId, tenantId }) {
      return state.discussionPosts.filter((post) => post.tenantId === tenantId && post.parentId === parentId).sort(oldestFirst).map(present);
    },
    async getPost({ postId, projectId = null, tenantId }) {
      const post = state.discussionPosts.find((entry) => entry.id === postId && entry.tenantId === tenantId && (!projectId || entry.projectId === projectId));
      return post ? present(post) : null;
    },
    async createPost({ fileIds = [], post }) {
      const stored = { deletedAt: null, deletedBy: null, editedAt: null, fileVersion: null, parentId: null, replyToId: null, ...clone(post), createdAt: stamp(), id: post.id ?? randomUUID() };
      state.discussionPosts.push(stored);
      for (const fileId of new Set(fileIds)) state.discussionPostFiles.push({ fileId, postId: stored.id });
      changeLog.append([postChange({ action: 'create', actorId: stored.authorId, post: stored })]);
      return present(stored);
    },
    async updatePost({ body, postId, tenantId, user }) {
      const post = state.discussionPosts.find((entry) => entry.id === postId && entry.tenantId === tenantId);
      if (!post) return null;
      Object.assign(post, { body, editedAt: stamp() });
      changeLog.append([postChange({ action: 'update', actorId: user.id, post })]);
      return present(post);
    },
    // The post keeps its place, its text and attachments go.
    async deletePost({ postId, tenantId, user }) {
      const post = state.discussionPosts.find((entry) => entry.id === postId && entry.tenantId === tenantId);
      if (!post) return null;
      Object.assign(post, { body: '', deletedAt: stamp(), deletedBy: user.id });
      state.discussionPostFiles = state.discussionPostFiles.filter((link) => link.postId !== postId);
      changeLog.append([postChange({ action: 'delete', actorId: user.id, post })]);
      return present(post);
    },
    async listPostFileIds({ postIds }) {
      const ids = new Set(postIds);
      return state.discussionPostFiles.filter((link) => ids.has(link.postId)).map(clone);
    },
    // Reactions (0106_post_reactions): one per post, person and emoji, oldest first.
    async listPostReactions({ postIds, tenantId }) {
      const ids = new Set(postIds);
      return state.discussionPostReactions
        .filter((reaction) => ids.has(reaction.postId) && reaction.tenantId === tenantId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((reaction) => ({ ...clone(reaction), name: authorName({ authorId: reaction.principalId, authorType: reaction.principalType }) }));
    },
    // Adds or removes one person's emoji on a post. True when that changed anything.
    async setPostReaction({ emoji, postId, principal, reacted, tenantId }) {
      const same = (reaction) => reaction.postId === postId && reaction.tenantId === tenantId && reaction.principalType === principal.type && reaction.principalId === principal.id && reaction.emoji === emoji;
      const found = state.discussionPostReactions.some(same);
      if (reacted && !found) state.discussionPostReactions.push({ createdAt: stamp(), emoji, postId, principalId: principal.id, principalType: principal.type, tenantId });
      if (!reacted && found) state.discussionPostReactions = state.discussionPostReactions.filter((reaction) => !same(reaction));
      return reacted !== found;
    },
    // Who has replied in a thread, for reply notifications (modules/notifications).
    async listThreadAuthors({ parentId, tenantId }) {
      const seen = new Map();
      for (const post of state.discussionPosts) {
        if (post.parentId === parentId && post.tenantId === tenantId && !post.deletedAt) seen.set(`${post.authorType}:${post.authorId}`, { authorId: post.authorId, authorType: post.authorType });
      }
      return [...seen.values()];
    },
    // Comments go with their file.
    async deleteFileDiscussion({ fileIds }) {
      const ids = new Set(fileIds);
      state.discussionPosts = state.discussionPosts.filter((post) => !(post.targetType === 'file' && ids.has(post.targetId)));
      state.discussionPostFiles = state.discussionPostFiles.filter((link) => !ids.has(link.fileId));
    },

    // --- unread ----------------------------------------------------------------------------
    // Posts by anyone else after the person last read each channel.
    async countUnread({ channelIds, principalId, principalType = 'user', tenantId }) {
      const counts = new Map(channelIds.map((id) => [id, 0]));
      for (const post of state.discussionPosts) {
        if (post.tenantId !== tenantId || post.targetType !== 'channel' || !counts.has(post.targetId) || post.deletedAt) continue;
        if (post.authorType === principalType && post.authorId === principalId) continue;
        const read = state.channelReads.find((entry) => entry.channelId === post.targetId && entry.principalType === principalType && entry.principalId === principalId);
        if (!read || post.createdAt > read.lastReadAt) counts.set(post.targetId, counts.get(post.targetId) + 1);
      }
      return counts;
    },
    // Unread posts in each project's open channels.
    async countUnreadByProject({ principalId, principalType = 'user', projectIds, tenantId }) {
      const channelsByProject = new Map(projectIds.map((id) => [id, []]));
      for (const channel of state.channels) {
        if (channel.tenantId === tenantId && !channel.archivedAt && channelsByProject.has(channel.projectId)) channelsByProject.get(channel.projectId).push(channel.id);
      }
      const counts = await this.countUnread({ channelIds: [...channelsByProject.values()].flat(), principalId, principalType, tenantId });
      return new Map([...channelsByProject].map(([projectId, ids]) => [projectId, ids.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0)]));
    },
    async markChannelRead({ channelId, principalId, principalType = 'user' }) {
      const at = stamp();
      const read = state.channelReads.find((entry) => entry.channelId === channelId && entry.principalType === principalType && entry.principalId === principalId);
      if (read) read.lastReadAt = at > read.lastReadAt ? at : read.lastReadAt;
      else state.channelReads.push({ channelId, lastReadAt: at, principalId, principalType });
      return at;
    },

    // --- folders ---------------------------------------------------------------------------
    async listFolders({ channelId = null, projectId, tenantId }) {
      return state.fileFolders.filter((folder) => folder.projectId === projectId && folder.tenantId === tenantId && (!channelId || folder.channelId === channelId)).map(clone);
    },
    async getFolder({ folderId, projectId = null, tenantId }) {
      const folder = state.fileFolders.find((entry) => entry.id === folderId && entry.tenantId === tenantId && (!projectId || entry.projectId === projectId));
      return folder ? clone(folder) : null;
    },
    async createFolder({ channelId, name, parentId = null, projectId, tenantId, user }) {
      if (state.fileFolders.some((entry) => entry.channelId === channelId && (entry.parentId ?? null) === (parentId ?? null) && sameName(entry.name, name))) throw folderNameTaken();
      const folder = { channelId, createdAt: stamp(), createdBy: user.id, id: randomUUID(), name, parentId: parentId ?? null, projectId, tenantId };
      state.fileFolders.push(folder);
      changeLog.append([folderChange({ action: 'create', actorId: user.id, folder })]);
      return clone(folder);
    },
    async updateFolder({ changes, folderId, tenantId, user }) {
      const folder = state.fileFolders.find((entry) => entry.id === folderId && entry.tenantId === tenantId);
      if (!folder) return null;
      const name = changes.name ?? folder.name;
      const parentId = changes.parentId === undefined ? folder.parentId : changes.parentId;
      if (state.fileFolders.some((entry) => entry.id !== folder.id && entry.channelId === folder.channelId && (entry.parentId ?? null) === (parentId ?? null) && sameName(entry.name, name))) throw folderNameTaken();
      Object.assign(folder, { name, parentId: parentId ?? null });
      changeLog.append([folderChange({ action: changes.parentId === undefined ? 'rename' : 'move', actorId: user.id, folder })]);
      return clone(folder);
    },
    async deleteFolder({ folderId, tenantId, user }) {
      const folder = state.fileFolders.find((entry) => entry.id === folderId && entry.tenantId === tenantId);
      if (!folder) return null;
      if (state.fileFolders.some((entry) => entry.parentId === folderId) || state.files.some((file) => file.folderId === folderId)) throw folderNotEmpty();
      state.fileFolders = state.fileFolders.filter((entry) => entry.id !== folderId);
      changeLog.append([folderChange({ action: 'delete', actorId: user.id, folder })]);
      return clone(folder);
    },

    // --- the editing marker ------------------------------------------------------------------
    async setFileEditing({ fileId, tenantId, userId }) {
      const file = state.files.find((entry) => entry.id === fileId && entry.tenantId === tenantId);
      if (!file) return null;
      Object.assign(file, { editingBy: userId, editingSince: stamp() });
      return editingMarker({ editingBy: file.editingBy, editingName: userName(userId), editingSince: file.editingSince });
    },
    // Clears the marker; with onlyUserId, only that person's.
    async clearFileEditing({ fileId, onlyUserId = null, tenantId }) {
      const file = state.files.find((entry) => entry.id === fileId && entry.tenantId === tenantId);
      if (!file) return false;
      if (onlyUserId && file.editingBy !== onlyUserId) return false;
      Object.assign(file, { editingBy: null, editingSince: null });
      return true;
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
const placeholders = (values) => values.map(() => '?').join(', ');

function channelFromRow(row) {
  return {
    archivedAt: iso(row.archived_at),
    archivedBy: row.archived_by ?? null,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    description: row.description ?? '',
    id: row.id,
    isGeneral: Number(row.is_general) === 1,
    name: row.name,
    // "Let Odin answer when tagged" (0105_channel_odin); on before that migration runs.
    odinEnabled: row.odin_enabled == null ? true : Number(row.odin_enabled) === 1,
    projectId: row.project_id,
    tenantId: row.tenant_id,
    updatedAt: iso(row.updated_at),
  };
}

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

function folderFromRow(row) {
  return { channelId: row.channel_id, createdAt: iso(row.created_at), createdBy: row.created_by, id: row.id, name: row.name, parentId: row.parent_id ?? null, projectId: row.project_id, tenantId: row.tenant_id };
}

export function createMysqlChannelMethods({ pool }) {
  // Names are read by id rather than joined: users and project_stakeholders may not share
  // these tables' collation.
  async function authorNames(executor, rows) {
    const names = new Map();
    const userIds = [...new Set(rows.filter((row) => row.author_type === 'user').map((row) => row.author_id))];
    const stakeholderIds = [...new Set(rows.filter((row) => row.author_type === 'stakeholder').map((row) => row.author_id))];
    if (userIds.length) {
      const [users] = await executor.query('SELECT id, name FROM users WHERE id IN (?)', [userIds]);
      for (const user of users) names.set(`user:${user.id}`, user.name);
    }
    if (stakeholderIds.length) {
      const [stakeholders] = await executor.query('SELECT id, name FROM project_stakeholders WHERE id IN (?)', [stakeholderIds]);
      for (const stakeholder of stakeholders) names.set(`stakeholder:${stakeholder.id}`, stakeholder.name);
    }
    return names;
  }

  async function presentPosts(executor, rows) {
    const names = await authorNames(executor, rows);
    return rows.map((row) => postFromRow(row, names));
  }

  async function readPost(executor, postId, tenantId, { lock = false } = {}) {
    const [rows] = await executor.execute(`SELECT * FROM discussion_posts WHERE id = ? AND tenant_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [postId, tenantId]);
    return rows[0] ?? null;
  }

  async function readChannel(executor, channelId, tenantId) {
    const [rows] = await executor.execute('SELECT * FROM project_channels WHERE id = ? AND tenant_id = ? LIMIT 1', [channelId, tenantId]);
    return rows[0] ? channelFromRow(rows[0]) : null;
  }

  async function readFolder(executor, folderId, tenantId, { lock = false } = {}) {
    const [rows] = await executor.execute(`SELECT * FROM file_folders WHERE id = ? AND tenant_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [folderId, tenantId]);
    return rows[0] ? folderFromRow(rows[0]) : null;
  }

  // Names inside a project are taken one writer at a time, as file names are.
  async function lockProject(connection, projectId, tenantId) {
    await connection.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [projectId, tenantId]);
  }

  async function assertFolderNameFree(connection, { channelId, exceptId = '', name, parentId }) {
    const [rows] = await connection.execute(
      'SELECT id, name FROM file_folders WHERE channel_id = ? AND parent_id <=> ? AND id <> ?',
      [channelId, parentId ?? null, exceptId],
    );
    if (rows.some((row) => sameName(row.name, name))) throw folderNameTaken();
  }

  return {
    async ensureGeneralChannel({ projectId, tenantId, userId }) {
      const [found] = await pool.execute('SELECT * FROM project_channels WHERE tenant_id = ? AND project_id = ? AND is_general = 1 LIMIT 1', [tenantId, projectId]);
      if (found[0]) return channelFromRow(found[0]);
      try {
        await pool.execute(
          `INSERT INTO project_channels (id, tenant_id, project_id, name, description, is_general, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 1, ?, NOW(3), NOW(3))`,
          [randomUUID(), tenantId, projectId, GENERAL_CHANNEL_NAME, userId],
        );
      } catch (error) {
        // Someone else made it first; theirs is the one.
        if (!isDuplicate(error)) throw error;
      }
      const [rows] = await pool.execute('SELECT * FROM project_channels WHERE tenant_id = ? AND project_id = ? AND is_general = 1 LIMIT 1', [tenantId, projectId]);
      return rows[0] ? channelFromRow(rows[0]) : null;
    },
    async listChannels({ projectId, tenantId }) {
      const [rows] = await pool.execute('SELECT * FROM project_channels WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      return rows.map(channelFromRow);
    },
    async getChannel({ channelId, projectId = null, tenantId }) {
      const channel = await readChannel(pool, channelId, tenantId);
      return channel && (!projectId || channel.projectId === projectId) ? channel : null;
    },
    async createChannel({ description = '', name, projectId, tenantId, user }) {
      const id = randomUUID();
      try {
        await withTransaction(pool, async (connection) => {
          await connection.execute(
            `INSERT INTO project_channels (id, tenant_id, project_id, name, description, is_general, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, NOW(3), NOW(3))`,
            [id, tenantId, projectId, name, description, user.id],
          );
          await appendMysqlProjectChanges(connection, [channelChange({ action: 'create', actorId: user.id, channel: { id, name, projectId, tenantId } })]);
        });
      } catch (error) {
        if (isDuplicate(error)) throw channelNameTaken();
        throw error;
      }
      return readChannel(pool, id, tenantId);
    },
    async updateChannel({ channelId, changes, projectId, tenantId, user }) {
      const sets = [];
      const values = [];
      if (changes.name !== undefined) { sets.push('name = ?'); values.push(changes.name); }
      if (changes.description !== undefined) { sets.push('description = ?'); values.push(changes.description); }
      if (changes.odinEnabled !== undefined) { sets.push('odin_enabled = ?'); values.push(changes.odinEnabled ? 1 : 0); }
      try {
        return await withTransaction(pool, async (connection) => {
          const [result] = await connection.execute(`UPDATE project_channels SET ${[...sets, 'updated_at = NOW(3)'].join(', ')} WHERE id = ? AND tenant_id = ? AND project_id = ?`, [...values, channelId, tenantId, projectId]);
          if (!result.affectedRows) return null;
          const channel = await readChannel(connection, channelId, tenantId);
          await appendMysqlProjectChanges(connection, [channelChange({ action: 'update', actorId: user.id, channel })]);
          return channel;
        });
      } catch (error) {
        if (isDuplicate(error)) throw channelNameTaken();
        throw error;
      }
    },
    async setChannelArchived({ archived, channelId, projectId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const [result] = await connection.execute(
          `UPDATE project_channels SET archived_at = ${archived ? 'NOW(3)' : 'NULL'}, archived_by = ?, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND project_id = ?`,
          [archived ? user.id : null, channelId, tenantId, projectId],
        );
        if (!result.affectedRows) return null;
        const channel = await readChannel(connection, channelId, tenantId);
        await appendMysqlProjectChanges(connection, [channelChange({ action: archived ? 'archive' : 'restore', actorId: user.id, channel })]);
        return channel;
      });
    },
    async listChannelGuests({ channelId, tenantId }) {
      const [rows] = await pool.execute('SELECT stakeholder_id AS stakeholderId, invited_at AS invitedAt, invited_by AS invitedBy FROM project_channel_guests WHERE channel_id = ? AND tenant_id = ? AND removed_at IS NULL', [channelId, tenantId]);
      if (!rows.length) return [];
      const [people] = await pool.query('SELECT id, name, email FROM project_stakeholders WHERE id IN (?)', [rows.map((row) => row.stakeholderId)]);
      const byId = new Map(people.map((person) => [person.id, person]));
      return rows.map((row) => ({ channelId, email: byId.get(row.stakeholderId)?.email ?? '', invitedAt: iso(row.invitedAt), invitedBy: row.invitedBy, name: byId.get(row.stakeholderId)?.name ?? '', stakeholderId: row.stakeholderId, tenantId }));
    },
    async addChannelGuest({ channel, invitedBy, stakeholder }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute('SELECT removed_at AS removedAt FROM project_channel_guests WHERE channel_id = ? AND stakeholder_id = ? FOR UPDATE', [channel.id, stakeholder.id]);
        if (rows[0] && rows[0].removedAt == null) return { added: false, guest: { channelId: channel.id, stakeholderId: stakeholder.id } };
        if (rows[0]) {
          await connection.execute('UPDATE project_channel_guests SET invited_by = ?, invited_at = NOW(3), removed_at = NULL, removed_by = NULL WHERE channel_id = ? AND stakeholder_id = ?', [invitedBy, channel.id, stakeholder.id]);
        } else {
          await connection.execute('INSERT INTO project_channel_guests (channel_id, stakeholder_id, tenant_id, invited_by, invited_at) VALUES (?, ?, ?, ?, NOW(3))', [channel.id, stakeholder.id, channel.tenantId, invitedBy]);
        }
        await appendMysqlProjectChanges(connection, [guestChange({ action: 'invite', actorId: invitedBy, channel, stakeholderId: stakeholder.id })]);
        return { added: true, guest: { channelId: channel.id, stakeholderId: stakeholder.id } };
      });
    },
    async removeChannelGuest({ channel, removedBy, stakeholderId }) {
      return withTransaction(pool, async (connection) => {
        const [result] = await connection.execute('UPDATE project_channel_guests SET removed_at = NOW(3), removed_by = ? WHERE channel_id = ? AND stakeholder_id = ? AND removed_at IS NULL', [removedBy, channel.id, stakeholderId]);
        if (!result.affectedRows) return false;
        await appendMysqlProjectChanges(connection, [guestChange({ action: 'remove', actorId: removedBy, channel, stakeholderId })]);
        return true;
      });
    },
    async listGuestMemberships({ stakeholderIds, tenantId }) {
      if (!stakeholderIds.length) return [];
      const [rows] = await pool.query(
        `SELECT g.channel_id AS channelId, g.stakeholder_id AS stakeholderId, g.invited_at AS invitedAt, c.project_id AS projectId
         FROM project_channel_guests g INNER JOIN project_channels c ON c.id = g.channel_id AND c.tenant_id = g.tenant_id
         WHERE g.tenant_id = ? AND g.stakeholder_id IN (?) AND g.removed_at IS NULL`,
        [tenantId, stakeholderIds],
      );
      return rows.map((row) => ({ channelId: row.channelId, invitedAt: iso(row.invitedAt), projectId: row.projectId, stakeholderId: row.stakeholderId }));
    },
    // `executor` is the conversion's transaction, when there is one.
    async listProjectChannelGuests({ executor = pool, projectId, tenantId }) {
      const [rows] = await executor.execute(
        `SELECT g.channel_id AS channelId, g.stakeholder_id AS stakeholderId, g.invited_at AS invitedAt
         FROM project_channel_guests g INNER JOIN project_channels c ON c.id = g.channel_id
         WHERE c.tenant_id = ? AND c.project_id = ? AND g.removed_at IS NULL`,
        [tenantId, projectId],
      );
      return rows.map((row) => ({ channelId: row.channelId, invitedAt: iso(row.invitedAt), stakeholderId: row.stakeholderId }));
    },

    async listPosts({ before = null, limit = 30, targetId, targetType, tenantId }) {
      const bounded = Math.max(1, Math.min(200, Number(limit) || 30));
      const cursorSql = before ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
      const cursorValues = before ? [new Date(before.createdAt), new Date(before.createdAt), before.id] : [];
      const [roots] = await pool.execute(
        `SELECT * FROM discussion_posts WHERE tenant_id = ? AND target_type = ? AND target_id = ? AND parent_id IS NULL${cursorSql}
         ORDER BY created_at DESC, id DESC LIMIT ${bounded + 1}`,
        [tenantId, targetType, targetId, ...cursorValues],
      );
      const page = roots.slice(0, bounded);
      let replies = [];
      if (page.length) {
        [replies] = await pool.query('SELECT * FROM discussion_posts WHERE tenant_id = ? AND parent_id IN (?) ORDER BY created_at ASC, id ASC', [tenantId, page.map((row) => row.id)]);
      }
      const all = await presentPosts(pool, [...page, ...replies]);
      return { hasMore: roots.length > bounded, posts: all.slice(0, page.length), replies: all.slice(page.length) };
    },
    async listThreadReplies({ parentId, tenantId }) {
      const [rows] = await pool.execute('SELECT * FROM discussion_posts WHERE tenant_id = ? AND parent_id = ? ORDER BY created_at ASC, id ASC', [tenantId, parentId]);
      return presentPosts(pool, rows);
    },
    async getPost({ postId, projectId = null, tenantId }) {
      const row = await readPost(pool, postId, tenantId);
      if (!row || (projectId && row.project_id !== projectId)) return null;
      return (await presentPosts(pool, [row]))[0];
    },
    async createPost({ fileIds = [], post }) {
      const id = post.id ?? randomUUID();
      await withTransaction(pool, async (connection) => {
        await connection.execute(
          `INSERT INTO discussion_posts (id, tenant_id, project_id, target_type, target_id, parent_id, reply_to_id, file_version, author_type, author_id, body_markdown, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
          [id, post.tenantId, post.projectId, post.targetType, post.targetId, post.parentId ?? null, post.replyToId ?? null, post.fileVersion ?? null, post.authorType, post.authorId, post.body],
        );
        for (const fileId of new Set(fileIds)) {
          await connection.execute('INSERT INTO discussion_post_files (post_id, file_id) VALUES (?, ?)', [id, fileId]);
        }
        await appendMysqlProjectChanges(connection, [postChange({ action: 'create', actorId: post.authorId, post: { ...post, id } })]);
      });
      return (await presentPosts(pool, [await readPost(pool, id, post.tenantId)]))[0];
    },
    async updatePost({ body, postId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const [result] = await connection.execute('UPDATE discussion_posts SET body_markdown = ?, edited_at = NOW(3) WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [body, postId, tenantId]);
        if (!result.affectedRows) return null;
        const row = await readPost(connection, postId, tenantId);
        await appendMysqlProjectChanges(connection, [postChange({ action: 'update', actorId: user.id, post: postFromRow(row, new Map()) })]);
        return (await presentPosts(connection, [row]))[0];
      });
    },
    async deletePost({ postId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const [result] = await connection.execute("UPDATE discussion_posts SET body_markdown = '', deleted_at = NOW(3), deleted_by = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", [user.id, postId, tenantId]);
        if (!result.affectedRows) return null;
        await connection.execute('DELETE FROM discussion_post_files WHERE post_id = ?', [postId]);
        const row = await readPost(connection, postId, tenantId);
        await appendMysqlProjectChanges(connection, [postChange({ action: 'delete', actorId: user.id, post: postFromRow(row, new Map()) })]);
        return (await presentPosts(connection, [row]))[0];
      });
    },
    async listPostFileIds({ postIds }) {
      if (!postIds.length) return [];
      const [rows] = await pool.query('SELECT post_id AS postId, file_id AS fileId FROM discussion_post_files WHERE post_id IN (?)', [postIds]);
      return rows;
    },
    async listPostReactions({ postIds, tenantId }) {
      if (!postIds.length) return [];
      const [rows] = await pool.query(
        'SELECT post_id, principal_type, principal_id, emoji, created_at FROM discussion_post_reactions WHERE tenant_id = ? AND post_id IN (?) ORDER BY created_at ASC, principal_id ASC',
        [tenantId, postIds],
      );
      const names = await authorNames(pool, rows.map((row) => ({ author_id: row.principal_id, author_type: row.principal_type })));
      return rows.map((row) => ({
        createdAt: iso(row.created_at),
        emoji: row.emoji,
        name: names.get(`${row.principal_type}:${row.principal_id}`) ?? null,
        postId: row.post_id,
        principalId: row.principal_id,
        principalType: row.principal_type,
        tenantId,
      }));
    },
    async setPostReaction({ emoji, postId, principal, reacted, tenantId }) {
      const [result] = reacted
        ? await pool.execute(
          'INSERT IGNORE INTO discussion_post_reactions (post_id, tenant_id, principal_type, principal_id, emoji, created_at) VALUES (?, ?, ?, ?, ?, NOW(3))',
          [postId, tenantId, principal.type, principal.id, emoji],
        )
        : await pool.execute(
          'DELETE FROM discussion_post_reactions WHERE post_id = ? AND tenant_id = ? AND principal_type = ? AND principal_id = ? AND emoji = ?',
          [postId, tenantId, principal.type, principal.id, emoji],
        );
      return result.affectedRows > 0;
    },
    async listThreadAuthors({ parentId, tenantId }) {
      const [rows] = await pool.execute('SELECT DISTINCT author_type AS authorType, author_id AS authorId FROM discussion_posts WHERE parent_id = ? AND tenant_id = ? AND deleted_at IS NULL', [parentId, tenantId]);
      return rows;
    },
    // In the transaction that deletes the files (`executor`).
    async deleteFileDiscussion({ executor = pool, fileIds }) {
      if (!fileIds.length) return;
      await executor.query("DELETE FROM discussion_posts WHERE target_type = 'file' AND target_id IN (?)", [fileIds]);
      await executor.query('DELETE FROM discussion_post_files WHERE file_id IN (?)', [fileIds]);
    },

    async countUnread({ channelIds, principalId, principalType = 'user', tenantId }) {
      const counts = new Map(channelIds.map((id) => [id, 0]));
      if (!channelIds.length) return counts;
      const [rows] = await pool.query(
        `SELECT p.target_id AS channelId, COUNT(*) AS n
         FROM discussion_posts p
         LEFT JOIN channel_reads r ON r.channel_id = p.target_id AND r.principal_type = ? AND r.principal_id = ?
         WHERE p.tenant_id = ? AND p.target_type = 'channel' AND p.target_id IN (?) AND p.deleted_at IS NULL
           AND NOT (p.author_type = ? AND p.author_id = ?)
           AND (r.last_read_at IS NULL OR p.created_at > r.last_read_at)
         GROUP BY p.target_id`,
        [principalType, principalId, tenantId, channelIds, principalType, principalId],
      );
      for (const row of rows) counts.set(row.channelId, Number(row.n));
      return counts;
    },
    async countUnreadByProject({ principalId, principalType = 'user', projectIds, tenantId }) {
      const counts = new Map(projectIds.map((id) => [id, 0]));
      if (!projectIds.length) return counts;
      const [rows] = await pool.query(
        `SELECT c.project_id AS projectId, COUNT(*) AS n
         FROM discussion_posts p
         INNER JOIN project_channels c ON c.id = p.target_id AND c.archived_at IS NULL
         LEFT JOIN channel_reads r ON r.channel_id = p.target_id AND r.principal_type = ? AND r.principal_id = ?
         WHERE p.tenant_id = ? AND c.tenant_id = ? AND c.project_id IN (?) AND p.target_type = 'channel' AND p.deleted_at IS NULL
           AND NOT (p.author_type = ? AND p.author_id = ?)
           AND (r.last_read_at IS NULL OR p.created_at > r.last_read_at)
         GROUP BY c.project_id`,
        [principalType, principalId, tenantId, tenantId, projectIds, principalType, principalId],
      );
      for (const row of rows) counts.set(row.projectId, Number(row.n));
      return counts;
    },
    async markChannelRead({ channelId, principalId, principalType = 'user' }) {
      await pool.execute(
        `INSERT INTO channel_reads (channel_id, principal_type, principal_id, last_read_at) VALUES (?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE last_read_at = GREATEST(last_read_at, VALUES(last_read_at))`,
        [channelId, principalType, principalId],
      );
      const [rows] = await pool.execute('SELECT last_read_at AS at FROM channel_reads WHERE channel_id = ? AND principal_type = ? AND principal_id = ?', [channelId, principalType, principalId]);
      return iso(rows[0]?.at);
    },

    async listFolders({ channelId = null, projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT * FROM file_folders WHERE tenant_id = ? AND project_id = ?${channelId ? ' AND channel_id = ?' : ''} ORDER BY name ASC`,
        [tenantId, projectId, ...(channelId ? [channelId] : [])],
      );
      return rows.map(folderFromRow);
    },
    async getFolder({ folderId, projectId = null, tenantId }) {
      const folder = await readFolder(pool, folderId, tenantId);
      return folder && (!projectId || folder.projectId === projectId) ? folder : null;
    },
    async createFolder({ channelId, name, parentId = null, projectId, tenantId, user }) {
      const id = randomUUID();
      await withTransaction(pool, async (connection) => {
        await lockProject(connection, projectId, tenantId);
        await assertFolderNameFree(connection, { channelId, name, parentId });
        await connection.execute(
          'INSERT INTO file_folders (id, tenant_id, project_id, channel_id, parent_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))',
          [id, tenantId, projectId, channelId, parentId ?? null, name, user.id],
        );
        await appendMysqlProjectChanges(connection, [folderChange({ action: 'create', actorId: user.id, folder: { channelId, id, name, parentId, projectId, tenantId } })]);
      });
      return readFolder(pool, id, tenantId);
    },
    async updateFolder({ changes, folderId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const current = await readFolder(connection, folderId, tenantId);
        if (!current) return null;
        await lockProject(connection, current.projectId, tenantId);
        const name = changes.name ?? current.name;
        const parentId = changes.parentId === undefined ? current.parentId : changes.parentId;
        await assertFolderNameFree(connection, { channelId: current.channelId, exceptId: folderId, name, parentId });
        await connection.execute('UPDATE file_folders SET name = ?, parent_id = ? WHERE id = ? AND tenant_id = ?', [name, parentId ?? null, folderId, tenantId]);
        const folder = await readFolder(connection, folderId, tenantId);
        await appendMysqlProjectChanges(connection, [folderChange({ action: changes.parentId === undefined ? 'rename' : 'move', actorId: user.id, folder })]);
        return folder;
      });
    },
    async deleteFolder({ folderId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const folder = await readFolder(connection, folderId, tenantId, { lock: true });
        if (!folder) return null;
        await lockProject(connection, folder.projectId, tenantId);
        const [children] = await connection.execute('SELECT id FROM file_folders WHERE parent_id = ? LIMIT 1', [folderId]);
        const [files] = await connection.execute('SELECT id FROM file_vault WHERE tenant_id = ? AND folder_id = ? LIMIT 1', [tenantId, folderId]);
        if (children.length || files.length) throw folderNotEmpty();
        await connection.execute('DELETE FROM file_folders WHERE id = ? AND tenant_id = ?', [folderId, tenantId]);
        await appendMysqlProjectChanges(connection, [folderChange({ action: 'delete', actorId: user.id, folder })]);
        return folder;
      });
    },

    async setFileEditing({ fileId, tenantId, userId }) {
      // The app's clock, not the database's: the marker's age is judged against it (editingMarker).
      const [result] = await pool.execute('UPDATE file_vault SET editing_by = ?, editing_since = ? WHERE id = ? AND tenant_id = ?', [userId, new Date(), fileId, tenantId]);
      if (!result.affectedRows) return null;
      const [rows] = await pool.execute('SELECT editing_by AS editingBy, editing_since AS editingSince FROM file_vault WHERE id = ? AND tenant_id = ?', [fileId, tenantId]);
      const [users] = await pool.execute('SELECT name FROM users WHERE id = ? LIMIT 1', [userId]);
      return editingMarker({ ...rows[0], editingName: users[0]?.name ?? null });
    },
    async clearFileEditing({ fileId, onlyUserId = null, tenantId }) {
      const [result] = await pool.execute(
        `UPDATE file_vault SET editing_by = NULL, editing_since = NULL WHERE id = ? AND tenant_id = ? AND editing_by IS NOT NULL${onlyUserId ? ' AND editing_by = ?' : ''}`,
        [fileId, tenantId, ...(onlyUserId ? [onlyUserId] : [])],
      );
      return result.affectedRows > 0;
    },
  };
}
