import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { HttpError } from '../src/lib/errors/http-error.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { ensureDevelopmentDemoUser } from '../src/modules/auth/auth.service.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemorySessionsRepository, REFRESH_GRACE_SECONDS } from '../src/modules/sessions/sessions.repository.js';
import { startPasswordSignup } from './helpers/password-signup.js';

const activeTestServers = new Set();

async function listenForTest(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  activeTestServers.add(server);
  return server;
}

test.afterEach(async () => {
  const servers = [...activeTestServers]; activeTestServers.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(resolve); server.closeAllConnections?.();
  })));
});

function createGoogleOAuthClientStub(overrides = {}) {
  return {
    getAuthorizationUrl({ state } = {}) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', 'test-client');
      if (state) {
        url.searchParams.set('state', state);
      }
      return url.toString();
    },
    async getUserInfoFromCode() {
      return {
        email: 'google.user@example.com',
        name: 'Google User',
        emailVerified: true,
      };
    },
    ...overrides,
  };
}

async function createTestApp(seed = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    ...seed,
  });
  const tokenService = createTokenService({
    issuer: 'odinpmp-test',
    secret: 'test-secret',
    ...seed.tokenServiceOptions,
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const mailRepository = createInMemoryMailRepository();
  const app = await listenForTest(createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:4173/app',
    googleOAuthClient: seed.googleOAuthClient ?? createGoogleOAuthClientStub(),
    mailRepository,
    sessionsRepository,
    signupCaptcha: seed.signupCaptcha ?? null,
    tokenService,
  }));

  return {
    app,
    authRepository,
    mailRepository,
    sessionsRepository,
    tokenService,
  };
}

test('Google registration requires a verified callback for the same email', async () => {
  const { app, authRepository } = await createTestApp({ googleOAuthClient: createGoogleOAuthClientStub({
    async getUserInfoFromCode() { return { email: 'new.google@example.com', name: 'New Google User', emailVerified: true }; },
  }) });
  const payload = {
    authMethod: 'google', createTenant: true, email: 'new.google@example.com',
    name: 'New Google User', role: 'admin', tenantName: 'Google Workspace',
  };
  const forged = await request(app).post('/api/auth/register').send(payload);
  assert.equal(forged.status, 401);
  assert.equal(authRepository.state.users.length, 0);

  const browser = request.agent(app);
  const callback = await browser.get('/api/auth/google/callback').query({ code: 'new-user' });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.location, /\/app\/register\?auth=google/);
  assert.ok(callback.headers['set-cookie'].some(cookie => cookie.startsWith('odin_google_registration=')));

  const wrongEmail = await browser.post('/api/auth/register').send({ ...payload, email: 'other@example.com' });
  assert.equal(wrongEmail.status, 403);
  assert.equal(authRepository.state.users.length, 0);

  const registered = await browser.post('/api/auth/register').send(payload);
  assert.equal(registered.status, 201);
  assert.equal(registered.body.session.user.email, payload.email);
  assert.equal(authRepository.state.users[0].authMethod, 'google');
  assert.ok(registered.headers['set-cookie'].some(cookie => cookie.startsWith('odin_google_registration=') && cookie.includes('Max-Age=0')));
});

