import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { processMailQueueBatch } from '../src/jobs/process-mail-queue.lib.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
async function setup() {
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true,
    tenants: [{ id: tenantId, name: 'Inviting workspace', domains: ['inviter.example'] }, { id: 'other-tenant', name: 'Existing workspace', domains: ['existing.example'] }],
    users: [
      { id: 'admin', email: 'admin@inviter.example', name: 'Admin', password: 'TestingPass123!', memberships: [{ tenantId, role: 'admin' }] },
      { id: 'existing', email: 'existing@outside.example', name: 'Existing User', password: 'TestingPass123!', memberships: [{ tenantId: 'other-tenant', role: 'user' }] },
    ],
  });
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  const mailRepository = createInMemoryMailRepository();
  const app = createApp({ authRepository, tenantsRepository, mailRepository, assistantStaleRunSweepIntervalMs: 0,
    frontendAppUrl: 'https://odin.example/app', tokenService: createTokenService({ issuer: 'test', secret: 'invitation-test-secret' }),
  });
  async function login(email) {
    const response = await request(app).post('/api/auth/login').set('X-Auth-Response', 'bearer').send({ email, password: 'TestingPass123!' });
    assert.equal(response.status, 200);
    return response.body.session.token;
  }
  const token = await login('admin@inviter.example');
  async function send(email = 'new@outside.example', role = 'manager') {
    const response = await request(app).post('/api/tenants/invites').auth(token, { type: 'bearer' }).send({ email, role });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return tenantsRepository.state.invites.at(-1).inviteToken;
  }
  return { app, authRepository, tenantsRepository, mailRepository, token, login, send };
}

test('invite email reaches the transport and its link registers the intended workspace and role', async () => {
  const { app, send, mailRepository, tenantsRepository, authRepository, token } = await setup();
  const inviteToken = await send('New@outside.example', 'admin');
  const outgoing = [];
  await processMailQueueBatch({ mailRepository, transport: { sendMail: async message => { outgoing.push(message); return { messageId: 'synthetic-message' }; } }, env: { mailFromAddress: 'noreply@odin.example' } });
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].to, 'new@outside.example');
  assert.ok(outgoing[0].html.includes(`https://odin.example/app/invites/${inviteToken}`));
  const listing = await request(app).get('/api/tenants/invites').auth(token, { type: 'bearer' });
  assert.equal(listing.body.invites[0].deliveryStatus, 'sent');
  const context = await request(app).get(`/api/auth/invites/${inviteToken}`);
  assert.equal(context.status, 200);
  assert.equal(context.headers['cache-control'], 'no-store');
  assert.equal(context.body.invitation.accountExists, false);
  assert.equal(context.body.invitation.workspaceName, 'Inviting workspace');
  const forged = await request(app).post(`/api/auth/invites/${inviteToken}/register`).send({ name: 'New User', password: 'TestingPass123!', role: 'user', tenantId: 'other-tenant' });
  assert.equal(forged.status, 400);
  const accepted = await request(app).post(`/api/auth/invites/${inviteToken}/register`).set('X-Auth-Response', 'bearer').send({ name: 'New User', password: 'TestingPass123!' });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.session.user.tenantId, tenantId);
  assert.equal(accepted.body.session.user.role, 'admin');
  assert.equal(accepted.body.session.user.email, 'new@outside.example');
  assert.equal(authRepository.state.tenants.length, 2);
  assert.equal(tenantsRepository.state.invites[0].accepted, true);
  const replay = await request(app).post(`/api/auth/invites/${inviteToken}/register`).send({ name: 'Again', password: 'AnotherPass123!' });
  assert.equal(replay.status, 410);
  assert.equal(authRepository.state.users.filter(user => user.email === 'new@outside.example').length, 1);
});

