import { randomUUID } from 'node:crypto';

// Durable state for clarification invitation digests.
//
// Invitation rows carry scheduled_at (when a save put the invitation into its stakeholder's
// digest) and, once sent, delivery_id. A stakeholder's digest in one project is due once the
// newest scheduled_at among their scheduled, unsent invitations is more than the quiet
// period old, so every new assignment pushes it back (a trailing debounce, no cap).
//
// project_clarification_invitation_digests holds at most one delivery per tenant, project
// and stakeholder (a unique key). A sender claims it with a token and a lease; every later
// step is a compare-and-set on that token, so an owner whose lease expired is fenced out.
// Nothing is marked sent unless it was in the email that was actually sent, and the
// deadline is checked again under lock right before sending.
//
// Releasing a left-out invitation (unscheduling it) is fenced twice: only an owner whose
// claim and lease are still live may release, and only an invitation whose scheduled_at is
// still the one the decision saw. An owner that lost its claim may still record what its
// sent email contained, but never releases or fails anything a newer owner may now send.
//
// Lock order is always invitation rows first, then the delivery row.

const UNSENT = (invitation) => !invitation.deactivatedAt && !invitation.queuedAt && invitation.mailStatus === 'pending';
const toTime = (value) => (value ? new Date(value).getTime() : 0);
const newestScheduled = (rows) => Math.max(...rows.map((row) => toTime(row.scheduledAt)));
const recipientKey = ({ projectId, stakeholderId, tenantId }) => JSON.stringify([tenantId, projectId, stakeholderId]);

const live = (delivery, now) => Boolean(delivery) && toTime(delivery.claimedUntil) > toTime(now);
const sameTime = (left, right) => Boolean(left) && Boolean(right) && toTime(left) === toTime(right);

/**
 * In-memory scheduling over the repository's invitation state. Synchronous, so it is atomic
 * with the in-memory save that calls it. clarificationIds null covers the whole project.
 */
export function scheduleInvitationsInState(state, { clarificationIds = null, projectId, scheduledAt, stakeholderIds = null, tenantId }, clone = (value) => value) {
  const clarifications = Array.isArray(clarificationIds) ? new Set(clarificationIds) : null;
  const stakeholders = Array.isArray(stakeholderIds) ? new Set(stakeholderIds) : null;
  const at = new Date(scheduledAt).toISOString();
  const scheduled = [];
  for (const invitation of state.projectClarificationInvitations) {
    if (invitation.projectId !== projectId || invitation.tenantId !== tenantId || !UNSENT(invitation) || invitation.scheduledAt) continue;
    if (clarifications && !clarifications.has(invitation.clarificationId)) continue;
    if (stakeholders && !stakeholders.has(invitation.stakeholderId)) continue;
    invitation.scheduledAt = at;
    invitation.updatedAt = at;
    scheduled.push(clone(invitation));
  }
  return scheduled;
}

