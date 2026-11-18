import assert from 'node:assert/strict';
import test from 'node:test';

import { createMysqlUsersRepository } from '../src/modules/users/users.repository.js';

function createUsersPool() {
  const users = new Map([[
    'user-1',
    {
      authenticationMethodId: 1,
      bio: '',
      department: '',
      email: 'grace@acme.com',
      firstName: 'Grace',
      id: 'user-1',
      jobTitle: '',
      lastName: 'Hopper',
      name: 'Grace Hopper',
      phone: '',
      timezone: 'America/New_York',
    },
  ]]);
  const preferences = new Map();
  const statements = [];

  function preferenceKey({ key, projectId, tenantId, userId }) {
    return JSON.stringify({
      key,
      projectId: projectId ?? null,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
    });
  }

  function getUserProfileRow(userId) {
    const user = users.get(userId);
    if (!user) {
      return null;
    }

    return {
      authenticationMethodId: user.authenticationMethodId,
      bio: user.bio,
      department: user.department,
      email: user.email,
      firstName: user.firstName,
      id: user.id,
      lastName: user.lastName,
      name: user.name,
      phone: user.phone,
      timezone: user.timezone,
      title: user.jobTitle,
      userAvatar: preferences.get(preferenceKey({
        key: 'user_avatar',
        userId,
      }))?.value ?? '',
      userPreferences: preferences.get(preferenceKey({
        key: 'user_preferences',
        userId,
      }))?.value ?? '{}',
    };
  }

  function buildExecutor() {
    return {
      async execute(sql, params = []) {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.includes('SELECT value') && sql.includes('FROM preferences')) {
          const [userId] = params;
          const existing = preferences.get(preferenceKey({ key: 'user_preferences', userId }));
          return [existing ? [{ value: existing.value }] : []];
        }

        if (sql.includes('SELECT id') && sql.includes('FROM preferences')) {
          const [key] = params;
          const userId = params.at(-1);
          const existing = preferences.get(preferenceKey({
            key,
            userId,
          }));
          return [existing ? [{ id: existing.id }] : []];
        }

        if (sql.startsWith('UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?')) {
          const [value, id] = params;
          for (const entry of preferences.values()) {
            if (entry.id === id) {
              entry.value = value;
              break;
            }
          }
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('INSERT INTO preferences (id, tenant_id, user_id, project_id, `key`, `value`, updated_at)')) {
          const [id, tenantId, userId, projectId, key, value] = params;
          preferences.set(preferenceKey({
            key,
            projectId,
            tenantId,
            userId,
          }), { id, value });
          return [{ affectedRows: 1 }];
        }

        if (sql.startsWith('SELECT id FROM users WHERE id = ?')) {
          const [userId] = params;
          return [users.has(userId) ? [{ id: userId }] : []];
        }

        if (sql.startsWith('UPDATE users SET ')) {
          const userId = params.at(-1);
          const user = users.get(userId);
          if (!user) {
            return [{ affectedRows: 0 }];
          }

          [
            user.firstName,
            user.lastName,
            user.name,
            user.jobTitle,
            user.department,
            user.bio,
            user.phone,
            user.timezone,
          ] = params.slice(0, 8);

          if (params.length > 9) {
            user.email = params[8];
          }

          return [{ affectedRows: 1 }];
        }

        if (sql.includes('FROM users u') && sql.includes('LEFT JOIN preferences prefs_pref')) {
          const [userId] = params;
          const row = getUserProfileRow(userId);
          return [row ? [row] : []];
        }

        throw new Error(`Unexpected SQL in MySQL users repository test double: ${sql}`);
      },
    };
  }

  return {
    preferences,
    preferenceKey,
    statements,
    async execute(sql, params) {
      return buildExecutor().execute(sql, params);
    },
    async getConnection() {
      const executor = buildExecutor();
      return {
        ...executor,
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
}

function createAvatarStorage() {
  const writes = [];

  return {
    rootDir: '/avatars',
    writes,
    async write(fileName, bytes) {
      writes.push({ bytes, fileName });
    },
  };
}

function createProfileInput(base64Avatar) {
  return {
    aboutMe: '',
    base64Avatar,
    department: '',
    email: 'grace@acme.com',
    firstName: 'Grace',
    lastName: 'Hopper',
    newPassword: '',
    phone: '',
    preferences: { language: 'en' },
    profileDisplayName: 'Grace Hopper',
    timezone: 'America/New_York',
    title: '',
    userId: 'user-1',
  };
}

test('mysql users repository accepts profile avatars well above 100 KB and persists the avatar path', async () => {
  const pool = createUsersPool();
  const avatarStorage = createAvatarStorage();
  const repository = createMysqlUsersRepository({ avatarStorage, pool });
  const avatarBytes = Buffer.alloc(290_502, 7);
  const dataUrl = `data:image/jpeg;base64,${avatarBytes.toString('base64')}`;

  const profile = await repository.updateProfile(createProfileInput(dataUrl));

  assert.equal(avatarStorage.writes.length, 1);
  assert.equal(avatarStorage.writes[0].fileName, 'user-1.jpg');
  assert.equal(avatarStorage.writes[0].bytes.length, avatarBytes.length);
  assert.equal(profile.picture, '/images/users/user-1.jpg');
});

test('mysql users repository rejects avatars that exceed the supported upload size with a client error', async () => {
  const pool = createUsersPool();
  const avatarStorage = createAvatarStorage();
  const repository = createMysqlUsersRepository({ avatarStorage, pool });
  const avatarBytes = Buffer.alloc(600 * 1024, 7);
  const dataUrl = `data:image/jpeg;base64,${avatarBytes.toString('base64')}`;

  await assert.rejects(
    () => repository.updateProfile(createProfileInput(dataUrl)),
    (error) => {
      assert.equal(error?.statusCode, 400);
      assert.match(error?.message ?? '', /Avatar image is too large/i);
      return true;
    },
  );

  assert.equal(avatarStorage.writes.length, 0);
});

test('mysql profile updates keep the stored two-factor flag and keys the form left out', async () => {
  const pool = createUsersPool();
  const repository = createMysqlUsersRepository({ avatarStorage: createAvatarStorage(), pool });
  const key = pool.preferenceKey({ key: 'user_preferences', userId: 'user-1' });
  pool.preferences.set(key, { id: 'pref-1', value: JSON.stringify({ emailNotifMentions: false, notificationPrefsVersion: 1, twoFactorEnabled: true }) });

  const sentOff = await repository.updateProfile({ ...createProfileInput(''), preferences: { language: 'fr', twoFactorEnabled: false } });
  assert.equal(sentOff.preferences.twoFactorEnabled, true);
  assert.deepEqual(JSON.parse(pool.preferences.get(key).value), { emailNotifMentions: false, language: 'fr', notificationPrefsVersion: 1, twoFactorEnabled: true });
  assert.ok(pool.statements.some((sql) => /^SELECT value FROM preferences WHERE user_id = \? .* FOR UPDATE$/.test(sql)), 'the stored row is read under a lock');

  const omitted = await repository.updateProfile({ ...createProfileInput(''), preferences: { darkMode: true } });
  assert.equal(omitted.preferences.twoFactorEnabled, true);
  assert.equal(omitted.preferences.language, 'fr');
});

test('mysql preference saves merge one key under a lock and keep server-owned keys', async () => {
  const pool = createUsersPool();
  const repository = createMysqlUsersRepository({ avatarStorage: createAvatarStorage(), pool });
  const key = pool.preferenceKey({ key: 'user_preferences', userId: 'user-1' });
  pool.preferences.set(key, { id: 'pref-1', value: JSON.stringify({ darkMode: true, twoFactorEnabled: true }) });

  const saved = await repository.updatePreferences({ preferences: { homeLens: 'team', twoFactorEnabled: false }, userId: 'user-1' });
  assert.deepEqual(saved, { darkMode: true, homeLens: 'team', twoFactorEnabled: true });
  assert.deepEqual(JSON.parse(pool.preferences.get(key).value), { darkMode: true, homeLens: 'team', twoFactorEnabled: true });
  assert.ok(pool.statements.some((sql) => /^SELECT value FROM preferences WHERE user_id = \? .* FOR UPDATE$/.test(sql)), 'the stored row is read under a lock');

  // The first save for a user without a preferences row inserts one.
  pool.preferences.delete(key);
  assert.deepEqual(await repository.updatePreferences({ preferences: { homeLens: 'my-work' }, userId: 'user-1' }), { homeLens: 'my-work' });
  assert.deepEqual(JSON.parse(pool.preferences.get(key).value), { homeLens: 'my-work' });

  assert.equal(await repository.updatePreferences({ preferences: { homeLens: 'team' }, userId: 'user-missing' }), null);
});
