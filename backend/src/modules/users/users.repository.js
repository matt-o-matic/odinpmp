import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/errors/http-error.js';
import { AVATAR_TOO_LARGE_MESSAGE, MAX_AVATAR_BYTES } from './avatar-limits.js';
import { mergeProfilePreferences } from './profile-preferences.js';

function safeJsonParse(value, fallback = {}) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function parseImageDataUrl(dataUrl) {
  const text = String(dataUrl ?? '').trim();
  if (!text) {
    return null;
  }

  const match = text.match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') {
    ext = 'jpg';
  }

  const bytes = Buffer.from(match[2], 'base64');
  return { bytes, ext };
}

function normalizeAvatarPath(userId, ext) {
  return `/images/users/${userId}.${ext}`;
}

async function upsertPreference({ pool, tenantId, userId, projectId, key, value }) {
  const executor = pool;
  const [rows] = await executor.execute(
    `
      SELECT id
      FROM preferences
      WHERE \`key\` = ?
        AND ${tenantId == null ? 'tenant_id IS NULL' : 'tenant_id = ?'}
        AND ${userId == null ? 'user_id IS NULL' : 'user_id = ?'}
        AND ${projectId == null ? 'project_id IS NULL' : 'project_id = ?'}
      LIMIT 1
    `,
    [
      key,
      ...(tenantId == null ? [] : [tenantId]),
      ...(userId == null ? [] : [userId]),
      ...(projectId == null ? [] : [projectId]),
    ],
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

export function createInMemoryUsersRepository({ authRepository } = {}) {
  if (!authRepository) {
    throw new Error('authRepository is required for the in-memory users repository.');
  }

  function findUser(userId) {
    return authRepository.state.users.find((u) => u.id === userId) ?? null;
  }

  return {
    avatarStorageRootDir: null,
    async getProfile({ userId }) {
      const user = findUser(userId);
      if (!user) {
        return null;
      }

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        authMethod: user.authMethod,
        picture: user.picture || '',
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? '',
        title: user.title ?? '',
        department: user.department ?? '',
        bio: user.bio ?? '',
        phone: user.phone ?? '',
        timezone: user.timezone ?? 'America/New_York',
        preferences: user.preferences ?? {},
      };
    },
    async updateEmail({ email, userId }) {
      const user = findUser(userId);
      if (user) user.email = String(email).toLowerCase();
      return Boolean(user);
    },
    async updateProfile(input) {
      const user = findUser(input.userId);
      if (!user) {
        return null;
      }

      user.name = input.profileDisplayName;
      user.email = input.email.toLowerCase();
      user.firstName = input.firstName;
      user.lastName = input.lastName;
      user.title = input.title ?? '';
      user.department = input.department ?? '';
      user.bio = input.aboutMe ?? '';
      user.phone = input.phone ?? '';
      user.timezone = input.timezone ?? 'America/New_York';
      user.preferences = mergeProfilePreferences(user.preferences, input.preferences);

      if (input.newPassword) {
        user.passwordHash = await bcrypt.hash(input.newPassword, 10);
      }

      if (input.base64Avatar) {
        // For in-memory mode, keep the data URL directly.
        user.picture = input.base64Avatar;
      }

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        authMethod: user.authMethod,
        picture: user.picture || '',
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? '',
        title: user.title ?? '',
        department: user.department ?? '',
        bio: user.bio ?? '',
        phone: user.phone ?? '',
        timezone: user.timezone ?? 'America/New_York',
        preferences: user.preferences ?? {},
      };
    },
    // Merges preference keys into the stored preferences, as a profile save does, without
    // touching the rest of the profile. Server-owned keys keep their stored values.
    async updatePreferences({ preferences, userId }) {
      const user = findUser(userId);
      if (!user) {
        return null;
      }

      user.preferences = mergeProfilePreferences(user.preferences, preferences);
      return { ...user.preferences };
    },
  };
}

