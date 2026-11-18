import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInMemoryAgentExecutionRepository,
  ensureMysqlAgentExecutionSchema,
} from '../src/modules/assistant/agent-execution.repository.js';

function enqueueInput(overrides = {}) {
  return {
    idempotencyKey: 'turn:session-1:message-1',
    payload: { input: 'Keep launch on track.' },
    projectId: 'project-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    ...overrides,
  };
}

test('durable agent execution deduplicates enqueues and worker claims', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const first = await repository.enqueueRun(enqueueInput());
  const duplicate = await repository.enqueueRun(enqueueInput());
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.id, first.run.id);

  const claimed = await repository.claimNextRun({
    leaseMs: 1000,
    now: new Date('2030-07-10T12:00:00.000Z'),
    workerId: 'worker-a',
  });
  assert.equal(claimed.id, first.run.id);
  assert.equal(claimed.attemptCount, 1);
  assert.equal(await repository.claimNextRun({
    leaseMs: 1000,
    now: new Date('2030-07-10T12:00:00.500Z'),
    workerId: 'worker-b',
  }), null);
});

test('expired lease is reclaimed once after repository restart and stale worker is fenced', async () => {
  const firstProcess = createInMemoryAgentExecutionRepository();
  const enqueued = await firstProcess.enqueueRun(enqueueInput());
  const firstClaim = await firstProcess.claimNextRun({
    leaseMs: 1000,
    now: new Date('2030-07-10T12:00:00.000Z'),
    workerId: 'worker-a',
  });

  const restartedProcess = createInMemoryAgentExecutionRepository({ state: firstProcess.state });
  const recovered = await restartedProcess.claimNextRun({
    leaseMs: 1000,
    now: new Date('2030-07-10T12:00:01.001Z'),
    workerId: 'worker-b',
  });
  assert.equal(recovered.id, enqueued.run.id);
  assert.equal(recovered.attemptCount, 2);
  assert.notEqual(recovered.leaseToken, firstClaim.leaseToken);

  await assert.rejects(() => firstProcess.completeRun({
    leaseToken: firstClaim.leaseToken,
    now: new Date('2030-07-10T12:00:01.100Z'),
    output: { stale: true },
    runId: enqueued.run.id,
    workerId: 'worker-a',
  }), /lease/i);

  const completed = await restartedProcess.completeRun({
    leaseToken: recovered.leaseToken,
    now: new Date('2030-07-10T12:00:01.100Z'),
    output: { ok: true },
    runId: enqueued.run.id,
    workerId: 'worker-b',
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual((await restartedProcess.listEvents(enqueued.run.id)).map((event) => event.type), [
    'run.queued', 'run.claimed', 'run.claimed', 'run.completed',
  ]);
});

test('retry scheduling backs off and exhausted retries move to dead letter', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const { run } = await repository.enqueueRun(enqueueInput({ maxAttempts: 2 }));
  const first = await repository.claimNextRun({ leaseMs: 1000, now: new Date('2030-07-10T12:00:00Z'), workerId: 'worker-a' });
  const retry = await repository.failRun({
    error: new Error('temporary'),
    leaseToken: first.leaseToken,
    now: new Date('2030-07-10T12:00:00.100Z'),
    retryBaseMs: 1000,
    retryable: true,
    runId: run.id,
    workerId: 'worker-a',
  });
  assert.equal(retry.status, 'retry_scheduled');
  assert.equal(await repository.claimNextRun({ leaseMs: 1000, now: new Date('2030-07-10T12:00:01.000Z'), workerId: 'worker-b' }), null);
  const second = await repository.claimNextRun({ leaseMs: 1000, now: new Date('2030-07-10T12:00:01.100Z'), workerId: 'worker-b' });
  const dead = await repository.failRun({
    error: new Error('still broken'),
    leaseToken: second.leaseToken,
    now: new Date('2030-07-10T12:00:01.200Z'),
    retryBaseMs: 1000,
    retryable: true,
    runId: run.id,
    workerId: 'worker-b',
  });
  assert.equal(dead.status, 'dead_lettered');
  assert.ok(dead.deadLetteredAt);
});

test('steps, tool calls, and checkpoints are idempotent and pause/resume is durable', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({
    constraints: { allowedTools: ['summarize_plan'] },
    scope: { projectIds: ['project-1'] },
    success: { measure: 'launch remains on track' },
    tenantId: 'tenant-1',
    title: 'Keep launch on track',
  });
  assert.equal(goal.status, 'active');
  const { run } = await repository.enqueueRun(enqueueInput());
  const stepInput = { idempotencyKey: 'step:plan', name: 'Plan', runId: run.id, sequence: 0 };
  const step = await repository.createStep(stepInput);
  assert.equal((await repository.createStep(stepInput)).created, false);
  const toolInput = { arguments: { projectId: 'project-1' }, idempotencyKey: 'tool:read-plan', runId: run.id, stepId: step.step.id, toolName: 'summarize_plan' };
  assert.equal((await repository.createToolCall(toolInput)).created, true);
  assert.equal((await repository.createToolCall(toolInput)).created, false);
  assert.equal((await repository.saveCheckpoint({ checkpoint: { cursor: 1 }, idempotencyKey: 'checkpoint:1', runId: run.id, stepId: step.step.id })).created, true);
  assert.equal((await repository.saveCheckpoint({ checkpoint: { cursor: 2 }, idempotencyKey: 'checkpoint:1', runId: run.id, stepId: step.step.id })).created, false);
  const approval = await repository.createApproval({
    policy: { reason: 'external side effect' },
    runId: run.id,
    stepId: step.step.id,
    summary: 'Approve stakeholder email',
  });
  assert.equal(approval.status, 'pending');
  assert.equal((await repository.pauseRun(run.id)).status, 'paused');
  assert.equal((await repository.resumeRun(run.id, { fromStepId: step.step.id })).status, 'queued');
});

