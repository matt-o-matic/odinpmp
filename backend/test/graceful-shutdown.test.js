import assert from 'node:assert/strict';
import test from 'node:test';

import { createGracefulShutdown } from '../src/lib/operations/graceful-shutdown.js';

test('graceful shutdown drains HTTP and worker work before closing the pool', async () => {
  const calls = []; const processRef = { exitCode: null };
  const shutdown = createGracefulShutdown({
    app: { locals: { async beginDrain({ timeoutMs }) { calls.push(['drain', timeoutMs]); return true; } } },
    logger: { log: (message) => calls.push(['log', message]) },
    pool: { async end() { calls.push(['pool.end']); } }, processRef,
    server: { close(callback) { calls.push(['server.close']); callback(); }, closeAllConnections() { calls.push(['server.force']); }, closeIdleConnections() { calls.push(['server.idle']); } },
    timeoutMs: 100,
    worker: { stop() { calls.push(['worker.stop']); }, async waitForIdle({ timeoutMs }) { calls.push(['worker.wait', timeoutMs]); return true; } },
  });
  const result = await shutdown('SIGTERM'); assert.deepEqual(result, { alreadyStarted: false, httpIdle: true, workerIdle: true }); assert.equal(processRef.exitCode, 0); assert.equal(calls.some(([name]) => name === 'server.force'), false); assert.equal(calls.at(-1)[0], 'pool.end');
  assert.deepEqual(await shutdown('SIGTERM'), { alreadyStarted: true });
});

test('graceful shutdown force-closes connections and sets failure exit code after drain timeout', async () => {
  let forced = false; const processRef = {};
  const shutdown = createGracefulShutdown({ app: { locals: { async beginDrain() { return false; } } }, logger: { log() {} }, pool: { async end() {} }, processRef, server: { close(callback) { callback(); }, closeAllConnections() { forced = true; } }, timeoutMs: 5, worker: { stop() {}, async waitForIdle() { return true; } } });
  const result = await shutdown('SIGTERM'); assert.equal(result.httpIdle, false); assert.equal(forced, true); assert.equal(processRef.exitCode, 1);
});
