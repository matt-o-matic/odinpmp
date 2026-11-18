import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { flushDueChatDigests } from '../src/modules/notifications/chat-digest.service.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAccessRepository } from '../src/modules/access/access.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { directMemberKey } from '../src/modules/chat/chat.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryGuestSessionsRepository } from '../src/modules/guests/guest-sessions.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// Odin Chat: the sidebar's channels across projects and engagements, Mentions, Threads, direct
// messages with their posts, files, unread counts and live stream, and Odin's direct message
// (the person's AI Workspace chats), through Odin's routes on in-memory repositories.
// odin-chat-mysql.integration.test.js runs 0103.

const TENANT_ID = 'tenant-acme';
const OTHER_TENANT_ID = 'tenant-other';
const DEL = 'project-del';
const SOLO = 'project-solo';
const ENG = 'project-eng';
const LOST = 'project-lost';
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', role: 'user' },
  other: { id: 'user-other', name: 'Olu Other', role: 'user' },
  outsider: { id: 'user-outsider', name: 'Oz Outsider', role: 'user' },
  admin: { id: 'user-admin', name: 'Ada Admin', role: 'admin' },
  stranger: { id: 'user-stranger', name: 'Sam Stranger', role: 'user', tenantId: OTHER_TENANT_ID },
};
const GINA = { email: 'gina@northwind.example', name: 'Gina Guest', organization: 'Northwind' };
const mention = (key) => `@[${USERS[key].name}](user:${USERS[key].id})`;
const start = Date.parse('2026-11-14T09:00:00.000Z');

