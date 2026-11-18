import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANNEL_TYPING_EVENT,
  TYPING_EXPIRY_MS,
  TYPING_SEND_INTERVAL_MS,
  createTypingLiveUpdates,
  createTypingSender,
  createTypingTracker,
  supportsTyping,
  typingLabel,
  typingLabelFor,
} from '../src/lib/channels/typing.js';

// Timers that run only when the test moves the clock.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at <= now && pending.has(id)) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
    timers: {
      clear: (id) => pending.delete(id),
      set: (callback, delay) => {
        const id = nextId++;
        pending.set(id, { at: now + delay, callback });
        return id;
      },
    },
  };
}

const ana = { id: 'u-ana', name: 'Ana', type: 'user' };
const ben = { id: 'u-ben', name: 'Ben', type: 'user' };

test('the sender sends at most one signal per interval while keys are pressed', () => {
  const clock = fakeClock();
  const sent = [];
  const sender = createTypingSender({ now: clock.now, send: (typing) => sent.push([clock.now(), typing]) });
  sender.update('H');
  sender.update('He');
  clock.advance(1000);
  sender.update('Hel');
  clock.advance(TYPING_SEND_INTERVAL_MS - 1000 - 1);
  sender.update('Hell');
  assert.deepEqual(sent, [[0, true]], 'one signal in the first interval');
  clock.advance(1);
  sender.update('Hello');
  assert.deepEqual(sent, [[0, true], [TYPING_SEND_INTERVAL_MS, true]]);
  assert.ok(TYPING_SEND_INTERVAL_MS < TYPING_EXPIRY_MS, 'a steady typist never expires between signals');
});

test('the sender stops at once when the box empties or the message is sent, and only once', () => {
  const sent = [];
  const sender = createTypingSender({ now: () => 0, send: (typing) => sent.push(typing) });
  sender.update('   ');
  assert.deepEqual(sent, [], 'blank text is not typing');
  sender.update('Hi');
  sender.update('');
  sender.update('');
  assert.deepEqual(sent, [true, false]);
  // Typing again right after clearing signals at once, not after the interval.
  sender.update('Again');
  sender.stop();
  sender.stop();
  assert.deepEqual(sent, [true, false, true, false]);
  assert.equal(sender.active, false);
});

test('the sender drops a failed signal and keeps working', async () => {
  const sent = [];
  const sender = createTypingSender({ now: () => 0, send: (typing) => { sent.push(typing); return Promise.reject(new Error('offline')); } });
  sender.update('Hi');
  sender.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [true, false]);
});

test('the tracker shows a person until a few seconds after their last signal, and drops them at once on a stop', () => {
  const clock = fakeClock();
  const changes = [];
  const tracker = createTypingTracker({ onChange: (list) => changes.push(list.map((entry) => entry.name)), timers: clock.timers });
  tracker.receive({ actor: ana, typing: true });
  tracker.receive({ actor: ben, typing: true });
  assert.deepEqual(changes, [['Ana'], ['Ana', 'Ben']]);

  // Ana keeps typing: each signal pushes her expiry out, without a change.
  clock.advance(TYPING_EXPIRY_MS - 1000);
  tracker.receive({ actor: ana, typing: true });
  assert.equal(changes.length, 2);
  clock.advance(1000);
  assert.deepEqual(changes.at(-1), ['Ana'], 'Ben expired; Ana did not');
  clock.advance(TYPING_EXPIRY_MS - 1000 - 1);
  assert.deepEqual(tracker.list().map((entry) => entry.name), ['Ana']);
  clock.advance(1);
  assert.deepEqual(changes.at(-1), []);

  tracker.receive({ actor: ana, typing: true });
  tracker.receive({ actor: ana, typing: false });
  assert.deepEqual(changes.at(-1), [], 'gone at once when she sends or clears the box');
  clock.advance(TYPING_EXPIRY_MS);
  assert.deepEqual(tracker.list(), []);
});

