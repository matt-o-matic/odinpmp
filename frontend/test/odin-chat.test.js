import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chatEndpoints } from '../src/lib/api/chat-endpoints.js';
import { countsLabel, jumpTargets, landingRedirect, markLanding, pickablePeople, placeLabel, placeRoute, readCollapsed, startPageOf, takeLanding, writeCollapsed } from '../src/lib/chat/chat.js';
import { CHAT_MANIFEST, CHAT_TOUCH_ICON, linkChatInstall } from '../src/lib/chat/chat-shell.js';
import { createDirectMessageApi } from '../src/lib/chat/direct-message-api.js';

// Odin Chat's helpers: the jump-to list, landing and the start page, where Mentions and Threads
// open, the direct message API the channel screens call, the client's /api/chat paths, and Odin
// Chat's own Home Screen install.

const sidebar = {
  directMessages: [
    { id: 'dm-1', isGroup: false, members: [{ id: 'me', name: 'Mo Member' }, { id: 'lena', name: 'Lena Lead' }], title: 'Lena Lead' },
    { id: 'dm-2', isGroup: true, members: [{ id: 'me', name: 'Mo Member' }, { id: 'lena', name: 'Lena Lead' }, { id: 'olu', name: 'Olu Other' }], title: 'Lena Lead, Olu Other' },
  ],
  groups: [
    { channels: [{ id: 'c-gen', name: 'General' }, { id: 'c-deal', name: 'Deal room' }], id: 'p-1', name: 'Contoso rollout' },
    { channels: [{ id: 'c-gen-2', name: 'General' }], id: 'p-2', name: 'Northwind pursuit' },
  ],
};

test('jump-to finds channels, conversations, people and Odin, best matches first', () => {
  assert.deepEqual(jumpTargets({ query: '', sidebar }), [], 'nothing until something is typed');
  assert.deepEqual(jumpTargets({ query: 'gen', sidebar }).map((entry) => [entry.label, entry.detail]), [['#General', 'Contoso rollout'], ['#General', 'Northwind pursuit']]);
  const deal = jumpTargets({ query: 'room', sidebar })[0];
  assert.deepEqual(deal.to, { name: 'chat-channel', params: { channelId: 'c-deal', projectId: 'p-1' }, query: {} });
  assert.deepEqual(jumpTargets({ query: 'odin', sidebar })[0].to, { name: 'chat-odin' });
  // A person in a one-to-one conversation opens it; anyone else starts one.
  const people = [{ email: 'lena@x', id: 'lena', name: 'Lena Lead' }, { email: 'ada@x', id: 'ada', name: 'Ada Admin' }];
  assert.deepEqual(jumpTargets({ people, query: 'lena', sidebar }).map((entry) => entry.kind), ['dm', 'dm'], 'her conversation and the group, not a new one');
  assert.deepEqual(jumpTargets({ people, query: 'ada', sidebar }).map((entry) => [entry.kind, entry.personId]), [['person', 'ada']]);
  assert.equal(jumpTargets({ people, query: 'olu', sidebar })[0].detail, 'Group message');
  assert.ok(jumpTargets({ query: 'e', sidebar }).length <= 8);
});

test('members land in Odin unless they chose Odin Chat, on the first page only', () => {
  assert.equal(startPageOf({}), 'odin');
  assert.equal(startPageOf({ startPage: 'chat' }), 'chat');
  assert.equal(startPageOf({ startPage: 'elsewhere' }), 'odin');
  assert.deepEqual(landingRedirect({ landing: true, preferences: { startPage: 'chat' }, toName: 'home' }), { name: 'chat-home' });
  assert.equal(landingRedirect({ landing: true, preferences: {}, toName: 'home' }), null);
  assert.equal(landingRedirect({ landing: false, preferences: { startPage: 'chat' }, toName: 'home' }), null, 'Home stays reachable after landing');
  assert.equal(landingRedirect({ landing: true, preferences: { startPage: 'chat' }, toName: 'project-detail' }), null, 'a link to a page opens that page');
  takeLanding();
  assert.equal(takeLanding(), false);
  markLanding();
  assert.equal(takeLanding(), true, 'signing in lands again');
  assert.equal(takeLanding(), false);
});

test('Mentions and Threads open the post in its channel or conversation, at its thread', () => {
  const channel = { channelId: 'c-1', channelName: 'General', kind: 'delivery', projectId: 'p-1', projectName: 'Contoso rollout', type: 'channel' };
  assert.deepEqual(placeRoute(channel, { id: 'reply-1', parentId: 'root-1' }), { name: 'chat-channel', params: { channelId: 'c-1', projectId: 'p-1' }, query: { post: 'root-1' } });
  assert.deepEqual(placeRoute({ conversationId: 'dm-1', title: 'Lena Lead', type: 'dm' }, { id: 'post-1', parentId: null }), { name: 'chat-direct', params: { conversationId: 'dm-1' }, query: { post: 'post-1' } });
  assert.equal(placeLabel(channel), '#General · Contoso rollout');
  assert.equal(placeLabel({ title: 'Lena Lead', type: 'dm' }), 'Lena Lead');
  assert.equal(countsLabel({ mentionCount: 1, unreadCount: 3 }), '3 unread, 1 mention');
  assert.equal(countsLabel({ mentionCount: 2 }), '2 mentions');
  assert.equal(countsLabel({}), '');
});

