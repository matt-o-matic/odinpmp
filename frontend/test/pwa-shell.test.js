import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('PWA shell is installable while API and mutation traffic remain network-only', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(manifest.start_url, '/app/'); assert.equal(manifest.scope, '/app/'); assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  assert.match(html, /rel="manifest" href="\/app\/manifest\.webmanifest"/);
  assert.match(worker, /matchAll\(\/\(\?:src\|href\)/); assert.match(worker, /\/app\\\/assets/);
  assert.match(worker, /request\.method !== 'GET'/); assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(worker, /POST|PUT|PATCH|DELETE/);
});

// Runs the service worker in a sandbox with a fake `self`, and fires its push events.
// A tab that `answers` opens a push in place (lib/notifications/open-from-push.js); one that
// doesn't is loaded on the address.
async function loadWorker({ answers = false, tabs = [] } = {}) {
  const { runInNewContext } = await import('node:vm');
  const listeners = {};
  const calls = { focus: [], navigate: [], open: [], posted: [], shown: [] };
  class MessageChannel {
    constructor() {
      this.port1 = {};
      this.port2 = { postMessage: (message) => this.port1.onmessage?.({ data: message }) };
    }
  }
  const postMessage = (message, ports = []) => {
    calls.posted.push(message);
    if (answers && message.type === 'odin-open') ports[0]?.postMessage({ opened: true });
  };
  const self = {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    clients: {
      claim: async () => {},
      matchAll: async () => tabs.map((url) => ({ focus: async () => calls.focus.push(url), navigate: async (target) => calls.navigate.push(target), postMessage, url })),
      openWindow: async (url) => calls.open.push(url),
    },
    location: { origin: 'https://odin.example' },
    registration: { showNotification: async (title, options) => calls.shown.push({ options, title }) },
    skipWaiting: () => {},
  };
  // The wait for a tab's answer runs at once here.
  runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), { MessageChannel, URL, caches: {}, clearTimeout, fetch: async () => ({}), self, setTimeout: (callback) => setTimeout(callback, 0) });
  const fire = async (type, event) => {
    let done = null;
    listeners[type]({ ...event, waitUntil: (promise) => { done = promise; } });
    await done;
  };
  return { calls, fire };
}

test('a push shows its title, text and tag, and opening it goes to its item inside the app only', async () => {
  const worker = await loadWorker({ tabs: ['https://odin.example/app/projects'] });
  await worker.fire('push', { data: { json: () => ({ body: 'Can you check the SOW?', notificationId: 'n1', tag: 'channel:c1', title: 'Lena mentioned you', url: 'https://odin.example/app/projects/p1/channels?channel=c1' }) } });
  assert.equal(worker.calls.shown[0].title, 'Lena mentioned you');
  assert.equal(worker.calls.shown[0].options.body, 'Can you check the SOW?');
  assert.equal(worker.calls.shown[0].options.tag, 'channel:c1');
  const notification = { close: () => {}, data: worker.calls.shown[0].options.data };
  await worker.fire('notificationclick', { notification });
  assert.deepEqual(worker.calls.navigate, ['https://odin.example/app/projects/p1/channels?channel=c1'], 'an open Odin tab that does not answer is loaded there');
  assert.deepEqual(worker.calls.posted.map((message) => message.type), ['odin-notification', 'odin-open'], 'open tabs hear of the push, then are asked to open it');

  // A tab that answers opens it in place, without loading the page again.
  const answering = await loadWorker({ answers: true, tabs: ['https://odin.example/app/projects'] });
  await answering.fire('notificationclick', { notification });
  assert.deepEqual(answering.calls.posted.map(({ type, url }) => [type, url]), [['odin-open', 'https://odin.example/app/projects/p1/channels?channel=c1']]);
  assert.deepEqual([answering.calls.focus.length, answering.calls.navigate, answering.calls.open], [1, [], []]);

  const fresh = await loadWorker();
  await fresh.fire('notificationclick', { notification: { close: () => {}, data: { url: 'https://evil.example/app/x' } } });
  await fresh.fire('notificationclick', { notification: { close: () => {}, data: { url: 'https://odin.example/api/me' } } });
  assert.deepEqual(fresh.calls.open, ['https://odin.example/app/', 'https://odin.example/app/'], 'anything outside the app opens the app instead');
  await fresh.fire('push', { data: { json: () => { throw new Error('not JSON'); }, text: () => 'plain' } });
  assert.deepEqual([fresh.calls.shown[0].title, fresh.calls.shown[0].options.body], ['Odin', 'plain']);
});
