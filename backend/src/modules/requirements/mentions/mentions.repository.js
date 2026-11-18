import { randomUUID } from 'node:crypto';

// Durable state for Requirements mentions and their email digests.
//
// requirements_mentions holds one row per comment and person it concerns (a unique key), with
// scheduled_at set when the comment was saved. Its reason is 'mention' when the comment tags
// the person, or 'reply' when it is a new comment on a topic they own or commented on
// (migration 0076). A tag outranks a reply: tagging someone in an edit turns their pending
// reply into a mention. A recipient's digest in one project is due
// once their newest pending mention is more than the quiet period old, so every new
// mention pushes it back (a trailing debounce with no cap), as clarification invitation
// digests do (assistant/clarification-invitation-digest.store.js, which this mirrors).
//
// requirements_mention_digests holds at most one delivery per tenant, project and recipient
// (a unique key). A sender claims it with a token and a lease; every later step is a
// compare-and-set on that token, so an owner whose lease expired is fenced out. Nothing is
// marked sent unless it was in the email that was actually sent, and the deadline is
// checked again under lock right before sending.
//
// Releasing a mention (it will never be emailed: the comment was removed, the person lost
// access, opted out...) is final, and only an owner whose claim and lease are still live may
// release. Lock order is always mention rows first, then the delivery row.

export const MENTION_RECIPIENT_TYPES = Object.freeze(['user', 'stakeholder']);
export const MENTION_SOURCE_TYPES = Object.freeze(['topic', 'annotation']);
export const MENTION_REASONS = Object.freeze(['mention', 'reply']);

const toTime = (value) => (value ? new Date(value).getTime() : 0);
const toIso = (value) => (value ? new Date(value).toISOString() : null);
const newestScheduled = (rows) => Math.max(...rows.map((row) => toTime(row.scheduledAt)));
const recipientKey = ({ projectId, recipientId, recipientType, tenantId }) => JSON.stringify([tenantId, projectId, recipientType, recipientId]);
const commentKey = ({ commentId, recipientId, recipientType, sourceType }) => JSON.stringify([sourceType, commentId, recipientType, recipientId]);
const live = (delivery, now) => Boolean(delivery) && toTime(delivery.claimedUntil) > toTime(now);
const placeholders = (values) => values.map(() => '?').join(', ');

function mentionRows({ author, projectId, reason = 'mention', recipients = [], scheduledAt, source, tenantId }) {
  const at = new Date(scheduledAt).toISOString();
  return recipients
    .filter((recipient) => MENTION_RECIPIENT_TYPES.includes(recipient.actorType) && recipient.actorId)
    .map((recipient) => ({
      annotationId: source.annotationId ?? null,
      authorId: String(author.actorId),
      authorName: String(author.name ?? '').slice(0, 255),
      authorType: author.actorType,
      commentId: String(source.commentId),
      createdAt: at,
      deliveryId: null,
      id: randomUUID(),
      lastError: '',
      projectId,
      reason: reason === 'reply' ? 'reply' : 'mention',
      recipientId: String(recipient.actorId),
      recipientType: recipient.actorType,
      roundId: source.roundId ?? null,
      scheduledAt: at,
      sentAt: null,
      sourceType: source.type,
      status: 'pending',
      tenantId,
      topicId: source.topicId ?? null,
      updatedAt: at,
    }));
}

