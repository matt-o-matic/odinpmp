import { randomUUID } from 'node:crypto';

import { normalizeAccessEmail } from './access-links.js';

// Storage for access links (one per workspace and email, with hashed tokens) and for the task
// access each resource without a login has on a project. Migrations 0078 and 0079 create the
// tables. The migration functions are checksummed once applied: never edit their bodies, add a
// new migration instead.

// 0078_access_links
export async function ensureMysqlAccessLinksSchema(executor) {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS access_links (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(36) NOT NULL,
      email VARCHAR(255) NOT NULL,
      issued_at DATETIME(3) NOT NULL,
      extended_until DATETIME(3) NULL,
      extended_by VARCHAR(128) NULL,
      revoked_at DATETIME(3) NULL,
      revoked_by VARCHAR(128) NULL,
      created_by VARCHAR(128) NOT NULL,
      last_used_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_access_links_email (tenant_id, email)
    )
  `);
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS access_link_tokens (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(36) NOT NULL,
      link_id VARCHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      purpose VARCHAR(16) NOT NULL,
      created_by VARCHAR(128) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      last_used_at DATETIME(3) NULL,
      revoked_at DATETIME(3) NULL,
      UNIQUE KEY uq_access_link_tokens_hash (token_hash),
      KEY idx_access_link_tokens_link (link_id)
    )
  `);
}

