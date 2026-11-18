import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { ACCESS_REQUEST_TEMPLATE_ID } from '../src/modules/mail/access-request.templates.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryWaitlistRepository } from '../src/modules/waitlist/waitlist.repository.js';

const ada = {
  name: 'Ada Lovelace',
  email: 'Ada@Example.com',
  company: 'Analytical Engines',
  companySize: '11-50',
  industry: 'Technology',
  comments: 'A returns portal for our stores.\nPilot in March.',
  betaInterest: true,
};

function setup({ recipients = ['team@example.com'], seed = [], rateLimit } = {}) {
  const repository = createInMemoryWaitlistRepository(seed);
  const mailRepository = createInMemoryMailRepository();
  const app = createApp({ accessRequestNotifyEmails: recipients, mailRepository, waitlistRateLimit: rateLimit, waitlistRepository: repository });
  return { app, mailRepository, repository };
}

test('a request is saved, and the team gets an email they can reply to', async () => {
  const { app, mailRepository, repository } = setup({ recipients: ['team@example.com', 'lead@example.com'] });

  const response = await request(app).post('/api/public/waitlist').send(ada);

  assert.equal(response.status, 201);
  // Only an acknowledgement goes back: nothing stored is echoed to the browser.
  assert.deepEqual(response.body, { ok: true });
  assert.equal(repository.items.length, 1);
  assert.equal(repository.items[0].email, 'ada@example.com');
  assert.equal('website' in repository.items[0], false);

  const mail = await mailRepository.listPendingEmails();
  assert.deepEqual(mail.map((row) => row.recipientEmail).sort(), ['lead@example.com', 'team@example.com']);
  for (const row of mail) {
    assert.equal(row.templateId, ACCESS_REQUEST_TEMPLATE_ID);
    assert.equal(row.replyTo, 'ada@example.com');
    assert.equal(row.subject, 'Odin access request from Ada Lovelace');
    assert.match(row.body, /Analytical Engines/);
    assert.match(row.body, /11 to 50/);
    assert.match(row.body, /A returns portal for our stores\.<br>Pilot in March\./);
    assert.match(row.body, /Yes, they want to try new features early/);
  }
});

test('whatever a requester types is escaped in the team email', async () => {
  const { app, mailRepository } = setup();

  await request(app).post('/api/public/waitlist').send({ name: 'Eve <script>', email: 'eve@example.com', comments: '<img src=x onerror=alert(1)>' });

  const [row] = await mailRepository.listPendingEmails();
  assert.equal(row.subject, 'Odin access request from Eve <script>');
  assert.doesNotMatch(row.body, /<script>|<img/);
  assert.match(row.body, /Eve &lt;script&gt;/);
  assert.match(row.body, /Not given/);
});

test('asking again gets the same answer, with no second row and no second email', async () => {
  const { app, mailRepository, repository } = setup({ seed: [{ id: '1', email: 'ada@example.com', name: 'Ada Lovelace', comments: 'Private notes' }] });

  const response = await request(app).post('/api/public/waitlist').send(ada);

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(repository.items.length, 1);
  assert.deepEqual(await mailRepository.listPendingEmails(), []);
});

test('a form filled in by a bot is accepted and dropped', async () => {
  const { app, mailRepository, repository } = setup();

  const response = await request(app).post('/api/public/waitlist').send({ ...ada, website: 'https://spam.example.com' });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(repository.items.length, 0);
  assert.deepEqual(await mailRepository.listPendingEmails(), []);
});

test('one connection can only send a few requests an hour', async () => {
  const { app, repository } = setup({ rateLimit: { limit: 2 } });

  const statuses = [];
  for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
    statuses.push((await request(app).post('/api/public/waitlist').send({ name: 'Someone', email })).status);
  }

  assert.deepEqual(statuses, [201, 201, 429]);
  assert.equal(repository.items.length, 2);
});

test('with no team address configured, the request is still saved', async () => {
  const { app, mailRepository, repository } = setup({ recipients: [] });

  const response = await request(app).post('/api/public/waitlist').send(ada);

  assert.equal(response.status, 201);
  assert.equal(repository.items.length, 1);
  assert.deepEqual(await mailRepository.listPendingEmails(), []);
});

test('invalid requests are rejected', async () => {
  const { app } = setup();

  const response = await request(app).post('/api/public/waitlist').send({ name: '', email: 'not-an-email' });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
});

test('ACCESS_REQUEST_NOTIFY_EMAILS is a comma-separated list of addresses', () => {
  assert.deepEqual(loadEnv({ NODE_ENV: 'test' }).accessRequestNotifyEmails, []);
  assert.deepEqual(loadEnv({ NODE_ENV: 'test', ACCESS_REQUEST_NOTIFY_EMAILS: ' Team@Example.com, lead@example.com,team@example.com ' }).accessRequestNotifyEmails, ['team@example.com', 'lead@example.com']);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', ACCESS_REQUEST_NOTIFY_EMAILS: 'team@example.com, nobody' }), /ACCESS_REQUEST_NOTIFY_EMAILS: nobody is not an email address/);
});
