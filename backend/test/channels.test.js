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
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { decodePostCursor, encodePostCursor } from '../src/modules/channels/channels.service.js';
import { editingMarker, EDITING_MARKER_MS } from '../src/modules/channels/channels.repository.js';
import { folderPaths } from '../src/modules/channels/channel-library.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// Channels, conversation, unread counts and live events (docs/engagements/plan.md, workstream
// 3; AC-03, AC-11), and channel libraries, folders, file comments and the editing marker
// (workstream 4; AC-07, AC-09), through Odin's routes on in-memory repositories.
// channels-mysql.integration.test.js runs migration 0096 and the MySQL methods.

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const P = `/api/projects/${PROJECT}`;
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', projectRole: 'admin', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', projectRole: 'user', role: 'user' },
  other: { id: 'user-other', name: 'Olu Other', projectRole: 'user', role: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', role: 'user' },
  outsider: { id: 'user-outsider', name: 'Oz Outsider', projectRole: null, role: 'user' },
  admin: { id: 'user-admin', name: 'Ada Admin', projectRole: null, role: 'admin' },
};
const mention = (key) => `@[${USERS[key].name}](user:${USERS[key].id})`;

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-channels-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const changeLog = createInMemoryProjectChangeLog();
  const mailRepository = createInMemoryMailRepository();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog,
    fileStorage: storage,
    mailRepository,
    seed: {
      projectMemberships: { [PROJECT]: Object.values(USERS).filter((user) => user.projectRole).map((user) => ({ email: `${user.id}@acme.example`, id: user.id, name: user.name, role: user.projectRole })) },
      projects: [{ epics: [], id: PROJECT, name: 'Northwind rollout', status: 'In Progress', tenantId: TENANT_ID }],
    },
  });
  const liveEventBus = createLiveEventBus();
  const events = [];
  liveEventBus.subscribe(`project:${PROJECT}`, (event) => events.push(event));
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'channels-fixture', secret: 'disposable-channels-fixture-secret' });
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  // HTTP audit events, to check which writes are recorded.
  const audited = [];
  const auditWriter = { append: async (event) => { audited.push(event); } };
  const app = createApp({
    auditWriter,
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, liveEventBus, mailRepository, projectRepository, sessionsRepository, tokenService, workspaceModulesRepository,
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
  async function send(as, method, route, body, { clientId = null } = {}) {
    const response = await fetch(absolute(route), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(clientId ? { 'X-Odin-Client-Id': clientId } : {}) },
      method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await send(as, method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  async function channels(as = 'member') {
    return (await ok(as, 'GET', `${P}/channels`)).channels;
  }
  async function general(as = 'member') {
    return (await channels(as)).find((channel) => channel.isGeneral);
  }
  // A whole upload through the parts path, into a channel (and folder), or as a new version.
  async function upload(as, contents, start) {
    const bytes = Buffer.from(contents);
    const started = await ok(as, 'POST', `${P}/uploads`, { contentType: 'text/plain', fileSize: bytes.length, ...start }, 201);
    const signed = await ok(as, 'POST', `${P}/uploads/${started.upload.id}/parts`, { partNumbers: [1] });
    const put = await fetch(absolute(signed.parts[0].url), { body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, method: 'PUT' });
    assert.equal(put.status, 200, await put.text());
    return send(as, 'POST', `${P}/uploads/${started.upload.id}/complete`, {});
  }
  async function scanAll() {
    // The scan worker's result, without a scanner: every pending object is clean, with its MD5.
    for (const object of await projectRepository.listPendingScanObjects({ limit: 100 })) {
      const bytes = (await storage.read(object.storageKey)).bytes;
      await projectRepository.recordObjectScan({ md5: createHash('md5').update(bytes).digest('hex'), scanStatus: 'clean', storageKey: object.storageKey });
    }
  }
  const channelEvents = () => events.filter((event) => event.type === 'channel.updated');
  // A member's open project stream (GET /api/projects/:projectId/events): its events as they arrive.
  async function openStream(as) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(absolute(`${P}/events`), { headers: { Authorization: `Bearer ${tokens[as]}` }, signal: controller.signal });
    const stream = { events: [], status: response.status };
    if (response.status !== 200) return stream;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            stream.events.push({ data: data ? JSON.parse(data) : null, type: /^event: (.*)$/m.exec(chunk)?.[1] });
          }
        }
      } catch {
        // aborted
      }
    })();
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
  return { audited, openStream, waitFor, authRepository, changeLog, channelEvents, channels, events, general, mailRepository, ok, projectRepository, scanAll, send, upload, workspaceModulesRepository };
}

test('every project gets exactly one General channel, made the first time anyone lists channels', async (t) => {
  const { channels, projectRepository } = await fixture(t);
  const [first, second] = await Promise.all([channels('member'), channels('viewer')]);
  assert.deepEqual(first.map((channel) => channel.name), ['General']);
  assert.equal(second[0].id, first[0].id);
  assert.equal((await projectRepository.listChannels({ projectId: PROJECT, tenantId: TENANT_ID })).length, 1, 'one General however many look at once');
});

