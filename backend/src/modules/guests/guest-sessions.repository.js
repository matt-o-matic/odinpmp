// Storage for guest sign-in codes and sessions (migration 0098, guest-sessions-schema.js). Codes
// and session tokens are kept only as SHA-256 hashes. Times are written with FROM_UNIXTIME and
// read with UNIX_TIMESTAMP, as access links are, so the session time zone never shifts an expiry.

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

const msOf = (value) => (value instanceof Date ? value.valueOf() : Date.parse(value));

function unixSeconds(value) {
  const ms = msOf(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function fromUnix(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)).toISOString() : null;
}

function presentCode(record) {
  return record ? { accessLinkId: record.accessLinkId, attempts: Number(record.attempts ?? 0), codeHash: record.codeHash, sentAt: toIso(record.sentAt), tenantId: record.tenantId, usedAt: toIso(record.usedAt) } : null;
}

function presentSession(record) {
  return record
    ? {
        accessLinkId: record.accessLinkId,
        createdAt: toIso(record.createdAt),
        expiresAt: toIso(record.expiresAt),
        id: record.id,
        ip: record.ip ?? '',
        lastSeenAt: toIso(record.lastSeenAt),
        revokedAt: toIso(record.revokedAt),
        tenantId: record.tenantId,
        userAgent: record.userAgent ?? '',
      }
    : null;
}

export function createInMemoryGuestSessionsRepository() {
  const state = { codes: [], sessions: [] };
  const codeOf = (accessLinkId) => state.codes.find((code) => code.accessLinkId === accessLinkId) ?? null;

  return {
    state,
    async saveSignInCode({ accessLinkId, codeHash, sentAt, tenantId }) {
      state.codes = state.codes.filter((code) => code.accessLinkId !== accessLinkId);
      state.codes.push({ accessLinkId, attempts: 0, codeHash, sentAt: toIso(sentAt), tenantId, usedAt: null });
    },
    async getSignInCode({ accessLinkId }) {
      return presentCode(codeOf(accessLinkId));
    },
    // Counts a wrong try on the code that is outstanding now; returns the tries so far.
    async recordCodeAttempt({ accessLinkId, codeHash }) {
      const code = codeOf(accessLinkId);
      if (!code || code.codeHash !== codeHash || code.usedAt) return null;
      code.attempts += 1;
      return code.attempts;
    },
    // Uses the code once: true for the one request that got it.
    async useSignInCode({ accessLinkId, at, codeHash, maxAttempts }) {
      const code = codeOf(accessLinkId);
      if (!code || code.codeHash !== codeHash || code.usedAt || code.attempts >= maxAttempts) return false;
      code.usedAt = toIso(at);
      return true;
    },
    async clearSignInCode({ accessLinkId, codeHash }) {
      state.codes = state.codes.filter((code) => !(code.accessLinkId === accessLinkId && code.codeHash === codeHash));
    },
    async createSession(session) {
      const stored = { ...session, createdAt: toIso(session.createdAt), expiresAt: toIso(session.expiresAt), lastSeenAt: toIso(session.lastSeenAt), revokedAt: null };
      state.sessions.push(stored);
      return presentSession(stored);
    },
    async findSessionByTokenHash({ tokenHash }) {
      return presentSession(state.sessions.find((session) => session.tokenHash === tokenHash) ?? null);
    },
    // Moves the expiry on from this use, unless the session has ended. True when it moved.
    async touchSession({ at, expiresAt, id }) {
      const session = state.sessions.find((entry) => entry.id === id);
      if (!session || session.revokedAt || msOf(session.expiresAt) <= msOf(at)) return false;
      Object.assign(session, { expiresAt: toIso(expiresAt), lastSeenAt: toIso(at) });
      return true;
    },
    async revokeSession({ at, id }) {
      const session = state.sessions.find((entry) => entry.id === id);
      if (session && !session.revokedAt) session.revokedAt = toIso(at);
    },
    async revokeSessionsForLink({ accessLinkId, at }) {
      let revoked = 0;
      for (const session of state.sessions) {
        if (session.accessLinkId === accessLinkId && !session.revokedAt) {
          session.revokedAt = toIso(at);
          revoked += 1;
        }
      }
      return revoked;
    },
    // When each link's guest last used any session, for "last seen".
    async lastSeenByLinks({ accessLinkIds }) {
      const seen = new Map();
      for (const session of state.sessions) {
        if (!accessLinkIds.includes(session.accessLinkId)) continue;
        const previous = seen.get(session.accessLinkId);
        if (!previous || session.lastSeenAt > previous) seen.set(session.accessLinkId, session.lastSeenAt);
      }
      return seen;
    },
  };
}

const CODE_COLUMNS = 'access_link_id AS accessLinkId, tenant_id AS tenantId, code_hash AS codeHash, UNIX_TIMESTAMP(sent_at) AS sentAt, attempts, UNIX_TIMESTAMP(used_at) AS usedAt';
const SESSION_COLUMNS = `id, tenant_id AS tenantId, access_link_id AS accessLinkId, ip, user_agent AS userAgent,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(last_seen_at) AS lastSeenAt, UNIX_TIMESTAMP(expires_at) AS expiresAt, UNIX_TIMESTAMP(revoked_at) AS revokedAt`;