test('Google registration rejects unverified email and claimed workspace role escalation', async () => {
  const unverified = await createTestApp({ googleOAuthClient: createGoogleOAuthClientStub({
    async getUserInfoFromCode() { return { email: 'unverified@example.com', name: 'Unverified', emailVerified: false }; },
  }) });
  const callback = await request(unverified.app).get('/api/auth/google/callback').query({ code: 'unverified' });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.location, /google_callback_failed/);
  assert.ok(!callback.headers['set-cookie']?.some(cookie => cookie.startsWith('odin_google_registration=')));

  const claimed = await createTestApp({ tenants: [
    { domains: [], id: 'tenant-decoy', name: 'Existing Workspace' },
    { domains: ['example.com'], id: 'tenant-example', name: 'Existing Workspace' },
  ],
    googleOAuthClient: createGoogleOAuthClientStub({ async getUserInfoFromCode() { return { email: 'new.google@example.com', name: 'New Google User', emailVerified: true }; } }),
  });
  const browser = request.agent(claimed.app);
  await browser.get('/api/auth/google/callback').query({ code: 'new-user' });
  const wrongWorkspace = await browser.post('/api/auth/register').send({
    authMethod: 'google', createTenant: false, email: 'new.google@example.com',
    name: 'New Google User', role: 'admin', tenantName: 'Another Workspace',
  });
  assert.equal(wrongWorkspace.status, 403);
  const joined = await browser.post('/api/auth/register').send({
    authMethod: 'google', createTenant: false, email: 'new.google@example.com',
    name: 'New Google User', role: 'admin', tenantName: 'Existing Workspace',
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.session.user.role, 'user');
  // Joins the workspace that owns the domain, not another workspace with the same name.
  assert.equal(joined.body.session.user.tenantId, 'tenant-example');
});

test('password registration cannot join an existing workspace or pick its own role', async () => {
  const { app, authRepository, mailRepository } = await createTestApp({
    tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme' }],
  });
  const join = (email) => request(app).post('/api/auth/register').send({
    authMethod: 'basic', createTenant: false, email,
    name: 'Mallory', password: 'P@ssw0rd123!', role: 'admin', tenantName: 'Acme',
  });

  const outsider = await join('mallory@elsewhere.com');
  assert.equal(outsider.status, 403);
  // An unverified address on the workspace's own domain is no better.
  const sameDomain = await join('mallory@acme.com');
  assert.equal(sameDomain.status, 403);

  const claimedDomain = await request(app).post('/api/auth/register').send({
    authMethod: 'basic', createTenant: true, email: 'mallory@acme.com',
    name: 'Mallory', password: 'P@ssw0rd123!', tenantName: 'Acme Two',
  });
  assert.equal(claimedDomain.status, 409);
  assert.equal(authRepository.state.users.length, 0);
  assert.equal(authRepository.state.tenants.length, 1);

  const token = await startPasswordSignup(app, mailRepository, {
    authMethod: 'basic', createTenant: true, email: 'ada@analyticalengines.com',
    name: 'Ada Lovelace', password: 'P@ssw0rd123!', role: 'user', tenantName: 'Analytical Engines',
  });
  const creator = await request(app).post('/api/auth/register/verify').set('X-Auth-Response', 'bearer').send({ token });
  assert.equal(creator.status, 201);
  assert.equal(creator.body.session.user.role, 'admin');
  assert.notEqual(creator.body.session.user.tenantId, 'tenant-acme');
});

test('ensureDevelopmentDemoUser seeds the local demo account into an empty repository', async () => {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
  });

  assert.equal(authRepository.state.users.length, 0);

  const result = await ensureDevelopmentDemoUser(authRepository);

  assert.equal(result.created, true);
  assert.equal(authRepository.state.users.length, 1);
  assert.equal(authRepository.state.users[0].email, 'demo@odinpmp.local');
  assert.equal(authRepository.state.tenants[0].name, 'OdinPMP Demo');
});

test('ensureDevelopmentDemoUser does not duplicate the demo account when it already exists', async () => {
  const authRepository = await createInMemoryAuthRepository();

  const beforeUsers = authRepository.state.users.length;
  const result = await ensureDevelopmentDemoUser(authRepository);

  assert.equal(result.created, false);
  assert.equal(authRepository.state.users.length, beforeUsers);
});

const ADA_SIGNUP = {
  authMethod: 'basic',
  createTenant: true,
  email: 'ada@analyticalengines.com',
  name: 'Ada Lovelace',
  password: 'P@ssw0rd123!',
  tenantName: 'Analytical Engines',
};

async function registerVerifiedAda(app, mailRepository) {
  const token = await startPasswordSignup(app, mailRepository, ADA_SIGNUP);
  return request(app).post('/api/auth/register/verify').set('X-Auth-Response', 'bearer').send({ token });
}

