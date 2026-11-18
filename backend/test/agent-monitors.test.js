import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { materializeDueGoalMonitors, materializeGoalEvent, monitorConditionMatches } from '../src/modules/assistant/agent-monitors.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryPlatformRepository } from '../src/modules/platform/platform.repository.js';

test('monitor conditions match nested event fields without executing content', () => {
  assert.equal(monitorConditionMatches({ 'change.kind': 'risk', 'change.status': ['open', 'monitoring'] }, { change: { kind: 'risk', status: 'open' } }), true);
  assert.equal(monitorConditionMatches({ 'change.kind': 'issue' }, { change: { kind: 'risk' } }), false);
});

test('scheduled goal monitors materialize idempotent assistant turns and advance their schedule', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Protect launch' });
  const monitor = await repository.createMonitor({
    goalId: goal.id,
    input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), payload: { sessionId: 'session-1' }, title: 'Check schedule', triggerType: 'schedule' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  const results = await materializeDueGoalMonitors({ executionRepository: repository, now: new Date('2030-01-01T12:00:00Z') });
  assert.equal(results[0].status, 'queued');
  const runs = await repository.listRuns({ goalId: goal.id, tenantId: 'tenant-1' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runType, 'assistant_turn');
  assert.equal(runs[0].payload.sessionId, 'session-1');
  const updated = await repository.getMonitor({ monitorId: monitor.id, tenantId: 'tenant-1' });
  assert.equal(updated.runCount, 1);
  assert.equal(updated.nextRunAt, '2030-01-01T12:15:00.000Z');
  assert.deepEqual(await materializeDueGoalMonitors({ executionRepository: repository, now: new Date('2030-01-01T12:00:01Z') }), []);
});

test('event monitors filter conditions and dedupe repeated event delivery', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Watch risks' });
  const monitor = await repository.createMonitor({
    goalId: goal.id,
    input: { condition: { 'change.impact': 'critical' }, eventType: 'governance.changed', payload: { sessionId: 'session-1' }, title: 'React to critical risk', triggerType: 'event' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  assert.deepEqual(await materializeGoalEvent({ event: { change: { impact: 'low' } }, eventId: 'event-1', eventType: 'governance.changed', executionRepository: repository, projectId: 'project-1', tenantId: 'tenant-1' }), []);
  const first = await materializeGoalEvent({ event: { change: { impact: 'critical' } }, eventId: 'event-2', eventType: 'governance.changed', executionRepository: repository, projectId: 'project-1', tenantId: 'tenant-1' });
  const duplicate = await materializeGoalEvent({ event: { change: { impact: 'critical' } }, eventId: 'event-2', eventType: 'governance.changed', executionRepository: repository, projectId: 'project-1', tenantId: 'tenant-1' });
  assert.equal(first[0].created, true);
  assert.equal(duplicate[0].created, false);
  assert.equal((await repository.listRuns({ goalId: goal.id, tenantId: 'tenant-1' })).length, 1);
  assert.equal((await repository.getMonitor({ monitorId: monitor.id, tenantId: 'tenant-1' })).runCount, 1);
});

test('workflow SLA events trigger condition-scoped autonomous goal runs', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Recover overdue approvals' });
  await repository.createMonitor({
    goalId: goal.id,
    input: { condition: { itemType: 'task', toState: 'review' }, eventType: 'workflow.sla.overdue', payload: { sessionId: 'session-workflow' }, title: 'Escalate overdue review', triggerType: 'event' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  const results = await materializeGoalEvent({
    event: { itemId: 'task-1', itemType: 'task', toState: 'review' }, eventId: 'sla-event-1', eventType: 'workflow.sla.overdue',
    executionRepository: repository, projectId: 'project-1', tenantId: 'tenant-1',
  });
  assert.equal(results[0].created, true);
  const [run] = await repository.listRuns({ goalId: goal.id, tenantId: 'tenant-1' });
  assert.equal(run.payload.sessionId, 'session-workflow');
  assert.equal(run.payload.trigger.eventType, 'workflow.sla.overdue');
});

test('scheduled monitor completes a goal from verifier evidence without starting another run', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Keep schedule valid',
    success: { measure: 'The dependency graph remains acyclic.', verifier: { requiredCheckIds: ['schedule.no_cycles'], type: 'project_health.v1' } },
  });
  const monitor = await repository.createMonitor({
    goalId: goal.id,
    input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), payload: { sessionId: 'session-1' }, title: 'Verify schedule', triggerType: 'schedule' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });

  const results = await materializeDueGoalMonitors({
    executionRepository: repository,
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [], milestones: [] }; } },
    now: new Date('2030-01-01T12:00:00Z'),
    projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } },
  });

  assert.equal(results[0].status, 'goal_completed');
  assert.equal((await repository.listRuns({ goalId: goal.id, tenantId: 'tenant-1' })).length, 0);
  const completedGoal = await repository.getGoal({ goalId: goal.id, tenantId: 'tenant-1' });
  assert.equal(completedGoal.status, 'completed');
  assert.equal(completedGoal.success.lastVerification.passed, true);
  assert.equal((await repository.getMonitor({ monitorId: monitor.id, tenantId: 'tenant-1' })).enabled, false);
});

