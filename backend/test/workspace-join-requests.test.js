import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import {
  JOIN_REQUEST_ADMIN_TEMPLATE_ID,
  JOIN_REQUEST_APPROVED_TEMPLATE_ID,
  JOIN_REQUEST_CONFIRM_TEMPLATE_ID,
  JOIN_REQUEST_DECLINED_TEMPLATE_ID,
} from '../src/modules/mail/workspace-access.templates.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { ensureMysqlJoinRequestSchema } from '../src/modules/tenants/join-requests.repository.js';
import { createJoinRequestLimiters } from '../src/modules/tenants/join-requests.service.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';

const PASSWORD = 'Secret123!';
// Session switching takes UUIDs.
const ACME_ID = '11111111-1111-4111-8111-111111111111';
const RECEIVED = 'Request received. If a workspace has exactly that name, your request is listed below.';
const OPTED_OUT = { emailNotifTasks: false, notificationPrefsVersion: 1, twoFactorEnabled: false };

function seedUser(id, email, memberships) {
  return { authMethod: 'basic', email, id, memberships, name: id.replace(/^user-/, '').replace(/^\w/, (c) => c.toUpperCase()), password: PASSWORD };
}

async function createJoinApp({ limiters, now } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      { domains: ['acme.com'], id: ACME_ID, name: 'Acme' },
      { domains: [], id: 'tenant-beta', name: 'Beta Labs' },
      { domains: [], id: 'tenant-gamma', name: 'Gamma' },
      { domains: [], id: 'tenant-delta', name: 'Delta' },
      { domains: [], id: 'tenant-twin-a', name: 'Twins' },
      { domains: [], id: 'tenant-twin-b', name: 'Twins' },
      { domains: ['rita.example'], id: 'tenant-rita', name: 'Rita Co' },
    ],
    users: [
      seedUser('user-ada', 'ada@acme.com', [{ role: 'admin', tenantId: ACME_ID }]),
      seedUser('user-quiet', 'quiet@acme.com', [{ role: 'admin', tenantId: ACME_ID }]),
      seedUser('user-max', 'max@acme.com', [{ role: 'user', tenantId: ACME_ID }]),
      seedUser('user-bea', 'bea@beta.example', [{ role: 'admin', tenantId: 'tenant-beta' }]),
      seedUser('user-rita', 'rita@rita.example', [{ role: 'admin', tenantId: 'tenant-rita' }]),
    ],
  });
  // The in-memory repository keeps only the 2FA flag from seeds; a profile save stores the rest.
  for (const user of authRepository.state.users) user.preferences = { ...user.preferences, ...(user.id === 'user-quiet' ? OPTED_OUT : {}) };
  const mailRepository = createInMemoryMailRepository();
  const auditEvents = [];
  const clock = { now: now ?? new Date('2026-10-10T12:00:00.000Z') };
  const joinRequestLimiters = limiters ?? createJoinRequestLimiters({ now: () => clock.now.valueOf() });
  const app = createApp({
    auditWriter: { async append(event) { auditEvents.push(event); return event; } },
    authRepository,
    frontendAppUrl: 'https://odin.example/app',
    joinRequestLimiters,
    joinRequestsClock: () => clock.now,
    mailRepository,
    sessionsRepository: createInMemorySessionsRepository(),
    tenantsRepository: createInMemoryTenantsRepository({ authRepository }),
    tokenService: createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' }),
  });
  const tokens = new Map();
  async function auth(email) {
    if (!tokens.has(email)) {
      const login = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({ email, password: PASSWORD });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      tokens.set(email, `Bearer ${login.body.session.token}`);
    }
    return tokens.get(email);
  }
  const as = async (email) => {
    const authorization = await auth(email);
    return {
      get: (path) => request(app).get(path).set('Authorization', authorization),
      post: (path, body = {}) => request(app).post(path).set('Authorization', authorization).send(body),
    };
  };
  function mails(templateId) {
    return mailRepository.state.queue.filter((row) => row.templateId === templateId);
  }
  function lastConfirmToken(email) {
    const mail = mails(JOIN_REQUEST_CONFIRM_TEMPLATE_ID).findLast((row) => row.recipientEmail === email);
    return mail?.body.match(/workspace-access\/confirm#([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }
  return { app, as, auditEvents, authRepository, clock, lastConfirmToken, mailRepository, mails };
}

test('a join request grants nothing until an admin approves it, and approval adds the chosen role through the invitation path', async () => {
  const { app, as, auditEvents, authRepository, lastConfirmToken, mails } = await createJoinApp();
  const rita = await as('rita@rita.example');
  const ada = await as('ada@acme.com');
  const max = await as('max@acme.com');

  const created = await rita.post('/api/workspace-access/requests', { workspaceName: '  acme ' });
  assert.equal(created.status, 202);
  assert.deepEqual(created.body, { message: RECEIVED, ok: true });

  // Unconfirmed: admins see nothing, nobody is notified, and the requester has no access.
  assert.deepEqual((await ada.get('/api/tenants/user-requests')).body.requests, []);
  assert.equal(mails(JOIN_REQUEST_ADMIN_TEMPLATE_ID).length, 0);
  const own = await rita.get('/api/workspace-access/requests');
  assert.equal(own.body.requests.length, 1);
  assert.equal(own.body.requests[0].workspaceName, 'Acme');
  assert.equal(own.body.requests[0].status, 'pending');
  assert.equal(own.body.requests[0].emailConfirmed, false);
  assert.equal(own.body.requests[0].tenantId, null, 'a pending request does not identify the workspace');
  assert.equal((await rita.post('/api/auth/switch-tenant', { tenantId: ACME_ID })).status, 404);

  const token = lastConfirmToken('rita@rita.example');
  assert.ok(token, 'the confirmation email carries a fragment link');
  assert.doesNotMatch(mails(JOIN_REQUEST_CONFIRM_TEMPLATE_ID)[0].body, /\?token=/);
  const confirmed = await request(app).post('/api/workspace-access/confirm').send({ token });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.body, { ok: true, workspaceName: 'Acme' });
  assert.equal((await request(app).post('/api/workspace-access/confirm').send({ token })).status, 410, 'a link works once');

  // Admins who opted out of attention emails are skipped.
  assert.deepEqual(mails(JOIN_REQUEST_ADMIN_TEMPLATE_ID).map((row) => row.recipientEmail), ['ada@acme.com']);
  assert.match(mails(JOIN_REQUEST_ADMIN_TEMPLATE_ID)[0].subject, /Rita asked to join Acme/);

  const listed = await ada.get('/api/tenants/user-requests');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.requests.length, 1);
  const [pending] = listed.body.requests;
  assert.equal(pending.email, 'rita@rita.example');
  assert.equal(pending.verificationMethod, 'email_link');
  assert.ok(pending.emailVerifiedAt);

  // Only the workspace's admins decide, and only on their own workspace's requests.
  assert.equal((await max.get('/api/tenants/user-requests')).status, 403);
  assert.equal((await max.post(`/api/tenants/user-requests/${pending.id}/approve`, { role: 'admin' })).status, 403);
  assert.equal((await rita.post(`/api/tenants/user-requests/${pending.id}/approve`, { role: 'admin' })).status, 404);
  assert.equal((await ada.post(`/api/tenants/user-requests/${pending.id}/approve`, { role: 'owner' })).status, 400);
  assert.equal(authRepository.state.users.find((user) => user.id === 'user-rita').memberships.length, 1);

  const approved = await ada.post(`/api/tenants/user-requests/${pending.id}/approve`, { role: 'manager' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(authRepository.state.users.find((user) => user.id === 'user-rita').memberships, [
    { role: 'admin', tenantId: 'tenant-rita' },
    { role: 'manager', tenantId: ACME_ID },
  ]);
  assert.equal((await ada.post(`/api/tenants/user-requests/${pending.id}/approve`, { role: 'admin' })).status, 404, 'a decision happens once');
  assert.equal((await rita.post('/api/auth/switch-tenant', { tenantId: ACME_ID })).status, 200);

  const audit = auditEvents.find((event) => event.action === 'tenant.join_request.approved');
  assert.equal(audit.userId, 'user-ada');
  assert.equal(audit.tenantId, ACME_ID);
  assert.deepEqual({ requesterUserId: audit.detail.requesterUserId, role: audit.detail.role }, { requesterUserId: 'user-rita', role: 'manager' });
  assert.deepEqual(mails(JOIN_REQUEST_APPROVED_TEMPLATE_ID).map((row) => row.recipientEmail), ['rita@rita.example']);
  assert.match(mails(JOIN_REQUEST_APPROVED_TEMPLATE_ID)[0].body, /You joined as manager/);
  const after = await rita.get('/api/workspace-access/requests');
  assert.deepEqual([after.body.requests[0].status, after.body.requests[0].tenantId], ['approved', ACME_ID]);
});

test('requests to unknown, ambiguous or already-joined workspaces reveal nothing more than the availability check', async () => {
  const { as, authRepository, mailRepository } = await createJoinApp();
  const rita = await as('rita@rita.example');

  const unknown = await rita.post('/api/workspace-access/requests', { workspaceName: 'No Such Workspace' });
  const own = await rita.post('/api/workspace-access/requests', { workspaceName: 'Rita Co' });
  const real = await rita.post('/api/workspace-access/requests', { workspaceName: 'Beta Labs' });
  for (const response of [unknown, own, real]) assert.deepEqual([response.status, response.body], [202, { message: RECEIVED, ok: true }]);
  assert.deepEqual((await rita.get('/api/workspace-access/requests')).body.requests.map((row) => row.workspaceName), ['Beta Labs']);
  assert.equal(mailRepository.state.queue.length, 1);

  // Two workspaces share a name, so a request can't be routed safely.
  const twins = await rita.post('/api/workspace-access/requests', { workspaceName: 'twins' });
  assert.equal(twins.status, 409);
  assert.doesNotMatch(JSON.stringify(twins.body), /tenant-twin/);

  // Registration still cannot join a workspace (security finding 1).
  const join = await rita.post('/api/auth/register', { authMethod: 'basic', createTenant: false, email: 'mallory@acme.com', name: 'Mallory', password: PASSWORD, tenantName: 'Acme' });
  assert.notEqual(join.status, 201);
  assert.equal(authRepository.state.users.some((user) => user.email === 'mallory@acme.com'), false);
});

test('decline, cancel, cool-down and the per-requester limits', async () => {
  const { app, as, clock, lastConfirmToken, mails } = await createJoinApp();
  const rita = await as('rita@rita.example');
  const bea = await as('bea@beta.example');

  await rita.post('/api/workspace-access/requests', { workspaceName: 'Beta Labs' });
  await request(app).post('/api/workspace-access/confirm').send({ token: lastConfirmToken('rita@rita.example') });
  const [pending] = (await bea.get('/api/tenants/user-requests')).body.requests;
  const declined = await bea.post(`/api/tenants/user-requests/${pending.id}/decline`);
  assert.equal(declined.status, 200);
  assert.deepEqual((await bea.get('/api/tenants/user-requests')).body.requests, []);
  assert.deepEqual(mails(JOIN_REQUEST_DECLINED_TEMPLATE_ID).map((row) => row.recipientEmail), ['rita@rita.example']);
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'Beta Labs' })).status, 409, 'declined in the last 7 days');

  // One pending request per workspace, and the requester can cancel it.
  await rita.post('/api/workspace-access/requests', { workspaceName: 'Gamma' });
  await rita.post('/api/workspace-access/requests', { workspaceName: 'gamma' });
  const gamma = (await rita.get('/api/workspace-access/requests')).body.requests.filter((row) => row.workspaceName === 'Gamma');
  assert.equal(gamma.length, 1);
  assert.equal((await bea.post(`/api/workspace-access/requests/${gamma[0].id}/cancel`)).status, 404, 'only the requester cancels');
  assert.equal((await rita.post(`/api/workspace-access/requests/${gamma[0].id}/cancel`)).status, 200);
  assert.equal((await rita.post(`/api/workspace-access/requests/${gamma[0].id}/cancel`)).status, 404);

  // At most three waiting at once.
  for (const name of ['Gamma', 'Delta', 'Acme']) assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: name })).status, 202);
  const fourth = await rita.post('/api/workspace-access/requests', { workspaceName: 'No Such Workspace' });
  assert.equal(fourth.status, 409, 'the pending cap answers the same whether or not the name exists');

  // At most five new requests a day: this account has made five (Beta, Gamma twice, Delta, Acme).
  const waiting = (await rita.get('/api/workspace-access/requests')).body.requests.filter((row) => row.status === 'pending');
  await rita.post(`/api/workspace-access/requests/${waiting[0].id}/cancel`);
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'No Such Workspace' })).status, 429);
  clock.now = new Date(clock.now.valueOf() + 25 * 60 * 60 * 1000);
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'No Such Workspace' })).status, 202);
  clock.now = new Date(clock.now.valueOf() + 7 * 24 * 60 * 60 * 1000);
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'Beta Labs' })).status, 202, 'the cool-down ends');
});