test('channel rights: members add and rename, viewers only read, decision rights archive and restore, General stays', async (t) => {
  const { general, ok, send } = await fixture(t);
  const generalChannel = await general();
  assert.deepEqual([generalChannel.canPost, generalChannel.canRename, generalChannel.canArchive], [true, false, false]);

  const created = await ok('member', 'POST', `${P}/channels`, { description: 'Pricing and proposal', name: 'Proposal' }, 201);
  assert.equal(created.channel.name, 'Proposal');
  assert.equal((await send('member', 'POST', `${P}/channels`, { name: 'proposal' })).body.details.code, 'channel_name_taken', 'names are unique in a project, whatever their case');
  assert.equal((await send('member', 'POST', `${P}/channels`, { name: 'General' })).status, 409, 'there is one General');
  const viewerTry = await send('viewer', 'POST', `${P}/channels`, { name: 'Viewers' });
  assert.deepEqual([viewerTry.status, viewerTry.body.details.code], [403, 'channel_read_only_member']);
  assert.equal((await send('outsider', 'GET', `${P}/channels`)).status, 404, 'someone outside the project sees nothing');
  assert.equal((await ok('viewer', 'GET', `${P}/channels`)).channels.length, 2, 'viewers see every channel');

  const renamed = await ok('member', 'PATCH', `${P}/channels/${created.channel.id}`, { name: 'Proposal v2' });
  assert.equal(renamed.channel.name, 'Proposal v2');
  assert.equal((await send('member', 'PATCH', `${P}/channels/${generalChannel.id}`, { name: 'Lobby' })).body.details.code, 'general_channel', 'General keeps its name');
  assert.equal((await ok('member', 'PATCH', `${P}/channels/${generalChannel.id}`, { description: 'Everyone' })).channel.description, 'Everyone');

  // Archiving needs decision rights; General never.
  assert.deepEqual([(await send('member', 'DELETE', `${P}/channels/${created.channel.id}`)).status], [403]);
  assert.equal((await send('lead', 'DELETE', `${P}/channels/${generalChannel.id}`)).body.details.code, 'general_channel');
  assert.equal((await send('admin', 'DELETE', `${P}/channels/${generalChannel.id}`)).status, 409, 'not for workspace admins either');
  const archived = await ok('lead', 'DELETE', `${P}/channels/${created.channel.id}`);
  assert.ok(archived.channel.archivedAt);
  assert.deepEqual([archived.channel.canPost, archived.channel.canRestore], [false, true]);

  // An archived channel is read-only.
  assert.equal((await send('member', 'POST', `${P}/channels/${created.channel.id}/posts`, { body: 'Late' })).body.details.code, 'channel_archived');
  assert.equal((await send('member', 'PATCH', `${P}/channels/${created.channel.id}`, { description: 'x' })).body.details.code, 'channel_archived');
  assert.equal((await send('member', 'POST', `${P}/channels/${created.channel.id}/folders`, { name: 'Drafts' })).body.details.code, 'channel_archived');
  assert.equal((await send('member', 'POST', `${P}/uploads`, { fileName: 'late.txt', fileSize: 4, targetId: created.channel.id, targetType: 'channel' })).body.details.code, 'channel_archived');
  assert.equal((await ok('member', 'GET', `${P}/channels/${created.channel.id}/posts`)).canPost, false, 'it can still be read');
  assert.equal((await send('member', 'POST', `${P}/channels/${created.channel.id}/restore`)).status, 403);
  const restored = await ok('admin', 'POST', `${P}/channels/${created.channel.id}/restore`);
  assert.equal(restored.channel.archivedAt, null, 'workspace admins have decision rights too');
  await ok('member', 'POST', `${P}/channels/${created.channel.id}/posts`, { body: 'Back again' }, 201);
});

test('posts: replies one level deep, author edits, delete in place, decision rights delete anyone’s, viewers cannot post', async (t) => {
  const { general, ok, send } = await fixture(t);
  const { id: channelId } = await general();
  const C = `${P}/channels/${channelId}`;
  const first = (await ok('member', 'POST', `${C}/posts`, { body: 'Kick-off **Thursday**' }, 201)).post;
  assert.deepEqual([first.author.name, first.isMine, first.canEdit, first.canReply], ['Mo Member', true, true, true]);
  const reply = (await ok('other', 'POST', `${C}/posts`, { body: 'Works for me', parentId: first.id }, 201)).post;
  assert.equal(reply.parentId, first.id);
  assert.equal((await send('member', 'POST', `${C}/posts`, { body: 'Deeper', parentId: reply.id })).body.details.code, 'reply_depth');
  assert.equal((await send('member', 'POST', `${C}/posts`, { body: '   ' })).body.details.code, 'post_empty');
  assert.equal((await send('viewer', 'POST', `${C}/posts`, { body: 'Hi' })).status, 403);

  const listed = await ok('viewer', 'GET', `${C}/posts`);
  assert.equal(listed.canPost, false);
  assert.deepEqual(listed.posts.map((post) => [post.body, post.replies.map((entry) => entry.body)]), [['Kick-off **Thursday**', ['Works for me']]]);
  assert.equal(listed.posts[0].canEdit, false, 'a viewer edits nothing');

  assert.equal((await send('other', 'PATCH', `${P}/posts/${first.id}`, { body: 'Hijack' })).body.details.code, 'not_author');
  const edited = (await ok('member', 'PATCH', `${P}/posts/${first.id}`, { body: 'Kick-off **Friday**' })).post;
  assert.ok(edited.editedAt);

  // Someone else's post: only decision rights delete it.
  assert.equal((await send('member', 'DELETE', `${P}/posts/${reply.id}`)).status, 403);
  const removed = (await ok('lead', 'DELETE', `${P}/posts/${reply.id}`)).post;
  assert.deepEqual([removed.deleted, removed.body], [true, '']);
  // The author's own: the thread keeps its place, and replies stay.
  await ok('other', 'POST', `${C}/posts`, { body: 'Still here', parentId: first.id }, 201);
  await ok('member', 'DELETE', `${P}/posts/${first.id}`);
  const after = await ok('member', 'GET', `${C}/posts`);
  assert.equal(after.posts.length, 1);
  assert.deepEqual([after.posts[0].deleted, after.posts[0].body, after.posts[0].canReply], [true, '', false]);
  assert.deepEqual(after.posts[0].replies.map((entry) => [entry.deleted, entry.body]), [[true, ''], [false, 'Still here']]);
  assert.equal((await send('member', 'PATCH', `${P}/posts/${first.id}`, { body: 'Undo' })).body.details.code, 'post_deleted');
  assert.equal((await send('other', 'POST', `${C}/posts`, { body: 'To a deleted one', parentId: first.id })).body.details.code, 'post_deleted');
});