test('agent goals expose versioned lifecycle, scoped listing, and run history', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({
    constraints: { maxAttempts: 3 }, ownerUserId: 'user-1', projectId: 'project-1',
    scope: { projectIds: ['project-1'] }, success: { measure: 'No overdue critical milestones' },
    tenantId: 'tenant-1', title: 'Protect launch readiness',
  });
  assert.equal(goal.version, 1);
  assert.equal((await repository.listGoals({ projectId: 'project-1', tenantId: 'tenant-1' })).length, 1);
  const updated = await repository.updateGoal({ expectedVersion: 1, goalId: goal.id, patch: { status: 'paused' }, tenantId: 'tenant-1' });
  assert.equal(updated.version, 2);
  await assert.rejects(
    repository.updateGoal({ expectedVersion: 1, goalId: goal.id, patch: { status: 'active' }, tenantId: 'tenant-1' }),
    (error) => error.code === 'agent_goal_version_conflict' && error.actualVersion === 2,
  );
  await repository.enqueueRun({
    goalId: goal.id, idempotencyKey: 'goal-run-1', payload: {}, projectId: 'project-1', tenantId: 'tenant-1', userId: 'user-1',
  });
  assert.equal((await repository.listRuns({ goalId: goal.id, tenantId: 'tenant-1' })).length, 1);
});

test('run budgets are enforced atomically and traces are durable and idempotent', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const { run } = await repository.enqueueRun(enqueueInput({
    budgets: { costUsd: 0.01, externalMessages: 0, inputTokens: 100, mutations: 1, outputTokens: 50, toolCalls: 2, wallClockMs: 1_000 },
  }));
  const updated = await repository.consumeRunUsage({
    runId: run.id,
    usage: { costUsd: 0.005, inputTokens: 80, outputTokens: 20, toolCalls: 1 },
  });
  assert.deepEqual(updated.usage, {
    costUsd: 0.005, externalMessages: 0, inputTokens: 80, mutations: 0,
    outputTokens: 20, toolCalls: 1, wallClockMs: 0,
  });
  await assert.rejects(() => repository.consumeRunUsage({
    runId: run.id,
    usage: { inputTokens: 21 },
  }), (error) => error.code === 'agent_run_budget_exceeded' && error.exceeded.includes('inputTokens'));
  assert.equal((await repository.getRun(run.id)).usage.inputTokens, 80);

  const traceInput = {
    costUsd: 0.005,
    idempotencyKey: 'model:response-1',
    inputTokens: 80,
    latencyMs: 42,
    model: 'gpt-5.4-nano',
    outputTokens: 20,
    promptId: 'intent-v1',
    requestId: 'response-1',
    runId: run.id,
  };
  assert.equal((await repository.recordTrace(traceInput)).created, true);
  assert.equal((await repository.recordTrace(traceInput)).created, false);
  assert.equal((await repository.listTraces(run.id)).length, 1);
  assert.deepEqual((await repository.listEvents(run.id)).slice(-3).map((event) => event.type), [
    'run.usage_recorded', 'run.budget_exceeded', 'run.trace_recorded',
  ]);
});

test('MySQL bootstrap creates every normalized durable execution table', async () => {
  const statements = [];
  await ensureMysqlAgentExecutionSchema({ execute: async (sql) => { statements.push(sql); return [{ affectedRows: 0 }]; } });
  for (const table of ['agent_goals', 'agent_runs', 'agent_steps', 'tool_calls', 'approvals', 'run_events', 'run_checkpoints', 'run_budgets', 'run_traces']) {
    assert.ok(statements.some((sql) => sql.includes(`TABLE IF NOT EXISTS ${table}`)), table);
  }
});