// 0079_project_task_access: one row per project and resource. Turning access off keeps the row
// with revoked_at set, so the link's lifetime can count from when it ended.
export async function ensureMysqlProjectTaskAccessSchema(executor) {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS project_task_access (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(128) NOT NULL,
      resource_id VARCHAR(36) NOT NULL,
      scope VARCHAR(8) NOT NULL,
      granted_by VARCHAR(128) NOT NULL,
      granted_at DATETIME(3) NOT NULL,
      revoked_at DATETIME(3) NULL,
      revoked_by VARCHAR(128) NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_project_task_access (tenant_id, project_id, resource_id),
      KEY idx_project_task_access_resource (tenant_id, resource_id)
    )
  `);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function presentLink(record) {
  return {
    createdAt: toIso(record.createdAt),
    createdBy: record.createdBy,
    email: record.email,
    extendedBy: record.extendedBy ?? null,
    extendedUntil: toIso(record.extendedUntil),
    id: record.id,
    issuedAt: toIso(record.issuedAt),
    lastUsedAt: toIso(record.lastUsedAt),
    revokedAt: toIso(record.revokedAt),
    revokedBy: record.revokedBy ?? null,
    tenantId: record.tenantId,
    updatedAt: toIso(record.updatedAt),
  };
}

function presentToken(record) {
  return {
    createdAt: toIso(record.createdAt),
    createdBy: record.createdBy,
    id: record.id,
    lastUsedAt: toIso(record.lastUsedAt),
    linkId: record.linkId,
    purpose: record.purpose,
    revokedAt: toIso(record.revokedAt),
  };
}

function presentGrant(record) {
  return {
    createdAt: toIso(record.createdAt),
    grantedAt: toIso(record.grantedAt),
    grantedBy: record.grantedBy,
    id: record.id,
    projectId: record.projectId,
    resourceId: record.resourceId,
    revokedAt: toIso(record.revokedAt),
    revokedBy: record.revokedBy ?? null,
    scope: record.scope,
    tenantId: record.tenantId,
    updatedAt: toIso(record.updatedAt),
  };
}

export function createInMemoryAccessRepository() {
  const state = { grants: [], links: [], tokens: [] };
  const findLink = (tenantId, email) => state.links.find((link) => link.tenantId === tenantId && link.email === normalizeAccessEmail(email)) ?? null;

  return {
    state,

    /**
     * Issues a token on the link for the email, making the link when there is none. Issuing
     * restarts the link's window; a revoked link starts afresh, and its old tokens stay revoked.
     */
    async issueLinkToken({ createdBy, email, now, purpose, tenantId, tokenHash }) {
      const timestamp = toIso(now);
      let link = findLink(tenantId, email);
      const linkCreated = !link;
      const reactivated = Boolean(link?.revokedAt);
      if (!link) {
        link = {
          createdAt: timestamp, createdBy, email: normalizeAccessEmail(email), extendedBy: null, extendedUntil: null, id: randomUUID(),
          issuedAt: timestamp, lastUsedAt: null, revokedAt: null, revokedBy: null, tenantId, updatedAt: timestamp,
        };
        state.links.push(link);
      } else {
        Object.assign(link, reactivated ? { extendedBy: null, extendedUntil: null, revokedAt: null, revokedBy: null } : {}, { issuedAt: timestamp, updatedAt: timestamp });
      }
      const token = { createdAt: timestamp, createdBy, id: randomUUID(), lastUsedAt: null, linkId: link.id, purpose, revokedAt: null, tenantId, tokenHash };
      state.tokens.push(token);
      return { link: presentLink(link), linkCreated, reactivated, token: presentToken(token) };
    },

    /**
     * The link for the email, made when there is none, for a channel guest.
     * Inviting someone again brings a revoked link back, as issuing a token does; its old tokens
     * stay revoked.
     */
    async ensureLink({ createdBy, email, now, tenantId }) {
      const timestamp = toIso(now);
      let link = findLink(tenantId, email);
      if (!link) {
        link = {
          createdAt: timestamp, createdBy, email: normalizeAccessEmail(email), extendedBy: null, extendedUntil: null, id: randomUUID(),
          issuedAt: timestamp, lastUsedAt: null, revokedAt: null, revokedBy: null, tenantId, updatedAt: timestamp,
        };
        state.links.push(link);
      } else if (link.revokedAt) {
        Object.assign(link, { extendedBy: null, extendedUntil: null, issuedAt: timestamp, revokedAt: null, revokedBy: null, updatedAt: timestamp });
      }
      return presentLink(link);
    },

    async findLinkById({ linkId }) {
      const link = state.links.find((item) => item.id === linkId);
      return link ? presentLink(link) : null;
    },

    /** Every workspace's link for the email, for guest sign-in. */
    async listLinksByEmail({ email }) {
      return state.links.filter((link) => link.email === normalizeAccessEmail(email)).map(presentLink);
    },

    async findTokenByHash({ tokenHash }) {
      const token = state.tokens.find((item) => item.tokenHash === tokenHash) ?? null;
      const link = token ? state.links.find((item) => item.id === token.linkId) ?? null : null;
      return token && link ? { link: presentLink(link), token: presentToken(token) } : null;
    },

    async findLinkByEmail({ email, tenantId }) {
      const link = findLink(tenantId, email);
      return link ? presentLink(link) : null;
    },

    async touchLink({ linkId, now, tokenId = null }) {
      const link = state.links.find((item) => item.id === linkId);
      if (link) link.lastUsedAt = toIso(now);
      const token = tokenId ? state.tokens.find((item) => item.id === tokenId) : null;
      if (token) token.lastUsedAt = toIso(now);
    },

    /** Revokes the link and every token on it. */
    async revokeLink({ linkId, now, revokedBy, tenantId }) {
      const link = state.links.find((item) => item.id === linkId && item.tenantId === tenantId);
      if (!link) return null;
      if (!link.revokedAt) Object.assign(link, { revokedAt: toIso(now), revokedBy, updatedAt: toIso(now) });
      for (const token of state.tokens) {
        if (token.linkId === linkId && !token.revokedAt) token.revokedAt = toIso(now);
      }
      return presentLink(link);
    },

    /** Grants, current and turned off, for a project or for some resources. */
    async listTaskAccess({ projectId = null, resourceIds = null, tenantId }) {
      return state.grants
        .filter((grant) => grant.tenantId === tenantId && (!projectId || grant.projectId === projectId) && (!resourceIds || resourceIds.includes(grant.resourceId)))
        .map((grant) => presentGrant(clone(grant)));
    },

    /** Sets a resource's task access on a project: `own`, `all`, or `off` (revokes, keeping the row). */
    async setTaskAccess({ by, now, projectId, resourceId, scope, tenantId }) {
      const timestamp = toIso(now);
      const grant = state.grants.find((item) => item.tenantId === tenantId && item.projectId === projectId && item.resourceId === resourceId) ?? null;
      if (scope === 'off') {
        if (grant && !grant.revokedAt) Object.assign(grant, { revokedAt: timestamp, revokedBy: by, updatedAt: timestamp });
        return grant ? presentGrant(grant) : null;
      }
      if (!grant) {
        const created = {
          createdAt: timestamp, grantedAt: timestamp, grantedBy: by, id: randomUUID(), projectId, resourceId,
          revokedAt: null, revokedBy: null, scope, tenantId, updatedAt: timestamp,
        };
        state.grants.push(created);
        return presentGrant(created);
      }
      // Turning access back on starts a new grant; changing the scope of a live one keeps its start.
      if (grant.revokedAt) Object.assign(grant, { grantedAt: timestamp, grantedBy: by, revokedAt: null, revokedBy: null });
      Object.assign(grant, { scope, updatedAt: timestamp });
      return presentGrant(grant);
    },
  };
}

// MySQL keeps times as DATETIME(3) written with FROM_UNIXTIME and read with UNIX_TIMESTAMP, as
// the requirements links are, so the session time zone never shifts a lifetime.
function unixSeconds(value) {
  const ms = value instanceof Date ? value.valueOf() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function fromUnix(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)).toISOString() : null;
}

const LINK_COLUMNS = `
  id, tenant_id AS tenantId, email, created_by AS createdBy, extended_by AS extendedBy, revoked_by AS revokedBy,
  UNIX_TIMESTAMP(issued_at) AS issuedAt, UNIX_TIMESTAMP(extended_until) AS extendedUntil, UNIX_TIMESTAMP(revoked_at) AS revokedAt,
  UNIX_TIMESTAMP(last_used_at) AS lastUsedAt, UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const TOKEN_COLUMNS = `
  id, link_id AS linkId, purpose, created_by AS createdBy,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(last_used_at) AS lastUsedAt, UNIX_TIMESTAMP(revoked_at) AS revokedAt
`;

const GRANT_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, resource_id AS resourceId, scope, granted_by AS grantedBy, revoked_by AS revokedBy,
  UNIX_TIMESTAMP(granted_at) AS grantedAt, UNIX_TIMESTAMP(revoked_at) AS revokedAt,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const linkFromRow = (row) => presentLink({
  ...row, createdAt: fromUnix(row.createdAt), extendedUntil: fromUnix(row.extendedUntil), issuedAt: fromUnix(row.issuedAt),
  lastUsedAt: fromUnix(row.lastUsedAt), revokedAt: fromUnix(row.revokedAt), updatedAt: fromUnix(row.updatedAt),
});
const tokenFromRow = (row) => presentToken({ ...row, createdAt: fromUnix(row.createdAt), lastUsedAt: fromUnix(row.lastUsedAt), revokedAt: fromUnix(row.revokedAt) });
const grantFromRow = (row) => presentGrant({
  ...row, createdAt: fromUnix(row.createdAt), grantedAt: fromUnix(row.grantedAt), revokedAt: fromUnix(row.revokedAt), updatedAt: fromUnix(row.updatedAt),
});

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

export function createMysqlAccessRepository({ pool }) {
  async function selectLink(executor, linkId) {
    const [rows] = await executor.execute(`SELECT ${LINK_COLUMNS} FROM access_links WHERE id = ? LIMIT 1`, [linkId]);
    return rows[0] ? linkFromRow(rows[0]) : null;
  }

  async function selectGrant(executor, { projectId, resourceId, tenantId }) {
    const [rows] = await executor.execute(`SELECT ${GRANT_COLUMNS} FROM project_task_access WHERE tenant_id = ? AND project_id = ? AND resource_id = ? LIMIT 1`, [tenantId, projectId, resourceId]);
    return rows[0] ? grantFromRow(rows[0]) : null;
  }

  return {
    async issueLinkToken({ createdBy, email, now, purpose, tenantId, tokenHash }) {
      const address = normalizeAccessEmail(email);
      const nowSeconds = unixSeconds(now);
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute('SELECT id, revoked_at AS revokedAt FROM access_links WHERE tenant_id = ? AND email = ? LIMIT 1 FOR UPDATE', [tenantId, address]);
        let linkId = rows[0]?.id ?? null;
        const linkCreated = !linkId;
        const reactivated = Boolean(rows[0]?.revokedAt);
        if (!linkId) {
          linkId = randomUUID();
          await connection.execute(
            `INSERT INTO access_links (id, tenant_id, email, issued_at, created_by, created_at, updated_at)
             VALUES (?, ?, ?, FROM_UNIXTIME(?), ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))`,
            [linkId, tenantId, address, nowSeconds, createdBy, nowSeconds, nowSeconds],
          );
        } else if (reactivated) {
          await connection.execute(
            `UPDATE access_links SET issued_at = FROM_UNIXTIME(?), extended_until = NULL, extended_by = NULL, revoked_at = NULL, revoked_by = NULL,
               updated_at = FROM_UNIXTIME(?) WHERE id = ?`,
            [nowSeconds, nowSeconds, linkId],
          );
        } else {
          await connection.execute('UPDATE access_links SET issued_at = FROM_UNIXTIME(?), updated_at = FROM_UNIXTIME(?) WHERE id = ?', [nowSeconds, nowSeconds, linkId]);
        }
        const tokenId = randomUUID();
        await connection.execute(
          `INSERT INTO access_link_tokens (id, tenant_id, link_id, token_hash, purpose, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
          [tokenId, tenantId, linkId, tokenHash, purpose, createdBy, nowSeconds],
        );
        const [tokenRows] = await connection.execute(`SELECT ${TOKEN_COLUMNS} FROM access_link_tokens WHERE id = ? LIMIT 1`, [tokenId]);
        return { link: await selectLink(connection, linkId), linkCreated, reactivated, token: tokenFromRow(tokenRows[0]) };
      });
    },

    async ensureLink({ createdBy, email, now, tenantId }) {
      const address = normalizeAccessEmail(email);
      const nowSeconds = unixSeconds(now);
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute('SELECT id, revoked_at AS revokedAt FROM access_links WHERE tenant_id = ? AND email = ? LIMIT 1 FOR UPDATE', [tenantId, address]);
        let linkId = rows[0]?.id ?? null;
        if (!linkId) {
          linkId = randomUUID();
          await connection.execute(
            `INSERT INTO access_links (id, tenant_id, email, issued_at, created_by, created_at, updated_at)
             VALUES (?, ?, ?, FROM_UNIXTIME(?), ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))`,
            [linkId, tenantId, address, nowSeconds, createdBy, nowSeconds, nowSeconds],
          );
        } else if (rows[0].revokedAt) {
          await connection.execute(
            `UPDATE access_links SET issued_at = FROM_UNIXTIME(?), extended_until = NULL, extended_by = NULL, revoked_at = NULL, revoked_by = NULL,
               updated_at = FROM_UNIXTIME(?) WHERE id = ?`,
            [nowSeconds, nowSeconds, linkId],
          );
        }
        return selectLink(connection, linkId);
      });
    },

    async findLinkById({ linkId }) {
      return selectLink(pool, linkId);
    },

    async listLinksByEmail({ email }) {
      const [rows] = await pool.execute(`SELECT ${LINK_COLUMNS} FROM access_links WHERE email = ?`, [normalizeAccessEmail(email)]);
      return rows.map(linkFromRow);
    },

    async findTokenByHash({ tokenHash }) {
      const [rows] = await pool.execute(`SELECT ${TOKEN_COLUMNS} FROM access_link_tokens WHERE token_hash = ? LIMIT 1`, [tokenHash]);
      if (!rows[0]) return null;
      const link = await selectLink(pool, rows[0].linkId);
      return link ? { link, token: tokenFromRow(rows[0]) } : null;
    },

    async findLinkByEmail({ email, tenantId }) {
      const [rows] = await pool.execute(`SELECT ${LINK_COLUMNS} FROM access_links WHERE tenant_id = ? AND email = ? LIMIT 1`, [tenantId, normalizeAccessEmail(email)]);
      return rows[0] ? linkFromRow(rows[0]) : null;
    },

    async touchLink({ linkId, now, tokenId = null }) {
      await pool.execute('UPDATE access_links SET last_used_at = FROM_UNIXTIME(?) WHERE id = ?', [unixSeconds(now), linkId]);
      if (tokenId) await pool.execute('UPDATE access_link_tokens SET last_used_at = FROM_UNIXTIME(?) WHERE id = ?', [unixSeconds(now), tokenId]);
    },

    async revokeLink({ linkId, now, revokedBy, tenantId }) {
      const nowSeconds = unixSeconds(now);
      await withTransaction(pool, async (connection) => {
        await connection.execute(
          'UPDATE access_links SET revoked_at = FROM_UNIXTIME(?), revoked_by = ?, updated_at = FROM_UNIXTIME(?) WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL',
          [nowSeconds, revokedBy, nowSeconds, linkId, tenantId],
        );
        await connection.execute(
          'UPDATE access_link_tokens SET revoked_at = FROM_UNIXTIME(?) WHERE link_id = ? AND tenant_id = ? AND revoked_at IS NULL',
          [nowSeconds, linkId, tenantId],
        );
      });
      const link = await selectLink(pool, linkId);
      return link?.tenantId === tenantId ? link : null;
    },

    async listTaskAccess({ projectId = null, resourceIds = null, tenantId }) {
      if (resourceIds && !resourceIds.length) return [];
      const clauses = ['tenant_id = ?'];
      const params = [tenantId];
      if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
      if (resourceIds) { clauses.push(`resource_id IN (${resourceIds.map(() => '?').join(', ')})`); params.push(...resourceIds); }
      const [rows] = await pool.execute(`SELECT ${GRANT_COLUMNS} FROM project_task_access WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`, params);
      return rows.map(grantFromRow);
    },

    async setTaskAccess({ by, now, projectId, resourceId, scope, tenantId }) {
      const nowSeconds = unixSeconds(now);
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          'SELECT id, UNIX_TIMESTAMP(revoked_at) AS revokedAt FROM project_task_access WHERE tenant_id = ? AND project_id = ? AND resource_id = ? LIMIT 1 FOR UPDATE',
          [tenantId, projectId, resourceId],
        );
        const current = rows[0] ?? null;
        if (scope === 'off') {
          if (current && current.revokedAt == null) {
            await connection.execute(
              'UPDATE project_task_access SET revoked_at = FROM_UNIXTIME(?), revoked_by = ?, updated_at = FROM_UNIXTIME(?) WHERE id = ?',
              [nowSeconds, by, nowSeconds, current.id],
            );
          }
        } else if (!current) {
          await connection.execute(
            `INSERT INTO project_task_access (id, tenant_id, project_id, resource_id, scope, granted_by, granted_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?))`,
            [randomUUID(), tenantId, projectId, resourceId, scope, by, nowSeconds, nowSeconds, nowSeconds],
          );
        } else if (current.revokedAt != null) {
          // Turning access back on starts a new grant.
          await connection.execute(
            `UPDATE project_task_access SET scope = ?, granted_by = ?, granted_at = FROM_UNIXTIME(?), revoked_at = NULL, revoked_by = NULL,
               updated_at = FROM_UNIXTIME(?) WHERE id = ?`,
            [scope, by, nowSeconds, nowSeconds, current.id],
          );
        } else {
          await connection.execute('UPDATE project_task_access SET scope = ?, updated_at = FROM_UNIXTIME(?) WHERE id = ?', [scope, nowSeconds, current.id]);
        }
        return selectGrant(connection, { projectId, resourceId, tenantId });
      });
    },
  };
}