/** In-memory store. Every method is synchronous inside, so it is atomic in Node. */
export function createInMemoryInvitationDigestStore(state, { clone, normalize }) {
  const deliveries = () => {
    state.clarificationInvitationDigests ??= new Map();
    return state.clarificationInvitationDigests;
  };
  const unsentFor = ({ projectId, stakeholderId, tenantId }) => state.projectClarificationInvitations
    .filter((invitation) => invitation.projectId === projectId && invitation.tenantId === tenantId && invitation.stakeholderId === stakeholderId && UNSENT(invitation));
  const owned = (deliveryId, claimToken) => [...deliveries().values()].find((row) => row.id === deliveryId && row.claimToken === claimToken) ?? null;
  const unschedule = ({ projectId, tenantId }, released, at) => {
    const decisions = new Map(released.map((entry) => [entry.id, entry]));
    for (const invitation of state.projectClarificationInvitations) {
      const decision = decisions.get(invitation.id);
      if (!decision || invitation.projectId !== projectId || invitation.tenantId !== tenantId || invitation.queuedAt) continue;
      if (!sameTime(invitation.scheduledAt, decision.scheduledAt)) continue;
      Object.assign(invitation, { lastError: decision.reason, scheduledAt: null, updatedAt: at });
    }
  };

  return {
    async scheduleClarificationInvitations(input) {
      return scheduleInvitationsInState(state, input, clone);
    },

    async listDueClarificationInvitationDigests({ dueBefore, limit = 50, now }) {
      const latest = new Map();
      for (const invitation of state.projectClarificationInvitations) {
        if (!UNSENT(invitation) || !invitation.scheduledAt) continue;
        const key = recipientKey(invitation);
        const current = latest.get(key);
        if (!current || toTime(invitation.scheduledAt) > toTime(current.lastScheduledAt)) {
          latest.set(key, { lastScheduledAt: invitation.scheduledAt, projectId: invitation.projectId, stakeholderId: invitation.stakeholderId, tenantId: invitation.tenantId });
        }
      }
      return [...latest.entries()]
        .filter(([key, entry]) => {
          const delivery = deliveries().get(key);
          const waiting = delivery && (toTime(delivery.claimedUntil) > now.getTime() || toTime(delivery.nextAttemptAt) > now.getTime());
          return !waiting && toTime(entry.lastScheduledAt) < dueBefore.getTime();
        })
        .map(([, entry]) => entry)
        .sort((left, right) => toTime(left.lastScheduledAt) - toTime(right.lastScheduledAt))
        .slice(0, limit);
    },

    async claimClarificationInvitationDigest({ dueBefore, leaseUntil, now, projectId, stakeholderId, tenantId }) {
      const key = recipientKey({ projectId, stakeholderId, tenantId });
      const scheduled = unsentFor({ projectId, stakeholderId, tenantId }).filter((invitation) => invitation.scheduledAt);
      if (!scheduled.length) {
        deliveries().delete(key);
        return null;
      }
      if (newestScheduled(scheduled) >= dueBefore.getTime()) return null;
      const existing = deliveries().get(key);
      if (existing && (toTime(existing.claimedUntil) > now.getTime() || toTime(existing.nextAttemptAt) > now.getTime())) return null;
      const claimToken = randomUUID();
      const interruptedSend = Boolean(existing?.sendStartedAt);
      const row = existing ?? { attempts: 0, id: randomUUID(), lastError: '', nextAttemptAt: null, projectId, stakeholderId, tenantId };
      Object.assign(row, { claimedUntil: new Date(leaseUntil).toISOString(), claimToken, sendStartedAt: null });
      deliveries().set(key, row);
      return { attempts: row.attempts, claimToken, deliveryId: row.id, interruptedSend };
    },

    async beginClarificationDigestSend({ claimToken, deliveryId, dueBefore, leaseUntil, now, projectId, sendIds, stakeholderId, tenantId }) {
      const delivery = owned(deliveryId, claimToken);
      if (!delivery || toTime(delivery.claimedUntil) <= now.getTime()) return { ok: false, reason: 'fenced' };
      const scheduled = unsentFor({ projectId, stakeholderId, tenantId }).filter((invitation) => invitation.scheduledAt);
      const stop = (reason) => {
        Object.assign(delivery, { claimedUntil: null, claimToken: null });
        return { ok: false, reason };
      };
      if (!scheduled.length || newestScheduled(scheduled) >= dueBefore.getTime()) return stop('not-due');
      const current = new Set(scheduled.map((invitation) => invitation.id));
      if (sendIds.some((id) => !current.has(id))) return stop('changed');
      Object.assign(delivery, { claimedUntil: new Date(leaseUntil).toISOString(), sendStartedAt: new Date(now).toISOString() });
      return { ok: true };
    },

    async completeClarificationDigestSend({ claimToken, deliveryId, now, projectId, providerMessageId = '', released = [], sentIds = [], tenantId }) {
      const at = new Date(now).toISOString();
      const sent = new Set(sentIds);
      // Marked even if this owner was fenced meanwhile: the email went out, and marking it
      // stops a later owner from sending the same topics again.
      for (const invitation of state.projectClarificationInvitations) {
        if (invitation.projectId !== projectId || invitation.tenantId !== tenantId || invitation.queuedAt || !sent.has(invitation.id)) continue;
        Object.assign(invitation, { deliveryId, lastError: '', lastProviderMessageId: providerMessageId, mailStatus: 'sent', queuedAt: at, sentAt: at, updatedAt: at });
      }
      const delivery = owned(deliveryId, claimToken);
      if (live(delivery, now)) unschedule({ projectId, tenantId }, released, at);
      if (delivery) deliveries().delete(recipientKey(delivery));
    },

    async failClarificationDigestAttempt({ claimToken, deliveryId, error, invitationIds = [], maxAttempts, now, projectId, retryAt = null, tenantId }) {
      const delivery = owned(deliveryId, claimToken);
      if (!live(delivery, now)) return { fenced: true };
      const attempts = delivery.attempts + 1;
      const at = new Date(now).toISOString();
      if (retryAt && attempts < maxAttempts) {
        Object.assign(delivery, { attempts, claimedUntil: null, claimToken: null, lastError: error, nextAttemptAt: new Date(retryAt).toISOString(), sendStartedAt: null });
        return { attempts, terminal: false };
      }
      const ids = new Set(invitationIds);
      for (const invitation of state.projectClarificationInvitations) {
        if (invitation.projectId !== projectId || invitation.tenantId !== tenantId || invitation.queuedAt || !ids.has(invitation.id)) continue;
        Object.assign(invitation, { lastError: error, mailStatus: 'failed', queuedAt: at, updatedAt: at });
      }
      deliveries().delete(recipientKey(delivery));
      return { attempts, terminal: true };
    },

    async releaseClarificationDigest({ claimToken, deliveryId, now, projectId, released = [], tenantId }) {
      const delivery = owned(deliveryId, claimToken);
      if (!delivery) return { fenced: true };
      const fenced = !live(delivery, now);
      if (!fenced) unschedule({ projectId, tenantId }, released, new Date(now).toISOString());
      deliveries().delete(recipientKey(delivery));
      return { fenced };
    },

    /** Gives up the claim before SMTP; the next run renders again. */
    async abortClarificationDigestSend({ claimToken, deliveryId }) {
      const delivery = owned(deliveryId, claimToken);
      if (delivery) Object.assign(delivery, { claimedUntil: null, claimToken: null, sendStartedAt: null });
    },

    /** Test and diagnostics access to the delivery row for one recipient. */
    async getClarificationInvitationDigest(recipient) {
      const row = deliveries().get(recipientKey(recipient));
      return row ? clone(row) : null;
    },
  };
}

