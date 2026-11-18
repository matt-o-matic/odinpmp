import assert from 'node:assert/strict';
import test from 'node:test';

import { levelOption, NOTIFICATION_LEVEL_OPTIONS } from '../src/lib/notifications/levels.js';
import { applicationServerKey, badgeLabel, createNotificationsStore, groupByProject, titleWithCount } from '../src/lib/notifications/notifications.js';

// The bell's helpers and store (src/lib/notifications): the tab title count, grouping by day,
// reading, the live stream's refetches, the focus heartbeat and push off when the server or
// the browser can't do it.

test('the tab title carries the unread count, replacing any earlier one', () => {
  assert.equal(titleWithCount('OdinPMP', 3), '(3) OdinPMP');
  assert.equal(titleWithCount('(3) OdinPMP', 4), '(4) OdinPMP');
  assert.equal(titleWithCount('(4) OdinPMP', 0), 'OdinPMP');
  assert.equal(titleWithCount('Plan', 150), '(99+) Plan');
  assert.equal(titleWithCount('(99+) Plan', 1), '(1) Plan');
  assert.deepEqual([badgeLabel(0), badgeLabel(7), badgeLabel(100)], ['', '7', '99+']);
});

test('notifications group by project or engagement, newest first, with direct messages apart and System last', () => {
  const at = (minute) => new Date(2026, 10, 14, 12, minute).toISOString();
  const groups = groupByProject([
    { id: 'system', kind: 'other', readAt: null, updatedAt: at(59) },
    { id: 'a-old', kind: 'mention', projectId: 'p-a', projectName: 'Contoso pursuit', readAt: at(5), updatedAt: at(1) },
    { id: 'b', kind: 'channel_post', projectId: 'p-b', projectName: 'Northwind rollout', readAt: null, updatedAt: at(20) },
    { id: 'a-new', kind: 'thread_reply', projectId: 'p-a', projectName: 'Contoso pursuit', readAt: null, updatedAt: at(30) },
    { conversationId: 'dm-1', id: 'dm', kind: 'direct_message', readAt: null, updatedAt: at(10) },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.entries.map((entry) => entry.id), group.unreadCount]), [
    ['Contoso pursuit', ['a-new', 'a-old'], 1],
    ['Northwind rollout', ['b'], 1],
    ['Direct messages', ['dm'], 1],
    ['System', ['system'], 1],
  ]);
});

test('levels have one option each, and an unknown one shows as mentions', () => {
  assert.deepEqual(NOTIFICATION_LEVEL_OPTIONS.map((option) => option.level), ['all', 'mentions', 'off']);
  assert.equal(levelOption('nope').level, 'mentions');
});

test('a VAPID key decodes to its bytes', () => {
  assert.deepEqual([...applicationServerKey('AQIDBA')], [1, 2, 3, 4]);
  assert.deepEqual([...applicationServerKey('-_8')], [251, 255]);
});

function fakes({ hasFocus = true, serviceWorker = null } = {}) {
  const calls = [];
  const handlers = [];
  const listeners = new Map();
  let result = { notifications: [{ id: 'n1', readAt: null, updatedAt: '2026-11-14T10:00:00Z' }, { id: 'n2', readAt: null, updatedAt: '2026-11-14T09:00:00Z' }], unreadCount: 2 };
  const apiClient = {
    async getPushConfig() { calls.push('push'); return { available: true, publicKey: 'AQID' }; },
    async listNotifications() { calls.push('list'); return structuredClone(result); },
    async markNotificationsRead(payload) { calls.push(['read', payload]); return { unreadCount: payload.all ? 0 : 1 }; },
    async sendNotificationFocus(focused, _token, options) { calls.push(options?.leaving ? ['focus', focused, 'leaving'] : ['focus', focused]); return { ok: true }; },
    subscribeToMyEvents(token, handler) { handlers.push(handler); queueMicrotask(() => handler.onEvent({ data: {}, type: 'connected' })); return () => {}; },
  };
  const doc = {
    addEventListener: (type, callback) => listeners.set(`doc:${type}`, callback),
    hasFocus: () => hasFocus,
    removeEventListener: (type) => listeners.delete(`doc:${type}`),
    title: 'OdinPMP',
    visibilityState: 'visible',
  };
  const win = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type) => listeners.delete(type),
  };
  const intervals = [];
  const timers = { clear: (id) => { if (id) intervals[id - 1].cleared = true; }, every: (callback, ms) => intervals.push({ callback, ms }) };
  const store = createNotificationsStore({ apiClient, authSession: { state: { token: 'token' } }, doc, nav: serviceWorker ? { serviceWorker } : {}, timers, win });
  return { calls, doc, handlers, intervals, listeners, setResult: (next) => { result = next; }, store };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 200));

