import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { processConnectorInboundBatch } from '../src/modules/connectors/connector-inbound-worker.js';
import { createInMemoryConnectorRepository } from '../src/modules/connectors/connector.repository.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const tenantId = 'tenant-worker';

async function fixture({ projectIds = ['project-1'], provider = 'jira' } = {}) {
  const repository = createInMemoryConnectorRepository();
  const connection = await repository.createConnection({ inboundSecretHash: hash('secret'), input: { authType: 'webhook', conflictPolicy: 'manual', name: 'Worker fixture', projectIds, provider, scopes: [], secretReference: 'vault://fixture', settings: {}, status: 'active', syncDirection: 'inbound' }, tenantId, userId: 'admin' });
  return { connection, repository };
}

test('connector worker leases one normalized event, projects it, and fences duplicate workers', async () => {
  const { connection, repository } = await fixture({ projectIds: ['project-1', 'project-2'] });
  await repository.createMapping({ input: { connectionId: connection.id, externalId: 'external-project', objectType: 'project', odinId: 'project-2', projectId: 'project-2' }, tenantId });
  await repository.recordInboundEvent({ connection: { ...connection, tenantId }, eventId: 'event-1', eventType: 'issue.updated', payload: { externalId: 'issue-1', fields: { projectExternalId: 'external-project', title: 'Capacity risk' }, kind: 'work_item', schemaVersion: 'odin.connector-object.v1' }, payloadHash: hash('payload-1') });
  const [first, second] = await Promise.all([repository.claimInboundEvents({ now: new Date('2030-01-01'), workerId: 'worker-a' }), repository.claimInboundEvents({ now: new Date('2030-01-01'), workerId: 'worker-b' })]);
  assert.equal(first.length + second.length, 1);
  const [{ event }] = first.length ? first : second; const owner = first.length ? 'worker-a' : 'worker-b';
  assert.equal(await repository.completeClaimedInboundEvent({ eventId: event.id, leaseToken: event.leaseToken, now: new Date('2030-01-01'), workerId: owner === 'worker-a' ? 'worker-b' : 'worker-a' }), false);
  await repository.failClaimedInboundEvent({ availableAt: new Date('2030-01-01'), error: 'retry fixture', eventId: event.id, leaseToken: event.leaseToken, now: new Date('2030-01-01'), workerId: owner });
  const result = await processConnectorInboundBatch({ now: new Date('2030-01-01T00:00:01Z'), repository, workerId: 'worker-c' });
  assert.equal(result[0].status, 'processed');
  const [object] = await repository.listConnectorObjects({ tenantId }); assert.equal(object.externalId, 'issue-1'); assert.equal(object.projectId, 'project-2');
  assert.equal((await repository.listSnapshot({ tenantId })).events[0].status, 'processed');
});

test('connector worker leaves ERP journals for explicit approval and dead-letters repeated projection failures', async () => {
  const erp = await fixture({ provider: 'netsuite' });
  await erp.repository.recordInboundEvent({ connection: { ...erp.connection, tenantId }, eventId: 'journal-1', eventType: 'journal.created', payload: { externalId: 'journal-1', fields: {}, kind: 'journal_entry', schemaVersion: 'odin.connector-object.v1' }, payloadHash: hash('journal') });
  assert.deepEqual(await processConnectorInboundBatch({ repository: erp.repository, workerId: 'worker-erp' }), []);
  assert.equal((await erp.repository.listSnapshot({ tenantId })).events[0].status, 'pending');

  const normal = await fixture();
  await normal.repository.recordInboundEvent({ connection: { ...normal.connection, tenantId }, eventId: 'event-bad', eventType: 'issue.updated', payload: { externalId: 'issue-bad', fields: {}, kind: 'work_item', schemaVersion: 'odin.connector-object.v1' }, payloadHash: hash('bad') });
  normal.repository.upsertConnectorObject = async () => { throw new Error('projection unavailable'); };
  const first = await processConnectorInboundBatch({ maxAttempts: 2, now: new Date('2030-01-01'), repository: normal.repository, workerId: 'worker-fail' });
  const second = await processConnectorInboundBatch({ maxAttempts: 2, now: new Date('2030-01-01T00:00:02Z'), repository: normal.repository, workerId: 'worker-fail' });
  assert.equal(first[0].status, 'retry'); assert.equal(second[0].status, 'dead');
  const snapshot = await normal.repository.listSnapshot({ tenantId }); assert.equal(snapshot.events[0].status, 'dead'); assert.equal(snapshot.connections[0].lastFailureAt, '2030-01-01T00:00:02.000Z');
});