test('scheduled monitor completes a resource-finance goal from capacity and budget evidence', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Keep delivery within capacity and budget',
    success: { verifier: { requiredCheckIds: ['resources.no_overallocation', 'finance.forecast_within_budget'], type: 'resource_finance.v1' } },
  });
  await repository.createMonitor({
    goalId: goal.id,
    input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), payload: { sessionId: 'session-resource' }, title: 'Verify capacity and forecast', triggerType: 'schedule' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  const results = await materializeDueGoalMonitors({
    executionRepository: repository,
    now: new Date('2030-01-01T12:00:00Z'),
    resourceFinanceRepository: { async listSnapshot() { return {
      allocations: [{ endDate: '2030-12-31', hoursPerWeek: 30, projectId: 'project-1', resourceId: 'resource-1', startDate: '2030-01-01', status: 'active' }],
      expenses: [], financialEntries: [
        { amount: 100000, currency: 'USD', entryKind: 'budget', projectId: 'project-1', status: 'posted' },
        { amount: 90000, currency: 'USD', entryKind: 'forecast', projectId: 'project-1', status: 'approved' },
      ], resources: [{ capacityHoursPerWeek: 40, id: 'resource-1' }], timeEntries: [],
    }; } },
  });
  assert.equal(results[0].status, 'goal_completed');
  assert.equal((await repository.getGoal({ goalId: goal.id, tenantId: 'tenant-1' })).status, 'completed');
});

test('scheduled monitor completes a workflow goal from approval, SLA, and required-field evidence', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Keep workflow controlled', success: { verifier: { requiredCheckIds: ['workflow.no_pending_approvals', 'workflow.no_overdue_sla'], type: 'workflow.v1' } } });
  await repository.createMonitor({ goalId: goal.id, input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), payload: { sessionId: 'session-workflow' }, title: 'Verify workflow', triggerType: 'schedule' }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1' });
  const results = await materializeDueGoalMonitors({
    executionRepository: repository, now: new Date('2030-01-01T12:00:00Z'),
    projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1', status: 'active' }; } },
    workflowRepository: { async listSnapshot() { return { approvals: [], bindings: [], customFields: [], customValues: [], histories: [], workflows: [] }; } },
  });
  assert.equal(results[0].status, 'goal_completed');
  assert.equal((await repository.getGoal({ goalId: goal.id, tenantId: 'tenant-1' })).status, 'completed');
});

test('scheduled monitor completes an integration goal only from delivered project evidence', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Prove delivery', success: { plan: { root: { all: [{ checkId: 'integration.deliveries_succeeded', criteria: {}, id: 'delivered', type: 'integration.v1' }, { checkId: 'integration.no_dead_deliveries', criteria: {}, id: 'not-dead', type: 'integration.v1' }] }, version: 'verifier-plan.v1' } } });
  await repository.createMonitor({ goalId: goal.id, input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), payload: { sessionId: 'session-integration' }, title: 'Verify delivery', triggerType: 'schedule' }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1' });
  const results = await materializeDueGoalMonitors({
    executionRepository: repository, now: new Date('2030-01-01T12:00:00Z'),
    platformRepository: { async listSnapshot() { return { deliveries: [{ eventId: 'event-1', id: 'delivery-1', payload: { projectId: 'project-1' }, status: 'delivered', subscriptionId: 'subscription-1' }], subscriptions: [{ enabled: true, id: 'subscription-1', lastDeliveredAt: '2030-01-01T11:59:00.000Z', lastFailureAt: null }] }; } },
  });
  assert.equal(results[0].status, 'goal_completed');
  assert.equal((await repository.getGoal({ goalId: goal.id, tenantId: 'tenant-1' })).status, 'completed');
});

