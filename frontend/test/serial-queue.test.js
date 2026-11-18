import assert from 'node:assert/strict';
import test from 'node:test';

import { createSerialQueue } from '../src/lib/async/serial-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

test('queued tasks run one at a time in order, and a failure does not stop later tasks', async () => {
  const sizes = [];
  const queue = createSerialQueue({ onChange: ({ size }) => sizes.push(size) });
  const first = deferred();
  const order = [];

  const a = queue.enqueue(async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
    return 'a';
  });
  const b = queue.enqueue(async () => {
    order.push('b');
    throw new Error('b failed');
  });
  const c = queue.enqueue(async () => {
    order.push('c');
    return 'c';
  });

  assert.equal(queue.size, 3);
  assert.deepEqual(order, ['a:start']);
  first.resolve();

  assert.equal(await a, 'a');
  await assert.rejects(b, /b failed/);
  assert.equal(await c, 'c');
  assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c']);
  assert.equal(queue.busy, false);
  assert.equal(sizes.at(-1), 0);
});

test('clear drops tasks that have not started and lets the running one finish', async () => {
  const queue = createSerialQueue();
  const running = deferred();
  const ran = [];

  const a = queue.enqueue(async () => {
    await running.promise;
    ran.push('a');
  });
  const b = queue.enqueue(async () => ran.push('b'));
  const reason = new Error('cancelled');

  queue.clear(reason);
  running.resolve();

  await a;
  await assert.rejects(b, (error) => error === reason);
  assert.deepEqual(ran, ['a']);
  assert.equal(queue.busy, false);
});
