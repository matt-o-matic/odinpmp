import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import httpEce from 'http_ece';
import webpush from 'web-push';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { CHAT_DIGEST_RELEASE_REASONS, flushDueChatDigests } from '../src/modules/notifications/chat-digest.service.js';
import { createChannelGuestDirectory } from '../src/modules/notifications/guest-directory.js';
import { createPrincipalNotificationsRouter } from '../src/modules/notifications/notifications.routes.js';
import { generateVapidKeys, isPushServiceEndpoint } from '../src/modules/notifications/web-push.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryUsersRepository } from '../src/modules/users/users.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// Notifications: levels and their defaults, records and collapsing, reading, the per-person
// stream with its focus heartbeat, Web Push against a fake push service, the rolled-up email on
// a fake clock, guests through the principal router, assignment and Odin reply notifications,
// and retention.
// notifications-mysql.integration.test.js runs migration 0102 and the MySQL repository.

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const P = `/api/projects/${PROJECT}`;
// Work items live in delivery projects; engagements keep theirs on the pursuit board.
const DELIVERY = 'project-2';
const APP = 'https://app.example/app';
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', projectRole: 'admin', role: 'user' },
  manager: { id: 'user-manager', name: 'Max Manager', projectRole: 'manager', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', projectRole: 'user', role: 'user' },
  other: { id: 'user-other', name: 'Olu Other', projectRole: 'user', role: 'user' },
  owner: { id: 'user-owner', name: 'Oona Owner', projectRole: 'user', role: 'user' },
  outsider: { id: 'user-outsider', name: 'Oz Outsider', projectRole: null, role: 'user' },
};
const GUEST = { email: 'sam@customer.example', id: 'stk-sam', name: 'Sam Customer' };
const mention = (key) => `@[${USERS[key].name}](user:${USERS[key].id})`;
const MINUTE = 60_000;

/** A clock the notifications and the digest read; tests move it forward. */
function fakeClock(start = '2026-11-14T10:00:00.000Z') {
  let at = new Date(start).getTime();
  const clock = () => new Date(at);
  clock.advance = (ms) => { at += ms; };
  return clock;
}