test('scheduled monitor completes a communication goal from acknowledged attention and sent email evidence', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const mailRepository = createInMemoryMailRepository();
  let goal = await repository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Confirm escalation delivery' });
  const created = await repository.createNotification({
    dedupeKey: 'communication-proof', evidence: {}, goalId: goal.id, kind: 'delivery_confirmation', message: 'Confirm delivery.',
    ownerUserId: 'user-1', projectId: 'project-1', severity: 'warning', tenantId: 'tenant-1', title: 'Delivery confirmation',
  });
  const notification = await repository.updateNotification({ expectedVersion: created.notification.version, notificationId: created.notification.id, patch: { status: 'read' }, tenantId: 'tenant-1' });
  await mailRepository.queueMail({ body: 'Delivery confirmation.', recipientEmail: 'owner@example.com', subject: 'Delivery confirmation', targetId: notification.id, templateId: 'goal-attention' });
  const [mail] = await mailRepository.listEmailsByTargetIds({ targetIds: [notification.id] });
  await mailRepository.markSent({ id: mail.id });
  goal = await repository.updateGoal({ expectedVersion: goal.version, goalId: goal.id, patch: { success: { verifier: { criteria: { notificationIds: [notification.id], requireEmail: true }, requiredCheckIds: ['communication.no_unread_attention', 'communication.email_delivery_complete'], type: 'communication.v1' } } }, tenantId: 'tenant-1' });
  await repository.createMonitor({ goalId: goal.id, input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), title: 'Verify communication', triggerType: 'schedule' }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1' });
  const results = await materializeDueGoalMonitors({ executionRepository: repository, mailRepository, now: new Date('2030-01-01T12:00:00Z') });
  assert.equal(results[0].status, 'goal_completed');
  assert.equal((await repository.getGoal({ goalId: goal.id, tenantId: 'tenant-1' })).status, 'completed');
  assert.equal(results[0].verification.checks.some((entry) => entry.id === 'communication.email_delivery_complete' && entry.passed), true);
});

test('failed verifier checks create one durable attention record and still queue monitor work', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const mailRepository = createInMemoryMailRepository();
  const goal = await repository.createGoal({
    constraints: { escalation: { afterRuns: 1, email: true } }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Protect launch',
    success: { verifier: { requiredCheckIds: ['governance.no_open_critical_risks'], type: 'project_health.v1' } },
  });
  await repository.createMonitor({
    goalId: goal.id,
    input: { condition: {}, eventType: 'governance.changed', payload: { sessionId: 'session-1' }, title: 'Check critical risks', triggerType: 'event' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  const options = {
    authRepository: { async findUserById() { return { email: 'owner@example.com', id: 'user-1' }; } },
    event: { change: { id: 'risk-1' } }, eventId: 'event-risk-1', eventType: 'governance.changed', executionRepository: repository,
    frontendAppUrl: 'https://odin.example/app',
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [{ id: 'risk-1', impact: 'critical', kind: 'risk', status: 'open', title: 'Launch blocker' }], milestones: [] }; } },
    mailRepository, projectId: 'project-1', projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } }, tenantId: 'tenant-1',
  };
  const first = await materializeGoalEvent(options);
  await materializeGoalEvent({ ...options, eventId: 'event-risk-2' });

  assert.equal(first[0].status, 'queued');
  const notifications = await repository.listNotifications({ goalId: goal.id, tenantId: 'tenant-1' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'verifier_failed');
  assert.equal(notifications[0].severity, 'critical');
  assert.deepEqual(notifications[0].evidence.failedCheckIds, ['governance.no_open_critical_risks']);
  assert.equal(mailRepository.state.queue.length, 1);
  assert.equal(mailRepository.state.queue[0].recipientEmail, 'owner@example.com');
  assert.match(mailRepository.state.queue[0].body, /https:\/\/odin\.example\/app\/projects\/project-1\?tab=governance/);
});

test('goal escalation channel policy routes one idempotent attention webhook without exposing recipient data', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const platformRepository = createInMemoryPlatformRepository();
  await platformRepository.createWebhookSubscription({ createdBy: 'admin-1', input: { description: 'Goal attention receiver', eventTypes: ['agent.goal.attention'], name: 'Goal attention', url: 'https://hooks.example.com/goals' }, tenantId: 'tenant-1' });
  const goal = await repository.createGoal({
    constraints: { escalation: { afterRuns: 1, channels: ['in_app', 'webhook'] } }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Protect launch',
    success: { verifier: { requiredCheckIds: ['governance.no_open_critical_risks'], type: 'project_health.v1' } },
  });
  await repository.createMonitor({ goalId: goal.id, input: { condition: {}, eventType: 'governance.changed', payload: { sessionId: 'session-1' }, title: 'Check risks', triggerType: 'event' }, ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1' });
  const options = {
    event: { change: { id: 'risk-1' } }, eventId: 'risk-event-1', eventType: 'governance.changed', executionRepository: repository,
    governanceRepository: { async listSnapshot() { return { dependencies: [], items: [{ id: 'risk-1', impact: 'critical', kind: 'risk', status: 'open' }], milestones: [] }; } },
    platformRepository, projectId: 'project-1', projectRepository: { async getProjectDetail() { return { epics: [], id: 'project-1' }; } }, tenantId: 'tenant-1',
  };
  await materializeGoalEvent(options);
  await materializeGoalEvent({ ...options, eventId: 'risk-event-2' });
  const snapshot = await platformRepository.listSnapshot({ tenantId: 'tenant-1' });
  assert.equal(snapshot.deliveries.length, 1);
  assert.equal(snapshot.deliveries[0].eventType, 'agent.goal.attention');
  assert.equal(snapshot.deliveries[0].payload.projectId, 'project-1');
  assert.equal(JSON.stringify(snapshot.deliveries[0].payload).includes('recipient'), false);
});
