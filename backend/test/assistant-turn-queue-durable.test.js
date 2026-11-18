import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { createAssistantTurnQueue } from '../src/modules/assistant/assistant-turn-queue.js';

function durableInput() {
  return {
    idempotencyKey: 'turn:session-1:request-1',
    payload: { message: 'Keep launch on track.' },
    projectId: 'project-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
  };
}

test('two turn queues execute one durable idempotent turn', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const firstQueue = createAssistantTurnQueue({ executionRepository: repository, leaseMs: 1000, workerId: 'worker-a' });
  const secondQueue = createAssistantTurnQueue({ executionRepository: repository, leaseMs: 1000, workerId: 'worker-b' });
  let executions = 0;
  const run = async () => { executions += 1; return { ok: true }; };

  const first = firstQueue.enqueue({ durable: durableInput(), run, sessionId: 'session-1' });
  const second = secondQueue.enqueue({ durable: durableInput(), run, sessionId: 'session-1' });
  await Promise.all([first.job.promise, second.job.promise]);

  assert.equal(executions, 1);
  const runs = [...repository.state.runs.values()];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
});

test('turn queue records retry state when execution fails', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const queue = createAssistantTurnQueue({ executionRepository: repository, leaseMs: 1000, workerId: 'worker-a' });
  const queued = queue.enqueue({
    durable: durableInput(),
    run: async () => { throw new Error('temporary'); },
    sessionId: 'session-1',
  });
  await queued.job.promise;

  assert.equal(queued.job.status, 'failed');
  assert.equal([...repository.state.runs.values()][0].status, 'retry_scheduled');
});

test('new worker process resumes a persisted unclaimed turn payload', async () => {
  const firstProcess = createInMemoryAgentExecutionRepository();
  const { run: persisted } = await firstProcess.enqueueRun({
    ...durableInput(),
    runType: 'assistant_turn',
    sessionId: 'session-1',
  });

  const restartedRepository = createInMemoryAgentExecutionRepository({ state: firstProcess.state });
  const restartedWorker = createAssistantTurnQueue({
    executionRepository: restartedRepository,
    leaseMs: 1000,
    workerId: 'worker-after-restart',
  });
  const resumed = await restartedWorker.workOnce({
    run: async ({ payload }) => ({ echoed: payload.message }),
  });

  assert.equal(resumed.run.id, persisted.id);
  assert.equal(resumed.run.status, 'completed');
  assert.deepEqual(resumed.output, { echoed: 'Keep launch on track.' });
});

test('durable worker exposes atomic budget and trace recording to the run handler', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  await repository.enqueueRun({
    ...durableInput(),
    budgets: { costUsd: 0.01, inputTokens: 100, outputTokens: 50, toolCalls: 1, wallClockMs: 1_000 },
    runType: 'assistant_turn',
    sessionId: 'session-1',
  });
  const queue = createAssistantTurnQueue({ executionRepository: repository, leaseMs: 1_000, workerId: 'worker-a' });
  const result = await queue.workOnce({
    async run({ executionRun, recordTrace, recordUsage }) {
      await recordUsage({ costUsd: 0.004, inputTokens: 40, outputTokens: 10, toolCalls: 1 });
      await recordTrace({
        costUsd: 0.004,
        idempotencyKey: 'intent-response-1',
        inputTokens: 40,
        model: 'gpt-5.4-nano',
        outputTokens: 10,
        requestId: 'response-1',
      });
      return { runId: executionRun.id };
    },
  });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.usage.inputTokens, 40);
  assert.equal(result.run.usage.toolCalls, 1);
  assert.ok(result.run.usage.wallClockMs >= 0);
  assert.equal((await repository.listTraces(result.run.id))[0].model, 'gpt-5.4-nano');
});
