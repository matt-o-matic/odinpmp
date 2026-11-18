import assert from 'node:assert/strict';
import test from 'node:test';

import { startAssistantDurableWorker } from '../src/modules/assistant/assistant-durable-worker.js';

test('durable worker polls claimable turns and prevents overlapping polls', async () => {
  let release;
  let workCalls = 0;
  const worker = startAssistantDurableWorker({
    intervalMs: 60_000,
    queue: {
      async workOnce({ run }) {
        workCalls += 1;
        await new Promise((resolve) => { release = resolve; });
        return run({ payload: { sessionId: 'session-1' } });
      },
    },
    run: async ({ payload }) => payload.sessionId,
  });

  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = await worker.poll();
  assert.equal(overlapping, null);
  assert.equal(workCalls, 1);
  assert.equal(worker.isIdle(), false);
  const waiting = worker.waitForIdle({ timeoutMs: 100 });
  release();
  assert.equal(await waiting, true);
  assert.equal(worker.isHealthy(), true);
  worker.stop();
  assert.equal(worker.isHealthy(), false);
});

test('durable worker reports polling errors without terminating', async () => {
  const errors = [];
  const worker = startAssistantDurableWorker({
    intervalMs: 60_000,
    onError: (error) => errors.push(error.message),
    queue: { async workOnce() { throw new Error('database unavailable'); } },
    run: async () => null,
  });

  await new Promise((resolve) => setImmediate(resolve));
  worker.stop();
  assert.deepEqual(errors, ['database unavailable']);
});