// `guestDirectory(projectRepository)` replaces the app's guest directory (the guests module's,
// which keys guests by access link; guests.test.js covers it).
async function fixture(t, { guestDirectory = null, webPush = null, webPushSend = null } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const mailRepository = createInMemoryMailRepository();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog: createInMemoryProjectChangeLog(),
    mailRepository,
    seed: {
      projectMemberships: Object.fromEntries([PROJECT, DELIVERY].map((projectId) => [projectId, Object.values(USERS).filter((user) => user.projectRole).map((user) => ({ email: `${user.id}@acme.example`, id: user.id, name: user.name, role: user.projectRole }))])),
      // Oona owns the engagement but has an ordinary role: the owner still hears everything.
      projects: [
        { engagementOwnerId: USERS.owner.id, engagementStatus: 'open', epics: [], id: PROJECT, kind: 'engagement', name: 'Northwind pursuit', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: DELIVERY, name: 'Northwind rollout', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.lead.id });
  const clock = fakeClock();
  const liveEventBus = createLiveEventBus();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'notifications-fixture', secret: 'disposable-notifications-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: APP, reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), liveEventBus, mailRepository, notificationsClock: clock, projectRepository, sessionsRepository, tokenService,
    usersRepository: createInMemoryUsersRepository({ authRepository }), workspaceModulesRepository,
    // The fake push service listens on loopback; real ones are checked by isPushServiceEndpoint.
    pushEndpointAllowed: (endpoint) => endpoint.startsWith('http://127.0.0.1:'),
    pushRetryDelaysMs: [0, 0],
    ...(webPush ? { webPush } : {}),
    ...(webPushSend ? { webPushSend } : {}),
    ...(guestDirectory ? { notificationGuestDirectory: guestDirectory(projectRepository) } : {}),
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
  async function send(as, method, route, body) {
    const response = await fetch(`${origin}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await send(as, method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const general = async (as = 'member') => (await ok(as, 'GET', `${P}/channels`)).channels.find((channel) => channel.isGeneral);
  // Each post a millisecond later on the notifications' clock, so newest-first is well defined.
  const post = async (as, channelId, body, extra = {}) => {
    clock.advance(1);
    return (await ok(as, 'POST', `${P}/channels/${channelId}/posts`, { body, ...extra }, 201)).post;
  };
  const bell = (as) => ok(as, 'GET', '/api/me/notifications');
  const kinds = async (as) => (await bell(as)).notifications.map((entry) => entry.kind);
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); return { messageId: `m-${sent.length}` }; } };
  const flush = () => flushDueChatDigests({
    authRepository, env: { mailFromAddress: 'noreply@odin.example', mailFromName: 'Odin' }, frontendAppUrl: APP, mailRepository,
    notificationsRepository: app.locals.notificationsRepository, now: clock, projectRepository, transport,
  });
  // Lets assignment observers and push sends that run after a response finish.
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await app.locals.pushSender.drain(); };
  return { app, authRepository, bell, clock, flush, general, kinds, liveEventBus, mailRepository, ok, origin, post, projectRepository, send, sent, settle, tokens, transport };
}

// --- levels and records ------------------------------------------------------------------------

test('the owner, admins and managers hear every post; others only mentions and replies; a level change applies at once', async (t) => {
  const { general, kinds, ok, post } = await fixture(t);
  const channel = await general();
  const levelOf = async (as) => (await ok(as, 'GET', `${P}/channels/${channel.id}/notification-level`));
  assert.deepEqual(await levelOf('lead'), { defaultLevel: 'all', isDefault: true, level: 'all', ok: true });
  assert.deepEqual(await levelOf('manager'), { defaultLevel: 'all', isDefault: true, level: 'all', ok: true });
  assert.deepEqual(await levelOf('owner'), { defaultLevel: 'all', isDefault: true, level: 'all', ok: true }, 'the engagement owner');
  assert.deepEqual(await levelOf('member'), { defaultLevel: 'mentions', isDefault: true, level: 'mentions', ok: true });
  assert.equal(channel.notificationLevel.level, 'mentions', 'the channel list carries the level too');

  const root = await post('other', channel.id, 'Kickoff notes are in the library');
  for (const key of ['lead', 'manager', 'owner']) assert.deepEqual(await kinds(key), ['channel_post'], key);
  assert.deepEqual(await kinds('member'), [], 'a plain post does not notify a member');
  assert.deepEqual(await kinds('other'), [], 'nor its author');

  await post('lead', channel.id, `${mention('member')} can you check the SOW?`);
  assert.deepEqual(await kinds('member'), ['mention']);
  await post('member', channel.id, 'Looking now', { parentId: root.id });
  assert.deepEqual(await kinds('other'), ['thread_reply'], 'a reply in the thread they started');
  await post('lead', channel.id, 'Thanks both', { parentId: root.id });
  assert.deepEqual(await kinds('member'), ['thread_reply', 'mention'], 'a reply in a thread they replied in');

  // Changing a level applies to the next post.
  assert.equal((await ok('member', 'PUT', `${P}/channels/${channel.id}/notification-level`, { level: 'all' })).level, 'all');
  await ok('lead', 'PUT', `${P}/channels/${channel.id}/notification-level`, { level: 'off' });
  await post('other', channel.id, 'Agenda for Friday');
  assert.equal((await kinds('member'))[0], 'channel_post', 'watching now');
  const leadBefore = (await kinds('lead')).length;
  await post('other', channel.id, `${mention('lead')} even a mention`);
  assert.equal((await kinds('lead')).length, leadBefore, 'off is off, mentions included');
  assert.deepEqual(await ok('lead', 'PUT', `${P}/channels/${channel.id}/notification-level`, { level: null }), { defaultLevel: 'all', isDefault: true, level: 'all', ok: true }, 'null goes back to the default');
});

test('the level route checks access, and settings list each channel in the person’s projects', async (t) => {
  const { general, ok, send } = await fixture(t);
  const channel = await general();
  assert.equal((await send('outsider', 'GET', `${P}/channels/${channel.id}/notification-level`)).status, 404);
  assert.equal((await send('member', 'PUT', `${P}/channels/${channel.id}/notification-level`, { level: 'loud' })).status, 400);
  assert.equal((await send('member', 'GET', `${P}/channels/missing/notification-level`)).status, 404);
  await ok('member', 'PUT', `${P}/channels/${channel.id}/notification-level`, { level: 'off' });
  const settings = await ok('member', 'GET', '/api/me/notification-levels');
  assert.deepEqual(settings.projects, [{ channels: [{ defaultLevel: 'mentions', id: channel.id, isDefault: false, level: 'off', name: 'General' }], id: PROJECT, kind: 'engagement', name: 'Northwind pursuit' }]);
  assert.deepEqual((await ok('outsider', 'GET', '/api/me/notification-levels')).projects, []);
});

test('five posts in a watched channel make one notification showing 5; opening the channel reads it; own posts never notify', async (t) => {
  const { bell, general, ok, post } = await fixture(t);
  const channel = await general();
  await post('lead', channel.id, 'My own post');
  for (const body of ['One', 'Two', 'Three', 'Four', 'Five']) await post('member', channel.id, body);
  let { notifications, unreadCount } = await bell('lead');
  assert.equal(unreadCount, 1);
  assert.equal(notifications.length, 1);
  assert.deepEqual([notifications[0].count, notifications[0].title, notifications[0].excerpt], [5, '5 new posts in #General', 'Mo Member: Five']);
  assert.equal(notifications[0].path, `/chat/channels/${PROJECT}/${channel.id}?post=${notifications[0].path.split('post=')[1]}`, 'members open it in Odin Chat');

  await ok('lead', 'POST', `${P}/channels/${channel.id}/read`);
  ({ notifications, unreadCount } = await bell('lead'));
  assert.equal(unreadCount, 0);
  assert.ok(notifications[0].readAt, 'opening the channel read it');

  await post('member', channel.id, 'Six');
  ({ notifications, unreadCount } = await bell('lead'));
  assert.deepEqual([unreadCount, notifications.length, notifications[0].count, notifications[0].title], [1, 2, 1, 'Mo Member posted in #General'], 'a new one after it was read');

  // Mark one read by id, then everything.
  await post('other', channel.id, `${mention('lead')} quick question`);
  const fresh = (await bell('lead')).notifications;
  assert.equal((await ok('lead', 'POST', '/api/me/notifications/read', { ids: [fresh[0].id] })).unreadCount, 1);
  assert.equal((await ok('lead', 'POST', '/api/me/notifications/read', { all: true })).unreadCount, 0);
  assert.equal((await ok('member', 'POST', '/api/me/notifications/read', { ids: [fresh[1].id] })).marked.length, 0, 'nobody reads someone else’s');

  // Posting in a channel reads its notifications for the writer too.
  await post('member', channel.id, 'Seven');
  assert.equal((await bell('lead')).unreadCount, 1);
  await post('lead', channel.id, 'Replying here');
  assert.equal((await bell('lead')).unreadCount, 0);
});

test('a new assignee is told, unless they assigned themselves; Odin’s reply tells the person it answers', async (t) => {
  const { app, bell, clock, general, kinds, ok, post, projectRepository, settle } = await fixture(t);
  const D = `/api/projects/${DELIVERY}`;
  const created = await ok('lead', 'POST', `${D}/items`, { item: { name: 'Draft the SOW' }, itemType: 'epic', parentId: null }, 201);
  const item = created.item;
  await ok('lead', 'PATCH', `${D}/items/${item.id}`, { expectedVersion: Number(item.version), patch: { assigneeId: USERS.member.id } });
  await settle();
  const [assigned] = (await bell('member')).notifications;
  assert.deepEqual([assigned.kind, assigned.title, assigned.excerpt, assigned.path, assigned.projectName], ['task_assigned', 'Lena Lead assigned you an epic', 'Draft the SOW', `/projects/${DELIVERY}?item=${item.id}`, 'Northwind rollout']);
  const self = await ok('manager', 'POST', `${D}/items`, { item: { assigneeId: USERS.manager.id, name: 'Mine' }, itemType: 'epic', parentId: null }, 201);
  await settle();
  assert.equal(self.item.assigneeId, USERS.manager.id);
  assert.deepEqual(await kinds('manager'), [], 'assigning yourself notifies nobody');

  // Odin posts arrive with author type odin once the @odin workstream merges.
  const channel = await general();
  const asked = await post('member', channel.id, '@odin what is left on the SOW?');
  // The stored post, as the @odin workstream reads it, not the presented one.
  const question = await projectRepository.getPost({ postId: asked.id, projectId: PROJECT, tenantId: TENANT_ID });
  clock.advance(1);
  await app.locals.notifications.notifyPost({ author: { id: 'odin', name: 'Odin', type: 'odin' }, channel, parent: question, people: [{ actorId: USERS.member.id, actorType: 'user', projectRole: 'user' }], post: { body: 'Two sections are left.', id: 'odin-post-1' }, projectId: PROJECT, tenantId: TENANT_ID });
  const [answer] = (await bell('member')).notifications;
  assert.deepEqual([answer.kind, answer.title, answer.excerpt], ['odin_reply', 'Odin replied to your post in #General', 'Two sections are left.']);
});

// --- live stream ----------------------------------------------------------------------------

async function openStream(origin, token, clientId = 'tab-1') {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/me/events?clientId=${clientId}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const reading = (async () => {
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
          events.push({ data, type });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (predicate, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No matching event in ${JSON.stringify(events)}`);
  };
  return { close: async () => { controller.abort(); await reading; }, events, waitFor };
}

test('the stream tells each of a person’s tabs of new and read notifications, with ids only, and nobody else', async (t) => {
  const { bell, general, ok, origin, post, tokens } = await fixture(t);
  const channel = await general();
  const first = await openStream(origin, tokens.member, 'tab-a');
  const second = await openStream(origin, tokens.member, 'tab-b');
  const outsider = await openStream(origin, tokens.other, 'tab-c');
  t.after(() => Promise.all([first.close(), second.close(), outsider.close()]));
  await first.waitFor((event) => event.type === 'connected');

  await post('lead', channel.id, `${mention('member')} secret pricing note`);
  const created = await first.waitFor((event) => event.type === 'notification.created');
  await second.waitFor((event) => event.type === 'notification.created');
  const [notification] = (await bell('member')).notifications;
  assert.deepEqual(created.data, { id: notification.id }, 'only the id, no text');
  assert.equal((await ok('member', 'GET', `/api/me/notifications/${notification.id}`)).notification.title, 'Lena Lead mentioned you in #General');
  assert.equal((await fetch(`${origin}/api/me/notifications/${notification.id}`, { headers: { Authorization: `Bearer ${tokens.other}` } })).status, 404);

  await ok('member', 'POST', '/api/me/notifications/read', { all: true });
  assert.deepEqual((await second.waitFor((event) => event.type === 'notification.read')).data, { all: true });
  assert.ok(!outsider.events.some((event) => event.type.startsWith('notification.')), 'another person hears nothing');
});

// --- push --------------------------------------------------------------------------------------

/** A browser's push keys, and a fake push service that decrypts what it receives. */
async function fakePushService(t, { status = () => 201 } = {}) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const code = status(request.url, received.length);
      const body = Buffer.concat(chunks);
      received.push({
        authorization: request.headers.authorization ?? '',
        code,
        encoding: request.headers['content-encoding'],
        payload: code < 300 ? JSON.parse(httpEce.decrypt(body, { authSecret: auth, privateKey: ecdh, version: 'aes128gcm' }).toString('utf8')) : null,
        ttl: request.headers.ttl,
        url: request.url,
      });
      response.writeHead(code).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    keys: { auth: auth.toString('base64url'), p256dh: ecdh.getPublicKey().toString('base64url') },
    received,
  };
}

