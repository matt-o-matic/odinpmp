import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL workflow repository persists versioned definitions, approvals, immutable history, baselines, templates, and custom fields', { skip: !databaseUrl, timeout: 15_000 }, async () => {
  const pool = mysql.createPool(databaseUrl); const tenantId = randomUUID();
  try {
    await applyMysqlMigrations(pool, ['0016_workflow_enterprise', '0026_workflow_automation_events', '0032_workflow_history_sequence']);
    const repository = createMysqlWorkflowRepository({ pool });
    const workflow = await repository.createWorkflow({ input: {
      description: '', itemTypes: ['project'], name: 'Delivery', status: 'active',
      states: [{ category: 'active', initial: true, key: 'active', label: 'Active', requiredFields: [], slaHours: 0, terminal: false }, { category: 'done', initial: false, key: 'done', label: 'Done', requiredFields: [], slaHours: 12, terminal: true }],
      transitions: [{ allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'], fromState: 'active', key: 'finish', requiredFields: [], toState: 'done' }],
    }, tenantId });
    const binding = await repository.createBinding({ input: { itemType: 'project', projectId: 'project-1', workflowId: workflow.id }, tenantId });
    const approval = await repository.requestApproval({ input: { expiresAt: null, fromState: 'active', itemId: 'project-1', itemType: 'project', note: '', projectId: 'project-1', toState: 'done', transitionKey: 'finish' }, requestedBy: 'manager', tenantId });
    const approved = await repository.decideApproval({ approvalId: approval.id, decidedBy: 'admin', input: { decisionNote: 'Approved', expectedVersion: 1, status: 'approved' }, tenantId });
    assert.equal(approved.version, 2);
    const history = await repository.recordTransition({ approvalId: approval.id, fromState: 'active', itemId: 'project-1', itemType: 'project', projectId: 'project-1', slaDueAt: '2026-07-12T00:00:00.000Z', tenantId, toState: 'done', transitionKey: 'finish', userId: 'manager' });
    const replaced = await repository.recordTransition({ fromState: 'active', itemId: 'task-replaced', itemType: 'task', projectId: 'project-1', slaDueAt: '2026-07-12T00:00:00.000Z', tenantId, toState: 'review', transitionKey: 'review', userId: 'manager' });
    const replacement = await repository.recordTransition({ fromState: 'review', itemId: 'task-replaced', itemType: 'task', projectId: 'project-1', slaDueAt: null, tenantId, toState: 'done', transitionKey: 'finish', userId: 'manager' });
    assert.equal(replacement.sequenceId > replaced.sequenceId, true);
    const automationEvents = await repository.listPendingAutomationEvents({ now: new Date('2026-07-13T00:00:00.000Z') });
    assert.deepEqual(automationEvents.filter((candidate) => candidate.history.id === history.id).map((candidate) => candidate.eventType).sort(), ['workflow.sla.overdue', 'workflow.transitioned']);
    assert.deepEqual(automationEvents.filter((candidate) => candidate.history.id === replaced.id).map((candidate) => candidate.eventType), ['workflow.transitioned']);
    await repository.markAutomationEventEnqueued({ enqueuedAt: new Date('2026-07-13T00:00:00.000Z'), eventType: 'workflow.transitioned', historyId: history.id });
    assert.deepEqual((await repository.listPendingAutomationEvents({ now: new Date('2026-07-13T00:00:00.000Z') })).filter((candidate) => candidate.history.id === history.id).map((candidate) => candidate.eventType), ['workflow.sla.overdue']);
    await repository.createBaseline({ createdBy: 'manager', input: { name: 'Approved plan', note: '', projectId: 'project-1' }, snapshot: { id: 'project-1', status: 'done' }, tenantId });
    await repository.createTemplate({ input: { description: '', kind: 'project', name: 'Standard', payload: { status: 'active' }, status: 'active' }, tenantId });
    const field = await repository.createCustomField({ input: { description: '', fieldType: 'string', name: 'Evidence', options: [], required: true, scope: 'project', status: 'active' }, tenantId });
    const value = await repository.upsertCustomValue({ input: { expectedVersion: null, fieldId: field.id, itemId: 'project-1', itemType: 'project', projectId: 'project-1', value: 'Verified' }, tenantId });
    await assert.rejects(repository.upsertCustomValue({ input: { expectedVersion: 99, fieldId: field.id, itemId: 'project-1', itemType: 'project', projectId: 'project-1', value: 'Changed' }, tenantId }), (error) => error.statusCode === 409);
    const snapshot = await repository.listSnapshot({ tenantId });
    assert.equal(snapshot.approvals[0].status, 'consumed');
    assert.equal(snapshot.histories.length, 3);
    assert.equal(snapshot.baselines[0].snapshot.status, 'done');
    assert.equal(snapshot.customValues[0].value, 'Verified');
    assert.equal(value.version, 1);
    await assert.rejects(repository.deleteWorkflow({ expectedVersion: 1, tenantId, workflowId: workflow.id }), /bindings/i);
    assert.equal(await repository.deleteBinding({ bindingId: binding.id, expectedVersion: 1, tenantId }), true);
  } finally { await pool.end(); }
});