test('the New message picker filters people and leaves out those already chosen', () => {
  const people = [{ email: 'lena@acme.example', id: 'lena', name: 'Lena Lead' }, { email: 'olu@acme.example', id: 'olu', name: 'Olu Other' }];
  assert.deepEqual(pickablePeople(people, { query: 'ol' }).map((person) => person.id), ['olu']);
  assert.deepEqual(pickablePeople(people, { query: 'acme' }).map((person) => person.id), ['lena', 'olu'], 'by email too');
  assert.deepEqual(pickablePeople(people, { chosen: [{ id: 'lena' }] }).map((person) => person.id), ['olu']);
});

test('collapsed sections are read and written safely when storage refuses', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  writeCollapsed(storage, 'k', new Set(['direct', 'p-1']));
  assert.deepEqual(readCollapsed(storage, 'k'), ['direct', 'p-1']);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readCollapsed(broken, 'k'), []);
  assert.doesNotThrow(() => writeCollapsed(broken, 'k', new Set(['x'])));
  assert.deepEqual(readCollapsed({ getItem: () => '{bad json' }, 'k'), []);
});

test('the direct message API gives the channel screens their method names, on the conversation', async () => {
  const calls = [];
  const fake = new Proxy({}, { get: (_target, name) => (name === 'passive' ? fakePassive : (...args) => { calls.push([name, ...args]); return { ok: true }; }) });
  const fakePassive = new Proxy({}, { get: (_target, name) => (...args) => { calls.push([`passive.${String(name)}`, ...args]); return { ok: true }; } });
  const api = createDirectMessageApi(fake);
  await api.listChannelPosts('dm-1', 'dm-1', { limit: 30 }, 'token');
  await api.createChannelPost('dm-1', 'dm-1', { body: 'Hi' }, 'token');
  await api.updatePost('dm-1', 'post-1', { body: 'Hey' }, 'token');
  await api.deletePost('dm-1', 'post-1', 'token');
  await api.startFileUpload('dm-1', { fileName: 'a.txt' }, 'token');
  await api.completeFileUpload('dm-1', 'upload-1', {}, 'token');
  await api.getFilePreviewUrl('dm-1', 'file-1', { version: 1 }, 'token');
  await api.passive.markChannelRead('dm-1', 'dm-1', 'token');
  await api.passive.listChannelMentionables('dm-1', 'dm-1', 'token');
  assert.deepEqual(calls, [
    ['listDirectPosts', 'dm-1', { limit: 30 }, 'token'],
    ['createDirectPost', 'dm-1', { body: 'Hi' }, 'token'],
    ['updateDirectPost', 'dm-1', 'post-1', { body: 'Hey' }, 'token'],
    ['deleteDirectPost', 'dm-1', 'post-1', 'token'],
    ['startDirectUpload', 'dm-1', { fileName: 'a.txt' }, 'token'],
    ['completeDirectUpload', 'dm-1', 'upload-1', 'token'],
    ['getDirectFilePreviewUrl', 'dm-1', 'file-1', { version: 1 }, 'token'],
    ['passive.markDirectConversationRead', 'dm-1', 'token'],
    ['passive.listDirectMentionables', 'dm-1', 'token'],
  ]);
  assert.throws(() => api.uploadProjectFile('dm-1', {}), /upload in parts/);
});

test('the client’s Odin Chat calls reach /api/chat', async () => {
  const requests = [];
  const endpoints = chatEndpoints({
    request: async (path, options = {}) => { requests.push([options.method ?? 'GET', path, options.body ?? null]); return { data: { ok: true } }; },
    segment: (value) => encodeURIComponent(String(value)),
    subscribe: (path) => { requests.push(['STREAM', path, null]); return () => {}; },
  });
  await endpoints.getChatSidebar('t');
  await endpoints.listChatMentions({ before: 'cursor 1' }, 't');
  await endpoints.startDirectConversation(['a', 'b'], 't');
  await endpoints.listDirectPosts('dm/1', { before: '', limit: 30 }, 't');
  await endpoints.getDirectFileDownloadUrl('dm-1', 'f-1', { inline: true }, 't');
  endpoints.subscribeToDirectConversationEvents('dm-1', 't', {});
  assert.deepEqual(requests, [
    ['GET', '/api/chat/sidebar', null],
    ['GET', '/api/chat/mentions?before=cursor+1', null],
    ['POST', '/api/chat/conversations', { memberIds: ['a', 'b'] }],
    ['GET', '/api/chat/conversations/dm%2F1/posts?limit=30', null],
    ['GET', '/api/chat/conversations/dm-1/files/f-1/download-url?disposition=inline', null],
    ['STREAM', '/api/chat/conversations/dm-1/events', null],
  ]);
});

