import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canExtendLink,
  canRevokeLink,
  linkExtensionBounds,
  linkLastUsedText,
  linkStatusChip,
  linkValidityText,
  stakeholderLinkOptions,
} from '../src/lib/requirements/requirements-links.js';
import {
  REQUIREMENTS_EVENT_TYPES,
  batchHasType,
  batchTouchesTopic,
  batchTouchesTrack,
  createRequirementsLiveUpdates,
  mergeRequirementsEvent,
} from '../src/lib/requirements/requirements-live-updates.js';
import { endOfLocalDayIso, formatAgo, formatRelativeDay, toDateInputValue } from '../src/lib/requirements/requirements-time.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    clear(id) { pending.delete(id); },
    flush() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pending,
    set(callback) { const id = nextId++; pending.set(id, callback); return id; },
  };
}

function fakeClient() {
  const streams = [];
  return {
    streams,
    subscribeToProjectEvents(projectId, token, handlers) {
      const stream = { handlers, projectId, stopped: false, token };
      streams.push(stream);
      return () => { stream.stopped = true; };
    },
  };
}

test('live updates batch requirements events and ignore everything else', () => {
  const timers = fakeTimers();
  const client = fakeClient();
  const batches = [];
  const stop = createRequirementsLiveUpdates({ apiClient: client, getToken: () => 'token', onChange: (batch) => batches.push(batch), projectId: 'p1', timers });

  const { onEvent } = client.streams[0].handlers;
  onEvent({ data: {}, type: 'connected' });
  onEvent({ data: { actor: { name: 'Sam' } }, type: 'project.assets.invalidated' });
  onEvent({ data: { topicIds: ['t1'], track: 'experience' }, type: REQUIREMENTS_EVENT_TYPES.topics });
  onEvent({ data: { topicIds: ['t1', 't2'], track: 'experience' }, type: REQUIREMENTS_EVENT_TYPES.decisions });
  timers.flush();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], {
    packageIds: [],
    reconnected: false,
    topicIds: ['t1', 't2'],
    tracks: ['experience'],
    types: [REQUIREMENTS_EVENT_TYPES.topics, REQUIREMENTS_EVENT_TYPES.decisions],
  });
  stop();
  assert.equal(client.streams[0].stopped, true);
});

test('a dropped stream reconnects and flags the first batch so everything refetches', () => {
  const timers = fakeTimers();
  const client = fakeClient();
  const batches = [];
  createRequirementsLiveUpdates({ apiClient: client, getToken: () => 'token', onChange: (batch) => batches.push(batch), projectId: 'p1', timers });

  client.streams[0].handlers.onClose();
  timers.flush();
  assert.equal(client.streams.length, 2);
  client.streams[1].handlers.onEvent({ data: {}, type: 'connected' });
  timers.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].reconnected, true);
});

test('a shared stream that opens again after the tab was hidden flags the next batch', () => {
  const timers = fakeTimers();
  const client = fakeClient();
  const batches = [];
  createRequirementsLiveUpdates({ apiClient: client, getToken: () => 'token', onChange: (batch) => batches.push(batch), projectId: 'p1', timers });

  client.streams[0].handlers.onEvent({ data: {}, type: 'connected' });
  timers.flush();
  assert.equal(batches.length, 0);
  client.streams[0].handlers.onEvent({ data: {}, resumed: true, type: 'connected' });
  timers.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].reconnected, true);
});

test('batches decide which views refetch', () => {
  const topics = mergeRequirementsEvent(null, { data: { topicIds: ['t1'], track: 'experience' }, type: REQUIREMENTS_EVENT_TYPES.topics });
  assert.equal(batchTouchesTopic(topics, 't1'), true);
  assert.equal(batchTouchesTopic(topics, 't2'), false);
  assert.equal(batchTouchesTrack(topics, 'experience'), true);
  assert.equal(batchTouchesTrack(topics, 'architecture'), false);

  const preference = mergeRequirementsEvent(null, { data: { track: 'experience' }, type: REQUIREMENTS_EVENT_TYPES.decisions });
  assert.equal(batchTouchesTopic(preference, 't9'), true);

  const links = mergeRequirementsEvent(null, { data: {}, type: REQUIREMENTS_EVENT_TYPES.links });
  assert.equal(batchTouchesTopic(links, 't1'), false);
  assert.equal(batchHasType(links, REQUIREMENTS_EVENT_TYPES.links), true);
  assert.equal(batchTouchesTrack(links, 'experience'), true);

  const summary = mergeRequirementsEvent(null, { data: { scopeId: 't3', scopeType: 'topic' }, type: REQUIREMENTS_EVENT_TYPES.summary });
  assert.deepEqual(summary.topicIds, ['t3']);
  assert.equal(batchTouchesTopic({ reconnected: true, topicIds: [], tracks: [], types: [] }, 'any'), true);
});

