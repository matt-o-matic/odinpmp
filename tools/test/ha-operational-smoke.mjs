#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../backend/src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const quiet = { agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0, reportSubscriptionSweepIntervalMs: 0, webhookSweepIntervalMs: 0 };
const servers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function appInstance(name, dependency) {
  const app = createApp({ ...quiet, readinessChecks: { database: async () => {
    if (!dependency.ready) throw new Error('database unavailable');
  } } });
  const server = http.createServer(app); servers.push(server);
  return { app, name, server };
}

async function healthy(instance) {
  if (!instance.server.listening) return false;
  try {
    const response = await fetch(`${instance.origin}/health/ready`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

try {
  const databaseA = { ready: true }; const databaseB = { ready: true };
  const instances = [appInstance('instance-a', databaseA), appInstance('instance-b', databaseB)];
  for (const instance of instances) instance.origin = await listen(instance.server);

  let cursor = 0;
  const loadBalancer = http.createServer(async (request, response) => {
    for (let offset = 0; offset < instances.length; offset += 1) {
      const index = (cursor + offset) % instances.length; const instance = instances[index];
      if (!await healthy(instance)) continue;
      cursor = (index + 1) % instances.length;
      const upstream = await fetch(`${instance.origin}${request.url}`, { signal: AbortSignal.timeout(2_000) });
      response.statusCode = upstream.status;
      response.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
      response.setHeader('X-Odin-Upstream', instance.name);
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    response.statusCode = 503; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: 'No ready Odin instance.', ok: false }));
  });
  servers.push(loadBalancer); const loadBalancerOrigin = await listen(loadBalancer);

  const distribution = new Set();
  for (let index = 0; index < 4; index += 1) {
    const response = await fetch(`${loadBalancerOrigin}/api`); assert.equal(response.status, 200); distribution.add(response.headers.get('x-odin-upstream'));
  }
  assert.deepEqual([...distribution].sort(), ['instance-a', 'instance-b']);

  assert.equal(await instances[0].app.locals.beginDrain({ timeoutMs: 1_000 }), true);
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${loadBalancerOrigin}/api`); assert.equal(response.status, 200); assert.equal(response.headers.get('x-odin-upstream'), 'instance-b');
  }
  await close(instances[0].server);
  const afterLoss = await fetch(`${loadBalancerOrigin}/api`); assert.equal(afterLoss.status, 200); assert.equal(afterLoss.headers.get('x-odin-upstream'), 'instance-b');

  databaseB.ready = false;
  const unavailable = await fetch(`${loadBalancerOrigin}/api`); assert.equal(unavailable.status, 503);
  const metrics = await (await fetch(`${instances[1].origin}/metrics`)).text();
  assert.match(metrics, /odin_dependency_ready\{dependency="database"\} 0/);
  assert.doesNotMatch(metrics, /database unavailable|secret|token/i);

  const alertRules = await fs.readFile(path.join(root, 'tools/observability/prometheus-rules.yml'), 'utf8');
  for (const contract of ['odin_readiness == 0', 'odin_slo_breach{objective="p95_latency"} == 1', 'odin_slo_breach{objective="error_rate"} == 1', 'odin_dependency_ready == 0']) assert.match(alertRules, new RegExp(contract.replace(/[{}]/g, '\\$&')));

  console.log(JSON.stringify({ alertContracts: 4, dependencyFailureRemovedLastInstance: true, distributedAcross: [...distribution].sort(), drainRemovedInstance: 'instance-a', instanceLossRecovered: true, passed: true }));
} finally {
  await Promise.allSettled(servers.map(close));
}
