import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyAgentGoalSuccess } from '../src/modules/assistant/agent-goal-verifier.js';

test('agent goal verifier evaluates only configured evidence checks', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: {
      id: 'goal-1', projectId: 'project-1', tenantId: 'tenant-1',
      success: { verifier: { requiredCheckIds: ['schedule.no_cycles'], type: 'project_health.v1' } },
    },
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [], milestones: [] }; } },
    now: new Date('2026-07-11T12:00:00Z'),
    projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } },
  });

  assert.equal(result.configured, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.requiredCheckIds, ['schedule.no_cycles']);
});

test('agent goal verifier fails closed for unknown verifier checks', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: {
      id: 'goal-1', projectId: 'project-1', tenantId: 'tenant-1',
      success: { verifier: { requiredCheckIds: ['unknown.check'], type: 'project_health.v1' } },
    },
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [], milestones: [] }; } },
    projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } },
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.unknownCheckIds, ['unknown.check']);
});

test('agent goal verifier proves resource capacity and budget outcomes from ledger evidence', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: {
      id: 'goal-2', projectId: 'project-1', tenantId: 'tenant-1',
      success: { verifier: { requiredCheckIds: ['resources.no_overallocation', 'finance.actual_within_budget'], type: 'resource_finance.v1' } },
    },
    now: new Date('2026-07-11T12:00:00Z'),
    resourceFinanceRepository: { async listSnapshot() { return {
      allocations: [{ endDate: '2026-12-31', hoursPerWeek: 32, projectId: 'project-1', resourceId: 'resource-1', startDate: '2026-01-01', status: 'active' }],
      expenses: [{ amount: 5000, currency: 'USD', projectId: 'project-1', status: 'approved' }],
      financialEntries: [
        { amount: 100000, currency: 'USD', entryKind: 'budget', projectId: 'project-1', status: 'posted' },
        { amount: 75000, currency: 'USD', entryKind: 'actual_cost', projectId: 'project-1', status: 'posted' },
      ],
      resources: [{ capacityHoursPerWeek: 40, id: 'resource-1' }],
      timeEntries: [],
    }; } },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCheckIds, []);
  assert.equal(result.checks.find((check) => check.id === 'finance.actual_within_budget').evidence.actuals.USD, 80000);
});

test('agent goal verifier proves workflow approvals, SLA, and required-field outcomes', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: { projectId: 'project-1', tenantId: 'tenant-1', success: { verifier: { requiredCheckIds: ['workflow.no_pending_approvals', 'workflow.no_overdue_sla', 'workflow.required_fields_complete'], type: 'workflow.v1' } } },
    now: new Date('2026-07-11T12:00:00Z'),
    projectRepository: { async getProjectDetail() { return { description: 'Ready', epics: [], id: 'project-1', status: 'active' }; } },
    workflowRepository: { async listSnapshot() { return {
      approvals: [], bindings: [{ itemType: 'project', projectId: 'project-1', workflowId: 'workflow-1' }], customFields: [], customValues: [], histories: [],
      workflows: [{ id: 'workflow-1', states: [{ key: 'active', requiredFields: ['description'] }], status: 'active' }],
    }; } },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCheckIds, []);
});

test('agent goal verifier proves project-scoped integration delivery outcomes', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: { projectId: 'project-1', tenantId: 'tenant-1', success: { verifier: { criteria: { eventTypes: ['workflow.transitioned'] }, requiredCheckIds: ['integration.deliveries_succeeded', 'integration.no_dead_deliveries'], type: 'integration.v1' } } },
    platformRepository: { async listSnapshot() { return {
      deliveries: [
        { eventId: 'event-1', eventType: 'workflow.transitioned', id: 'delivery-1', payload: { projectId: 'project-1' }, status: 'delivered', subscriptionId: 'subscription-1' },
        { eventId: 'event-2', eventType: 'workflow.transitioned', id: 'delivery-2', payload: { projectId: 'project-2' }, status: 'dead', subscriptionId: 'subscription-1' },
      ],
      subscriptions: [{ enabled: true, id: 'subscription-1', lastDeliveredAt: '2026-07-11T12:00:00.000Z', lastFailureAt: null }],
    }; } },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.requiredCheckIds, ['integration.deliveries_succeeded', 'integration.no_dead_deliveries']);
});