test('the tracker keeps the channel box and each thread apart, and forgets everyone on clear', () => {
  const clock = fakeClock();
  const tracker = createTypingTracker({ timers: clock.timers });
  tracker.receive({ actor: ana, parentId: null, typing: true });
  tracker.receive({ actor: ben, parentId: 'thread-1', typing: true });
  tracker.receive({ actor: ana, parentId: 'thread-1', typing: true });
  // A guest with the same id string as a member is someone else.
  tracker.receive({ actor: { id: 'u-ana', name: 'Ana Guest', type: 'stakeholder' }, parentId: null, typing: true });
  assert.equal(typingLabelFor(tracker.list(), null), 'Ana and Ana Guest are typing…');
  assert.equal(typingLabelFor(tracker.list(), 'thread-1'), 'Ben and Ana are typing…');
  assert.equal(typingLabelFor(tracker.list(), 'thread-2'), '');
  tracker.receive({ actor: ana, parentId: 'thread-1', typing: false });
  assert.equal(typingLabelFor(tracker.list(), null), 'Ana and Ana Guest are typing…', 'a stop in a thread leaves the channel box');
  tracker.clear();
  assert.deepEqual(tracker.list(), []);
  tracker.receive({ actor: { name: 'Nobody' }, typing: true });
  assert.deepEqual(tracker.list(), [], 'no one without an id');
});

test('typing labels', () => {
  assert.equal(typingLabel([]), '');
  assert.equal(typingLabel(['Ana']), 'Ana is typing…');
  assert.equal(typingLabel(['Ana', 'Ben']), 'Ana and Ben are typing…');
  assert.equal(typingLabel(['Ana', 'Ben', 'Cy']), 'Ana, Ben and Cy are typing…');
  assert.equal(typingLabel(['Ana', 'Ben', 'Cy', 'Di', 'Ed']), 'Ana, Ben and 3 others are typing…');
});

test('typing comes through the stream the channel screens already use, for this channel only, never this tab’s own', async () => {
  let handlers = null;
  const opened = [];
  const api = {
    clientId: 'tab-1',
    sendChannelTyping: () => {},
    subscribeToProjectEvents(projectId, token, given) {
      opened.push([projectId, token]);
      handlers = given;
      return () => {};
    },
  };
  assert.equal(supportsTyping(api), true);
  assert.equal(supportsTyping({ subscribeToProjectEvents() {} }), false, 'a direct message API has no typing route');
  const received = [];
  const stop = createTypingLiveUpdates({ api, channelId: 'c1', getToken: () => 'token-1', onEvent: (event) => received.push(event), projectId: 'p1' });
  assert.deepEqual(opened, [['p1', 'token-1']]);
  const event = (data) => handlers.onEvent({ data: { type: CHANNEL_TYPING_EVENT, typing: true, ...data }, type: CHANNEL_TYPING_EVENT });
  event({ actor: ana, channelId: 'c1' });
  event({ actor: ben, channelId: 'c2' });
  event({ actor: ana, channelId: 'c1', originClientId: 'tab-1' });
  handlers.onEvent({ data: { actor: ben, channelId: 'c1' }, type: 'channel.updated' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(received.map((entry) => [entry.actor.name, entry.channelId]), [['Ana', 'c1']]);
  stop();
});

test('guests hear typing on their own stream', async () => {
  let handlers = null;
  const api = { clientId: 'guest-tab', sendChannelTyping: () => {}, subscribeToEvents(given) { handlers = given; return () => {}; } };
  const received = [];
  const stop = createTypingLiveUpdates({ api, channelId: 'c1', onEvent: (event) => received.push(event), projectId: 'p1' });
  handlers.onEvent({ data: { actor: ana, channelId: 'c1', typing: true }, type: CHANNEL_TYPING_EVENT });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.length, 1);
  stop();
});
