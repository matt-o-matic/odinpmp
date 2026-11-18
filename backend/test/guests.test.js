import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAccessRepository } from '../src/modules/access/access.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { addEngagementGuestsAsStakeholders } from '../src/modules/engagements/engagements.service.js';
import { createGuestRateLimiter } from '../src/modules/guests/guest-rate-limit.js';
import { tagsOdin } from '../src/modules/channels/odin-tag.js';
import { NO_GUEST_TASKS } from '../src/modules/guests/guest-tasks.js';
import { createInMemoryGuestSessionsRepository } from '../src/modules/guests/guest-sessions.repository.js';
import { GUEST_SESSION_TTL_MS } from '../src/modules/guests/guests.service.js';
import { createGuestNotificationDirectory } from '../src/modules/guests/guest-notifications.js';
import { flushDueChatDigests } from '../src/modules/notifications/chat-digest.service.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// Channel guests: invitations, sign-in by emailed code, the 30-day session that renews with use,
// everything a guest may do in their channels, the 404s and 403s for everything else, removal,
// the guest stream, the Consulting module, conversion and the audit trail. Through Odin's routes
// on in-memory repositories, with a fake clock for codes and sessions.
// guests-mysql.integration.test.js runs migration 0098.

const TENANT_ID = 'tenant-acme';
const OTHER_TENANT_ID = 'tenant-other';
const ENG = 'project-eng';
// A second engagement, for a guest in two (one bell and one email across both).
const ENG2 = 'project-eng-2';
const DEL = 'project-del';
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', projectRole: 'admin', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', projectRole: 'user', role: 'user' },
  admin: { id: 'user-admin', name: 'Ada Admin', projectRole: null, role: 'admin' },
};
const GINA = { email: 'gina@northwind.example', name: 'Gina Guest', organization: 'Northwind' };
const OTTO = { email: 'otto@contoso.example', name: 'Otto Outside', organization: 'Contoso' };
const NOBODY = 'nobody@nowhere.example';
const start = Date.parse('2026-11-14T09:00:00.000Z');

async function fixture(t, { guestTaskSource = undefined, rateLimits = null } = {}) {
  const clock = { now: start };
  const at = () => new Date(clock.now);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }, { domains: ['other.example'], id: OTHER_TENANT_ID, name: 'Other' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-guests-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const changeLog = createInMemoryProjectChangeLog();
  const mailRepository = createInMemoryMailRepository();
  const members = Object.values(USERS).filter((user) => user.projectRole).map((user) => ({ email: `${user.id}@acme.example`, id: user.id, name: user.name, role: user.projectRole }));
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog,
    fileStorage: storage,
    mailRepository,
    seed: {
      projectMemberships: { [DEL]: members, [ENG]: members, [ENG2]: members },
      projects: [
        { engagementCustomer: 'Northwind', engagementOwnerId: USERS.lead.id, engagementStatus: 'open', epics: [], id: ENG, kind: 'engagement', name: 'Northwind pursuit', status: 'In Progress', tenantId: TENANT_ID },
        { engagementCustomer: 'Northwind', engagementOwnerId: USERS.lead.id, engagementStatus: 'open', epics: [], id: ENG2, kind: 'engagement', name: 'Northwind phase 2', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: DEL, name: 'Contoso rollout', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const assistantRepository = createInMemoryAssistantRepository();
  const accessRepository = createInMemoryAccessRepository();
  const guestSessionsRepository = createInMemoryGuestSessionsRepository();
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
  const liveEventBus = createLiveEventBus();
  const audit = [];
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'guests-fixture', secret: 'disposable-guests-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    accessRepository, assistantRepository, auditWriter: { async append(event) { audit.push(event); return event; } }, authRepository, complianceRepository: createInMemoryComplianceRepository(),
    fileStorage: storage, guestClock: at, guestHeartbeatMs: 60_000, ...(guestTaskSource ? { guestTaskSource } : {}), guestRateLimiter: createGuestRateLimiter(rateLimits ? { limits: rateLimits } : {}), guestSessionsRepository,
    liveEventBus, mailRepository, projectRepository, requirementsClock: at, sessionsRepository, tokenService, workspaceModulesRepository,
  });
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const tokens = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: {}, role: user.role, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[key] = token;
  }
  const absolute = (url) => (url.startsWith('http') ? url : `${origin}${url}`);
  // `as` is a member key, or { guest: token } for a guest's bearer token.
  async function send(as, method, route, body, { headers = {} } = {}) {
    const bearer = typeof as === 'string' ? tokens[as] : as?.guest;
    const response = await fetch(absolute(route), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      method,
    });
    return { body: await response.json().catch(() => null), headers: response.headers, status: response.status };
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await send(as, method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const P = (projectId) => `/api/projects/${projectId}`;
  async function channel(projectId, name) {
    const listed = await ok('lead', 'GET', `${P(projectId)}/channels`);
    const found = listed.channels.find((entry) => entry.name === name);
    if (found) return found;
    return (await ok('lead', 'POST', `${P(projectId)}/channels`, { name }, 201)).channel;
  }
  async function invite(projectId, channelId, person, as = 'lead') {
    return ok(as, 'POST', `${P(projectId)}/channels/${channelId}/guests`, person, 201);
  }
  const lastCode = (email) => {
    const mail = [...mailRepository.state.queue].reverse().find((row) => row.recipientEmail === email && row.templateId === 'guest-sign-in-code-v1');
    return mail ? /letter-spacing:6px[^>]*>(\d{6})</.exec(mail.body)?.[1] ?? null : null;
  };
  async function signIn(email, { advance = 61_000 } = {}) {
    clock.now += advance;
    await ok(null, 'POST', '/api/guest/sign-in/code', { email });
    const code = lastCode(email);
    assert.ok(code, 'a code was emailed');
    return ok(null, 'POST', '/api/guest/sign-in', { code, email });
  }
  async function upload(as, projectBase, contents, start) {
    const bytes = Buffer.from(contents);
    const started = await ok(as, 'POST', `${projectBase}/uploads`, { contentType: 'text/plain', fileSize: bytes.length, ...start }, 201);
    const signed = await ok(as, 'POST', `${projectBase}/uploads/${started.upload.id}/parts`, { partNumbers: [1] });
    const put = await fetch(absolute(signed.parts[0].url), { body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, method: 'PUT' });
    assert.equal(put.status, 200, await put.text());
    return send(as, 'POST', `${projectBase}/uploads/${started.upload.id}/complete`, {});
  }
  async function scanAll() {
    for (const object of await projectRepository.listPendingScanObjects({ limit: 100 })) {
      const bytes = (await storage.read(object.storageKey)).bytes;
      await projectRepository.recordObjectScan({ md5: createHash('md5').update(bytes).digest('hex'), scanStatus: 'clean', storageKey: object.storageKey });
    }
  }
  // An open guest stream: its events as they arrive, and whether it closed.
  async function openStream(guestToken) {
    const controller = new AbortController();
    const response = await fetch(absolute('/api/guest/events'), { headers: { Authorization: `Bearer ${guestToken}` }, signal: controller.signal });
    const stream = { closed: false, events: [], status: response.status };
    if (response.status !== 200) return stream;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    stream.done = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const type = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            stream.events.push({ data: data ? JSON.parse(data) : null, type });
          }
        }
      } catch {
        // aborted
      }
      stream.closed = true;
    })();
    stream.stop = () => controller.abort();
    t.after(() => controller.abort());
    return stream;
  }
  const waitFor = async (check, label, timeoutMs = 3000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  return { absoluteUrl: absolute, accessRepository, app, assistantRepository, audit, authRepository, channel, clock, guestSessionsRepository, invite, lastCode, liveEventBus, mailRepository, notificationsRepository: app.locals.notificationsRepository, ok, openStream, P, projectRepository, scanAll, send, signIn, upload, waitFor, workspaceModulesRepository };
}

// A fixture with Gina in #Deal room on the engagement and Otto in #Internal; Gina signed in.
async function withGuests(t, options) {
  const f = await fixture(t, options);
  const deal = await f.channel(ENG, 'Deal room');
  const internal = await f.channel(ENG, 'Internal');
  const general = (await f.ok('lead', 'GET', `${f.P(ENG)}/channels`)).channels.find((entry) => entry.isGeneral);
  const contoso = await f.channel(DEL, 'Contoso team');
  const ginaInvite = await f.invite(ENG, deal.id, GINA);
  const ottoInvite = await f.invite(ENG, internal.id, OTTO);
  const session = await f.signIn(GINA.email);
  const gina = { guest: session.token };
  return { ...f, contoso, deal, general, gina, ginaInvite, internal, ottoInvite, session };
}

