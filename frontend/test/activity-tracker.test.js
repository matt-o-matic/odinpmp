import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createActivityTracker,
  createWorkingController,
  isWorkingCancellation,
  resolveWorkingMode,
} from '../src/lib/api/activity-tracker.js';
import { createApiClient, withWorkingMode } from '../src/lib/api/client.js';

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    clearTimer: (id) => timers.delete(id),
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
  };
}

function createTestTracker() {
  const clock = createClock();
  const tracker = createActivityTracker({ clearTimer: clock.clearTimer, setTimer: clock.setTimer });
  return { clock, tracker };
}

const view = ({ blocking, count, visible }) => ({ blocking, count, visible });

test('default calls show the banner at once and escalate to the dialog after 5 seconds', () => {
  const { clock, tracker } = createTestTracker();
  const call = tracker.begin();

  assert.deepEqual(view(tracker.getState()), { blocking: false, count: 1, visible: true });
  clock.advance(4999);
  assert.equal(tracker.getState().blocking, false);
  clock.advance(1);
  assert.equal(tracker.getState().blocking, true);

  call.end();
  assert.deepEqual(view(tracker.getState()), { blocking: false, count: 0, visible: false });
});

test('the escalation countdown restarts whenever no default call is in flight', () => {
  const { clock, tracker } = createTestTracker();
  const passive = tracker.begin({ mode: 'passive' });
  const first = tracker.begin();
  clock.advance(4000);
  first.end();
  const second = tracker.begin();
  clock.advance(4000);

  assert.equal(tracker.getState().blocking, false);
  clock.advance(1000);
  assert.equal(tracker.getState().blocking, true);
  second.end();
  passive.end();
});

test('passive calls stay hidden for 1 second, never block, and keep the banner until idle', () => {
  const { clock, tracker } = createTestTracker();
  const passive = tracker.begin({ mode: 'passive' });

  assert.equal(tracker.getState().visible, false);
  clock.advance(999);
  assert.equal(tracker.getState().visible, false);
  clock.advance(1);
  assert.equal(tracker.getState().visible, true);
  clock.advance(60000);
  assert.equal(tracker.getState().blocking, false);

  passive.end();
  assert.equal(tracker.getState().visible, false);
});

test('the passive delay counts from the start of the current stretch of activity', () => {
  const { clock, tracker } = createTestTracker();
  const first = tracker.begin({ mode: 'passive' });
  clock.advance(700);
  const second = tracker.begin({ mode: 'passive' });
  first.end();
  clock.advance(300);

  assert.equal(tracker.getState().visible, true);
  second.end();
});

test('once shown, the banner stays up until nothing is in flight', () => {
  const { tracker } = createTestTracker();
  const passive = tracker.begin({ mode: 'passive' });
  const user = tracker.begin();
  user.end();

  assert.equal(tracker.getState().visible, true, 'no flicker while passive work continues');
  passive.end();
  assert.equal(tracker.getState().visible, false);
});

test('blocking calls show the dialog immediately', () => {
  const { tracker } = createTestTracker();
  const call = tracker.begin({ mode: 'blocking' });

  assert.deepEqual(view(tracker.getState()), { blocking: true, count: 1, visible: true });
  call.end();
});

test('a call without a mode takes the mode of its signal', () => {
  const { tracker } = createTestTracker();
  const call = tracker.begin({ signal: createWorkingController('blocking').signal });

  assert.equal(call.mode, 'blocking');
  assert.equal(tracker.begin({ mode: 'passive', signal: createWorkingController('blocking').signal }).mode, 'passive');
  call.end();
});

test('cancel aborts every non-passive call and leaves background calls running', async () => {
  const { tracker } = createTestTracker();
  const hang = (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const blocking = tracker.track({ mode: 'blocking' }, hang);
  const user = tracker.track({}, hang);
  const background = tracker.begin({ mode: 'passive' });

  tracker.cancel();

  await assert.rejects(blocking, (error) => isWorkingCancellation(error) && error.message === 'Request cancelled.');
  await assert.rejects(user, (error) => isWorkingCancellation(error));
  assert.equal(background.signal.aborted, false);
  assert.equal(tracker.getState().count, 1);
  background.end();
});

test('aborting the caller signal aborts the tracked request', () => {
  const { tracker } = createTestTracker();
  const controller = new AbortController();
  const call = tracker.begin({ signal: controller.signal });

  controller.abort();
  assert.equal(call.signal.aborted, true);
  call.end();
});

test('the API client tracks each request with the mode chosen at the call site', async (t) => {
  const modes = [];
  const tracker = {
    track(options, run) {
      modes.push(resolveWorkingMode(options));
      return run(new AbortController().signal);
    },
  };
  t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' }, status: 200 }));
  const client = createApiClient({ activityTracker: tracker, baseUrl: 'http://odin.test/' });

  await client.getProjectKanbanConfig('p1', 'token');
  await client.passive.getProjectKanbanConfig('p1', 'token');
  await client.blocking.getProjectKanbanConfig('p1', 'token');
  await client.withSignal(createWorkingController('passive').signal).getProjectKanbanConfig('p1', 'token');
  await withWorkingMode({ getProjectKanbanConfig: async () => ({}) }, 'passive').getProjectKanbanConfig('p1', 'token');

  assert.deepEqual(modes, ['default', 'passive', 'blocking', 'passive']);
});
