import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureOnce } from '../src/lib/database/ensure-once.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

test('a seeding helper runs once per key, and again after a failed run', async () => {
  const pool = {};
  const otherPool = {};
  let calls = 0;
  let fail = true;
  const ensure = async (executor) => {
    calls += 1;
    assert.ok(executor === pool || executor === otherPool || executor.connection);
    if (fail) throw new Error('database unavailable');
  };

  await assert.rejects(ensureOnce(pool, ensure), /database unavailable/);
  fail = false;
  // The failure is forgotten, so the next call runs the helper again.
  await Promise.all([ensureOnce(pool, ensure), ensureOnce(pool, ensure, { connection: true })]);
  await ensureOnce(pool, ensure);
  assert.equal(calls, 2, 'concurrent and later calls share the successful run');
  await ensureOnce(otherPool, ensure);
  assert.equal(calls, 3, 'another pool runs its own check');
});

test('Home reads pending approvals, bindings and only the latest overdue transitions of its projects', async () => {
  const repository = createInMemoryWorkflowRepository();
  const tenantId = 'tenant-1';
  const workflow = await repository.createWorkflow({ input: { description: '', itemTypes: ['story'], name: 'Story flow', states: [], status: 'active', transitions: [] }, tenantId });
  await repository.createBinding({ input: { itemType: 'story', projectId: 'project-1', workflowId: workflow.id }, tenantId });
  await repository.createBinding({ input: { itemType: 'story', projectId: 'project-other', workflowId: workflow.id }, tenantId });
  const record = (projectId, itemId, slaDueAt, toState = 'Review') => repository.recordTransition({ fromState: 'In Progress', itemId, itemType: 'story', projectId, slaDueAt, tenantId, toState, transitionKey: 'review', userId: 'user-1' });
  await record('project-1', 'item-moved-on', '2026-10-01T00:00:00.000Z');
  await record('project-1', 'item-moved-on', null, 'Done');
  await record('project-1', 'item-late', '2026-10-02T00:00:00.000Z');
  await record('project-1', 'item-not-due', '2026-12-01T00:00:00.000Z');
  await record('project-other', 'item-elsewhere', '2026-10-01T00:00:00.000Z');
  await repository.requestApproval({ input: { expiresAt: null, fromState: 'Review', itemId: 'item-late', itemType: 'story', note: '', projectId: 'project-1', toState: 'Done', transitionKey: 'ship' }, requestedBy: 'user-2', tenantId });

  const state = await repository.listProjectWorkflowState({ now: new Date('2026-10-12T15:00:00.000Z'), projectIds: ['project-1'], tenantId });
  assert.deepEqual(state.histories.map((history) => history.itemId), ['item-late']);
  assert.deepEqual(state.bindings.map((binding) => binding.projectId), ['project-1']);
  assert.deepEqual(state.workflows.map((entry) => entry.id), [workflow.id]);
  assert.deepEqual(state.approvals.map((approval) => [approval.itemId, approval.status]), [['item-late', 'pending']]);
});