test('a password sign-up creates nothing until its emailed link is used, and the link works once', async () => {
  const { app, authRepository, mailRepository } = await createTestApp();

  const started = await request(app).post('/api/auth/register').send(ADA_SIGNUP);
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, { email: 'ada@analyticalengines.com', ok: true, verificationRequired: true });
  assert.equal(started.body.session, undefined);
  assert.equal(authRepository.state.users.length, 0);
  assert.equal(authRepository.state.tenants.length, 0);
  const [mail] = mailRepository.state.queue;
  assert.equal(mail.recipientEmail, 'ada@analyticalengines.com');
  assert.match(mail.body, /http:\/\/localhost:4173\/app\/verify-email#[A-Za-z0-9_-]{40,}/);
  // Only a hash of the token is stored.
  const token = mail.body.match(/verify-email#([A-Za-z0-9_-]+)/)[1];
  assert.ok(!JSON.stringify(authRepository.state.pendingRegistrations).includes(token));
  assert.ok(!JSON.stringify(authRepository.state.pendingRegistrations).includes(ADA_SIGNUP.password));

  const wrongToken = await request(app).post('/api/auth/register/verify').send({ token: `${token.slice(0, -4)}AAAA` });
  assert.equal(wrongToken.status, 410);

  const verified = await request(app).post('/api/auth/register/verify').set('X-Auth-Response', 'bearer').send({ token });
  assert.equal(verified.status, 201);
  assert.equal(verified.body.session.user.email, 'ada@analyticalengines.com');
  assert.equal(verified.body.session.user.role, 'admin');
  assert.equal(verified.body.session.user.tenantName, 'Analytical Engines');
  assert.equal(authRepository.state.users.length, 1);
  assert.equal(authRepository.state.tenants.length, 1);

  const reused = await request(app).post('/api/auth/register/verify').send({ token });
  assert.equal(reused.status, 410);

  const login = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({ email: ADA_SIGNUP.email, password: ADA_SIGNUP.password });
  assert.equal(login.status, 200);
});

test('signing up again replaces the earlier link, and expired links fail', async () => {
  const { app, authRepository, mailRepository } = await createTestApp();
  const first = await startPasswordSignup(app, mailRepository, ADA_SIGNUP);
  const second = await startPasswordSignup(app, mailRepository, { ...ADA_SIGNUP, tenantName: 'Engines Two' });
  assert.notEqual(first, second);
  assert.equal(authRepository.state.pendingRegistrations.length, 1);
  assert.equal((await request(app).post('/api/auth/register/verify').send({ token: first })).status, 410);

  authRepository.state.pendingRegistrations[0].expiresAt = new Date(Date.now() - 1000);
  assert.equal((await request(app).post('/api/auth/register/verify').send({ token: second })).status, 410);
  assert.equal(authRepository.state.users.length, 0);
});

test('the confirmation link fails if the email was registered in the meantime', async () => {
  const { app, authRepository, mailRepository } = await createTestApp();
  const token = await startPasswordSignup(app, mailRepository, ADA_SIGNUP);
  authRepository.state.users.push({ ...authRepository.state.users[0], authMethod: 'basic', email: ADA_SIGNUP.email, id: 'already-there', memberships: [], preferences: {} });
  const verified = await request(app).post('/api/auth/register/verify').send({ token });
  assert.equal(verified.status, 409);
  assert.equal(authRepository.state.tenants.length, 0);
});

test('every sign-up form rejects a filled honeypot before doing anything', async () => {
  const { app, authRepository, mailRepository } = await createTestApp();
  const trapped = await request(app).post('/api/auth/register').send({ ...ADA_SIGNUP, website: 'https://spam.example' });
  assert.equal(trapped.status, 400);
  assert.equal(mailRepository.state.queue.length, 0);
  assert.equal(authRepository.state.pendingRegistrations.length, 0);

  const invite = await request(app).post('/api/auth/invites/any-token/register').send({ name: 'Bot', password: 'P@ssw0rd123!', website: 'x' });
  assert.equal(invite.status, 400);
});

test('with reCAPTCHA configured, sign-ups need a token Google accepts', async () => {
  const checked = [];
  const signupCaptcha = {
    siteKey: 'site-key-for-tests',
    async verify({ token, remoteIp }) {
      checked.push({ remoteIp, token });
      if (token !== 'good-token') throw new HttpError(400, 'We couldn’t confirm this sign-up came from a person.');
    },
  };
  const { app, authRepository, mailRepository } = await createTestApp({ signupCaptcha });

  const config = await request(app).get('/api/auth/register/config');
  assert.deepEqual(config.body, { ok: true, recaptchaSiteKey: 'site-key-for-tests' });

  const missing = await request(app).post('/api/auth/register').send(ADA_SIGNUP);
  assert.equal(missing.status, 400);
  const bad = await request(app).post('/api/auth/register').send({ ...ADA_SIGNUP, recaptchaToken: 'bad-token' });
  assert.equal(bad.status, 400);
  assert.equal(authRepository.state.pendingRegistrations.length, 0);

  const good = await request(app).post('/api/auth/register').send({ ...ADA_SIGNUP, recaptchaToken: 'good-token' });
  assert.equal(good.status, 202);
  assert.equal(mailRepository.state.queue.length, 1);
  assert.deepEqual(checked.map((entry) => entry.token), ['', 'bad-token', 'good-token']);
  assert.ok(checked.every((entry) => typeof entry.remoteIp === 'string'));

  const invite = await request(app).post('/api/auth/invites/any-token/register').send({ name: 'Someone', password: 'P@ssw0rd123!' });
  assert.equal(invite.status, 400);
});

test('without reCAPTCHA keys the sign-up config reports no site key', async () => {
  const { app } = await createTestApp();
  const config = await request(app).get('/api/auth/register/config');
  assert.deepEqual(config.body, { ok: true, recaptchaSiteKey: null });
});

test('authenticated users can switch active tenants and preserve the selection through refresh', async () => {
  const tenantOne = '11111111-1111-4111-8111-111111111111';
  const tenantTwo = '22222222-2222-4222-8222-222222222222';
  const { app, tokenService } = await createTestApp({
    tenants: [
      { domains: ['one.example.com'], id: tenantOne, name: 'Tenant One' },
      { domains: ['two.example.com'], id: tenantTwo, name: 'Tenant Two' },
    ],
    users: [{
      authMethod: 'basic',
      email: 'multi@example.com',
      id: 'multi-user',
      memberships: [{ role: 'user', tenantId: tenantOne }, { role: 'manager', tenantId: tenantTwo }],
      name: 'Multi Tenant User',
      password: 'P@ssw0rd123!',
    }],
  });
  const login = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({ email: 'multi@example.com', password: 'P@ssw0rd123!' });
  assert.equal(login.status, 200);
  assert.equal(login.body.session.user.tenantId, tenantOne);
  assert.deepEqual(login.body.session.user.tenants.map((tenant) => tenant.id), [tenantOne, tenantTwo]);

  const switched = await request(app).post('/api/auth/switch-tenant').set('Authorization', `Bearer ${login.body.session.token}`).set('X-Auth-Response', 'bearer').send({ tenantId: tenantTwo });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.session.user.tenantId, tenantTwo);
  assert.equal(switched.body.session.user.role, 'manager');
  assert.equal(tokenService.verifySessionToken(switched.body.session.token).tenantId, tenantTwo);

  const current = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${switched.body.session.token}`);
  assert.equal(current.status, 200);
  assert.equal(current.body.user.tenantId, tenantTwo);
  const originalSession = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.session.token}`);
  assert.equal(originalSession.status, 200);
  assert.equal(originalSession.body.user.tenantId, tenantOne);
  const refreshed = await request(app).post('/api/auth/refresh').set('X-Auth-Response', 'bearer').send({ refreshToken: switched.body.session.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.session.user.tenantId, tenantTwo);
  assert.equal(tokenService.verifySessionToken(refreshed.body.session.token).tenantId, tenantTwo);

  const denied = await request(app).post('/api/auth/switch-tenant').set('Authorization', `Bearer ${refreshed.body.session.token}`).set('X-Auth-Response', 'bearer').send({ tenantId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(denied.status, 404);
});

test('browser auth uses hardened cookies, signed CSRF, rotation, and logout without exposing tokens', async () => {
  const { app, mailRepository } = await createTestApp();
  const browser = request.agent(app);
  const token = await startPasswordSignup(app, mailRepository, {
    authMethod: 'basic',
    createTenant: true,
    email: 'cookie.user@example.com',
    name: 'Cookie User',
    password: 'P@ssw0rd123!',
    tenantName: 'Cookie Tenant',
  });
  const registerResponse = await browser.post('/api/auth/register/verify').send({ token });

  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.session.token, undefined);
  assert.equal(registerResponse.body.session.refreshToken, undefined);
  const setCookies = registerResponse.headers['set-cookie'];
  const accessCookie = setCookies.find((cookie) => cookie.startsWith('odin_access='));
  const refreshCookie = setCookies.find((cookie) => cookie.startsWith('odin_refresh='));
  const csrfCookie = setCookies.find((cookie) => cookie.startsWith('odin_csrf='));
  assert.match(accessCookie, /; Path=\/api; SameSite=Lax; HttpOnly; Max-Age=\d+/);
  assert.match(refreshCookie, /; Path=\/api\/auth; SameSite=Lax; HttpOnly; Max-Age=\d+/);
  assert.match(csrfCookie, /; Path=\/; SameSite=Strict; Max-Age=\d+/);
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  const csrfToken = decodeURIComponent(csrfCookie.match(/^odin_csrf=([^;]+)/)[1]);

  const currentUser = await browser.get('/api/auth/me');
  assert.equal(currentUser.status, 200);
  assert.equal(currentUser.body.user.email, 'cookie.user@example.com');

  const initialCookieHeader = setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  const rejectedLogout = await request(app)
    .post('/api/auth/logout')
    .set('Cookie', initialCookieHeader);
  assert.equal(rejectedLogout.status, 403);

  const refreshResponse = await browser
    .post('/api/auth/refresh')
    .set('X-CSRF-Token', csrfToken);
  assert.equal(refreshResponse.status, 200);
  assert.equal(refreshResponse.body.session.token, undefined);
  assert.equal(refreshResponse.body.session.user.email, 'cookie.user@example.com');
  const rotatedCsrfCookie = refreshResponse.headers['set-cookie']
    .find((cookie) => cookie.startsWith('odin_csrf='));
  const rotatedCsrfToken = decodeURIComponent(rotatedCsrfCookie.match(/^odin_csrf=([^;]+)/)[1]);

  const logoutResponse = await browser
    .post('/api/auth/logout')
    .set('X-CSRF-Token', rotatedCsrfToken);
  assert.equal(logoutResponse.status, 200);
  assert.ok(logoutResponse.headers['set-cookie'].every((cookie) => /Max-Age=0/.test(cookie)));
  assert.equal((await browser.get('/api/auth/me')).status, 401);
});

test('production auth cookies opt into Secure without widening their domain', async () => {
  const previousSecure = process.env.AUTH_COOKIE_SECURE;
  process.env.AUTH_COOKIE_SECURE = 'true';
  try {
    const { app, mailRepository } = await createTestApp();
    const token = await startPasswordSignup(app, mailRepository, {
      authMethod: 'basic',
      createTenant: true,
      email: 'secure.cookie@example.com',
      name: 'Secure Cookie',
      password: 'P@ssw0rd123!',
      tenantName: 'Secure Cookie Tenant',
    });
    const response = await request(app).post('/api/auth/register/verify').send({ token });
    assert.equal(response.status, 201);
    assert.ok(response.headers['set-cookie'].every((cookie) => /; Secure(?:;|$)/.test(cookie)));
    assert.ok(response.headers['set-cookie'].every((cookie) => !/; Domain=/i.test(cookie)));
  } finally {
    if (previousSecure == null) {
      delete process.env.AUTH_COOKIE_SECURE;
    } else {
      process.env.AUTH_COOKIE_SECURE = previousSecure;
    }
  }
});

test('POST /api/auth/login returns 202 when 2FA is enabled', async () => {
  const secret = authenticator.generateSecret();
  const passwordHash = await bcrypt.hash('Secret123!', 10);
  const { app } = await createTestApp({
    tenants: [
      {
        domains: ['acme.com'],
        id: 'tenant-acme',
        name: 'Acme',
      },
    ],
    users: [
      {
        authMethod: 'basic',
        email: 'grace@acme.com',
        id: 'user-grace',
        memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
        name: 'Grace Hopper',
        passwordHash,
        preferences: { twoFactorEnabled: true },
        twoFactorSecret: secret,
      },
    ],
  });

  const response = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({
    email: 'grace@acme.com',
    password: 'Secret123!',
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.requiresTwoFactor, true);
  assert.ok(response.body.challengeToken);
});

test('POST /api/auth/two-factor/verify exchanges a challenge token for a session', async () => {
  const secret = authenticator.generateSecret();
  const passwordHash = await bcrypt.hash('Secret123!', 10);
  const { app } = await createTestApp({
    tenants: [
      {
        domains: ['acme.com'],
        id: 'tenant-acme',
        name: 'Acme',
      },
    ],
    users: [
      {
        authMethod: 'basic',
        email: 'grace@acme.com',
        id: 'user-grace',
        memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
        name: 'Grace Hopper',
        passwordHash,
        preferences: { twoFactorEnabled: true },
        twoFactorSecret: secret,
      },
    ],
  });

  const loginResponse = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({
    email: 'grace@acme.com',
    password: 'Secret123!',
  });

  const verifyResponse = await request(app).post('/api/auth/two-factor/verify').set('X-Auth-Response', 'bearer').send({
    challengeToken: loginResponse.body.challengeToken,
    code: authenticator.generate(secret),
  });

  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyResponse.body.ok, true);
  assert.ok(verifyResponse.body.session.token);
  assert.equal(verifyResponse.body.session.user.email, 'grace@acme.com');
});

test('GET /api/auth/me returns the current authenticated user', async () => {
  const { app, mailRepository } = await createTestApp();

  const registerResponse = await registerVerifiedAda(app, mailRepository);

  const response = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${registerResponse.body.session.token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.user.email, 'ada@analyticalengines.com');
});

test('POST /api/auth/refresh issues a new session after the access token expires', async () => {
  const { app, mailRepository } = await createTestApp({
    tokenServiceOptions: {
      refreshTokenTtlSeconds: 60 * 60 * 24,
      // Leave a full second of validity on the rotated token even when signing
      // happens immediately before a whole-second JWT timestamp boundary.
      sessionTokenTtlSeconds: 2,
    },
  });

  const registerResponse = await registerVerifiedAda(app, mailRepository);

  assert.equal(registerResponse.status, 201);
  assert.ok(registerResponse.body.session.token);
  assert.ok(registerResponse.body.session.refreshToken);

  await new Promise((resolve) => setTimeout(resolve, 2100));

  const expiredSessionResponse = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${registerResponse.body.session.token}`);

  assert.equal(expiredSessionResponse.status, 401);

  const refreshResponse = await request(app)
    .post('/api/auth/refresh')
    .send({
      refreshToken: registerResponse.body.session.refreshToken,
    });

  assert.equal(refreshResponse.status, 200);
  assert.equal(refreshResponse.body.ok, true);
  assert.equal(refreshResponse.body.session.user.email, 'ada@analyticalengines.com');
  assert.ok(refreshResponse.body.session.token);
  assert.ok(refreshResponse.body.session.refreshToken);
  assert.notEqual(refreshResponse.body.session.token, registerResponse.body.session.token);
  assert.notEqual(refreshResponse.body.session.refreshToken, registerResponse.body.session.refreshToken);

  const refreshedSessionResponse = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${refreshResponse.body.session.token}`);

  assert.equal(refreshedSessionResponse.status, 200);
  assert.equal(refreshedSessionResponse.body.user.email, 'ada@analyticalengines.com');
});