async function fixture(t) {
  const clock = { now: start };
  const at = () => new Date(clock.now);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }, { domains: ['other.example'], id: OTHER_TENANT_ID, name: 'Other' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: user.tenantId ?? TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-chat-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const changeLog = createInMemoryProjectChangeLog();
  const mailRepository = createInMemoryMailRepository();
  const people = (entries) => entries.map(([key, role]) => ({ email: `${USERS[key].id}@acme.example`, id: USERS[key].id, name: USERS[key].name, role }));
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog,
    fileStorage: storage,
    mailRepository,
    seed: {
      projectMemberships: {
        [DEL]: people([['lead', 'admin'], ['member', 'user'], ['other', 'user']]),
        [SOLO]: people([['lead', 'admin']]),
        [ENG]: people([['lead', 'admin'], ['member', 'user']]),
        [LOST]: people([['lead', 'admin'], ['member', 'user']]),
      },
      projects: [
        { epics: [], id: DEL, name: 'Contoso rollout', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: SOLO, name: 'Lena only', status: 'In Progress', tenantId: TENANT_ID },
        { engagementCustomer: 'Northwind', engagementOwnerId: USERS.lead.id, engagementStatus: 'open', epics: [], id: ENG, kind: 'engagement', name: 'Northwind pursuit', status: 'In Progress', tenantId: TENANT_ID },
        { engagementCustomer: 'Fabrikam', engagementOwnerId: USERS.lead.id, engagementStatus: 'lost', epics: [], id: LOST, kind: 'engagement', name: 'Fabrikam bid', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  let moduleVersion = 0;
  async function setConsulting(enabled) {
    await workspaceModulesRepository.setModule({ enabled, expectedVersion: moduleVersion, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
    moduleVersion += 1;
  }
  await setConsulting(true);
  const liveEventBus = createLiveEventBus();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'odin-chat-fixture', secret: 'disposable-odin-chat-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    accessRepository: createInMemoryAccessRepository(), assistantRepository: createInMemoryAssistantRepository(), authRepository, complianceRepository: createInMemoryComplianceRepository(),
    fileStorage: storage, guestClock: at, guestHeartbeatMs: 60_000, guestSessionsRepository: createInMemoryGuestSessionsRepository(),
    liveEventBus, mailRepository, projectRepository, sessionsRepository, tokenService, workspaceModulesRepository,
  });
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const streams = [];
  t.after(async () => {
    for (const controller of streams) controller.abort();
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const tokens = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: {}, role: user.role, tenantId: user.tenantId ?? TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[key] = token;
  }
  const absolute = (url) => (url.startsWith('http') ? url : `${origin}${url}`);
  // `as` is a member key, or { guest: token } for a guest's bearer token.
  async function send(as, method, route, body) {
    const bearer = typeof as === 'string' ? tokens[as] : as?.guest;
    const response = await fetch(absolute(route), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await send(as, method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const P = (projectId) => `/api/projects/${projectId}`;
  async function channel(projectId, name = 'General') {
    const listed = await ok('lead', 'GET', `${P(projectId)}/channels`);
    return listed.channels.find((entry) => entry.name === name) ?? (await ok('lead', 'POST', `${P(projectId)}/channels`, { name }, 201)).channel;
  }
  async function post(as, projectId, channelId, body, extra = {}) {
    return (await ok(as, 'POST', `${P(projectId)}/channels/${channelId}/posts`, { body, ...extra }, 201)).post;
  }
  const sidebar = (as) => ok(as, 'GET', '/api/chat/sidebar');
  const C = (conversationId) => `/api/chat/conversations/${conversationId}`;
  async function dm(as, ...others) {
    return ok(as, 'POST', '/api/chat/conversations', { memberIds: others.map((key) => USERS[key]?.id ?? key) }, 201);
  }
  async function upload(as, base, contents, fileName = 'notes.txt') {
    const bytes = Buffer.from(contents);
    const started = await ok(as, 'POST', `${base}/uploads`, { contentType: 'text/plain', fileName, fileSize: bytes.length }, 201);
    const signed = await ok(as, 'POST', `${base}/uploads/${started.upload.id}/parts`, { partNumbers: [1] });
    const put = await fetch(absolute(signed.parts[0].url), { body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, method: 'PUT' });
    assert.equal(put.status, 200, await put.text());
    return ok(as, 'POST', `${base}/uploads/${started.upload.id}/complete`, {}, 201);
  }
  async function scanAll() {
    for (const object of await projectRepository.listPendingScanObjects({ limit: 100 })) {
      const bytes = (await storage.read(object.storageKey)).bytes;
      await projectRepository.recordObjectScan({ md5: createHash('md5').update(bytes).digest('hex'), scanStatus: 'clean', storageKey: object.storageKey });
    }
  }
  // An open event stream: its events as they arrive.
  async function openStream(as, route) {
    const controller = new AbortController();
    streams.push(controller);
    const response = await fetch(absolute(route), { headers: { Authorization: `Bearer ${tokens[as]}` }, signal: controller.signal });
    const stream = { events: [], status: response.status };
    if (response.status !== 200) return stream;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            stream.events.push({ data: data ? JSON.parse(data) : null, type });
          }
        }
      } catch {
        // Aborted at the end of the test.
      }
    })();
    return stream;
  }
  async function until(check, label) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
  }
  return { app, authRepository, channel, clock, dm, mailRepository, ok, openStream, post, projectRepository, scanAll, send, setConsulting, sidebar, until, upload, C, P, absolute, tokens };
}

test('the sidebar lists every channel the person is in across projects and engagements, with unread and mention counts', async (t) => {
  const f = await fixture(t);
  const general = await f.channel(DEL);
  const deal = await f.channel(DEL, 'Deal room');
  // Writing marks the channel read for the writer, so Mo writes first.
  await f.post('member', DEL, general.id, 'My own post never counts for me.');
  await f.post('lead', DEL, general.id, 'Kick-off is Monday.');
  await f.post('lead', DEL, general.id, `${mention('member')} can you book the room?`);
  // A channel in a project Mo is not in: never listed, never counted.
  await f.post('lead', SOLO, (await f.channel(SOLO)).id, `${mention('member')} this is not for you to see`);

  const seen = await f.sidebar('member');
  assert.deepEqual(seen.groups.map((group) => [group.name, group.kind, group.readOnly]), [
    ['Contoso rollout', 'delivery', false],
    ['Northwind pursuit', 'engagement', false],
    ['Fabrikam bid', 'engagement', true],
  ], 'readable projects and engagements, lost ones last; General is made on first look');
  const del = seen.groups.find((group) => group.id === DEL);
  assert.deepEqual(del.channels.map((entry) => [entry.name, entry.unreadCount, entry.mentionCount]), [['General', 2, 1], ['Deal room', 0, 0]]);
  assert.equal(seen.groups.find((group) => group.id === ENG).customer, 'Northwind');
  assert.deepEqual(seen.totals, { channels: 2, directMessages: 0, mentions: 1, unread: 2 });
  assert.deepEqual(await f.ok('member', 'GET', '/api/chat/unread'), { ok: true, channels: 2, directMessages: 0, mentions: 1, unread: 2 });

  // Reading the channel clears its counts.
  await f.ok('member', 'POST', `${f.P(DEL)}/channels/${general.id}/read`, {});
  assert.equal((await f.sidebar('member')).totals.unread, 0);

  // An archived channel leaves the sidebar.
  await f.ok('lead', 'DELETE', `${f.P(DEL)}/channels/${deal.id}`);
  assert.deepEqual((await f.sidebar('member')).groups.find((group) => group.id === DEL).channels.map((entry) => entry.name), ['General']);

  // Someone in no project sees no channels; a workspace admin sees every project's.
  assert.deepEqual((await f.sidebar('outsider')).groups, []);
  assert.deepEqual((await f.sidebar('admin')).groups.map((group) => group.id).sort(), [DEL, ENG, LOST, SOLO].sort());

  // With the Consulting module off, engagements leave the sidebar, and come back with it on.
  await f.setConsulting(false);
  assert.deepEqual((await f.sidebar('member')).groups.map((group) => group.id), [DEL]);
  await f.setConsulting(true);
  assert.deepEqual((await f.sidebar('member')).groups.map((group) => group.id), [DEL, ENG, LOST]);

  // A lost engagement's channel stays listed, read-only.
  const lostGeneral = (await f.sidebar('member')).groups.find((group) => group.id === LOST).channels[0];
  const refused = await f.send('member', 'POST', `${f.P(LOST)}/channels/${lostGeneral.id}/posts`, { body: 'Anyone?' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.details.code, 'engagement_closed');

  // Another workspace's member gets nothing of this one.
  assert.deepEqual((await f.sidebar('stranger')).groups, []);
});

test('Mentions lists the posts and replies that tag the person, in channels and direct messages they are in', async (t) => {
  const f = await fixture(t);
  const general = await f.channel(DEL);
  const eng = await f.channel(ENG);
  const root = await f.post('lead', DEL, general.id, `${mention('member')} please review the plan`);
  await f.post('lead', DEL, general.id, `${mention('member')} and the reply`, { parentId: root.id });
  await f.post('member', DEL, general.id, `${mention('member')} a note to myself`);
  await f.post('lead', DEL, general.id, 'No tag here.');
  await f.post('lead', SOLO, (await f.channel(SOLO)).id, `${mention('member')} out of reach`);
  await f.post('lead', ENG, eng.id, `${mention('member')} engagement question`);
  const { conversation } = await f.dm('lead', 'member');
  await f.ok('lead', 'POST', `${f.C(conversation.id)}/posts`, { body: `${mention('member')} in private` }, 201);

  const listed = await f.ok('member', 'GET', '/api/chat/mentions');
  assert.deepEqual(listed.mentions.map((entry) => entry.post.excerpt), ['@Mo Member in private', '@Mo Member engagement question', '@Mo Member and the reply', '@Mo Member please review the plan']);
  assert.deepEqual(listed.mentions[0].place, { conversationId: conversation.id, title: 'Lena Lead', type: 'dm' });
  assert.deepEqual(listed.mentions[1].place, { channelId: eng.id, channelName: 'General', kind: 'engagement', projectId: ENG, projectName: 'Northwind pursuit', type: 'channel' });
  assert.equal(listed.mentions[2].post.parentId, root.id, 'a reply names its thread');
  assert.equal(listed.nextCursor, null);

  // With the Consulting module off, the engagement's mention goes too.
  await f.setConsulting(false);
  assert.equal((await f.ok('member', 'GET', '/api/chat/mentions')).mentions.some((entry) => entry.place.projectId === ENG), false);

  // Someone else sees only their own tags.
  assert.deepEqual((await f.ok('other', 'GET', '/api/chat/mentions')).mentions, []);
});

test('Threads lists threads the person started or replied in, with replies new since they last read', async (t) => {
  const f = await fixture(t);
  const general = await f.channel(DEL);
  const mine = await f.post('member', DEL, general.id, 'Who owns the budget?');
  const theirs = await f.post('lead', DEL, general.id, 'Draft timeline attached.');
  const unrelated = await f.post('lead', DEL, general.id, 'Lunch at noon.');
  const lonely = await f.post('member', DEL, general.id, 'Nobody replied to this one.');
  await f.post('member', DEL, general.id, 'Looks right to me.', { parentId: theirs.id });
  await f.post('other', DEL, general.id, 'Agreed.', { parentId: unrelated.id });
  await f.post('lead', DEL, general.id, 'I do.', { parentId: mine.id });

  let listed = await f.ok('member', 'GET', '/api/chat/threads');
  assert.deepEqual(listed.threads.map((thread) => thread.root.id), [mine.id, theirs.id], 'latest reply first; not threads Mo is not in, nor ones without replies');
  assert.notEqual(lonely.id, listed.threads[0].root.id);
  assert.deepEqual(listed.threads.map((thread) => [thread.replyCount, thread.newReplyCount]), [[1, 1], [1, 0]], 'Mo has read up to his own reply');
  assert.deepEqual(listed.threads[0].lastReply.excerpt, 'I do.');
  assert.equal(listed.threads[0].place.channelId, general.id);

  await f.ok('member', 'POST', `${f.P(DEL)}/channels/${general.id}/read`, {});
  listed = await f.ok('member', 'GET', '/api/chat/threads');
  assert.equal(listed.threads[0].newReplyCount, 0, 'reading the channel reads its threads');

  // Threads in direct messages count too.
  const { conversation } = await f.dm('member', 'lead');
  const opener = (await f.ok('member', 'POST', `${f.C(conversation.id)}/posts`, { body: 'Quick question' }, 201)).post;
  await f.ok('lead', 'POST', `${f.C(conversation.id)}/posts`, { body: 'Go ahead', parentId: opener.id }, 201);
  listed = await f.ok('member', 'GET', '/api/chat/threads');
  assert.deepEqual([listed.threads[0].root.id, listed.threads[0].newReplyCount, listed.threads[0].place.type], [opener.id, 1, 'dm']);
});

test('direct messages: start, post, reply, tag, attach, read, unread and live, for members only', async (t) => {
  const f = await fixture(t);
  // One to one, and the same people reach the same conversation.
  const started = await f.dm('member', 'lead');
  assert.equal(started.created, true);
  assert.deepEqual(started.conversation.members.map((member) => member.name), ['Mo Member', 'Lena Lead']);
  assert.equal(started.conversation.title, 'Lena Lead');
  const again = await f.dm('lead', 'member');
  assert.deepEqual([again.created, again.conversation.id], [false, started.conversation.id]);
  const id = started.conversation.id;
  // A group of three is its own conversation.
  const group = await f.dm('member', 'lead', 'other');
  assert.notEqual(group.conversation.id, id);
  assert.equal(group.conversation.isGroup, true);
  assert.equal(group.conversation.title, 'Lena Lead, Olu Other');

  // Who can be in one: 2 to 8 people of this workspace.
  assert.equal((await f.send('member', 'POST', '/api/chat/conversations', { memberIds: [USERS.member.id] })).body.details.code, 'members_required');
  assert.equal((await f.send('member', 'POST', '/api/chat/conversations', { memberIds: [USERS.stranger.id] })).body.details.code, 'not_workspace_members');
  assert.equal((await f.send('member', 'POST', '/api/chat/conversations', { memberIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })).status, 400, 'nine people');
  const people = await f.ok('member', 'GET', '/api/chat/people');
  assert.deepEqual(people.people.map((person) => person.name), ['Ada Admin', 'Lena Lead', 'Olu Other', 'Oz Outsider'], 'everyone in the workspace but me');

  // Live: Lena's open conversation hears Mo's post, without its text.
  const stream = await f.openStream('lead', `${f.C(id)}/events`);
  assert.equal(stream.status, 200);
  await f.until(() => stream.events.some((event) => event.type === 'connected'), 'the stream to open');

  // A post with a tag and a file uploaded in parts into the conversation.
  const uploaded = await f.upload('member', f.C(id), 'Rate card v2');
  assert.equal(uploaded.file.targetType, 'dm');
  const twin = await f.upload('member', f.C(id), 'Rate card v3');
  assert.notEqual(twin.file.id, uploaded.file.id, 'the same name is kept beside, never a version');
  await f.scanAll();
  const sent = await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: `${mention('lead')} rates attached`, fileIds: [uploaded.file.id] }, 201);
  assert.equal(sent.post.body, `${mention('lead')} rates attached`, 'the tag resolves to a member');
  assert.deepEqual(sent.mentioned, [USERS.lead.id]);
  assert.deepEqual(sent.post.attachments.map((file) => file.fileName), ['notes.txt']);
  await f.until(() => stream.events.some((event) => event.type === 'direct-message.updated' && event.data.area === 'posts'), 'the live event');
  assert.ok(stream.events.some((entry) => entry.type === 'direct-message.updated' && entry.data.area === 'files'), 'uploads are heard too');
  const event = stream.events.find((entry) => entry.type === 'direct-message.updated' && entry.data.area === 'posts');
  assert.deepEqual([event.data.area, event.data.conversationId, event.data.actor.id], ['posts', id, USERS.member.id]);
  assert.equal(JSON.stringify(event.data).includes('rates attached'), false, 'events carry no message text');
  // A tag of someone outside the conversation stays plain text.
  const outside = await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: `${mention('other')} not here` }, 201);
  assert.equal(outside.post.body, '@Olu Other not here');
  assert.equal((await f.send('member', 'POST', `${f.C(id)}/posts`, { body: 'x', fileIds: ['file-elsewhere'] })).body.details.code, 'attachment_not_in_conversation');

  // Lena's unread count, then a reply and her read.
  let lena = (await f.sidebar('lead')).directMessages.find((entry) => entry.id === id);
  assert.deepEqual([lena.unreadCount, lena.mentionCount, lena.title], [2, 1, 'Mo Member']);
  assert.equal((await f.sidebar('lead')).totals.directMessages, 2);
  const reply = await f.ok('lead', 'POST', `${f.C(id)}/posts`, { body: 'Thanks', parentId: sent.post.id }, 201);
  assert.equal(reply.post.parentId, sent.post.id);
  assert.equal((await f.send('lead', 'POST', `${f.C(id)}/posts`, { body: 'deeper', parentId: reply.post.id })).body.details.code, 'reply_depth');
  lena = (await f.sidebar('lead')).directMessages.find((entry) => entry.id === id);
  assert.equal(lena.unreadCount, 0, 'writing marks it read');
  await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: 'One more' }, 201);
  assert.equal((await f.sidebar('lead')).directMessages.find((entry) => entry.id === id).unreadCount, 1);
  await f.ok('lead', 'POST', `${f.C(id)}/read`, {});
  assert.equal((await f.sidebar('lead')).directMessages.find((entry) => entry.id === id).unreadCount, 0);

  // The conversation reads as a channel does: newest first, replies under their post.
  const page = await f.ok('lead', 'GET', `${f.C(id)}/posts`);
  assert.deepEqual(page.posts.map((entry) => entry.body), ['One more', '@Olu Other not here', `${mention('lead')} rates attached`]);
  assert.deepEqual(page.posts[2].replies.map((entry) => entry.body), ['Thanks']);
  assert.deepEqual([page.posts[2].canEdit, page.posts[2].canDelete, page.posts[0].canReply], [false, false, true], 'only authors change their posts');
  assert.equal((await f.send('lead', 'PATCH', `${f.C(id)}/posts/${sent.post.id}`, { body: 'mine now' })).status, 403);
  const edited = await f.ok('member', 'PATCH', `${f.C(id)}/posts/${sent.post.id}`, { body: 'rates attached (v2)' });
  assert.equal(edited.post.body, 'rates attached (v2)');
  const removed = await f.ok('member', 'DELETE', `${f.C(id)}/posts/${outside.post.id}`);
  assert.equal(removed.post.deleted, true);
  assert.deepEqual((await f.ok('lead', 'GET', `${f.C(id)}/mentionables`)).people.map((person) => person.ref), [`user:${USERS.member.id}`]);

  // Members download the attached file once it is scanned.
  const download = await f.ok('lead', 'GET', `${f.C(id)}/files/${uploaded.file.id}/download-url`);
  assert.equal((await (await fetch(f.absolute(download.url))).text()), 'Rate card v2');
  assert.deepEqual((await f.ok('lead', 'GET', `${f.C(id)}/files`)).files.map((file) => file.fileName).sort(), ['notes (2).txt', 'notes.txt'].sort());

  // Anyone else gets 404, as for a conversation that doesn't exist: reads, writes, files, stream.
  for (const as of ['other', 'admin', 'stranger']) {
    for (const [method, route, body] of [
      ['GET', f.C(id)], ['GET', `${f.C(id)}/posts`], ['POST', `${f.C(id)}/posts`, { body: 'hi' }], ['POST', `${f.C(id)}/read`, {}],
      ['PATCH', `${f.C(id)}/posts/${sent.post.id}`, { body: 'x' }], ['DELETE', `${f.C(id)}/posts/${sent.post.id}`], ['GET', `${f.C(id)}/mentionables`],
      ['GET', `${f.C(id)}/files`], ['GET', `${f.C(id)}/files/${uploaded.file.id}/download-url`], ['GET', `${f.C(id)}/file-storage`],
      ['POST', `${f.C(id)}/uploads`, { contentType: 'text/plain', fileName: 'x.txt', fileSize: 1 }], ['GET', `${f.C(id)}/events`],
    ]) {
      assert.equal((await f.send(as, method, route, body)).status, 404, `${as} ${method} ${route}`);
    }
    assert.equal((await f.sidebar(as)).directMessages.some((entry) => entry.id === id), false);
  }
  assert.equal((await f.send('other', 'GET', '/api/chat/conversations/no-such-thing')).status, 404);
  // The file isn't reachable through project file routes either, even for a workspace admin.
  assert.equal((await f.send('admin', 'GET', `/api/files/${uploaded.file.id}/content`)).status, 404);
  assert.equal((await f.send('admin', 'GET', `/api/projects/${id}/files/${uploaded.file.id}/download-url`)).status, 404);
  // Direct message posts stay out of the projects' change log.
  assert.equal(f.projectRepository.state.discussionPosts.filter((entry) => entry.targetType === 'dm').every((entry) => entry.projectId === id || entry.projectId === group.conversation.id), true);
});