test('mentions notify members once each and email nobody at once, and an edit notifies only people it adds', async (t) => {
  const { general, mailRepository, ok, send } = await fixture(t);
  const { id: channelId } = await general();
  // Mention email comes later, in the rolled-up digest, if the mention is still unread (Q-04).
  const mentionedIn = async (key) => (await ok(key, 'GET', '/api/me/notifications')).notifications.filter((entry) => entry.kind === 'mention');
  const people = (await ok('member', 'GET', `${P}/channels/${channelId}/mentionables`)).people;
  assert.ok(people.some((person) => person.ref === `user:${USERS.other.id}` && person.kind === 'team'));
  assert.ok(!people.some((person) => person.ref === `user:${USERS.member.id}`), 'the writer is not in their own list');

  const post = (await ok('member', 'POST', `${P}/channels/${channelId}/posts`, { body: `${mention('other')} can you check the SOW? @[Nobody](user:user-nobody)` }, 201)).post;
  assert.equal(post.body, `${mention('other')} can you check the SOW? @Nobody`, 'a tag for someone outside the project becomes plain text');
  let [tagged] = await mentionedIn('other');
  assert.equal(tagged.title, 'Mo Member mentioned you in #General');
  // Members open chat items in Odin Chat (docs/odin-chat/plan.md, Notifications).
  assert.equal(tagged.path, `/chat/channels/${PROJECT}/${channelId}?post=${post.id}`);
  assert.equal(mailRepository.state.queue.length, 0, 'no email at once');

  // Tagging yourself notifies nobody; an edit notifies only who it adds.
  const edited = await ok('member', 'PATCH', `${P}/posts/${post.id}`, { body: `${mention('other')} and ${mention('lead')} and ${mention('member')}` });
  assert.deepEqual(edited.mentioned, [USERS.lead.id]);
  assert.equal((await mentionedIn('other')).length, 1);
  assert.equal((await mentionedIn('lead')).length, 1);
  assert.equal((await mentionedIn('member')).length, 0);
  // A second post tagging the same person is its own notification.
  await ok('lead', 'POST', `${P}/channels/${channelId}/posts`, { body: `${mention('other')} again` }, 201);
  [tagged] = await mentionedIn('other');
  assert.equal((await mentionedIn('other')).length, 2);
  assert.equal(tagged.title, 'Lena Lead mentioned you in #General', 'newest first');
  assert.equal(mailRepository.state.queue.length, 0);
  // Stakeholder tags keep their form for guests (workstream 6) but need a guest in the channel.
  const guestTag = (await ok('member', 'POST', `${P}/channels/${channelId}/posts`, { body: '@[Sam Customer](stakeholder:stk-1) hello' }, 201)).post;
  assert.equal(guestTag.body, '@Sam Customer hello');
  assert.equal((await send('viewer', 'GET', `${P}/channels/${channelId}/mentionables`)).status, 200, 'viewers may read who is here');
});

test('stakeholder tags resolve for a channel’s guests and are stored as tokens', async (t) => {
  const { general, ok, projectRepository } = await fixture(t);
  const { id: channelId } = await general();
  projectRepository.state.channelGuests.push({ channelId, email: 'sam@customer.example', invitedAt: new Date().toISOString(), name: 'Sam Customer', stakeholderId: 'stk-1', tenantId: TENANT_ID });
  const people = (await ok('member', 'GET', `${P}/channels/${channelId}/mentionables`)).people;
  assert.ok(people.some((person) => person.ref === 'stakeholder:stk-1' && person.kind === 'stakeholder'));
  const post = (await ok('member', 'POST', `${P}/channels/${channelId}/posts`, { body: '@[Sam](stakeholder:stk-1) welcome' }, 201)).post;
  assert.equal(post.body, '@[Sam Customer](stakeholder:stk-1) welcome', 'a resolved tag takes the person’s current name');
});

test('long channels page newest first with a cursor', async (t) => {
  const { general, ok, send } = await fixture(t);
  const { id: channelId } = await general();
  for (let index = 1; index <= 35; index += 1) await ok(index % 2 ? 'member' : 'other', 'POST', `${P}/channels/${channelId}/posts`, { body: `Message ${index}` }, 201);
  const first = await ok('member', 'GET', `${P}/channels/${channelId}/posts`);
  assert.equal(first.posts.length, 30);
  assert.deepEqual([first.posts[0].body, first.posts.at(-1).body], ['Message 35', 'Message 6']);
  assert.ok(first.nextCursor);
  const second = await ok('member', 'GET', `${P}/channels/${channelId}/posts?before=${encodeURIComponent(first.nextCursor)}`);
  assert.deepEqual(second.posts.map((post) => post.body), ['Message 5', 'Message 4', 'Message 3', 'Message 2', 'Message 1']);
  assert.equal(second.nextCursor, null);
  assert.equal((await ok('member', 'GET', `${P}/channels/${channelId}/posts?limit=40`)).posts.length, 35);
  assert.equal((await send('member', 'GET', `${P}/channels/${channelId}/posts?before=garbage`)).body.details.code, 'invalid_cursor');
  const cursor = { createdAt: '2026-11-14T10:00:00.000Z', id: 'abc' };
  assert.deepEqual(decodePostCursor(encodePostCursor(cursor)), cursor);
});

test('unread counts: posts by others after the last read, per channel and per engagement, cleared by reading', async (t) => {
  const { channels, general, ok, workspaceModulesRepository } = await fixture(t);
  const { id: generalId } = await general();
  const side = (await ok('member', 'POST', `${P}/channels`, { name: 'Side' }, 201)).channel;
  await ok('member', 'POST', `${P}/channels/${generalId}/posts`, { body: 'One' }, 201);
  await ok('member', 'POST', `${P}/channels/${generalId}/posts`, { body: 'Two' }, 201);
  const reply = await ok('member', 'POST', `${P}/channels/${side.id}/posts`, { body: 'Three' }, 201);
  const unread = async (as) => Object.fromEntries((await channels(as)).map((channel) => [channel.name, channel.unreadCount]));
  assert.deepEqual(await unread('other'), { General: 2, Side: 1 });
  assert.deepEqual(await unread('member'), { General: 0, Side: 0 }, 'your own posts are read');
  await ok('other', 'POST', `${P}/channels/${generalId}/read`);
  assert.deepEqual(await unread('other'), { General: 0, Side: 1 });
  await ok('lead', 'DELETE', `${P}/posts/${reply.post.id}`);
  assert.deepEqual(await unread('other'), { General: 0, Side: 0 }, 'a deleted post is not unread');
  await ok('member', 'POST', `${P}/channels/${generalId}/posts`, { body: 'Four' }, 201);
  assert.deepEqual(await unread('other'), { General: 1, Side: 0 });
  // The viewer can read, so marks read too.
  await ok('viewer', 'POST', `${P}/channels/${generalId}/read`);
  assert.deepEqual(await unread('viewer'), { General: 0, Side: 0 });

  // Per engagement, on the Engagements page.
  await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
  const engagement = (await ok('member', 'POST', '/api/engagements', { customer: 'Northwind', name: 'Pilot' }, 201)).project;
  const engagementGeneral = (await ok('member', 'GET', `/api/projects/${engagement.id}/channels`)).channels[0];
  await ok('member', 'POST', `/api/projects/${engagement.id}/channels/${engagementGeneral.id}/posts`, { body: 'Hello' }, 201);
  const listed = await ok('admin', 'GET', '/api/engagements');
  assert.equal(listed.engagements.find((entry) => entry.id === engagement.id).unreadCount, 1);
  assert.equal((await ok('member', 'GET', '/api/engagements')).engagements.find((entry) => entry.id === engagement.id).unreadCount, 0);
});

