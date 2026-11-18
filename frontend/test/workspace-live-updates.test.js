import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceLiveUpdates, deferWhileHidden } from '../src/lib/live/live-updates.js';

function fakeTimers() {
  const queue = new Map();
  let nextId = 1;
  return {
    clear(id) { queue.delete(id); },
    runAll() { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach((callback) => callback()); },
    set(callback) { const id = nextId++; queue.set(id, callback); return id; },
  };
}

function fakeApi() {
  const streams = [];
  return {
    clientId: 'tab-me',
    streams,
    subscribeToWorkspaceEvents(token, handlers) {
      const stream = { handlers, stopped: false, token };
      streams.push(stream);
      return () => { stream.stopped = true; };
    },
  };
}

function fakeDocument() {
  const listeners = new Set();
  return {
    hidden: false,
    listeners,
    addEventListener(type, listener) { if (type === 'visibilitychange') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'visibilitychange') listeners.delete(listener); },
    show() { this.hidden = false; listeners.forEach((listener) => listener()); },
  };
}

test('reports changes to the areas a screen shows, from other tabs only, in one batch', () => {
  const apiClient = fakeApi();
  const timers = fakeTimers();
  const batches = [];
  const stop = createWorkspaceLiveUpdates({ apiClient, areas: ['projects', 'workflows'], getToken: () => 'token', onChange: (batch) => batches.push(batch), timers });

  const { onEvent } = apiClient.streams[0].handlers;
  assert.equal(apiClient.streams[0].token, 'token');
  onEvent({ data: {}, type: 'connected' });
  onEvent({ data: { area: 'resources', originClientId: 'tab-other' }, type: 'workspace.changed' });
  onEvent({ data: { area: 'projects', originClientId: 'tab-me' }, type: 'workspace.changed' });
  onEvent({ data: { area: 'projects' }, type: 'project.assets.invalidated' });
  timers.runAll();
  assert.deepEqual(batches, [], 'other areas, this tab\'s own changes and other event types are ignored');

  onEvent({ data: { area: 'projects', originClientId: 'tab-other' }, type: 'workspace.changed' });
  onEvent({ data: { area: 'workflows', originClientId: null }, type: 'workspace.changed' });
  timers.runAll();
  assert.deepEqual(batches, [{ actors: [], reconnected: false }]);

  stop();
  assert.equal(apiClient.streams[0].stopped, true);
});

test('a dropped workspace stream reconnects and asks for a catch-up refresh', () => {
  const apiClient = fakeApi();
  const timers = fakeTimers();
  const batches = [];
  createWorkspaceLiveUpdates({ apiClient, areas: ['resources'], getToken: () => 'token', onChange: (batch) => batches.push(batch), timers });

  apiClient.streams[0].handlers.onError(new Error('network'));
  timers.runAll();
  assert.equal(apiClient.streams.length, 2);
  apiClient.streams[1].handlers.onEvent({ data: {}, type: 'connected' });
  timers.runAll();
  assert.deepEqual(batches, [{ actors: [], reconnected: true }]);
});

test('a stream that opens again after the tab was hidden asks for a catch-up refresh', () => {
  const apiClient = fakeApi();
  const timers = fakeTimers();
  const batches = [];
  createWorkspaceLiveUpdates({ apiClient, areas: ['resources'], getToken: () => 'token', onChange: (batch) => batches.push(batch), timers });

  apiClient.streams[0].handlers.onEvent({ data: {}, type: 'connected' });
  timers.runAll();
  assert.deepEqual(batches, []);
  apiClient.streams[0].handlers.onEvent({ data: {}, resumed: true, type: 'connected' });
  timers.runAll();
  assert.deepEqual(batches, [{ actors: [], reconnected: true }]);
  assert.equal(apiClient.streams.length, 1, 'the shared stream reopened itself; no reconnect here');
});

test('refreshes wait while the page is hidden and run once when it is shown', () => {
  const doc = fakeDocument();
  const runs = [];
  const deferred = deferWhileHidden((batch) => runs.push(batch), { document: doc });

  deferred.run({ actors: [], reconnected: false });
  assert.equal(runs.length, 1, 'a visible page refreshes at once');

  doc.hidden = true;
  deferred.run({ actors: [{ id: 'u1', name: 'Grace' }], reconnected: false });
  deferred.run({ actors: [{ id: 'u1', name: 'Grace' }, { id: 'u2', name: 'Ada' }], reconnected: true });
  assert.equal(runs.length, 1, 'a hidden page holds its refreshes');

  doc.show();
  assert.deepEqual(runs[1], { actors: [{ id: 'u1', name: 'Grace' }, { id: 'u2', name: 'Ada' }], reconnected: true });
  doc.show();
  assert.equal(runs.length, 2, 'showing the page again with nothing held does nothing');

  doc.hidden = true;
  deferred.run();
  deferred.stop();
  doc.show();
  assert.equal(runs.length, 2, 'a stopped screen runs nothing it held');
  assert.equal(doc.listeners.size, 0);
});
