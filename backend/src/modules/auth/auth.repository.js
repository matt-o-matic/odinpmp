import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

import { readUserPreferencesMemory, readUserPreferencesMysql } from '../users/notification-preferences.js';
import { isStakeholderEmail } from './stakeholder-accounts.js';

const BASIC_AUTH_METHOD_ID = 1;
const GOOGLE_AUTH_METHOD_ID = 2;
const DEFAULT_INVALID_DOMAINS = ['gmail.com', 'hotmail.com', 'icloud.com', 'outlook.com', 'yahoo.com'];
const DEMO_PASSWORD = 'DemoPass123!';

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

// 0084_authentication_methods: the basic and Google sign-in methods that users rows reference.
export async function ensureMysqlAuthenticationMethods(executor) {
  const [rows] = await executor.execute(
    `
      SELECT id
      FROM authentication_methods
      WHERE id IN (?, ?)
    `,
    [BASIC_AUTH_METHOD_ID, GOOGLE_AUTH_METHOD_ID],
  );
  const existingIds = new Set((rows ?? []).map((row) => Number(row.id)));

  if (!existingIds.has(BASIC_AUTH_METHOD_ID)) {
    await executor.execute(
      `
        INSERT INTO authentication_methods (id, name, description)
        VALUES (?, 'basic', 'Email and password authentication')
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          description = VALUES(description)
      `,
      [BASIC_AUTH_METHOD_ID],
    );
  }

  if (!existingIds.has(GOOGLE_AUTH_METHOD_ID)) {
    await executor.execute(
      `
        INSERT INTO authentication_methods (id, name, description)
        VALUES (?, 'google', 'Google OAuth authentication')
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          description = VALUES(description)
      `,
      [GOOGLE_AUTH_METHOD_ID],
    );
  }
}

async function normalizeUser(user) {
  return {
    id: user.id ?? randomUUID(),
    name: user.name,
    email: user.email.toLowerCase(),
    passwordHash: user.passwordHash ?? (user.password ? await bcrypt.hash(user.password, 10) : ''),
    authMethod: user.authMethod ?? 'basic',
    memberships: user.memberships ?? [],
    picture: user.picture ?? '/images/avatar_default.jpg',
    preferences: {
      twoFactorEnabled: Boolean(user.preferences?.twoFactorEnabled),
    },
    twoFactorSecret: user.twoFactorSecret ?? '',
    pendingTwoFactorSecret: user.pendingTwoFactorSecret ?? '',
    backupCodes: user.backupCodes ?? [],
  };
}

async function normalizeState(seed = {}) {
  const tenants = (seed.tenants ?? []).map((tenant) => ({
    domains: (tenant.domains ?? []).map((domain) => domain.toLowerCase()),
    id: tenant.id ?? randomUUID(),
    name: tenant.name,
  }));
  const users = [];

  for (const user of seed.users ?? []) {
    users.push(await normalizeUser(user));
  }

  if (users.length === 0 && seed.disableDemoUser !== true) {
    const tenantId = randomUUID();

    tenants.push({
      domains: ['odinpmp.local'],
      id: tenantId,
      name: 'OdinPMP Demo',
    });

    users.push(
      await normalizeUser({
        email: 'demo@odinpmp.local',
        memberships: [{ role: 'admin', tenantId }],
        name: 'Demo User',
        password: DEMO_PASSWORD,
      }),
    );
  }

  return {
    invalidDomains: (seed.invalidDomains ?? DEFAULT_INVALID_DOMAINS).map((domain) => domain.toLowerCase()),
    // Stands in for the project_stakeholders table, which this repository cannot see.
    stakeholderEmails: new Set((seed.stakeholderEmails ?? []).map((email) => email.toLowerCase())),
    pendingRegistrations: [],
    tenants,
    users,
  };
}