test('attempts are rate limited per requester even for names that match nothing', async () => {
  const limiters = createJoinRequestLimiters();
  limiters.attempts = { calls: 0, take() { this.calls += 1; return this.calls <= 2; } };
  const { as } = await createJoinApp({ limiters });
  const rita = await as('rita@rita.example');
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'Nothing 1' })).status, 202);
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'Nothing 2' })).status, 202);
  assert.equal((await rita.post('/api/workspace-access/requests', { workspaceName: 'Nothing 3' })).status, 429);
});

test('confirmation links expire, a resend replaces them, an email change voids them, and a confirmed address is reused', async () => {
  const { app, as, authRepository, clock, lastConfirmToken, mails } = await createJoinApp();
  const rita = await as('rita@rita.example');
  const ada = await as('ada@acme.com');

  await rita.post('/api/workspace-access/requests', { workspaceName: 'Acme' });
  const first = lastConfirmToken('rita@rita.example');
  const [own] = (await rita.get('/api/workspace-access/requests')).body.requests;
  assert.equal((await rita.post(`/api/workspace-access/requests/${own.id}/resend-confirmation`)).status, 429, 'just sent');
  clock.now = new Date(clock.now.valueOf() + 25 * 60 * 60 * 1000);
  assert.equal((await request(app).post('/api/workspace-access/confirm').send({ token: first })).status, 410, 'expired');
  const resent = await rita.post(`/api/workspace-access/requests/${own.id}/resend-confirmation`);
  assert.equal(resent.status, 200);
  const second = lastConfirmToken('rita@rita.example');
  assert.notEqual(second, first);
  assert.equal(mails(JOIN_REQUEST_CONFIRM_TEMPLATE_ID).length, 2);

  // The link proves the address it was sent to, not whatever the account says now.
  const account = authRepository.state.users.find((user) => user.id === 'user-rita');
  account.email = 'someone-else@rita.example';
  assert.equal((await request(app).post('/api/workspace-access/confirm').send({ token: second })).status, 410);
  account.email = 'rita@rita.example';
  assert.equal((await request(app).post('/api/workspace-access/confirm').send({ token: second })).status, 200);

  // Approval checks the account still has the confirmed address.
  const [pending] = (await ada.get('/api/tenants/user-requests')).body.requests;
  account.email = 'someone-else@rita.example';
  assert.equal((await ada.post(`/api/tenants/user-requests/${pending.id}/approve`, {})).status, 409);
  account.email = 'rita@rita.example';
  assert.equal((await ada.post(`/api/tenants/user-requests/${pending.id}/approve`, {})).status, 200);
  assert.equal(account.memberships.find((membership) => membership.tenantId === ACME_ID).role, 'user', 'approval defaults to user');

  // This address is confirmed now, so the next request reaches its admins straight away.
  const bea = await as('bea@beta.example');
  await rita.post('/api/workspace-access/requests', { workspaceName: 'Beta Labs' });
  assert.equal(mails(JOIN_REQUEST_CONFIRM_TEMPLATE_ID).length, 2, 'no new confirmation email');
  const [beta] = (await bea.get('/api/tenants/user-requests')).body.requests;
  assert.equal(beta.verificationMethod, 'earlier_confirmation');
  assert.ok(mails(JOIN_REQUEST_ADMIN_TEMPLATE_ID).some((row) => row.recipientEmail === 'bea@beta.example'));
});