const UNSENT_SQL = "deactivated_at IS NULL AND queued_at IS NULL AND mail_status = 'pending'";
const INVITATION_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, clarification_id AS clarificationId, stakeholder_id AS stakeholderId,
  mail_status AS mailStatus, queued_at AS queuedAt, deactivated_at AS deactivatedAt, scheduled_at AS scheduledAt`;
const DELIVERY_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, stakeholder_id AS stakeholderId, claim_token AS claimToken,
  claimed_until AS claimedUntil, send_started_at AS sendStartedAt, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError`;
const placeholders = (values) => values.map(() => '?').join(', ');

/**
 * MySQL scheduling, run on the caller's connection so it commits or rolls back with the save
 * that invites the stakeholders. clarificationIds null covers the whole project.
 */
export async function scheduleInvitationsMysql(executor, { clarificationIds = null, projectId, scheduledAt, stakeholderIds = null, tenantId }) {
  const ids = Array.isArray(clarificationIds) ? [...new Set(clarificationIds)].filter(Boolean) : null;
  if ((ids && !ids.length) || (Array.isArray(stakeholderIds) && !stakeholderIds.length)) return [];
  const clarificationFilter = ids ? ` AND clarification_id IN (${placeholders(ids)})` : '';
  const stakeholderFilter = Array.isArray(stakeholderIds) ? ` AND stakeholder_id IN (${placeholders(stakeholderIds)})` : '';
  const [rows] = await executor.execute(
    `SELECT ${INVITATION_COLUMNS} FROM project_clarification_invitations
      WHERE tenant_id = ? AND project_id = ?${clarificationFilter}${stakeholderFilter} AND ${UNSENT_SQL} AND scheduled_at IS NULL
      FOR UPDATE`,
    [tenantId, projectId, ...(ids ?? []), ...(Array.isArray(stakeholderIds) ? stakeholderIds : [])],
  );
  if (!rows.length) return [];
  await executor.execute(
    `UPDATE project_clarification_invitations SET scheduled_at = ?, updated_at = ? WHERE id IN (${placeholders(rows)})`,
    [scheduledAt, scheduledAt, ...rows.map((row) => row.id)],
  );
  return rows.map((row) => ({ ...row, scheduledAt }));
}

