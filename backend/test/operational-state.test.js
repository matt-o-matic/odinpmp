import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createOperationalState } from '../src/lib/operations/operational-state.js';

const quiet = { agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0, reportSubscriptionSweepIntervalMs: 0, webhookSweepIntervalMs: 0 };

test('operational state reports dependency readiness, SLO telemetry, and fail-closed drain behavior', async () => {
  const app = createApp({ ...quiet, readinessChecks: { database: async () => true, worker: async () => true } });
  assert.equal((await request(app).get('/health/live')).status, 200);
  const ready = await request(app).get('/health/ready'); assert.equal(ready.status, 200); assert.equal(ready.body.checks.database.ok, true);
  assert.equal((await request(app).get('/api')).status, 200);
  const slo = await request(app).get('/health/slo'); assert.equal(slo.status, 200); assert.equal(slo.body.telemetry.completedRequests, 1); assert.equal(slo.body.telemetry.latencyMs.sampleCount, 1);
  const metrics = await request(app).get('/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers['content-type'], /text\/plain/);
  assert.match(metrics.text, /odin_http_requests_total 1/);
  assert.match(metrics.text, /odin_dependency_ready\{dependency="database"\} 1/);
  assert.doesNotMatch(metrics.text, /database unavailable|token|secret/i);
  assert.equal(await app.locals.beginDrain({ timeoutMs: 100 }), true);
  const rejected = await request(app).get('/api'); assert.equal(rejected.status, 503); assert.equal(rejected.headers['retry-after'], '5');
  assert.equal((await request(app).get('/health/live')).status, 200); assert.equal((await request(app).get('/health/ready')).status, 503);
});

test('operational readiness names failed dependencies without failing liveness', async () => {
  const app = createApp({ ...quiet, readinessChecks: { database: async () => { throw new Error('database unavailable'); } } });
  const ready = await request(app).get('/health/ready'); assert.equal(ready.status, 503); assert.equal(ready.body.checks.database.ok, false); assert.match(ready.body.checks.database.error, /unavailable/);
  assert.equal((await request(app).get('/health/live')).status, 200);
});

test('operational drain waits for active work and observes its timeout', async () => {
  const state = createOperationalState(); const finish = state.beginRequest();
  const waiting = state.waitForIdle({ timeoutMs: 100 }); setTimeout(() => finish(204), 10); assert.equal(await waiting, true);
  const neverFinishes = state.beginRequest(); assert.equal(await state.waitForIdle({ timeoutMs: 5 }), false); neverFinishes(500);
});

test('operational telemetry evaluates declared latency and error-rate SLOs', () => {
  let now = Date.parse('2026-07-11T12:00:00.000Z'); const state = createOperationalState({ clock: () => now, slo: { errorRatePercent: 1, p95LatencyMs: 5 } });
  const finish = state.beginRequest(); now += 10; finish(503); const snapshot = state.snapshot();
  assert.deepEqual(snapshot.slo.breaches.sort(), ['error_rate', 'p95_latency']); assert.equal(snapshot.slo.observed.errorRatePercent, 100); assert.equal(snapshot.slo.targets.p95LatencyMs, 5);
});