test('invite: decision rights invite by name, email and organization; the stakeholder and access link are made once; members cannot invite', async (t) => {
  const { accessRepository, assistantRepository, audit, channel, invite, mailRepository, ok, P, send } = await fixture(t);
  const deal = await channel(ENG, 'Deal room');
  const second = await channel(ENG, 'Pricing');

  const invited = await invite(ENG, deal.id, GINA);
  assert.equal(invited.added, true);
  assert.equal(invited.invitationQueued, true);
  const stakeholders = await assistantRepository.listProjectStakeholders({ projectId: ENG, tenantId: TENANT_ID });
  assert.deepEqual(stakeholders.map((entry) => [entry.email, entry.name, entry.roleTitle]), [[GINA.email, GINA.name, 'Northwind']]);
  const link = await accessRepository.findLinkByEmail({ email: GINA.email, tenantId: TENANT_ID });
  assert.ok(link, 'the workspace access link identity exists');
  const invitation = mailRepository.state.queue.find((row) => row.templateId === 'guest-invitation-v1');
  assert.equal(invitation.recipientEmail, GINA.email);
  assert.match(invitation.body, new RegExp(`https://app.example/app/guest/channels/${deal.id}\\?workspace=${TENANT_ID}`));

  const again = await invite(ENG, deal.id, GINA);
  assert.deepEqual([again.added, again.invitationQueued], [false, false], 'already in the channel: nothing changes and nothing is sent');
  assert.equal(mailRepository.state.queue.filter((row) => row.templateId === 'guest-invitation-v1').length, 1);

  // Adding them to more channels later reuses the stakeholder and the link.
  const more = await invite(ENG, second.id, { email: GINA.email.toUpperCase() });
  assert.equal(more.added, true);
  assert.equal((await assistantRepository.listProjectStakeholders({ projectId: ENG, tenantId: TENANT_ID })).length, 1);
  assert.equal((await accessRepository.findLinkByEmail({ email: GINA.email, tenantId: TENANT_ID })).id, link.id);

  const memberTry = await send('member', 'POST', `${P(ENG)}/channels/${deal.id}/guests`, OTTO);
  assert.deepEqual([memberTry.status, memberTry.body.details.code], [403, 'decision_rights_required']);
  const workspaceMember = await send('lead', 'POST', `${P(ENG)}/channels/${deal.id}/guests`, { email: 'user-member@acme.example', name: 'Mo' });
  assert.deepEqual([workspaceMember.status, workspaceMember.body.details.code], [409, 'guest_is_member']);
  const noName = await send('lead', 'POST', `${P(ENG)}/channels/${deal.id}/guests`, { email: 'new@person.example' });
  assert.deepEqual([noName.status, noName.body.details.code], [400, 'guest_name_required']);

  const listed = await ok('member', 'GET', `${P(ENG)}/channels/${deal.id}/guests`);
  assert.equal(listed.canManage, false, 'members see guests; decision rights manage them');
  assert.deepEqual(listed.guests.map((guest) => [guest.email, guest.organization, guest.lastSeenAt]), [[GINA.email, 'Northwind', null]]);
  assert.equal((await ok('lead', 'GET', `${P(ENG)}/channels/${deal.id}/guests`)).canManage, true);
  assert.equal(audit.filter((entry) => entry.action === 'guest.invite').length, 2, 'each invitation that added someone is audited');
  assert.ok(audit.every((entry) => entry.action !== 'guest.invite' || entry.userId === USERS.lead.id));
});

test('sign-in codes: 6 digits for 15 minutes, 5 tries, resend after 60 s, and the same answers for unknown addresses', async (t) => {
  const { audit, channel, clock, guestSessionsRepository, invite, lastCode, send } = await fixture(t);
  const deal = await channel(ENG, 'Deal room');
  await invite(ENG, deal.id, GINA);
  const ask = (email) => send(null, 'POST', '/api/guest/sign-in/code', { email });
  const enter = (email, code) => send(null, 'POST', '/api/guest/sign-in', { code, email });
  // What a caller can compare: status, error code and remaining tries.
  const shape = (response) => [response.status, response.body?.details?.code ?? null, response.body?.details?.remaining ?? null];

  const known = await ask(GINA.email);
  const unknown = await ask(NOBODY);
  assert.equal(known.status, 200);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort(), 'the same answer for an unknown address');
  assert.deepEqual({ ...known.body, sentTo: '' }, { ...unknown.body, sentTo: '' });
  assert.equal(known.body.sentTo, 'g***@northwind.example');
  const code = lastCode(GINA.email);
  assert.match(code, /^\d{6}$/);
  assert.equal(lastCode(NOBODY), null, 'nothing is sent to an unknown address');
  const stored = await guestSessionsRepository.getSignInCode({ accessLinkId: (await guestSessionsRepository.state.codes[0]).accessLinkId });
  assert.notEqual(stored.codeHash, code, 'stored hashed');
  assert.equal(stored.codeHash.length, 64);

  // Resend after 60 seconds, for both.
  assert.deepEqual(shape(await ask(GINA.email)), [429, 'code_recently_sent', null]);
  assert.deepEqual(shape(await ask(NOBODY)), [429, 'code_recently_sent', null]);
  clock.now += 61_000;
  assert.equal((await ask(GINA.email)).status, 200);
  assert.equal((await ask(NOBODY)).status, 200);
  const fresh = lastCode(GINA.email);
  assert.notEqual((await guestSessionsRepository.getSignInCode({ accessLinkId: stored.accessLinkId })).codeHash, stored.codeHash, 'a resend replaces the code');

  // Five wrong tries lock the code, and then even the right one is refused. An unknown address
  // answers exactly the same.
  const wrong = fresh === '000000' ? '111111' : '000000';
  for (const email of [GINA.email, NOBODY]) {
    const tries = [];
    for (let attempt = 0; attempt < 6; attempt += 1) tries.push(shape(await enter(email, wrong)));
    assert.deepEqual(tries, [
      [400, 'code_invalid', 4], [400, 'code_invalid', 3], [400, 'code_invalid', 2], [400, 'code_invalid', 1],
      [400, 'code_locked', 0], [400, 'code_locked', null],
    ], email);
  }
  assert.deepEqual(shape(await enter(GINA.email, fresh)), [400, 'code_locked', null], 'a locked code stays locked');
  assert.ok(audit.some((entry) => entry.action === 'guest.sign_in_locked'));

  // A code expires after 15 minutes.
  clock.now += 61_000;
  await ask(GINA.email);
  await ask(NOBODY);
  const expiring = lastCode(GINA.email);
  clock.now += 15 * 60_000 + 1000;
  assert.deepEqual(shape(await enter(GINA.email, expiring)), [400, 'code_expired', null]);
  assert.deepEqual(shape(await enter(NOBODY, '123456')), [400, 'code_expired', null]);

  // A right code signs in once.
  clock.now += 61_000;
  await ask(GINA.email);
  const good = lastCode(GINA.email);
  const signedIn = await enter(GINA.email, good);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.match(signedIn.body.token, /^odin_guest_/);
  assert.deepEqual(shape(await enter(GINA.email, good)), [400, 'code_required', null], 'a used code is gone');
  // Never asked: the same answer for both.
  assert.deepEqual(shape(await enter('never@asked.example', '123456')), [400, 'code_required', null]);
  assert.deepEqual((await send(null, 'POST', '/api/guest/sign-in/code', { email: 'not an email' })).body.details.code, 'invalid_email');
});

test('sign-in rate limits: per email and per IP, whether or not the address is a guest', async (t) => {
  const limits = {
    codesPerEmail: { capacity: 2, refillPerSecond: 0.0001 },
    codesPerIp: { capacity: 6, refillPerSecond: 0.0001 },
    signInsPerIp: { capacity: 3, refillPerSecond: 0.0001 },
  };
  const { channel, clock, invite, send } = await fixture(t, { rateLimits: limits });
  await invite(ENG, (await channel(ENG, 'Deal room')).id, GINA);
  const ask = (email) => send(null, 'POST', '/api/guest/sign-in/code', { email });
  for (const email of [GINA.email, NOBODY]) {
    assert.equal((await ask(email)).status, 200);
    clock.now += 61_000;
    assert.equal((await ask(email)).status, 200);
    clock.now += 61_000;
    const limited = await ask(email);
    assert.deepEqual([limited.status, limited.body.details.code, limited.body.details.scope], [429, 'rate_limited', 'email'], email);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }
  const byIp = await ask('third@person.example');
  assert.deepEqual([byIp.status, byIp.body.details.scope], [429, 'ip'], 'six requests from one address, then no more');
  for (let attempt = 0; attempt < 3; attempt += 1) await send(null, 'POST', '/api/guest/sign-in', { code: '123456', email: NOBODY });
  const tries = await send(null, 'POST', '/api/guest/sign-in', { code: '123456', email: GINA.email });
  assert.deepEqual([tries.status, tries.body.details.code, tries.body.details.scope], [429, 'rate_limited', 'ip']);
});