test('guests cannot start, see or be added to direct messages', async (t) => {
  const f = await fixture(t);
  const deal = await f.channel(ENG, 'Deal room');
  await f.ok('lead', 'POST', `${f.P(ENG)}/channels/${deal.id}/guests`, GINA, 201);
  // Gina's real session, signed in with the emailed code.
  f.clock.now += 61_000;
  await f.ok(null, 'POST', '/api/guest/sign-in/code', { email: GINA.email });
  const code = /letter-spacing:6px[^>]*>(\d{6})</.exec([...f.mailRepository.state.queue].reverse().find((row) => row.recipientEmail === GINA.email && row.templateId === 'guest-sign-in-code-v1')?.body ?? '')?.[1];
  assert.ok(code, 'a code was emailed');
  const session = await f.ok(null, 'POST', '/api/guest/sign-in', { code, email: GINA.email });
  const guest = { guest: session.token };
  assert.equal((await f.send(guest, 'GET', '/api/guest/session')).status, 200, 'the session works where guests belong');

  const { conversation } = await f.dm('member', 'lead');
  for (const [method, route, body] of [
    ['GET', '/api/chat/sidebar'], ['GET', '/api/chat/unread'], ['GET', '/api/chat/conversations'], ['POST', '/api/chat/conversations', { memberIds: [USERS.member.id] }],
    ['GET', f.C(conversation.id)], ['GET', `${f.C(conversation.id)}/posts`], ['POST', `${f.C(conversation.id)}/posts`, { body: 'hi' }],
    ['GET', `${f.C(conversation.id)}/events`], ['GET', '/api/chat/people'], ['GET', '/api/chat/mentions'], ['GET', '/api/chat/threads'],
  ]) {
    const response = await f.send(guest, method, route, body);
    assert.equal(response.status, 403, `${method} ${route}`);
    assert.equal(response.body.details.code, 'guest_not_allowed');
  }
  // A guest is no workspace member: never offered, and their account can't be added.
  assert.equal((await f.ok('member', 'GET', '/api/chat/people')).people.some((person) => person.email === GINA.email), false);
  const account = await f.authRepository.findOrCreateStakeholderOwner({ email: GINA.email, name: GINA.name });
  assert.ok(account?.id);
  const refused = await f.send('member', 'POST', '/api/chat/conversations', { memberIds: [account.id] });
  assert.deepEqual([refused.status, refused.body.details.code], [400, 'not_workspace_members']);
});

