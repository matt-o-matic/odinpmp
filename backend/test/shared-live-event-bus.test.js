import assert from 'node:assert/strict';
import test from 'node:test';

import { createSharedLiveEventBus } from '../src/lib/events/shared-live-event-bus.js';

function repository() {
  const events = [];
  return {
    async append(event) { events.push({ ...structuredClone(event), sequence: events.length + 1 }); },
    async latestSequence() { return events.length; },
    async listAfter({ sequence }) { return events.filter((event) => event.sequence > sequence); },
  };
}

test('shared live-event buses relay cross-instance invalidations once while preserving immediate local delivery', async () => {
  const shared = repository(); const first = createSharedLiveEventBus({ instanceId: 'first', pollIntervalMs: 60_000, repository: shared }); const second = createSharedLiveEventBus({ instanceId: 'second', pollIntervalMs: 60_000, repository: shared });
  await Promise.all([first.ready, second.ready]); const firstEvents = []; const secondEvents = []; first.subscribe('project:1', (event) => firstEvents.push(event)); second.subscribe('project:1', (event) => secondEvents.push(event));
  first.publish('project:1', { reason: 'updated', type: 'invalidate' }); assert.equal(firstEvents.length, 1); assert.equal(secondEvents.length, 0); await first.flush(); await second.poll(); assert.equal(secondEvents.length, 1); assert.equal(secondEvents[0].reason, 'updated');
  await second.poll(); assert.equal(secondEvents.length, 1); second.publish('project:1', { reason: 'deleted', type: 'invalidate' }); await second.flush(); await first.poll(); assert.equal(firstEvents.length, 2); assert.equal(firstEvents[1].reason, 'deleted');
  await Promise.all([first.stop(), second.stop()]);
});

test('a typing signal reaches another backend process through the shared bus, and goes stale after its short TTL', async () => {
  const { CHANNEL_TYPING_EVENT, TYPING_RELAY_TTL_MS, publishChannelTyping } = await import('../src/modules/channels/channel-events.js');
  const shared = repository(); const first = createSharedLiveEventBus({ instanceId: 'first', pollIntervalMs: 60_000, repository: shared }); const second = createSharedLiveEventBus({ instanceId: 'second', pollIntervalMs: 60_000, repository: shared });
  await Promise.all([first.ready, second.ready]);
  const seen = []; second.subscribe('project:p1', (event) => seen.push(event));
  const signal = { actor: { id: 'u1', name: 'Ana', type: 'user' }, channelId: 'c1', parentId: null, projectId: 'p1', typing: true };

  // In time: the other process delivers it, with the relay row expiring in seconds, not minutes.
  const sentAt = Date.now();
  publishChannelTyping(first, signal); await first.flush(); await second.poll();
  assert.deepEqual(seen.map((event) => [event.type, event.actor.name, event.channelId, event.typing]), [[CHANNEL_TYPING_EVENT, 'Ana', 'c1', true]]);
  const expiresIn = Date.parse((await shared.listAfter({ sequence: 0 }))[0].expiresAt) - sentAt;
  assert.ok(expiresIn <= TYPING_RELAY_TTL_MS + 50 && expiresIn > 0, `expires in ${expiresIn} ms`);

  // Late (a stalled poll): a stale signal is dropped, not shown.
  publishChannelTyping(first, signal); await first.flush();
  const stale = await shared.listAfter({ sequence: 1 }); stale[0].expiresAt = new Date(Date.now() - 1).toISOString();
  await second.poll(); assert.equal(seen.length, 1);
  await Promise.all([first.stop(), second.stop()]);
});
