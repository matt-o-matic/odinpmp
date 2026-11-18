import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiClient } from '../src/lib/api/client.js';
import { createSharedEventStreams } from '../src/lib/projects/shared-project-events.js';
import {
  REQUIREMENTS_EVENT_TYPES,
  batchTouchesPackage,
  batchTouchesPackages,
  batchTouchesTopic,
  batchTouchesTopicList,
  mergeRequirementsEvent,
} from '../src/lib/requirements/requirements-live-updates.js';

function fakeOpen() {
  const opened = [];
  const open = (key, handlers) => {
    const stream = { handlers, key, stopped: false };
    opened.push(stream);
    return () => { stream.stopped = true; };
  };
  return { open, opened };
}

function syncDefer() {
  const queue = [];
  return { defer: (callback) => queue.push(callback), flush: () => { while (queue.length) queue.shift()(); } };
}

test('subscribers to the same project share one stream and each get every event', () => {
  const { open, opened } = fakeOpen();
  const deferred = syncDefer();
  const shared = createSharedEventStreams({ defer: deferred.defer, open });
  const first = [];
  const second = [];
  const stopFirst = shared.subscribe('p1', { onEvent: (event) => first.push(event.type) });
  const stopSecond = shared.subscribe('p1', { onEvent: (event) => second.push(event.type) });
  shared.subscribe('p2', {});
  assert.equal(opened.length, 2, 'one stream per project');

  opened[0].handlers.onEvent({ type: 'connected' });
  opened[0].handlers.onEvent({ type: 'requirements.topics.invalidated' });
  assert.deepEqual(first, ['connected', 'requirements.topics.invalidated']);
  assert.deepEqual(second, ['connected', 'requirements.topics.invalidated']);

  stopFirst();
  assert.equal(opened[0].stopped, false, 'the stream stays open while someone listens');
  stopSecond();
  assert.equal(opened[0].stopped, true, 'the last listener closes it');
  stopSecond();
  assert.equal(shared.size, 1);
});

test('a late subscriber gets the connected event replayed', () => {
  const { open, opened } = fakeOpen();
  const deferred = syncDefer();
  const shared = createSharedEventStreams({ defer: deferred.defer, open });
  shared.subscribe('p1', {});
  opened[0].handlers.onEvent({ data: { projectId: 'p1' }, type: 'connected' });
  const late = [];
  shared.subscribe('p1', { onEvent: (event) => late.push(event) });
  assert.deepEqual(late, []);
  deferred.flush();
  assert.deepEqual(late, [{ data: { projectId: 'p1' }, type: 'connected' }]);
  assert.equal(opened.length, 1);
});

test('when the stream ends every listener hears it once, and the next subscribe opens a new stream', () => {
  const { open, opened } = fakeOpen();
  const shared = createSharedEventStreams({ defer: () => {}, open });
  const closes = [];
  const errors = [];
  shared.subscribe('p1', { onClose: () => closes.push('a'), onError: (error) => errors.push(['a', error.message]) });
  shared.subscribe('p1', { onClose: () => closes.push('b') });
  opened[0].handlers.onClose();
  opened[0].handlers.onClose();
  opened[0].handlers.onEvent({ type: 'late' });
  assert.deepEqual(closes, ['a', 'b']);
  assert.equal(shared.size, 0);

  shared.subscribe('p1', { onError: (error) => errors.push(['c', error.message]) });
  assert.equal(opened.length, 2);
  opened[1].handlers.onError(new Error('dropped'));
  assert.deepEqual(errors, [['c', 'dropped']]);
});

test('one listener throwing does not stop the others', () => {
  const { open, opened } = fakeOpen();
  const thrown = [];
  const shared = createSharedEventStreams({ defer: (callback) => { try { callback(); } catch (error) { thrown.push(error.message); } }, open });
  const received = [];
  shared.subscribe('p1', { onEvent: () => { throw new Error('boom'); } });
  shared.subscribe('p1', { onEvent: (event) => received.push(event.type) });
  opened[0].handlers.onEvent({ type: 'x' });
  assert.deepEqual(received, ['x']);
  assert.deepEqual(thrown, ['boom']);
});

function fakeDocument({ hidden = false } = {}) {
  const listeners = new Set();
  return {
    hidden,
    addEventListener(type, listener) { if (type === 'visibilitychange') listeners.add(listener); },
    hide() { this.hidden = true; listeners.forEach((listener) => listener()); },
    show() { this.hidden = false; listeners.forEach((listener) => listener()); },
  };
}

