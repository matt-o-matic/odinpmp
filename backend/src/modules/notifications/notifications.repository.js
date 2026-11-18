import { createHash, randomUUID } from 'node:crypto';

import { createInMemoryChatDigestMethods, createMysqlChatDigestMethods } from './chat-digest.repository.js';
import { NOTIFICATION_COLUMNS, iso, notificationFromRow, parseJsonObject } from './notification-rows.js';

// Durable state for notifications (migration 0102, notifications-schema.js): levels per channel
// and person, notification records, which tabs have Odin focused, and Web Push subscriptions.
// The digest's delivery rows are in chat-digest.repository.js; both are spread into one
// repository, as the channel methods are spread into the projects repository.
//
// A principal is { principalType, principalId }: a member ('user') or a guest ('stakeholder').
// Every read and write of notifications is scoped to one workspace and principal.

const time = (value) => (value ? new Date(value).getTime() : 0);
const principalKey = ({ principalId, principalType, tenantId = '' }) => JSON.stringify([tenantId, principalType, String(principalId)]);
const placeholders = (values) => values.map(() => '?').join(', ');

export const NOTIFICATION_KINDS = Object.freeze(['mention', 'thread_reply', 'channel_post', 'odin_reply', 'task_assigned', 'direct_message']);
// Where a notification is in the rolled-up email (notifications-schema.js).
export const DIGEST_STATES = Object.freeze(['pending', 'read', 'sent', 'released', 'failed']);
// A collapsed notification that was already emailed or released goes back into the digest when
// a new post lands in it.
const REOPENED_DIGEST_STATES = new Set(['sent', 'released', 'failed']);

export function endpointHash(endpoint) {
  return createHash('sha256').update(String(endpoint)).digest('hex');
}

function newRow({ notification, now }) {
  return {
    actorId: String(notification.actorId ?? ''),
    actorType: notification.actorType ?? 'user',
    channelId: notification.channelId ?? null,
    collapseCount: 1,
    collapseKey: notification.collapseKey ?? null,
    conversationId: notification.conversationId ?? null,
    createdAt: iso(now),
    digestAfter: iso(notification.digestAfter ?? null),
    digestDeliveryId: null,
    digestError: '',
    digestSentAt: null,
    digestState: notification.digestAfter ? 'pending' : 'released',
    fileId: notification.fileId ?? null,
    id: randomUUID(),
    itemId: notification.itemId ?? null,
    kind: notification.kind,
    postId: notification.postId ?? null,
    principalId: String(notification.principalId),
    principalType: notification.principalType,
    projectId: notification.projectId ?? null,
    readAt: null,
    summary: notification.summary ?? {},
    tenantId: notification.tenantId,
    threadId: notification.threadId ?? null,
    updatedAt: iso(now),
  };
}

// --- in memory --------------------------------------------------------------------------------

