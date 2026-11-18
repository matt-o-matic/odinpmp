import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { addWorkspaceMembershipMemory, addWorkspaceMembershipMysql } from './workspace-membership.js';

// Requests to join a workspace, kept in the legacy `user_requests` table. A row stays after it
// is decided or cancelled so that per-user limits survive restarts.

const JOIN_REQUEST_COLUMNS = [
  ['user_id', 'CHAR(36) NULL'],
  ['status', "VARCHAR(16) NOT NULL DEFAULT 'pending'"],
  ['email_verified_at', 'DATETIME(3) NULL'],
  ['verification_method', 'VARCHAR(32) NULL'],
  ['verification_token_hash', 'CHAR(64) NULL'],
  ['verification_expires_at', 'DATETIME(3) NULL'],
  ['verification_sent_at', 'DATETIME(3) NULL'],
  ['decided_at', 'DATETIME(3) NULL'],
  ['decided_by', 'CHAR(36) NULL'],
  ['granted_role', 'VARCHAR(50) NULL'],
];

const JOIN_REQUEST_INDEXES = [
  ['idx_user_requests_user_status', 'CREATE INDEX idx_user_requests_user_status ON user_requests (user_id, status, requested_at)'],
  ['idx_user_requests_tenant_status', 'CREATE INDEX idx_user_requests_tenant_status ON user_requests (tenant_id, status)'],
  ['uq_user_requests_verification_token', 'CREATE UNIQUE INDEX uq_user_requests_verification_token ON user_requests (verification_token_hash)'],
];

async function informationSchemaCount(executor, sql, params) {
  const [rows] = await executor.execute(sql, params);
  return Number(rows[0]?.count ?? 0) > 0;
}

