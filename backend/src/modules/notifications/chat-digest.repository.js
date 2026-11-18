import { randomUUID } from 'node:crypto';

import { NOTIFICATION_COLUMNS, iso, notificationFromRow } from './notification-rows.js';

// The rolled-up chat email's durable state (docs/odin-chat/plan.md, Email; qna.md Q-04), on the
// notifications themselves and chat_digest_deliveries (migration 0102). It mirrors
// requirements/mentions/mentions.repository.js, which holds the same digest for requirements
// mentions:
//
// - An item is a notification whose digest_state is 'pending', that is still unread, and whose
//   digest_after (created_at plus the unseen delay) has passed: it has joined the digest.
// - A person's digest is due once the newest item joined more than the quiet period ago, so
//   every new item pushes it back (a trailing debounce with no cap).
// - A sender claims the person's delivery row with a token and a lease; each later step is a
//   compare-and-set on that token, so an owner whose lease expired is fenced out. Nothing is
//   marked sent unless it was in the email that went out, and the items and the deadline are
//   checked again under lock right before sending.
// - Releasing an item (the person opted out, lost access, has no email) is final, and only a
//   live owner may release. Lock order: notification rows first, then the delivery row.
//
// A recipient is { tenantId, principalType, principalId }.

const time = (value) => (value ? new Date(value).getTime() : 0);
const recipientKey = ({ principalId, principalType, tenantId }) => JSON.stringify([tenantId, principalType, String(principalId)]);
const placeholders = (values) => values.map(() => '?').join(', ');
const newestJoined = (rows) => Math.max(...rows.map((row) => time(row.digestAfter)));
const live = (delivery, now) => Boolean(delivery) && time(delivery.claimedUntil) > time(now);
const isItem = (row, now) => row.digestState === 'pending' && !row.readAt && row.digestAfter && time(row.digestAfter) <= time(now);

