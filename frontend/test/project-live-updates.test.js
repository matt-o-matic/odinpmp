import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectLiveUpdates, describeLiveUpdateActors } from '../src/lib/projects/project-live-updates.js';

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
    subscribeToProjectEvents(projectId, token, handlers) {
      const stream = { handlers, projectId, stopped: false, token };
      streams.push(stream);
      return () => { stream.stopped = true; };
    },
  };
}

test('batches changes from others and ignores this tab', () => {
  const apiClient = fakeApi();
  const timers = fakeTimers();
  const batches = [];
  createProjectLiveUpdates({ apiClient, getToken: () => 'token', onChange: (batch) => batches.push(batch), projectId: 'p1', timers });

  const { onEvent } = apiClient.streams[0].handlers;
  onEvent({ data: {}, type: 'connected' });
  onEvent({ data: { actor: { id: 'u1', name: 'Grace' }, originClientId: 'tab-other' }, type: 'project.assets.invalidated' });
  onEvent({ data: { actor: { id: 'u2', name: 'Ada' } }, type: 'project.assets.invalidated' });
  onEvent({ data: { actor: { id: 'me', name: 'Me' }, originClientId: 'tab-me' }, type: 'project.assets.invalidated' });
  timers.runAll();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].actors.map((actor) => actor.name), ['Grace', 'Ada']);
  assert.equal(describeLiveUpdateActors(batches[0].actors), 'Grace and Ada');
});

test('reconnects after the stream drops and flags the catch-up refresh', () => {
  const apiClient = fakeApi();
  const timers = fakeTimers();
  const batches = [];
  const stop = createProjectLiveUpdates({ apiClient, getToken: () => 'token', onChange: (batch) => batches.push(batch), projectId: 'p1', timers });

  apiClient.streams[0].handlers.onClose();
  timers.runAll();
  assert.equal(apiClient.streams.length, 2);

  apiClient.streams[1].handlers.onEvent({ data: {}, type: 'connected' });
  timers.runAll();
  assert.deepEqual(batches, [{ actors: [], reconnected: true }]);

  stop();
  assert.equal(apiClient.streams[1].stopped, true);
});