test('every channel, post, file, version, folder and comment write publishes channel.updated with actor and client id', async (t) => {
  const { channelEvents, events, general, ok, scanAll, send, upload } = await fixture(t);
  const { id: channelId } = await general();
  const seen = () => channelEvents().map((event) => `${event.area}${event.fileId ? ':file' : ''}`);
  const created = await send('member', 'POST', `${P}/channels`, { name: 'Deal room' }, { clientId: 'tab-a' });
  const last = channelEvents().at(-1);
  assert.deepEqual([last.channelId, last.area, last.actor, last.originClientId, last.projectId], [created.body.channel.id, 'members', { id: USERS.member.id, name: 'Mo Member' }, 'tab-a', PROJECT]);
  assert.equal(last.body, undefined, 'events carry no text');
  events.length = 0;

  const post = (await ok('member', 'POST', `${P}/channels/${channelId}/posts`, { body: 'Hello' }, 201)).post;
  await ok('member', 'PATCH', `${P}/posts/${post.id}`, { body: 'Hello there' });
  await ok('member', 'DELETE', `${P}/posts/${post.id}`);
  assert.deepEqual(seen(), ['posts', 'posts', 'posts']);
  assert.ok(!events.some((event) => event.type === 'project.assets.invalidated'), 'a conversation does not reload project screens');

  events.length = 0;
  const folder = (await ok('member', 'POST', `${P}/channels/${channelId}/folders`, { name: 'Drafts' }, 201)).folder;
  await ok('member', 'PATCH', `${P}/folders/${folder.id}`, { name: 'Draft work' });
  const saved = await upload('member', 'v1', { fileName: 'sow.txt', folderId: folder.id, targetId: channelId, targetType: 'channel' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  await scanAll();
  const fileId = saved.body.file.id;
  await upload('member', 'v2', { expectedVersion: 1, fileId, fileName: 'sow.txt' });
  await scanAll();
  await ok('member', 'POST', `${P}/files/${fileId}/versions/1/restore`, { expectedVersion: 2 });
  await ok('lead', 'DELETE', `${P}/files/${fileId}/versions/2`);
  await ok('member', 'POST', `${P}/files/${fileId}/comments`, { body: 'Looks right' }, 201);
  await ok('member', 'PUT', `${P}/files/${fileId}/editing`);
  await ok('member', 'DELETE', `${P}/files/${fileId}/editing`);
  const base64 = await ok('member', 'POST', `${P}/files`, { fileContentsBase64: Buffer.from('small').toString('base64'), fileName: 'note.txt', fileType: 'text/plain', targetId: channelId, targetType: 'channel' }, 201);
  await ok('member', 'DELETE', `/api/files/${base64.file.id}`);
  await ok('member', 'DELETE', `${P}/folders/${(await ok('member', 'POST', `${P}/channels/${channelId}/folders`, { name: 'Empty' }, 201)).folder.id}`);
  assert.deepEqual(seen(), ['files', 'files', 'files', 'files', 'files:file', 'files:file', 'files:file', 'files:file', 'files:file', 'files', 'files:file', 'files', 'files']);
  assert.ok(channelEvents().every((event) => event.channelId === channelId && event.actor?.id));
});

test('folders: create, unique names within a parent, rename, move within the channel, delete only when empty', async (t) => {
  const { general, ok, send, upload } = await fixture(t);
  const { id: channelId } = await general();
  const other = (await ok('member', 'POST', `${P}/channels`, { name: 'Elsewhere' }, 201)).channel;
  const F = `${P}/channels/${channelId}/folders`;
  const proposals = (await ok('member', 'POST', F, { name: 'Proposals' }, 201)).folder;
  const contracts = (await ok('member', 'POST', F, { name: 'Contracts' }, 201)).folder;
  assert.equal((await send('member', 'POST', F, { name: 'proposals' })).body.details.code, 'folder_name_taken');
  const drafts = (await ok('member', 'POST', F, { name: 'Drafts', parentId: proposals.id }, 201)).folder;
  await ok('member', 'POST', F, { name: 'Drafts', parentId: contracts.id }, 201);
  assert.equal((await send('member', 'POST', F, { name: 'a/b' })).body.details.code, 'folder_name_invalid');
  assert.equal((await send('viewer', 'POST', F, { name: 'Viewer' })).status, 403);
  const otherFolder = (await ok('member', 'POST', `${P}/channels/${other.id}/folders`, { name: 'Theirs' }, 201)).folder;
  assert.equal((await send('member', 'POST', F, { name: 'Cross', parentId: otherFolder.id })).body.details.code, 'invalid_folder');

  assert.equal((await ok('member', 'PATCH', `${P}/folders/${proposals.id}`, { name: 'Bids' })).folder.name, 'Bids');
  assert.equal((await send('member', 'PATCH', `${P}/folders/${drafts.id}`, { parentId: contracts.id })).body.details.code, 'folder_name_taken', 'a move must not collide either');
  assert.equal((await send('member', 'PATCH', `${P}/folders/${proposals.id}`, { parentId: drafts.id })).body.details.code, 'folder_cycle');
  assert.equal((await send('member', 'PATCH', `${P}/folders/${drafts.id}`, { parentId: otherFolder.id })).body.details.code, 'invalid_folder', 'moves stay within the channel');
  assert.equal((await ok('member', 'PATCH', `${P}/folders/${drafts.id}`, { parentId: null })).folder.parentId, null);

  // Uploads go into a folder; the same name in the same folder is a new version, elsewhere a new file.
  const first = await upload('member', 'one', { fileName: 'plan.txt', folderId: drafts.id, targetId: channelId, targetType: 'channel' });
  const again = await upload('member', 'two', { fileName: 'PLAN.txt', folderId: drafts.id, targetId: channelId, targetType: 'channel' });
  assert.deepEqual([again.body.file.id, again.body.file.version], [first.body.file.id, 2]);
  const top = await upload('member', 'three', { fileName: 'plan.txt', targetId: channelId, targetType: 'channel' });
  assert.notEqual(top.body.file.id, first.body.file.id);
  assert.equal(top.body.file.folderId, null);
  assert.equal((await send('member', 'POST', `${P}/uploads`, { fileName: 'x.txt', fileSize: 3, folderId: otherFolder.id, targetId: channelId, targetType: 'channel' })).body.details.code, 'invalid_folder');

  assert.equal((await send('member', 'DELETE', `${P}/folders/${drafts.id}`)).body.details.code, 'folder_not_empty');
  assert.equal((await send('member', 'DELETE', `${P}/folders/${contracts.id}`)).body.details.code, 'folder_not_empty', 'a folder with a folder in it stays');
  const listed = (await ok('viewer', 'GET', F)).folders;
  assert.deepEqual(listed.map((folder) => folder.name), ['Bids', 'Contracts', 'Drafts', 'Drafts']);
  await ok('member', 'DELETE', `/api/files/${first.body.file.id}`);
  await ok('member', 'DELETE', `${P}/folders/${drafts.id}`);
  assert.equal((await ok('member', 'GET', F)).folders.length, 3);
  assert.deepEqual([...folderPaths([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }]).values()], ['A', 'A / B']);
});

test('the project Files view lists channel files with their channel and folder; attachments land in the library', async (t) => {
  const { general, ok, send, upload } = await fixture(t);
  const { id: channelId } = await general();
  const side = (await ok('member', 'POST', `${P}/channels`, { name: 'Side' }, 201)).channel;
  const folder = (await ok('member', 'POST', `${P}/channels/${channelId}/folders`, { name: 'Proposals' }, 201)).folder;
  const sub = (await ok('member', 'POST', `${P}/channels/${channelId}/folders`, { name: 'Drafts', parentId: folder.id }, 201)).folder;
  const attached = (await upload('member', 'deck', { fileName: 'deck.pptx', folderId: sub.id, targetId: channelId, targetType: 'channel' })).body.file;
  const elsewhere = (await upload('member', 'other', { fileName: 'side.txt', targetId: side.id, targetType: 'channel' })).body.file;

  const post = (await ok('member', 'POST', `${P}/channels/${channelId}/posts`, { body: 'Deck attached', fileIds: [attached.id] }, 201)).post;
  assert.deepEqual(post.attachments.map((file) => file.fileName), ['deck.pptx']);
  assert.equal((await ok('member', 'POST', `${P}/channels/${channelId}/posts`, { fileIds: [attached.id] }, 201)).post.body, '', 'a file alone is a post');
  assert.equal((await send('member', 'POST', `${P}/channels/${channelId}/posts`, { body: 'Wrong one', fileIds: [elsewhere.id] })).body.details.code, 'attachment_not_in_channel');
  assert.equal((await ok('member', 'GET', `${P}/channels/${channelId}/posts`)).posts.at(-1).attachments[0].id, attached.id);

  const library = (await ok('member', 'GET', `${P}/files?targetId=${channelId}&targetType=channel`)).files;
  assert.deepEqual(library.map((file) => [file.fileName, file.folderPath]), [['deck.pptx', 'Proposals / Drafts']]);
  const vault = (await ok('viewer', 'GET', `${P}/files?targetId=${PROJECT}&targetType=project`)).files;
  const row = vault.find((file) => file.id === attached.id);
  assert.deepEqual([row.targetType, row.targetName, row.folderPath], ['channel', 'General', 'Proposals / Drafts']);
  assert.ok(vault.some((file) => file.id === elsewhere.id && file.targetName === 'Side'));
  assert.ok((await ok('member', 'GET', `${P}/file-storage`)).storage.bytes >= 9, 'channel files count toward storage used');

  // A deleted file drops out of the post that carried it.
  await ok('member', 'DELETE', `/api/files/${attached.id}`);
  assert.deepEqual((await ok('member', 'GET', `${P}/channels/${channelId}/posts`)).posts.at(-1).attachments, []);
});

test('file comments record the version each was made on, reply one level, and go with their file (AC-07)', async (t) => {
  const { general, mailRepository, ok, scanAll, send, upload } = await fixture(t);
  const { id: channelId } = await general();
  const file = (await upload('member', 'v1', { fileName: 'sow.txt', targetId: channelId, targetType: 'channel' })).body.file;
  await scanAll();
  const C = `${P}/files/${file.id}/comments`;
  const first = (await ok('member', 'POST', C, { body: `Section 2 is wrong ${mention('other')}` }, 201)).comment;
  assert.equal(first.fileVersion, 1);
  assert.equal(mailRepository.state.queue.length, 0, 'mentions in comments email only through the digest');
  const [commentMention] = (await ok('other', 'GET', '/api/me/notifications')).notifications;
  assert.equal(commentMention.title, 'Mo Member mentioned you in sow.txt');
  assert.equal(commentMention.path, `/chat/channels/${PROJECT}/${channelId}?file=${file.id}&tab=files`);
  await upload('other', 'v2', { expectedVersion: 1, fileId: file.id, fileName: 'sow.txt' });
  const second = (await ok('other', 'POST', C, { body: 'Fixed in this one', parentId: first.id }, 201)).comment;
  assert.equal(second.fileVersion, 2);
  assert.equal((await send('member', 'POST', C, { body: 'Too deep', parentId: second.id })).body.details.code, 'reply_depth');
  assert.equal((await send('viewer', 'POST', C, { body: 'Viewer' })).status, 403);
  const listed = await ok('viewer', 'GET', C);
  assert.equal(listed.currentVersion, 2);
  assert.deepEqual(listed.comments.map((comment) => [comment.fileVersion, comment.replies.map((reply) => reply.fileVersion)]), [[1, [2]]]);
  assert.ok((await ok('member', 'GET', `${P}/files/${file.id}/mentionables`)).people.length >= 3);
  // Edits and deletes use the post routes.
  assert.equal((await ok('member', 'PATCH', `${P}/posts/${first.id}`, { body: 'Section 2 was wrong' })).post.body, 'Section 2 was wrong');
  await ok('lead', 'DELETE', `${P}/posts/${second.id}`);
  assert.equal((await ok('member', 'GET', C)).comments[0].replies[0].deleted, true);
  // Comments on vault files work too.
  const vaultFile = await ok('member', 'POST', `${P}/files`, { fileContentsBase64: Buffer.from('x').toString('base64'), fileName: 'vault.txt', fileType: 'text/plain', targetId: PROJECT, targetType: 'project' }, 201);
  assert.equal((await ok('member', 'POST', `${P}/files/${vaultFile.file.id}/comments`, { body: 'In the vault' }, 201)).channelId, null);

  await ok('member', 'DELETE', `/api/files/${file.id}`);
  assert.equal((await send('member', 'GET', C)).status, 404);
  assert.equal((await send('member', 'PATCH', `${P}/posts/${first.id}`, { body: 'Gone' })).status, 404, 'a deleted file’s comments go with it');
});

test('the editing marker shows to others, asks a second uploader to confirm, and clears on the editor’s upload, their clear or after 24 hours (AC-09)', async (t) => {
  const { general, ok, projectRepository, scanAll, send, upload } = await fixture(t);
  const { id: channelId } = await general();
  const file = (await upload('member', 'v1', { fileName: 'model.xlsx', targetId: channelId, targetType: 'channel' })).body.file;
  await scanAll();
  const marked = await ok('member', 'PUT', `${P}/files/${file.id}/editing`);
  assert.deepEqual([marked.editing.userId, marked.editing.name], [USERS.member.id, 'Mo Member']);
  const seenByOther = (await ok('other', 'GET', `${P}/files?targetId=${channelId}&targetType=channel`)).files[0].editing;
  assert.deepEqual([seenByOther.name, Boolean(Date.parse(seenByOther.since))], ['Mo Member', true]);
  assert.equal((await send('viewer', 'PUT', `${P}/files/${file.id}/editing`)).status, 403);

  // Someone else uploading asks first, by new version or by the same name.
  const start = { contentType: 'text/plain', expectedVersion: 1, fileId: file.id, fileName: 'model.xlsx', fileSize: 2 };
  const refused = await send('other', 'POST', `${P}/uploads`, start);
  assert.deepEqual([refused.status, refused.body.details.code, refused.body.details.editing.name], [409, 'file_being_edited', 'Mo Member']);
  assert.equal((await send('other', 'POST', `${P}/uploads`, { contentType: 'text/plain', fileName: 'model.xlsx', fileSize: 2, targetId: channelId, targetType: 'channel' })).body.details.code, 'file_being_edited');
  const base64Version = await send('other', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: Buffer.from('b6').toString('base64') });
  assert.equal(base64Version.body.details.code, 'file_being_edited');
  const confirmed = await upload('other', 'v2', { confirmEditing: true, expectedVersion: 1, fileId: file.id, fileName: 'model.xlsx' });
  assert.equal(confirmed.body.file.version, 2);
  assert.equal(confirmed.body.file.editing?.userId, USERS.member.id, 'someone else’s upload leaves the marker');
  // The editor uploading clears it; the version check still applies.
  assert.equal((await send('member', 'POST', `${P}/uploads`, { ...start, expectedVersion: 1 })).body.details.code, 'file_changed');
  const own = await upload('member', 'v3', { expectedVersion: 2, fileId: file.id, fileName: 'model.xlsx' });
  assert.equal(own.body.file.editing, null);

  // Clearing: the editor or decision rights.
  await ok('member', 'PUT', `${P}/files/${file.id}/editing`);
  assert.equal((await send('other', 'DELETE', `${P}/files/${file.id}/editing`)).body.details.code, 'editing_by_other');
  await ok('lead', 'DELETE', `${P}/files/${file.id}/editing`);
  await ok('member', 'PUT', `${P}/files/${file.id}/editing`);
  await ok('member', 'DELETE', `${P}/files/${file.id}/editing`);
  assert.equal((await ok('other', 'GET', `${P}/files?targetId=${channelId}&targetType=channel`)).files[0].editing, null);

  // After 24 hours the marker is gone, and uploads need no question.
  await ok('member', 'PUT', `${P}/files/${file.id}/editing`);
  projectRepository.state.files.find((entry) => entry.id === file.id).editingSince = new Date(Date.now() - EDITING_MARKER_MS - 1000).toISOString();
  assert.equal((await ok('other', 'GET', `${P}/files?targetId=${channelId}&targetType=channel`)).files[0].editing, null);
  assert.equal((await send('other', 'POST', `${P}/uploads`, { ...start, expectedVersion: 3 })).status, 201);
  assert.equal(editingMarker({ editingBy: 'u', editingSince: new Date(Date.now() - EDITING_MARKER_MS + 60_000).toISOString() })?.userId, 'u');
});

