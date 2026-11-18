import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpTrafficLimiter, describeMcpRequest } from '../src/mcp/mcp-traffic.js';

// How much MCP traffic Odin takes at once, and what it logs about each request. The limits on the
// real endpoint are checked in mcp-http.test.js.

test('each grant gets a burst and then a steady rate; other grants are not affected', () => {
  let nowMs = 0;
  const limiter = createMcpTrafficLimiter({ grant: { capacity: 3, refillPerSecond: 1 }, now: () => nowMs });
  assert.deepEqual([1, 2, 3].map(() => limiter.take('family-a').allowed), [true, true, true]);
  assert.deepEqual(limiter.take('family-a'), { allowed: false, retryAfterSeconds: 1 });
  assert.equal(limiter.take('family-b').allowed, true);
  nowMs = 1_000;
  assert.equal(limiter.take('family-a').allowed, true);
  assert.equal(limiter.take('family-a').allowed, false);
});

test('only so many requests run at once; the rest wait in line, and a full line is turned away', async () => {
  const limiter = createMcpTrafficLimiter({ maxInFlight: 2, maxQueued: 1, queueTimeoutMs: 50 });
  const first = await limiter.acquire();
  const second = await limiter.acquire();
  assert.deepEqual(limiter.stats(), { active: 2, queued: 0 });
  const waiting = limiter.acquire();
  assert.equal(await limiter.acquire(), null, 'the line holds one');
  assert.deepEqual(limiter.stats(), { active: 2, queued: 1 });
  first();
  first();
  const third = await waiting;
  assert.equal(typeof third, 'function');
  assert.deepEqual(limiter.stats(), { active: 2, queued: 0 }, 'the freed slot went to the one waiting, and a second release did nothing');
  second();
  third();
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});

test('a wait that runs out gives up its place', async () => {
  const limiter = createMcpTrafficLimiter({ maxInFlight: 1, maxQueued: 5, queueTimeoutMs: 20 });
  const holder = await limiter.acquire();
  assert.equal(await limiter.acquire(), null);
  assert.deepEqual(limiter.stats(), { active: 1, queued: 0 });
  holder();
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});

test('the log names methods, tools and the client, never arguments', () => {
  assert.deepEqual(describeMcpRequest({ id: 1, jsonrpc: '2.0', method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' }, protocolVersion: '2025-06-18' } }), {
    client: { name: 'openai-mcp', protocolVersion: '2025-06-18', version: '1.0.0' }, methods: ['initialize'],
  });
  const call = describeMcpRequest({ id: 2, jsonrpc: '2.0', method: 'tools/call', params: { arguments: { secret: 'do-not-log' }, name: 'odin_find_items' } });
  assert.deepEqual(call, { methods: ['tools/call'], tools: ['odin_find_items'] });
  assert.ok(!JSON.stringify(call).includes('do-not-log'));
  assert.deepEqual(describeMcpRequest([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { id: 3, jsonrpc: '2.0', method: 'tools/list' }]), {
    batch: 2, methods: ['notifications/initialized', 'tools/list'],
  });
  assert.deepEqual(describeMcpRequest({ id: 4, jsonrpc: '2.0', result: {} }), { methods: ['response'] });
  assert.deepEqual(describeMcpRequest(undefined), { methods: [] });
});
