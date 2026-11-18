// Optional modules each workspace switches on or off (tenant_modules, 0095_engagements). A module
// with no row is off, at version 0.
import { HttpError } from '../../lib/errors/http-error.js';

export const CONSULTING_MODULE = 'consulting';
export const WORKSPACE_MODULE_KEYS = Object.freeze([CONSULTING_MODULE]);

function offRecord(tenantId, moduleKey) {
  return { enabled: false, moduleKey, tenantId, updatedAt: null, updatedBy: null, version: 0 };
}

function versionConflict(current) {
  return new HttpError(409, 'Someone else changed this module. Reload and try again.', {
    details: { code: 'module_version_conflict', current },
  });
}

export function createInMemoryWorkspaceModulesRepository({ seed = [] } = {}) {
  const rows = new Map(seed.map((row) => [`${row.tenantId}:${row.moduleKey}`, { ...offRecord(row.tenantId, row.moduleKey), version: 1, ...row }]));
  const read = (tenantId, moduleKey) => structuredClone(rows.get(`${tenantId}:${moduleKey}`) ?? offRecord(tenantId, moduleKey));
  return {
    async getModule({ moduleKey, tenantId }) {
      return read(tenantId, moduleKey);
    },
    async listModules({ tenantId }) {
      return WORKSPACE_MODULE_KEYS.map((moduleKey) => read(tenantId, moduleKey));
    },
    async setModule({ enabled, expectedVersion, moduleKey, tenantId, userId }) {
      const current = read(tenantId, moduleKey);
      if (current.version !== expectedVersion) throw versionConflict(current);
      const next = { enabled: Boolean(enabled), moduleKey, tenantId, updatedAt: new Date().toISOString(), updatedBy: userId, version: current.version + 1 };
      rows.set(`${tenantId}:${moduleKey}`, next);
      return structuredClone(next);
    },
  };
}

function mapRow(row) {
  return {
    enabled: Number(row.enabled) === 1,
    moduleKey: row.module_key,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by ?? null,
    version: Number(row.version),
  };
}

export function createMysqlWorkspaceModulesRepository({ pool }) {
  async function read(executor, tenantId, moduleKey, { lock = false } = {}) {
    const [rows] = await executor.execute(
      `SELECT tenant_id, module_key, enabled, updated_by, updated_at, version FROM tenant_modules WHERE tenant_id = ? AND module_key = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [tenantId, moduleKey],
    );
    return rows[0] ? mapRow(rows[0]) : offRecord(tenantId, moduleKey);
  }

  return {
    getModule({ moduleKey, tenantId }) {
      return read(pool, tenantId, moduleKey);
    },
    async listModules({ tenantId }) {
      return Promise.all(WORKSPACE_MODULE_KEYS.map((moduleKey) => read(pool, tenantId, moduleKey)));
    },
    async setModule({ enabled, expectedVersion, moduleKey, tenantId, userId }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const current = await read(connection, tenantId, moduleKey, { lock: true });
        if (current.version !== expectedVersion) throw versionConflict(current);
        if (current.version === 0) {
          await connection.execute(
            'INSERT INTO tenant_modules (tenant_id, module_key, enabled, updated_by, updated_at, version) VALUES (?, ?, ?, ?, NOW(3), 1)',
            [tenantId, moduleKey, enabled ? 1 : 0, userId],
          );
        } else {
          await connection.execute(
            'UPDATE tenant_modules SET enabled = ?, updated_by = ?, updated_at = NOW(3), version = version + 1 WHERE tenant_id = ? AND module_key = ?',
            [enabled ? 1 : 0, userId, tenantId, moduleKey],
          );
        }
        const saved = await read(connection, tenantId, moduleKey);
        await connection.commit();
        return saved;
      } catch (error) {
        await connection.rollback();
        // Two first switches at once: the second insert finds the first one's row.
        if (error?.code === 'ER_DUP_ENTRY') throw versionConflict(await read(pool, tenantId, moduleKey));
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