test('a hidden tab closes its streams and opens them again when shown; the first connected event says so', () => {
  const { open, opened } = fakeOpen();
  const deferred = syncDefer();
  const doc = fakeDocument();
  const shared = createSharedEventStreams({ defer: deferred.defer, document: doc, open });
  const events = [];
  const ends = [];
  shared.subscribe('p1', { onClose: () => ends.push('close'), onError: () => ends.push('error'), onEvent: (event) => events.push(event) });
  shared.subscribe('w', {});
  opened[0].handlers.onEvent({ data: { projectId: 'p1' }, type: 'connected' });

  doc.hide();
  assert.deepEqual(opened.map((stream) => stream.stopped), [true, true], 'every stream lets its connection go');
  // The closed stream's own callbacks no longer reach anyone.
  opened[0].handlers.onEvent({ type: 'channel.updated' });
  opened[0].handlers.onError(new Error('aborted'));
  assert.deepEqual(ends, [], 'listeners stay subscribed');
  assert.equal(shared.size, 2);

  doc.show();
  assert.equal(opened.length, 4);
  assert.deepEqual(opened.slice(2).map((stream) => stream.key), ['p1', 'w']);
  opened[2].handlers.onEvent({ data: { projectId: 'p1' }, type: 'connected' });
  opened[2].handlers.onEvent({ type: 'channel.updated' });
  opened[2].handlers.onEvent({ data: { projectId: 'p1' }, type: 'connected' });
  assert.deepEqual(events, [
    { data: { projectId: 'p1' }, type: 'connected' },
    { data: { projectId: 'p1' }, resumed: true, type: 'connected' },
    { type: 'channel.updated' },
    { data: { projectId: 'p1' }, type: 'connected' },
  ]);

  // A listener that joins later gets the plain connected event.
  const late = [];
  shared.subscribe('p1', { onEvent: (event) => late.push(event) });
  deferred.flush();
  assert.deepEqual(late, [{ data: { projectId: 'p1' }, type: 'connected' }]);

  opened[2].handlers.onClose();
  assert.deepEqual(ends, ['close'], 'the reopened stream ends as before');
});

test('a tab opened hidden connects when first shown, and one left while hidden opens nothing', () => {
  const { open, opened } = fakeOpen();
  const doc = fakeDocument({ hidden: true });
  const shared = createSharedEventStreams({ defer: () => {}, document: doc, open });
  const events = [];
  shared.subscribe('p1', { onEvent: (event) => events.push(event) });
  const stopOther = shared.subscribe('p2', {});
  assert.equal(opened.length, 0);

  stopOther();
  assert.equal(shared.size, 1);
  doc.show();
  assert.deepEqual(opened.map((stream) => stream.key), ['p1']);
  opened[0].handlers.onEvent({ type: 'connected' });
  assert.deepEqual(events, [{ resumed: true, type: 'connected' }]);

  doc.hide();
  doc.show();
  doc.show();
  assert.equal(opened.length, 2, 'showing a shown tab opens nothing more');
});

test('a stream that cannot open again ends with the error', () => {
  const doc = fakeDocument();
  let calls = 0;
  const shared = createSharedEventStreams({
    defer: () => {},
    document: doc,
    open: () => {
      calls += 1;
      if (calls > 1) throw new Error('offline');
      return () => {};
    },
  });
  const errors = [];
  shared.subscribe('p1', { onError: (error) => errors.push(error.message) });
  doc.hide();
  doc.show();
  assert.deepEqual(errors, ['offline']);
  assert.equal(shared.size, 0);
});

test('the API client opens one project event request for several subscribers', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: connected\ndata: {"projectId":"p1"}\n\n'));
        options.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      },
    });
    return { body, ok: true, status: 200 };
  };
  try {
    const client = createApiClient({ baseUrl: 'http://localhost:3001' });
    const events = { a: [], b: [] };
    const stopA = client.subscribeToProjectEvents('p1', 'token', { onEvent: (event) => events.a.push(event.type) });
    const stopB = client.passive.subscribeToProjectEvents('p1', 'token', { onEvent: (event) => events.b.push(event.type) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requests, ['http://localhost:3001/api/projects/p1/events']);
    assert.deepEqual(events, { a: ['connected'], b: ['connected'] });
    stopA();
    stopB();
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('package events reach package views but not topic pages or registers', () => {
  const batch = mergeRequirementsEvent(null, { data: { packageIds: ['pkg-3'], track: 'experience' }, type: REQUIREMENTS_EVENT_TYPES.packages });
  assert.deepEqual(batch.packageIds, ['pkg-3']);
  assert.equal(batchTouchesPackages(batch, 'experience'), true);
  assert.equal(batchTouchesPackages(batch, 'architecture'), false);
  assert.equal(batchTouchesPackage(batch, 'pkg-3'), true);
  assert.equal(batchTouchesPackage(batch, 'pkg-4'), false);
  assert.equal(batchTouchesTopic(batch, 't1'), false);
  assert.equal(batchTouchesTopicList(batch, 'experience'), false);

  const summary = mergeRequirementsEvent(null, { data: { scopeId: 't1', scopeType: 'topic', status: 'failed', track: 'experience' }, type: REQUIREMENTS_EVENT_TYPES.summary });
  assert.equal(batchTouchesTopic(summary, 't1'), true, 'a summary run refetches its topic');
  assert.equal(batchTouchesTopic(summary, 't2'), false);
  assert.equal(batchTouchesTopicList(summary, 'experience'), true);
  assert.equal(batchTouchesPackages(summary, 'experience'), false);
  assert.equal(batchTouchesPackage({ ...summary, reconnected: true }, 'pkg-1'), true, 'after a reconnect everything refetches');
});