test('versions in channel libraries: restore makes a new version, decision rights delete old ones, archived libraries refuse both', async (t) => {
  const { general, ok, scanAll, send, upload } = await fixture(t);
  const deal = (await ok('member', 'POST', `${P}/channels`, { name: 'Deal' }, 201)).channel;
  await general();
  const file = (await upload('member', 'one', { fileName: 'terms.txt', targetId: deal.id, targetType: 'channel' })).body.file;
  await scanAll();
  await upload('member', 'two', { expectedVersion: 1, fileId: file.id, fileName: 'terms.txt' });
  await scanAll();
  const restored = await ok('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 2 });
  assert.deepEqual([restored.file.version, restored.file.versionNote], [3, 'Restored from version 1']);
  const conflict = await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 2 });
  assert.equal(conflict.status, 409, 'restoring from a stale version is a conflict');
  assert.equal((await send('member', 'DELETE', `${P}/files/${file.id}/versions/2`)).status, 404, 'members cannot delete versions');
  const deleted = await ok('lead', 'DELETE', `${P}/files/${file.id}/versions/2`);
  assert.equal(deleted.deletedVersion, 2);
  assert.equal((await send('lead', 'DELETE', `${P}/files/${file.id}/versions/3`)).body.details.code, 'current_version');
  const versions = (await ok('member', 'GET', `${P}/files/${file.id}/versions`)).versions;
  assert.deepEqual(versions.map((version) => [version.version, Boolean(version.deletedAt)]), [[3, false], [2, true], [1, false]]);
  assert.equal((await ok('member', 'GET', `${P}/files/${file.id}/download-url?version=1`)).version, 1, 'earlier versions still download');

  await ok('lead', 'DELETE', `${P}/channels/${deal.id}`);
  const code = async (method, route, body) => (await send('member', method, route, body)).body?.details?.code;
  assert.equal(await code('POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 3 }), 'channel_archived');
  assert.equal(await code('POST', `${P}/uploads`, { expectedVersion: 3, fileId: file.id, fileName: 'terms.txt', fileSize: 3 }), 'channel_archived');
  assert.equal(await code('DELETE', `/api/files/${file.id}`), 'channel_archived');
  assert.equal(await code('PUT', `${P}/files/${file.id}/editing`), 'channel_archived');
  assert.equal(await code('POST', `${P}/files/${file.id}/comments`, { body: 'x' }), 'channel_archived');
  assert.equal((await ok('member', 'GET', `${P}/files?targetId=${deal.id}&targetType=channel`)).canWrite, false);
  assert.equal((await ok('member', 'GET', `${P}/files/${file.id}/download-url`)).fileName, 'terms.txt', 'it can still be downloaded');
});

test('an engagement’s customer and owner change with decision rights; the owner must be a member', async (t) => {
  const { ok, projectRepository, send, workspaceModulesRepository } = await fixture(t);
  await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id });
  const engagement = (await ok('member', 'POST', '/api/engagements', { customer: 'Northwind', name: 'Pilot' }, 201)).project;
  const E = `/api/projects/${engagement.id}`;
  // The creator is its admin; a plain member joins to be named owner.
  projectRepository.state.projectMemberships.get(engagement.id).push({ email: `${USERS.other.id}@acme.example`, id: USERS.other.id, name: USERS.other.name, role: 'user' });
  assert.equal((await ok('member', 'PATCH', `${E}/engagement`, { ownerId: USERS.other.id })).project.engagementOwnerId, USERS.other.id);
  const updated = await send('member', 'PATCH', `${E}/engagement`, { customer: 'Northwind Traders' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.project.engagementCustomer, 'Northwind Traders');
  assert.equal((await send('member', 'PATCH', `${E}/engagement`, { ownerId: USERS.outsider.id })).body.details.code, 'owner_not_member');
  assert.equal((await send('other', 'PATCH', `${E}/engagement`, { customer: 'Nope' })).status, 404, 'without decision rights it is not there');
  const engagements = (await ok('member', 'GET', '/api/engagements')).engagements;
  assert.equal(engagements.find((entry) => entry.id === engagement.id).customer, 'Northwind Traders');
});

