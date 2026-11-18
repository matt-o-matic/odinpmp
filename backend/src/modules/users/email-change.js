import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { EMAIL_CHANGE_CONFIRM_TEMPLATE_ID, EMAIL_CHANGE_NOTICE_TEMPLATE_ID } from '../mail/account-email.templates.js';

// Changing an account's email address. The profile form only asks for the change: the account
// keeps its old address until someone opens the link emailed to the new one, and the old
// address is told about the request. Without this, a person could point their account at
// someone else's address, and a Google sign-in with that address would land in their account.

export const EMAIL_CHANGE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const LINK_UNUSABLE = 'This link has expired or was already used. Change your email in your profile again to get a new one.';

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const iso = (value) => (value ? new Date(value).toISOString() : null);

export async function ensureMysqlEmailChangeSchema(executor) {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS email_change_requests (
      id CHAR(36) NOT NULL PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      old_email VARCHAR(255) NOT NULL,
      new_email VARCHAR(255) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      confirmed_at DATETIME(3) NULL,
      superseded_at DATETIME(3) NULL,
      UNIQUE KEY uq_email_change_token (token_hash),
      KEY idx_email_change_user (user_id)
    )
  `);
}

const fromRow = (row) => (row ? {
  confirmedAt: iso(row.confirmed_at ?? row.confirmedAt),
  expiresAt: iso(row.expires_at ?? row.expiresAt),
  id: row.id,
  newEmail: row.new_email ?? row.newEmail,
  oldEmail: row.old_email ?? row.oldEmail,
  supersededAt: iso(row.superseded_at ?? row.supersededAt),
  userId: row.user_id ?? row.userId,
} : null);

export function createInMemoryEmailChangeRepository() {
  const rows = [];
  const open = (row, now) => !row.confirmedAt && !row.supersededAt && Date.parse(row.expiresAt) > now.valueOf();
  return {
    rows,
    async replacePending({ expiresAt, newEmail, now, oldEmail, tokenHash, userId }) {
      for (const row of rows) if (row.userId === userId && !row.confirmedAt && !row.supersededAt) row.supersededAt = now.toISOString();
      const row = { confirmedAt: null, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(), id: randomUUID(), newEmail, oldEmail, supersededAt: null, tokenHash, userId };
      rows.push(row);
      return fromRow(row);
    },
    async findPendingForUser({ now, userId }) {
      return fromRow([...rows].reverse().find((row) => row.userId === userId && open(row, now)) ?? null);
    },
    async findOpenByTokenHash({ now, tokenHash }) {
      return fromRow(rows.find((row) => row.tokenHash === tokenHash && open(row, now)) ?? null);
    },
    async markConfirmed({ id, now }) {
      const row = rows.find((entry) => entry.id === id && !entry.confirmedAt && !entry.supersededAt);
      if (!row) return false;
      row.confirmedAt = now.toISOString();
      return true;
    },
  };
}

export function createMysqlEmailChangeRepository({ pool }) {
  return {
    async replacePending({ expiresAt, newEmail, now, oldEmail, tokenHash, userId }) {
      const id = randomUUID();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('UPDATE email_change_requests SET superseded_at = ? WHERE user_id = ? AND confirmed_at IS NULL AND superseded_at IS NULL', [now, userId]);
        await connection.execute(
          'INSERT INTO email_change_requests (id, user_id, old_email, new_email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, userId, oldEmail, newEmail, tokenHash, expiresAt, now],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      return fromRow({ expires_at: expiresAt, id, new_email: newEmail, old_email: oldEmail, user_id: userId });
    },
    async findPendingForUser({ now, userId }) {
      const [rows] = await pool.execute(
        'SELECT * FROM email_change_requests WHERE user_id = ? AND confirmed_at IS NULL AND superseded_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
        [userId, now],
      );
      return fromRow(rows[0]);
    },
    async findOpenByTokenHash({ now, tokenHash }) {
      const [rows] = await pool.execute(
        'SELECT * FROM email_change_requests WHERE token_hash = ? AND confirmed_at IS NULL AND superseded_at IS NULL AND expires_at > ? LIMIT 1',
        [tokenHash, now],
      );
      return fromRow(rows[0]);
    },
    async markConfirmed({ id, now }) {
      const [result] = await pool.execute(
        'UPDATE email_change_requests SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND superseded_at IS NULL',
        [now, id],
      );
      return result.affectedRows === 1;
    },
  };
}

function appBase(deps) {
  return String(deps.frontendAppUrl || 'http://localhost:5173/app').replace(/\/$/, '');
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function queueTemplate(deps, { recipientEmail, templateId, vars }) {
  if (!deps.mailRepository?.queueMail) return false;
  try {
    const escaped = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, escapeText(value)]));
    const rendered = await renderEmailFromTemplate({ mailRepository: deps.mailRepository, templateId, vars: escaped });
    // A fresh target per email: the queue skips a second email with the same target.
    return await deps.mailRepository.queueMail({ body: rendered.body, recipientEmail, subject: rendered.subject, targetId: randomUUID(), templateId });
  } catch (error) {
    logBackendError({ context: buildOperationLogContext('users.emailChange.mail', { templateId }), error, level: 'warn', message: 'An email change email could not be queued.' });
    return false;
  }
}

/**
 * Asks to move `account` (the stored user) to `newEmail`. The address in use stays until the
 * link is opened. Returns the pending address, or null when `newEmail` is the current one.
 */
export async function requestEmailChange(deps, { account, newEmail }) {
  const next = normalizeEmail(newEmail);
  const current = normalizeEmail(account.email);
  if (!next || next === current) return null;
  if (!deps.emailChangeRepository) throw new HttpError(503, 'Email changes are not available right now.');
  const holder = await deps.authRepository.findUserByEmail(next);
  if (holder && holder.id !== account.id) throw new HttpError(409, 'Another account already uses that email address.', { details: { code: 'email_in_use' } });

  const now = deps.clock ? deps.clock() : new Date();
  const token = randomBytes(32).toString('base64url');
  const pending = await deps.emailChangeRepository.replacePending({
    expiresAt: new Date(now.valueOf() + EMAIL_CHANGE_LIFETIME_MS),
    newEmail: next,
    now,
    oldEmail: current,
    tokenHash: hashToken(token),
    userId: account.id,
  });
  const name = account.name || 'there';
  // The token rides in the fragment, which browsers never send to a server or put in a Referer.
  await queueTemplate(deps, { recipientEmail: next, templateId: EMAIL_CHANGE_CONFIRM_TEMPLATE_ID, vars: { confirmUrl: `${appBase(deps)}/account/confirm-email#${token}`, name, newEmail: next } });
  await queueTemplate(deps, { recipientEmail: current, templateId: EMAIL_CHANGE_NOTICE_TEMPLATE_ID, vars: { name, newEmail: next, profileUrl: `${appBase(deps)}/user` } });
  return pending.newEmail;
}