export function createInMemoryNotificationsRepository() {
  const state = { focus: new Map(), levels: new Map(), notifications: [], pushSubscriptions: [] };
  const clone = (value) => structuredClone(value);
  const levelKey = (channelId, principalType, principalId) => JSON.stringify([channelId, principalType, String(principalId)]);
  const owns = (row, principal) => principalKey(row) === principalKey(principal);
  const unreadOf = (principal) => state.notifications.filter((row) => owns(row, principal) && !row.readAt);

  return {
    state,

    async getChannelLevels({ channelIds, principalId, principalType }) {
      const levels = new Map();
      for (const channelId of channelIds) {
        const row = state.levels.get(levelKey(channelId, principalType, principalId));
        if (row) levels.set(channelId, row.level);
      }
      return levels;
    },
    async listChannelLevels({ channelId }) {
      return new Map([...state.levels.values()].filter((row) => row.channelId === channelId).map((row) => [`${row.principalType}:${row.principalId}`, row.level]));
    },
    async setChannelLevel({ channelId, level, now = new Date(), principalId, principalType, tenantId }) {
      const key = levelKey(channelId, principalType, principalId);
      if (!level) state.levels.delete(key);
      else state.levels.set(key, { channelId, level, principalId: String(principalId), principalType, tenantId, updatedAt: iso(now) });
    },

    async recordNotification({ notification, now = new Date() }) {
      const open = notification.collapseKey
        ? unreadOf(notification).find((row) => row.collapseKey === notification.collapseKey)
        : null;
      if (open) {
        Object.assign(open, { actorId: String(notification.actorId), actorType: notification.actorType, collapseCount: open.collapseCount + 1, postId: notification.postId ?? open.postId, summary: notification.summary ?? open.summary, threadId: notification.threadId ?? null, updatedAt: iso(now) });
        if (REOPENED_DIGEST_STATES.has(open.digestState) && notification.digestAfter) Object.assign(open, { digestAfter: iso(notification.digestAfter), digestError: '', digestState: 'pending' });
        return { created: false, notification: clone(open) };
      }
      const row = newRow({ notification, now });
      state.notifications.push(row);
      return { created: true, notification: clone(row) };
    },
    async getNotification({ id, ...principal }) {
      const row = state.notifications.find((entry) => entry.id === id && owns(entry, principal));
      return row ? clone(row) : null;
    },
    async listNotifications({ limit = 50, ...principal }) {
      return state.notifications.filter((row) => owns(row, principal))
        .sort((left, right) => time(right.updatedAt) - time(left.updatedAt) || String(right.id).localeCompare(String(left.id)))
        .slice(0, limit).map(clone);
    },
    async countUnread(principal) {
      return unreadOf(principal).length;
    },
    /** Marks read the principal's unread notifications that match; returns their ids. */
    async markNotificationsRead({ all = false, channelId = null, conversationId = null, ids = null, now = new Date(), ...principal }) {
      const wanted = ids ? new Set(ids) : null;
      const marked = [];
      for (const row of unreadOf(principal)) {
        if (!all && !(wanted?.has(row.id) || (channelId && row.channelId === channelId) || (conversationId && row.conversationId === conversationId))) continue;
        row.readAt = iso(now);
        if (row.digestState === 'pending') row.digestState = 'read';
        marked.push(row.id);
      }
      return marked;
    },
    async purgeNotifications({ before, now = new Date() }) {
      const count = state.notifications.length;
      // By last activity: a collapsed notification that is still getting posts stays.
      state.notifications = state.notifications.filter((row) => time(row.updatedAt) >= time(before));
      for (const [key, until] of state.focus) if (until <= time(now)) state.focus.delete(key);
      return count - state.notifications.length;
    },

    async setFocus({ clientId, focusedUntil, principalId, principalType }) {
      state.focus.set(JSON.stringify([principalType, String(principalId), clientId]), time(focusedUntil));
    },
    async clearFocus({ clientId, principalId, principalType }) {
      state.focus.delete(JSON.stringify([principalType, String(principalId), clientId]));
    },
    async isFocused({ now = new Date(), principalId, principalType }) {
      const prefix = JSON.stringify([principalType, String(principalId)]).slice(0, -1);
      return [...state.focus].some(([key, until]) => key.startsWith(`${prefix},`) && until > time(now));
    },

    async savePushSubscription({ endpoint, keys, now = new Date(), principalId, principalType, userAgent = '' }) {
      const hash = endpointHash(endpoint);
      // A browser that another person signs in to takes the subscription over.
      const existing = state.pushSubscriptions.find((row) => row.endpointHash === hash);
      const row = existing ?? { createdAt: iso(now), endpoint, endpointHash: hash, id: randomUUID() };
      Object.assign(row, { expiredAt: null, keys: clone(keys), lastUsedAt: row.lastUsedAt ?? null, principalId: String(principalId), principalType, userAgent: String(userAgent).slice(0, 255) });
      if (!existing) state.pushSubscriptions.push(row);
      return clone(row);
    },
    async removePushSubscription({ endpoint, principalId, principalType }) {
      const hash = endpointHash(endpoint);
      const before = state.pushSubscriptions.length;
      state.pushSubscriptions = state.pushSubscriptions.filter((row) => !(row.endpointHash === hash && row.principalType === principalType && row.principalId === String(principalId)));
      return before !== state.pushSubscriptions.length;
    },
    async listPushSubscriptions({ principalId, principalType }) {
      return state.pushSubscriptions.filter((row) => row.principalType === principalType && row.principalId === String(principalId) && !row.expiredAt).map(clone);
    },
    async expirePushSubscription({ id, now = new Date() }) {
      const row = state.pushSubscriptions.find((entry) => entry.id === id);
      if (row) row.expiredAt = iso(now);
    },
    async touchPushSubscription({ id, now = new Date() }) {
      const row = state.pushSubscriptions.find((entry) => entry.id === id);
      if (row) row.lastUsedAt = iso(now);
    },

    ...createInMemoryChatDigestMethods({ state }),
  };
}

// --- MySQL ------------------------------------------------------------------------------------

function subscriptionFromRow(row) {
  return {
    createdAt: iso(row.created_at),
    endpoint: row.endpoint,
    endpointHash: row.endpoint_hash,
    expiredAt: iso(row.expired_at),
    id: row.id,
    keys: parseJsonObject(row.keys_json),
    lastUsedAt: iso(row.last_used_at),
    principalId: row.principal_id,
    principalType: row.principal_type,
    userAgent: row.user_agent ?? '',
  };
}