test('reactions: anyone who can post adds and takes back emoji; counts, mine and who; limits; deleted posts have none; a live event', async (t) => {
  const { channelEvents, general, ok, send } = await fixture(t);
  const { id: channelId } = await general();
  const C = `${P}/channels/${channelId}`;
  const post = (await ok('member', 'POST', `${C}/posts`, { body: 'Ship it?' }, 201)).post;
  assert.deepEqual([post.reactions, post.canReact], [[], true]);
  const react = (as, emoji, reacted = true) => ok(as, 'PUT', `${P}/posts/${post.id}/reactions`, { emoji, reacted });

  const before = channelEvents().length;
  let result = await react('member', '👍');
  assert.deepEqual(result.reactions, [{ count: 1, emoji: '👍', mine: true, people: [{ id: USERS.member.id, isViewer: true, name: 'Mo Member', type: 'user' }] }]);
  assert.equal(result.channelId, channelId);
  assert.ok(channelEvents().length > before, 'others hear of it');
  await react('member', '👍');
  await react('other', '👍');
  await react('other', '🎉');
  await react('lead', '👨‍👩‍👧‍👦');
  const listed = (await ok('other', 'GET', `${C}/posts`)).posts[0].reactions;
  assert.deepEqual(listed.map(({ count, emoji, mine }) => [emoji, count, mine]), [['👍', 2, true], ['🎉', 1, true], ['👨‍👩‍👧‍👦', 1, false]], 'twice is still once; first used first');
  assert.deepEqual(listed[0].people.map((person) => person.name), ['Mo Member', 'Olu Other']);
  assert.deepEqual((await ok('lead', 'GET', `${C}/posts`)).posts[0].reactions.map((entry) => entry.mine), [false, false, true], 'mine is per person');

  result = await react('member', '👍', false);
  assert.deepEqual(result.reactions.map(({ count, emoji, mine }) => [emoji, count, mine]), [['👍', 1, false], ['🎉', 1, false], ['👨‍👩‍👧‍👦', 1, false]]);
  await react('member', '🙏', false);

  // Text is not an emoji; viewers and outsiders cannot react; the post must be here.
  for (const emoji of ['ok', 'a', '1', '👍 nice', '']) assert.equal((await send('member', 'PUT', `${P}/posts/${post.id}/reactions`, { emoji, reacted: true })).status, 400, JSON.stringify(emoji));
  assert.equal((await send('viewer', 'PUT', `${P}/posts/${post.id}/reactions`, { emoji: '👍', reacted: true })).status, 403);
  assert.equal((await ok('viewer', 'GET', `${C}/posts`)).posts[0].canReact, false);
  assert.equal((await send('outsider', 'PUT', `${P}/posts/${post.id}/reactions`, { emoji: '👍', reacted: true })).status, 404, 'outside the project it is not there');
  assert.equal((await send('member', 'PUT', `${P}/posts/no-such-post/reactions`, { emoji: '👍', reacted: true })).status, 404);

  // One person adds at most 20 different emoji to one message.
  const many = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋'];
  const reply = (await ok('member', 'POST', `${C}/posts`, { body: 'React away', parentId: post.id }, 201)).post;
  for (const emoji of many.slice(0, 20)) await ok('member', 'PUT', `${P}/posts/${reply.id}/reactions`, { emoji, reacted: true });
  assert.equal((await send('member', 'PUT', `${P}/posts/${reply.id}/reactions`, { emoji: many[20], reacted: true })).body.details.code, 'too_many_reactions');
  assert.equal((await ok('member', 'GET', `${C}/posts`)).posts[0].replies[0].reactions.length, 20, 'replies carry theirs');

  // An edit keeps them; a deleted post shows none and takes no more.
  assert.equal((await ok('member', 'PATCH', `${P}/posts/${post.id}`, { body: 'Ship it!' })).post.reactions.length, 3);
  await ok('member', 'DELETE', `${P}/posts/${post.id}`);
  const gone = (await ok('member', 'GET', `${C}/posts`)).posts[0];
  assert.deepEqual([gone.reactions, gone.canReact], [[], false]);
  assert.equal((await send('other', 'PUT', `${P}/posts/${post.id}/reactions`, { emoji: '👍', reacted: true })).body.details.code, 'post_deleted');
});

