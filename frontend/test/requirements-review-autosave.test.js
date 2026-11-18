import assert from 'node:assert/strict';
import test from 'node:test';

import { createAutosave, describeSaveStatus } from '../src/lib/requirements/review-autosave.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    clear(id) { pending.delete(id); },
    async fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
      await settle();
    },
    pending,
    set(callback, delay) { const id = nextId++; pending.set(id, callback); callback.delay = delay; return id; },
  };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}

test('an immediate save runs at once and reports Saving, then Saved', async () => {
  const states = [];
  const save = createAutosave({ now: () => new Date('2026-10-07T10:42:00'), onChange: (status) => states.push(status.state) });
  const gate = deferred();
  const calls = [];
  save.schedule('verdict:home', async () => { calls.push('home'); await gate.promise; });
  assert.deepEqual(calls, ['home']);
  assert.equal(save.status().state, 'saving');
  gate.resolve();
  await settle();
  assert.equal(save.status().state, 'saved');
  assert.equal(save.status().savedAt.getHours(), 10);
  assert.ok(states.includes('saving'));
  assert.equal(states.at(-1), 'saved');
  assert.equal(save.hasPending('verdict:home'), false);
});

test('coalesces trailing saves for one key so only the last state is sent', async () => {
  const timers = fakeTimers();
  const save = createAutosave({ timers });
  const sent = [];
  for (const x of [10, 15, 20, 25]) save.schedule('annotation:a', async () => { sent.push(x); }, { delay: 400 });
  assert.equal(timers.pending.size, 1, 'one timer for the key');
  assert.equal([...timers.pending.values()][0].delay, 400);
  assert.deepEqual(sent, []);
  assert.equal(save.status().state, 'saving');
  await timers.fire();
  assert.deepEqual(sent, [25]);
  assert.equal(save.status().state, 'saved');
});

test('one key runs in order: a newer save waits for the request in flight', async () => {
  const save = createAutosave();
  const first = deferred();
  const order = [];
  save.schedule('answer:q1', async () => { order.push('start 1'); await first.promise; order.push('end 1'); });
  save.schedule('answer:q1', async () => { order.push('run 2'); });
  save.schedule('answer:q1', async () => { order.push('run 3'); });
  assert.deepEqual(order, ['start 1']);
  first.resolve();
  await settle();
  assert.deepEqual(order, ['start 1', 'end 1', 'run 3'], 'the superseded run 2 never went out');
});

test('different keys save independently', async () => {
  const save = createAutosave();
  const slow = deferred();
  const order = [];
  save.schedule('verdict:a', async () => { await slow.promise; order.push('a'); });
  save.schedule('verdict:b', async () => { order.push('b'); });
  await settle();
  assert.deepEqual(order, ['b']);
  slow.resolve();
  await settle();
  assert.deepEqual(order, ['b', 'a']);
});

test('a failed save keeps the draft, reports Couldn\'t save, and Retry sends it again', async () => {
  const errors = [];
  const save = createAutosave({ onError: (key, error) => { errors.push([key, error.message]); } });
  let fail = true;
  const sent = [];
  save.schedule('verdict:home', async () => {
    sent.push('try');
    if (fail) throw new Error('offline');
  });
  await settle();
  assert.equal(save.status().state, 'error');
  assert.equal(save.status().failed, 1);
  assert.equal(save.status().error.message, 'offline');
  assert.deepEqual(errors, [['verdict:home', 'offline']]);
  assert.equal(save.hasPending('verdict:home'), true, 'the failed draft is still held');
  assert.ok(save.pendingKeys().has('verdict:home'));

  // A save for another key does not hide the failure.
  save.schedule('verdict:other', async () => {});
  await settle();
  assert.equal(save.status().state, 'error');

  fail = false;
  save.retry();
  await settle();
  assert.deepEqual(sent, ['try', 'try']);
  assert.equal(save.status().state, 'saved');
  assert.equal(save.hasPending('verdict:home'), false);
});

test('a newer edit replaces a failed one for the same key', async () => {
  const save = createAutosave();
  save.schedule('note:a', async () => { throw new Error('offline'); });
  await settle();
  assert.equal(save.status().state, 'error');
  const sent = [];
  save.schedule('note:a', async () => { sent.push('new'); });
  await settle();
  assert.deepEqual(sent, ['new']);
  assert.equal(save.status().state, 'saved');
});

test('an error the caller handles is dropped instead of kept for Retry', async () => {
  const save = createAutosave({ onError: (_key, error) => error.status === 409 });
  save.schedule('verdict:a', async () => { const error = new Error('closed'); error.status = 409; throw error; });
  await settle();
  assert.equal(save.status().state, 'idle');
  assert.equal(save.hasPending('verdict:a'), false);
});

test('flush runs a waiting save now and throws when it fails', async () => {
  const timers = fakeTimers();
  const save = createAutosave({ timers });
  const sent = [];
  save.schedule('annotation:a', async () => { sent.push('a'); }, { delay: 400 });
  await save.flush('annotation:a');
  assert.deepEqual(sent, ['a']);
  assert.equal(timers.pending.size, 0);

  save.schedule('annotation:b', async () => { throw new Error('nope'); }, { delay: 400 });
  await assert.rejects(save.flush('annotation:b'), /nope/);
  await save.flush('annotation:none');
});

test('flushAll settles everything and cancel drops a queued save', async () => {
  const timers = fakeTimers();
  const save = createAutosave({ timers });
  const sent = [];
  save.schedule('a', async () => { sent.push('a'); }, { delay: 400 });
  save.schedule('b', async () => { sent.push('b'); }, { delay: 400 });
  save.cancel('b');
  const status = await save.flushAll();
  assert.deepEqual(sent, ['a']);
  assert.equal(status.state, 'saved');
});

test('silent saves never show as Saving or Couldn’t save', async () => {
  const save = createAutosave();
  const gate = deferred();
  save.schedule('position', async () => { await gate.promise; }, { silent: true });
  assert.equal(save.status().state, 'idle');
  gate.reject(new Error('offline'));
  await settle();
  assert.equal(save.status().state, 'idle');
  assert.equal(save.hasPending('position'), true, 'it is still kept for Retry');
});

test('describeSaveStatus gives the header text', () => {
  assert.deepEqual(describeSaveStatus({ state: 'idle' }), { label: '', tone: 'idle' });
  assert.deepEqual(describeSaveStatus({ state: 'saving' }), { label: 'Saving…', tone: 'saving' });
  assert.deepEqual(describeSaveStatus({ state: 'error' }), { label: 'Couldn’t save', tone: 'error' });
  const saved = describeSaveStatus({ savedAt: new Date('2026-10-07T10:42:00'), state: 'saved' }, { locale: 'en-US' });
  assert.equal(saved.tone, 'saved');
  assert.match(saved.label, /^Saved 10:42/);
});
