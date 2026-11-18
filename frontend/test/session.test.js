import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionStore } from '../src/lib/auth/session.js';

const MARKER = 'cookie-session';

function sessionUser(email = 'ada@example.com') {
  return { email, preferences: { twoFactorEnabled: false } };
}

test('login keeps only non-secret cookie session markers in frontend state', async () => {
  const storage = {
    getItem() { throw new Error('Web Storage must not be read for auth.'); },
    setItem() { throw new Error('Web Storage must not be written for auth.'); },
    removeItem() { throw new Error('Web Storage must not be written for auth.'); },
  };
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async login() {
        return { session: { user: sessionUser() } };
      },
    },
    storage,
  });

  await store.login({ email: 'ada@example.com', password: 'secret' });

  assert.equal(store.state.isAuthenticated, true);
  assert.equal(store.state.token, MARKER);
  assert.equal(store.state.refreshToken, MARKER);
  assert.equal(store.state.currentUser.email, 'ada@example.com');
});

test('restore derives the current session from HttpOnly cookies through /me', async () => {
  const calls = [];
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async getCurrentUser(token, options) {
        calls.push({ options, token });
        return { user: sessionUser('restored@example.com') };
      },
    },
  });

  await store.restore();

  assert.equal(store.state.ready, true);
  assert.equal(store.state.isAuthenticated, true);
  assert.equal(store.state.currentUser.email, 'restored@example.com');
  assert.equal(store.state.token, MARKER);
  assert.equal(calls[0].token, MARKER);
  assert.equal(calls[0].options.skipAuthRedirect, true);
});

test('restore rotates a cookie session when the access cookie expired', async () => {
  let refreshCalls = 0;
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async getCurrentUser() {
        const error = new Error('Authentication required.');
        error.status = 401;
        throw error;
      },
      async refreshSession(refreshToken) {
        refreshCalls += 1;
        assert.equal(refreshToken, MARKER);
        return { session: { user: sessionUser('rotated@example.com') } };
      },
    },
  });

  await store.restore();

  assert.equal(refreshCalls, 1);
  assert.equal(store.state.isAuthenticated, true);
  assert.equal(store.state.currentUser.email, 'rotated@example.com');
});

test('2FA uses an HttpOnly challenge cookie marker instead of retaining the challenge JWT', async () => {
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async login() {
        return { requiresTwoFactor: true };
      },
      async verifyTwoFactor(payload) {
        assert.deepEqual(payload, { code: '123456' });
        return { session: { user: sessionUser('mfa@example.com') } };
      },
    },
  });

  await store.login({ email: 'mfa@example.com', password: 'secret' });
  assert.equal(store.state.pendingTwoFactorChallenge, 'cookie-challenge');
  await store.verifyTwoFactor({ code: '123456' });
  assert.equal(store.state.isAuthenticated, true);
  assert.equal(store.state.pendingTwoFactorChallenge, '');
});

test('OAuth callback consumes cookie state and ignores token-shaped query values', async () => {
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async getCurrentUser(token) {
        assert.equal(token, MARKER);
        return { user: sessionUser('oauth@example.com') };
      },
    },
  });

  const result = await store.consumeOAuthCallback({
    redirect: '/projects/demo',
    refreshToken: 'must-not-be-consumed',
    token: 'must-not-be-consumed',
  });

  assert.deepEqual(result, { authenticated: true, redirect: '/projects/demo' });
  assert.equal(store.state.token, MARKER);
  assert.equal(store.state.refreshToken, MARKER);
});

test('OAuth 2FA callback retains no challenge token from the URL', async () => {
  const store = createSessionStore({
    apiClient: { baseUrl: 'http://localhost:3001' },
  });

  const result = await store.consumeOAuthCallback({
    challengeToken: 'must-not-be-consumed',
    redirect: '/projects/demo',
    requiresTwoFactor: '1',
  });

  assert.deepEqual(result, { redirect: '/projects/demo', requiresTwoFactor: true });
  assert.equal(store.state.pendingTwoFactorChallenge, 'cookie-challenge');
});

test('logout revokes the server session before clearing local markers', async () => {
  const calls = [];
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async login() { return { session: { user: sessionUser() } }; },
      async logout(token) { calls.push(token); return { ok: true }; },
    },
  });
  await store.login({});

  await store.logout();

  assert.deepEqual(calls, [MARKER]);
  assert.equal(store.state.isAuthenticated, false);
  assert.equal(store.state.token, '');
});

test('tenant switching replaces the active cookie-backed session user', async () => {
  const calls = [];
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async login() { return { session: { user: { ...sessionUser(), tenantId: 'tenant-1' } } }; },
      async switchTenant(tenantId, token) {
        calls.push({ tenantId, token });
        return { session: { user: { ...sessionUser(), tenantId, role: 'manager' } } };
      },
    },
  });
  await store.login({});
  const result = await store.switchTenant('tenant-2');
  assert.deepEqual(calls, [{ tenantId: 'tenant-2', token: MARKER }]);
  assert.equal(result.session.user.tenantId, 'tenant-2');
  assert.equal(store.state.currentUser.tenantId, 'tenant-2');
  assert.equal(store.state.currentUser.role, 'manager');
});