test('Odin as a direct message lists the person\'s own AI Workspace chats', async (t) => {
  const f = await fixture(t);
  const mine = await f.ok('member', 'POST', '/api/assistant/chats', { projectId: null }, 201);
  await f.ok('lead', 'POST', '/api/assistant/chats', { projectId: null }, 201);
  const listed = await f.ok('member', 'GET', '/api/assistant/chats');
  const ids = [...listed.general, ...listed.projects.flatMap((group) => group.chats)].map((chat) => chat.id);
  assert.deepEqual(ids, [mine.chat.id], 'only Mo\'s chat');
});

test('a conversation key is the same for the same people in any order', () => {
  assert.equal(directMemberKey(['b', 'a', 'a']), directMemberKey(['a', 'b']));
  assert.notEqual(directMemberKey(['a', 'b']), directMemberKey(['a', 'b', 'c']));
});

test('direct messages notify every other member, always: one collapsing notification per conversation, mentions as mentions, read on opening, in the stream and the rolled-up email', async (t) => {
  const f = await fixture(t);
  const { conversation } = await f.dm('member', 'lead', 'other');
  const id = conversation.id;
  const bell = async (as) => (await f.ok(as, 'GET', '/api/me/notifications'));
  const mine = async (as) => (await bell(as)).notifications.filter((entry) => entry.path.startsWith(`/chat/dm/${id}`));
  const stream = await f.openStream('lead', '/api/me/events');
  await f.until(() => stream.events.some((event) => event.type === 'connected'), 'the bell stream to open');

  const first = (await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: 'Draft agenda is up' }, 201)).post;
  for (const as of ['lead', 'other']) {
    const [entry] = await mine(as);
    assert.deepEqual([entry?.kind, entry?.title, entry?.path], ['direct_message', 'Mo Member sent you a direct message', `/chat/dm/${id}?post=${first.id}`], as);
  }
  assert.deepEqual(await mine('member'), [], 'never your own post');
  await f.until(() => stream.events.some((event) => event.type === 'notification.created'), 'the bell stream hears it');

  // More posts collapse into the one open notification; a tag is its own mention.
  await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: 'and the venue' }, 201);
  await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: `${mention('other')} can you book it?` }, 201);
  const lena = await mine('lead');
  assert.deepEqual(lena.map((entry) => [entry.kind, entry.count, entry.title]), [['direct_message', 3, '3 new direct messages']]);
  const olu = await mine('other');
  assert.deepEqual(olu.map((entry) => entry.kind).sort(), ['direct_message', 'mention']);
  assert.equal(olu.find((entry) => entry.kind === 'mention').title, 'Mo Member mentioned you in a direct message');
  assert.deepEqual(olu.find((entry) => entry.kind === 'direct_message').count, 2, 'the tagged post is a mention, not a third message');

  // Opening the conversation reads its notifications, for that person only.
  await f.ok('other', 'POST', `${f.C(id)}/read`, {});
  assert.deepEqual((await mine('other')).filter((entry) => !entry.readAt), []);
  assert.equal((await mine('lead')).filter((entry) => !entry.readAt).length, 1);

  // Posting reads your own; an edit tells only someone it newly tags.
  const reply = (await f.ok('lead', 'POST', `${f.C(id)}/posts`, { body: 'Thanks', parentId: first.id }, 201)).post;
  assert.deepEqual((await mine('lead')).filter((entry) => !entry.readAt), [], 'writing in it reads it');
  const forMo = await mine('member');
  assert.deepEqual(forMo.map((entry) => [entry.kind, entry.path]), [['direct_message', `/chat/dm/${id}?post=${reply.id}`]], 'a reply opens on itself, in its thread');
  const before = (await bell('other')).unreadCount;
  await f.ok('lead', 'PATCH', `${f.C(id)}/posts/${reply.id}`, { body: 'Thanks all' });
  assert.equal((await bell('other')).unreadCount, before, 'an edit that tags nobody new tells nobody');
  await f.ok('lead', 'PATCH', `${f.C(id)}/posts/${reply.id}`, { body: `Thanks ${mention('other')}` });
  assert.equal((await mine('other')).filter((entry) => !entry.readAt && entry.kind === 'mention').length, 1);

  // Unread direct messages join the rolled-up email, with Odin Chat links.
  const sent = [];
  const summary = await flushDueChatDigests({
    authRepository: f.authRepository, env: { mailFromAddress: 'noreply@odin.example', mailFromName: 'Odin' }, frontendAppUrl: 'https://app.example/app', mailRepository: f.mailRepository,
    notificationsRepository: f.app.locals.notificationsRepository, now: () => new Date(Date.now() + 45 * 60_000), projectRepository: f.projectRepository,
    transport: { async sendMail(message) { sent.push(message); return { messageId: `m-${sent.length}` }; } },
  });
  assert.ok(summary.sent >= 1, JSON.stringify(summary));
  const toMo = sent.find((message) => message.to === `${USERS.member.id}@acme.example`);
  assert.ok(toMo, 'Mo’s unread direct message is emailed');
  assert.ok(toMo.html.includes(`href="https://app.example/app/chat/dm/${id}?post=${reply.id}"`), "the link opens the reply, in its thread, in Odin Chat");

  // Someone outside the conversation hears nothing.
  assert.deepEqual(await mine('outsider'), []);
});

