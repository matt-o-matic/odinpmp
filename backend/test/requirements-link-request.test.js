import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { LINK_REQUEST_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { createRequirementsTestApp, PROJECT_ID } from './helpers/requirements-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function expiredLink(options = {}) {
  const mail = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository: mail, ...options });
  const stakeholder = await harness.seedStakeholder();
  const created = await harness.createLink(stakeholder.id);
  return { created, harness, mail, stakeholder };
}

const requestMail = (mail) => mail.state.queue.filter((row) => row.templateId === LINK_REQUEST_TEMPLATE_ID);

test('an expired link can ask for a new one: recorded once per 24 h, emailed to admins and managers, shown on the links page', async () => {
  const { created, harness, mail, stakeholder } = await expiredLink();
  const portal = harness.portal(created.token);

  // A link that still works is not a request.
  const active = await portal.post('/link-request');
  assert.equal(active.status, 409);
  assert.equal(active.body.details.code, 'link_active');
  assert.equal(requestMail(mail).length, 0);

  harness.clock.offsetMs = 15 * DAY_MS;
  const expired = await portal.get();
  assert.equal(expired.status, 410);
  assert.equal(expired.body.details.code, 'link_expired');
  assert.equal(expired.body.details.canRequestNewLink, true);

  const events = harness.recordEvents(`project:${PROJECT_ID}`);
  const first = await portal.post('/link-request');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.alreadyRequested, false);
  assert.ok(first.body.requestedAt);
  assert.equal(first.headers['cache-control'], 'no-store');

  // One email per admin or manager (project and tenant roles), none to members or viewers.
  const sent = requestMail(mail);
  assert.deepEqual(sent.map((row) => row.recipientEmail).sort(), ['user-padmin@acme.com', 'user-pmanager@acme.com', 'user-tadmin@acme.com', 'user-tmanager@acme.com']);
  assert.ok(sent.every((row) => row.subject === 'Jamie Ortiz asked for a new link to Client booking requirements'));
  assert.ok(sent.every((row) => row.body.includes(`http://localhost:5173/app/projects/${PROJECT_ID}/requirements/links`)));
  assert.ok(sent[0].body.includes('Jamie Ortiz (Operations lead, jamie@client.example) asked for a new link to Client booking requirements.'));
  assert.ok(sent.every((row) => row.targetId.length <= 36));
  assert.ok(events.events.some((event) => event.type === 'requirements.links.invalidated' && event.reason === 'link-requested'));

  // Recorded on the link as a revoked, never-usable row; the portal stays expired.
  const stored = harness.requirementsRepository.state.tokens.filter((token) => token.purpose === 'link-request');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].createdBy, `stakeholder:${stakeholder.id}`);
  assert.ok(stored[0].revokedAt);
  assert.equal((await portal.get()).status, 410);

  // Admins see the pending request; it is not listed as a token.
  const links = await harness.as('projectManager').get('/links');
  assert.deepEqual(links.body.links[0].linkRequest, { requestedAt: first.body.requestedAt });
  assert.deepEqual(links.body.links[0].tokens.map((token) => token.purpose), ['manual']);
  assert.equal((await harness.as('member').get('/links')).status, 404);

  // A repeat within 24 hours is acknowledged, not re-sent.
  harness.clock.offsetMs += 23 * 60 * 60 * 1000;
  const again = await portal.post('/link-request');
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { alreadyRequested: true, ok: true, requestedAt: first.body.requestedAt });
  assert.equal(requestMail(mail).length, 4);

  // After 24 hours a new request goes out.
  harness.clock.offsetMs += 2 * 60 * 60 * 1000;
  const later = await portal.post('/link-request');
  assert.equal(later.status, 201);
  assert.ok(Date.parse(later.body.requestedAt) > Date.parse(first.body.requestedAt));
  assert.equal(requestMail(mail).length, 8);

  // Acting on the link (here: extending it) settles the request.
  const until = new Date(Date.now() + harness.clock.offsetMs + 10 * DAY_MS).toISOString();
  assert.equal((await harness.as('projectManager').post(`/links/${created.link.id}/extend`, { until })).status, 200);
  assert.equal((await harness.as('projectManager').get('/links')).body.links[0].linkRequest, null);
  assert.equal((await portal.get()).status, 200);
});

test('link requests: revoked links get the portal\'s 410, unknown tokens 404, and requests are rate-limited per link', async () => {
  const { created, harness } = await expiredLink({
    rateLimiter: createRequirementsPublicRateLimiter({ ip: { capacity: 1_000, refillPerSecond: 0.001 }, link: { capacity: 10, refillPerSecond: 0.001 } }),
  });
  harness.clock.offsetMs = 15 * DAY_MS;

  assert.equal((await harness.portal('no-such-token').post('/link-request')).status, 404);
  assert.equal((await harness.portal('no-such-token').post('/link-request')).body.details.code, 'link_not_found');

  // Write cost 5 against a bucket of 10: two requests, then 429.
  assert.equal((await harness.portal(created.token).post('/link-request')).status, 201);
  assert.equal((await harness.portal(created.token).post('/link-request')).status, 200);
  const limited = await harness.portal(created.token).post('/link-request');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.details.code, 'rate_limited');

  // Revoked: the same 410 and message the portal gives.
  const other = await expiredLink();
  other.harness.clock.offsetMs = 15 * DAY_MS;
  await other.harness.as('projectManager').post(`/links/${other.created.link.id}/revoke`);
  const portalView = await other.harness.portal(other.created.token).get();
  const revoked = await other.harness.portal(other.created.token).post('/link-request');
  assert.equal(revoked.status, 410);
  assert.equal(revoked.body.details.code, 'link_revoked');
  assert.deepEqual(revoked.body, portalView.body);
  assert.equal(requestMail(other.mail).length, 0);
});

test('a link request is recorded even when mail is not configured', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const created = await harness.createLink(stakeholder.id);
  harness.clock.offsetMs = 15 * DAY_MS;
  const response = await harness.portal(created.token).post('/link-request');
  assert.equal(response.status, 201);
  assert.ok((await harness.as('tenantAdmin').get('/links')).body.links[0].linkRequest);
});