// web-push signs and encrypts as it does for real push services, which are all HTTPS; the fake
// service is plain HTTP on loopback, so the request web-push builds is sent with fetch.
async function sendThroughFetch(subscription, payload, options) {
  const details = webpush.generateRequestDetails(subscription, payload, options);
  const response = await fetch(details.endpoint, { body: details.body, headers: details.headers, method: details.method });
  if (response.status >= 300) throw new webpush.WebPushError('Push service refused', response.status, {}, '', details.endpoint);
}

test('a push goes to each device unless an Odin tab is focused; 410 removes the subscription; other failures retry twice', async (t) => {
  const vapid = generateVapidKeys();
  const service = await fakePushService(t, { status: (url, count) => (url.startsWith('/gone') ? 410 : url.startsWith('/flaky') ? 500 : 201) });
  const { app, general, ok, post, send, settle } = await fixture(t, { webPush: { ...vapid, subject: 'mailto:ops@odin.example' }, webPushSend: sendThroughFetch });
  const config = await ok('member', 'GET', '/api/me/push');
  assert.deepEqual(config, { available: true, ok: true, publicKey: vapid.publicKey });
  assert.equal((await send('member', 'POST', '/api/me/push-subscriptions', { endpoint: 'https://evil.example/push', keys: service.keys })).status, 400, 'only push service addresses');
  await ok('member', 'POST', '/api/me/push-subscriptions', { endpoint: `${service.base}/phone`, keys: service.keys }, 201);
  const channel = await general();

  await post('lead', channel.id, `${mention('member')} the SOW is ready`);
  await settle();
  assert.equal(service.received.length, 1);
  const [push] = service.received;
  assert.equal(push.encoding, 'aes128gcm');
  assert.match(push.authorization, /^vapid t=.+, k=/);
  assert.equal(push.ttl, '3600');
  assert.equal(push.payload.title, 'Lena Lead mentioned you in #General (Northwind pursuit)');
  assert.equal(push.payload.body, '@Mo Member the SOW is ready');
  assert.match(push.payload.url, new RegExp(`^${APP}/chat/channels/${PROJECT}/${channel.id}\\?post=`), 'a push opens the item in Odin Chat');

  // With a focused tab, nothing is pushed; once it blurs, pushes go again.
  await ok('member', 'POST', '/api/me/focus', { clientId: 'tab-1', focused: true });
  await post('lead', channel.id, `${mention('member')} while you look`);
  await settle();
  assert.equal(service.received.length, 1, 'skipped while focused');
  await ok('member', 'POST', '/api/me/focus', { clientId: 'tab-1', focused: false });
  await post('lead', channel.id, `${mention('member')} after you left`);
  await settle();
  assert.equal(service.received.length, 2);

  // A gone subscription is removed; a failing one is tried three times in all.
  await ok('member', 'POST', '/api/me/push-subscriptions', { endpoint: `${service.base}/gone`, keys: service.keys }, 201);
  await ok('member', 'POST', '/api/me/push-subscriptions', { endpoint: `${service.base}/flaky`, keys: service.keys }, 201);
  await post('lead', channel.id, `${mention('member')} third`);
  await settle();
  assert.deepEqual(service.received.slice(2).map((entry) => [entry.url, entry.code]), [['/phone', 201], ['/gone', 410], ['/flaky', 500], ['/flaky', 500], ['/flaky', 500]]);
  const left = await app.locals.notificationsRepository.listPushSubscriptions({ principalId: USERS.member.id, principalType: 'user' });
  assert.deepEqual(left.map((entry) => new URL(entry.endpoint).pathname).sort(), ['/flaky', '/phone'], '410 removed it; a 500 does not');

  assert.equal((await ok('member', 'DELETE', '/api/me/push-subscriptions', { endpoint: `${service.base}/phone` })).removed, true);
  assert.equal(isPushServiceEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(isPushServiceEndpoint('https://web.push.apple.com/abc'), true);
  assert.equal(isPushServiceEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
  assert.equal(isPushServiceEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
});

test('without VAPID keys push is off: the bell is told so and subscribing is refused', async (t) => {
  const { ok, send } = await fixture(t);
  assert.deepEqual(await ok('member', 'GET', '/api/me/push'), { available: false, ok: true, publicKey: '' });
  assert.equal((await send('member', 'POST', '/api/me/push-subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { auth: 'a'.repeat(22), p256dh: 'b'.repeat(87) } })).body.details.code, 'push_unavailable');
});

// --- the rolled-up email (fake clock) ----------------------------------------------------------

test('a mention read within 10 minutes never emails; unread items roll into one email once 20 quiet minutes pass; items read first are dropped', async (t) => {
  const { clock, flush, general, mailRepository, ok, post, sent } = await fixture(t);
  const channel = await general();
  await post('lead', channel.id, `${mention('member')} read me soon`);
  clock.advance(5 * MINUTE);
  await ok('member', 'POST', `${P}/channels/${channel.id}/read`);
  clock.advance(60 * MINUTE);
  await flush();
  const to = (key) => sent.filter((mail) => mail.to === `${USERS[key].id}@acme.example`);
  assert.equal(to('member').length, 0, 'read in Odin, never emailed');
  assert.equal(to('manager').length, 1, 'a watcher who never opened the channel gets it');

  // Three unread items for Mo: a mention, a reply in his thread and, ten minutes later, another
  // mention, which pushes the email back. One is read before the email goes.
  const root = await post('member', channel.id, 'My thread');
  await post('lead', channel.id, `${mention('member')} first`);
  const reply = await post('other', channel.id, 'A reply for Mo', { parentId: root.id });
  clock.advance(10 * MINUTE);
  await post('other', channel.id, `${mention('member')} later`);
  clock.advance(10 * MINUTE + 1);
  await flush();
  assert.equal(to('member').length, 0, 'joined 10 minutes after creation; then 20 quiet minutes are needed');
  clock.advance(10 * MINUTE);
  await flush();
  assert.equal(to('member').length, 0, 'the later mention joined 10 minutes ago, so not yet');
  const bell = (await ok('member', 'GET', '/api/me/notifications')).notifications;
  await ok('member', 'POST', '/api/me/notifications/read', { ids: [bell.find((entry) => entry.excerpt.includes('first')).id] });
  clock.advance(10 * MINUTE + 1);
  const summary = await flush();
  assert.equal(summary.sent, 1, JSON.stringify(summary));

  const [mail] = to('member');
  assert.equal(mail.subject, "2 things you haven't seen in Odin");
  assert.match(mail.html, /Olu Other replied in a thread in #General \(Northwind pursuit\)/);
  assert.match(mail.html, /Olu Other mentioned you in #General \(Northwind pursuit\)/);
  assert.doesNotMatch(mail.html, /first/, 'read before the email, so dropped');
  assert.match(mail.html, new RegExp(`href="${APP}/chat/channels/${PROJECT}/${channel.id}\\?post=${reply.id}"`), 'a reply opens on itself, in its thread, in Odin Chat');
  assert.match(mail.html, /In reply to: My thread/, 'and names its thread');
  assert.match(mail.html, /Turn off the chat email digest/);
  const [lead] = to('lead');
  assert.equal(lead.subject, '2 new posts in #General (Northwind pursuit)', 'the lead watches the channel: one collapsed item, begun after the lead last posted there');
  assert.equal((await flush()).due, 0, 'sent once');
  assert.equal(mailRepository.state.queue.length, 0, 'no immediate mention email and no daily digest');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['job:channel-digest'], undefined, 'the daily digest job is gone');

  // A collapsed notification that was emailed goes back in when a new post lands in it.
  await post('other', channel.id, 'One more for the lead');
  clock.advance(31 * MINUTE);
  await flush();
  assert.equal(to('lead').length, 2);
  assert.equal(to('lead')[1].subject, '3 new posts in #General (Northwind pursuit)');
});

test('chat emails about a poll and a reply in its thread each link to their own post and show a preview, also after a vote', async (t) => {
  const { clock, flush, general, ok, post, sent } = await fixture(t);
  const channel = await general();
  const to = (key) => sent.filter((mail) => mail.to === `${USERS[key].id}@acme.example`);
  const hrefs = (mail) => [...mail.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll('&amp;', '&')).filter((href) => href.includes('/chat/'));
  const inbox = (mail) => /<div style="display:none;[^>]*>([^<]*)<\/div>/.exec(mail.html)?.[1] ?? '';

  // Email 1: a poll with nothing written above it. Lena watches the channel.
  const poll = await post('member', channel.id, '', { poll: { kind: 'single', options: ['Yes', 'No'], question: 'Lunch on Friday <b>or</b> Monday & later?' } });
  clock.advance(31 * MINUTE);
  await flush();
  const [first] = to('lead');
  assert.equal(first.subject, 'Mo Member posted in #General (Northwind pursuit)');
  assert.deepEqual(hrefs(first), [`${APP}/chat/channels/${PROJECT}/${channel.id}?post=${poll.id}`]);
  assert.match(first.html, /<blockquote>Poll: Lunch on Friday &lt;b&gt;or&lt;\/b&gt; Monday &amp; later\?<\/blockquote>/, 'the poll question, escaped');
  assert.doesNotMatch(first.html, /<b>or<\/b>/);
  assert.equal(inbox(first), 'Poll: Lunch on Friday &lt;b&gt;or&lt;/b&gt; Monday &amp; later?', 'the inbox shows it too');
  assert.doesNotMatch(first.html, /In reply to:/, 'a thread’s first post names no thread');

  // Lena votes in the poll; then Olu replies in its thread. Voting changes nothing a link needs.
  await ok('lead', 'PUT', `${P}/posts/${poll.id}/poll/vote`, { answer: { optionIds: ['o1'] } });
  const reply = await post('other', channel.id, 'We have chat now', { parentId: poll.id });
  clock.advance(31 * MINUTE);
  await flush();
  const second = to('lead')[1];
  assert.ok(second, 'a second email');
  assert.deepEqual(hrefs(second), [`${APP}/chat/channels/${PROJECT}/${channel.id}?post=${reply.id}`], 'the reply, marked in the poll’s thread');
  assert.match(second.html, /In reply to: Poll: Lunch on Friday &lt;b&gt;or&lt;\/b&gt; Monday &amp; later\?/, 'the same thread as the first email');
  assert.match(second.html, /<blockquote>Olu Other: We have chat now<\/blockquote>/);
  assert.equal(inbox(second), 'Olu Other: We have chat now');

  // The poll's author hears of the reply in their thread, with the same link and thread.
  const author = to('member').at(-1);
  assert.equal(author.subject, 'Olu Other replied in a thread in #General (Northwind pursuit)');
  assert.deepEqual(hrefs(author), [`${APP}/chat/channels/${PROJECT}/${channel.id}?post=${reply.id}`]);
  assert.match(author.html, /In reply to: Poll: Lunch on Friday/);

  // Text above a poll comes first, cut short, then the question.
  const long = await post('member', channel.id, `Team lunch ${'is on us '.repeat(40)}`, { poll: { kind: 'single', options: ['Yes', 'No'], question: 'Coming?' } });
  const [bell] = (await ok('lead', 'GET', '/api/me/notifications')).notifications;
  assert.equal(bell.path, `/chat/channels/${PROJECT}/${channel.id}?post=${long.id}`);
  assert.match(bell.excerpt, /^Mo Member: Team lunch is on us .*… · Poll: Coming\?$/);
  assert.ok(bell.excerpt.length <= 'Mo Member: '.length + 200, bell.excerpt);
});

test('the digest leaves out people who turned it off, and retries a mail failure', async (t) => {
  const { clock, flush, general, ok, post, sent, transport } = await fixture(t);
  const channel = await general();
  await ok('other', 'PUT', '/api/users/me', { email: `${USERS.other.id}@acme.example`, firstName: 'Olu', lastName: 'Other', preferences: { emailNotifChannelDigest: false, notificationPrefsVersion: 1 }, profileDisplayName: 'Olu Other' });
  await post('lead', channel.id, `${mention('other')} and ${mention('member')} please look`);
  const realSend = transport.sendMail;
  let failures = 1;
  transport.sendMail = async (message) => {
    if (message.to === `${USERS.member.id}@acme.example` && failures-- > 0) throw new Error('421 try again later');
    return realSend(message);
  };
  clock.advance(31 * MINUTE);
  const first = await flush();
  assert.equal(first.retried, 1, JSON.stringify(first));
  assert.equal(first.skipped, 1, 'Olu turned the chat email digest off');
  const [released] = (await ok('other', 'GET', '/api/me/notifications')).notifications;
  assert.ok(released, 'still on the bell');
  clock.advance(10 * MINUTE);
  assert.equal((await flush()).sent, 1, 'the retry goes out');
  const people = sent.map((entry) => entry.to);
  assert.equal(people.filter((address) => address === `${USERS.member.id}@acme.example`).length, 1);
  assert.ok(!people.includes(`${USERS.other.id}@acme.example`));
  assert.equal(CHAT_DIGEST_RELEASE_REASONS.digestOff.startsWith('chat digest'), true);
});

// --- guests ---------------------------------------------------------------------------

test('a guest hears of mentions and replies in their channels only, on their own bell, and their email links open the guest view', async (t) => {
  // The notifications module's own directory, keyed by stakeholder; the guests module's, keyed by
  // access link, is tested with real guest sessions in guests.test.js.
  const { app, clock, flush, general, ok, post, projectRepository, sent } = await fixture(t, { guestDirectory: (projectRepository) => createChannelGuestDirectory({ projectRepository }) });
  const shared = await general();
  const internal = (await ok('lead', 'POST', `${P}/channels`, { name: 'Internal' }, 201)).channel;
  projectRepository.state.channelGuests.push({ channelId: shared.id, email: GUEST.email, invitedAt: clock().toISOString(), invitedBy: USERS.lead.id, name: GUEST.name, removedAt: null, stakeholderId: GUEST.id, tenantId: TENANT_ID });
  const guestTag = `@[${GUEST.name}](stakeholder:${GUEST.id})`;

  // The guests workstream wires its session in; here a header stands in for it.
  const guestApp = express();
  guestApp.use(express.json());
  guestApp.use('/api/guest/me', createPrincipalNotificationsRouter({
    authenticate: (request, response, next) => (request.get('x-guest') === GUEST.id ? next() : response.status(401).end()),
    liveEventBus: app.locals.liveEventBus,
    notifications: app.locals.notifications,
    notificationsRepository: app.locals.notificationsRepository,
    principalOf: () => ({ principalId: GUEST.id, principalType: 'stakeholder', tenantId: TENANT_ID }),
  }));
  const guestServer = createServer(guestApp);
  await new Promise((resolve) => guestServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => guestServer.close(resolve)));
  const guestBell = async () => (await (await fetch(`http://127.0.0.1:${guestServer.address().port}/api/guest/me/notifications`, { headers: { 'x-guest': GUEST.id } })).json());

  await post('lead', shared.id, `${guestTag} could you confirm the dates?`);
  await post('lead', internal.id, `${guestTag} not for them`);
  await post('lead', shared.id, 'Plain post');
  // The guest's own post, and a member's reply to it.
  const guestPost = await projectRepository.createPost({ post: { authorId: GUEST.id, authorType: 'stakeholder', body: 'Dates work for us', projectId: PROJECT, targetId: shared.id, targetType: 'channel', tenantId: TENANT_ID } });
  await post('lead', shared.id, 'Great, thanks', { parentId: guestPost.id });

  const { notifications, unreadCount } = await guestBell();
  assert.equal(unreadCount, 2);
  assert.deepEqual(notifications.map((entry) => [entry.kind, entry.title]), [['thread_reply', 'Lena Lead replied in a thread in #General'], ['mention', 'Lena Lead mentioned you in #General']]);
  assert.ok(notifications.every((entry) => entry.path.startsWith('/guest/')), 'guest links');
  assert.ok(!notifications.some((entry) => entry.channelId === internal.id), 'nothing from a channel they are not in');

  clock.advance(31 * MINUTE);
  await flush();
  const mail = sent.find((entry) => entry.to === GUEST.email);
  assert.ok(mail, 'the guest gets the rolled-up email');
  const links = [...mail.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll('&amp;', '&'));
  assert.ok(links.length >= 2);
  assert.ok(links.every((link) => link.startsWith(`${APP}/guest/channels/${shared.id}?post=`)), links.join('\n'));
  assert.doesNotMatch(mail.html, /\/user\?tab=preferences/, 'no member settings link');

  // Removed from the channel: nothing new, and anything pending is released.
  projectRepository.state.channelGuests[0].removedAt = clock().toISOString();
  await post('lead', shared.id, `${guestTag} are you there?`);
  assert.equal((await guestBell()).unreadCount, 2, 'no new notification once removed');
});

// --- retention ---------------------------------------------------------------------------------

test('notifications are kept 90 days', async (t) => {
  const { app, bell, clock, general, post } = await fixture(t);
  const channel = await general();
  await post('lead', channel.id, `${mention('member')} old news`);
  clock.advance(60 * 86_400_000);
  await post('lead', channel.id, `${mention('member')} newer`);
  clock.advance(31 * 86_400_000);
  // Mo's first mention is 91 days old; the watchers' collapsed notifications had a post 31 days ago.
  assert.equal(await app.locals.notifications.purgeOld(), 1);
  assert.equal((await bell('manager')).notifications.length, 1);
  assert.deepEqual((await bell('member')).notifications.map((entry) => entry.excerpt), ['@Mo Member newer']);
});
