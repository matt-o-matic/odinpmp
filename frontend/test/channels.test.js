import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendOlder,
  childFolders,
  createChannelLiveUpdates,
  editingLabel,
  folderMoveTargets,
  folderTrail,
  hasPost,
  loadUntilPost,
  normalizeChannelTab,
  pickChannel,
  replyTagFor,
  unreadLabel,
  upsertPost,
} from '../src/lib/channels/channels.js';
import { fileAttachments, sameNamedFile } from '../src/lib/projects/project-files.js';

const channels = [{ id: 'c-side', isGeneral: false, name: 'Side' }, { id: 'c-general', isGeneral: true, name: 'General' }];

test('a link picks its channel, "general" or nothing picks General, and tabs fall back to the conversation', () => {
  assert.equal(pickChannel(channels, 'c-side').id, 'c-side');
  assert.equal(pickChannel(channels, 'general').id, 'c-general');
  assert.equal(pickChannel(channels, 'gone').id, 'c-general');
  assert.equal(pickChannel([], ''), null);
  assert.equal(normalizeChannelTab('files'), 'files');
  assert.equal(normalizeChannelTab('plan'), 'conversation');
  assert.deepEqual([unreadLabel(0), unreadLabel(3), unreadLabel(120)], ['', '3', '99+']);
});

test('upsertPost puts each post the server returns in one place: new at the front, replies in their parent, edits in place', () => {
  const first = { id: 'p1', replies: [] };
  let posts = upsertPost([], first);
  posts = upsertPost(posts, { id: 'p2', replies: [] });
  assert.deepEqual(posts.map((post) => post.id), ['p2', 'p1']);
  posts = upsertPost(posts, { id: 'r1', parentId: 'p1' });
  posts = upsertPost(posts, { id: 'r1', parentId: 'p1', body: 'edited' });
  assert.deepEqual(posts[1].replies, [{ body: 'edited', id: 'r1', parentId: 'p1' }], 'a reply seen twice shows once');
  posts = upsertPost(posts, { deleted: true, id: 'p1', replies: [] });
  assert.equal(posts[1].deleted, true);
  assert.equal(posts[1].replies.length, 1, 'a deleted post keeps its replies');
  assert.deepEqual(appendOlder(posts, [{ id: 'p1' }, { id: 'p0' }]).map((post) => post.id), ['p2', 'p1', 'p0']);
});

test('folders: the trail down to one, its children, and where it can move', () => {
  const folders = [
    { id: 'a', name: 'Proposals', parentId: null },
    { id: 'b', name: 'Drafts', parentId: 'a' },
    { id: 'c', name: 'Old', parentId: 'b' },
    { id: 'd', name: 'Contracts', parentId: null },
  ];
  assert.deepEqual(folderTrail(folders, 'c').map((folder) => folder.name), ['Proposals', 'Drafts', 'Old']);
  assert.deepEqual(folderTrail(folders, null), []);
  assert.deepEqual(childFolders(folders, null).map((folder) => folder.name), ['Contracts', 'Proposals']);
  assert.deepEqual(folderMoveTargets(folders, folders[1]).map((target) => target.label), ['Contracts', 'Proposals'], 'never into itself or what is inside it');
});

test('the editing marker names who is editing and since when', () => {
  const now = new Date('2026-11-14T15:00:00');
  const editing = { name: 'Pat Seller', since: new Date('2026-11-14T10:42:00').toISOString(), userId: 'u-pat' };
  assert.match(editingLabel(editing, 'u-me', now), /^Pat Seller is editing · since \d{1,2}:42/);
  assert.match(editingLabel(editing, 'u-pat', now), /^You are editing/);
  assert.equal(editingLabel(null), '');
});

test('channel files name their channel and folder, and link to the channel library', () => {
  const [place] = fileAttachments({ folderPath: 'Proposals / Drafts', id: 'f1', targetId: 'c-general', targetName: 'General', targetType: 'channel' }, 'p1');
  assert.equal(place.name, '#General / Proposals / Drafts');
  assert.deepEqual(place.route, { name: 'project-channels', params: { projectId: 'p1' }, query: { channel: 'c-general', file: 'f1', tab: 'files' } });
  const files = [{ fileName: 'plan.txt', folderId: 'x', id: 'in-x', targetId: 'c', targetType: 'channel' }, { fileName: 'plan.txt', folderId: null, id: 'top', targetId: 'c', targetType: 'channel' }];
  assert.equal(sameNamedFile(files, { targetId: 'c', targetType: 'channel' }, 'PLAN.txt', 'x').id, 'in-x', 'names are taken within a folder');
  assert.equal(sameNamedFile(files, { targetId: 'c', targetType: 'channel' }, 'plan.txt').id, 'top');
});