// 0085_pending_registrations: password sign-ups wait here until the emailed link is clicked;
// nothing else exists for them until then.
export async function ensureMysqlPendingRegistrationsSchema(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(320) NOT NULL,
      name VARCHAR(120) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      tenant_name VARCHAR(120) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_pending_registrations_email (email),
      UNIQUE KEY uq_pending_registrations_token (token_hash),
      KEY idx_pending_registrations_expires (expires_at)
    )
  `);
}

function mapPendingRegistration(row) {
  return row
    ? {
        createdAt: new Date(row.created_at),
        email: row.email,
        expiresAt: new Date(row.expires_at),
        id: row.id,
        name: row.name,
        passwordHash: row.password_hash,
        tenantName: row.tenant_name,
      }
    : null;
}

export async function createInMemoryAuthRepository(seed = {}) {
  const state = await normalizeState(seed);
  // See stakeholder-accounts.js: a stakeholder's account without a membership cannot sign in.
  const withLoginState = (user) => {
    if (user) user.loginDisabled = user.memberships.length === 0 && state.stakeholderEmails.has(user.email);
    return user ?? null;
  };

  return {
    state,
    async findUserByEmail(email) {
      return withLoginState(state.users.find((user) => user.email === email.toLowerCase()));
    },
    async findUserById(userId) {
      return withLoginState(state.users.find((user) => user.id === userId));
    },
    async listUserPreferences(query) {
      return readUserPreferencesMemory(state.users, query);
    },
    async findOrCreateStakeholderOwner({ email, name }) {
      const address = String(email ?? '').trim().toLowerCase();
      if (!address.includes('@')) return null;
      state.stakeholderEmails.add(address);
      let user = state.users.find((candidate) => candidate.email === address);
      if (!user) {
        user = await normalizeUser({ email: address, memberships: [], name: String(name ?? '').trim() || address });
        state.users.push(user);
      }
      return { id: user.id, name: user.name };
    },
    async findTenantByDomain(domain) {
      return state.tenants.find((tenant) => tenant.domains.includes(domain.toLowerCase())) ?? null;
    },
    async findTenantById(tenantId) {
      return state.tenants.find((tenant) => tenant.id === tenantId) ?? null;
    },
    async findTenantByName(name) {
      return state.tenants.find((tenant) => tenant.name.toLowerCase() === name.toLowerCase()) ?? null;
    },
    async isEmailAvailable(email) {
      return (await this.findUserByEmail(email)) === null;
    },
    async isTenantNameAvailable(name) {
      return (await this.findTenantByName(name)) === null;
    },
    // A new sign-up for the same email replaces the earlier one, so only the latest link works.
    async savePendingRegistration({ email, expiresAt, name, passwordHash, tenantName, tokenHash }) {
      const now = new Date();
      const address = email.toLowerCase();
      state.pendingRegistrations = state.pendingRegistrations.filter((row) => row.email !== address && row.expiresAt > now);
      const row = { createdAt: now, email: address, expiresAt, id: randomUUID(), name, passwordHash, tenantName, tokenHash };
      state.pendingRegistrations.push(row);
      return { ...row };
    },
    // Removes the sign-up as it is read, so a link can only be used once.
    async takePendingRegistration(tokenHash) {
      const index = state.pendingRegistrations.findIndex((row) => row.tokenHash === tokenHash);
      if (index === -1) return null;
      const [row] = state.pendingRegistrations.splice(index, 1);
      return { ...row };
    },
    async createRegistration(input) {
      const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
      let tenant = null;

      if (input.createTenant) {
        tenant = {
          domains: state.invalidDomains.includes(domain) ? [] : [domain],
          id: randomUUID(),
          name: input.tenantName,
        };
        state.tenants.push(tenant);
      } else {
        tenant = await this.findTenantById(input.tenantId);
      }

      if (!tenant) {
        throw new Error('Unable to resolve tenant for registration.');
      }

      const user = await normalizeUser({
        authMethod: input.authMethod,
        email: input.email,
        memberships: [{ role: input.role, tenantId: tenant.id }],
        name: input.name,
        passwordHash: input.passwordHash,
      });

      state.users.push(user);

      return {
        tenant,
        user,
      };
    },
    async setPendingTwoFactorSecret(userId, secret) {
      const user = await this.findUserById(userId);

      if (!user) {
        return;
      }

      user.pendingTwoFactorSecret = secret;
    },
    async getPendingTwoFactorSecret(userId) {
      const user = await this.findUserById(userId);
      return user?.pendingTwoFactorSecret ?? '';
    },
    async enableTwoFactor(userId, { backupCodes, secret }) {
      const user = await this.findUserById(userId);

      if (!user) {
        return;
      }

      user.twoFactorSecret = secret;
      user.pendingTwoFactorSecret = '';
      user.preferences.twoFactorEnabled = true;
      user.backupCodes = [...backupCodes];
    },
    async getTwoFactorSecret(userId) {
      const user = await this.findUserById(userId);
      return user?.twoFactorSecret ?? '';
    },
    async getBackupCodes(userId) {
      const user = await this.findUserById(userId);
      return [...(user?.backupCodes ?? [])];
    },
    async consumeBackupCode(userId, code) {
      const user = await this.findUserById(userId);

      if (!user) {
        return false;
      }

      const index = user.backupCodes.findIndex((backupCode) => backupCode === code);

      if (index === -1) {
        return false;
      }

      user.backupCodes.splice(index, 1);
      return true;
    },
    async disableTwoFactor(userId) {
      const user = await this.findUserById(userId);

      if (!user) {
        return;
      }

      user.twoFactorSecret = '';
      user.pendingTwoFactorSecret = '';
      user.preferences.twoFactorEnabled = false;
      user.backupCodes = [];
    },
  };
}

function authenticationMethodId(authMethod) {
  return authMethod === 'google' ? GOOGLE_AUTH_METHOD_ID : BASIC_AUTH_METHOD_ID;
}

function hydrateUser(rows) {
  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];
  const preferences = first.userPreferences ? JSON.parse(first.userPreferences) : {};
  const backupCodes = rows
    .map((row) => row.backupCode)
    .filter(Boolean);
  const memberships = rows
    .filter((row) => row.tenantId)
    .map((row) => ({
      role: row.tenantRole,
      tenantId: row.tenantId,
    }));

  return {
    authMethod: Number(first.authenticationMethodId) === GOOGLE_AUTH_METHOD_ID ? 'google' : 'basic',
    backupCodes,
    email: first.email,
    id: first.id,
    memberships,
    name: first.name,
    passwordHash: first.passwordHash ?? '',
    pendingTwoFactorSecret: '',
    picture: first.userAvatar ?? '/images/avatar_default.jpg',
    preferences: {
      twoFactorEnabled: Boolean(preferences.twoFactorEnabled),
    },
    twoFactorSecret: first.twoFactorSecret ?? '',
  };
}

export function createMysqlAuthRepository({ pool }) {
  // See stakeholder-accounts.js: a stakeholder's account without a membership cannot sign in.
  async function withLoginState(user) {
    if (user) user.loginDisabled = user.memberships.length === 0 && await isStakeholderEmail(pool, user.email);
    return user;
  }

  return {
    async findUserByEmail(email) {
      const [rows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            u.password AS passwordHash,
            u.authentication_method_id AS authenticationMethodId,
            ut.tenant_id AS tenantId,
            ut.role AS tenantRole,
            secret_pref.value AS twoFactorSecret,
            prefs_pref.value AS userPreferences,
            avatar_pref.value AS userAvatar,
            bc.code AS backupCode
          FROM users u
          LEFT JOIN user_tenant ut ON ut.user_id = u.id
          LEFT JOIN preferences secret_pref
            ON secret_pref.user_id = u.id
            AND secret_pref.tenant_id IS NULL
            AND secret_pref.project_id IS NULL
            AND secret_pref.key = 'two_factor_secret'
          LEFT JOIN preferences prefs_pref
            ON prefs_pref.user_id = u.id
            AND prefs_pref.tenant_id IS NULL
            AND prefs_pref.project_id IS NULL
            AND prefs_pref.key = 'user_preferences'
          LEFT JOIN preferences avatar_pref
            ON avatar_pref.user_id = u.id
            AND avatar_pref.tenant_id IS NULL
            AND avatar_pref.project_id IS NULL
            AND avatar_pref.key = 'user_avatar'
          LEFT JOIN backup_codes bc
            ON bc.user_id = u.id
            AND bc.used = 0
          WHERE u.email = ?
        `,
        [email.toLowerCase()],
      );

      return withLoginState(hydrateUser(rows));
    },
    async findUserById(userId) {
      const [rows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            u.password AS passwordHash,
            u.authentication_method_id AS authenticationMethodId,
            ut.tenant_id AS tenantId,
            ut.role AS tenantRole,
            secret_pref.value AS twoFactorSecret,
            prefs_pref.value AS userPreferences,
            avatar_pref.value AS userAvatar,
            bc.code AS backupCode
          FROM users u
          LEFT JOIN user_tenant ut ON ut.user_id = u.id
          LEFT JOIN preferences secret_pref
            ON secret_pref.user_id = u.id
            AND secret_pref.tenant_id IS NULL
            AND secret_pref.project_id IS NULL
            AND secret_pref.key = 'two_factor_secret'
          LEFT JOIN preferences prefs_pref
            ON prefs_pref.user_id = u.id
            AND prefs_pref.tenant_id IS NULL
            AND prefs_pref.project_id IS NULL
            AND prefs_pref.key = 'user_preferences'
          LEFT JOIN preferences avatar_pref
            ON avatar_pref.user_id = u.id
            AND avatar_pref.tenant_id IS NULL
            AND avatar_pref.project_id IS NULL
            AND avatar_pref.key = 'user_avatar'
          LEFT JOIN backup_codes bc
            ON bc.user_id = u.id
            AND bc.used = 0
          WHERE u.id = ?
        `,
        [userId],
      );

      return withLoginState(hydrateUser(rows));
    },
    async listUserPreferences(query) {
      return readUserPreferencesMysql(pool, query);
    },
    // The account that owns a stakeholder's files. An account with the stakeholder's email is the same
    // person and is reused unchanged; otherwise a no-login account is created with no membership.
    async findOrCreateStakeholderOwner({ email, name }) {
      const address = String(email ?? '').trim().toLowerCase();
      if (!address.includes('@') || !await isStakeholderEmail(pool, address)) return null;
      const select = async () => (await pool.execute('SELECT id, name FROM users WHERE email = ? LIMIT 1', [address]))[0][0] ?? null;
      let row = await select();
      if (!row) {
        try {
          await withTransaction(pool, async (connection) => {
            await connection.execute(
              'INSERT INTO users (id, name, email, password, authentication_method_id) VALUES (?, ?, ?, NULL, ?)',
              [randomUUID(), String(name ?? '').trim() || address, address, BASIC_AUTH_METHOD_ID],
            );
          });
        } catch (error) {
          // A concurrent upload for the same stakeholder created it first.
          if (error?.code !== 'ER_DUP_ENTRY') throw error;
        }
        row = await select();
      }
      return row ? { id: row.id, name: row.name } : null;
    },
    async findTenantByDomain(domain) {
      const [rows] = await pool.execute(
        `
          SELECT t.id, t.name, td.domain
          FROM tenants t
          INNER JOIN tenant_domains td ON td.tenant_id = t.id
          WHERE td.domain = ?
          LIMIT 1
        `,
        [domain.toLowerCase()],
      );

      return rows[0]
        ? {
            domains: [rows[0].domain],
            id: rows[0].id,
            name: rows[0].name,
          }
        : null;
    },
    async findTenantById(tenantId) {
      const [rows] = await pool.execute(
        `
          SELECT id, name
          FROM tenants
          WHERE id = ?
          LIMIT 1
        `,
        [tenantId],
      );

      return rows[0] ?? null;
    },
    async findTenantByName(name) {
      const [rows] = await pool.execute(
        `
          SELECT id, name
          FROM tenants
          WHERE lower(name) = lower(?)
          LIMIT 1
        `,
        [name],
      );

      return rows[0] ?? null;
    },
    async isEmailAvailable(email) {
      return (await this.findUserByEmail(email)) === null;
    },
    async isTenantNameAvailable(name) {
      return (await this.findTenantByName(name)) === null;
    },
    // A new sign-up for the same email replaces the earlier one, so only the latest link works.
    async savePendingRegistration({ email, expiresAt, name, passwordHash, tenantName, tokenHash }) {
      const row = { createdAt: new Date(), email: email.toLowerCase(), expiresAt, id: randomUUID(), name, passwordHash, tenantName, tokenHash };
      await pool.execute('DELETE FROM pending_registrations WHERE expires_at <= ?', [row.createdAt]);
      await pool.execute(
        `
          INSERT INTO pending_registrations (id, email, name, password_hash, tenant_name, token_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE id = VALUES(id), name = VALUES(name), password_hash = VALUES(password_hash),
            tenant_name = VALUES(tenant_name), token_hash = VALUES(token_hash), created_at = VALUES(created_at),
            expires_at = VALUES(expires_at)
        `,
        [row.id, row.email, row.name, row.passwordHash, row.tenantName, row.tokenHash, row.createdAt, row.expiresAt],
      );
      return row;
    },
    // Removes the sign-up as it is read, so a link can only be used once.
    async takePendingRegistration(tokenHash) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute('SELECT * FROM pending_registrations WHERE token_hash = ? LIMIT 1 FOR UPDATE', [tokenHash]);
        if (!rows[0]) return null;
        await connection.execute('DELETE FROM pending_registrations WHERE id = ?', [rows[0].id]);
        return mapPendingRegistration(rows[0]);
      });
    },
    async createRegistration(input) {
      const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
      const result = await withTransaction(pool, async (connection) => {
        let tenantId = null;

        if (input.createTenant) {
          tenantId = randomUUID();
          await connection.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, input.tenantName]);

          if (!DEFAULT_INVALID_DOMAINS.includes(domain)) {
            await connection.execute(
              'INSERT INTO tenant_domains (id, tenant_id, domain) VALUES (?, ?, ?)',
              [randomUUID(), tenantId, domain],
            );
          }
        } else {
          const [tenantRows] = await connection.execute(
            'SELECT id FROM tenants WHERE id = ? LIMIT 1',
            [input.tenantId ?? null],
          );
          const tenant = tenantRows[0] ?? null;

          if (!tenant) {
            throw new Error('Tenant not found.');
          }

          tenantId = tenant.id;
        }

        const userId = randomUUID();

        await connection.execute(
          'INSERT INTO users (id, name, email, password, authentication_method_id) VALUES (?, ?, ?, ?, ?)',
          [
            userId,
            input.name,
            input.email.toLowerCase(),
            input.passwordHash,
            authenticationMethodId(input.authMethod),
          ],
        );

        await connection.execute(
          'INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)',
          [randomUUID(), userId, tenantId, input.role],
        );

        return {
          tenantId,
          userId,
        };
      });

      return {
        tenant: await this.findTenantById(result.tenantId),
        user: await this.findUserById(result.userId),
      };
    },
    async setPendingTwoFactorSecret(userId, secret) {
      const [rows] = await pool.execute(
        `
          SELECT id
          FROM preferences
          WHERE user_id = ?
            AND tenant_id IS NULL
            AND project_id IS NULL
            AND \`key\` = 'two_factor_secret'
          LIMIT 1
        `,
        [userId],
      );

      if (rows[0]?.id) {
        await pool.execute(
          'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
          [secret, rows[0].id],
        );
        return;
      }

      await pool.execute(
        `
          INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
          VALUES (?, NULL, ?, NULL, 'two_factor_secret', ?, NOW())
        `,
        [randomUUID(), userId, secret],
      );
    },
    async getPendingTwoFactorSecret(userId) {
      const [rows] = await pool.execute(
        `
          SELECT value
          FROM preferences
          WHERE user_id = ?
            AND tenant_id IS NULL
            AND project_id IS NULL
            AND \`key\` = 'two_factor_secret'
          LIMIT 1
        `,
        [userId],
      );

      return rows[0]?.value ?? '';
    },
    async enableTwoFactor(userId, { backupCodes, secret }) {
      await withTransaction(pool, async (connection) => {
        const [preferenceRows] = await connection.execute(
          `
            SELECT id, value
            FROM preferences
            WHERE user_id = ?
              AND tenant_id IS NULL
              AND project_id IS NULL
              AND \`key\` = 'user_preferences'
            LIMIT 1
          `,
          [userId],
        );
        const existingPreferences = preferenceRows[0]?.value ? JSON.parse(preferenceRows[0].value) : {};
        existingPreferences.twoFactorEnabled = true;

        const [secretRows] = await connection.execute(
          `
            SELECT id
            FROM preferences
            WHERE user_id = ?
              AND tenant_id IS NULL
              AND project_id IS NULL
              AND \`key\` = 'two_factor_secret'
            LIMIT 1
          `,
          [userId],
        );

        if (secretRows[0]?.id) {
          await connection.execute(
            'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
            [secret, secretRows[0].id],
          );
        } else {
          await connection.execute(
            `
              INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
              VALUES (?, NULL, ?, NULL, 'two_factor_secret', ?, NOW())
            `,
            [randomUUID(), userId, secret],
          );
        }

        if (preferenceRows[0]) {
          await connection.execute(
            'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
            [JSON.stringify(existingPreferences), preferenceRows[0].id],
          );
        } else {
          await connection.execute(
            `
              INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
              VALUES (?, NULL, ?, NULL, 'user_preferences', ?, NOW())
            `,
            [randomUUID(), userId, JSON.stringify(existingPreferences)],
          );
        }

        await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [userId]);

        for (const code of backupCodes) {
          await connection.execute(
            'INSERT INTO backup_codes (id, user_id, code, used) VALUES (?, ?, ?, 0)',
            [randomUUID(), userId, code],
          );
        }
      });
    },
    async getTwoFactorSecret(userId) {
      return this.getPendingTwoFactorSecret(userId);
    },
    async getBackupCodes(userId) {
      const [rows] = await pool.execute(
        'SELECT code FROM backup_codes WHERE user_id = ? AND used = 0',
        [userId],
      );

      return rows.map((row) => row.code);
    },
    async consumeBackupCode(userId, code) {
      const [result] = await pool.execute(
        'DELETE FROM backup_codes WHERE user_id = ? AND code = ? LIMIT 1',
        [userId, code],
      );

      return result.affectedRows > 0;
    },
    async disableTwoFactor(userId) {
      await withTransaction(pool, async (connection) => {
        const [preferenceRows] = await connection.execute(
          `
            SELECT id, value
            FROM preferences
            WHERE user_id = ?
              AND tenant_id IS NULL
              AND project_id IS NULL
              AND \`key\` = 'user_preferences'
            LIMIT 1
          `,
          [userId],
        );
        const existingPreferences = preferenceRows[0]?.value ? JSON.parse(preferenceRows[0].value) : {};
        existingPreferences.twoFactorEnabled = false;

        await connection.execute(
          `
            DELETE FROM preferences
            WHERE user_id = ?
              AND tenant_id IS NULL
              AND project_id IS NULL
              AND \`key\` = 'two_factor_secret'
          `,
          [userId],
        );
        await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [userId]);

        if (preferenceRows[0]) {
          await connection.execute(
            'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
            [JSON.stringify(existingPreferences), preferenceRows[0].id],
          );
        } else {
          await connection.execute(
            `
              INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
              VALUES (?, NULL, ?, NULL, 'user_preferences', ?, NOW())
            `,
            [randomUUID(), userId, JSON.stringify(existingPreferences)],
          );
        }
      });
    },
  };
}

export { DEMO_PASSWORD };
