import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { startPasswordSignup } from './helpers/password-signup.js';

function createGoogleOAuthClientStub() {
  return {
    getAuthorizationUrl() {
      return 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client';
    },
    async getUserInfoFromCode() {
      return {
        email: 'google.user@example.com',
        name: 'Google User',
      };
    },
  };
}

function parseStructuredEntry(value) {
  try {
    return JSON.parse(String(value));
  } catch (_error) {
    return null;
  }
}

async function captureStructuredLogs(run) {
  const stdoutEntries = [];
  const stderrEntries = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (entry) => {
    const parsed = parseStructuredEntry(entry);
    if (parsed) {
      stdoutEntries.push(parsed);
    }
  };
  console.error = (entry) => {
    const parsed = parseStructuredEntry(entry);
    if (parsed) {
      stderrEntries.push(parsed);
    }
  };

  try {
    await run({ stderrEntries, stdoutEntries });
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return {
    stderrEntries,
    stdoutEntries,
  };
}

function findLogEntry(entries, message) {
  return entries.find((entry) => entry?.message === message) ?? null;
}

async function createAuthenticatedApp({
  deps = {},
  user = {},
} = {}) {
  const mergedUser = {
    authMethod: 'basic',
    email: 'grace@acme.com',
    id: 'user-grace',
    memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
    name: 'Grace Hopper',
    password: 'Secret123!',
    preferences: { twoFactorEnabled: false },
    ...user,
  };
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      {
        domains: ['acme.com'],
        id: 'tenant-acme',
        name: 'Acme',
      },
    ],
    users: [mergedUser],
  });
  const tokenService = createTokenService({
    issuer: 'odinpmp-test',
    secret: 'test-secret',
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    googleOAuthClient: createGoogleOAuthClientStub(),
    sessionsRepository,
    tokenService,
    ...deps,
  });

  const storedUser = await authRepository.findUserById(mergedUser.id);
  const membership = storedUser.memberships?.[0] ?? {};
  const token = tokenService.signSessionToken({
    email: storedUser.email,
    id: storedUser.id,
    name: storedUser.name,
    preferences: storedUser.preferences,
    role: membership.role ?? 'user',
    scopes: membership.tenantId ? [`T${membership.tenantId}-${membership.role ?? 'user'}`] : [],
    tenantId: membership.tenantId ?? null,
  });
  const expiry = tokenService.verifySessionToken(token);

  await sessionsRepository.createSession({
    expiryDate: new Date(expiry.exp * 1000),
    ipAddr: '127.0.0.1',
    locationName: 'Localhost',
    token,
    userAgent: 'test-agent',
    userId: storedUser.id,
  });

  return {
    app,
    authRepository,
    sessionsRepository,
    token,
    tokenService,
  };
}

test('POST /api/auth/register/verify logs state-changing auth failures to stderr with operation context', async () => {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
  });
  authRepository.createRegistration = async () => {
    throw new Error('registration persistence exploded');
  };
  const tokenService = createTokenService({
    issuer: 'odinpmp-test',
    secret: 'test-secret',
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const mailRepository = createInMemoryMailRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    googleOAuthClient: createGoogleOAuthClientStub(),
    mailRepository,
    sessionsRepository,
    tokenService,
  });
  const token = await startPasswordSignup(app, mailRepository, {
    authMethod: 'basic',
    createTenant: true,
    email: 'admin@acme.com',
    name: 'Acme Admin',
    password: 'P@ssw0rd123!',
    tenantName: 'Acme',
  });

  const { stderrEntries } = await captureStructuredLogs(async () => {
    const response = await request(app).post('/api/auth/register/verify').send({ token });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
  });

  const entry = findLogEntry(stderrEntries, 'Auth operation failed.');
  assert.ok(entry);
  assert.equal(entry.context.operation, 'auth.registerAccount');
  assert.equal(entry.context.authMethod, 'basic');
  assert.equal(entry.context.createTenant, true);
  assert.equal(entry.context.emailDomain, 'acme.com');
  assert.equal(entry.error.message, 'registration persistence exploded');
});