test('starting loads the list, sets the title, and sends a focus heartbeat while the tab is focused', async () => {
  const { calls, doc, intervals, listeners, store } = fakes();
  store.start();
  store.start();
  await flush();
  assert.equal(calls.filter((call) => call === 'list').length, 1, 'two bells share one store');
  assert.equal(store.state.unreadCount, 2);
  assert.equal(doc.title, '(2) OdinPMP');
  assert.deepEqual(calls.filter((call) => call[0] === 'focus'), [['focus', true]]);
  assert.equal(intervals[0].ms, 25_000);
  doc.hasFocus = () => false;
  listeners.get('blur')();
  assert.deepEqual(calls.filter((call) => call[0] === 'focus').at(-1), ['focus', false]);
  assert.equal(intervals[0].cleared, true);
  assert.equal(store.state.push.available, true);
  assert.equal(store.state.push.supported, false, 'no service worker here, so the bell does not offer push');
  store.stop();
  assert.ok(listeners.has('focus'), 'still one bell');
  store.stop();
  assert.ok(!listeners.has('focus'));
  assert.equal(doc.title, 'OdinPMP', 'the count leaves the title when the last bell goes');
});

test('a live event or a reconnect refetches, and reading updates the list, the count and the title', async () => {
  const { calls, doc, handlers, setResult, store } = fakes();
  store.start();
  await flush();
  setResult({ notifications: [{ id: 'n3', readAt: null, updatedAt: '2026-11-14T11:00:00Z' }], unreadCount: 3 });
  handlers[0].onEvent({ data: { id: 'n3' }, type: 'notification.created' });
  await flush();
  assert.equal(store.state.unreadCount, 3);
  assert.equal(doc.title, '(3) OdinPMP');

  await store.markRead(['n3']);
  assert.ok(store.state.notifications[0].readAt);
  assert.deepEqual(calls.at(-1), ['read', { ids: ['n3'] }]);
  assert.equal(doc.title, '(1) OdinPMP');
  await store.markAllRead();
  assert.equal(store.state.unreadCount, 0);
  assert.equal(doc.title, 'OdinPMP');

  const before = calls.filter((call) => call === 'list').length;
  handlers[1].onClose();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.ok(calls.filter((call) => call === 'list').length > before, 'a dropped stream reconnects and refetches the count');
  store.stop();
});

test('a hidden tab checks for notifications every half minute, and at once when a push arrives', async () => {
  const workerListeners = new Map();
  const serviceWorker = {
    addEventListener: (type, callback) => workerListeners.set(type, callback),
    getRegistration: async () => null,
    removeEventListener: (type) => workerListeners.delete(type),
  };
  const { calls, doc, intervals, listeners, setResult, store } = fakes({ hasFocus: false, serviceWorker });
  store.start();
  await flush();
  const lists = () => calls.filter((call) => call === 'list').length;
  assert.equal(intervals.length, 0, 'a visible tab has its live stream');

  doc.visibilityState = 'hidden';
  listeners.get('doc:visibilitychange')();
  const check = intervals.at(-1);
  assert.equal(check.ms, 30_000);
  setResult({ notifications: [{ id: 'n3', readAt: null, updatedAt: '2026-11-14T11:00:00Z' }], unreadCount: 3 });
  const before = lists();
  check.callback();
  await flush();
  assert.equal(lists(), before + 1);
  assert.equal(doc.title, '(3) OdinPMP');

  // The service worker says a push came: fetched now.
  setResult({ notifications: [], unreadCount: 4 });
  workerListeners.get('message')({ data: { type: 'odin-notification' } });
  await flush();
  assert.equal(doc.title, '(4) OdinPMP');
  workerListeners.get('message')({ data: { type: 'something-else' } });
  await flush();
  assert.equal(lists(), before + 2);

  doc.visibilityState = 'visible';
  listeners.get('doc:visibilitychange')();
  assert.equal(check.cleared, true, 'shown again, the live stream takes over');
  store.stop();
  assert.ok(!workerListeners.has('message'));
});

test('a page that unloads says it is no longer focused, in a request that outlives it', async () => {
  const { calls, intervals, listeners, store } = fakes();
  store.start();
  await flush();
  assert.equal(intervals[0].ms, 25_000, 'focused: the heartbeat runs');
  listeners.get('pagehide')();
  assert.deepEqual(calls.at(-1), ['focus', false, 'leaving']);
  assert.equal(intervals[0].cleared, true);
  store.stop();
  assert.ok(!listeners.has('pagehide'));
});