/** MySQL store. */
export function createMysqlInvitationDigestStore({ normalize, pool, withTransaction }) {
  async function lockRecipient(connection, { projectId, stakeholderId, tenantId }) {
    const [rows] = await connection.execute(
      `SELECT ${INVITATION_COLUMNS} FROM project_clarification_invitations
        WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ? AND ${UNSENT_SQL}
        FOR UPDATE`,
      [tenantId, projectId, stakeholderId],
    );
    return rows.filter((row) => row.scheduledAt);
  }
  async function lockDelivery(connection, deliveryId) {
    const [rows] = await connection.execute(`SELECT ${DELIVERY_COLUMNS} FROM project_clarification_invitation_digests WHERE id = ? FOR UPDATE`, [deliveryId]);
    return rows[0] ?? null;
  }
  async function unschedule(connection, { projectId, tenantId }, released, now) {
    for (const entry of released) {
      if (!entry.scheduledAt) continue;
      await connection.execute(
        `UPDATE project_clarification_invitations SET scheduled_at = NULL, last_error = ?, updated_at = ?
          WHERE tenant_id = ? AND project_id = ? AND id = ? AND queued_at IS NULL AND scheduled_at = ?`,
        [entry.reason, now, tenantId, projectId, entry.id, new Date(entry.scheduledAt)],
      );
    }
  }

  return {
    async scheduleClarificationInvitations(input) {
      return withTransaction(pool, async (connection) => {
        return (await scheduleInvitationsMysql(connection, input)).map((row) => normalize(row));
      });
    },

    async listDueClarificationInvitationDigests({ dueBefore, limit = 50, now }) {
      // The two tables can have different collations: in production the invitations table is
      // utf8mb4_0900_ai_ci and the digests table took the database default, utf8mb4_unicode_ci.
      // Comparing their columns directly fails with ER_CANT_AGGREGATE_2COLLATIONS, so the join
      // names one collation. The keys are ASCII ids, so the matches are the same either way.
      const [rows] = await pool.execute(
        `SELECT i.tenant_id AS tenantId, i.project_id AS projectId, i.stakeholder_id AS stakeholderId, MAX(i.scheduled_at) AS lastScheduledAt
          FROM project_clarification_invitations i
          LEFT JOIN project_clarification_invitation_digests d
            ON d.tenant_id = i.tenant_id COLLATE utf8mb4_unicode_ci
            AND d.project_id = i.project_id COLLATE utf8mb4_unicode_ci
            AND d.stakeholder_id = i.stakeholder_id COLLATE utf8mb4_unicode_ci
          WHERE i.deactivated_at IS NULL AND i.queued_at IS NULL AND i.mail_status = 'pending' AND i.scheduled_at IS NOT NULL
            AND (d.id IS NULL OR ((d.claimed_until IS NULL OR d.claimed_until <= ?) AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)))
          GROUP BY i.tenant_id, i.project_id, i.stakeholder_id
          HAVING MAX(i.scheduled_at) < ?
          ORDER BY lastScheduledAt
          LIMIT ${Math.max(1, Math.min(500, Number.parseInt(String(limit), 10) || 50))}`,
        [now, now, dueBefore],
      );
      return rows.map((row) => ({ lastScheduledAt: row.lastScheduledAt ? new Date(row.lastScheduledAt).toISOString() : null, projectId: row.projectId, stakeholderId: row.stakeholderId, tenantId: row.tenantId }));
    },

    async claimClarificationInvitationDigest({ dueBefore, leaseUntil, now, projectId, stakeholderId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const scheduled = await lockRecipient(connection, { projectId, stakeholderId, tenantId });
        if (!scheduled.length) {
          await connection.execute('DELETE FROM project_clarification_invitation_digests WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ?', [tenantId, projectId, stakeholderId]);
          return null;
        }
        if (newestScheduled(scheduled) >= dueBefore.getTime()) return null;
        const [existingRows] = await connection.execute(
          `SELECT ${DELIVERY_COLUMNS} FROM project_clarification_invitation_digests WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ? FOR UPDATE`,
          [tenantId, projectId, stakeholderId],
        );
        const existing = existingRows[0] ?? null;
        if (existing && (toTime(existing.claimedUntil) > now.getTime() || toTime(existing.nextAttemptAt) > now.getTime())) return null;
        const claimToken = randomUUID();
        if (existing) {
          await connection.execute(
            'UPDATE project_clarification_invitation_digests SET claim_token = ?, claimed_until = ?, send_started_at = NULL, updated_at = ? WHERE id = ?',
            [claimToken, leaseUntil, now, existing.id],
          );
          return { attempts: Number(existing.attempts ?? 0), claimToken, deliveryId: existing.id, interruptedSend: Boolean(existing.sendStartedAt) };
        }
        const deliveryId = randomUUID();
        try {
          await connection.execute(
            `INSERT INTO project_clarification_invitation_digests (id, tenant_id, project_id, stakeholder_id, claim_token, claimed_until, attempts, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [deliveryId, tenantId, projectId, stakeholderId, claimToken, leaseUntil, now, now],
          );
        } catch (error) {
          // The unique recipient key: another sender created the delivery first.
          if (error?.code === 'ER_DUP_ENTRY') return null;
          throw error;
        }
        return { attempts: 0, claimToken, deliveryId, interruptedSend: false };
      });
    },

    async beginClarificationDigestSend({ claimToken, deliveryId, dueBefore, leaseUntil, now, projectId, sendIds, stakeholderId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const scheduled = await lockRecipient(connection, { projectId, stakeholderId, tenantId });
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken || toTime(delivery.claimedUntil) <= now.getTime()) return { ok: false, reason: 'fenced' };
        const stop = async (reason) => {
          await connection.execute(
            'UPDATE project_clarification_invitation_digests SET claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ? AND claim_token = ?',
            [now, deliveryId, claimToken],
          );
          return { ok: false, reason };
        };
        if (!scheduled.length || newestScheduled(scheduled) >= dueBefore.getTime()) return stop('not-due');
        const current = new Set(scheduled.map((row) => row.id));
        if (sendIds.some((id) => !current.has(id))) return stop('changed');
        await connection.execute(
          'UPDATE project_clarification_invitation_digests SET claimed_until = ?, send_started_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?',
          [leaseUntil, now, now, deliveryId, claimToken],
        );
        return { ok: true };
      });
    },

    async completeClarificationDigestSend({ claimToken, deliveryId, now, projectId, providerMessageId = '', released = [], sentIds = [], stakeholderId, tenantId }) {
      await withTransaction(pool, async (connection) => {
        await lockRecipient(connection, { projectId, stakeholderId, tenantId });
        if (sentIds.length) {
          // Marked even if this owner was fenced meanwhile: the email went out, and marking it
          // stops a later owner from sending the same topics again.
          await connection.execute(
            `UPDATE project_clarification_invitations
              SET mail_status = 'sent', queued_at = ?, sent_at = ?, delivery_id = ?, last_error = '', last_provider_message_id = ?, updated_at = ?
              WHERE tenant_id = ? AND project_id = ? AND queued_at IS NULL AND id IN (${placeholders(sentIds)})`,
            [now, now, deliveryId, providerMessageId, now, tenantId, projectId, ...sentIds],
          );
        }
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken) return;
        if (live(delivery, now)) await unschedule(connection, { projectId, tenantId }, released, now);
        await connection.execute('DELETE FROM project_clarification_invitation_digests WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
      });
    },

    async failClarificationDigestAttempt({ claimToken, deliveryId, error, invitationIds = [], maxAttempts, now, projectId, retryAt = null, stakeholderId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        await lockRecipient(connection, { projectId, stakeholderId, tenantId });
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken || !live(delivery, now)) return { fenced: true };
        const attempts = Number(delivery.attempts ?? 0) + 1;
        if (retryAt && attempts < maxAttempts) {
          await connection.execute(
            `UPDATE project_clarification_invitation_digests
              SET attempts = ?, next_attempt_at = ?, last_error = ?, claim_token = NULL, claimed_until = NULL, send_started_at = NULL, updated_at = ?
              WHERE id = ? AND claim_token = ?`,
            [attempts, retryAt, error, now, deliveryId, claimToken],
          );
          return { attempts, terminal: false };
        }
        if (invitationIds.length) {
          await connection.execute(
            `UPDATE project_clarification_invitations SET mail_status = 'failed', queued_at = ?, last_error = ?, updated_at = ?
              WHERE tenant_id = ? AND project_id = ? AND queued_at IS NULL AND id IN (${placeholders(invitationIds)})`,
            [now, error, now, tenantId, projectId, ...invitationIds],
          );
        }
        await connection.execute('DELETE FROM project_clarification_invitation_digests WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
        return { attempts, terminal: true };
      });
    },

    async releaseClarificationDigest({ claimToken, deliveryId, now, projectId, released = [], stakeholderId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        await lockRecipient(connection, { projectId, stakeholderId, tenantId });
        const delivery = await lockDelivery(connection, deliveryId);
        if (!delivery || delivery.claimToken !== claimToken) return { fenced: true };
        const fenced = !live(delivery, now);
        if (!fenced) await unschedule(connection, { projectId, tenantId }, released, now);
        await connection.execute('DELETE FROM project_clarification_invitation_digests WHERE id = ? AND claim_token = ?', [deliveryId, claimToken]);
        return { fenced };
      });
    },

    /** Gives up the claim before SMTP; the next run renders again. */
    async abortClarificationDigestSend({ claimToken, deliveryId, now }) {
      await pool.execute(
        'UPDATE project_clarification_invitation_digests SET claim_token = NULL, claimed_until = NULL, send_started_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ?',
        [now, deliveryId, claimToken],
      );
    },

    async getClarificationInvitationDigest({ projectId, stakeholderId, tenantId }) {
      const [rows] = await pool.execute(`SELECT ${DELIVERY_COLUMNS} FROM project_clarification_invitation_digests WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ?`, [tenantId, projectId, stakeholderId]);
      return rows[0] ?? null;
    },
  };
}
