import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
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

async function createTestApp(seed = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    ...seed,
  });
  const tokenService = createTokenService({
    issuer: 'odinpmp-test',
    secret: 'test-secret',
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  const mailRepository = createInMemoryMailRepository();

  const app = createApp({
    authRepository,
    mailRepository,
    googleOAuthClient: createGoogleOAuthClientStub(),
    sessionsRepository,
    tenantsRepository,
    tokenService,
  });

  return { app, mailRepository };
}

test('tenant admin endpoints list existing users and manage invites', async () => {
  const { app, mailRepository } = await createTestApp();

  const signupToken = await startPasswordSignup(app, mailRepository, {
    authMethod: 'basic',
    createTenant: true,
    email: 'admin@acme.com',
    name: 'Acme Admin',
    password: 'P@ssw0rd123!',
    tenantName: 'Acme',
  });
  const register = await request(app).post('/api/auth/register/verify').set('X-Auth-Response', 'bearer').send({ token: signupToken });

  assert.equal(register.status, 201);
  const token = register.body.session.token;
  assert.ok(token);

  const existing = await request(app)
    .get('/api/tenants/existing-users')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(existing.status, 200);
  assert.equal(existing.body.ok, true);
  assert.equal(existing.body.users.length, 1);
  assert.equal(existing.body.users[0].email, 'admin@acme.com');

  const invite = await request(app)
    .post('/api/tenants/invites')
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'user@acme.com', role: 'user' });

  assert.equal(invite.status, 200);
  assert.equal(invite.body.ok, true);

  const invites = await request(app)
    .get('/api/tenants/invites')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(invites.status, 200);
  assert.equal(invites.body.ok, true);
  assert.equal(invites.body.invites.length, 1);
  assert.equal(invites.body.invites[0].email, 'user@acme.com');
});
