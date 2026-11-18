import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { mergeProfilePreferences } from '../src/modules/users/profile-preferences.js';
import { createInMemoryUsersRepository } from '../src/modules/users/users.repository.js';

async function createProfileApp(preferences) {
  const user = {
    authMethod: 'basic', email: 'grace@acme.com', id: 'user-grace', memberships: [{ role: 'user', tenantId: 'tenant-acme' }],
    name: 'Grace Hopper', password: 'Secret123!', preferences,
  };
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme' }], users: [user] });
  // Seeding keeps only the two-factor flag; store the whole preferences object as a save would.
  authRepository.state.users.find((candidate) => candidate.id === user.id).preferences = { ...preferences };
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'profile-two-factor-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({ authRepository, frontendAppUrl: 'http://localhost:5173/app', sessionsRepository, tokenService, usersRepository: createInMemoryUsersRepository({ authRepository }) });
  const stored = await authRepository.findUserById(user.id);
  const token = tokenService.signSessionToken({ email: stored.email, id: stored.id, name: stored.name, preferences: stored.preferences, role: 'user', scopes: ['Ttenant-acme-user'], tenantId: 'tenant-acme' });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: stored.id });
  return { app, authRepository, authorization: `Bearer ${token}` };
}

function profileBody(preferences) {
  return { email: 'grace@acme.com', firstName: 'Grace', lastName: 'Hopper', preferences, profileDisplayName: 'Grace Hopper', timezone: 'America/New_York' };
}

test('a profile save cannot switch two-factor sign-in off, whether it sends the flag or leaves it out', async () => {
  const { app, authRepository, authorization } = await createProfileApp({ emailNotifMentions: false, notificationPrefsVersion: 1, twoFactorEnabled: true });

  const sentOff = await request(app).put('/api/users/me').set('Authorization', authorization).send(profileBody({ darkMode: true, twoFactorEnabled: false }));
  assert.equal(sentOff.status, 200, JSON.stringify(sentOff.body));
  assert.equal(sentOff.body.user.preferences.twoFactorEnabled, true);
  assert.equal((await authRepository.findUserById('user-grace')).preferences.twoFactorEnabled, true);

  // A form loaded before later changes leaves keys out; they keep their stored values.
  const omitted = await request(app).put('/api/users/me').set('Authorization', authorization).send(profileBody({ language: 'fr' }));
  assert.equal(omitted.status, 200);
  assert.deepEqual(omitted.body.user.preferences, { darkMode: true, emailNotifMentions: false, language: 'fr', notificationPrefsVersion: 1, twoFactorEnabled: true });

  const profile = await request(app).get('/api/users/me').set('Authorization', authorization);
  assert.equal(profile.body.user.preferences.twoFactorEnabled, true);
});

test('a profile save cannot switch two-factor sign-in on without a code either', async () => {
  const { app, authRepository, authorization } = await createProfileApp({ twoFactorEnabled: false });
  const response = await request(app).put('/api/users/me').set('Authorization', authorization).send(profileBody({ twoFactorEnabled: true }));
  assert.equal(response.status, 200);
  assert.equal(response.body.user.preferences.twoFactorEnabled, false);
  assert.equal((await authRepository.findUserById('user-grace')).preferences.twoFactorEnabled, false);
});

test('server-owned preference keys keep their stored value or stay absent', () => {
  assert.deepEqual(mergeProfilePreferences({ twoFactorEnabled: true, darkMode: false }, { darkMode: true, twoFactorEnabled: false }), { darkMode: true, twoFactorEnabled: true });
  assert.deepEqual(mergeProfilePreferences({}, { twoFactorEnabled: true }), {});
  assert.deepEqual(mergeProfilePreferences(null, undefined), {});
});