const codeFromRow = (row) => presentCode({ ...row, sentAt: fromUnix(row.sentAt), usedAt: fromUnix(row.usedAt) });
const sessionFromRow = (row) => presentSession({ ...row, createdAt: fromUnix(row.createdAt), expiresAt: fromUnix(row.expiresAt), lastSeenAt: fromUnix(row.lastSeenAt), revokedAt: fromUnix(row.revokedAt) });

export function createMysqlGuestSessionsRepository({ pool }) {
  return {
    async saveSignInCode({ accessLinkId, codeHash, sentAt, tenantId }) {
      await pool.execute(
        `INSERT INTO access_sign_in_codes (access_link_id, tenant_id, code_hash, sent_at, attempts, used_at) VALUES (?, ?, ?, FROM_UNIXTIME(?), 0, NULL)
         ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), code_hash = VALUES(code_hash), sent_at = VALUES(sent_at), attempts = 0, used_at = NULL`,
        [accessLinkId, tenantId, codeHash, unixSeconds(sentAt)],
      );
    },
    async getSignInCode({ accessLinkId }) {
      const [rows] = await pool.execute(`SELECT ${CODE_COLUMNS} FROM access_sign_in_codes WHERE access_link_id = ? LIMIT 1`, [accessLinkId]);
      return rows[0] ? codeFromRow(rows[0]) : null;
    },
    async recordCodeAttempt({ accessLinkId, codeHash }) {
      const [result] = await pool.execute('UPDATE access_sign_in_codes SET attempts = attempts + 1 WHERE access_link_id = ? AND code_hash = ? AND used_at IS NULL', [accessLinkId, codeHash]);
      if (!result.affectedRows) return null;
      const [rows] = await pool.execute('SELECT attempts FROM access_sign_in_codes WHERE access_link_id = ?', [accessLinkId]);
      return Number(rows[0]?.attempts ?? 0);
    },
    async useSignInCode({ accessLinkId, at, codeHash, maxAttempts }) {
      const [result] = await pool.execute(
        'UPDATE access_sign_in_codes SET used_at = FROM_UNIXTIME(?) WHERE access_link_id = ? AND code_hash = ? AND used_at IS NULL AND attempts < ?',
        [unixSeconds(at), accessLinkId, codeHash, maxAttempts],
      );
      return result.affectedRows === 1;
    },
    async clearSignInCode({ accessLinkId, codeHash }) {
      await pool.execute('DELETE FROM access_sign_in_codes WHERE access_link_id = ? AND code_hash = ?', [accessLinkId, codeHash]);
    },
    async createSession({ accessLinkId, createdAt, expiresAt, id, ip = '', lastSeenAt, tenantId, tokenHash, userAgent = '' }) {
      await pool.execute(
        `INSERT INTO access_sessions (id, tenant_id, access_link_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?)`,
        [id, tenantId, accessLinkId, tokenHash, unixSeconds(createdAt), unixSeconds(lastSeenAt), unixSeconds(expiresAt), String(ip).slice(0, 100), String(userAgent).slice(0, 512)],
      );
      const [rows] = await pool.execute(`SELECT ${SESSION_COLUMNS} FROM access_sessions WHERE id = ?`, [id]);
      return sessionFromRow(rows[0]);
    },
    async findSessionByTokenHash({ tokenHash }) {
      const [rows] = await pool.execute(`SELECT ${SESSION_COLUMNS} FROM access_sessions WHERE token_hash = ? LIMIT 1`, [tokenHash]);
      return rows[0] ? sessionFromRow(rows[0]) : null;
    },
    async touchSession({ at, expiresAt, id }) {
      const [result] = await pool.execute(
        'UPDATE access_sessions SET last_seen_at = FROM_UNIXTIME(?), expires_at = FROM_UNIXTIME(?) WHERE id = ? AND revoked_at IS NULL AND expires_at > FROM_UNIXTIME(?)',
        [unixSeconds(at), unixSeconds(expiresAt), id, unixSeconds(at)],
      );
      return result.affectedRows === 1;
    },
    async revokeSession({ at, id }) {
      await pool.execute('UPDATE access_sessions SET revoked_at = FROM_UNIXTIME(?) WHERE id = ? AND revoked_at IS NULL', [unixSeconds(at), id]);
    },
    async revokeSessionsForLink({ accessLinkId, at }) {
      const [result] = await pool.execute('UPDATE access_sessions SET revoked_at = FROM_UNIXTIME(?) WHERE access_link_id = ? AND revoked_at IS NULL', [unixSeconds(at), accessLinkId]);
      return result.affectedRows;
    },
    async lastSeenByLinks({ accessLinkIds }) {
      const seen = new Map();
      if (!accessLinkIds.length) return seen;
      const [rows] = await pool.query('SELECT access_link_id AS accessLinkId, UNIX_TIMESTAMP(MAX(last_seen_at)) AS lastSeenAt FROM access_sessions WHERE access_link_id IN (?) GROUP BY access_link_id', [accessLinkIds]);
      for (const row of rows) seen.set(row.accessLinkId, fromUnix(row.lastSeenAt));
      return seen;
    },
  };
}