test('sessions: stored hashed, renewed by each request to 30 days after it, refused after 30 days unused, and ended by sign-out', async (t) => {
  const { clock, gina, guestSessionsRepository, ok, send, session } = await withGuests(t);
  const stored = guestSessionsRepository.state.sessions[0];
  assert.equal(stored.tokenHash, createHash('sha256').update(session.token).digest('hex'));
  assert.ok(!JSON.stringify(guestSessionsRepository.state).includes(session.token), 'the token itself is not stored');
  const signedInAt = clock.now;
  assert.equal(Date.parse(session.expiresAt), signedInAt + GUEST_SESSION_TTL_MS);

  clock.now += 10 * 24 * 3600_000;
  const described = await ok(gina, 'GET', '/api/guest/session');
  assert.equal(Date.parse(described.session.expiresAt), clock.now + GUEST_SESSION_TTL_MS, 'each request moves the expiry to 30 days after it');
  assert.equal(Date.parse(guestSessionsRepository.state.sessions[0].expiresAt), clock.now + GUEST_SESSION_TTL_MS);

  // 29 days later it still works, because it was used 10 days in.
  clock.now += 29 * 24 * 3600_000;
  await ok(gina, 'GET', '/api/guest/engagements');
  // Then 30 days and a second without use: refused.
  clock.now += GUEST_SESSION_TTL_MS + 1000;
  const expired = await send(gina, 'GET', '/api/guest/engagements');
  assert.deepEqual([expired.status, expired.body.details.code], [401, 'guest_session_ended']);

  const again = await (await withGuests(t)).signIn(GINA.email);
  assert.ok(again.token);
});

test('sessions by cookie: HttpOnly on /api/guest only, writes need the CSRF value, sign-out revokes', async (t) => {
  const f = await withGuests(t);
  const { deal, send, session } = f;
  // Signing in sets the cookies.
  f.clock.now += 61_000;
  await f.ok(null, 'POST', '/api/guest/sign-in/code', { email: GINA.email });
  const code = f.lastCode(GINA.email);
  const signIn = await f.send(null, 'POST', '/api/guest/sign-in', { code, email: GINA.email });
  const cookies = signIn.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.startsWith('odin_guest='));
  const csrfCookie = cookies.find((value) => value.startsWith('odin_guest_csrf='));
  assert.match(sessionCookie, /Path=\/api\/guest/);
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /Max-Age=2592000/, 'the cookie lasts as long as the session');
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  const cookieValue = sessionCookie.split(';')[0];
  const csrf = decodeURIComponent(csrfCookie.split(';')[0].split('=')[1]);
  const viaCookie = (method, route, body, extra = {}) => f.send(null, method, route, body, { headers: { Cookie: cookieValue, ...extra } });
  assert.equal((await viaCookie('GET', '/api/guest/engagements')).status, 200);
  const noCsrf = await viaCookie('POST', `/api/guest/channels/${f.deal.id}/posts`, { body: 'Hello' });
  assert.equal(noCsrf.status, 403, 'a write by cookie without the CSRF value is refused');
  assert.equal((await viaCookie('POST', `/api/guest/channels/${f.deal.id}/posts`, { body: 'Hello' }, { 'X-CSRF-Token': csrf })).status, 201);
  // The member cookie name never carries a guest session.
  const asMemberCookie = await f.send(null, 'GET', '/api/projects', undefined, { headers: { Cookie: `odin_access=${cookieValue.split('=')[1]}` } });
  assert.deepEqual([asMemberCookie.status, asMemberCookie.body.details.code], [403, 'guest_not_allowed']);
  // Sign-out ends the session.
  assert.equal((await viaCookie('POST', '/api/guest/sign-out', {}, { 'X-CSRF-Token': csrf })).status, 200);
  assert.equal((await viaCookie('GET', '/api/guest/engagements')).status, 401);

  // A bearer session signs out too.
  assert.equal((await send({ guest: session.token }, 'POST', '/api/guest/sign-out', {})).status, 200);
  assert.equal((await send({ guest: session.token }, 'GET', `/api/guest/channels/${deal.id}`)).status, 401);
});

test('a guest sees only their channels: engagements list, channel, posts, replies, edits, mentions and unread counts', async (t) => {
  const { audit, deal, gina, general, internal, ok, P, send } = await withGuests(t);
  const listed = await ok(gina, 'GET', '/api/guest/engagements');
  assert.deepEqual(listed.projects.map((project) => [project.id, project.kind, project.channels.map((entry) => entry.name)]), [[ENG, 'engagement', ['Deal room']]], 'not General, not Internal, not other projects');
  assert.ok(audit.some((entry) => entry.action === 'guest.sign_in' && entry.userId.startsWith('guest:')));

  // The file tree shows her channels only, without the engagement's own files.
  const tree = await ok(gina, 'GET', `/api/guest/projects/${ENG}/file-tree`);
  assert.deepEqual([tree.canManage, tree.rootFileCount, tree.channels.map((entry) => entry.name)], [false, 0, ['Deal room']]);

  const opened = await ok(gina, 'GET', `/api/guest/channels/${deal.id}`);
  assert.deepEqual([opened.channel.canPost, opened.channel.canRename, opened.channel.canArchive, opened.channel.canEdit], [true, false, false, false]);

  // A member posts and tags Gina: she gets a mention notification, which the rolled-up chat
  // email carries (modules/notifications), as members do.
  const ginaStakeholder = (await ok('member', 'GET', `${P(ENG)}/channels/${deal.id}/mentionables`)).people.find((person) => person.kind === 'stakeholder').ref.split(':')[1];
  const memberPost = (await ok('member', 'POST', `${P(ENG)}/channels/${deal.id}/posts`, { body: `Hi @[${GINA.name}](stakeholder:${ginaStakeholder})` }, 201)).post;
  const bell = await ok(gina, 'GET', '/api/guest/me/notifications');
  assert.deepEqual([bell.unreadCount, bell.notifications.map((entry) => [entry.kind, entry.path])], [1, [['mention', `/guest/channels/${deal.id}?post=${memberPost.id}`]]], 'the tagged guest is notified, with a link into the guest view');
  assert.equal((await ok(gina, 'GET', '/api/guest/engagements')).projects[0].channels[0].unreadCount, 1);
  await ok(gina, 'POST', `/api/guest/channels/${deal.id}/read`, {});
  assert.equal((await ok(gina, 'GET', '/api/guest/engagements')).projects[0].channels[0].unreadCount, 0);

  // Gina tags Mo and replies; Mo is emailed.
  const people = (await ok(gina, 'GET', `/api/guest/channels/${deal.id}/mentionables`)).people;
  assert.ok(people.some((person) => person.name === USERS.member.name));
  assert.ok(!people.some((person) => person.name === OTTO.name), 'guests of other channels are not listed');
  assert.ok(!people.some((person) => person.name === GINA.name), 'not herself');
  const created = await ok(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: `Thanks @[${USERS.member.name}](user:${USERS.member.id})` }, 201);
  assert.deepEqual([created.post.author.type, created.post.author.name, created.post.isMine, created.post.canEdit], ['stakeholder', GINA.name, true, true]);
  assert.deepEqual(created.mentioned, [USERS.member.id]);
  const reply = await ok(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: 'A reply', parentId: memberPost.id }, 201);
  assert.equal(reply.post.parentId, memberPost.id);
  const edited = await ok(gina, 'PATCH', `/api/guest/posts/${created.post.id}`, { body: 'Thanks all' });
  assert.equal(edited.post.body, 'Thanks all');
  const notMine = await send(gina, 'PATCH', `/api/guest/posts/${memberPost.id}`, { body: 'hijack' });
  assert.deepEqual([notMine.status, notMine.body.details.code], [403, 'not_author']);
  assert.equal((await send(gina, 'DELETE', `/api/guest/posts/${memberPost.id}`)).status, 403, 'a guest deletes only their own');
  assert.equal((await ok(gina, 'DELETE', `/api/guest/posts/${reply.post.id}`)).post.deleted, true);

  // Members see Gina's posts with her name.
  const seen = (await ok('member', 'GET', `${P(ENG)}/channels/${deal.id}/posts`)).posts;
  assert.ok(seen.some((post) => post.author.type === 'stakeholder' && post.author.name === GINA.name));
  const guestView = (await ok(gina, 'GET', `/api/guest/channels/${deal.id}/posts`)).posts;
  assert.equal(guestView.length, 2);
  void general; void internal;
});