test('under /app/chat the page links Odin Chat’s manifest, icon and name, and puts Odin’s back after', () => {
  const elements = [];
  const make = (tag) => {
    const attributes = new Map();
    const element = {
      getAttribute: (name) => attributes.get(name) ?? null,
      remove: () => elements.splice(elements.indexOf(element), 1),
      setAttribute: (name, value) => attributes.set(name, value),
      tag,
    };
    Object.defineProperty(element, 'rel', { set: (value) => attributes.set('rel', value) });
    Object.defineProperty(element, 'name', { set: (value) => attributes.set('name', value) });
    return element;
  };
  const manifest = make('link');
  manifest.setAttribute('rel', 'manifest');
  manifest.setAttribute('href', '/app/manifest.webmanifest');
  elements.push(manifest);
  const doc = {
    createElement: make,
    head: {
      append: (element) => elements.push(element),
      querySelector: (selector) => {
        const [, attribute, value] = /\[(\w+)="([^"]+)"\]/.exec(selector);
        return elements.find((element) => element.getAttribute(attribute) === value) ?? null;
      },
    },
  };
  const restore = linkChatInstall(doc);
  assert.equal(manifest.getAttribute('href'), CHAT_MANIFEST);
  assert.equal(doc.head.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'), CHAT_TOUCH_ICON);
  assert.equal(doc.head.querySelector('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), 'Odin Chat');
  restore();
  assert.equal(manifest.getAttribute('href'), '/app/manifest.webmanifest');
  assert.equal(doc.head.querySelector('link[rel="apple-touch-icon"]'), null, 'what it added goes');
});

test('Odin Chat installs as its own app, inside the service worker’s scope', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/chat.webmanifest', import.meta.url), 'utf8'));
  const odin = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.equal(manifest.name, 'Odin Chat');
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope, manifest.display], ['/app/chat/', '/app/chat/', '/app/chat/', 'standalone']);
  assert.notEqual(manifest.id, odin.id, 'its own app, not Odin’s');
  assert.ok(manifest.scope.startsWith(odin.scope));
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/app\/brand\/odin-chat-\d+\.png$/);
    await readFile(new URL(`../public${icon.src.replace(/^\/app/, '')}`, import.meta.url));
    assert.match(worker, new RegExp(icon.src.replace(/[.]/g, '\\.')));
  }
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  assert.match(worker, /'\/app\/chat\.webmanifest'/);
  assert.match(main, /register\('\/app\/sw\.js', \{ scope: '\/app\/' \}\)/, 'one worker covers Odin and Odin Chat');
});

test('the Chat badge reads the count once, then only when the person’s own stream reports a notification made or read', async () => {
  const { createChatUnreadStore } = await import('../src/lib/chat/chat-unread-store.js');
  let fetches = 0;
  const listeners = [];
  const api = {
    passive: { getChatUnread: async () => { fetches += 1; return { mentions: fetches, unread: fetches * 2 }; } },
    subscribeToMyEvents(_token, handlers) { listeners.push(handlers); return () => {}; },
    // A workspace stream would be the old way; the badge must not open one.
    subscribeToWorkspaceEvents() { throw new Error('the badge does not listen to the whole workspace'); },
  };
  const store = createChatUnreadStore({ api, debounceMs: 0, session: { state: { isAuthenticated: true, token: 'token' } } });
  store.start();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  await settle();
  assert.equal(fetches, 1, 'one initial fetch');
  assert.deepEqual([store.state.unread, store.state.mentions], [2, 1]);
  assert.equal(listeners.length, 2, 'notification.created and notification.read, on the person stream');
  for (const listener of listeners) listener.onEvent({ data: { ok: true }, type: 'connected' });
  for (const listener of listeners) listener.onEvent({ data: { area: 'projects' }, type: 'workspace.changed' });
  await settle();
  assert.equal(fetches, 1, 'nothing else in the workspace makes it ask');
  listeners[0].onEvent({ data: { id: 'n-1' }, type: 'notification.created' });
  await settle();
  assert.equal(fetches, 2);
  listeners[1].onEvent({ data: { ids: ['n-1'] }, type: 'notification.read' });
  await settle();
  assert.equal(fetches, 3);
  store.apply({ mentions: 0, unread: 7 });
  assert.equal(store.state.unread, 7, 'Odin Chat hands over its totals without a request');
  assert.equal(fetches, 3);
  store.end();
});