test('the tenant user-update endpoint no longer accepts request decisions by email', async () => {
  const { app } = await createJoinApp();
  const login = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({ email: 'ada@acme.com', password: PASSWORD });
  const put = await request(app).put('/api/tenants/users').set('Authorization', `Bearer ${login.body.session.token}`).send({ accepted_requests: [{ email: 'rita@rita.example' }] });
  assert.equal(put.status, 400);
});

function schemaExecutor({ columns = false, indexes = false, table = false } = {}) {
  const ddl = [];
  return {
    ddl,
    async execute(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('information_schema.TABLES')) return [[{ count: table ? 1 : 0 }]];
      if (normalized.includes('information_schema.COLUMNS')) return [[{ count: columns ? 1 : 0 }]];
      if (normalized.includes('information_schema.STATISTICS')) return [[{ count: indexes ? 1 : 0 }]];
      ddl.push(normalized);
      return [{ affectedRows: 0 }];
    },
  };
}

test('0072 adds the join-request columns to the legacy table, creates it where missing, and is a no-op once applied', async () => {
  const legacy = schemaExecutor({ table: true });
  await ensureMysqlJoinRequestSchema(legacy);
  assert.deepEqual(legacy.ddl.filter((statement) => statement.startsWith('ALTER')).map((statement) => statement.split(' ')[5]), [
    'user_id', 'status', 'email_verified_at', 'verification_method', 'verification_token_hash',
    'verification_expires_at', 'verification_sent_at', 'decided_at', 'decided_by', 'granted_role',
  ]);
  assert.ok(legacy.ddl.includes('CREATE UNIQUE INDEX uq_user_requests_verification_token ON user_requests (verification_token_hash)'));
  assert.ok(legacy.ddl.some((statement) => statement.includes("status VARCHAR(16) NOT NULL DEFAULT 'pending'")));
  assert.equal(legacy.ddl.some((statement) => /\btoken VARCHAR/.test(statement)), false, 'only a hash of the token is stored');

  const fresh = schemaExecutor();
  await ensureMysqlJoinRequestSchema(fresh);
  assert.match(fresh.ddl[0], /^CREATE TABLE user_requests \( ?id CHAR\(36\) NOT NULL PRIMARY KEY, tenant_id CHAR\(36\) NOT NULL/);
  assert.match(fresh.ddl[0], /verification_token_hash CHAR\(64\) NULL/);
  assert.equal(fresh.ddl.length, 4);

  const applied = schemaExecutor({ columns: true, indexes: true, table: true });
  await ensureMysqlJoinRequestSchema(applied);
  assert.deepEqual(applied.ddl, []);
});
