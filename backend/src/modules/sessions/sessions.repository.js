import { randomUUID } from 'node:crypto';

// How long a session still accepts the refresh token it just replaced (0104_refresh_grace). Two
// refreshes can race (two windows, or a window coming back while a stream retries), and a
// refresh's answer can be lost on the way, leaving the browser with the old token. Within this
// time the old token gets the current session back instead of signing the person out.
export const REFRESH_GRACE_SECONDS = 5 * 60;

function normalizeExpiryDate(value) {
  if (!value) {
    return new Date(Date.now() + 60 * 60 * 24 * 1000);
  }

  if (value instanceof Date) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return new Date(Date.now() + 60 * 60 * 24 * 1000);
  }

  return date;
}

function normalizeIp(ip) {
  const value = String(ip ?? '').trim();
  if (!value) {
    return 'unknown';
  }

  // Normalize localhost representations so the UI looks consistent.
  if (value === '::1' || value === '127.0.0.1') {
    return '127.0.0.1';
  }

  return value;
}

export function createInMemorySessionsRepository(seed = []) {
  const state = {
    tokens: seed.map((row) => ({
      id: row.id ?? randomUUID(),
      expiryDate: normalizeExpiryDate(row.expiryDate),
      ipAddr: normalizeIp(row.ipAddr),
      locationName: row.locationName ?? 'Unknown Location',
      token: String(row.token ?? ''),
      userAgent: row.userAgent ?? 'unknown',
      userId: row.userId,
    })),
  };

  function isActive(row) {
    return row.expiryDate.valueOf() > Date.now();
  }

  return {
    state,
    async createSession({ expiryDate, id, ipAddr, locationName, token, userAgent, userId }) {
      const row = {
        id: id ?? randomUUID(),
        expiryDate: normalizeExpiryDate(expiryDate),
        ipAddr: normalizeIp(ipAddr),
        locationName: locationName ?? 'Unknown Location',
        token: String(token ?? ''),
        userAgent: userAgent ?? 'unknown',
        userId,
      };
      state.tokens.push(row);
      return row;
    },
    async validateToken({ token }) {
      const row = state.tokens.find((entry) => entry.token === token && isActive(entry));
      return row ? { ok: true, session: row } : { ok: false, session: null };
    },
    async validateSession({ sessionId, userId }) {
      const row = state.tokens.find((entry) => entry.id === sessionId && isActive(entry));
      if (!row || (userId && row.userId !== userId)) {
        return { ok: false, session: null };
      }

      return { ok: true, session: row };
    },
    async validateRefreshToken({ now = new Date(), refreshToken, sessionId, userId }) {
      const given = String(refreshToken ?? '');
      const row = state.tokens.find((entry) => entry.id === sessionId && isActive(entry));
      if (!row || (userId && row.userId !== userId)) return { ok: false, session: null };
      if (row.token === given) return { grace: false, ok: true, session: row };
      const inGrace = row.previousToken && row.previousToken === given && row.rotatedAt
        && now.getTime() - row.rotatedAt.getTime() <= REFRESH_GRACE_SECONDS * 1000;
      return inGrace ? { grace: true, ok: true, session: row } : { ok: false, session: null };
    },
    async refreshToken({ newExpiryDate, newToken, oldToken, userId }) {
      const row = state.tokens.find((entry) => entry.userId === userId && entry.token === oldToken);
      if (!row) {
        return false;
      }

      row.token = String(newToken ?? '');
      row.expiryDate = normalizeExpiryDate(newExpiryDate);
      return true;
    },
    async rotateRefreshToken({ expiryDate, refreshToken, sessionId, userId }) {
      const row = state.tokens.find((entry) => entry.id === sessionId && entry.userId === userId);
      if (!row) {
        return false;
      }

      row.previousToken = row.token;
      row.rotatedAt = new Date();
      row.token = String(refreshToken ?? '');
      row.expiryDate = normalizeExpiryDate(expiryDate);
      return true;
    },
    async listActiveSessions({ userId }) {
      return state.tokens
        .filter((row) => row.userId === userId && isActive(row))
        .map((row) => ({
          id: row.id,
          expiryDate: row.expiryDate.toISOString(),
          ipAddr: row.ipAddr,
          locationName: row.locationName,
          userAgent: row.userAgent,
          token: row.token,
        }));
    },
    async killSession({ tokenId, userId }) {
      const index = state.tokens.findIndex((row) => row.userId === userId && row.id === tokenId);
      if (index === -1) {
        return false;
      }

      state.tokens.splice(index, 1);
      return true;
    },
    async revokeToken({ token }) {
      const before = state.tokens.length;
      state.tokens = state.tokens.filter((row) => row.token !== token);
      return state.tokens.length !== before;
    },
  };
}

