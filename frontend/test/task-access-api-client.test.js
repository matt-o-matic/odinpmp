import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiClient } from '../src/lib/api/client.js';

async function capture(run) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ auth: options.headers?.Authorization ?? null, body: options.body ? JSON.parse(options.body) : undefined, method: options.method, url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  try {
    await run(createApiClient({ baseUrl: 'http://localhost:3001' }));
  } finally {
    globalThis.fetch = previousFetch;
  }
  return calls.map((call) => ({ ...call, url: call.url.replace('http://localhost:3001', '') }));
}

test('access link calls use the public routes and send no session token', async () => {
  const calls = await capture(async (client) => {
    await client.getAccessHub('tok/1');
    await client.openAccessRequirements('tok', 'p1');
    await client.getAccessTasks('tok', 'p1');
    await client.updateAccessTask('tok', 'p1', 't1', { boardColumn: 'doing', expectedVersion: 3, status: 'In Progress' });
    await client.createAccessTask('tok', 'p1', 's1', { name: 'New' });
    await client.listAccessTaskComments('tok', 'p1', 't1');
    await client.addAccessTaskComment('tok', 'p1', 't1', { text: 'Done' });
    await client.listAccessTaskTime('tok', 'p1', 't1');
    await client.logAccessTaskTime('tok', 'p1', 't1', { hours: 1.5, workDate: '2026-10-29' });
    await client.deleteAccessTimeEntry('tok', 'p1', 'e1', 2);
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/public/access/tok%2F1',
    'POST /api/public/access/tok/projects/p1/requirements',
    'GET /api/public/access/tok/projects/p1/tasks',
    'PATCH /api/public/access/tok/projects/p1/tasks/t1',
    'POST /api/public/access/tok/projects/p1/stories/s1/tasks',
    'GET /api/public/access/tok/projects/p1/tasks/t1/comments',
    'POST /api/public/access/tok/projects/p1/tasks/t1/comments',
    'GET /api/public/access/tok/projects/p1/tasks/t1/time',
    'POST /api/public/access/tok/projects/p1/tasks/t1/time',
    'DELETE /api/public/access/tok/projects/p1/time/e1?expectedVersion=2',
  ]);
  assert.deepEqual(calls[3].body, { boardColumn: 'doing', expectedVersion: 3, status: 'In Progress' });
  assert.deepEqual(calls[8].body, { hours: 1.5, workDate: '2026-10-29' });
  assert.equal(calls.every((call) => call.auth === null), true);
});

test('stories and epics use the same item routes as tasks', async () => {
  const calls = await capture(async (client) => {
    await client.updateAccessTask('tok', 'p1', 'story-1', { expectedVersion: 2, status: 'Completed' });
    await client.addAccessTaskComment('tok', 'p1', 'epic-1', { text: 'On track' });
    await client.logAccessTaskTime('tok', 'p1', 'epic-1', { hours: 1, workDate: '2026-10-29' });
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'PATCH /api/public/access/tok/projects/p1/tasks/story-1',
    'POST /api/public/access/tok/projects/p1/tasks/epic-1/comments',
    'POST /api/public/access/tok/projects/p1/tasks/epic-1/time',
  ]);
});

test('the public writes that answer 201 Created resolve with their body', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 201, async json() { return { ok: true, task: { id: 't-new' } }; } });
  try {
    const client = createApiClient({ baseUrl: 'http://localhost:3001' });
    assert.deepEqual(await client.createAccessTask('tok', 'p1', 's1', { name: 'New' }), { ok: true, task: { id: 't-new' } });
    assert.deepEqual(await client.logAccessTaskTime('tok', 'p1', 't1', { hours: 1, workDate: '2026-10-29' }), { ok: true, task: { id: 't-new' } });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('manager task access calls use the resource planning routes', async () => {
  const calls = await capture(async (client) => {
    await client.getProjectTaskAccess('p1', 'token');
    await client.setProjectTaskAccess('p1', 'r1', { scope: 'own' }, 'token');
    await client.sendProjectTaskAccessLink('p1', 'r1', { delivery: 'manual' }, 'token');
    await client.getResourceAccessLink('r1', 'token');
    await client.revokeResourceAccessLink('r1', 'token');
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/resource-planning/projects/p1/task-access',
    'PUT /api/resource-planning/projects/p1/task-access/r1',
    'POST /api/resource-planning/projects/p1/task-access/r1/link',
    'GET /api/resource-planning/resources/r1/access-link',
    'POST /api/resource-planning/resources/r1/access-link/revoke',
  ]);
  assert.deepEqual(calls[1].body, { scope: 'own' });
  assert.deepEqual(calls[2].body, { delivery: 'manual' });
  assert.equal(calls[0].auth, 'Bearer token');
});