export async function ensureMysqlMentionsSchema(executor) {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS requirements_mentions (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      recipient_type VARCHAR(16) NOT NULL,
      recipient_id VARCHAR(64) NOT NULL,
      source_type VARCHAR(16) NOT NULL,
      comment_id VARCHAR(64) NOT NULL,
      topic_id VARCHAR(64) NULL,
      round_id VARCHAR(64) NULL,
      annotation_id VARCHAR(64) NULL,
      author_type VARCHAR(16) NOT NULL,
      author_id VARCHAR(64) NOT NULL,
      author_name VARCHAR(255) NOT NULL DEFAULT '',
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      scheduled_at DATETIME(3) NOT NULL,
      delivery_id VARCHAR(36) NULL,
      sent_at DATETIME(3) NULL,
      last_error TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_requirements_mentions_comment_recipient (source_type, comment_id, recipient_type, recipient_id),
      KEY idx_requirements_mentions_recipient (tenant_id, project_id, recipient_type, recipient_id, status)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS requirements_mention_digests (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      recipient_type VARCHAR(16) NOT NULL,
      recipient_id VARCHAR(64) NOT NULL,
      claim_token VARCHAR(36) NULL,
      claimed_until DATETIME(3) NULL,
      send_started_at DATETIME(3) NULL,
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME(3) NULL,
      last_error TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_requirements_mention_digests_recipient (tenant_id, project_id, recipient_type, recipient_id)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/** Adds the reason column (migration 0076). Rows from before it are all mentions. */
export async function ensureMysqlMentionReasonSchema(executor) {
  const [columns] = await executor.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'requirements_mentions' AND column_name = 'reason'",
  );
  if (columns.length) return;
  await executor.execute("ALTER TABLE requirements_mentions ADD COLUMN reason VARCHAR(16) NOT NULL DEFAULT 'mention' AFTER author_name");
}

/** In-memory store. Every method is synchronous inside, so it is atomic in Node. */
export function createInMemoryMentionsRepository() {
  const state = { deliveries: new Map(), mentions: [] };
  const clone = (value) => structuredClone(value);
  const pendingFor = (recipient) => state.mentions.filter((row) => row.status === 'pending' && recipientKey(row) === recipientKey(recipient));
  const owned = (deliveryId, claimToken) => [...state.deliveries.values()].find((row) => row.id === deliveryId && row.claimToken === claimToken) ?? null;
  const release = (recipient, released, at) => {
    const decisions = new Map(released.map((entry) => [entry.id, entry]));
    for (const row of pendingFor(recipient)) {
      const decision = decisions.get(row.id);
      if (decision) Object.assign(row, { lastError: decision.reason, status: 'released', updatedAt: at });
    }
  };

  return {
    state,

    async recordMentions(input) {
      const known = new Map(state.mentions.map((row) => [commentKey(row), row]));
      const rows = mentionRows(input);
      for (const row of rows) {
        const existing = known.get(commentKey(row));
        if (existing?.status === 'pending' && existing.reason === 'reply' && row.reason === 'mention') Object.assign(existing, { reason: 'mention', updatedAt: row.updatedAt });
      }
      const added = rows.filter((row) => !known.has(commentKey(row)));
      state.mentions.push(...added);
      return added.map(clone);
    },

    async listPendingMentions(recipient) {
      return pendingFor(recipient).map(clone).sort((left, right) => toTime(left.scheduledAt) - toTime(right.scheduledAt));
    },

    async listMentions({ projectId, tenantId } = {}) {
      return state.mentions.filter((row) => (!projectId || row.projectId === projectId) && (!tenantId || row.tenantId === tenantId)).map(clone);
    },

    async listDueMentionDigests({ dueBefore, limit = 50, now }) {
      const latest = new Map();
      for (const row of state.mentions) {
        if (row.status !== 'pending') continue;
        const key = recipientKey(row);
        const current = latest.get(key);
        if (!current || toTime(row.scheduledAt) > toTime(current.lastScheduledAt)) {
          latest.set(key, { lastScheduledAt: row.scheduledAt, projectId: row.projectId, recipientId: row.recipientId, recipientType: row.recipientType, tenantId: row.tenantId });
        }
      }
      return [...latest.entries()]
        .filter(([key, entry]) => {
          const delivery = state.deliveries.get(key);
          const waiting = delivery && (toTime(delivery.claimedUntil) > now.getTime() || toTime(delivery.nextAttemptAt) > now.getTime());
          return !waiting && toTime(entry.lastScheduledAt) < dueBefore.getTime();
        })
        .map(([, entry]) => entry)
        .sort((left, right) => toTime(left.lastScheduledAt) - toTime(right.lastScheduledAt))
        .slice(0, limit);
    },

    async claimMentionDigest({ dueBefore, leaseUntil, now, ...recipient }) {
      const key = recipientKey(recipient);
      const pending = pendingFor(recipient);
      if (!pending.length) {
        state.deliveries.delete(key);
        return null;
      }
      if (newestScheduled(pending) >= dueBefore.getTime()) return null;
      const existing = state.deliveries.get(key);
      if (existing && (toTime(existing.claimedUntil) > now.getTime() || toTime(existing.nextAttemptAt) > now.getTime())) return null;
      const claimToken = randomUUID();
      const interruptedSend = Boolean(existing?.sendStartedAt);
      const row = existing ?? { attempts: 0, id: randomUUID(), lastError: '', nextAttemptAt: null, ...recipient };
      Object.assign(row, { claimedUntil: new Date(leaseUntil).toISOString(), claimToken, sendStartedAt: null });
      state.deliveries.set(key, row);
      return { attempts: row.attempts, claimToken, deliveryId: row.id, interruptedSend };
    },

    async beginMentionDigestSend({ claimToken, deliveryId, dueBefore, leaseUntil, now, sendIds, ...recipient }) {
      const delivery = owned(deliveryId, claimToken);
      if (!delivery || toTime(delivery.claimedUntil) <= now.getTime()) return { ok: false, reason: 'fenced' };
      const pending = pendingFor(recipient);
      const stop = (reason) => {
        Object.assign(delivery, { claimedUntil: null, claimToken: null });
        return { ok: false, reason };
      };
      if (!pending.length || newestScheduled(pending) >= dueBefore.getTime()) return stop('not-due');
      const current = new Set(pending.map((row) => row.id));
      if (sendIds.some((id) => !current.has(id))) return stop('changed');
      Object.assign(delivery, { claimedUntil: new Date(leaseUntil).toISOString(), sendStartedAt: new Date(now).toISOString() });
      return { ok: true };
    },

    async completeMentionDigestSend({ claimToken, deliveryId, now, providerMessageId: _providerMessageId = '', released = [], sentIds = [], ...recipient }) {
      const at = new Date(now).toISOString();
      const sent = new Set(sentIds);
      // Marked even if this owner was fenced meanwhile: the email went out, and marking it
      // stops a later owner from sending the same mentions again.
      for (const row of pendingFor(recipient)) {
        if (sent.has(row.id)) Object.assign(row, { deliveryId, lastError: '', sentAt: at, status: 'sent', updatedAt: at });
      }
      const delivery = owned(deliveryId, claimToken);
      if (live(delivery, now)) release(recipient, released, at);
      if (delivery) state.deliveries.delete(recipientKey(delivery));
    },

    async failMentionDigestAttempt({ claimToken, deliveryId, error, maxAttempts, mentionIds = [], now, retryAt = null, ...recipient }) {
      const delivery = owned(deliveryId, claimToken);
      if (!live(delivery, now)) return { fenced: true };
      const attempts = delivery.attempts + 1;
      const at = new Date(now).toISOString();
      if (retryAt && attempts < maxAttempts) {
        Object.assign(delivery, { attempts, claimedUntil: null, claimToken: null, lastError: error, nextAttemptAt: new Date(retryAt).toISOString(), sendStartedAt: null });
        return { attempts, terminal: false };
      }
      const ids = new Set(mentionIds);
      for (const row of pendingFor(recipient)) {
        if (ids.has(row.id)) Object.assign(row, { lastError: error, status: 'failed', updatedAt: at });
      }
      state.deliveries.delete(recipientKey(delivery));
      return { attempts, terminal: true };
    },

    async releaseMentionDigest({ claimToken, deliveryId, now, released = [], ...recipient }) {
      const delivery = owned(deliveryId, claimToken);
      if (!delivery) return { fenced: true };
      const fenced = !live(delivery, now);
      if (!fenced) release(recipient, released, new Date(now).toISOString());
      state.deliveries.delete(recipientKey(delivery));
      return { fenced };
    },

    /** Gives up the claim before SMTP; the next run renders again. */
    async abortMentionDigestSend({ claimToken, deliveryId }) {
      const delivery = owned(deliveryId, claimToken);
      if (delivery) Object.assign(delivery, { claimedUntil: null, claimToken: null, sendStartedAt: null });
    },

    /** Test and diagnostics access to the delivery row for one recipient. */
    async getMentionDigest(recipient) {
      const row = state.deliveries.get(recipientKey(recipient));
      return row ? clone(row) : null;
    },
  };
}

const MENTION_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, recipient_type AS recipientType, recipient_id AS recipientId,
  source_type AS sourceType, comment_id AS commentId, topic_id AS topicId, round_id AS roundId, annotation_id AS annotationId,
  author_type AS authorType, author_id AS authorId, author_name AS authorName, reason, status, scheduled_at AS scheduledAt,
  delivery_id AS deliveryId, sent_at AS sentAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt`;
const DELIVERY_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, recipient_type AS recipientType, recipient_id AS recipientId,
  claim_token AS claimToken, claimed_until AS claimedUntil, send_started_at AS sendStartedAt, attempts,
  next_attempt_at AS nextAttemptAt, last_error AS lastError`;

function normalizeMention(row) {
  return {
    ...row,
    annotationId: row.annotationId ?? null,
    createdAt: toIso(row.createdAt),
    lastError: row.lastError ?? '',
    reason: row.reason === 'reply' ? 'reply' : 'mention',
    roundId: row.roundId ?? null,
    scheduledAt: toIso(row.scheduledAt),
    sentAt: toIso(row.sentAt),
    topicId: row.topicId ?? null,
    updatedAt: toIso(row.updatedAt),
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
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

/** MySQL store, on the tables of migrations 0074 and 0076. */
export function createMysqlMentionsRepository({ pool }) {
  if (!pool) throw new Error('A MySQL pool is required to create the mentions repository.');

  const recipientWhere = 'tenant_id = ? AND project_id = ? AND recipient_type = ? AND recipient_id = ?';
  const recipientArgs = ({ projectId, recipientId, recipientType, tenantId }) => [tenantId, projectId, recipientType, recipientId];

  async function lockRecipient(connection, recipient) {
    const [rows] = await connection.execute(
      `SELECT ${MENTION_COLUMNS} FROM requirements_mentions WHERE ${recipientWhere} AND status = 'pending' FOR UPDATE`,
      recipientArgs(recipient),
    );
    return rows;
  }
  async function lockDelivery(connection, deliveryId) {
    const [rows] = await connection.execute(`SELECT ${DELIVERY_COLUMNS} FROM requirements_mention_digests WHERE id = ? FOR UPDATE`, [deliveryId]);
    return rows[0] ?? null;
  }
  async function release(connection, recipient, released, now) {
    for (const entry of released) {
      await connection.execute(
        `UPDATE requirements_mentions SET status = 'released', last_error = ?, updated_at = ?
          WHERE ${recipientWhere} AND id = ? AND status = 'pending'`,
        [entry.reason, now, ...recipientArgs(recipient), entry.id],
      );
    }
  }

  return {
    async recordMentions(input) {
      const rows = mentionRows(input);
      if (!rows.length) return [];
      const added = [];
      for (const row of rows) {
        // INSERT IGNORE would also hide other errors; the unique key is the only expected one.
        try {
          await pool.execute(
            `INSERT INTO requirements_mentions
              (id, tenant_id, project_id, recipient_type, recipient_id, source_type, comment_id, topic_id, round_id, annotation_id,
               author_type, author_id, author_name, reason, status, scheduled_at, last_error, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, ?)`,
            [row.id, row.tenantId, row.projectId, row.recipientType, row.recipientId, row.sourceType, row.commentId, row.topicId, row.roundId, row.annotationId,
              row.authorType, row.authorId, row.authorName, row.reason, new Date(row.scheduledAt), new Date(row.createdAt), new Date(row.updatedAt)],
          );
          added.push(row);
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY') throw error;
          if (row.reason === 'mention') {
            await pool.execute(
              `UPDATE requirements_mentions SET reason = 'mention', updated_at = ?
                WHERE source_type = ? AND comment_id = ? AND recipient_type = ? AND recipient_id = ? AND status = 'pending' AND reason = 'reply'`,
              [new Date(row.updatedAt), row.sourceType, row.commentId, row.recipientType, row.recipientId],
            );
          }
        }
      }
      return added;
    },

    async listPendingMentions(recipient) {
      const [rows] = await pool.execute(
        `SELECT ${MENTION_COLUMNS} FROM requirements_mentions WHERE ${recipientWhere} AND status = 'pending' ORDER BY scheduled_at, id`,
        recipientArgs(recipient),
      );
      return rows.map(normalizeMention);
    },

    async listMentions({ projectId, tenantId }) {
      const [rows] = await pool.execute(`SELECT ${MENTION_COLUMNS} FROM requirements_mentions WHERE tenant_id = ? AND project_id = ? ORDER BY created_at, id`, [tenantId, projectId]);
      return rows.map(normalizeMention);
    },

    async listDueMentionDigests({ dueBefore, limit = 50, now }) {
      const [rows] = await pool.execute(
        `SELECT m.tenant_id AS tenantId, m.project_id AS projectId, m.recipient_type AS recipientType, m.recipient_id AS recipientId,
            MAX(m.scheduled_at) AS lastScheduledAt
          FROM requirements_mentions m
          LEFT JOIN requirements_mention_digests d
            ON d.tenant_id = m.tenant_id AND d.project_id = m.project_id AND d.recipient_type = m.recipient_type AND d.recipient_id = m.recipient_id
          WHERE m.status = 'pending'
            AND (d.id IS NULL OR ((d.claimed_until IS NULL OR d.claimed_until <= ?) AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)))
          GROUP BY m.tenant_id, m.project_id, m.recipient_type, m.recipient_id
          HAVING MAX(m.scheduled_at) < ?
          ORDER BY lastScheduledAt
          LIMIT ${Math.max(1, Math.min(500, Number.parseInt(String(limit), 10) || 50))}`,
        [now, now, dueBefore],
      );
      return rows.map((row) => ({ ...row, lastScheduledAt: toIso(row.lastScheduledAt) }));
    },

    async claimMentionDigest({ dueBefore, leaseUntil, now, ...recipient }) {
      return withTransaction(pool, async (connection) => {
        const pending = await lockRecipient(connection, recipient);
        if (!pending.length) {
          await connection.execute(`DELETE FROM requirements_mention_digests WHERE ${recipientWhere}`, recipientArgs(recipient));
          return null;
        }
        if (newestScheduled(pending) >= dueBefore.getTime()) return null;
        const [existingRows] = await connection.execute(`SELECT ${DELIVERY_COLUMNS} FROM requirements_mention_digests WHERE ${recipientWhere} FOR UPDATE`, recipientArgs(recipient));
        const existing = existingRows[0] ?? null;
        if (existing && (toTime(existing.claimedUntil) > now.getTime() || toTime(existing.nextAttemptAt) > now.getTime())) return null;
        const claimToken = randomUUID();
        if (existing) {
          await connection.execute(
            'UPDATE requirements_mention_digests SET claim_token = ?, claimed_until = ?, send_started_at = NULL, updated_at = ? WHERE id = ?',
            [claimToken, leaseUntil, now, existing.id],
          );
          return { attempts: Number(existing.attempts ?? 0), claimToken, deliveryId: existing.id, interruptedSend: Boolean(existing.sendStartedAt) };
        }
        const deliveryId = randomUUID();
        try {
          await connection.execute(
            `INSERT INTO requirements_mention_digests (id, tenant_id, project_id, recipient_type, recipient_id, claim_token, claimed_until, attempts, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [deliveryId, ...recipientArgs(recipient), claimToken, leaseUntil, now, now],
          );
        } catch (error) {
          // The unique recipient key: another sender created the delivery first.
          if (error?.code === 'ER_DUP_ENTRY') return null;
          throw error;
        }
        return { attempts: 0, claimToken, deliveryId, interruptedSend: false };
      });
    },

    async beginMentionDigestSend({ claimToken, deliveryId, dueBefore, leaseUntil, now, sendIds, ...recipient }) {
      return withTransaction(pool, async (connection) => {
        const pending = await lockRecipient(connection, recipient);
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken || toTime(delivery.claimedUntil) <= now.getTime()) return { ok: false, reason: 'fenced' };
        const stop = async (reason) => {
          await connection.execute(
            'UPDATE requirements_mention_digests SET claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ? AND claim_token = ?',
            [now, deliveryId, claimToken],
          );
          return { ok: false, reason };
        };
        if (!pending.length || newestScheduled(pending) >= dueBefore.getTime()) return stop('not-due');
        const current = new Set(pending.map((row) => row.id));
        if (sendIds.some((id) => !current.has(id))) return stop('changed');
        await connection.execute(
          'UPDATE requirements_mention_digests SET claimed_until = ?, send_started_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?',
          [leaseUntil, now, now, deliveryId, claimToken],
        );
        return { ok: true };
      });
    },

    async completeMentionDigestSend({ claimToken, deliveryId, now, providerMessageId: _providerMessageId = '', released = [], sentIds = [], ...recipient }) {
      await withTransaction(pool, async (connection) => {
        await lockRecipient(connection, recipient);
        if (sentIds.length) {
          // Marked even if this owner was fenced meanwhile: the email went out, and marking it
          // stops a later owner from sending the same mentions again.
          await connection.execute(
            `UPDATE requirements_mentions SET status = 'sent', sent_at = ?, delivery_id = ?, last_error = '', updated_at = ?
              WHERE ${recipientWhere} AND status = 'pending' AND id IN (${placeholders(sentIds)})`,
            [now, deliveryId, now, ...recipientArgs(recipient), ...sentIds],
          );
        }
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken) return;
        if (live(delivery, now)) await release(connection, recipient, released, now);
        await connection.execute('DELETE FROM requirements_mention_digests WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
      });
    },

    async failMentionDigestAttempt({ claimToken, deliveryId, error, maxAttempts, mentionIds = [], now, retryAt = null, ...recipient }) {
      return withTransaction(pool, async (connection) => {
        await lockRecipient(connection, recipient);
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken || !live(delivery, now)) return { fenced: true };
        const attempts = Number(delivery.attempts ?? 0) + 1;
        if (retryAt && attempts < maxAttempts) {
          await connection.execute(
            `UPDATE requirements_mention_digests
              SET attempts = ?, next_attempt_at = ?, last_error = ?, claim_token = NULL, claimed_until = NULL, send_started_at = NULL, updated_at = ?
              WHERE id = ? AND claim_token = ?`,
            [attempts, retryAt, error, now, deliveryId, claimToken],
          );
          return { attempts, terminal: false };
        }
        if (mentionIds.length) {
          await connection.execute(
            `UPDATE requirements_mentions SET status = 'failed', last_error = ?, updated_at = ?
              WHERE ${recipientWhere} AND status = 'pending' AND id IN (${placeholders(mentionIds)})`,
            [error, now, ...recipientArgs(recipient), ...mentionIds],
          );
        }
        await connection.execute('DELETE FROM requirements_mention_digests WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
        return { attempts, terminal: true };
      });
    },

    async releaseMentionDigest({ claimToken, deliveryId, now, released = [], ...recipient }) {
      return withTransaction(pool, async (connection) => {
        await lockRecipient(connection, recipient);
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken) return { fenced: true };
        const fenced = !live(delivery, now);
        if (!fenced) await release(connection, recipient, released, now);
        await connection.execute('DELETE FROM requirements_mention_digests WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
        return { fenced };
      });
    },

    /** Gives up the claim before SMTP; the next run renders again. */
    async abortMentionDigestSend({ claimToken, deliveryId, now }) {
      await pool.execute(
        'UPDATE requirements_mention_digests SET claim_token = NULL, claimed_until = NULL, send_started_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ?',
        [now, deliveryId, claimToken],
      );
    },

    async getMentionDigest(recipient) {
      const [rows] = await pool.execute(`SELECT ${DELIVERY_COLUMNS} FROM requirements_mention_digests WHERE ${recipientWhere}`, recipientArgs(recipient));
      return rows[0] ?? null;
    },
  };
}