export function createInMemoryChatDigestMethods({ state }) {
  state.digestDeliveries ??= new Map();
  const clone = (value) => structuredClone(value);
  const itemsOf = (recipient, now) => state.notifications.filter((row) => recipientKey(row) === recipientKey(recipient) && isItem(row, now));
  const owned = (deliveryId, claimToken) => [...state.digestDeliveries.values()].find((row) => row.id === deliveryId && row.claimToken === claimToken) ?? null;
  const release = (recipient, released) => {
    const reasons = new Map(released.map((entry) => [entry.id, entry.reason]));
    for (const row of state.notifications) {
      if (recipientKey(row) === recipientKey(recipient) && row.digestState === 'pending' && reasons.has(row.id)) Object.assign(row, { digestError: reasons.get(row.id), digestState: 'released' });
    }
  };

  return {
    async listDueChatDigests({ dueBefore, limit = 50, now }) {
      const latest = new Map();
      for (const row of state.notifications) {
        if (!isItem(row, now)) continue;
        const key = recipientKey(row);
        if (!latest.has(key) || time(row.digestAfter) > time(latest.get(key).lastJoinedAt)) {
          latest.set(key, { lastJoinedAt: row.digestAfter, principalId: row.principalId, principalType: row.principalType, tenantId: row.tenantId });
        }
      }
      return [...latest.entries()]
        .filter(([key, entry]) => {
          const delivery = state.digestDeliveries.get(key);
          const waiting = delivery && (time(delivery.claimedUntil) > time(now) || time(delivery.nextAttemptAt) > time(now));
          return !waiting && time(entry.lastJoinedAt) < time(dueBefore);
        })
        .map(([, entry]) => entry)
        .sort((left, right) => time(left.lastJoinedAt) - time(right.lastJoinedAt))
        .slice(0, limit);
    },

    async listChatDigestItems({ now, ...recipient }) {
      return itemsOf(recipient, now).map(clone).sort((left, right) => time(left.createdAt) - time(right.createdAt));
    },

    async claimChatDigest({ dueBefore, leaseUntil, now, ...recipient }) {
      const key = recipientKey(recipient);
      const items = itemsOf(recipient, now);
      if (!items.length) {
        state.digestDeliveries.delete(key);
        return null;
      }
      if (newestJoined(items) >= time(dueBefore)) return null;
      const existing = state.digestDeliveries.get(key);
      if (existing && (time(existing.claimedUntil) > time(now) || time(existing.nextAttemptAt) > time(now))) return null;
      const claimToken = randomUUID();
      const interruptedSend = Boolean(existing?.sendStartedAt);
      const row = existing ?? { attempts: 0, id: randomUUID(), lastError: '', nextAttemptAt: null, ...recipient };
      Object.assign(row, { claimedUntil: iso(leaseUntil), claimToken, sendStartedAt: null });
      state.digestDeliveries.set(key, row);
      return { attempts: row.attempts, claimToken, deliveryId: row.id, interruptedSend };
    },

    async beginChatDigestSend({ claimToken, deliveryId, dueBefore, leaseUntil, now, sendIds, ...recipient }) {
      const delivery = owned(deliveryId, claimToken);
      if (!live(delivery, now)) return { ok: false, reason: 'fenced' };
      const items = itemsOf(recipient, now);
      const stop = (reason) => {
        Object.assign(delivery, { claimedUntil: null, claimToken: null });
        return { ok: false, reason };
      };
      if (!items.length || newestJoined(items) >= time(dueBefore)) return stop('not-due');
      const current = new Set(items.map((row) => row.id));
      if (sendIds.some((id) => !current.has(id))) return stop('changed');
      Object.assign(delivery, { claimedUntil: iso(leaseUntil), sendStartedAt: iso(now) });
      return { ok: true };
    },

    async completeChatDigestSend({ claimToken, deliveryId, now, released = [], sentIds = [], ...recipient }) {
      const sent = new Set(sentIds);
      // Marked even if this owner was fenced meanwhile: the email went out.
      for (const row of state.notifications) {
        if (recipientKey(row) === recipientKey(recipient) && sent.has(row.id) && row.digestState === 'pending') Object.assign(row, { digestDeliveryId: deliveryId, digestError: '', digestSentAt: iso(now), digestState: 'sent' });
      }
      const delivery = owned(deliveryId, claimToken);
      if (live(delivery, now)) release(recipient, released);
      if (delivery) state.digestDeliveries.delete(recipientKey(delivery));
    },

    async failChatDigestAttempt({ claimToken, deliveryId, error, itemIds = [], maxAttempts, now, retryAt = null, ...recipient }) {
      const delivery = owned(deliveryId, claimToken);
      if (!live(delivery, now)) return { fenced: true };
      const attempts = delivery.attempts + 1;
      if (retryAt && attempts < maxAttempts) {
        Object.assign(delivery, { attempts, claimedUntil: null, claimToken: null, lastError: error, nextAttemptAt: iso(retryAt), sendStartedAt: null });
        return { attempts, terminal: false };
      }
      const ids = new Set(itemIds);
      for (const row of state.notifications) {
        if (recipientKey(row) === recipientKey(recipient) && ids.has(row.id) && row.digestState === 'pending') Object.assign(row, { digestError: error, digestState: 'failed' });
      }
      state.digestDeliveries.delete(recipientKey(delivery));
      return { attempts, terminal: true };
    },

    async releaseChatDigest({ claimToken, deliveryId, now, released = [], ...recipient }) {
      const delivery = owned(deliveryId, claimToken);
      if (!delivery) return { fenced: true };
      const fenced = !live(delivery, now);
      if (!fenced) release(recipient, released);
      state.digestDeliveries.delete(recipientKey(delivery));
      return { fenced };
    },

    async abortChatDigestSend({ claimToken, deliveryId }) {
      const delivery = owned(deliveryId, claimToken);
      if (delivery) Object.assign(delivery, { claimedUntil: null, claimToken: null, sendStartedAt: null });
    },

    async getChatDigest(recipient) {
      const row = state.digestDeliveries.get(recipientKey(recipient));
      return row ? clone(row) : null;
    },
  };
}