const tableExists = (executor, table) => informationSchemaCount(executor,
  'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
const columnExists = (executor, table, column) => informationSchemaCount(executor,
  'SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
const indexExists = (executor, table, index) => informationSchemaCount(executor,
  'SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [table, index]);

/** Migration 0072: who asked, the email confirmation, and the decision. */
export async function ensureMysqlJoinRequestSchema(executor) {
  if (!await tableExists(executor, 'user_requests')) {
    await executor.execute(`
      CREATE TABLE user_requests (
        id CHAR(36) NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) NOT NULL,
        name VARCHAR(255) NULL,
        email VARCHAR(255) NOT NULL,
        requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ${JOIN_REQUEST_COLUMNS.map(([column, definition]) => `${column} ${definition}`).join(',\n        ')},
        KEY idx_user_requests_tenant_id (tenant_id),
        KEY idx_user_requests_requested_at (requested_at)
      )
    `);
  } else {
    for (const [column, definition] of JOIN_REQUEST_COLUMNS) {
      if (!await columnExists(executor, 'user_requests', column)) {
        await executor.execute(`ALTER TABLE user_requests ADD COLUMN ${column} ${definition}`);
      }
    }
  }
  for (const [index, statement] of JOIN_REQUEST_INDEXES) {
    if (!await indexExists(executor, 'user_requests', index)) await executor.execute(statement);
  }
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function present(row) {
  return {
    decidedAt: toIso(row.decidedAt),
    decidedBy: row.decidedBy ?? null,
    email: row.email,
    emailVerifiedAt: toIso(row.emailVerifiedAt),
    grantedRole: row.grantedRole ?? null,
    id: row.id,
    name: row.name ?? '',
    requestedAt: toIso(row.requestedAt),
    status: row.status,
    tenantId: row.tenantId,
    userId: row.userId,
    verificationExpiresAt: toIso(row.verificationExpiresAt),
    verificationMethod: row.verificationMethod ?? null,
    verificationSentAt: toIso(row.verificationSentAt),
    ...(row.workspaceName === undefined ? {} : { workspaceName: row.workspaceName }),
  };
}

/**
 * Decides which of the requester's limits, if any, stops a new request. `requests` are the
 * requester's own rows. Shared by both repositories so they enforce the same rules.
 */
function blockingOutcome(requests, { isMember, limits, tenantId }) {
  if (isMember) return 'member';
  if (requests.some((row) => row.tenantId === tenantId && row.status === 'pending')) return 'duplicate';
  if (requests.some((row) => row.tenantId === tenantId && row.status === 'declined' && Date.parse(row.decidedAt) >= limits.declinedSince.valueOf())) return 'recently_declined';
  if (requests.filter((row) => row.status === 'pending').length >= limits.maxPending) return 'too_many_pending';
  if (requests.filter((row) => Date.parse(row.requestedAt) >= limits.since.valueOf()).length >= limits.perPeriod) return 'rate_limited';
  return null;
}

export function createInMemoryJoinRequestsRepository({ authRepository } = {}) {
  if (!authRepository?.state) throw new Error('An in-memory authRepository is required for join requests.');
  const state = { requests: [] };
  const users = () => authRepository.state.users;
  const tenantName = (tenantId) => authRepository.state.tenants.find((tenant) => tenant.id === tenantId)?.name ?? '';

  return {
    state,
    async findWorkspacesByName(name) {
      const wanted = String(name ?? '').trim().toLowerCase();
      return authRepository.state.tenants.filter((tenant) => tenant.name.toLowerCase() === wanted).slice(0, 2).map((tenant) => ({ id: tenant.id, name: tenant.name }));
    },
    async createRequest({ email, limits, name, now, tenantId, token, userId, verification }) {
      const user = users().find((row) => row.id === userId);
      const own = state.requests.filter((row) => row.userId === userId);
      const outcome = blockingOutcome(own, { isMember: Boolean(user?.memberships.some((membership) => membership.tenantId === tenantId)), limits, tenantId });
      if (outcome) return { outcome };
      const row = {
        decidedAt: null, decidedBy: null, email, emailVerifiedAt: verification?.verifiedAt ?? null, grantedRole: null,
        id: randomUUID(), name, requestedAt: now.toISOString(), status: 'pending', tenantId, userId,
        verificationExpiresAt: token?.expiresAt?.toISOString() ?? null, verificationMethod: verification?.method ?? null,
        verificationSentAt: token ? now.toISOString() : null, verificationTokenHash: token?.hash ?? null,
      };
      state.requests.push(row);
      return { outcome: 'created', request: present(row) };
    },
    async hasVerifiedEmail({ email, userId }) {
      return state.requests.some((row) => row.userId === userId && row.emailVerifiedAt && row.email.toLowerCase() === String(email).toLowerCase());
    },
    async listForRequester({ since, userId }) {
      return state.requests
        .filter((row) => row.userId === userId && (row.status === 'pending' || Date.parse(row.decidedAt) >= since.valueOf()))
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .map((row) => present({ ...row, workspaceName: tenantName(row.tenantId) }));
    },
    async findById({ requestId }) {
      const row = state.requests.find((entry) => entry.id === requestId);
      return row ? present({ ...row, workspaceName: tenantName(row.tenantId) }) : null;
    },
    async findPendingByTokenHash({ tokenHash }) {
      const row = state.requests.find((entry) => entry.verificationTokenHash === tokenHash && entry.status === 'pending');
      return row ? present({ ...row, workspaceName: tenantName(row.tenantId) }) : null;
    },
    async replaceVerificationToken({ expiresAt, now, requestId, tokenHash, userId }) {
      const row = state.requests.find((entry) => entry.id === requestId && entry.userId === userId && entry.status === 'pending' && !entry.emailVerifiedAt);
      if (!row) return false;
      Object.assign(row, { verificationExpiresAt: expiresAt.toISOString(), verificationSentAt: now.toISOString(), verificationTokenHash: tokenHash });
      return true;
    },
    async markVerified({ method, now, requestId, tokenHash }) {
      // Synchronous check-and-set, so a link works once even if opened twice at the same moment.
      const row = state.requests.find((entry) => entry.id === requestId && entry.verificationTokenHash === tokenHash && entry.status === 'pending' && !entry.emailVerifiedAt);
      if (!row || Date.parse(row.verificationExpiresAt) <= now.valueOf()) return false;
      Object.assign(row, { emailVerifiedAt: now.toISOString(), verificationMethod: method, verificationTokenHash: null });
      return true;
    },
    async cancel({ now, requestId, userId }) {
      const row = state.requests.find((entry) => entry.id === requestId && entry.userId === userId && entry.status === 'pending');
      if (!row) return false;
      Object.assign(row, { decidedAt: now.toISOString(), decidedBy: userId, status: 'cancelled', verificationTokenHash: null });
      return true;
    },
    async listPendingForTenant({ tenantId }) {
      return state.requests
        .filter((row) => row.tenantId === tenantId && row.status === 'pending' && row.emailVerifiedAt)
        .map((row) => present(row));
    },
    async decide({ auditEvent, auditWriter, decidedBy, decision, now, requestId, role, tenantId }) {
      const row = state.requests.find((entry) => entry.id === requestId && entry.tenantId === tenantId && entry.status === 'pending' && entry.emailVerifiedAt);
      if (!row) return null;
      let membershipAdded = false;
      if (decision === 'approved') {
        const user = users().find((entry) => entry.id === row.userId);
        if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) throw requesterChanged();
        membershipAdded = addWorkspaceMembershipMemory(user, { role, tenantId });
      }
      Object.assign(row, { decidedAt: now.toISOString(), decidedBy, grantedRole: decision === 'approved' ? role : null, status: decision, verificationTokenHash: null });
      await auditWriter?.append?.(auditEvent);
      return { membershipAdded, request: present(row) };
    },
    async listWorkspaceAdmins({ tenantId }) {
      return users()
        .filter((user) => user.memberships.some((membership) => membership.tenantId === tenantId && membership.role === 'admin'))
        .map((user) => ({ email: user.email, id: user.id, name: user.name }));
    },
  };
}

function requesterChanged() {
  return new HttpError(409, 'The requester’s account email has changed since they asked. Ask them to send a new request.');
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

// A user_requests table created by 0072 takes the database default collation, which in
// production differs from the legacy tables' (see the clarification digest store), so joins
// name one. The keys are ASCII ids, so matches are the same either way.
const SELECT_REQUEST = `
  SELECT r.id, r.tenant_id AS tenantId, r.user_id AS userId, r.name, r.email, r.status,
    r.requested_at AS requestedAt, r.email_verified_at AS emailVerifiedAt, r.verification_method AS verificationMethod,
    r.verification_expires_at AS verificationExpiresAt, r.verification_sent_at AS verificationSentAt,
    r.decided_at AS decidedAt, r.decided_by AS decidedBy, r.granted_role AS grantedRole, t.name AS workspaceName
  FROM user_requests r
  INNER JOIN tenants t ON t.id = r.tenant_id COLLATE utf8mb4_unicode_ci`;

export function createMysqlJoinRequestsRepository({ pool } = {}) {
  if (!pool) throw new Error('A MySQL pool is required to create the join requests repository.');

  return {
    async findWorkspacesByName(name) {
      const [rows] = await pool.execute('SELECT id, name FROM tenants WHERE LOWER(name) = LOWER(?) LIMIT 2', [String(name ?? '').trim()]);
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },
    async createRequest({ email, limits, name, now, tenantId, token, userId, verification }) {
      return withTransaction(pool, async (connection) => {
        // Serializes this requester's requests so the limits hold under concurrent calls.
        const [users] = await connection.execute('SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [userId]);
        if (!users.length) return { outcome: 'ignored' };
        const [memberships] = await connection.execute('SELECT id FROM user_tenant WHERE user_id = ? AND tenant_id = ? LIMIT 1', [userId, tenantId]);
        const [own] = await connection.execute(
          `SELECT tenant_id AS tenantId, status, requested_at AS requestedAt, decided_at AS decidedAt
           FROM user_requests WHERE user_id = ? AND (status = 'pending' OR requested_at >= ? OR decided_at >= ?)`,
          [userId, limits.since, limits.declinedSince],
        );
        const outcome = blockingOutcome(own.map((row) => ({ ...row, decidedAt: toIso(row.decidedAt), requestedAt: toIso(row.requestedAt) })), { isMember: memberships.length > 0, limits, tenantId });
        if (outcome) return { outcome };
        const id = randomUUID();
        await connection.execute(
          `INSERT INTO user_requests (id, tenant_id, user_id, name, email, requested_at, status, email_verified_at, verification_method,
             verification_token_hash, verification_expires_at, verification_sent_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          [id, tenantId, userId, name, email, now, verification?.verifiedAt ? new Date(verification.verifiedAt) : null, verification?.method ?? null,
            token?.hash ?? null, token?.expiresAt ?? null, token ? now : null],
        );
        const [rows] = await connection.execute(`${SELECT_REQUEST} WHERE r.id = ?`, [id]);
        return { outcome: 'created', request: present(rows[0]) };
      });
    },
    async hasVerifiedEmail({ email, userId }) {
      const [rows] = await pool.execute('SELECT id FROM user_requests WHERE user_id = ? AND LOWER(email) = LOWER(?) AND email_verified_at IS NOT NULL LIMIT 1', [userId, email]);
      return rows.length > 0;
    },
    async listForRequester({ since, userId }) {
      const [rows] = await pool.execute(`${SELECT_REQUEST} WHERE r.user_id = ? AND (r.status = 'pending' OR r.decided_at >= ?) ORDER BY r.requested_at DESC LIMIT 50`, [userId, since]);
      return rows.map(present);
    },
    async findById({ requestId }) {
      const [rows] = await pool.execute(`${SELECT_REQUEST} WHERE r.id = ? LIMIT 1`, [requestId]);
      return rows[0] ? present(rows[0]) : null;
    },
    async findPendingByTokenHash({ tokenHash }) {
      const [rows] = await pool.execute(`${SELECT_REQUEST} WHERE r.verification_token_hash = ? AND r.status = 'pending' LIMIT 1`, [tokenHash]);
      return rows[0] ? present(rows[0]) : null;
    },
    async replaceVerificationToken({ expiresAt, now, requestId, tokenHash, userId }) {
      const [result] = await pool.execute(
        `UPDATE user_requests SET verification_token_hash = ?, verification_expires_at = ?, verification_sent_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending' AND email_verified_at IS NULL`,
        [tokenHash, expiresAt, now, requestId, userId],
      );
      return result.affectedRows > 0;
    },
    async markVerified({ method, now, requestId, tokenHash }) {
      const [result] = await pool.execute(
        `UPDATE user_requests SET email_verified_at = ?, verification_method = ?, verification_token_hash = NULL
         WHERE id = ? AND verification_token_hash = ? AND status = 'pending' AND email_verified_at IS NULL AND verification_expires_at > ?`,
        [now, method, requestId, tokenHash, now],
      );
      return result.affectedRows > 0;
    },
    async cancel({ now, requestId, userId }) {
      const [result] = await pool.execute(
        `UPDATE user_requests SET status = 'cancelled', decided_at = ?, decided_by = ?, verification_token_hash = NULL
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
        [now, userId, requestId, userId],
      );
      return result.affectedRows > 0;
    },
    async listPendingForTenant({ tenantId }) {
      const [rows] = await pool.execute(
        `${SELECT_REQUEST} WHERE r.tenant_id = ? AND r.status = 'pending' AND r.user_id IS NOT NULL AND r.email_verified_at IS NOT NULL
         ORDER BY r.requested_at DESC LIMIT 500`,
        [tenantId],
      );
      return rows.map(present);
    },
    async decide({ auditEvent, auditWriter, decidedBy, decision, now, requestId, role, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `SELECT r.id, r.user_id AS userId, r.email, u.email AS accountEmail FROM user_requests r
           LEFT JOIN users u ON u.id = r.user_id COLLATE utf8mb4_unicode_ci
           WHERE r.id = ? AND r.tenant_id = ? AND r.status = 'pending' AND r.email_verified_at IS NOT NULL LIMIT 1 FOR UPDATE`,
          [requestId, tenantId],
        );
        const row = rows[0];
        if (!row) return null;
        let membershipAdded = false;
        if (decision === 'approved') {
          if (!row.accountEmail || row.accountEmail.toLowerCase() !== row.email.toLowerCase()) throw requesterChanged();
          membershipAdded = await addWorkspaceMembershipMysql(connection, { role, tenantId, userId: row.userId });
        }
        await connection.execute(
          `UPDATE user_requests SET status = ?, decided_at = ?, decided_by = ?, granted_role = ?, verification_token_hash = NULL WHERE id = ?`,
          [decision, now, decidedBy, decision === 'approved' ? role : null, requestId],
        );
        await auditWriter?.append?.(auditEvent, { executor: connection });
        const [updated] = await connection.execute(`${SELECT_REQUEST} WHERE r.id = ?`, [requestId]);
        return { membershipAdded, request: present(updated[0]) };
      });
    },
    async listWorkspaceAdmins({ tenantId }) {
      const [rows] = await pool.execute(
        "SELECT u.id, u.email, u.name FROM user_tenant ut INNER JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = ? AND ut.role = 'admin'",
        [tenantId],
      );
      return rows.map((row) => ({ email: row.email, id: row.id, name: row.name }));
    },
  };
}