test('PUT /api/users/me logs avatar update failures with request correlation and avatar context', async () => {
  const avatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const dataUrl = `data:image/png;base64,${avatarBytes.toString('base64')}`;
  const usersRepository = {
    avatarStorageRootDir: '/srv/odinpmp/avatars',
    async getProfile() {
      return { preferences: {} };
    },
    async updateProfile() {
      throw new Error('avatar storage exploded');
    },
  };
  const { app, token } = await createAuthenticatedApp({
    deps: {
      usersRepository,
    },
  });

  const { stderrEntries } = await captureStructuredLogs(async () => {
    const response = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        aboutMe: '',
        base64Avatar: dataUrl,
        confirmNewPassword: '',
        currentPassword: '',
        department: '',
        email: 'grace@acme.com',
        firstName: 'Grace',
        lastName: 'Hopper',
        newPassword: '',
        phone: '',
        preferences: {},
        profileDisplayName: 'Grace Hopper',
        timezone: 'America/New_York',
        title: '',
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
  });

  const entry = findLogEntry(stderrEntries, 'Users repository operation failed.');
  assert.ok(entry);
  assert.equal(entry.context.operation, 'users.updateProfile');
  assert.equal(entry.context.requestId?.length > 0, true);
  assert.equal(entry.context.method, 'PUT');
  assert.equal(entry.context.route, '/api/users/me');
  assert.equal(entry.context.userId, 'user-grace');
  assert.equal(entry.context.tenantId, 'tenant-acme');
  assert.equal(entry.context.avatarProvided, true);
  assert.equal(entry.context.avatarExt, 'png');
  assert.equal(entry.context.avatarBytes, avatarBytes.length);
  assert.equal(entry.context.avatarStorageRootDir, '/srv/odinpmp/avatars');
  assert.equal(entry.context.avatarWriteTarget, 'user-grace.png');
  assert.equal(entry.error.message, 'avatar storage exploded');
});

test('POST /api/projects logs state-changing project failures to stderr with operation context', async () => {
  const { app, token } = await createAuthenticatedApp({
    deps: {
      projectRepository: {
        async createProject() {
          throw new Error('project create exploded');
        },
      },
    },
  });

  const { stderrEntries } = await captureStructuredLogs(async () => {
    const response = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Replace the legacy admin dashboard.',
        endDate: '2026-09-15',
        name: 'Admin Rebuild',
        startDate: '2026-06-01',
        status: 'Planned',
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
  });

  const entry = findLogEntry(stderrEntries, 'Projects repository operation failed.');
  assert.ok(entry);
  assert.equal(entry.context.operation, 'projects.createProject');
  assert.equal(entry.context.projectName, 'Admin Rebuild');
  assert.equal(entry.context.tenantId, 'tenant-acme');
  assert.equal(entry.context.userId, 'user-grace');
  assert.equal(entry.error.message, 'project create exploded');
});

test('POST /api/ranking/vote logs vote persistence failures to stderr with operation context', async () => {
  const { app, token } = await createAuthenticatedApp({
    deps: {
      rankingRepository: {
        async submitVote() {
          throw new Error('ranking vote exploded');
        },
      },
    },
  });

  const { stderrEntries } = await captureStructuredLogs(async () => {
    const response = await request(app)
      .post('/api/ranking/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        loserId: 'project-b',
        winnerId: 'project-a',
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
  });

  const entry = findLogEntry(stderrEntries, 'Ranking repository operation failed.');
  assert.ok(entry);
  assert.equal(entry.context.operation, 'ranking.submitVote');
  assert.equal(entry.context.winnerId, 'project-a');
  assert.equal(entry.context.loserId, 'project-b');
  assert.equal(entry.context.tenantId, 'tenant-acme');
  assert.equal(entry.context.userId, 'user-grace');
  assert.equal(entry.error.message, 'ranking vote exploded');
});

test('PUT /api/tenants/settings logs tenant write failures to stderr with operation context', async () => {
  const { app, token } = await createAuthenticatedApp({
    deps: {
      tenantsRepository: {
        async updateTenant() {
          throw new Error('tenant update exploded');
        },
      },
    },
  });

  const { stderrEntries } = await captureStructuredLogs(async () => {
    const response = await request(app)
      .put('/api/tenants/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        domains: ['acme.com'],
        tenant_name: 'Acme Updated',
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
  });

  const entry = findLogEntry(stderrEntries, 'Tenant operation failed.');
  assert.ok(entry);
  assert.equal(entry.context.operation, 'tenants.updateTenant');
  assert.equal(entry.context.tenantName, 'Acme Updated');
  assert.equal(entry.context.domainCount, 1);
  assert.equal(entry.context.tenantId, 'tenant-acme');
  assert.equal(entry.context.userId, 'user-grace');
  assert.equal(entry.error.message, 'tenant update exploded');
});

test('POST /api/public/waitlist logs signup persistence failures to stderr with operation context', async () => {
  const app = createApp({
    waitlistRepository: {
      async create() {
        throw new Error('waitlist create exploded');
      },
      async findByEmail() {
        return null;
      },
    },
  });

  const { stderrEntries } = await captureStructuredLogs(async () => {
    const response = await request(app).post('/api/public/waitlist').send({
      betaInterest: true,
      comments: 'Interested in beta access.',
      company: 'Analytical Engines',
      companySize: '11-50',
      email: 'ada@example.com',
      industry: 'Technology',
      name: 'Ada Lovelace',
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
  });

  const entry = findLogEntry(stderrEntries, 'Waitlist operation failed.');
  assert.ok(entry);
  assert.equal(entry.context.operation, 'waitlist.createSignup');
  assert.equal(entry.context.emailDomain, 'example.com');
  assert.equal(entry.context.companyProvided, true);
  assert.equal(entry.context.betaInterest, true);
  assert.equal(entry.error.message, 'waitlist create exploded');
});
