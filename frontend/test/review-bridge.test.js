import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_SOURCE,
  FRAME_SANDBOX,
  MAX_SNAPSHOT_DATA_URL,
  captureCommand,
  createRequestTracker,
  fitScale,
  frameSrc,
  gotoStateCommand,
  hintCommand,
  matchDeclaredState,
  parseBridgeMessage,
  pingCommand,
} from '../src/lib/requirements/review-bridge.js';

const frameWindow = { name: 'our frame' };
const otherWindow = { name: 'something else' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function event(data, { origin = 'null', source = frameWindow } = {}) {
  return { data, origin, source };
}

function bridge(fields) {
  return { source: BRIDGE_SOURCE, version: 1, ...fields };
}

const READY = bridge({
  scroll: { height: 1600, width: 1280, x: 0, y: 0 },
  state: { declared: true, hash: '', key: 'choose-service', path: 'prototypes/booking/index.html' },
  type: 'ready',
  viewport: { devicePixelRatio: 1, height: 800, width: 1280 },
});

test('a well-formed message from our frame is accepted and rebuilt field by field', () => {
  const parsed = parseBridgeMessage(event({ ...READY, extra: '<img src=x onerror=alert(1)>' }), frameWindow);
  assert.deepEqual(parsed, {
    scroll: { height: 1600, width: 1280, x: 0, y: 0 },
    state: { declared: true, hash: '', key: 'choose-service', path: 'prototypes/booking/index.html' },
    type: 'ready',
    viewport: { devicePixelRatio: 1, height: 800, width: 1280 },
  });
  assert.equal('extra' in parsed, false);
  assert.deepEqual(parseBridgeMessage(event(bridge({ declared: false, hash: '#confirm', key: 'prototypes/booking/index.html#confirm', path: 'prototypes/booking/index.html', type: 'state' })), frameWindow), {
    state: { declared: false, hash: '#confirm', key: 'prototypes/booking/index.html#confirm', path: 'prototypes/booking/index.html' },
    type: 'state',
  });
});

test('messages from any other window are rejected, even with the right fields', () => {
  assert.equal(parseBridgeMessage(event(READY, { source: otherWindow }), frameWindow), null);
  assert.equal(parseBridgeMessage(event(READY, { source: null }), frameWindow), null);
  assert.equal(parseBridgeMessage(event(READY), null), null, 'no frame yet');
  // The frame is sandboxed with an opaque origin; a real origin means it is not our frame.
  assert.equal(parseBridgeMessage(event(READY, { origin: 'https://review.odinpmp.com' }), frameWindow), null);
});

test('messages without the bridge source or version are rejected', () => {
  assert.equal(parseBridgeMessage(event({ ...READY, source: 'hostile-report' }), frameWindow), null);
  assert.equal(parseBridgeMessage(event({ ...READY, source: undefined }), frameWindow), null);
  assert.equal(parseBridgeMessage(event({ ...READY, version: 2 }), frameWindow), null);
  assert.equal(parseBridgeMessage(event({ ...READY, version: '1' }), frameWindow), null);
  assert.equal(parseBridgeMessage(event({ ...READY, type: 'goto-state' }), frameWindow), null, 'commands are not inbound types');
});

test('malformed payloads are rejected', () => {
  const malformed = [
    null,
    'ready',
    [READY],
    Object.assign(Object.create({ inherited: true }), READY),
    { ...READY, state: null },
    { ...READY, state: { ...READY.state, key: 42 } },
    { ...READY, state: { ...READY.state, key: '' } },
    { ...READY, state: { ...READY.state, key: 'x'.repeat(601) } },
    { ...READY, viewport: { height: 800, width: Number.NaN } },
    { ...READY, viewport: { height: '800', width: 1280 } },
    { ...READY, scroll: { x: Number.POSITIVE_INFINITY, y: 0 } },
    bridge({ type: 'state', key: { toString: () => 'x' }, path: '', hash: '' }),
    bridge({ type: 'scroll' }),
    bridge({ type: 'capture', requestId: 'c1', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', width: 10, height: 10, stateKey: 'a', scroll: {} }),
    bridge({ type: 'capture', requestId: 'c1', dataUrl: 'javascript:alert(1)', width: 10, height: 10, stateKey: 'a', scroll: {} }),
    bridge({ type: 'capture', requestId: 'c1', dataUrl: `data:image/png;base64,${'A'.repeat(MAX_SNAPSHOT_DATA_URL)}`, width: 10, height: 10, stateKey: 'a', scroll: {} }),
    bridge({ type: 'capture', requestId: 'c1', dataUrl: PNG, width: 0, height: 10, stateKey: 'a', scroll: {} }),
    bridge({ type: 'capture', requestId: 7, dataUrl: PNG, width: 10, height: 10, stateKey: 'a', scroll: {} }),
    bridge({ type: 'capture-failed', requestId: { id: 1 } }),
    bridge({ type: 'hint', requestId: 'h1', x: 1, y: 2, hint: { box: { x: 0, y: 0, width: 10, height: 10 }, odinId: 'cta', tag: '<script>', text: 'Hi' } }),
    bridge({ type: 'hint', requestId: 'h1', x: 1, y: 2, hint: { box: { x: 0, y: 0, width: -1, height: 10 }, tag: 'a' } }),
    bridge({ type: 'hint', requestId: 'h1', x: 1, y: 2, hint: 'button' }),
    bridge({ type: 'hint', requestId: 'h1', x: 'one', y: 2, hint: null }),
  ];
  for (const data of malformed) {
    assert.equal(parseBridgeMessage(event(data), frameWindow), null, JSON.stringify(data)?.slice(0, 120));
  }
});

test('capture, capture-failed, and hint replies keep only the fields the spec defines', () => {
  assert.deepEqual(parseBridgeMessage(event(bridge({ dataUrl: PNG, height: 800, requestId: 'c1', scroll: { x: 0, y: 40 }, stateKey: 'pick-time', type: 'capture', width: 1280 })), frameWindow), {
    dataUrl: PNG,
    height: 800,
    requestId: 'c1',
    scroll: { height: 0, width: 0, x: 0, y: 40 },
    stateKey: 'pick-time',
    type: 'capture',
    width: 1280,
  });
  assert.deepEqual(parseBridgeMessage(event(bridge({ reason: 'x'.repeat(400), requestId: 'c2', type: 'capture-failed' })), frameWindow), {
    reason: 'x'.repeat(300),
    requestId: 'c2',
    type: 'capture-failed',
  });
  const hint = parseBridgeMessage(event(bridge({
    hint: { box: { height: 40, width: 200, x: 10, y: 20 }, odinId: 'continue', tag: 'A', text: `Continue to confirm →${' and more'.repeat(20)}` },
    requestId: 'h1',
    type: 'hint',
    x: 15,
    y: 25,
  })), frameWindow);
  assert.equal(hint.hint.tag, 'a');
  assert.equal(hint.hint.odinId, 'continue');
  assert.equal(hint.hint.text.length, 80);
  assert.deepEqual(parseBridgeMessage(event(bridge({ hint: null, requestId: 'h2', type: 'hint', x: 0, y: 0 })), frameWindow).hint, null);
});

test('commands to the bridge are bounded and goto-state accepts only ids', () => {
  assert.deepEqual(captureCommand({ requestId: 'c1', scale: 9 }), { requestId: 'c1', scale: 2, type: 'capture' });
  assert.deepEqual(captureCommand({ requestId: 'c1', scale: 0.1 }), { requestId: 'c1', scale: 0.25, type: 'capture' });
  assert.deepEqual(hintCommand({ requestId: 'h1', x: 10.6, y: '4' }), { requestId: 'h1', type: 'hint', x: 11, y: 4 });
  assert.deepEqual(gotoStateCommand('pick-time'), { key: 'pick-time', type: 'goto-state' });
  assert.equal(gotoStateCommand('Pick Time'), null);
  assert.equal(gotoStateCommand('../x'), null);
  assert.equal(gotoStateCommand('a'.repeat(65)), null);
  assert.deepEqual(pingCommand(), { type: 'ping' });
  assert.equal(FRAME_SANDBOX, 'allow-scripts allow-forms');
});

test('the frame address adds the app origin in the query and refuses non-web URLs', () => {
  assert.equal(
    frameSrc('https://review.odinpmp.com/p/pkg-1/grant.abc/prototypes/booking/index.html', 'https://odinpmp.com'),
    'https://review.odinpmp.com/p/pkg-1/grant.abc/prototypes/booking/index.html?odin-parent=https%3A%2F%2Fodinpmp.com',
  );
  assert.equal(frameSrc('javascript:alert(1)', 'https://odinpmp.com'), '');
  assert.equal(frameSrc('data:text/html,<script>1</script>', 'https://odinpmp.com'), '');
  assert.equal(frameSrc('not a url', 'https://odinpmp.com'), '');
  assert.equal(frameSrc('', 'https://odinpmp.com'), '');
});

test('the frame scales down to fit, never up, and states match by key or hash', () => {
  assert.equal(fitScale(1280, 640), 0.5);
  assert.equal(fitScale(1280, 2000), 1);
  assert.equal(fitScale(1280, 0), 1);
  const states = [{ key: 'choose-service' }, { key: 'pick-time' }];
  assert.equal(matchDeclaredState({ hash: '', key: 'pick-time' }, states), 'pick-time');
  assert.equal(matchDeclaredState({ hash: '#choose-service', key: 'prototypes/booking/index.html#choose-service' }, states), 'choose-service');
  assert.equal(matchDeclaredState({ hash: '#other', key: 'other' }, states), '');
  assert.equal(matchDeclaredState(null, states), '');
});

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    clear(id) { pending.delete(id); },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pending,
    set(callback) { const id = nextId++; pending.set(id, callback); return id; },
  };
}

test('requests settle with their reply, time out gracefully, and never reject', async () => {
  const timers = fakeTimers();
  const tracker = createRequestTracker({ timers });
  const answered = tracker.start('c1', { kind: 'capture', onTimeout: () => ({ ok: false, reason: 'timeout' }), timeoutMs: 100 });
  const late = tracker.start('c2', { kind: 'capture', onTimeout: () => ({ ok: false, reason: 'timeout' }), timeoutMs: 100 });
  assert.equal(tracker.size, 2);
  assert.equal(tracker.settle('c1', { ok: true }), true);
  assert.equal(tracker.settle('c1', { ok: true }), false, 'a duplicate reply is ignored');
  assert.equal(tracker.settle('unknown', { ok: true }), false);
  timers.fire();
  assert.deepEqual(await answered, { ok: true });
  assert.deepEqual(await late, { ok: false, reason: 'timeout' });
  assert.equal(tracker.settle('c2', { ok: true }), false, 'a reply after the timeout is ignored');

  const hint = tracker.start('h1', { kind: 'hint', timeoutMs: 100 });
  tracker.cancelAll((kind) => ({ kind, ok: false }));
  assert.deepEqual(await hint, { kind: 'hint', ok: false });
  assert.equal(tracker.size, 0);
});