test('direct messages take reactions and replies to a reply, for the people in the conversation only', async (t) => {
  const f = await fixture(t);
  const { id } = (await f.dm('member', 'lead')).conversation;
  const root = (await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: 'Lunch?' }, 201)).post;
  const reply = (await f.ok('lead', 'POST', `${f.C(id)}/posts`, { body: 'Noon works', parentId: root.id }, 201)).post;
  const answer = (await f.ok('member', 'POST', `${f.C(id)}/posts`, { body: 'See you then', parentId: root.id, replyToId: reply.id }, 201)).post;
  assert.equal(answer.replyToId, reply.id);

  const reacted = await f.ok('lead', 'PUT', `${f.C(id)}/posts/${root.id}/reactions`, { emoji: '🍕', reacted: true });
  assert.deepEqual(reacted.reactions.map(({ count, emoji, mine }) => [emoji, count, mine]), [['🍕', 1, true]]);
  const listed = (await f.ok('member', 'GET', `${f.C(id)}/posts`)).posts[0];
  assert.deepEqual(listed.reactions.map(({ emoji, mine, people }) => [emoji, mine, people.map((person) => person.name)]), [['🍕', false, ['Lena Lead']]]);
  assert.deepEqual(listed.replies.map((entry) => entry.replyToId), [null, reply.id]);
  assert.equal((await f.send('other', 'PUT', `${f.C(id)}/posts/${root.id}/reactions`, { emoji: '🍕', reacted: true })).status, 404, 'not in the conversation');
  assert.equal((await f.send('lead', 'PUT', `${f.C(id)}/posts/${root.id}/reactions`, { emoji: 'yum', reacted: true })).status, 400);
  await f.ok('lead', 'PUT', `${f.C(id)}/posts/${root.id}/reactions`, { emoji: '🍕', reacted: false });
  assert.deepEqual((await f.ok('member', 'GET', `${f.C(id)}/posts`)).posts[0].reactions, []);
});
