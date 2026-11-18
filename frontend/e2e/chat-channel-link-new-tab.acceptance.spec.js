import http from 'node:http';

import { expect, test } from '@playwright/test';

import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// A chat email link opened in a new tab while Odin is open in another (production, 2026-11-16):
// the new tab loaded the channel list but never asked for the messages. Each Odin tab holds 3
// live event streams, and over HTTP/1.1 a browser opens at most 6 connections to a host for all
// its tabs, so the messages request waited for a connection that never came free. Hidden tabs
// now close their streams (lib/projects/shared-project-events.js).
//
// Mocked routes never use a connection, so here the event streams and the messages request go
// to a real local HTTP/1.1 server, and the streams stay open as they do in production.

test.describe.configure({ mode: 'serial', timeout: 90_000 });

const CHAT = `chat/channels/${syntheticProject.id}/channel-general`;
const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 9, minutes)).toISOString();
const POSTS = [
  { body: 'Kick-off notes are in the library.', createdAt: at(5), id: 'post-welcome' },
  { body: 'Which day suits the workshop?', createdAt: at(6), id: 'post-workshop' },
  { body: 'Slides are up.', createdAt: at(7), id: 'post-slides' },
];

function presentPost({ body, createdAt, id }) {
  return {
    attachments: [], author: { id: 'user-pat', name: 'Pat Partner', type: 'user' }, body, canDelete: false, canEdit: false, canReact: true, canReply: true,
    createdAt, deleted: false, editedAt: null, fileVersion: null, id, isMine: false, parentId: null, reactions: [], replies: [], replyToId: null, targetId: 'channel-general', targetType: 'channel',
  };
}

let server;
let origin = '';
const streams = new Set();
const postRequests = [];

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const cors = {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': request.headers['access-control-request-headers'] ?? '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    if (/\/events(\?|$)/.test(request.url)) {
      response.writeHead(200, { ...cors, 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream' });
      response.write('event: connected\ndata: {}\n\n');
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }
    if (/\/channels\/channel-general\/posts(\?|$)/.test(request.url)) {
      postRequests.push(request.url);
      response.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ canPost: true, nextCursor: null, ok: true, posts: [...POSTS].reverse().map(presentPost) }));
      return;
    }
    response.writeHead(404, cors).end('{}');
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  origin = `http://localhost:${server.address().port}`;
});

test.afterAll(async () => {
  for (const response of streams) response.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Signs in on a new tab; its event streams and the General channel's messages use real connections. */
async function signedInTab(context) {
  const page = await context.newPage();
  await installSyntheticApi(page);
  await installChannelsApi(page, { world: createChannelsWorld() });
  const toServer = (route) => {
    const url = new URL(route.request().url());
    return route.continue({ url: `${origin}${url.pathname}${url.search}` });
  };
  await page.route(/\/api\/.+\/events(\?|$)/, toServer);
  await page.route(/\/channels\/channel-general\/posts(\?|$)/, toServer);
  await authenticateSyntheticUser(page);
  return page;
}

// The browser hides a tab when another one opens in front of it. Headless pages stay visible,
// so the test says so itself.
async function hide(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function show(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const marked = (page, postId) => page.locator(`li.channel-post--focused > #channel-post-${postId}`);

test('a channel link opened in a new tab, while another Odin tab is open, loads the messages and marks the post', async ({ context }) => {
  // The first email: signed in, the channel opens on its post.
  const first = await signedInTab(context);
  await first.goto(`${CHAT}?post=post-welcome`);
  await expect(marked(first, 'post-welcome')).toBeVisible();
  await expect.poll(() => streams.size).toBe(3);

  // The second email opens a new tab in front, so the first is hidden. The new tab is already
  // signed in, and loads the link straight away.
  await hide(first);
  const second = await signedInTab(context);
  const asked = postRequests.length;
  await second.goto(`${CHAT}?post=post-workshop`);
  await expect.poll(() => postRequests.length).toBeGreaterThan(asked);
  await expect(second.locator('#channel-post-post-workshop')).toContainText('Which day suits the workshop?');
  await expect(marked(second, 'post-workshop')).toBeVisible();
  // Only the tab in front holds streams.
  expect(streams.size).toBe(3);

  // Reloading it works the same way.
  const beforeReload = postRequests.length;
  await second.reload();
  await expect.poll(() => postRequests.length).toBeGreaterThan(beforeReload);
  await expect(marked(second, 'post-workshop')).toBeVisible();

  // So does the same link on the project's Channels tab.
  const beforeProject = postRequests.length;
  await second.goto(`projects/${syntheticProject.id}/channels?channel=channel-general&post=post-workshop`);
  await expect.poll(() => postRequests.length).toBeGreaterThan(beforeProject);
  await expect(marked(second, 'post-workshop')).toBeVisible();

  // Back on the first tab, its streams open again and it fetches what it missed.
  const beforeShow = postRequests.length;
  await hide(second);
  await show(first);
  await expect.poll(() => streams.size).toBe(3);
  await expect.poll(() => postRequests.length).toBeGreaterThan(beforeShow);
  await expect(first.locator('#channel-post-post-slides')).toContainText('Slides are up.');
});