export function createMysqlUsersRepository({ avatarStorage, pool }) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the users repository.');
  }

  if (!avatarStorage) {
    throw new Error('avatarStorage is required to create the users repository.');
  }

  return {
    avatarStorageRootDir: avatarStorage?.rootDir ?? null,
    async getProfile({ userId }) {
      const [rows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            u.authentication_method_id AS authenticationMethodId,
            u.first_name AS firstName,
            u.last_name AS lastName,
            u.job_title AS title,
            u.department,
            u.bio,
            u.phone,
            u.timezone,
            prefs_pref.value AS userPreferences,
            avatar_pref.value AS userAvatar
          FROM users u
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
          WHERE u.id = ?
          LIMIT 1
        `,
        [userId],
      );

      if (!rows[0]) {
        return null;
      }

      const preferences = safeJsonParse(rows[0].userPreferences, {});
      const picture = rows[0].userAvatar || '/images/avatar_default.jpg';

      return {
        id: rows[0].id,
        name: rows[0].name,
        email: rows[0].email,
        authMethod: Number(rows[0].authenticationMethodId) === 2 ? 'google' : 'basic',
        picture,
        firstName: rows[0].firstName ?? '',
        lastName: rows[0].lastName ?? '',
        title: rows[0].title ?? '',
        department: rows[0].department ?? '',
        bio: rows[0].bio ?? '',
        phone: rows[0].phone ?? '',
        timezone: rows[0].timezone ?? 'America/New_York',
        preferences,
      };
    },
    async updateEmail({ email, userId }) {
      const [result] = await pool.execute('UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?', [String(email).toLowerCase(), userId]);
      return result.affectedRows === 1;
    },
    async updateProfile(input) {
      const updates = [];
      const values = [];

      updates.push('first_name = ?'); values.push(input.firstName);
      updates.push('last_name = ?'); values.push(input.lastName);
      updates.push('name = ?'); values.push(input.profileDisplayName);
      updates.push('job_title = ?'); values.push(input.title ?? null);
      updates.push('department = ?'); values.push(input.department ?? null);
      updates.push('bio = ?'); values.push(input.aboutMe ?? null);
      updates.push('phone = ?'); values.push(input.phone ?? null);
      updates.push('timezone = ?'); values.push(input.timezone ?? null);
      updates.push('updated_at = NOW()');

      if (input.email) {
        updates.push('email = ?');
        values.push(input.email.toLowerCase());
      }

      await withTransaction(pool, async (connection) => {
        await connection.execute(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
          [...values, input.userId],
        );

        if (input.newPassword) {
          const hash = await bcrypt.hash(input.newPassword, 10);
          await connection.execute('UPDATE users SET password = ? WHERE id = ?', [hash, input.userId]);
        }

        // Merge with the row as stored now, so a two-factor change that committed after the
        // service read the profile still wins over the form.
        const [storedRows] = await connection.execute(
          `
            SELECT value
            FROM preferences
            WHERE user_id = ?
              AND tenant_id IS NULL
              AND project_id IS NULL
              AND \`key\` = 'user_preferences'
            LIMIT 1
            FOR UPDATE
          `,
          [input.userId],
        );
        const preferences = mergeProfilePreferences(safeJsonParse(storedRows[0]?.value, {}), input.preferences);
        const preferencesJson = JSON.stringify(preferences, null, 0);
        await upsertPreference({
          key: 'user_preferences',
          pool: connection,
          projectId: null,
          tenantId: null,
          userId: input.userId,
          value: preferencesJson,
        });

        const avatar = parseImageDataUrl(input.base64Avatar);
        if (avatar) {
          if (avatar.bytes.length > MAX_AVATAR_BYTES) {
            throw new HttpError(400, AVATAR_TOO_LARGE_MESSAGE);
          }

          const fileName = `${input.userId}.${avatar.ext}`;
          await avatarStorage.write(fileName, avatar.bytes);

          const avatarPath = normalizeAvatarPath(input.userId, avatar.ext);
          await upsertPreference({
            key: 'user_avatar',
            pool: connection,
            projectId: null,
            tenantId: null,
            userId: input.userId,
            value: avatarPath,
          });
        }

        return true;
      });

      return this.getProfile({ userId: input.userId });
    },
    // Merges preference keys into the stored row under a lock, as updateProfile does, so a
    // concurrent two-factor change or profile save is not lost.
    async updatePreferences({ preferences, userId }) {
      return withTransaction(pool, async (connection) => {
        const [userRows] = await connection.execute('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
        if (!userRows[0]) {
          return null;
        }

        const [storedRows] = await connection.execute(
          `
            SELECT value
            FROM preferences
            WHERE user_id = ?
              AND tenant_id IS NULL
              AND project_id IS NULL
              AND \`key\` = 'user_preferences'
            LIMIT 1
            FOR UPDATE
          `,
          [userId],
        );
        const merged = mergeProfilePreferences(safeJsonParse(storedRows[0]?.value, {}), preferences);
        await upsertPreference({
          key: 'user_preferences',
          pool: connection,
          projectId: null,
          tenantId: null,
          userId,
          value: JSON.stringify(merged, null, 0),
        });
        return merged;
      });
    },
  };
}
