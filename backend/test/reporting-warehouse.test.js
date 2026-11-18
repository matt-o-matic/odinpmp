import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryReportingRepository } from '../src/modules/reporting/reporting.repository.js';

test('reporting warehouse captures events idempotently, materializes facts, and invalidates sequence-aware cache', async () => {
  const repository = createInMemoryReportingRepository();
  const event = { createdAt: '2026-07-11T12:00:00.000Z', eventType: 'workflow.transitioned', id: 'event-1', payload: { transitionKey: 'complete' }, projectId: 'project-1', tenantId: 'tenant-1' };
  assert.deepEqual(await repository.captureWarehouseChange({ event }), { created: true, sequenceId: 1 });
  assert.deepEqual(await repository.captureWarehouseChange({ event }), { created: false, sequenceId: 1 });
  assert.deepEqual(await repository.materializeWarehouseChanges(), { lastSequenceId: 1, processed: 1 });
  assert.deepEqual(await repository.materializeWarehouseChanges(), { lastSequenceId: null, processed: 0 });
  const facts = await repository.getReportingAnalytics({ projectIds: ['project-1'], tenantId: 'tenant-1' });
  assert.equal(facts.length, 1); assert.equal(facts[0].occurrenceCount, 1); assert.equal(facts[0].eventType, 'workflow.transitioned');
  await repository.writeReportingCache({ cacheKey: 'visible-scope', sourceSequenceId: 1, tenantId: 'tenant-1', value: { total: 1 } });
  assert.deepEqual(await repository.readReportingCache({ cacheKey: 'visible-scope', sourceSequenceId: 1, tenantId: 'tenant-1' }), { total: 1 });
  await repository.captureWarehouseChange({ event: { ...event, id: 'event-2' } });
  assert.equal(await repository.readReportingCache({ cacheKey: 'visible-scope', sourceSequenceId: 2, tenantId: 'tenant-1' }), null);
});

test('report subscription claims are exclusive, fenced, reclaimable, and completed by lease owner only', async () => {
  const repository = createInMemoryReportingRepository();
  const subscription = await repository.createSubscription({ input: { deliveryChannel: 'in_app', enabled: true, format: 'json', nextRunAt: new Date('2026-07-11T12:00:00.000Z'), recipients: [], reportId: 'report-1', schedule: { intervalMinutes: 60, timezone: 'UTC' } }, ownerUserId: 'user-1', tenantId: 'tenant-1' });
  const first = await repository.claimDueSubscriptions({ leaseMs: 1000, now: new Date('2026-07-11T12:00:00.000Z') });
  assert.equal(first.length, 1); assert.equal(first[0].fencingToken, 1);
  assert.deepEqual(await repository.claimDueSubscriptions({ leaseMs: 1000, now: new Date('2026-07-11T12:00:00.500Z') }), []);
  const reclaimed = await repository.claimDueSubscriptions({ leaseMs: 1000, now: new Date('2026-07-11T12:00:02.000Z') });
  assert.equal(reclaimed[0].fencingToken, 2);
  assert.equal(await repository.completeSubscriptionClaim({ expectedVersion: subscription.version, lastRunAt: new Date(), leaseToken: first[0].leaseToken, nextRunAt: new Date('2026-07-12T12:00:00.000Z'), subscriptionId: subscription.id, tenantId: 'tenant-1' }), false);
  assert.equal(await repository.completeSubscriptionClaim({ expectedVersion: subscription.version, lastRunAt: new Date('2026-07-11T12:00:02.000Z'), leaseToken: reclaimed[0].leaseToken, nextRunAt: new Date('2026-07-12T12:00:00.000Z'), subscriptionId: subscription.id, tenantId: 'tenant-1' }), true);
  const snapshot = await repository.listSnapshot({ tenantId: 'tenant-1' }); assert.equal(snapshot.subscriptions[0].version, 2);
});

test('global search ranks semantically related indexed documents without lexical overlap', async () => {
  const repository = createInMemoryReportingRepository();
  await repository.syncDocuments({ documents: [
    { content: 'Supplier staffing threatens the launch date.', documentType: 'risk', embedding: { vector: [1, 0] }, facets: {}, projectId: 'project-1', sourceHash: 'a', sourceId: 'risk-1', title: 'Capacity exposure', updatedAt: '2026-07-11T00:00:00.000Z', url: '/risk-1' },
    { content: 'Routine status update.', documentType: 'project', embedding: { vector: [0, 1] }, facets: {}, projectId: 'project-1', sourceHash: 'b', sourceId: 'project-1', title: 'Status', updatedAt: '2026-07-11T00:00:00.000Z', url: '/project-1' },
  ], tenantId: 'tenant-1' });
  const result = await repository.searchDocuments({ limit: 10, offset: 0, projectIds: ['project-1'], query: 'vendor bottleneck', queryEmbedding: { vector: [0.99, 0.01] }, tenantId: 'tenant-1', types: [] });
  assert.equal(result.records[0].title, 'Capacity exposure'); assert.equal(result.records[0].retrievalMode, 'semantic'); assert.ok(result.records[0].semanticScore > 0.9); assert.equal(result.records[0].embedding, undefined);
});