test('governed impersonation uses an in-memory bearer session and restores the actor cookie session on end', async () => {
  const calls = [];
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async endImpersonation(grantId, expectedVersion, token) {
        calls.push({ expectedVersion, grantId, token });
        return { ok: true };
      },
      async getCurrentUser(token) {
        assert.equal(token, MARKER);
        return { user: sessionUser('support-admin@example.com') };
      },
    },
  });

  store.beginImpersonation({
    expiresAt: '2030-01-01T00:15:00.000Z',
    grant: { id: 'grant-1', version: 3 },
    session: { token: 'short-lived-impersonation-token', user: sessionUser('target@example.com') },
  });
  assert.equal(store.state.currentUser.email, 'target@example.com');
  assert.equal(store.state.token, 'short-lived-impersonation-token');
  assert.equal(store.state.refreshToken, '');
  assert.equal(await store.keepAlive(), null);

  await store.endImpersonation();
  assert.deepEqual(calls, [{ expectedVersion: 3, grantId: 'grant-1', token: 'short-lived-impersonation-token' }]);
  assert.equal(store.state.currentUser.email, 'support-admin@example.com');
  assert.equal(store.state.impersonation, null);
  assert.equal(store.state.token, MARKER);
});

test('break-glass authentication keeps its challenge and bounded access token in memory only', async () => {
  const calls = [];
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async startBreakGlass(payload) { calls.push(payload); return { challengeToken: 'emergency-challenge', requiresTwoFactor: true }; },
      async verifyBreakGlass(payload) { calls.push(payload); return { breakGlass: { expiresAt: '2030-01-01T00:15:00.000Z', reason: 'Incident' }, session: { token: 'emergency-access-token', user: sessionUser('admin@example.com') } }; },
    },
  });

  await store.startBreakGlass({ email: 'admin@example.com', password: 'secret', reason: 'Identity provider outage.' });
  assert.equal(store.state.pendingBreakGlassChallenge, 'emergency-challenge');
  await store.verifyBreakGlass({ code: '123456' });
  assert.equal(store.state.currentUser.email, 'admin@example.com');
  assert.equal(store.state.token, 'emergency-access-token');
  assert.equal(store.state.refreshToken, '');
  assert.equal(store.state.pendingBreakGlassChallenge, '');
  assert.equal(await store.keepAlive(), null);
  assert.deepEqual(calls[1], { challengeToken: 'emergency-challenge', code: '123456' });
});

test('a refresh that fails while the access cookie still works keeps the person signed in', async () => {
  let meCalls = 0;
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async login() {
        return { session: { user: sessionUser() } };
      },
      async refreshSession() {
        const error = new Error('Session is no longer valid.');
        error.status = 401;
        throw error;
      },
      async getCurrentUser(token, options) {
        meCalls += 1;
        assert.equal(options.skipAuthRedirect, true);
        return { user: sessionUser('still@example.com') };
      },
    },
  });
  await store.login({ email: 'ada@example.com', password: 'secret' });

  assert.equal(await store.refreshSession(), MARKER);
  assert.equal(meCalls, 1);
  assert.equal(store.state.isAuthenticated, true);
  assert.equal(store.state.token, MARKER, 'the token never empties, so open screens keep their place');
  assert.equal(store.state.currentUser.email, 'still@example.com');
});

test('a refresh that fails when /me fails too ends the session', async () => {
  const unauthorized = () => Object.assign(new Error('Authentication required.'), { status: 401 });
  const store = createSessionStore({
    apiClient: {
      baseUrl: 'http://localhost:3001',
      async login() {
        return { session: { user: sessionUser() } };
      },
      async refreshSession() { throw unauthorized(); },
      async getCurrentUser() { throw unauthorized(); },
    },
  });
  await store.login({ email: 'ada@example.com', password: 'secret' });

  await assert.rejects(() => store.refreshSession(), { status: 401 });
  assert.equal(store.state.isAuthenticated, false);
  assert.equal(store.state.token, '');
});

test('coming back to the window refreshes only when the last refresh is old', async () => {
  const listeners = {};
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener: (type, handler) => { listeners[type] = handler; } };
  try {
    let clock = 1_000_000;
    let refreshCalls = 0;
    const store = createSessionStore({
      apiClient: {
        baseUrl: 'http://localhost:3001',
        async login() {
          return { session: { user: sessionUser() } };
        },
        async refreshSession() {
          refreshCalls += 1;
          return { session: { user: sessionUser() } };
        },
      },
      now: () => clock,
    });
    await store.login({ email: 'ada@example.com', password: 'secret' });

    listeners.focus();
    await Promise.resolve();
    assert.equal(refreshCalls, 0, 'just signed in: no refresh on every window switch');

    clock += 11 * 60 * 1000;
    listeners.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshCalls, 1);

    listeners.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshCalls, 1, 'the refresh just now counts');
  } finally {
    globalThis.window = previousWindow;
  }
});