test('a guest uploads in parts into their channel, downloads after the scan, previews, versions, comments and marks editing', async (t) => {
  const { absoluteUrl, audit, deal, gina, ok, P, scanAll, send, upload } = await withGuests(t);
  const uploaded = await upload(gina, '/api/guest', 'Network diagram v1', { fileName: 'diagram.txt', targetId: deal.id, targetType: 'channel' });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const file = uploaded.body.file;
  assert.equal(file.uploadedBy.name, GINA.name);
  assert.equal(file.scanStatus, 'pending');
  assert.ok(!('links' in file) && !('audience' in file), 'a guest sees no links or audience');
  assert.ok(audit.some((entry) => entry.action === 'guest.upload' && entry.detail.fileId === file.id));

  const pending = await send(gina, 'GET', `/api/guest/files/${file.id}/download-url`);
  assert.equal(pending.status, 409, 'nothing downloads before its scan passes');
  await scanAll();
  const link = await ok(gina, 'GET', `/api/guest/files/${file.id}/download-url`);
  const bytes = await (await fetch(absoluteUrl(link.url))).text();
  assert.equal(bytes, 'Network diagram v1', 'the signed link serves the file');
  assert.ok(audit.some((entry) => entry.action === 'guest.download' && entry.detail.fileId === file.id));
  const preview = await ok(gina, 'GET', `/api/guest/files/${file.id}/preview-url`);
  assert.equal(preview.kind, 'text');

  // Members see the guest's file in the channel library.
  const memberFiles = (await ok('member', 'GET', `${P(ENG)}/files?targetType=channel&targetId=${deal.id}`)).files;
  assert.deepEqual(memberFiles.map((entry) => [entry.fileName, entry.uploadedBy.name]), [['diagram.txt', GINA.name]]);
  const listed = await ok(gina, 'GET', `/api/guest/channels/${deal.id}/files`);
  assert.deepEqual([listed.canWrite, listed.files.map((entry) => entry.fileName)], [true, ['diagram.txt']]);
  assert.deepEqual((await ok(gina, 'GET', '/api/guest/file-storage')).canDeleteVersions, false);

  // A new version from the guest, then the versions.
  const second = await upload(gina, '/api/guest', 'Network diagram v2', { expectedVersion: 1, fileId: file.id, fileName: 'diagram.txt' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.file.version, 2);
  const versions = await ok(gina, 'GET', `/api/guest/files/${file.id}/versions`);
  assert.deepEqual(versions.versions.map((entry) => entry.version), [2, 1]);

  // Comments and the editing marker.
  const comment = await ok(gina, 'POST', `/api/guest/files/${file.id}/comments`, { body: 'Updated the WAN links' }, 201);
  assert.equal(comment.comment.fileVersion, 2);
  const comments = await ok('member', 'GET', `${P(ENG)}/files/${file.id}/comments`);
  assert.equal(comments.comments[0].author.name, GINA.name);
  const marked = await ok(gina, 'PUT', `/api/guest/files/${file.id}/editing`, {});
  assert.equal(marked.editing.name, GINA.name);
  // A member who uploads over Gina's marker is asked to confirm.
  const overMarker = await send('member', 'POST', `${P(ENG)}/uploads`, { contentType: 'text/plain', expectedVersion: 2, fileId: file.id, fileName: 'diagram.txt', fileSize: 4 });
  assert.deepEqual([overMarker.status, overMarker.body.details.code, overMarker.body.details.editing.name], [409, 'file_being_edited', GINA.name]);
  assert.equal((await ok(gina, 'DELETE', `/api/guest/files/${file.id}/editing`)).editing, null);
  // The 1 GB limit applies to guests.
  const tooBig = await send(gina, 'POST', '/api/guest/uploads', { contentType: 'text/plain', fileName: 'huge.bin', fileSize: 1_073_741_825, targetId: deal.id, targetType: 'channel' });
  assert.deepEqual([tooBig.status, tooBig.body.details.code], [413, 'file_too_large']);
});

test('every guest route answers 404 for another channel, its posts, files, versions, comments, previews, downloads, uploads and events', async (t) => {
  const { contoso, deal, gina, general, internal, ok, openStream, P, scanAll, send, upload, waitFor } = await withGuests(t);
  // Internal has a post, a file with a comment, and an upload in progress by a member.
  const internalPost = (await ok('member', 'POST', `${P(ENG)}/channels/${internal.id}/posts`, { body: 'Internal pricing' }, 201)).post;
  const internalFile = (await upload('member', P(ENG), 'Pricing sheet', { fileName: 'pricing.txt', targetId: internal.id, targetType: 'channel' })).body.file;
  await scanAll();
  const internalComment = (await ok('member', 'POST', `${P(ENG)}/files/${internalFile.id}/comments`, { body: 'Margins' }, 201)).comment;
  const memberUpload = (await ok('member', 'POST', `${P(ENG)}/uploads`, { contentType: 'text/plain', fileName: 'draft.txt', fileSize: 5, targetId: deal.id, targetType: 'channel' }, 201)).upload;
  const vaultFile = (await ok('member', 'POST', `${P(ENG)}/files`, { fileContentsBase64: Buffer.from('vault').toString('base64'), fileDescription: '', fileName: 'vault.txt', fileType: 'text/plain', targetId: ENG, targetType: 'project' }, 201)).file;
  const contosoPost = (await ok('member', 'POST', `${P(DEL)}/channels/${contoso.id}/posts`, { body: 'Other project' }, 201)).post;

  const denied = [
    ['GET', `/api/guest/channels/${internal.id}`],
    ['GET', `/api/guest/channels/${general.id}`],
    ['GET', `/api/guest/channels/${contoso.id}`],
    ['GET', `/api/guest/channels/${internal.id}/posts`],
    ['POST', `/api/guest/channels/${internal.id}/posts`, { body: 'Let me in' }],
    ['POST', `/api/guest/channels/${internal.id}/read`, {}],
    ['GET', `/api/guest/channels/${internal.id}/mentionables`],
    ['GET', `/api/guest/channels/${internal.id}/folders`],
    ['GET', `/api/guest/projects/${DEL}/file-tree`],
    ['GET', `/api/guest/channels/${internal.id}/files`],
    ['GET', `/api/guest/channels/${contoso.id}/posts`],
    ['PATCH', `/api/guest/posts/${internalPost.id}`, { body: 'x' }],
    ['DELETE', `/api/guest/posts/${internalPost.id}`],
    ['PATCH', `/api/guest/posts/${contosoPost.id}`, { body: 'x' }],
    ['PATCH', `/api/guest/posts/${internalComment.id}`, { body: 'x' }],
    ['DELETE', `/api/guest/posts/${internalComment.id}`],
    ['GET', `/api/guest/files/${internalFile.id}/versions`],
    ['GET', `/api/guest/files/${internalFile.id}/download-url`],
    ['GET', `/api/guest/files/${internalFile.id}/download-url?version=1`],
    ['GET', `/api/guest/files/${internalFile.id}/preview-url`],
    ['GET', `/api/guest/files/${internalFile.id}/comments`],
    ['POST', `/api/guest/files/${internalFile.id}/comments`, { body: 'x' }],
    ['GET', `/api/guest/files/${internalFile.id}/mentionables`],
    ['PUT', `/api/guest/files/${internalFile.id}/editing`, {}],
    ['DELETE', `/api/guest/files/${internalFile.id}/editing`],
    ['GET', `/api/guest/files/${vaultFile.id}/download-url`],
    ['GET', `/api/guest/files/${vaultFile.id}/versions`],
    ['POST', '/api/guest/uploads', { contentType: 'text/plain', fileName: 'x.txt', fileSize: 3, targetId: internal.id, targetType: 'channel' }],
    ['POST', '/api/guest/uploads', { contentType: 'text/plain', expectedVersion: 1, fileId: internalFile.id, fileName: 'pricing.txt', fileSize: 3 }],
    ['POST', '/api/guest/uploads', { contentType: 'text/plain', fileName: 'x.txt', fileSize: 3, targetId: ENG, targetType: 'project' }],
    ['GET', `/api/guest/uploads/${memberUpload.id}`],
    ['POST', `/api/guest/uploads/${memberUpload.id}/parts`, { partNumbers: [1] }],
    ['POST', `/api/guest/uploads/${memberUpload.id}/complete`, {}],
    ['DELETE', `/api/guest/uploads/${memberUpload.id}`],
    ['GET', `/api/guest/projects/${DEL}/tasks`],
  ];
  for (const [method, route, body] of denied) {
    const response = await send(gina, method, route, body);
    assert.ok([400, 404].includes(response.status), `${method} ${route} answered ${response.status}`);
    if (response.status === 400) assert.equal(response.body.details?.code, 'target_required', `${method} ${route}`);
  }
  // A channel id that is not there at all looks the same as one that is someone else's.
  assert.equal((await send(gina, 'GET', '/api/guest/channels/no-such-channel')).status, 404);

  // Events: a post in Internal never reaches Gina's stream; one in her channel does.
  const stream = await openStream(gina.guest);
  assert.equal(stream.status, 200);
  await waitFor(() => stream.events.some((event) => event.type === 'connected'), 'connected');
  await ok('member', 'POST', `${P(ENG)}/channels/${internal.id}/posts`, { body: 'Internal only' }, 201);
  await ok('member', 'POST', `${P(DEL)}/channels/${contoso.id}/posts`, { body: 'Other project only' }, 201);
  await ok('member', 'POST', `${P(ENG)}/channels/${deal.id}/posts`, { body: 'For Gina' }, 201);
  await waitFor(() => stream.events.some((event) => event.type === 'channel.updated'), 'her channel event');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const delivered = stream.events.filter((event) => event.type === 'channel.updated');
  assert.ok(delivered.length >= 1 && delivered.every((event) => event.data.channelId === deal.id), JSON.stringify(delivered));
  assert.ok(delivered.every((event) => !('actor' in event.data)), 'events name no member');
});

test('a guest token opens no member route, and member routes refuse it as a guest', async (t) => {
  const { deal, gina, send } = await withGuests(t);
  const memberRoutes = [
    ['GET', '/api/projects'],
    ['GET', `/api/projects/${ENG}`],
    ['GET', `/api/projects/${ENG}/channels`],
    ['GET', `/api/projects/${ENG}/channels/${deal.id}/posts`],
    ['POST', `/api/projects/${ENG}/channels/${deal.id}/posts`, { body: 'x' }],
    ['GET', `/api/projects/${ENG}/channels/${deal.id}/guests`],
    ['POST', `/api/projects/${ENG}/channels/${deal.id}/guests`, OTTO],
    ['GET', `/api/projects/${ENG}/files?targetType=channel&targetId=${deal.id}`],
    ['POST', `/api/projects/${ENG}/uploads`, { contentType: 'text/plain', fileName: 'x.txt', fileSize: 3, targetId: deal.id, targetType: 'channel' }],
    ['GET', `/api/projects/${ENG}/events`],
    ['GET', `/api/projects/${ENG}/insights`],
    ['GET', `/api/projects/${ENG}/requirements`],
    ['GET', '/api/engagements'],
    ['GET', '/api/home'],
    ['GET', '/api/reporting/search?q=pricing'],
    ['GET', '/api/assistant/chats'],
    ['POST', '/api/assistant/chats', {}],
    ['GET', '/api/workspace/events'],
    ['GET', '/api/workspace/modules'],
    ['GET', '/api/users/me'],
    ['GET', '/api/auth/me'],
    ['GET', '/api/tenants'],
    ['GET', '/api/portfolio'],
  ];
  for (const [method, route, body] of memberRoutes) {
    const response = await send(gina, method, route, body);
    assert.ok([401, 403, 404].includes(response.status), `${method} ${route} answered ${response.status}`);
    assert.ok(response.status < 200 || response.status >= 300);
  }
  const named = await send(gina, 'GET', '/api/projects');
  assert.deepEqual([named.status, named.body.details.code], [403, 'guest_not_allowed']);
  // And a member's token opens no guest route.
  const member = await send('member', 'GET', '/api/guest/engagements');
  assert.deepEqual([member.status, member.body.details.code], [401, 'guest_sign_in_required']);
});

test('removed from their only channel, the guest is refused on the next request, their stream closes and their sessions end', async (t) => {
  const { audit, deal, gina, guestSessionsRepository, invite, ok, openStream, P, send, signIn, waitFor } = await withGuests(t);
  const stakeholderId = (await ok('lead', 'GET', `${P(ENG)}/channels/${deal.id}/guests`)).guests[0].stakeholderId;
  const stream = await openStream(gina.guest);
  await waitFor(() => stream.events.some((event) => event.type === 'connected'), 'connected');
  const memberTry = await send('member', 'DELETE', `${P(ENG)}/channels/${deal.id}/guests/${stakeholderId}`);
  assert.equal(memberTry.status, 403, 'removing needs decision rights');

  const removed = await ok('lead', 'DELETE', `${P(ENG)}/channels/${deal.id}/guests/${stakeholderId}`);
  assert.deepEqual([removed.removed, removed.accessEnded], [true, true]);
  await waitFor(() => stream.closed, 'the stream to close');
  const next = await send(gina, 'GET', `/api/guest/channels/${deal.id}`);
  assert.equal(next.status, 401);
  assert.ok(guestSessionsRepository.state.sessions.every((session) => session.revokedAt), 'every session is revoked');
  assert.ok(audit.some((entry) => entry.action === 'guest.remove' && entry.detail.accessEnded === true));
  assert.deepEqual((await ok('lead', 'GET', `${P(ENG)}/channels/${deal.id}/guests`)).guests, []);
  // Invited again, they sign in afresh.
  await invite(ENG, deal.id, GINA);
  const back = await signIn(GINA.email);
  assert.equal((await send({ guest: back.token }, 'GET', `/api/guest/channels/${deal.id}`)).status, 200);
});

test('removed from one of two channels: that channel is refused on the next request and its events stop; the other goes on', async (t) => {
  const { channel, gina, invite, ok, openStream, P, send, waitFor } = await withGuests(t);
  const deal = await channel(ENG, 'Deal room');
  const second = await channel(ENG, 'Pricing');
  await invite(ENG, second.id, { email: GINA.email });
  const stream = await openStream(gina.guest);
  await waitFor(() => stream.events.some((event) => event.type === 'connected'), 'connected');
  const stakeholderId = (await ok('lead', 'GET', `${P(ENG)}/channels/${deal.id}/guests`)).guests[0].stakeholderId;
  const removed = await ok('lead', 'DELETE', `${P(ENG)}/channels/${second.id}/guests/${stakeholderId}`);
  assert.equal(removed.accessEnded, false);
  assert.equal((await send(gina, 'GET', `/api/guest/channels/${second.id}`)).status, 404);
  assert.equal((await send(gina, 'GET', `/api/guest/channels/${deal.id}`)).status, 200);
  await waitFor(() => stream.events.some((event) => event.type === 'guest.changed'), 'the guest.changed event');
  const before = stream.events.length;
  await ok('member', 'POST', `${P(ENG)}/channels/${second.id}/posts`, { body: 'After removal' }, 201);
  await ok('member', 'POST', `${P(ENG)}/channels/${deal.id}/posts`, { body: 'Still here' }, 201);
  await waitFor(() => stream.events.slice(before).some((event) => event.type === 'channel.updated'), 'an event');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(stream.events.slice(before).filter((event) => event.type === 'channel.updated').every((event) => event.data.channelId === deal.id));
  assert.equal(stream.closed, false);
});

test('the Consulting module: off, guests reach no engagement channel and stakeholder links on engagements stop; on, both come back', async (t) => {
  const { contoso, deal, gina, invite, ok, send, signIn, workspaceModulesRepository } = await withGuests(t);
  // Gina is also a guest on the delivery project.
  await invite(DEL, contoso.id, GINA);
  const switchModule = async (enabled) => {
    const current = await workspaceModulesRepository.getModule({ moduleKey: 'consulting', tenantId: TENANT_ID });
    await workspaceModulesRepository.setModule({ enabled, expectedVersion: current.version, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
  };
  const otto = await signIn(OTTO.email);
  await switchModule(false);
  const listed = await ok(gina, 'GET', '/api/guest/engagements');
  assert.deepEqual(listed.projects.map((project) => project.id), [DEL], 'the engagement drops out');
  assert.equal((await send(gina, 'GET', `/api/guest/channels/${deal.id}`)).status, 404);
  assert.equal((await send(gina, 'GET', `/api/guest/channels/${deal.id}/posts`)).status, 404);
  assert.equal((await send(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: 'x' })).status, 404);
  assert.equal((await send(gina, 'GET', `/api/guest/channels/${contoso.id}`)).status, 200, 'delivery projects are not part of the module');

  // A guest only on engagements is refused, and the session is kept for when the module returns.
  const ottoToken = otto.token;
  const refused = await send({ guest: ottoToken }, 'GET', '/api/guest/engagements');
  assert.deepEqual([refused.status, refused.body.details.code], [401, 'guest_access_ended']);
  assert.equal((await send(null, 'POST', '/api/guest/sign-in/code', { email: OTTO.email })).status, 200, 'the same answer as anyone');
  await switchModule(true);
  assert.equal((await send({ guest: ottoToken }, 'GET', '/api/guest/engagements')).status, 200);
  assert.deepEqual((await ok(gina, 'GET', '/api/guest/engagements')).projects.map((project) => project.id).sort(), [DEL, ENG].sort());
});

test('carried note: public stakeholder links on an engagement check the Consulting module; delivery projects are unaffected', async (t) => {
  const f = await fixture(t);
  const linkFor = async (projectId) => {
    const stakeholder = await f.assistantRepository.createProjectStakeholder({ projectId, tenantId: TENANT_ID, value: { email: `${projectId}@client.example`, name: `Stake ${projectId}` } });
    const issued = await f.ok('lead', 'POST', `/api/projects/${projectId}/requirements/links`, { send: false, stakeholderId: stakeholder.id }, 201);
    return issued.token;
  };
  const engToken = await linkFor(ENG);
  const delToken = await linkFor(DEL);
  assert.ok(engToken && delToken, 'links were issued');
  const switchModule = async (enabled) => {
    const current = await f.workspaceModulesRepository.getModule({ moduleKey: 'consulting', tenantId: TENANT_ID });
    await f.workspaceModulesRepository.setModule({ enabled, expectedVersion: current.version, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
  };
  const portal = (token, suffix = '') => f.send(null, 'GET', `/api/public/requirements/${token}${suffix}`);
  assert.equal((await portal(engToken)).status, 200, 'module on: the engagement link works');
  assert.equal((await portal(engToken, '/documents')).status, 200, 'and its shared documents (signing portal)');
  await switchModule(false);
  for (const suffix of ['', '/documents', '/rounds']) {
    assert.equal((await portal(engToken, suffix)).status, 404, `module off: ${suffix || 'the portal'} answers as missing`);
  }
  assert.equal((await portal(delToken)).status, 200, 'delivery projects are unaffected');
  await switchModule(true);
  assert.equal((await portal(engToken)).status, 200, 'switched back on, the link works again');
});

test('conversion keeps every guest as a stakeholder, refuses if a guest lost their record, and guests keep their channels after it', async (t) => {
  const { assistantRepository, deal, gina, ok, projectRepository, send } = await withGuests(t);
  // A guest whose stakeholder record vanished would be lost: the conversion refuses.
  const stakeholders = assistantRepository.state?.projectStakeholders ?? null;
  if (stakeholders) {
    const removedRecord = stakeholders.splice(stakeholders.findIndex((entry) => entry.email === OTTO.email), 1)[0];
    const refused = await send('lead', 'POST', `/api/projects/${ENG}/convert`, {});
    assert.deepEqual([refused.status, refused.body.details.code], [409, 'guest_stakeholder_missing']);
    assert.equal((await projectRepository.getProjectKind({ projectId: ENG })).kind, 'engagement', 'nothing changed');
    stakeholders.push(removedRecord);
  }
  assert.equal(await addEngagementGuestsAsStakeholders({ assistantRepository, projectId: ENG, projectRepository, tenantId: TENANT_ID }), 2);
  const converted = await ok('lead', 'POST', `/api/projects/${ENG}/convert`, {});
  assert.equal(converted.project.kind, 'delivery');
  const after = await assistantRepository.listProjectStakeholders({ projectId: ENG, tenantId: TENANT_ID });
  assert.deepEqual(after.map((entry) => entry.email).sort(), [GINA.email, OTTO.email].sort());
  const listed = await ok(gina, 'GET', '/api/guest/engagements');
  assert.deepEqual(listed.projects.map((project) => [project.id, project.kind]), [[ENG, 'delivery']]);
  assert.equal((await send(gina, 'GET', `/api/guest/channels/${deal.id}/posts`)).status, 200);
});

test('a lost engagement is read-only for guests, and a guest can still be removed from it', async (t) => {
  const { deal, gina, ok, P, send } = await withGuests(t);
  await ok('lead', 'POST', `/api/projects/${ENG}/close`, {});
  const opened = await ok(gina, 'GET', `/api/guest/channels/${deal.id}`);
  assert.equal(opened.channel.canPost, false);
  assert.equal((await send(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: 'x' })).status, 403);
  assert.equal((await send(gina, 'POST', '/api/guest/uploads', { contentType: 'text/plain', fileName: 'x.txt', fileSize: 3, targetId: deal.id, targetType: 'channel' })).status, 403);
  const stakeholderId = (await ok('lead', 'GET', `${P(ENG)}/channels/${deal.id}/guests`)).guests[0].stakeholderId;
  assert.equal((await send('lead', 'POST', `${P(ENG)}/channels/${deal.id}/guests`, OTTO)).status, 403, 'no new guests while lost');
  assert.equal((await ok('lead', 'DELETE', `${P(ENG)}/channels/${deal.id}/guests/${stakeholderId}`)).removed, true);
});

test('guest tasks come from the task source the pursuit board supplies; without one there are none', async (t) => {
  const { gina, ok, send } = await withGuests(t, { guestTaskSource: NO_GUEST_TASKS });
  const none = await ok(gina, 'GET', `/api/guest/projects/${ENG}/tasks`);
  assert.deepEqual([none.available, none.tasks], [false, []]);
  assert.equal((await send(gina, 'PATCH', `/api/guest/projects/${ENG}/tasks/task-1`, { status: 'Done' })).status, 404);
  assert.equal((await send(gina, 'GET', `/api/guest/projects/${ENG}/tasks/task-1/comments`)).status, 404);
});

// Pursuit tasks for Gina and Otto, and one for a member, on the engagement's board.
async function withPursuitTasks(t) {
  const f = await withGuests(t);
  const { ok, P } = f;
  const { storyId } = await ok('lead', 'GET', `${P(ENG)}/pursuit`);
  const guests = async (channelId) => (await ok('lead', 'GET', `${P(ENG)}/channels/${channelId}/guests`)).guests;
  const ginaId = (await guests(f.deal.id)).find((entry) => entry.email === GINA.email).stakeholderId;
  const ottoId = (await guests(f.internal.id)).find((entry) => entry.email === OTTO.email).stakeholderId;
  const add = async (name, assigneeId) => (await ok('lead', 'POST', `${P(ENG)}/items`, { item: { assigneeId, name, status: 'Not Started', targetEndDate: '2026-11-20' }, itemType: 'task', parentId: storyId }, 201)).item;
  const tasks = {
    gina: await add('Send network diagrams', `stakeholder:${ginaId}`),
    member: await add('Draft the proposal', USERS.member.id),
    otto: await add('Confirm licences', `stakeholder:${ottoId}`),
  };
  async function guestsSeeBoard(on) {
    const { settings } = await ok('lead', 'GET', `${P(ENG)}/settings`);
    await ok('lead', 'PUT', `${P(ENG)}/settings`, { expectedVersion: settings.version, guestsSeeBoard: on });
  }
  return { ...f, ginaId, guestsSeeBoard, ottoId, tasks };
}

test('guest tasks, setting off: a guest sees only the pursuit tasks assigned to them and changes their status, comments and attaches files', async (t) => {
  const { absoluteUrl, audit, gina, ok, P, scanAll, send, tasks, upload } = await withPursuitTasks(t);
  const T = (taskId, rest = '') => `/api/guest/projects/${ENG}/tasks/${taskId}${rest}`;

  const listed = await ok(gina, 'GET', `/api/guest/projects/${ENG}/tasks`);
  assert.equal(listed.available, true);
  assert.equal(listed.wholeBoard, false);
  assert.deepEqual(listed.tasks.map((task) => [task.name, task.assignedToMe, task.canUpdate, task.canComment, task.canAttach, task.dueDate]), [['Send network diagrams', true, true, true, true, '2026-11-20']]);
  assert.ok(listed.statuses.includes('In Progress'));

  const updated = await ok(gina, 'PATCH', T(tasks.gina.id), { status: 'In Progress' });
  assert.equal(updated.task.status, 'In Progress');
  assert.equal((await send(gina, 'PATCH', T(tasks.gina.id), { status: 'Shipped' })).status, 400, 'only statuses on the board');

  // Members see the change, and the guests' names on their tasks, on the board and in the drawer.
  const board = await ok('member', 'GET', `${P(ENG)}/pursuit`);
  const boardTasks = board.project.epics.flatMap((epic) => epic.stories.flatMap((story) => story.tasks));
  assert.deepEqual(boardTasks.map((task) => [task.name, task.assigneeName, task.status]).sort(), [
    ['Confirm licences', OTTO.name, 'Not Started'],
    ['Draft the proposal', USERS.member.name, 'Not Started'],
    ['Send network diagrams', GINA.name, 'In Progress'],
  ]);
  assert.deepEqual(board.outsideAssignees.map((person) => [person.name, person.guest]).sort(), [[GINA.name, true], [OTTO.name, true]]);

  await ok(gina, 'POST', T(tasks.gina.id, '/comments'), { text: 'Sent the **v2** diagrams.' }, 201);
  const comments = await ok(gina, 'GET', T(tasks.gina.id, '/comments'));
  assert.equal(comments.canComment, true);
  assert.deepEqual(comments.comments.map((comment) => [comment.authorName, comment.mine]), [[GINA.name, true]]);
  assert.match(comments.comments[0].html, /<strong>v2<\/strong>/);

  const attached = await upload(gina, '/api/guest', 'diagram bytes', { fileName: 'diagram.txt', targetId: tasks.gina.id, targetType: 'task' });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  assert.ok(audit.some((entry) => entry.action === 'guest.upload' && entry.detail.taskId === tasks.gina.id));
  await scanAll();
  const files = await ok(gina, 'GET', T(tasks.gina.id, '/files'));
  assert.deepEqual([files.canWrite, files.files.map((file) => file.fileName)], [true, ['diagram.txt']]);
  const link = await ok(gina, 'GET', `/api/guest/files/${files.files[0].id}/download-url`);
  assert.equal(await (await fetch(absoluteUrl(link.url))).text(), 'diagram bytes');
  const memberFiles = (await ok('member', 'GET', `${P(ENG)}/files?targetType=task&targetId=${tasks.gina.id}`)).files;
  assert.deepEqual(memberFiles.map((file) => [file.fileName, file.uploadedBy.name]), [['diagram.txt', GINA.name]]);

  // Everyone else's tasks are not there for her: not listed, not changeable, no comments, no files.
  for (const other of [tasks.otto, tasks.member]) {
    assert.equal((await send(gina, 'PATCH', T(other.id), { status: 'Completed' })).status, 404);
    assert.equal((await send(gina, 'GET', T(other.id, '/comments'))).status, 404);
    assert.equal((await send(gina, 'POST', T(other.id, '/comments'), { text: 'hi' })).status, 404);
    assert.equal((await send(gina, 'GET', T(other.id, '/files'))).status, 404);
    assert.equal((await send(gina, 'POST', '/api/guest/uploads', { contentType: 'text/plain', fileName: 'x.txt', fileSize: 3, targetId: other.id, targetType: 'task' })).status, 404);
  }
  // A file a member attached to Otto's task does not download for her.
  const memberUpload = await upload('lead', P(ENG), 'internal notes', { fileName: 'notes.txt', targetId: tasks.otto.id, targetType: 'task' });
  assert.equal(memberUpload.status, 201, JSON.stringify(memberUpload.body));
  await scanAll();
  assert.equal((await send(gina, 'GET', `/api/guest/files/${memberUpload.body.file.id}/download-url`)).status, 404);
  assert.equal((await send(gina, 'GET', `/api/guest/files/${memberUpload.body.file.id}/versions`)).status, 404, 'task files take no versions or comments from guests');
});

test('guest tasks, "Guests see the whole board" on: every pursuit task shows, and the guest still changes only their own', async (t) => {
  const { absoluteUrl, gina, guestsSeeBoard, ok, P, scanAll, send, tasks, upload } = await withPursuitTasks(t);
  const T = (taskId, rest = '') => `/api/guest/projects/${ENG}/tasks/${taskId}${rest}`;
  const memberUpload = await upload('lead', P(ENG), 'pricing', { fileName: 'pricing.txt', targetId: tasks.member.id, targetType: 'task' });
  assert.equal(memberUpload.status, 201, JSON.stringify(memberUpload.body));
  await scanAll();
  await guestsSeeBoard(true);

  const listed = await ok(gina, 'GET', `/api/guest/projects/${ENG}/tasks`);
  assert.equal(listed.wholeBoard, true);
  assert.deepEqual(listed.tasks.map((task) => [task.name, task.assignedToMe, task.canUpdate, task.assigneeName]).sort(), [
    ['Confirm licences', false, false, OTTO.name],
    ['Draft the proposal', false, false, USERS.member.name],
    ['Send network diagrams', true, true, ''],
  ]);
  await ok(gina, 'PATCH', T(tasks.gina.id), { status: 'Review' });
  for (const other of [tasks.otto, tasks.member]) {
    const refused = await send(gina, 'PATCH', T(other.id), { status: 'Completed' });
    assert.deepEqual([refused.status, refused.body.details?.code], [403, 'not_your_task']);
    assert.equal((await send(gina, 'POST', T(other.id, '/comments'), { text: 'hi' })).status, 403);
    assert.equal((await send(gina, 'POST', '/api/guest/uploads', { contentType: 'text/plain', fileName: 'x.txt', fileSize: 3, targetId: other.id, targetType: 'task' })).status, 403);
    assert.equal((await ok(gina, 'GET', T(other.id, '/comments'))).canComment, false, 'she reads their comments but cannot add one');
    assert.equal((await ok(gina, 'GET', T(other.id, '/files'))).canWrite, false);
  }
  // She can read files on tasks she sees.
  const link = await ok(gina, 'GET', `/api/guest/files/${memberUpload.body.file.id}/download-url`);
  assert.equal(await (await fetch(absoluteUrl(link.url))).text(), 'pricing');
  const statuses = (await ok('member', 'GET', `${P(ENG)}/pursuit`)).project.epics.flatMap((epic) => epic.stories.flatMap((story) => story.tasks)).map((task) => [task.name, task.status]).sort();
  assert.deepEqual(statuses, [['Confirm licences', 'Not Started'], ['Draft the proposal', 'Not Started'], ['Send network diagrams', 'Review']]);

  // Off again: back to her own task only.
  await guestsSeeBoard(false);
  assert.deepEqual((await ok(gina, 'GET', `/api/guest/projects/${ENG}/tasks`)).tasks.map((task) => task.name), ['Send network diagrams']);
  assert.equal((await send(gina, 'GET', `/api/guest/files/${memberUpload.body.file.id}/download-url`)).status, 404);
});

test('guest tasks: on a lost engagement, with the module off, or removed from the engagement, the guest changes no task', async (t) => {
  const { deal, gina, ginaId, ok, P, send, tasks, workspaceModulesRepository } = await withPursuitTasks(t);
  const T = (taskId, rest = '') => `/api/guest/projects/${ENG}/tasks/${taskId}${rest}`;
  await ok('lead', 'POST', `${P(ENG)}/close`, {});
  assert.equal((await send(gina, 'PATCH', T(tasks.gina.id), { status: 'In Progress' })).status, 403, 'a lost engagement is read-only');
  assert.equal((await send(gina, 'POST', T(tasks.gina.id, '/comments'), { text: 'hi' })).status, 403);
  assert.equal((await ok(gina, 'GET', T(tasks.gina.id, '/comments'))).canComment, false);
  await ok('lead', 'POST', `${P(ENG)}/reopen`, {});

  const module = (await workspaceModulesRepository.listModules({ tenantId: TENANT_ID })).find((entry) => entry.moduleKey === 'consulting');
  await workspaceModulesRepository.setModule({ enabled: false, expectedVersion: module.version, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
  assert.equal((await send(gina, 'GET', `/api/guest/projects/${ENG}/tasks`)).status, 401, 'module off: her only engagement is hidden, so she reaches nothing');
  await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: module.version + 1, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });

  await ok('lead', 'DELETE', `${P(ENG)}/channels/${deal.id}/guests/${ginaId}`);
  assert.equal((await send(gina, 'GET', `/api/guest/projects/${ENG}/tasks`)).status, 401, 'removed from her only channel, her session ended');
});

test('a guest who tags @odin in their channel gets a reply record as their stakeholder; with the channel’s setting off, @odin is plain text', async (t) => {
  const { deal, gina, ok, P, projectRepository } = await withGuests(t);
  const stakeholderId = (await ok('lead', 'GET', `${P(ENG)}/channels/${deal.id}/guests`)).guests.find((guest) => guest.email === GINA.email).stakeholderId;
  const mentionables = await ok(gina, 'GET', `/api/guest/channels/${deal.id}/mentionables`);
  assert.equal(mentionables.people[0].kind, 'odin', 'Odin is first in the guest’s picker');

  const tagged = await ok(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: '@odin what is the timeline?' }, 201);
  const [reply] = await projectRepository.listOdinReplies({ postIds: [tagged.post.id], tenantId: TENANT_ID });
  assert.deepEqual([reply?.requesterType, reply?.requesterId, reply?.chatId], ['stakeholder', stakeholderId, null], 'one record, as the guest’s stakeholder, with no member chat');

  await ok('lead', 'PATCH', `${P(ENG)}/channels/${deal.id}`, { odinEnabled: false });
  assert.equal((await ok(gina, 'GET', `/api/guest/channels/${deal.id}/mentionables`)).people.some((person) => person.kind === 'odin'), false, 'not in the guest’s picker either');
  const plain = await ok(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: '@odin are you there?' }, 201);
  assert.deepEqual(await projectRepository.listOdinReplies({ postIds: [plain.post.id], tenantId: TENANT_ID }), []);
  assert.equal(tagsOdin(plain.post.body), false, 'the text keeps no Odin tag');
});

test('a guest in two engagements has one bell, one stream and one rolled-up email across both; opening a channel reads its notifications', async (t) => {
  const { accessRepository, app, assistantRepository, deal, gina, mailRepository, ok, openStream, P, projectRepository, send, waitFor, workspaceModulesRepository } = await withGuests(t);
  const phase2 = (await ok('lead', 'POST', `${P(ENG2)}/channels`, { name: 'Phase 2' }, 201)).channel;
  await ok('lead', 'POST', `${P(ENG2)}/channels/${phase2.id}/guests`, GINA, 201);
  const stakeholderIn = async (projectId, channelId) => (await ok('lead', 'GET', `${P(projectId)}/channels/${channelId}/guests`)).guests.find((guest) => guest.email === GINA.email).stakeholderId;
  const [first, second] = [await stakeholderIn(ENG, deal.id), await stakeholderIn(ENG2, phase2.id)];
  assert.notEqual(first, second, 'a stakeholder record per engagement');
  const tag = (stakeholderId) => `@[${GINA.name}](stakeholder:${stakeholderId})`;

  const stream = await openStream(gina.guest);
  const one = (await ok('member', 'POST', `${P(ENG)}/channels/${deal.id}/posts`, { body: `${tag(first)} the pricing deck` }, 201)).post;
  const two = (await ok('member', 'POST', `${P(ENG2)}/channels/${phase2.id}/posts`, { body: `${tag(second)} the phase 2 scope` }, 201)).post;
  await waitFor(() => stream.events.filter((event) => event.type === 'notification.created').length === 2, 'both notifications on the one guest stream');
  assert.ok(stream.events.filter((event) => event.type === 'notification.created').every((event) => Object.keys(event.data).join() === 'id'), 'ids only');

  const bell = await ok(gina, 'GET', '/api/guest/me/notifications');
  assert.equal(bell.unreadCount, 2);
  assert.deepEqual(bell.notifications.map((entry) => [entry.projectName, entry.path]).sort(), [
    ['Northwind phase 2', `/guest/channels/${phase2.id}?post=${two.id}`],
    ['Northwind pursuit', `/guest/channels/${deal.id}?post=${one.id}`],
  ]);

  // The rolled-up email: one, to Gina, with both items and guest-view links.
  const sent = [];
  const flush = () => flushDueChatDigests({
    env: { mailFromAddress: 'noreply@odin.example', mailFromName: 'Odin' },
    frontendAppUrl: 'https://app.example/app',
    guestDirectory: createGuestNotificationDirectory({ accessRepository, assistantRepository, projectRepository, workspaceModulesRepository }),
    mailRepository,
    notificationsRepository: app.locals.notificationsRepository,
    now: () => new Date(Date.now() + 45 * 60_000),
    projectRepository,
    transport: { async sendMail(message) { sent.push(message); return { messageId: `m-${sent.length}` }; } },
  });
  const summary = await flush();
  assert.equal(summary.sent, 1, JSON.stringify(summary));
  assert.deepEqual(sent.map((message) => message.to), [GINA.email]);
  const links = [...sent[0].html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll('&amp;', '&'));
  assert.deepEqual(links.sort(), [`https://app.example/app/guest/channels/${deal.id}?post=${one.id}`, `https://app.example/app/guest/channels/${phase2.id}?post=${two.id}`].sort());
  assert.match(sent[0].html, /Northwind pursuit/);
  assert.match(sent[0].html, /Northwind phase 2/);
  assert.equal((await flush()).sent, 0, 'sent once');

  // Opening one channel reads that engagement's notification only.
  await ok(gina, 'POST', `/api/guest/channels/${phase2.id}/read`, {});
  await waitFor(() => stream.events.some((event) => event.type === 'notification.read'), 'the read reaches the stream');
  const after = await ok(gina, 'GET', '/api/guest/me/notifications');
  assert.deepEqual([after.unreadCount, after.notifications.filter((entry) => !entry.readAt).map((entry) => entry.projectName)], [1, ['Northwind pursuit']]);
  await ok(gina, 'POST', '/api/guest/me/notifications/read', { all: true });
  assert.equal((await ok(gina, 'GET', '/api/guest/me/notifications')).unreadCount, 0);

  // Otto was tagged nowhere: nothing for him. Members' bells are their own routes.
  const otto = await accessRepository.findLinkByEmail({ email: OTTO.email, tenantId: TENANT_ID });
  assert.deepEqual(await app.locals.notificationsRepository.listNotifications({ principalId: String(otto.id), principalType: 'guest', tenantId: TENANT_ID }), []);
  assert.equal((await send('member', 'GET', '/api/guest/me/notifications')).status, 401, 'a member token is no guest session');
});

test('guests react and answer replies in their channels only', async (t) => {
  const { deal, gina, internal, ok, P: path, send } = await withGuests(t);
  const C = `${path(ENG)}/channels/${deal.id}`;
  const root = (await ok('lead', 'POST', `${C}/posts`, { body: 'Proposal is in the library' }, 201)).post;
  const reply = (await ok('lead', 'POST', `${C}/posts`, { body: 'Pricing is on page 4', parentId: root.id }, 201)).post;
  const reacted = await ok(gina, 'PUT', `/api/guest/posts/${root.id}/reactions`, { emoji: '👀', reacted: true });
  assert.deepEqual(reacted.reactions.map(({ emoji, mine, people }) => [emoji, mine, people.map((person) => person.type)]), [['👀', true, ['stakeholder']]]);
  assert.equal(reacted.ctx, undefined, 'the guest context is not sent');
  const answered = (await ok(gina, 'POST', `/api/guest/channels/${deal.id}/posts`, { body: 'Thanks, reading it', parentId: root.id, replyToId: reply.id }, 201)).post;
  assert.equal(answered.replyToId, reply.id);
  // Members see Gina's reaction under her name.
  const seen = (await ok('lead', 'GET', `${C}/posts`)).posts[0].reactions[0];
  assert.deepEqual([seen.emoji, seen.people[0].name, seen.mine], ['👀', GINA.name, false]);
  // A post in a channel she is not in is not there for her.
  const hidden = (await ok('lead', 'POST', `${path(ENG)}/channels/${internal.id}/posts`, { body: 'Internal only' }, 201)).post;
  assert.equal((await send(gina, 'PUT', `/api/guest/posts/${hidden.id}/reactions`, { emoji: '👀', reacted: true })).status, 404);
});

test('typing reaches a guest only for their own channels, names the typer, and never echoes the guest’s own', async (t) => {
  const { deal, gina, internal, liveEventBus, ok, openStream, P: path, send, waitFor } = await withGuests(t);
  const typing = [];
  liveEventBus.subscribe(`project:${ENG}`, (event) => { if (event.type === 'channel.typing') typing.push(event); });
  const stream = await openStream(gina.guest);
  await waitFor(() => stream.events.some((event) => event.type === 'connected'), 'connected');
  const guestTyping = () => stream.events.filter((event) => event.type === 'channel.typing');

  // A member types in Internal (not hers), then in her Deal room.
  await ok('member', 'POST', `${path(ENG)}/channels/${internal.id}/typing`, { typing: true });
  await ok('member', 'POST', `${path(ENG)}/channels/${deal.id}/typing`, { typing: true });
  await waitFor(() => guestTyping().length >= 1, 'typing in her channel');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(guestTyping().map((event) => [event.data.channelId, event.data.actor.name, event.data.typing]), [[deal.id, 'Mo Member', true]]);

  // Gina types in her channel: members hear it under her name; her own stream does not.
  const before = guestTyping().length;
  assert.deepEqual(await ok(gina, 'POST', `/api/guest/channels/${deal.id}/typing`, { typing: true }), { ok: true });
  const hers = typing.at(-1);
  assert.deepEqual([hers.channelId, hers.actor.name, hers.actor.type, hers.parentId], [deal.id, GINA.name, 'stakeholder', null]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(guestTyping().length, before, 'never her own typing');

  // Not in a channel she is not in, and not with text.
  const count = typing.length;
  assert.equal((await send(gina, 'POST', `/api/guest/channels/${internal.id}/typing`, { typing: true })).status, 404);
  assert.equal((await send(gina, 'POST', `/api/guest/channels/${deal.id}/typing`, { body: 'x', typing: true })).status, 400);
  assert.equal(typing.length, count);
});