test('a reply to a reply keeps which one it answers; same thread only, not a deleted one; the quoted author hears of it once', async (t) => {
  const { general, ok, send } = await fixture(t);
  const { id: channelId } = await general();
  const C = `${P}/channels/${channelId}`;
  const root = (await ok('member', 'POST', `${C}/posts`, { body: 'Agenda for Thursday' }, 201)).post;
  const first = (await ok('other', 'POST', `${C}/posts`, { body: 'Add the **budget** review', parentId: root.id }, 201)).post;
  assert.equal(first.canReply, true, 'Reply shows on a reply too');
  const answer = (await ok('lead', 'POST', `${C}/posts`, { body: 'Agreed', parentId: root.id, replyToId: first.id }, 201)).post;
  assert.deepEqual([answer.parentId, answer.replyToId], [root.id, first.id]);
  // Olu, whose reply Lena answered, hears of it once, as anyone in the thread does.
  const heard = (await ok('other', 'GET', '/api/me/notifications')).notifications.filter((entry) => entry.path.includes(answer.id));
  assert.deepEqual(heard.map((entry) => entry.kind), ['thread_reply']);
  const thread = (await ok('member', 'GET', `${C}/posts`)).posts[0].replies;
  assert.deepEqual(thread.map((entry) => [entry.body, entry.replyToId]), [['Add the **budget** review', null], ['Agreed', first.id]]);
  // Editing keeps it.
  assert.equal((await ok('lead', 'PATCH', `${P}/posts/${answer.id}`, { body: 'Agreed, 30 minutes' })).post.replyToId, first.id);
  // Answering the first post itself needs no replyToId.
  assert.equal((await ok('lead', 'POST', `${C}/posts`, { body: 'Also', parentId: root.id, replyToId: root.id }, 201)).post.replyToId, null);


  const elsewhere = (await ok('member', 'POST', `${C}/posts`, { body: 'Other thread' }, 201)).post;
  const otherReply = (await ok('other', 'POST', `${C}/posts`, { body: 'In the other thread', parentId: elsewhere.id }, 201)).post;
  assert.equal((await send('lead', 'POST', `${C}/posts`, { body: 'Crossed', parentId: root.id, replyToId: otherReply.id })).body.details.code, 'reply_to_other_thread');
  assert.equal((await send('lead', 'POST', `${C}/posts`, { body: 'No thread', replyToId: first.id })).body.details.code, 'reply_to_without_thread');
  await ok('other', 'DELETE', `${P}/posts/${first.id}`);
  assert.equal((await send('lead', 'POST', `${C}/posts`, { body: 'Late', parentId: root.id, replyToId: first.id })).body.details.code, 'post_deleted');
  // The answer still points at it; the app shows "Deleted message".
  const after = (await ok('member', 'GET', `${C}/posts`)).posts.find((entry) => entry.id === root.id).replies;
  assert.deepEqual(after.filter((entry) => entry.replyToId === first.id).map((entry) => entry.body), ['Agreed, 30 minutes']);
  assert.equal(after.find((entry) => entry.id === first.id).deleted, true);
});

