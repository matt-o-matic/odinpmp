import assert from 'node:assert/strict';
import test from 'node:test';

import { appRouteFor, listenForPushOpens } from '../src/lib/notifications/open-from-push.js';

const origin = 'https://odinpmp.test';

test('an address inside the app becomes its route; anything else is refused', () => {
  assert.equal(appRouteFor(`${origin}/app/chat/channels/p1/c1?post=x#top`, { origin }), '/chat/channels/p1/c1?post=x#top');
  assert.equal(appRouteFor('/app/projects/p1', { origin }), '/projects/p1');
  assert.equal(appRouteFor('https://elsewhere.test/app/projects/p1', { origin }), null);
  assert.equal(appRouteFor(`${origin}/api/me`, { origin }), null);
  assert.equal(appRouteFor('http://[bad', { origin }), null);
});

test('a push opened from the service worker moves the open page, and answers so it is not reloaded', async () => {
  const listeners = new Map();
  const container = { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: (type) => listeners.delete(type) };
  const pushed = [];
  const answers = [];
  const stop = listenForPushOpens({ container, origin, router: { push: async (path) => { pushed.push(path); } } });
  const port = { postMessage: (message) => answers.push(message) };

  listeners.get('message')({ data: { type: 'odin-open', url: `${origin}/app/chat/channels/p1/c1?post=x` }, ports: [port] });
  assert.deepEqual(pushed, ['/chat/channels/p1/c1?post=x']);
  assert.deepEqual(answers, [{ opened: true }]);

  // Another message, or an address outside the app, is left alone and gets no answer.
  listeners.get('message')({ data: { type: 'odin-notification' }, ports: [port] });
  listeners.get('message')({ data: { type: 'odin-open', url: 'https://elsewhere.test/app/x' }, ports: [port] });
  assert.equal(pushed.length, 1);
  assert.equal(answers.length, 1);

  stop();
  assert.ok(!listeners.has('message'));
});