const DELIVERY_COLUMNS = `id, tenant_id AS tenantId, principal_type AS principalType, principal_id AS principalId, claim_token AS claimToken,
  claimed_until AS claimedUntil, send_started_at AS sendStartedAt, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError`;

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export function createMysqlChatDigestMethods({ pool }) {
  const where = 'tenant_id = ? AND principal_type = ? AND principal_id = ?';
  const args = ({ principalId, principalType, tenantId }) => [tenantId, principalType, String(principalId)];
  const itemWhere = `${where} AND digest_state = 'pending' AND read_at IS NULL AND digest_after IS NOT NULL AND digest_after <= ?`;
  const fromRow = (rows) => rows.map(notificationFromRow);

  async function lockItems(connection, recipient, now) {
    const [rows] = await connection.execute(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${itemWhere} FOR UPDATE`, [...args(recipient), new Date(now)]);
    return fromRow(rows);
  }
  async function lockDelivery(connection, deliveryId) {
    const [rows] = await connection.execute(`SELECT ${DELIVERY_COLUMNS} FROM chat_digest_deliveries WHERE id = ? FOR UPDATE`, [deliveryId]);
    return rows[0] ?? null;
  }
  async function release(connection, recipient, released) {
    for (const entry of released) {
      await connection.execute(`UPDATE notifications SET digest_state = 'released', digest_error = ? WHERE ${where} AND id = ? AND digest_state = 'pending'`, [entry.reason, ...args(recipient), entry.id]);
    }
  }

  return {
    async listDueChatDigests({ dueBefore, limit = 50, now }) {
      const bounded = Math.max(1, Math.min(500, Number.parseInt(String(limit), 10) || 50));
      const [rows] = await pool.execute(
        `SELECT n.tenant_id AS tenantId, n.principal_type AS principalType, n.principal_id AS principalId, MAX(n.digest_after) AS lastJoinedAt
          FROM notifications n
          LEFT JOIN chat_digest_deliveries d ON d.tenant_id = n.tenant_id AND d.principal_type = n.principal_type AND d.principal_id = n.principal_id
          WHERE n.digest_state = 'pending' AND n.read_at IS NULL AND n.digest_after IS NOT NULL AND n.digest_after <= ?
            AND (d.id IS NULL OR ((d.claimed_until IS NULL OR d.claimed_until <= ?) AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)))
          GROUP BY n.tenant_id, n.principal_type, n.principal_id
          HAVING MAX(n.digest_after) < ?
          ORDER BY lastJoinedAt
          LIMIT ${bounded}`,
        [new Date(now), new Date(now), new Date(now), new Date(dueBefore)],
      );
      return rows.map((row) => ({ ...row, lastJoinedAt: iso(row.lastJoinedAt) }));
    },

    async listChatDigestItems({ now, ...recipient }) {
      const [rows] = await pool.execute(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${itemWhere} ORDER BY created_at, id`, [...args(recipient), new Date(now)]);
      return fromRow(rows);
    },

    async claimChatDigest({ dueBefore, leaseUntil, now, ...recipient }) {
      return withTransaction(pool, async (connection) => {
        const items = await lockItems(connection, recipient, now);
        if (!items.length) {
          await connection.execute(`DELETE FROM chat_digest_deliveries WHERE ${where}`, args(recipient));
          return null;
        }
        if (newestJoined(items) >= time(dueBefore)) return null;
        const [existingRows] = await connection.execute(`SELECT ${DELIVERY_COLUMNS} FROM chat_digest_deliveries WHERE ${where} FOR UPDATE`, args(recipient));
        const existing = existingRows[0] ?? null;
        if (existing && (time(existing.claimedUntil) > time(now) || time(existing.nextAttemptAt) > time(now))) return null;
        const claimToken = randomUUID();
        if (existing) {
          await connection.execute('UPDATE chat_digest_deliveries SET claim_token = ?, claimed_until = ?, send_started_at = NULL, updated_at = ? WHERE id = ?', [claimToken, new Date(leaseUntil), new Date(now), existing.id]);
          return { attempts: Number(existing.attempts ?? 0), claimToken, deliveryId: existing.id, interruptedSend: Boolean(existing.sendStartedAt) };
        }
        const deliveryId = randomUUID();
        try {
          await connection.execute(
            `INSERT INTO chat_digest_deliveries (id, tenant_id, principal_type, principal_id, claim_token, claimed_until, attempts, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [deliveryId, ...args(recipient), claimToken, new Date(leaseUntil), new Date(now), new Date(now)],
          );
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') return null;
          throw error;
        }
        return { attempts: 0, claimToken, deliveryId, interruptedSend: false };
      });
    },

    async beginChatDigestSend({ claimToken, deliveryId, dueBefore, leaseUntil, now, sendIds, ...recipient }) {
      return withTransaction(pool, async (connection) => {
        const items = await lockItems(connection, recipient, now);
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken || !live(delivery, now)) return { ok: false, reason: 'fenced' };
        const stop = async (reason) => {
          await connection.execute('UPDATE chat_digest_deliveries SET claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ? AND claim_token = ?', [new Date(now), deliveryId, claimToken]);
          return { ok: false, reason };
        };
        if (!items.length || newestJoined(items) >= time(dueBefore)) return stop('not-due');
        const current = new Set(items.map((row) => row.id));
        if (sendIds.some((id) => !current.has(id))) return stop('changed');
        await connection.execute('UPDATE chat_digest_deliveries SET claimed_until = ?, send_started_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?', [new Date(leaseUntil), new Date(now), new Date(now), deliveryId, claimToken]);
        return { ok: true };
      });
    },

    async completeChatDigestSend({ claimToken, deliveryId, now, released = [], sentIds = [], ...recipient }) {
      await withTransaction(pool, async (connection) => {
        if (sentIds.length) {
          // Marked even if this owner was fenced meanwhile: the email went out.
          await connection.execute(
            `UPDATE notifications SET digest_state = 'sent', digest_sent_at = ?, digest_delivery_id = ?, digest_error = ''
              WHERE ${where} AND digest_state = 'pending' AND id IN (${placeholders(sentIds)})`,
            [new Date(now), deliveryId, ...args(recipient), ...sentIds],
          );
        }
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken) return;
        if (live(delivery, now)) await release(connection, recipient, released);
        await connection.execute('DELETE FROM chat_digest_deliveries WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
      });
    },

    async failChatDigestAttempt({ claimToken, deliveryId, error, itemIds = [], maxAttempts, now, retryAt = null, ...recipient }) {
      return withTransaction(pool, async (connection) => {
        await lockItems(connection, recipient, now);
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken || !live(delivery, now)) return { fenced: true };
        const attempts = Number(delivery.attempts ?? 0) + 1;
        if (retryAt && attempts < maxAttempts) {
          await connection.execute(
            `UPDATE chat_digest_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ?, claim_token = NULL, claimed_until = NULL, send_started_at = NULL, updated_at = ?
              WHERE id = ? AND claim_token = ?`,
            [attempts, new Date(retryAt), error, new Date(now), deliveryId, claimToken],
          );
          return { attempts, terminal: false };
        }
        if (itemIds.length) {
          await connection.execute(`UPDATE notifications SET digest_state = 'failed', digest_error = ? WHERE ${where} AND digest_state = 'pending' AND id IN (${placeholders(itemIds)})`, [error, ...args(recipient), ...itemIds]);
        }
        await connection.execute('DELETE FROM chat_digest_deliveries WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
        return { attempts, terminal: true };
      });
    },

    async releaseChatDigest({ claimToken, deliveryId, now, released = [], ...recipient }) {
      return withTransaction(pool, async (connection) => {
        await lockItems(connection, recipient, now);
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken) return { fenced: true };
        const fenced = !live(delivery, now);
        if (!fenced) await release(connection, recipient, released);
        await connection.execute('DELETE FROM chat_digest_deliveries WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
        return { fenced };
      });
    },

    async abortChatDigestSend({ claimToken, deliveryId, now }) {
      await pool.execute('UPDATE chat_digest_deliveries SET claim_token = NULL, claimed_until = NULL, send_started_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ?', [new Date(now), deliveryId, claimToken]);
    },

    async getChatDigest(recipient) {
      const [rows] = await pool.execute(`SELECT ${DELIVERY_COLUMNS} FROM chat_digest_deliveries WHERE ${where}`, args(recipient));
      return rows[0] ?? null;
    },
  };
}