test('channel live updates batch channel.updated events with their details, and skip this tab’s own', () => {
  const timers = new Map();
  let nextTimer = 1;
  const handlers = {};
  const batches = [];
  const stop = createChannelLiveUpdates({
    apiClient: { clientId: 'tab-me', subscribeToProjectEvents: (_projectId, _token, given) => { Object.assign(handlers, given); return () => {}; } },
    getToken: () => 'token',
    onChange: (batch) => batches.push(batch),
    projectId: 'p1',
    timers: { clear: (id) => timers.delete(id), set: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; } },
  });
  handlers.onEvent({ type: 'connected' });
  handlers.onEvent({ data: { actor: { id: 'u2', name: 'Bo' }, area: 'posts', channelId: 'c1', originClientId: 'tab-other' }, type: 'channel.updated' });
  handlers.onEvent({ data: { area: 'posts', channelId: 'c1', originClientId: 'tab-me' }, type: 'channel.updated' });
  handlers.onEvent({ data: { area: 'files', channelId: 'c2' }, type: 'project.assets.invalidated' });
  [...timers.values()].forEach((callback) => callback());
  stop();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].details.map((event) => [event.channelId, event.area]), [['c1', 'posts']]);
  assert.deepEqual(batches[0].actors.map((actor) => actor.name), ['Bo']);
});

test('a thread shows "Odin is replying" while a tag in it is being answered, and the confirm card explains itself to others', async () => {
  const { odinConfirmationNote, threadOdinReplying } = await import('../src/lib/channels/channels.js');
  assert.equal(threadOdinReplying({ id: 'p1', odin: { status: 'replying' }, replies: [] }), true);
  assert.equal(threadOdinReplying({ id: 'p1', replies: [{ id: 'r1', odin: { status: 'replying' } }] }), true, 'a reply that tagged Odin');
  assert.equal(threadOdinReplying({ id: 'p1', odin: { status: 'replied' }, replies: [{ author: { type: 'odin' }, id: 'r2' }] }), false);
  assert.equal(odinConfirmationNote({ status: 'pending' }), 'Waiting for the person who tagged Odin to confirm.');
  assert.equal(odinConfirmationNote({ status: 'approved' }), 'Confirmed.');
  assert.equal(odinConfirmationNote({ status: 'declined' }), 'Cancelled.');
  assert.equal(odinConfirmationNote({ status: 'whatever' }), 'This is no longer waiting.');
});

test('a link to a post older than the first page loads earlier pages until the post, a reply too, is there', async () => {
  // Threads newest first, each with its replies; a page holds two.
  const threads = ['t6', 't5', 't4', 't3', 't2', 't1'].map((id) => ({ id, replies: id === 't2' ? [{ id: 'r2', parentId: 't2' }] : [] }));
  const pageAfter = (cursor) => {
    const start = cursor ? threads.findIndex((thread) => thread.id === cursor) + 1 : 0;
    const posts = threads.slice(start, start + 2);
    return { nextCursor: start + 2 < threads.length ? posts.at(-1).id : null, posts };
  };
  const first = pageAfter(null);
  assert.equal(hasPost(first.posts, 't5'), true);
  assert.equal(hasPost(threads, 'r2'), true, 'a reply counts');
  assert.equal(hasPost(first.posts, 'r2'), false);
  assert.equal(hasPost(first.posts, ''), false);

  const asked = [];
  const fetchOlder = async (cursor) => { asked.push(cursor); return pageAfter(cursor); };
  const reply = await loadUntilPost({ cursor: first.nextCursor, fetchOlder, postId: 'r2', posts: first.posts });
  assert.deepEqual([reply.found, reply.posts.map((post) => post.id), reply.nextCursor, asked], [true, ['t6', 't5', 't4', 't3', 't2', 't1'], null, ['t5', 't3']]);

  asked.length = 0;
  const loaded = await loadUntilPost({ cursor: first.nextCursor, fetchOlder, postId: 't6', posts: first.posts });
  assert.deepEqual([loaded.found, asked], [true, []], 'nothing to load when the post is in the first page');
  const missing = await loadUntilPost({ cursor: first.nextCursor, fetchOlder, maxPages: 1, postId: 'gone', posts: first.posts });
  assert.deepEqual([missing.found, missing.posts.length, missing.nextCursor], [false, 4, 't3'], 'stops after maxPages');
});

test('a reply tags the author of the message it answers, if the writer may tag them', () => {
  const people = [{ name: 'Odin', ref: 'odin:odin' }, { name: 'Ana Lee', ref: 'user:u-ana' }, { name: 'Pat Client', ref: 'stakeholder:s-pat' }];
  assert.deepEqual(replyTagFor({ id: 'u-ana', name: 'Ana', type: 'user' }, people), { label: 'Ana Lee', ref: 'user:u-ana' });
  assert.deepEqual(replyTagFor({ id: 's-pat', name: 'Pat', type: 'stakeholder' }, people), { label: 'Pat Client', ref: 'stakeholder:s-pat' });
  assert.deepEqual(replyTagFor({ id: null, name: 'Odin', type: 'odin' }, people), { label: 'Odin', ref: 'odin:odin' });
  // The writer is never in the list, nor Odin where it is off, nor a former member.
  assert.equal(replyTagFor({ id: 'u-me', name: 'Me', type: 'user' }, people), null);
  assert.equal(replyTagFor({ id: null, name: 'Odin', type: 'odin' }, people.slice(1)), null);
  assert.equal(replyTagFor(null, people), null);
});