/** The address an account asked to move to and hasn't confirmed yet, or null. */
export async function pendingEmailFor(deps, userId) {
  if (!deps.emailChangeRepository) return null;
  const pending = await deps.emailChangeRepository.findPendingForUser({ now: deps.clock ? deps.clock() : new Date(), userId });
  return pending?.newEmail ?? null;
}

/** Opens an emailed link: the account's address becomes the new one. */
export async function confirmEmailChange(deps, { token }) {
  if (!deps.emailChangeRepository) throw new HttpError(410, LINK_UNUSABLE);
  const now = deps.clock ? deps.clock() : new Date();
  const pending = await deps.emailChangeRepository.findOpenByTokenHash({ now, tokenHash: hashToken(token) });
  if (!pending) throw new HttpError(410, LINK_UNUSABLE);
  // The request was made for the address the account had then; a change since voids it.
  const account = await deps.authRepository.findUserById(pending.userId);
  if (!account || normalizeEmail(account.email) !== pending.oldEmail) throw new HttpError(410, LINK_UNUSABLE);
  const holder = await deps.authRepository.findUserByEmail(pending.newEmail);
  if (holder && holder.id !== account.id) throw new HttpError(409, 'Another account already uses that email address.', { details: { code: 'email_in_use' } });
  if (!await deps.emailChangeRepository.markConfirmed({ id: pending.id, now })) throw new HttpError(410, LINK_UNUSABLE);
  await deps.usersRepository.updateEmail({ email: pending.newEmail, userId: account.id });
  return { email: pending.newEmail, ok: true };
}