export function createMysqlSessionsRepository({ pool }) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the sessions repository.');
  }

  return {
    async createSession({ expiryDate, id, ipAddr, locationName, token, userAgent, userId }) {
      const sessionId = id ?? randomUUID();
      const expiry = normalizeExpiryDate(expiryDate);

      await pool.execute(
        `
          INSERT INTO tokens (
            id,
            user_id,
            token,
            expiry_date,
            ip_addr,
            location_name,
            user_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          sessionId,
          userId,
          String(token ?? ''),
          expiry.toISOString().slice(0, 19).replace('T', ' '),
          normalizeIp(ipAddr),
          locationName ?? 'Unknown Location',
          userAgent ?? 'unknown',
        ],
      );

      return {
        id: sessionId,
        expiryDate: expiry,
        ipAddr: normalizeIp(ipAddr),
        locationName: locationName ?? 'Unknown Location',
        token: String(token ?? ''),
        userAgent: userAgent ?? 'unknown',
        userId,
      };
    },
    async validateToken({ token }) {
      const [rows] = await pool.execute(
        `
          SELECT id, user_id AS userId, token, expiry_date AS expiryDate, ip_addr AS ipAddr, location_name AS locationName, user_agent AS userAgent
          FROM tokens
          WHERE token = ?
            AND expiry_date > NOW()
          LIMIT 1
        `,
        [String(token ?? '')],
      );

      return rows[0]
        ? {
            ok: true,
            session: {
              id: rows[0].id,
              expiryDate: rows[0].expiryDate,
              ipAddr: rows[0].ipAddr,
              locationName: rows[0].locationName,
              token: rows[0].token,
              userAgent: rows[0].userAgent,
              userId: rows[0].userId,
            },
          }
        : { ok: false, session: null };
    },
    async validateSession({ sessionId, userId }) {
      const [rows] = await pool.execute(
        `
          SELECT id, user_id AS userId, token, expiry_date AS expiryDate, ip_addr AS ipAddr, location_name AS locationName, user_agent AS userAgent
          FROM tokens
          WHERE id = ?
            AND expiry_date > NOW()
          LIMIT 1
        `,
        [String(sessionId ?? '')],
      );

      if (!rows[0] || (userId && rows[0].userId !== userId)) {
        return { ok: false, session: null };
      }

      return {
        ok: true,
        session: {
          id: rows[0].id,
          expiryDate: rows[0].expiryDate,
          ipAddr: rows[0].ipAddr,
          locationName: rows[0].locationName,
          token: rows[0].token,
          userAgent: rows[0].userAgent,
          userId: rows[0].userId,
        },
      };
    },
    async validateRefreshToken({ refreshToken, sessionId, userId }) {
      const [rows] = await pool.execute(
        `
          SELECT id, user_id AS userId, token, expiry_date AS expiryDate, ip_addr AS ipAddr, location_name AS locationName, user_agent AS userAgent,
            token <> ? AS grace
          FROM tokens
          WHERE id = ?
            AND user_id = ?
            AND expiry_date > NOW()
            AND (token = ? OR (previous_token = ? AND rotated_at > NOW(3) - INTERVAL ? SECOND))
          LIMIT 1
        `,
        [String(refreshToken ?? ''), String(sessionId ?? ''), userId, String(refreshToken ?? ''), String(refreshToken ?? ''), REFRESH_GRACE_SECONDS],
      );

      return rows[0]
        ? {
            grace: Boolean(Number(rows[0].grace)),
            ok: true,
            session: {
              id: rows[0].id,
              expiryDate: rows[0].expiryDate,
              ipAddr: rows[0].ipAddr,
              locationName: rows[0].locationName,
              token: rows[0].token,
              userAgent: rows[0].userAgent,
              userId: rows[0].userId,
            },
          }
        : { ok: false, session: null };
    },
    async refreshToken({ newExpiryDate, newToken, oldToken, userId }) {
      const expiry = normalizeExpiryDate(newExpiryDate);
      const [result] = await pool.execute(
        `
          UPDATE tokens
          SET token = ?, expiry_date = ?
          WHERE user_id = ?
            AND token = ?
        `,
        [
          String(newToken ?? ''),
          expiry.toISOString().slice(0, 19).replace('T', ' '),
          userId,
          String(oldToken ?? ''),
        ],
      );

      return result.affectedRows > 0;
    },
    async rotateRefreshToken({ expiryDate, refreshToken, sessionId, userId }) {
      const normalizedExpiry = normalizeExpiryDate(expiryDate);
      const [result] = await pool.execute(
        `
          UPDATE tokens
          SET previous_token = token, rotated_at = NOW(3), token = ?, expiry_date = ?
          WHERE id = ?
            AND user_id = ?
        `,
        [
          String(refreshToken ?? ''),
          normalizedExpiry.toISOString().slice(0, 19).replace('T', ' '),
          String(sessionId ?? ''),
          userId,
        ],
      );

      return result.affectedRows > 0;
    },
    async listActiveSessions({ userId }) {
      const [rows] = await pool.execute(
        `
          SELECT id, token, expiry_date AS expiryDate, ip_addr AS ipAddr, location_name AS locationName, user_agent AS userAgent
          FROM tokens
          WHERE user_id = ?
            AND expiry_date >= NOW()
          ORDER BY expiry_date DESC
        `,
        [userId],
      );

      return rows.map((row) => ({
        id: row.id,
        expiryDate: row.expiryDate instanceof Date ? row.expiryDate.toISOString() : String(row.expiryDate),
        ipAddr: row.ipAddr ?? 'unknown',
        locationName: row.locationName ?? 'Unknown Location',
        token: row.token,
        userAgent: row.userAgent ?? 'unknown',
      }));
    },
    async killSession({ tokenId, userId }) {
      const [result] = await pool.execute(
        'DELETE FROM tokens WHERE id = ? AND user_id = ?',
        [tokenId, userId],
      );

      return result.affectedRows > 0;
    },
    async revokeToken({ token }) {
      const [result] = await pool.execute('DELETE FROM tokens WHERE token = ?', [String(token ?? '')]);
      return result.affectedRows > 0;
    },
  };
}