test('POST /api/auth/refresh: a refresh that lost a race gets the current session, and an older token does not', async () => {
  const { app, mailRepository, sessionsRepository } = await createTestApp();
  const registered = await registerVerifiedAda(app, mailRepository);
  const first = registered.body.session.refreshToken;
  const refresh = (refreshToken) => request(app).post('/api/auth/refresh').send({ refreshToken });
  // Refresh tokens are signed to the second; a rotation in the same second would repeat one.
  const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

  await nextSecond();
  const winner = await refresh(first);
  assert.equal(winner.status, 200);
  const second = winner.body.session.refreshToken;
  assert.notEqual(second, first);

  // The racer, still holding the first token, gets the same refresh token the winner got.
  const racer = await refresh(first);
  assert.equal(racer.status, 200);
  assert.equal(racer.body.session.refreshToken, second);
  assert.ok(racer.body.session.token);
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${racer.body.session.token}`)).status, 200);

  // Only the token just replaced is accepted: two rotations back is refused.
  await nextSecond();
  const next = await refresh(second);
  assert.equal(next.status, 200);
  assert.equal((await refresh(first)).status, 401);
  assert.equal((await refresh(second)).status, 200, 'the token just replaced still works');

  // And only for a short time after the rotation.
  const [session] = await sessionsRepository.listActiveSessions({ userId: registered.body.session.user.id });
  const later = new Date(Date.now() + (REFRESH_GRACE_SECONDS + 5) * 1000);
  assert.equal((await sessionsRepository.validateRefreshToken({ now: later, refreshToken: second, sessionId: session.id, userId: registered.body.session.user.id })).ok, false);
  assert.equal((await sessionsRepository.validateRefreshToken({ now: later, refreshToken: next.body.session.refreshToken, sessionId: session.id, userId: registered.body.session.user.id })).ok, true);
});

test('POST /api/auth/two-factor/init and /enable turn on 2FA and return backup codes', async () => {
  const { app, authRepository, mailRepository } = await createTestApp();

  const registerResponse = await registerVerifiedAda(app, mailRepository);

  const token = registerResponse.body.session.token;
  const initResponse = await request(app)
    .post('/api/auth/two-factor/init')
    .set('Authorization', `Bearer ${token}`)
    .send({});

  assert.equal(initResponse.status, 200);
  assert.equal(initResponse.body.ok, true);
  assert.match(initResponse.body.qrCodeData, /^data:image\/png;base64,/);

  const user = authRepository.state.users[0];
  const enableResponse = await request(app)
    .post('/api/auth/two-factor/enable')
    .set('Authorization', `Bearer ${token}`)
    .send({
      code: authenticator.generate(user.pendingTwoFactorSecret),
    });

  assert.equal(enableResponse.status, 200);
  assert.equal(enableResponse.body.ok, true);
  assert.equal(enableResponse.body.backupCodes.length, 8);
  assert.equal(authRepository.state.users[0].preferences.twoFactorEnabled, true);
});

test('GET /api/auth/google/start redirects back to login when Google OAuth is unavailable', async () => {
  const { app } = await createTestApp({
    googleOAuthClient: createGoogleOAuthClientStub({
      getAuthorizationUrl() {
        throw new Error('Google OAuth is not configured.');
      },
    }),
  });

  const response = await request(app)
    .get('/api/auth/google/start')
    .query({ redirect: '/projects/demo?tab=kanban#discussion' });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    'http://localhost:4173/app/login?error=google_unavailable&redirect=%2Fprojects%2Fdemo%3Ftab%3Dkanban%23discussion',
  );
});

test('GET /api/auth/google/callback preserves redirect state for Google users and 2FA handoff', async () => {
  const { app } = await createTestApp({
    tenants: [
      {
        domains: ['example.com'],
        id: 'tenant-example',
        name: 'Example',
      },
    ],
    users: [
      {
        authMethod: 'google',
        email: 'google.user@example.com',
        id: 'user-google',
        memberships: [{ role: 'admin', tenantId: 'tenant-example' }],
        name: 'Google User',
        preferences: { twoFactorEnabled: false },
      },
      {
        authMethod: 'google',
        email: 'secure.user@example.com',
        id: 'user-secure',
        memberships: [{ role: 'admin', tenantId: 'tenant-example' }],
        name: 'Secure User',
        preferences: { twoFactorEnabled: true },
      },
    ],
    googleOAuthClient: createGoogleOAuthClientStub({
      async getUserInfoFromCode(code) {
        if (code === 'two-factor') {
          return {
            email: 'secure.user@example.com',
            name: 'Secure User',
            emailVerified: true,
          };
        }

        return {
          email: 'google.user@example.com',
          name: 'Google User',
          emailVerified: true,
        };
      },
    }),
  });

  const response = await request(app)
    .get('/api/auth/google/callback')
    .query({
      code: 'token-user',
      state: '/projects/demo?tab=kanban#discussion',
    });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    'http://localhost:4173/app/oauth/callback?redirect=%2Fprojects%2Fdemo%3Ftab%3Dkanban%23discussion',
  );
  assert.ok(response.headers['set-cookie'].some((cookie) => cookie.startsWith('odin_access=')));
  assert.ok(response.headers['set-cookie'].some((cookie) => cookie.startsWith('odin_refresh=')));

  const twoFactorResponse = await request(app)
    .get('/api/auth/google/callback')
    .query({
      code: 'two-factor',
      state: '/projects/demo',
    });

  assert.equal(twoFactorResponse.status, 302);
  assert.equal(
    twoFactorResponse.headers.location,
    'http://localhost:4173/app/oauth/callback?requiresTwoFactor=1&redirect=%2Fprojects%2Fdemo',
  );
  assert.ok(twoFactorResponse.headers['set-cookie'].some((cookie) => cookie.startsWith('odin_two_factor=')));
});

test('GET /api/auth/google/callback signs existing basic accounts in when the Google email matches', async () => {
  const passwordHash = await bcrypt.hash('Secret123!', 10);
  const { app } = await createTestApp({
    tenants: [
      {
        domains: ['example.com'],
        id: 'tenant-example',
        name: 'Example',
      },
    ],
    users: [
      {
        authMethod: 'basic',
        email: 'google.user@example.com',
        id: 'user-basic',
        memberships: [{ role: 'admin', tenantId: 'tenant-example' }],
        name: 'Google User',
        passwordHash,
        preferences: { twoFactorEnabled: false },
      },
    ],
  });

  const response = await request(app)
    .get('/api/auth/google/callback')
    .query({
      code: 'token-user',
      state: '/projects/demo',
    });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    'http://localhost:4173/app/oauth/callback?redirect=%2Fprojects%2Fdemo',
  );
});

test('GET /api/auth/google/callback redirects to login instead of returning 500 when Google exchange fails', async () => {
  const { app } = await createTestApp({
    googleOAuthClient: createGoogleOAuthClientStub({
      async getUserInfoFromCode() {
        throw new Error('Google token exchange failed. {"error":"invalid_grant"}');
      },
    }),
  });

  const response = await request(app)
    .get('/api/auth/google/callback')
    .query({
      code: 'bad-code',
      state: '/projects/demo',
    });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    'http://localhost:4173/app/login?error=google_callback_failed&stage=oauth_exchange&redirect=%2Fprojects%2Fdemo',
  );
});

test('GET /api/auth/google/callback redirects to login when Google returns an error query', async () => {
  const { app } = await createTestApp();

  const response = await request(app)
    .get('/api/auth/google/callback')
    .query({
      error: 'access_denied',
      error_description: 'User denied the request',
      state: '/projects/demo',
    });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    'http://localhost:4173/app/login?error=google_callback_failed&redirect=%2Fprojects%2Fdemo',
  );
});
