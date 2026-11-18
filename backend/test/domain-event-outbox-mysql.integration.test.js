import assert from 'node:assert/strict';
import test from 'node:test';

import mysql from 'mysql2/promise';

import {
  createMysqlDomainEventOutboxRepository,
  dispatchDomainEventOutbox,
  ensureMysqlDomainEventOutboxSchema,
} from '../src/lib/events/domain-event-outbox.js';
import { createMysqlGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { mutateGovernanceForUser } from '../src/modules/governance/governance.service.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL domain event outbox persists dedupe, lease recovery, retry, and completion', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await ensureMysqlDomainEventOutboxSchema(pool);
    await pool.execute('DELETE FROM domain_event_outbox');
    const repository = createMysqlDomainEventOutboxRepository({ pool });
    const input = { eventType: 'governance.changed', idempotencyKey: 'mysql-request-1', payload: { entityId: 'risk-1' }, projectId: 'project-1', tenantId: 'tenant-1' };
    const first = await repository.enqueue(input);
    const duplicate = await repository.enqueue(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.event.id, first.event.id);

    const now = new Date(Date.now() + 1000);
    const [abandoned] = await repository.claim({ leaseMs: 10, now });
    assert.equal(abandoned.attempts, 1);
    const [reclaimed] = await repository.claim({ now: new Date(now.getTime() + 11) });
    assert.equal(reclaimed.id, first.event.id);
    assert.equal(reclaimed.attempts, 2);
    await repository.fail({ availableAt: new Date(now.getTime() + 11), error: 'temporary', eventId: reclaimed.id, leaseToken: reclaimed.leaseToken, now: new Date(now.getTime() + 11) });

    const handled = [];
    await dispatchDomainEventOutbox({ handlers: { 'governance.changed': async (event) => handled.push(event.payload.entityId) }, now: new Date(now.getTime() + 11), repository });
    assert.deepEqual(handled, ['risk-1']);
    const [stored] = await repository.list();
    assert.equal(stored.status, 'processed');
    assert.equal(stored.attempts, 3);
  } finally { await pool.end(); }
});

test('MySQL governance mutation and domain event enqueue commit or roll back atomically', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await applyMysqlMigrations(pool, ['0008_governance', '0012_domain_event_outbox', '0025_schedule_controls']);
    const governanceRepository = createMysqlGovernanceRepository({ pool });
    const outboxRepository = createMysqlDomainEventOutboxRepository({ pool });
    const projectRepository = { async getProjectAccess() { return { exists: true, projectRole: 'editor' }; } };
    const user = { id: 'editor-1', memberships: [{ role: 'user', tenantId: 'tenant-1' }] };
    const input = {
      description: '', dueDate: null, impact: 'high', kind: 'risk', ownerId: null,
      probability: 'high', responsePlan: '', status: 'open', title: 'Atomic vendor risk',
    };
    const mutation = (repository, args) => repository.createItem(args);
    const domainEvent = { eventType: 'governance.changed', idempotencyKey: 'atomic-request-1', payload: { action: 'created', entityType: 'governance_item' } };

    await assert.rejects(
      mutateGovernanceForUser({
        domainEvent,
        domainEventOutboxRepository: { withExecutor: () => ({ async enqueue() { throw new Error('synthetic outbox failure'); } }) },
        governanceRepository, operation: mutation, payload: { input }, projectId: 'project-atomic', projectRepository, user,
      }),
      /synthetic outbox failure/,
    );
    assert.equal((await governanceRepository.listSnapshot({ projectId: 'project-atomic', tenantId: 'tenant-1' })).items.length, 0);

    await mutateGovernanceForUser({
      domainEvent: { ...domainEvent, idempotencyKey: 'atomic-request-2' }, domainEventOutboxRepository: outboxRepository,
      governanceRepository, operation: mutation, payload: { input }, projectId: 'project-atomic', projectRepository, user,
    });
    assert.equal((await governanceRepository.listSnapshot({ projectId: 'project-atomic', tenantId: 'tenant-1' })).items.length, 1);
    const matchingEvents = (await outboxRepository.list()).filter((event) => event.idempotencyKey === 'atomic-request-2');
    assert.equal(matchingEvents.length, 1);
    assert.equal(matchingEvents[0].payload.change.title, 'Atomic vendor risk');
  } finally { await pool.end(); }
});
