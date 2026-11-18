import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInMemoryDomainEventOutboxRepository,
  dispatchDomainEventOutbox,
} from '../src/lib/events/domain-event-outbox.js';

test('domain event outbox deduplicates, dispatches, and records completion', async () => {
  const repository = createInMemoryDomainEventOutboxRepository();
  const input = {
    eventType: 'governance.changed', idempotencyKey: 'request-1',
    payload: { action: 'created', entityId: 'risk-1' }, projectId: 'project-1', tenantId: 'tenant-1',
  };
  const first = await repository.enqueue(input);
  const duplicate = await repository.enqueue(input);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.event.id, first.event.id);

  const handled = [];
  assert.deepEqual(await dispatchDomainEventOutbox({
    handlers: { 'governance.changed': async (event) => handled.push(event.payload) },
    now: new Date(first.event.availableAt), repository,
  }), [{ eventId: first.event.id, status: 'processed' }]);
  assert.deepEqual(handled, [input.payload]);
  const [stored] = await repository.list();
  assert.equal(stored.status, 'processed');
  assert.equal(stored.attempts, 1);
  assert.equal(stored.leaseToken, null);
});

test('domain event outbox reclaims expired leases, retries, and dead-letters bounded failures', async () => {
  const repository = createInMemoryDomainEventOutboxRepository();
  const { event } = await repository.enqueue({ eventType: 'governance.changed', idempotencyKey: 'request-2', tenantId: 'tenant-1' });
  const start = new Date(event.availableAt);
  const [abandoned] = await repository.claim({ leaseMs: 1000, now: start });
  assert.equal((await repository.claim({ now: new Date(start.getTime() + 500) })).length, 0);

  const [reclaimed] = await repository.claim({ now: new Date(start.getTime() + 1001) });
  assert.equal(reclaimed.id, abandoned.id);
  assert.notEqual(reclaimed.leaseToken, abandoned.leaseToken);
  assert.equal(reclaimed.attempts, 2);
  await repository.fail({ availableAt: new Date(start.getTime() + 1001), error: 'still broken', eventId: event.id, leaseToken: reclaimed.leaseToken, maxAttempts: 3, now: new Date(start.getTime() + 1001) });

  const results = await dispatchDomainEventOutbox({
    handlers: { 'governance.changed': async () => { throw new Error('synthetic delivery failure'); } },
    maxAttempts: 3, now: new Date(start.getTime() + 1001), repository,
  });
  assert.deepEqual(results, [{ error: 'synthetic delivery failure', eventId: event.id, status: 'dead' }]);
  const [stored] = await repository.list();
  assert.equal(stored.status, 'dead');
  assert.equal(stored.attempts, 3);
  assert.match(stored.lastError, /synthetic delivery failure/);
});

test('domain event outbox leaves a failed event replayable after handler recovery', async () => {
  const repository = createInMemoryDomainEventOutboxRepository();
  const { event } = await repository.enqueue({ eventType: 'governance.changed', idempotencyKey: 'request-3', tenantId: 'tenant-1' });
  const start = new Date(event.availableAt);
  await dispatchDomainEventOutbox({ handlers: { 'governance.changed': async () => { throw new Error('offline'); } }, now: start, repository });
  assert.equal((await repository.list())[0].status, 'pending');

  const handled = [];
  await dispatchDomainEventOutbox({
    handlers: { 'governance.changed': async (claimed) => handled.push(claimed.id) },
    now: new Date(start.getTime() + 1000), repository,
  });
  assert.deepEqual(handled, [event.id]);
  assert.equal((await repository.list())[0].status, 'processed');
});
