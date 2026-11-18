import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';
import { createOdinApiClient, OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createOdinMcpServer } from '../src/mcp/server.js';

// The change tools against a fake Odin REST API: the requests they send and the messages they give
// for Odin's refusals. The routes' own rules are in project-changes-api.test.js and
// item-details-and-changes-api.test.js.

const BASE = '/api/projects/project-1';

async function session(t, respond) {
  const calls = [];
  const server = createOdinMcpServer({ api: { request: async (...args) => { calls.push(args); return respond(...args); } } });
  const client = new Client({ name: 'odin-mcp-change-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
    return { data: result.structuredContent, isError: result.isError === true };
  };
  return { call, calls, client };
}

const change = (index) => ({ expected: { version: 1 }, idempotencyKey: `key-change-${String(index).padStart(4, '0')}`, itemId: `task-${index}`, patch: { status: 'Review' }, reason: 'CI passed.' });

test('item details send ids and continue tokens as lists; the batch posts as sent', async (t) => {
  const { call, calls, client } = await session(t, (method, path) => (path === BASE ? { permissions: { canEditPlan: true, canManage: true } } : { items: [], missing: [], ok: true, results: [] }));
  const details = await call('odin_get_item_details', { continue: ['d1.abcd'], itemIds: ['task-1', 'task-2'], projectId: 'project-1' });
  assert.equal(details.isError, false);
  assert.deepEqual(calls[0], ['GET', `${BASE}/item-details`, { query: { commentLimit: 20, continue: 'd1.abcd', historyLimit: 10, ids: 'task-1,task-2' } }]);

  const body = { basedOn: 'c1.abcd', changes: [{ ...change(1), comment: 'Deployed.', evidence: [{ ref: 'ci:42' }] }] };
  assert.equal((await call('odin_apply_item_changes', { ...body, projectId: 'project-1' })).isError, false);
  assert.deepEqual(calls.at(-1), ['POST', `${BASE}/item-changes`, { body, okFalseIsResult: true }]);

  // An idempotency key too short, a change with nothing in it, or an unknown field never reaches Odin.
  const sent = calls.length;
  for (const bad of [{ ...change(2), idempotencyKey: 'short' }, { expected: { version: 1 }, idempotencyKey: 'key-change-9999', itemId: 'task-9', reason: 'r' }, { ...change(3), extra: true }]) {
    assert.equal((await call('odin_apply_item_changes', { changes: [bad], projectId: 'project-1' })).isError, true, JSON.stringify(bad));
  }
  assert.equal(calls.length, sent);
  // Reads are read-only; the batch writes, without asking first (it sends no email: mentions are refused).
  const listed = new Map((await client.listTools()).tools.map((entry) => [entry.name, entry]));
  assert.deepEqual(['odin_get_item_details', 'odin_apply_item_changes'].map((name) => listed.get(name).annotations.readOnlyHint), [true, false]);
  assert.equal(toolNeedsConfirmation('odin_apply_item_changes', { changes: [change(1)], projectId: 'project-1' }), false);
});

test('over HTTP, a batch with a stale change comes back as its results, and what it saved counts toward the item limit', async (t) => {
  // Odin's batch route answers ok: false when any change wasn't applied. The real API client
  // treats ok: false as an error unless the call says it is a result.
  const posted = [];
  const odin = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === BASE) {
      return response.end(JSON.stringify({ ok: true, permissions: { canEditPlan: true, canManage: false, projectRole: 'member' }, project: { id: 'project-1' } }));
    }
    const { changes } = JSON.parse(raw);
    posted.push(changes.length);
    const results = changes.map((entry, index) => ({ idempotencyKey: entry.idempotencyKey, itemId: entry.itemId, status: index === 0 ? 'stale' : 'applied' }));
    return response.end(JSON.stringify({ applied: changes.length - 1, ok: false, results }));
  });
  await new Promise((resolve) => { odin.listen(0, '127.0.0.1', resolve); });
  // The pause lets the client side finish closing: without it, --test-force-exit exits while that
  // work is in flight and Node aborts on Windows (a libuv assertion in srcwinasync.c), after every
  // test here has passed.
  t.after(async () => { odin.closeAllConnections(); await new Promise((resolve) => { odin.close(resolve); }); await new Promise((resolve) => { setTimeout(resolve, 50); }); });
  const api = createOdinApiClient({ baseUrl: `http://127.0.0.1:${odin.address().port}`, token: 'test-session-token' });
  const tool = createOdinToolCatalog({ api, extended: true }).find((entry) => entry.name === 'odin_apply_item_changes');
  const apply = (from, count) => tool.handler(tool.schema.parse({ changes: Array.from({ length: count }, (_, index) => change(from + index)), projectId: 'project-1' }));

  const first = await apply(1, 9);
  assert.equal(first.ok, false);
  assert.deepEqual(first.results.map((entry) => entry.status), ['stale', ...Array(8).fill('applied')]);
  // 8 saved, so 3 more would pass the limit of 10 in this turn; 2 more fit.
  await assert.rejects(apply(10, 3), { code: 'needs_project_manager' });
  assert.equal((await apply(10, 2)).results.length, 2);
  assert.deepEqual(posted, [9, 2]);
});

test('someone without manager rights can\'t change more than the item limit in one batch', async (t) => {
  const { call, calls } = await session(t, (method, path) => (path === BASE ? { permissions: { canEditPlan: true, canManage: false, projectRole: 'member' } } : { ok: true, results: [] }));
  const refused = await call('odin_apply_item_changes', { changes: Array.from({ length: 25 }, (_, index) => change(index)), projectId: 'project-1' });
  assert.equal(refused.isError, true);
  assert.ok(!calls.some(([method]) => method === 'POST'));
});

test('Odin\'s refusals come back as messages that say what to do next', async (t) => {
  for (const [name, args, status, code] of [
    ['odin_get_item_details', { itemIds: ['task-1'], projectId: 'project-1' }, 400, 'invalid_request'],
    ['odin_get_project_changes', { cursor: 'c1.old', projectId: 'project-1' }, 409, 'cursor_expired'],
    ['odin_apply_item_changes', { changes: [change(1)], projectId: 'project-1' }, 404, 'http_404'],
  ]) {
    const { call } = await session(t, (method, path) => {
      if (path === BASE) return { permissions: { canEditPlan: true, canManage: true } };
      throw new OdinApiError(status, `http_${status}`, 'upstream');
    });
    const { data, isError } = await call(name, args);
    assert.equal(isError, true, name);
    assert.equal(data.error.code, code, name);
  }
});
