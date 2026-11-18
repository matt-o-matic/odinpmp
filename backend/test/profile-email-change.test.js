import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { EMAIL_CHANGE_CONFIRM_TEMPLATE_ID, EMAIL_CHANGE_NOTICE_TEMPLATE_ID } from '../src/modules/mail/account-email.templates.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryEmailChangeRepository, EMAIL_CHANGE_LIFETIME_MS } from '../src/modules/users/email-change.js';
import { createInMemoryUsersRepository } from '../src/modules/users/users.repository.js';

// Changing an account's email: the profile form only asks; the account
// keeps its address until the link sent to the new one is opened, and the old one is told.

async function createEmailApp() {
  const users = [
    { authMethod: 'basic', email: 'grace@acme.com', id: 'user-grace', memberships: [{ role: 'user', tenantId: 'tenant-acme' }], name: 'Grace Hopper', password: 'Secret123!' },
    { authMethod: 'basic', email: 'ada@acme.com', id: 'user-ada', memberships: [{ role: 'user', tenantId: 'tenant-acme' }], name: 'Ada Lovelace', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme' }], users });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'profile-email-change-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const mailRepository = createInMemoryMailRepository();
  const emailChangeRepository = createInMemoryEmailChangeRepository();
  const app = createApp({
    authRepository, emailChangeRepository, frontendAppUrl: 'http://localhost:5173/app', mailRepository, sessionsRepository, tokenService,
    usersRepository: createInMemoryUsersRepository({ authRepository }),
  });
  const stored = await authRepository.findUserById('user-grace');
  const token = tokenService.signSessionToken({ email: stored.email, id: stored.id, name: stored.name, role: 'user', scopes: ['Ttenant-acme-user'], tenantId: 'tenant-acme' });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: stored.id });
  const authorization = `Bearer ${token}`;
  const save = (email) => request(app).put('/api/users/me').set('Authorization', authorization)
    .send({ email, firstName: 'Grace', lastName: 'Hopper', profileDisplayName: 'Grace Hopper', timezone: 'America/New_York' });
  const mails = (templateId) => mailRepository.state.queue.filter((row) => row.templateId === templateId);
  const lastLink = () => mails(EMAIL_CHANGE_CONFIRM_TEMPLATE_ID).at(-1)?.body.match(/account\/confirm-email#([A-Za-z0-9_-]+)/)?.[1] ?? null;
  const confirm = (linkToken) => request(app).post('/api/account/email-change/confirm').send({ token: linkToken });
  return { app, authorization, authRepository, confirm, emailChangeRepository, lastLink, mails, save };
}

test('a new email is only asked for: the account keeps its address until the emailed link is opened', async () => {
  const { app, authorization, authRepository, confirm, lastLink, mails, save } = await createEmailApp();

  const saved = await save('grace@navy.mil');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.user.email, 'grace@acme.com');
  assert.equal(saved.body.pendingEmail, 'grace@navy.mil');
  assert.equal((await authRepository.findUserById('user-grace')).email, 'grace@acme.com');
  assert.equal(await authRepository.findUserByEmail('grace@navy.mil'), null, 'Google sign-in with the new address finds nobody yet');

  // A link to the new address; a notice to the old one, with no link in it.
  const [confirmMail] = mails(EMAIL_CHANGE_CONFIRM_TEMPLATE_ID);
  assert.equal(confirmMail.recipientEmail, 'grace@navy.mil');
  const [notice] = mails(EMAIL_CHANGE_NOTICE_TEMPLATE_ID);
  assert.equal(notice.recipientEmail, 'grace@acme.com');
  assert.match(notice.body, /grace@navy\.mil/);
  assert.doesNotMatch(notice.body, /confirm-email/);

  const profile = await request(app).get('/api/users/me').set('Authorization', authorization);
  assert.equal(profile.body.pendingEmail, 'grace@navy.mil');

  const token = lastLink();
  const confirmed = await confirm(token);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.email, 'grace@navy.mil');
  assert.equal((await authRepository.findUserById('user-grace')).email, 'grace@navy.mil');
  assert.equal((await confirm(token)).status, 410, 'the link works once');
  assert.equal((await request(app).get('/api/users/me').set('Authorization', authorization)).body.pendingEmail, null);
});

test('a second request replaces the first, and an address another account uses is refused', async () => {
  const { authRepository, confirm, lastLink, mails, save } = await createEmailApp();
  await save('grace@one.example');
  const first = lastLink();
  await save('grace@two.example');
  assert.equal((await confirm(first)).status, 410, 'the earlier link is void');
  assert.equal((await confirm(lastLink())).status, 200);
  assert.equal((await authRepository.findUserById('user-grace')).email, 'grace@two.example');

  const taken = await save('ada@acme.com');
  assert.equal(taken.status, 409);
  assert.equal(taken.body.details?.code ?? taken.body.code, 'email_in_use');
  assert.equal(mails(EMAIL_CHANGE_CONFIRM_TEMPLATE_ID).filter((row) => row.recipientEmail === 'ada@acme.com').length, 0);
  // Saving the address it already has asks for nothing.
  const same = await save('GRACE@two.example');
  assert.equal(same.status, 200);
  assert.equal(same.body.pendingEmail, null);
});

test('a link is void once it expires, or once the account moved to another address', async () => {
  const { authRepository, confirm, emailChangeRepository, lastLink, save } = await createEmailApp();
  await save('grace@later.example');
  const token = lastLink();
  emailChangeRepository.rows.at(-1).expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal((await confirm(token)).status, 410);
  assert.ok(EMAIL_CHANGE_LIFETIME_MS === 24 * 60 * 60 * 1000);

  await save('grace@moved.example');
  const moved = lastLink();
  authRepository.state.users.find((user) => user.id === 'user-grace').email = 'grace@admin-changed.example';
  assert.equal((await confirm(moved)).status, 410);
  assert.equal((await confirm('x'.repeat(43))).status, 410);
  assert.equal((await confirm('short')).status, 400);
});