test('agent goal verifier fails closed for unscoped tenant-wide integration checks', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: { projectId: null, tenantId: 'tenant-1', success: { verifier: { requiredCheckIds: [], type: 'integration.v1' } } },
    platformRepository: { async listSnapshot() { return { deliveries: [], subscriptions: [] }; } },
  });
  assert.equal(result.passed, false);
  assert.match(result.error, /project or explicit delivery scope/);
});

test('agent goal verifier proves communication outcomes only from goal-owned attention and delivery records', async () => {
  const result = await verifyAgentGoalSuccess({
    executionRepository: { async listNotifications() { return [
      { goalId: 'goal-1', id: 'notification-1', projectId: 'project-1', status: 'read', tenantId: 'tenant-1' },
    ]; } },
    goal: { id: 'goal-1', projectId: 'project-1', tenantId: 'tenant-1', success: { verifier: { criteria: { notificationIds: ['notification-1'], requireEmail: true }, requiredCheckIds: ['communication.no_unread_attention', 'communication.email_delivery_complete'], type: 'communication.v1' } } },
    mailRepository: { async listEmailsByTargetIds({ targetIds }) { assert.deepEqual(targetIds, ['notification-1']); return [
      { id: 'mail-1', status: 'sent', targetId: 'notification-1', templateId: 'goal-attention' },
    ]; } },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.requiredCheckIds, ['communication.no_unread_attention', 'communication.email_delivery_complete']);
});

test('agent goal communication verifier fails closed when scoped storage is unavailable', async () => {
  const result = await verifyAgentGoalSuccess({ goal: { id: 'goal-1', tenantId: 'tenant-1', success: { verifier: { requiredCheckIds: [], type: 'communication.v1' } } } });
  assert.equal(result.passed, false);
  assert.match(result.error, /notification and delivery storage/);
});

test('agent goal verifier composes cross-domain all, any, and not predicates', async () => {
  const result = await verifyAgentGoalSuccess({
    goal: { projectId: 'project-1', tenantId: 'tenant-1', success: { plan: { version: 'verifier-plan.v1', root: { all: [
      { checkId: 'schedule.no_cycles', criteria: {}, id: 'schedule-safe', type: 'project_health.v1' },
      { any: [
        { checkId: 'integration.deliveries_succeeded', criteria: {}, id: 'delivery-complete', type: 'integration.v1' },
        { not: { checkId: 'integration.no_pending_deliveries', criteria: {}, id: 'delivery-not-pending', type: 'integration.v1' } },
      ] },
    ] } } } },
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [], milestones: [] }; } },
    platformRepository: { async listSnapshot() { return { deliveries: [{ eventId: 'event-1', id: 'delivery-1', payload: { projectId: 'project-1' }, status: 'delivered', subscriptionId: 'subscription-1' }], subscriptions: [{ enabled: true, id: 'subscription-1', lastDeliveredAt: '2026-07-11T12:00:00.000Z', lastFailureAt: null }] }; } },
    projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } },
  });
  assert.equal(result.passed, true);
  assert.equal(result.planVersion, 'verifier-plan.v1');
  assert.equal(result.predicateResults.length, 3);
});

test('agent goal verifier bounds composable plan depth and fails closed', async () => {
  let root = { checkId: 'schedule.no_cycles', criteria: {}, id: 'schedule-safe', type: 'project_health.v1' };
  for (let index = 0; index < 10; index += 1) root = { not: root };
  const result = await verifyAgentGoalSuccess({ goal: { projectId: 'project-1', tenantId: 'tenant-1', success: { plan: { root, version: 'verifier-plan.v1' } } } });
  assert.equal(result.passed, false);
  assert.match(result.error, /maximum depth/);
});