test('link status and validity text', () => {
  const locale = 'en-US';
  assert.deepEqual(linkStatusChip({ status: 'active' }), { label: 'Active', tone: 'ok' });
  assert.deepEqual(linkStatusChip({ status: 'expired' }), { label: 'Expired', tone: 'outline' });
  assert.deepEqual(linkStatusChip({ status: 'revoked' }), { label: 'Revoked', tone: 'bad' });
  assert.equal(linkValidityText({ involvementActive: true, status: 'active' }), 'While involved, then 14 days');
  assert.equal(linkValidityText({ extendedUntil: '2026-12-01T12:00:00Z', involvementActive: true, status: 'active' }, { locale }), 'While involved, at least until Dec 1');
  assert.equal(linkValidityText({ expiresAt: '2026-10-20T12:00:00Z', status: 'active' }, { locale }), 'Until Oct 20');
  assert.equal(linkValidityText({ expiresAt: '2026-10-01T12:00:00Z', status: 'expired' }, { locale }), 'Expired Oct 1');
  assert.equal(linkValidityText({ revokedAt: '2026-10-02T12:00:00Z', status: 'revoked' }, { locale }), 'Revoked Oct 2');
  assert.equal(linkLastUsedText({ lastUsedAt: null }), 'Not used yet');
  assert.equal(canExtendLink({ status: 'expired' }), true);
  assert.equal(canRevokeLink({ status: 'revoked' }), false);
});

test('extension bounds run from tomorrow to under a year, defaulting 14 days past the later of now and expiry', () => {
  const now = new Date(2026, 9, 7, 12);
  assert.deepEqual(linkExtensionBounds({ expiresAt: null }, { now }), { defaultValue: '2026-10-21', max: '2027-10-06', min: '2026-10-08' });
  assert.equal(linkExtensionBounds({ expiresAt: new Date(2026, 9, 30, 12).toISOString() }, { now }).defaultValue, '2026-11-13');
  const end = new Date(endOfLocalDayIso('2026-10-21'));
  assert.equal(end.getDate(), 21);
  assert.deepEqual([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()], [23, 59, 59, 999]);
  assert.equal(new Date(end.valueOf() + 1).getDate(), 22, 'one millisecond later is the next day');
  assert.equal(endOfLocalDayIso('not a date'), '');
});

test('stakeholder options are sorted and show an existing link', () => {
  const options = stakeholderLinkOptions(
    [{ email: 'r@x', id: 's2', name: 'Ravi' }, { email: 'j@x', id: 's1', name: 'Jamie' }, { id: '' }],
    [{ id: 'l1', stakeholder: { id: 's2' } }],
  );
  assert.deepEqual(options.map((option) => [option.name, option.link?.id ?? null]), [['Jamie', null], ['Ravi', 'l1']]);
});

test('relative time phrases', () => {
  const now = new Date(2026, 9, 7, 12, 0);
  assert.equal(formatAgo(new Date(2026, 9, 7, 11, 54), { now }), '6 min ago');
  assert.equal(formatAgo(new Date(2026, 9, 7, 11, 59, 40), { now }), 'just now');
  assert.equal(formatAgo(new Date(2026, 9, 7, 9, 0), { now }), '3 h ago');
  assert.equal(formatRelativeDay(new Date(2026, 9, 6, 23), { now }), 'yesterday');
  assert.equal(formatRelativeDay(new Date(2026, 8, 20), { locale: 'en-US', now }), 'Sep 20');
  assert.equal(formatRelativeDay('', { now }), '');
  assert.equal(toDateInputValue(new Date(2026, 0, 5)), '2026-01-05');
});