test('typing: only people who can post send it, it reaches every reader of the channel but the typer, and nothing is stored or audited', async (t) => {
  const { audited, events, general, ok, openStream, send, waitFor } = await fixture(t);
  const { id: channelId } = await general();
  const C = `${P}/channels/${channelId}`;
  const thread = (await ok('member', 'POST', `${C}/posts`, { body: 'Thread' }, 201)).post;
  const typingEvents = () => events.filter((event) => event.type === 'channel.typing');

  // Readers: the typer, a viewer who can read but not post, and someone outside the project.
  const own = await openStream('member');
  const viewer = await openStream('viewer');
  const outsider = await openStream('outsider');
  assert.equal(outsider.status, 404, 'no stream for someone who cannot read the project');
  await waitFor(() => own.events.some((event) => event.type === 'connected') && viewer.events.some((event) => event.type === 'connected'), 'both streams');

  events.length = 0;
  audited.length = 0;
  const response = await send('member', 'POST', `${C}/typing`, { typing: true }, { clientId: 'tab-a' });
  assert.deepEqual([response.status, response.body], [200, { ok: true }]);
  await ok('member', 'POST', `${C}/typing`, { parentId: thread.id, typing: true });
  await ok('member', 'POST', `${C}/typing`, { typing: false });
  assert.deepEqual(typingEvents().map((event) => [event.channelId, event.parentId, event.typing, event.actor.id, event.actor.name, event.actor.type]), [
    [channelId, null, true, USERS.member.id, 'Mo Member', 'user'],
    [channelId, thread.id, true, USERS.member.id, 'Mo Member', 'user'],
    [channelId, null, false, USERS.member.id, 'Mo Member', 'user'],
  ]);
  assert.equal(typingEvents()[0].originClientId, 'tab-a');
  assert.ok(!events.some((event) => event.type === 'project.assets.invalidated' || event.type === 'channel.updated'), 'typing reloads no screen');
  assert.equal(audited.length, 0, 'typing is not an audit event');

  await waitFor(() => viewer.events.filter((event) => event.type === 'channel.typing').length === 3, 'the viewer to see all three');
  assert.equal(viewer.events.find((event) => event.type === 'channel.typing').data.actor.name, 'Mo Member');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(own.events.filter((event) => event.type === 'channel.typing').length, 0, 'never your own typing');

  // Who may send it: the same checks as posting.
  events.length = 0;
  assert.equal((await send('viewer', 'POST', `${C}/typing`, { typing: true })).status, 403);
  assert.equal((await send('outsider', 'POST', `${C}/typing`, { typing: true })).status, 404);
  assert.equal((await send('member', 'POST', `${P}/channels/no-such-channel/typing`, { typing: true })).status, 404);
  assert.equal((await send('member', 'POST', `${C}/typing`, { parentId: 'no-such-post', typing: true })).status, 404);
  assert.equal((await send('member', 'POST', `${C}/typing`, { text: 'secret', typing: true })).status, 400, 'no text goes with it');
  const archived = (await ok('member', 'POST', `${P}/channels`, { name: 'Old' }, 201)).channel;
  await ok('lead', 'DELETE', `${P}/channels/${archived.id}`);
  assert.equal((await send('member', 'POST', `${P}/channels/${archived.id}/typing`, { typing: true })).status, 409);
  assert.equal(typingEvents().length, 0, 'a refused signal publishes nothing');
});