const principalWhere = 'tenant_id = ? AND principal_type = ? AND principal_id = ?';
const principalArgs = ({ principalId, principalType, tenantId }) => [tenantId, principalType, String(principalId)];

export function createMysqlNotificationsRepository({ pool }) {
  if (!pool) throw new Error('A MySQL pool is required to create the notifications repository.');

  async function readNotification(executor, id, principal) {
    const [rows] = await executor.execute(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ? AND ${principalWhere}`, [id, ...principalArgs(principal)]);
    return rows[0] ? notificationFromRow(rows[0]) : null;
  }

  return {
    async getChannelLevels({ channelIds, principalId, principalType }) {
      if (!channelIds.length) return new Map();
      const [rows] = await pool.execute(
        `SELECT channel_id, level FROM channel_notification_levels WHERE principal_type = ? AND principal_id = ? AND channel_id IN (${placeholders(channelIds)})`,
        [principalType, String(principalId), ...channelIds],
      );
      return new Map(rows.map((row) => [row.channel_id, row.level]));
    },
    async listChannelLevels({ channelId }) {
      const [rows] = await pool.execute('SELECT principal_type, principal_id, level FROM channel_notification_levels WHERE channel_id = ?', [channelId]);
      return new Map(rows.map((row) => [`${row.principal_type}:${row.principal_id}`, row.level]));
    },
    async setChannelLevel({ channelId, level, now = new Date(), principalId, principalType, tenantId }) {
      if (!level) {
        await pool.execute('DELETE FROM channel_notification_levels WHERE channel_id = ? AND principal_type = ? AND principal_id = ?', [channelId, principalType, String(principalId)]);
        return;
      }
      await pool.execute(
        `INSERT INTO channel_notification_levels (channel_id, principal_type, principal_id, tenant_id, level, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE level = VALUES(level), updated_at = VALUES(updated_at)`,
        [channelId, principalType, String(principalId), tenantId, level, new Date(now)],
      );
    },

    async recordNotification({ notification, now = new Date() }) {
      const row = newRow({ notification, now });
      const at = new Date(now);
      const digestAfter = row.digestAfter ? new Date(row.digestAfter) : null;
      // A collapsed notification meets its unread row through uq_notifications_open_collapse.
      const [result] = await pool.execute(
        `INSERT INTO notifications (id, tenant_id, principal_type, principal_id, kind, project_id, channel_id, conversation_id, post_id, thread_id,
           file_id, item_id, actor_type, actor_id, summary_json, collapse_key, collapse_count, read_at, digest_state, digest_after, digest_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, '', ?, ?)
         ON DUPLICATE KEY UPDATE
           digest_error = IF(digest_state IN ('sent', 'released', 'failed') AND VALUES(digest_after) IS NOT NULL, '', digest_error),
           digest_after = IF(digest_state IN ('sent', 'released', 'failed') AND VALUES(digest_after) IS NOT NULL, VALUES(digest_after), digest_after),
           digest_state = IF(digest_state IN ('sent', 'released', 'failed') AND VALUES(digest_after) IS NOT NULL, 'pending', digest_state),
           collapse_count = collapse_count + 1, actor_type = VALUES(actor_type), actor_id = VALUES(actor_id),
           post_id = COALESCE(VALUES(post_id), post_id), thread_id = VALUES(thread_id), summary_json = VALUES(summary_json), updated_at = VALUES(updated_at)`,
        [row.id, row.tenantId, row.principalType, row.principalId, row.kind, row.projectId, row.channelId, row.conversationId, row.postId, row.threadId,
          row.fileId, row.itemId, row.actorType, row.actorId, JSON.stringify(row.summary), row.collapseKey, row.digestState, digestAfter, at, at],
      );
      // affectedRows is 1 for an insert and 2 for an update of the open row.
      if (Number(result.affectedRows) === 1) return { created: true, notification: await readNotification(pool, row.id, row) };
      const [open] = await pool.execute(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${principalWhere} AND open_collapse_key = ?`, [...principalArgs(row), row.collapseKey]);
      return { created: false, notification: open[0] ? notificationFromRow(open[0]) : null };
    },
    async getNotification({ id, ...principal }) {
      return readNotification(pool, id, principal);
    },
    async listNotifications({ limit = 50, ...principal }) {
      const bounded = Math.max(1, Math.min(200, Number.parseInt(String(limit), 10) || 50));
      const [rows] = await pool.execute(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${principalWhere} ORDER BY updated_at DESC, id DESC LIMIT ${bounded}`, principalArgs(principal));
      return rows.map(notificationFromRow);
    },
    async countUnread(principal) {
      const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM notifications WHERE ${principalWhere} AND read_at IS NULL`, principalArgs(principal));
      return Number(rows[0]?.count ?? 0);
    },
    async markNotificationsRead({ all = false, channelId = null, conversationId = null, ids = null, now = new Date(), ...principal }) {
      const clauses = [];
      const args = [];
      if (!all) {
        if (ids?.length) { clauses.push(`id IN (${placeholders(ids)})`); args.push(...ids); }
        if (channelId) { clauses.push('channel_id = ?'); args.push(channelId); }
        if (conversationId) { clauses.push('conversation_id = ?'); args.push(conversationId); }
        if (!clauses.length) return [];
      }
      const filter = all ? '' : ` AND (${clauses.join(' OR ')})`;
      const [rows] = await pool.execute(`SELECT id FROM notifications WHERE ${principalWhere} AND read_at IS NULL${filter}`, [...principalArgs(principal), ...args]);
      const marked = rows.map((row) => row.id);
      if (!marked.length) return [];
      await pool.execute(
        `UPDATE notifications SET read_at = ?, digest_state = IF(digest_state = 'pending', 'read', digest_state)
          WHERE ${principalWhere} AND read_at IS NULL AND id IN (${placeholders(marked)})`,
        [new Date(now), ...principalArgs(principal), ...marked],
      );
      return marked;
    },
    async purgeNotifications({ before, now = new Date() }) {
      const [result] = await pool.execute('DELETE FROM notifications WHERE updated_at < ?', [new Date(before)]);
      await pool.execute('DELETE FROM notification_focus WHERE focused_until <= ?', [new Date(now)]);
      return Number(result.affectedRows ?? 0);
    },

    async setFocus({ clientId, focusedUntil, principalId, principalType }) {
      await pool.execute(
        `INSERT INTO notification_focus (principal_type, principal_id, client_id, focused_until) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE focused_until = VALUES(focused_until)`,
        [principalType, String(principalId), clientId, new Date(focusedUntil)],
      );
    },
    async clearFocus({ clientId, principalId, principalType }) {
      await pool.execute('DELETE FROM notification_focus WHERE principal_type = ? AND principal_id = ? AND client_id = ?', [principalType, String(principalId), clientId]);
    },
    async isFocused({ now = new Date(), principalId, principalType }) {
      const [rows] = await pool.execute('SELECT 1 FROM notification_focus WHERE principal_type = ? AND principal_id = ? AND focused_until > ? LIMIT 1', [principalType, String(principalId), new Date(now)]);
      return rows.length > 0;
    },

    async savePushSubscription({ endpoint, keys, now = new Date(), principalId, principalType, userAgent = '' }) {
      const hash = endpointHash(endpoint);
      await pool.execute(
        `INSERT INTO push_subscriptions (id, principal_type, principal_id, endpoint_hash, endpoint, keys_json, user_agent, created_at, last_used_at, expired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON DUPLICATE KEY UPDATE principal_type = VALUES(principal_type), principal_id = VALUES(principal_id), keys_json = VALUES(keys_json),
           user_agent = VALUES(user_agent), expired_at = NULL`,
        [randomUUID(), principalType, String(principalId), hash, endpoint, JSON.stringify(keys), String(userAgent).slice(0, 255), new Date(now)],
      );
      const [rows] = await pool.execute('SELECT * FROM push_subscriptions WHERE endpoint_hash = ?', [hash]);
      return subscriptionFromRow(rows[0]);
    },
    async removePushSubscription({ endpoint, principalId, principalType }) {
      const [result] = await pool.execute('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND principal_type = ? AND principal_id = ?', [endpointHash(endpoint), principalType, String(principalId)]);
      return Number(result.affectedRows ?? 0) > 0;
    },
    async listPushSubscriptions({ principalId, principalType }) {
      const [rows] = await pool.execute('SELECT * FROM push_subscriptions WHERE principal_type = ? AND principal_id = ? AND expired_at IS NULL ORDER BY created_at', [principalType, String(principalId)]);
      return rows.map(subscriptionFromRow);
    },
    async expirePushSubscription({ id, now = new Date() }) {
      await pool.execute('UPDATE push_subscriptions SET expired_at = ? WHERE id = ?', [new Date(now), id]);
    },
    async touchPushSubscription({ id, now = new Date() }) {
      await pool.execute('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', [new Date(now), id]);
    },

    ...createMysqlChatDigestMethods({ pool }),
  };
}
