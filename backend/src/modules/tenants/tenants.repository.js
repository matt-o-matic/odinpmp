import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/errors/http-error.js';
import { isUnclaimedStakeholderAccount } from '../auth/stakeholder-accounts.js';
import { assertTicketConfigRevision } from './ticket-config-revision.js';
import { invitationExpired, requireOpenInvitation } from './workspace-invitations.js';
import { addWorkspaceMembershipMemory, addWorkspaceMembershipMysql } from './workspace-membership.js';

import {
  DEFAULT_TENANT_ENVIRONMENTS,
  ensureMysqlTenantEnvironmentDefaults,
} from '../projects/projects.repository.js';

const TICKET_CONFIG_TABLES = { environments: 'tenant_environments', releases: 'tenant_releases' };

function safeJsonParse(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
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

async function upsertPreference({ executor, key, tenantId, userId, projectId, value }) {
  const tenantClause = tenantId == null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const userClause = userId == null ? 'user_id IS NULL' : 'user_id = ?';
  const projectClause = projectId == null ? 'project_id IS NULL' : 'project_id = ?';
  const params = [
    key,
    ...(tenantId == null ? [] : [tenantId]),
    ...(userId == null ? [] : [userId]),
    ...(projectId == null ? [] : [projectId]),
  ];

  const [rows] = await executor.execute(
    `
      SELECT id
      FROM preferences
      WHERE \`key\` = ?
        AND ${tenantClause}
        AND ${userClause}
        AND ${projectClause}
      LIMIT 1
    `,
    params,
  );

  if (rows[0]?.id) {
    await executor.execute(
      'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
      [value, rows[0].id],
    );
    return rows[0].id;
  }

  const id = randomUUID();
  await executor.execute(
    `
      INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `,
    [id, tenantId ?? null, userId ?? null, projectId ?? null, key, value],
  );
  return id;
}

export function createInMemoryTenantsRepository({ authRepository } = {}) {
  if (!authRepository) {
    throw new Error('authRepository is required for the in-memory tenants repository.');
  }

  const state = {
    auditLogs: [],
    invites: [],
    openAiConfigs: new Map(),
    statusDefinitions: new Map(),
    taskTypeDefinitions: new Map(),
    ticketConfigLists: new Map(),
  };

  function ticketConfigKey(tenantId, kind) {
    return `${tenantId}:${kind}`;
  }

  function seededTicketConfigList(tenantId, kind) {
    const key = ticketConfigKey(tenantId, kind);
    if (!state.ticketConfigLists.has(key)) {
      // AC2.1: environments are seeded with defaults; release lists start empty.
      state.ticketConfigLists.set(key, kind === 'environments'
        ? DEFAULT_TENANT_ENVIRONMENTS.map((name, index) => ({
            id: `env-${name.toLowerCase()}`,
            name,
            projectId: null,
            sortOrder: index,
            status: 'active',
            version: 1,
          }))
        : []);
    }
    return state.ticketConfigLists.get(key);
  }

  return {
    state,
    async listTicketConfigList({ kind, tenantId }) {
      return seededTicketConfigList(tenantId, kind).map((entry) => ({ ...entry }));
    },
    async saveTicketConfigList({ entries, expectedRevision, kind, tenantId }) {
      const current = seededTicketConfigList(tenantId, kind);
      assertTicketConfigRevision(current, expectedRevision);
      const existing = new Map(current.map((entry) => [entry.id, entry]));
      const next = (entries ?? []).map((entry, index) => {
        const id = entry.id || randomUUID();
        return {
          id,
          name: entry.name,
          projectId: entry.projectId ?? null,
          sortOrder: entry.sortOrder ?? index,
          status: entry.status ?? 'active',
          version: (existing.get(id)?.version ?? 0) + 1,
        };
      });
      const keptIds = new Set(next.map((entry) => entry.id));
      // Omitted entries are retired, as in the MySQL repository, so tickets still resolve them.
      const retired = current
        .filter((entry) => !keptIds.has(entry.id))
        .map((entry) => ({ ...entry, status: 'inactive', version: entry.version + 1 }));
      const saved = [...next, ...retired].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
      state.ticketConfigLists.set(ticketConfigKey(tenantId, kind), saved);
      return { entries: saved.map((entry) => ({ ...entry })) };
    },
    async getTenantSettings({ tenantId }) {
      const tenant = authRepository.state.tenants.find((t) => t.id === tenantId);
      if (!tenant) {
        return null;
      }

      return {
        tenant_name: tenant.name,
        domains: [...(tenant.domains ?? [])],
      };
    },
    async updateTenant({ tenantId, tenantName, domains }) {
      const tenant = authRepository.state.tenants.find((t) => t.id === tenantId);
      if (!tenant) {
        return null;
      }

      tenant.name = tenantName;
      tenant.domains = [...domains];
      return { message: 'Tenant updated successfully.' };
    },
    async getOpenAiConfig({ tenantId, defaults }) {
      const config = state.openAiConfigs.get(tenantId);
      return config
        ? { ...config, valid_config: true }
        : { ...defaults, valid_config: false };
    },
    async saveOpenAiConfig({ tenantId, config }) {
      state.openAiConfigs.set(tenantId, { ...config, valid_config: true });
      return { message: 'OpenAI config saved.' };
    },
    async deleteOpenAiConfig({ tenantId }) {
      state.openAiConfigs.delete(tenantId);
      return { message: 'OpenAI config removed. Tenant will revert to default settings.' };
    },
    async updateUsers({
      tenantId,
      roleChanges = [],
      updates = [],
    } = {}) {
      const normalizedTenantId = tenantId;

      for (const change of roleChanges) {
        const email = change.email.toLowerCase();
        const user = authRepository.state.users.find((u) => u.email.toLowerCase() === email);
        if (!user) continue;
        const membership = user.memberships?.find((m) => m.tenantId === normalizedTenantId);
        if (membership) {
          membership.role = change.role;
        }
      }

      for (const update of updates) {
        const email = update.email.toLowerCase();
        const user = authRepository.state.users.find((u) => u.email.toLowerCase() === email);
        if (!user) continue;
        if (update.name) {
          user.name = update.name;
        }
        const membership = user.memberships?.find((m) => m.tenantId === normalizedTenantId);
        if (membership) {
          if (update.role) membership.role = update.role;
          if (update.resource_cost !== undefined) membership.resourceCost = update.resource_cost;
          if (update.default_bill_rate !== undefined) membership.defaultBillRate = update.default_bill_rate;
          if (update.min_bill_rate !== undefined) membership.minBillRate = update.min_bill_rate;
        }
      }

      return { message: 'Users updated.' };
    },
    async listInvites({ tenantId }) {
      return state.invites
        .filter((row) => row.tenantId === tenantId)
        .map((row) => ({
          id: row.id,
          email: row.email,
          invite_token: row.inviteToken,
          role: row.role,
          sentOn: String(row.invitedAt).slice(0, 10),
          status: row.accepted ? 'Accepted' : invitationExpired(row) ? 'Expired' : 'Pending Acceptance',
        }));
    },
    async inviteUser({ tenantId, email, role }) {
      const invitation = { accepted: false, email: email.toLowerCase(), id: randomUUID(), inviteToken: randomUUID().replace(/-/g, ''), invitedAt: new Date().toISOString(), role, tenantId };
      state.invites.push(invitation);
      return { invitation };
    },
    async findInviteByToken({ inviteToken }) {
      const invitation = state.invites.find(row => row.inviteToken === inviteToken);
      if (!invitation) return null;
      const tenant = authRepository.state.tenants.find(row => row.id === invitation.tenantId);
      return tenant ? { ...invitation, tenantName: tenant.name } : null;
    },
    async renewInvite({ tenantId, inviteToken }) {
      const invitation = state.invites.find(row => row.tenantId === tenantId && row.inviteToken === inviteToken && !row.accepted);
      if (!invitation) throw new HttpError(404, 'Pending invitation not found.');
      invitation.inviteToken = randomUUID().replace(/-/g, '');
      invitation.invitedAt = new Date().toISOString();
      return { invitation };
    },
    async acceptInvite({ inviteToken, userId, registration }) {
      // Keep validation and mutation synchronous so simultaneous redemptions cannot both succeed.
      const invitation = requireOpenInvitation(state.invites.find(row => row.inviteToken === inviteToken));
      let user = userId ? authRepository.state.users.find(row => row.id === userId) : null;
      let claimed = false;
      if (registration) {
        const existing = authRepository.state.users.find(row => row.email.toLowerCase() === invitation.email.toLowerCase());
        // An invitation sent to a stakeholder's address proves they hold it, so they claim their file-owner account.
        claimed = Boolean(existing && !existing.memberships.length && !existing.passwordHash && authRepository.state.stakeholderEmails?.has(existing.email));
        if (existing && !claimed) throw new HttpError(409, 'An account already exists for this email. Sign in to accept the invitation.');
        user = claimed
          ? Object.assign(existing, { authMethod: 'basic', name: registration.name, passwordHash: registration.passwordHash })
          : { id: randomUUID(), email: invitation.email.toLowerCase(), name: registration.name, passwordHash: registration.passwordHash, authMethod: 'basic', memberships: [], preferences: { twoFactorEnabled: false }, backupCodes: [] };
      }
      if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) throw new HttpError(403, 'Sign in with the email address this invitation was sent to.');
      if (registration && !claimed) authRepository.state.users.push(user);
      addWorkspaceMembershipMemory(user, { role: invitation.role, tenantId: invitation.tenantId });
      for (const row of state.invites) {
        if (row.tenantId === invitation.tenantId && row.email.toLowerCase() === invitation.email.toLowerCase()) row.accepted = true;
      }
      return { userId: user.id, tenantId: invitation.tenantId };
    },
    async revokeInvite({ tenantId, inviteToken }) {
      const index = state.invites.findIndex((row) => row.tenantId === tenantId && row.inviteToken === inviteToken);
      if (index === -1) {
        return { ok: false, reason: 'not_found' };
      }
      if (state.invites[index].accepted) {
        return { ok: false, reason: 'accepted' };
      }

      state.invites.splice(index, 1);
      return { ok: true };
    },
    async listExistingUsers({ tenantId }) {
      return authRepository.state.users
        .flatMap((user) => {
          const membership = user.memberships?.find((m) => m.tenantId === tenantId);
          if (!membership) return [];
          return [{
            authMethod: user.authMethod,
            default_bill_rate: membership.defaultBillRate ?? null,
            email: user.email,
            id: user.id,
            img_url: user.picture ?? '',
            min_bill_rate: membership.minBillRate ?? null,
            name: user.name,
            resource_cost: membership.resourceCost ?? null,
            role: membership.role,
            twoFA: Boolean(user.preferences?.twoFactorEnabled),
          }];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    async provisionUser({ email, name, role = 'user', tenantId }) {
      let user = authRepository.state.users.find((row) => row.email.toLowerCase() === email.toLowerCase());
      if (!user) {
        user = { authMethod: 'basic', backupCodes: [], email: email.toLowerCase(), id: randomUUID(), memberships: [], name, passwordHash: '', pendingTwoFactorSecret: '', picture: '/images/avatar_default.jpg', preferences: { twoFactorEnabled: false }, twoFactorSecret: '' };
        authRepository.state.users.push(user);
      }
      user.name = name || user.name;
      const membership = user.memberships.find((item) => item.tenantId === tenantId);
      if (membership) membership.role = role; else user.memberships.push({ role, tenantId });
      return { email: user.email, id: user.id, name: user.name, role };
    },
    async removeUserFromTenant({ tenantId, userId }) {
      const user = authRepository.state.users.find((row) => row.id === userId);
      if (!user) return false;
      user.memberships = (user.memberships ?? []).filter((m) => m.tenantId !== tenantId);
      return true;
    },
    async listStatusDefinitions({ tenantId }) {
      const defaults = [
        { id: 'default-not-started', is_default: true, name: 'Not Started', sort_order: 10 },
        { id: 'default-in-progress', is_default: true, name: 'In Progress', sort_order: 20 },
        { id: 'default-completed', is_default: true, name: 'Completed', sort_order: 30 },
      ];
      const custom = state.statusDefinitions.get(tenantId) ?? [];
      return [...defaults, ...custom];
    },
    async saveStatusDefinitions({ tenantId, statuses }) {
      const custom = (statuses ?? []).filter((row) => !row.is_default).map((row) => ({
        id: row.id || randomUUID(),
        is_default: false,
        name: row.name,
        sort_order: row.sort_order ?? 0,
      }));
      state.statusDefinitions.set(tenantId, custom);
      return { message: 'Statuses updated.' };
    },
    async resetStatusDefinitions({ tenantId }) {
      state.statusDefinitions.delete(tenantId);
      return { message: 'Statuses reset.' };
    },
    async listTaskTypeDefinitions({ tenantId }) {
      const defaults = [
        { id: 'default-feature', is_default: true, name: 'Feature', sort_order: 10 },
        { id: 'default-bug', is_default: true, name: 'Bug', sort_order: 20 },
        { id: 'default-chore', is_default: true, name: 'Chore', sort_order: 30 },
      ];
      const custom = state.taskTypeDefinitions.get(tenantId) ?? [];
      return [...defaults, ...custom];
    },
    async saveTaskTypeDefinitions({ tenantId, taskTypes }) {
      const custom = (taskTypes ?? []).filter((row) => !row.is_default).map((row) => ({
        id: row.id || randomUUID(),
        is_default: false,
        name: row.name,
        sort_order: row.sort_order ?? 0,
      }));
      state.taskTypeDefinitions.set(tenantId, custom);
      return { message: 'Task types updated.' };
    },
    async resetTaskTypeDefinitions({ tenantId }) {
      state.taskTypeDefinitions.delete(tenantId);
      return { message: 'Task types reset.' };
    },
  };
}

export function createMysqlTenantsRepository({ pool }) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the tenants repository.');
  }

  async function listTicketConfigRows(tenantId, kind) {
    const table = TICKET_CONFIG_TABLES[kind];
    if (kind === 'environments') {
      await ensureMysqlTenantEnvironmentDefaults(pool, tenantId);
    }
    const [rows] = await pool.execute(
      `SELECT id, name, project_id AS projectId, sort_order AS sortOrder, status, version FROM ${table} WHERE tenant_id = ? ORDER BY sort_order, name`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      projectId: row.projectId ?? null,
      sortOrder: Number(row.sortOrder ?? 0),
      status: row.status,
      version: Number(row.version ?? 1),
    }));
  }

  function formatDateOnly(value) {
    if (!value) {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.valueOf())) {
      return String(value).slice(0, 10);
    }

    return date.toISOString().slice(0, 10);
  }

  return {
    async listTicketConfigList({ kind, tenantId }) {
      return listTicketConfigRows(tenantId, kind);
    },
    async saveTicketConfigList({ entries, expectedRevision, kind, tenantId }) {
      const table = TICKET_CONFIG_TABLES[kind];

      await withTransaction(pool, async (connection) => {
        const [existingRows] = await connection.execute(`SELECT id, version FROM ${table} WHERE tenant_id = ? FOR UPDATE`, [tenantId]);
        assertTicketConfigRevision(existingRows, expectedRevision);
        const keptIds = new Set((entries ?? []).map((entry) => entry.id).filter(Boolean));

        for (const row of existingRows) {
          if (!keptIds.has(row.id)) {
            // AC2.4: retiring an entry deactivates it so tickets already pointing at it still read.
            await connection.execute(`UPDATE ${table} SET status = 'inactive', version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ?`, [row.id, tenantId]);
          }
        }

        for (const [index, entry] of (entries ?? []).entries()) {
          const id = entry.id || randomUUID();
          await connection.execute(
            `INSERT INTO ${table} (id, tenant_id, project_id, name, sort_order, status, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))
             ON DUPLICATE KEY UPDATE name = VALUES(name), project_id = VALUES(project_id), sort_order = VALUES(sort_order), status = VALUES(status), version = version + 1, updated_at = NOW(3)`,
            [id, tenantId, entry.projectId ?? null, entry.name, entry.sortOrder ?? index, entry.status ?? 'active'],
          );
        }
      });

      return { entries: await listTicketConfigRows(tenantId, kind) };
    },
    async getTenantSettings({ tenantId }) {
      const [tenantRows] = await pool.execute(
        'SELECT name FROM tenants WHERE id = ? LIMIT 1',
        [tenantId],
      );

      if (!tenantRows[0]) {
        return null;
      }

      const [domainRows] = await pool.execute(
        'SELECT domain FROM tenant_domains WHERE tenant_id = ? ORDER BY domain',
        [tenantId],
      );

      return {
        tenant_name: tenantRows[0].name,
        domains: domainRows.map((row) => row.domain),
      };
    },
    async updateTenant({ tenantId, tenantName, domains }) {
      await withTransaction(pool, async (connection) => {
        await connection.execute('UPDATE tenants SET name = ? WHERE id = ?', [tenantName, tenantId]);
        await connection.execute('DELETE FROM tenant_domains WHERE tenant_id = ?', [tenantId]);

        for (const domain of domains) {
          await connection.execute(
            'INSERT INTO tenant_domains (id, tenant_id, domain) VALUES (?, ?, ?)',
            [randomUUID(), tenantId, domain],
          );
        }
      });

      return { message: 'Tenant updated successfully.' };
    },
    async getOpenAiConfig({ tenantId, defaults }) {
      const [rows] = await pool.execute(
        `
          SELECT value
          FROM preferences
          WHERE tenant_id = ?
            AND user_id IS NULL
            AND project_id IS NULL
            AND \`key\` = 'openai_config'
          LIMIT 1
        `,
        [tenantId],
      );

      const config = safeJsonParse(rows[0]?.value ?? '', null);
      if (!config) {
        return { ...defaults, valid_config: false };
      }

      return {
        openai_key: config.openai_key ?? '',
        available_models: config.available_models ?? [],
        capabilities: config.capabilities ?? {},
        model_to_function: config.model_to_function ?? {},
        valid_config: true,
      };
    },
    async saveOpenAiConfig({ tenantId, config }) {
      const json = JSON.stringify(config ?? {}, null, 0);
      await upsertPreference({
        executor: pool,
        key: 'openai_config',
        projectId: null,
        tenantId,
        userId: null,
        value: json,
      });

      return { message: 'OpenAI config saved.' };
    },
    async deleteOpenAiConfig({ tenantId }) {
      await pool.execute(
        `
          DELETE FROM preferences
          WHERE tenant_id = ?
            AND user_id IS NULL
            AND project_id IS NULL
            AND \`key\` = 'openai_config'
        `,
        [tenantId],
      );

      return { message: 'OpenAI config removed. Tenant will revert to default settings.' };
    },
    async updateUsers({
      tenantId,
      roleChanges = [],
      updates = [],
    } = {}) {
      return withTransaction(pool, async (connection) => {
        for (const change of roleChanges) {
          await connection.execute(
            `
              UPDATE user_tenant ut
              INNER JOIN users u ON u.id = ut.user_id
              SET ut.role = ?
              WHERE ut.tenant_id = ?
                AND LOWER(u.email) = LOWER(?)
            `,
            [change.role, tenantId, change.email],
          );
        }

        for (const update of updates) {
          const [rows] = await connection.execute(
            `
              SELECT u.id AS userId, ut.id AS utId
              FROM users u
              INNER JOIN user_tenant ut ON ut.user_id = u.id
              WHERE ut.tenant_id = ?
                AND LOWER(u.email) = LOWER(?)
              LIMIT 1
            `,
            [tenantId, update.email],
          );
          if (!rows[0]) {
            continue;
          }

          const userId = rows[0].userId;
          const utId = rows[0].utId;

          if (update.name) {
            await connection.execute('UPDATE users SET name = ? WHERE id = ?', [update.name, userId]);
          }

          if (update.role || update.resource_cost !== undefined || update.default_bill_rate !== undefined || update.min_bill_rate !== undefined) {
            const [currentRows] = await connection.execute(
              'SELECT role, resource_cost AS resourceCost, default_bill_rate AS defaultBillRate, min_bill_rate AS minBillRate FROM user_tenant WHERE id = ? LIMIT 1',
              [utId],
            );
            const current = currentRows[0] ?? {};

            await connection.execute(
              `
                UPDATE user_tenant
                SET role = ?,
                    resource_cost = ?,
                    default_bill_rate = ?,
                    min_bill_rate = ?
                WHERE id = ?
              `,
              [
                update.role ?? current.role,
                update.resource_cost !== undefined ? update.resource_cost : current.resourceCost,
                update.default_bill_rate !== undefined ? update.default_bill_rate : current.defaultBillRate,
                update.min_bill_rate !== undefined ? update.min_bill_rate : current.minBillRate,
                utId,
              ],
            );
          }
        }

        return { message: 'Users updated.' };
      });
    },
    async listInvites({ tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT id, email, role, invited_at AS invitedAt, accepted, invite_token AS inviteToken
          FROM user_invites
          WHERE tenant_id = ?
          ORDER BY invited_at DESC
        `,
        [tenantId],
      );

      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        invite_token: row.inviteToken,
        role: row.role,
        sentOn: formatDateOnly(row.invitedAt),
        status: Number(row.accepted ?? 0) === 1 ? 'Accepted' : invitationExpired(row) ? 'Expired' : 'Pending Acceptance',
      }));
    },
    async inviteUser({ tenantId, email, role }) {
      const invitation = { id: randomUUID(), tenantId, email: email.toLowerCase(), role, inviteToken: randomUUID().replace(/-/g, ''), invitedAt: new Date().toISOString(), accepted: false };
      await pool.execute(
        'INSERT INTO user_invites (id, tenant_id, email, role, invite_token, invited_at, accepted) VALUES (?, ?, ?, ?, ?, NOW(), 0)',
        [invitation.id, tenantId, invitation.email, role, invitation.inviteToken],
      );
      return { invitation };
    },
    async findInviteByToken({ inviteToken }) {
      const [rows] = await pool.execute(`SELECT i.id, i.tenant_id AS tenantId, i.email, i.role, i.invite_token AS inviteToken,
        i.invited_at AS invitedAt, i.accepted, t.name AS tenantName FROM user_invites i
        INNER JOIN tenants t ON t.id = i.tenant_id WHERE i.invite_token = ? LIMIT 1`, [inviteToken]);
      return rows[0] ? { ...rows[0], accepted: Boolean(Number(rows[0].accepted)) } : null;
    },
    async renewInvite({ tenantId, inviteToken }) {
      const nextToken = randomUUID().replace(/-/g, '');
      const [result] = await pool.execute('UPDATE user_invites SET invite_token = ?, invited_at = NOW() WHERE tenant_id = ? AND invite_token = ? AND accepted = 0', [nextToken, tenantId, inviteToken]);
      if (!result.affectedRows) throw new HttpError(404, 'Pending invitation not found.');
      return { invitation: await this.findInviteByToken({ inviteToken: nextToken }) };
    },
    async acceptInvite({ inviteToken, userId, registration }) {
      return withTransaction(pool, async connection => {
        const [rows] = await connection.execute(`SELECT id, tenant_id AS tenantId, email, role, invited_at AS invitedAt, accepted
          FROM user_invites WHERE invite_token = ? LIMIT 1 FOR UPDATE`, [inviteToken]);
        const invitation = requireOpenInvitation(rows[0]);
        let acceptedUserId = userId;
        if (registration) {
          const [existing] = await connection.execute('SELECT id FROM users WHERE email = ? LIMIT 1 FOR UPDATE', [invitation.email.toLowerCase()]);
          // An invitation sent to a stakeholder's address proves they hold it, so they claim their file-owner account.
          const claimed = existing.length > 0 && await isUnclaimedStakeholderAccount(connection, { email: invitation.email, userId: existing[0].id });
          if (existing.length && !claimed) throw new HttpError(409, 'An account already exists for this email. Sign in to accept the invitation.');
          if (claimed) {
            acceptedUserId = existing[0].id;
            await connection.execute('UPDATE users SET name = ?, password = ?, authentication_method_id = 1 WHERE id = ?', [registration.name, registration.passwordHash, acceptedUserId]);
          } else {
            acceptedUserId = randomUUID();
            await connection.execute('INSERT INTO users (id, name, email, password, authentication_method_id) VALUES (?, ?, ?, ?, 1)', [acceptedUserId, registration.name, invitation.email.toLowerCase(), registration.passwordHash]);
          }
        } else {
          const [users] = await connection.execute('SELECT email FROM users WHERE id = ? LIMIT 1', [acceptedUserId]);
          if (!users[0] || users[0].email.toLowerCase() !== invitation.email.toLowerCase()) throw new HttpError(403, 'Sign in with the email address this invitation was sent to.');
        }
        await addWorkspaceMembershipMysql(connection, { role: invitation.role, tenantId: invitation.tenantId, userId: acceptedUserId });
        await connection.execute('UPDATE user_invites SET accepted = 1 WHERE tenant_id = ? AND email = ? AND accepted = 0', [invitation.tenantId, invitation.email]);
        return { userId: acceptedUserId, tenantId: invitation.tenantId };
      });
    },
    async revokeInvite({ tenantId, inviteToken }) {
      const [rows] = await pool.execute(
        `
          SELECT id, invited_at AS invitedAt, accepted
          FROM user_invites
          WHERE tenant_id = ?
            AND invite_token = ?
          LIMIT 1
        `,
        [tenantId, inviteToken],
      );
      const invite = rows[0] ?? null;
      if (!invite) {
        return { ok: false, reason: 'not_found' };
      }
      if (Number(invite.accepted ?? 0) === 1) {
        return { ok: false, reason: 'accepted' };
      }

      const invitedAt = invite.invitedAt instanceof Date ? invite.invitedAt : new Date(invite.invitedAt);
      if (!Number.isNaN(invitedAt.valueOf())) {
        const diffDays = Math.floor((Date.now() - invitedAt.valueOf()) / (1000 * 60 * 60 * 24));
        if (diffDays > 30) {
          return { ok: false, reason: 'expired' };
        }
      }

      await pool.execute('DELETE FROM user_invites WHERE id = ?', [invite.id]);
      return { ok: true };
    },
    async listExistingUsers({ tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            ut.role,
            ut.resource_cost AS resource_cost,
            ut.default_bill_rate AS default_bill_rate,
            ut.min_bill_rate AS min_bill_rate,
            am.name AS authMethod,
            CASE WHEN tf.value IS NULL OR tf.value = '' THEN 0 ELSE 1 END AS twoFA,
            COALESCE(avatar.value, '') AS img_url
          FROM user_tenant ut
          INNER JOIN users u ON u.id = ut.user_id
          INNER JOIN authentication_methods am ON am.id = u.authentication_method_id
          LEFT JOIN preferences tf
            ON tf.user_id = u.id
            AND tf.tenant_id IS NULL
            AND tf.project_id IS NULL
            AND tf.key = 'two_factor_secret'
          LEFT JOIN preferences avatar
            ON avatar.user_id = u.id
            AND avatar.tenant_id IS NULL
            AND avatar.project_id IS NULL
            AND avatar.key = 'user_avatar'
          WHERE ut.tenant_id = ?
          ORDER BY u.name ASC
        `,
        [tenantId],
      );

      return rows.map((row) => ({
        ...row,
        twoFA: Number(row.twoFA ?? 0) === 1,
      }));
    },
    async provisionUser({ email, name, role = 'user', tenantId }) {
      return withTransaction(pool, async (connection) => {
        await connection.execute("INSERT INTO authentication_methods (id, name, description) VALUES (1, 'basic', 'Email and password authentication') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)");
        const [rows] = await connection.execute('SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [email]);
        const userId = rows[0]?.id ?? randomUUID();
        if (!rows[0]) await connection.execute('INSERT INTO users (id, name, email, password, authentication_method_id) VALUES (?, ?, ?, NULL, 1)', [userId, name, email.toLowerCase()]);
        else await connection.execute('UPDATE users SET name = ? WHERE id = ?', [name, userId]);
        const [memberships] = await connection.execute('SELECT id FROM user_tenant WHERE user_id = ? AND tenant_id = ? LIMIT 1', [userId, tenantId]);
        if (memberships[0]) await connection.execute('UPDATE user_tenant SET role = ?, updated_at = NOW() WHERE id = ?', [role, memberships[0].id]);
        else await connection.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())', [randomUUID(), userId, tenantId, role]);
        return { email: email.toLowerCase(), id: userId, name, role };
      });
    },
    async removeUserFromTenant({ tenantId, userId }) {
      const [result] = await pool.execute(
        'DELETE FROM user_tenant WHERE tenant_id = ? AND user_id = ?',
        [tenantId, userId],
      );
      return result.affectedRows > 0;
    },
    async listStatusDefinitions({ tenantId }) {
      const [defaultRows] = await pool.execute(
        `
          SELECT id, task_status_name AS name, sort_order, 1 AS is_default
          FROM task_statuses
          WHERE tenant_id IS NULL
            AND project_id IS NULL
            AND deleted = 0
          ORDER BY sort_order
        `,
      );
      const [customRows] = await pool.execute(
        `
          SELECT id, task_status_name AS name, sort_order, 0 AS is_default
          FROM task_statuses
          WHERE tenant_id = ?
            AND project_id IS NULL
            AND deleted = 0
          ORDER BY sort_order
        `,
        [tenantId],
      );

      return [...defaultRows, ...customRows];
    },
    async saveStatusDefinitions({ tenantId, statuses }) {
      return withTransaction(pool, async (connection) => {
        const [defaultRows] = await connection.execute(
          `
            SELECT id
            FROM task_statuses
            WHERE tenant_id IS NULL
              AND project_id IS NULL
              AND deleted = 0
          `,
        );
        const defaultIds = new Set(defaultRows.map((row) => row.id));

        const [currentRows] = await connection.execute(
          'SELECT id FROM task_statuses WHERE tenant_id = ? AND project_id IS NULL',
          [tenantId],
        );
        const currentCustomIds = currentRows.map((row) => row.id);

        const incomingCustom = (statuses ?? []).filter((row) => !defaultIds.has(row.id));
        const incomingCustomIds = new Set(incomingCustom.map((row) => row.id).filter(Boolean));

        for (const id of currentCustomIds) {
          if (!incomingCustomIds.has(id)) {
            await connection.execute('DELETE FROM task_statuses WHERE id = ? AND tenant_id = ?', [id, tenantId]);
          }
        }

        for (const status of incomingCustom) {
          const id = status.id && incomingCustomIds.has(status.id) ? status.id : '';
          if (!id || !currentCustomIds.includes(id)) {
            await connection.execute(
              'INSERT INTO task_statuses (id, tenant_id, project_id, task_status_name, sort_order, deleted) VALUES (?, ?, NULL, ?, ?, 0)',
              [randomUUID(), tenantId, status.name, status.sort_order ?? 0],
            );
          } else {
            await connection.execute(
              'UPDATE task_statuses SET task_status_name = ?, sort_order = ? WHERE id = ? AND tenant_id = ?',
              [status.name, status.sort_order ?? 0, id, tenantId],
            );
          }
        }

        return { message: 'Statuses updated.' };
      });
    },
    async resetStatusDefinitions({ tenantId }) {
      await pool.execute('DELETE FROM task_statuses WHERE tenant_id = ? AND project_id IS NULL', [tenantId]);
      return { message: 'Statuses reset.' };
    },
    async listTaskTypeDefinitions({ tenantId }) {
      const [defaultRows] = await pool.execute(
        `
          SELECT id, task_type_name AS name, sort_order, 1 AS is_default
          FROM task_types
          WHERE tenant_id IS NULL
            AND project_id IS NULL
            AND deleted = 0
          ORDER BY sort_order
        `,
      );
      const [customRows] = await pool.execute(
        `
          SELECT id, task_type_name AS name, sort_order, 0 AS is_default
          FROM task_types
          WHERE tenant_id = ?
            AND project_id IS NULL
            AND deleted = 0
          ORDER BY sort_order
        `,
        [tenantId],
      );

      return [...defaultRows, ...customRows];
    },
    async saveTaskTypeDefinitions({ tenantId, taskTypes }) {
      return withTransaction(pool, async (connection) => {
        const [defaultRows] = await connection.execute(
          `
            SELECT id
            FROM task_types
            WHERE tenant_id IS NULL
              AND project_id IS NULL
              AND deleted = 0
          `,
        );
        const defaultIds = new Set(defaultRows.map((row) => row.id));

        const [currentRows] = await connection.execute(
          'SELECT id FROM task_types WHERE tenant_id = ? AND project_id IS NULL',
          [tenantId],
        );
        const currentCustomIds = currentRows.map((row) => row.id);

        const incomingCustom = (taskTypes ?? []).filter((row) => !defaultIds.has(row.id));
        const incomingCustomIds = new Set(incomingCustom.map((row) => row.id).filter(Boolean));

        for (const id of currentCustomIds) {
          if (!incomingCustomIds.has(id)) {
            // Soft-delete if referenced.
            const inUse = await connection.execute('SELECT COUNT(*) AS count FROM tasks WHERE task_type = ? AND deleted = 0', [id])
              .then(([rows]) => Number(rows[0]?.count ?? 0) > 0);
            if (inUse) {
              await connection.execute('UPDATE task_types SET deleted = 1 WHERE id = ? AND tenant_id = ?', [id, tenantId]);
            } else {
              await connection.execute('DELETE FROM task_types WHERE id = ? AND tenant_id = ?', [id, tenantId]);
            }
          }
        }

        for (const type of incomingCustom) {
          const id = type.id && incomingCustomIds.has(type.id) ? type.id : '';
          if (!id || !currentCustomIds.includes(id)) {
            // task_types.id is AUTO_INCREMENT in the legacy schema; allow insert without specifying id.
            await connection.execute(
              'INSERT INTO task_types (tenant_id, project_id, task_type_name, sort_order, deleted) VALUES (?, NULL, ?, ?, 0)',
              [tenantId, type.name, type.sort_order ?? 0],
            );
          } else {
            await connection.execute(
              'UPDATE task_types SET task_type_name = ?, sort_order = ? WHERE id = ? AND tenant_id = ?',
              [type.name, type.sort_order ?? 0, id, tenantId],
            );
          }
        }

        return { message: 'Task types updated.' };
      });
    },
    async resetTaskTypeDefinitions({ tenantId }) {
      await pool.execute('DELETE FROM task_types WHERE tenant_id = ? AND project_id IS NULL', [tenantId]);
      return { message: 'Task types reset.' };
    },
    async listAuditLogs({
      tenantId,
      startDate,
      endDate,
      searchText = '',
      applySearch = false,
    }) {
      const start = `${startDate} 00:00:00`;
      const end = `${endDate} 23:59:59`;

      const params = [start, end, tenantId, tenantId, tenantId];
      const searchClause = applySearch
        ? `
            AND (
                 a.action LIKE ?
              OR a.result LIKE ?
              OR p.name  LIKE ?
              OR u.name  LIKE ?
              OR a.detail LIKE ?
            )
          `
        : '';

      if (applySearch) {
        const like = `%${searchText}%`;
        params.push(like, like, like, like, like);
      }

      const [rows] = await pool.execute(
        `
          SELECT a.id,
                 a.dt_stamp AS dtStamp,
                 (UNIX_TIMESTAMP(a.dt_stamp) * 1000) AS epochMs,
                 u.id as userId,
                 COALESCE(u.name, 'Unknown User') AS userFullName,
                 p.name as projectName,
                 p.id as projectId,
                 a.action,
                 a.result,
                 a.detail
          FROM audit_log a
          LEFT JOIN users u ON a.user_id = u.id
          LEFT JOIN projects p ON a.project_id = p.id
          WHERE a.dt_stamp >= ?
            AND a.dt_stamp <= DATE_ADD(?, INTERVAL 1 DAY)
            AND (
                 a.tenant_id = ?
              OR a.user_id IN (SELECT user_id FROM user_tenant WHERE tenant_id = ?)
              OR a.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
            )
          ${searchClause}
          ORDER BY a.dt_stamp DESC
        `,
        params,
      );

      return rows.map((row) => ({
        dt_stamp: Number(row.epochMs ?? 0),
        date_time: `${row.dtStamp} UTC`,
        user_id: row.userId,
        user_full_name: row.userFullName,
        project_name: row.projectName,
        project_id: row.projectId,
        action: row.action,
        result: row.result,
        detail: row.detail ?? null,
      }));
    },
    async exportTenantBackupData({ tenantId }) {
      const [tenantRows] = await pool.execute(
        'SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM tenants WHERE id = ? LIMIT 1',
        [tenantId],
      );
      const tenant = tenantRows[0] ?? null;
      if (!tenant) {
        return null;
      }

      const [domainRows] = await pool.execute(
        'SELECT domain FROM tenant_domains WHERE tenant_id = ? ORDER BY domain',
        [tenantId],
      );
      const domains = domainRows.map((row) => row.domain);

      const [userRows] = await pool.execute(
        `
          SELECT u.id, u.name, u.email, ut.role, u.created_at AS created_at, u.updated_at AS updated_at
          FROM users u
          INNER JOIN user_tenant ut ON ut.user_id = u.id
          WHERE ut.tenant_id = ?
        `,
        [tenantId],
      );

      const [projectsRows] = await pool.execute(
        `
          SELECT id, name, description, project_status, start_date, end_date, created_at, updated_at
          FROM projects
          WHERE tenant_id = ?
            AND COALESCE(deleted, 0) = 0
        `,
        [tenantId],
      );

      const projects = [];
      for (const project of projectsRows) {
        const projectId = project.id;
        const [taskRows] = await pool.execute(
          `
            SELECT id,
                   parent_task_id,
                   task_type,
                   sort_order,
                   name,
                   description,
                   priority,
                   points,
                   target_start_date,
                   target_end_date,
                   target_hour_estimate,
                   created_at,
                   updated_at
            FROM tasks
            WHERE project_id = ?
              AND deleted = 0
            ORDER BY sort_order ASC, created_at ASC
          `,
          [projectId],
        );

        const tasks = [];
        for (const task of taskRows) {
          const [logRows] = await pool.execute(
            `
              SELECT id, log_date, log_action, log_data
              FROM task_log
              WHERE task_id = ?
              ORDER BY log_date ASC
            `,
            [task.id],
          );

          tasks.push({
            ...task,
            log: logRows,
          });
        }

        projects.push({
          ...project,
          tasks,
        });
      }

      const [prefRows] = await pool.execute(
        `
          SELECT id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at
          FROM preferences
          WHERE tenant_id = ?
        `,
        [tenantId],
      );

      const [statusRows] = await pool.execute(
        `
          SELECT id, task_status_name, sort_order, deleted
          FROM task_statuses
          WHERE tenant_id = ?
            AND project_id IS NULL
        `,
        [tenantId],
      );

      const [typeRows] = await pool.execute(
        `
          SELECT id, task_type_name, sort_order, deleted
          FROM task_types
          WHERE tenant_id = ?
            AND project_id IS NULL
        `,
        [tenantId],
      );

      let userProjectRows = [];
      if (projects.length) {
        const [rows] = await pool.execute(
          `
            SELECT id, user_id, project_id, role, created_at, updated_at, project_bill_rate, project_allocation
            FROM user_project
            WHERE project_id IN (${projects.map(() => '?').join(', ')})
          `,
          projects.map((p) => p.id),
        );
        userProjectRows = rows;
      }

      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          created_at: tenant.createdAt,
          updated_at: tenant.updatedAt,
        },
        domains,
        users: userRows,
        projects,
        preferences: prefRows,
        task_statuses: statusRows,
        task_types: typeRows,
        user_project: userProjectRows,
      };
    },
    async restoreTenantFromBackupData({ tenantId, backupData }) {
      if (!backupData) {
        throw new Error('Invalid backup data.');
      }

      return withTransaction(pool, async (connection) => {
        if (backupData.tenant?.name) {
          await connection.execute('UPDATE tenants SET name = ? WHERE id = ?', [backupData.tenant.name, tenantId]);
        }

        const [projectRows] = await connection.execute(
          'SELECT id FROM projects WHERE tenant_id = ?',
          [tenantId],
        );
        const projectIds = projectRows.map((row) => row.id);

        if (projectIds.length) {
          const placeholders = projectIds.map(() => '?').join(', ');
          await connection.execute(`DELETE FROM task_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (${placeholders}))`, projectIds);
          await connection.execute(`DELETE FROM tasks WHERE project_id IN (${placeholders})`, projectIds);
          await connection.execute(`DELETE FROM user_project WHERE project_id IN (${placeholders})`, projectIds);
        }

        await connection.execute('DELETE FROM projects WHERE tenant_id = ?', [tenantId]);
        await connection.execute('DELETE FROM user_tenant WHERE tenant_id = ?', [tenantId]);
        await connection.execute('DELETE FROM tenant_domains WHERE tenant_id = ?', [tenantId]);
        await connection.execute('DELETE FROM preferences WHERE tenant_id = ?', [tenantId]);
        await connection.execute('DELETE FROM task_statuses WHERE tenant_id = ? AND project_id IS NULL', [tenantId]);
        await connection.execute('DELETE FROM task_types WHERE tenant_id = ? AND project_id IS NULL', [tenantId]);

        if (Array.isArray(backupData.domains)) {
          for (const domain of backupData.domains) {
            await connection.execute(
              'INSERT INTO tenant_domains (id, tenant_id, domain) VALUES (?, ?, ?)',
              [randomUUID(), tenantId, domain],
            );
          }
        }

        if (Array.isArray(backupData.users)) {
          for (const user of backupData.users) {
            const [existing] = await connection.execute('SELECT id FROM users WHERE id = ? LIMIT 1', [user.id]);
            if (!existing[0]?.id) {
              await connection.execute(
                'INSERT INTO users (id, name, email, authentication_method_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
                [user.id, user.name, user.email, user.created_at, user.updated_at],
              );
            }

            await connection.execute(
              'INSERT INTO user_tenant (id, user_id, tenant_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
              [randomUUID(), user.id, tenantId, user.role, user.created_at, user.updated_at],
            );
          }
        }

        if (Array.isArray(backupData.task_statuses)) {
          for (const status of backupData.task_statuses) {
            await connection.execute(
              'INSERT INTO task_statuses (id, tenant_id, project_id, task_status_name, sort_order, deleted) VALUES (?, ?, NULL, ?, ?, ?)',
              [status.id, tenantId, status.task_status_name ?? status.name ?? '', status.sort_order ?? 0, status.deleted ?? 0],
            );
          }
        }

        if (Array.isArray(backupData.task_types)) {
          for (const type of backupData.task_types) {
            await connection.execute(
              'INSERT INTO task_types (id, tenant_id, project_id, task_type_name, sort_order, deleted) VALUES (?, ?, NULL, ?, ?, ?)',
              [type.id, tenantId, type.task_type_name ?? type.name ?? '', type.sort_order ?? 0, type.deleted ?? 0],
            );
          }
        }

        if (Array.isArray(backupData.preferences)) {
          for (const pref of backupData.preferences) {
            await connection.execute(
              'INSERT INTO preferences (id, tenant_id, user_id, project_id, `key`, `value`, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [pref.id ?? randomUUID(), tenantId, pref.user_id ?? null, pref.project_id ?? null, pref.key, pref.value, pref.updated_at ?? new Date().toISOString().slice(0, 19).replace('T', ' ')],
            );
          }
        }

        if (Array.isArray(backupData.projects)) {
          for (const proj of backupData.projects) {
            await connection.execute(
              'INSERT INTO projects (id, tenant_id, name, description, project_status, start_date, end_date, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
              [proj.id, tenantId, proj.name, proj.description ?? '', proj.project_status, proj.start_date ?? null, proj.end_date ?? null, proj.created_at, proj.updated_at],
            );

            if (Array.isArray(proj.tasks)) {
              for (const task of proj.tasks) {
                await connection.execute(
                  'INSERT INTO tasks (id, project_id, task_type, parent_task_id, name, description, priority, points, target_start_date, target_end_date, target_hour_estimate, created_at, updated_at, deleted, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
                  [
                    task.id,
                    proj.id,
                    task.task_type ?? 1,
                    task.parent_task_id ?? null,
                    task.name,
                    task.description ?? '',
                    task.priority ?? null,
                    task.points ?? null,
                    task.target_start_date ?? null,
                    task.target_end_date ?? null,
                    task.target_hour_estimate ?? null,
                    task.created_at,
                    task.updated_at,
                    task.sort_order ?? 0,
                  ],
                );

                if (Array.isArray(task.log)) {
                  for (const log of task.log) {
                    await connection.execute(
                      'INSERT INTO task_log (id, task_id, log_date, log_action, log_data) VALUES (?, ?, ?, ?, ?)',
                      [log.id ?? randomUUID(), task.id, log.log_date, log.log_action, log.log_data ?? null],
                    );
                  }
                }
              }
            }
          }
        }

        if (Array.isArray(backupData.user_project)) {
          for (const mapping of backupData.user_project) {
            await connection.execute(
              'INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at, project_bill_rate, project_allocation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [
                mapping.id ?? randomUUID(),
                mapping.user_id,
                mapping.project_id,
                mapping.role,
                mapping.created_at,
                mapping.updated_at,
                mapping.project_bill_rate ?? null,
                mapping.project_allocation ?? null,
              ],
            );
          }
        }

        return { message: 'Tenant restored.' };
      });
    },
  };
}
