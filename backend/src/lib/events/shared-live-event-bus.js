import { randomUUID } from 'node:crypto';

import { buildOperationLogContext, logBackendError } from '../logging/backend-logger.js';
import { createLiveEventBus } from './live-event-bus.js';

export function createSharedLiveEventBus({ instanceId = randomUUID(), pollIntervalMs = 250, repository, retentionMs = 5 * 60_000 } = {}) {
  if (!repository) throw new Error('Shared live event bus requires a repository.');
  const local = createLiveEventBus(); let cursor = 0; let pollCount = 0; let polling = false; let stopped = false; const pending = new Set();
  const ready = repository.latestSequence().then((value) => { cursor = value; return value; });
  async function poll() {
    if (stopped || polling) return [];
    polling = true;
    try {
      await ready; const events = await repository.listAfter({ sequence: cursor });
      for (const event of events) { cursor = Math.max(cursor, event.sequence); if (event.originId !== instanceId && (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())) local.publish(event.channel, event.payload); }
      pollCount += 1; if (pollCount % 240 === 0) await repository.purgeExpired?.();
      return events;
    } catch (error) { logBackendError({ context: buildOperationLogContext('shared-live-event-bus.poll', { instanceId }), error, level: 'warn', message: 'Shared live-event polling failed.' }); return []; }
    finally { polling = false; }
  }
  const timer = setInterval(() => { void poll(); }, Math.max(50, Number(pollIntervalMs) || 250)); timer.unref?.();
  return {
    instanceId,
    ready,
    // `ttlMs` shortens how long other instances may still deliver the event: a typing signal is
    // worthless after a few seconds, so its relay row expires with it.
    publish(channel, event = {}, { ttlMs = retentionMs } = {}) { local.publish(channel, event); const operation = ready.then(() => repository.append({ channel, eventId: randomUUID(), expiresAt: new Date(Date.now() + Math.min(retentionMs, Math.max(1000, Number(ttlMs) || retentionMs))).toISOString(), originId: instanceId, payload: event })).catch((error) => { logBackendError({ context: buildOperationLogContext('shared-live-event-bus.publish', { channel, instanceId }), error, level: 'warn', message: 'Shared live-event persistence failed.' }); }).finally(() => pending.delete(operation)); pending.add(operation); },
    subscribe: local.subscribe,
    poll,
    async flush() { await Promise.all([...pending]); },
    async stop() { stopped = true; clearInterval(timer); await Promise.all([...pending]); },
  };
}