test('existing users authenticate and join without replacing accounts or existing roles', async () => {
  const { app, send, token, login, authRepository } = await setup();
  const inviteToken = await send('existing@outside.example', 'manager');
  const context = await request(app).get(`/api/auth/invites/${inviteToken}`);
  assert.equal(context.body.invitation.accountExists, true);
  const resetAttempt = await request(app).post(`/api/auth/invites/${inviteToken}/register`).send({ name: 'Reset attempt', password: 'AnotherPass123!' });
  assert.equal(resetAttempt.status, 409);
  assert.equal((await request(app).post(`/api/auth/invites/${inviteToken}/accept`).auth(token, { type: 'bearer' }).send({})).status, 403);
  const existingToken = await login('existing@outside.example');
  const joined = await request(app).post(`/api/auth/invites/${inviteToken}/accept`).auth(existingToken, { type: 'bearer' }).set('X-Auth-Response', 'bearer').send({});
  assert.equal(joined.status, 200);
  assert.equal(joined.body.session.user.id, 'existing');
  assert.equal(joined.body.session.user.tenantId, tenantId);
  assert.equal(joined.body.session.user.role, 'manager');
  assert.equal(authRepository.state.users.find(user => user.id === 'existing').memberships.length, 2);
  const otherInvite = await send('existing@outside.example', 'admin');
  const rejoined = await request(app).post(`/api/auth/invites/${otherInvite}/accept`).auth(existingToken, { type: 'bearer' }).set('X-Auth-Response', 'bearer').send({});
  assert.equal(rejoined.body.session.user.role, 'manager');
});

test('resend rotates the link; expired and revoked invites cannot create accounts', async () => {
  const { app, send, token, tenantsRepository, mailRepository } = await setup();
  const oldToken = await send();
  tenantsRepository.state.invites[0].invitedAt = '2020-01-01T00:00:00.000Z';
  assert.equal((await request(app).get(`/api/auth/invites/${oldToken}`)).status, 410);
  const resent = await request(app).post('/api/tenants/invites/resend').auth(token, { type: 'bearer' }).send({ invite_token: oldToken });
  assert.equal(resent.status, 200);
  const newToken = tenantsRepository.state.invites[0].inviteToken;
  assert.notEqual(oldToken, newToken);
  assert.equal(mailRepository.state.queue.length, 2);
  assert.equal((await request(app).get(`/api/auth/invites/${oldToken}`)).status, 410);
  assert.equal((await request(app).get(`/api/auth/invites/${newToken}`)).status, 200);
  await request(app).post('/api/tenants/invites/revoke').auth(token, { type: 'bearer' }).send({ invite_token: newToken });
  assert.equal((await request(app).post(`/api/auth/invites/${newToken}/register`).send({ name: 'New', password: 'TestingPass123!' })).status, 410);
});

test('queue failure is reported honestly and the saved invite can be resent', async () => {
  const { app, token, tenantsRepository, mailRepository } = await setup();
  const originalQueueMail = mailRepository.queueMail;
  mailRepository.queueMail = async () => { throw new Error('Mail store unavailable'); };
  const failed = await request(app).post('/api/tenants/invites').auth(token, { type: 'bearer' }).send({ email: 'new@outside.example', role: 'user' });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /could not be queued/);
  const listed = await request(app).get('/api/tenants/invites').auth(token, { type: 'bearer' });
  assert.equal(listed.body.invites[0].deliveryStatus, 'not_queued');
  mailRepository.queueMail = originalQueueMail;
  const resent = await request(app).post('/api/tenants/invites/resend').auth(token, { type: 'bearer' }).send({ invite_token: tenantsRepository.state.invites[0].inviteToken });
  assert.equal(resent.status, 200);
  assert.equal(mailRepository.state.queue.length, 1);
});

test('invites require admin authority, and cookie acceptance issues a usable browser session', async () => {
  const { app, login, send, authRepository } = await setup();
  const member = await login('existing@outside.example');
  assert.equal((await request(app).post('/api/tenants/invites').auth(member, { type: 'bearer' }).send({ email: 'x@outside.example', role: 'admin' })).status, 403);
  const inviteToken = await send();
  const client = request.agent(app);
  const accepted = await client.post(`/api/auth/invites/${inviteToken}/register`).send({ name: 'Invited User', password: 'TestingPass123!' });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.session.token, undefined);
  assert.ok(accepted.headers['set-cookie'].some(cookie => /HttpOnly/.test(cookie)));
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.tenantId, tenantId);
  assert.equal(authRepository.state.users.length, 3);
});
