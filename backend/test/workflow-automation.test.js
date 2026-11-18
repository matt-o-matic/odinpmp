import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { createInMemoryDomainEventOutboxRepository } from '../src/lib/events/domain-event-outbox.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { materializeWorkflowAutomationEvents } from '../src/modules/workflows/workflow-automation.js';

test('workflow automation emits each transition and only the current overdue SLA exactly once', async () => {
  const workflowRepository = createInMemoryWorkflowRepository();
  const domainEventOutboxRepository = createInMemoryDomainEventOutboxRepository();
  const common = { approvalId: null, fromState: 'active', itemType: 'task', projectId: 'project-1', tenantId: 'tenant-1', transitionKey: 'advance', userId: 'user-1' };
  await workflowRepository.recordTransition({ ...common, itemId: 'task-replaced', slaDueAt: '2026-07-10T10:00:00.000Z', toState: 'review' });
  await workflowRepository.recordTransition({ ...common, fromState: 'review', itemId: 'task-replaced', slaDueAt: null, toState: 'done' });
  const overdue = await workflowRepository.recordTransition({ ...common, itemId: 'task-overdue', slaDueAt: '2026-07-10T11:00:00.000Z', toState: 'review' });

  const first = await materializeWorkflowAutomationEvents({
    domainEventOutboxRepository,
    now: new Date('2026-07-11T12:00:00.000Z'),
    workflowRepository,
  });
  const second = await materializeWorkflowAutomationEvents({
    domainEventOutboxRepository,
    now: new Date('2026-07-11T12:05:00.000Z'),
    workflowRepository,
  });

  assert.equal(first.filter((event) => event.eventType === 'workflow.transitioned').length, 3);
  assert.deepEqual(first.filter((event) => event.eventType === 'workflow.sla.overdue').map((event) => event.historyId), [overdue.id]);
  assert.deepEqual(second, []);
  const events = await domainEventOutboxRepository.list();
  assert.equal(events.length, 4);
  const slaEvent = events.find((event) => event.eventType === 'workflow.sla.overdue');
  assert.equal(slaEvent.payload.itemId, 'task-overdue');
  assert.equal(slaEvent.payload.overdueByMinutes, 1500);
});

test('workflow automation leaves a failed outbox enqueue eligible for a later sweep', async () => {
  const workflowRepository = createInMemoryWorkflowRepository();
  await workflowRepository.recordTransition({
    approvalId: null, fromState: 'active', itemId: 'task-1', itemType: 'task', projectId: 'project-1',
    slaDueAt: null, tenantId: 'tenant-1', toState: 'done', transitionKey: 'finish', userId: 'user-1',
  });
  await assert.rejects(materializeWorkflowAutomationEvents({
    domainEventOutboxRepository: { async enqueue() { throw new Error('outbox unavailable'); } },
    workflowRepository,
  }), /outbox unavailable/);
  const recovered = await materializeWorkflowAutomationEvents({
    domainEventOutboxRepository: createInMemoryDomainEventOutboxRepository(),
    workflowRepository,
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].eventType, 'workflow.transitioned');
});

test('app workflow automation dispatches an overdue SLA into a configured durable goal monitor', async (t) => {
  const workflowRepository = createInMemoryWorkflowRepository();
  const domainEventOutboxRepository = createInMemoryDomainEventOutboxRepository();
  const agentExecutionRepository = createInMemoryAgentExecutionRepository();
  const goal = await agentExecutionRepository.createGoal({ ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1', title: 'Recover SLA breach' });
  await agentExecutionRepository.createMonitor({
    goalId: goal.id,
    input: { condition: { itemType: 'task' }, eventType: 'workflow.sla.overdue', payload: { sessionId: 'session-1' }, title: 'Workflow SLA action', triggerType: 'event' },
    ownerUserId: 'user-1', projectId: 'project-1', tenantId: 'tenant-1',
  });
  await workflowRepository.recordTransition({
    approvalId: null, fromState: 'active', itemId: 'task-1', itemType: 'task', projectId: 'project-1',
    slaDueAt: '2026-07-10T11:00:00.000Z', tenantId: 'tenant-1', toState: 'review', transitionKey: 'review', userId: 'user-1',
  });
  const app = createApp({
    agentExecutionRepository, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0,
    domainEventOutboxRepository, domainEventSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0, workflowRepository,
  });
  t.after(() => app.locals.beginDrain({ timeoutMs: 1000 }));
  await app.locals.materializeWorkflowAutomationEvents({ now: new Date('2026-07-11T12:00:00.000Z') });
  const queuedEvents = await domainEventOutboxRepository.list();
  await app.locals.dispatchDomainEvents({ now: new Date(Math.max(...queuedEvents.map((event) => Date.parse(event.availableAt)))) });

  const runs = await agentExecutionRepository.listRuns({ goalId: goal.id, tenantId: 'tenant-1' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].payload.trigger.eventType, 'workflow.sla.overdue');
  assert.equal((await domainEventOutboxRepository.list()).every((event) => event.status === 'processed'), true);
});
