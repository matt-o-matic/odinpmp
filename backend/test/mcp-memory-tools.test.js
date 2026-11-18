import assert from 'node:assert/strict';
import test from 'node:test';
import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';

// Correcting and forgetting memories against a fake Odin REST API. These are the in-app
// assistant's tools alone; mcp-monitor-api.test.js runs them against the real routes.

const memory = { confidence: 0.9, content: 'Launch is on 1 December.', createdBy: 'user-1', embedding: null, id: 'memory-1', memoryType: 'decision', projectId: 'project-1', provenance: {}, sensitivity: 'internal', tenantId: 'tenant-1', title: 'Launch date', updatedAt: '2026-10-01T00:00:00.000Z', version: 3 };

function tools(respond) {
  const calls = [];
  const catalog = createOdinToolCatalog({ api: { request: async (...args) => { calls.push(args); return respond(...args); } }, extended: true });
  const call = (name, args) => {
    const entry = catalog.find((candidate) => candidate.name === name);
    return entry.handler(entry.schema.parse(args));
  };
  return { call, calls, catalog };
}

test('memory tools are the assistant\'s alone; forgetting asks the user first', () => {
  const mcp = createOdinToolCatalog({ api: null }).map((entry) => entry.name);
  for (const name of ['odin_correct_memory', 'odin_forget_memory', 'odin_create_monitor', 'odin_list_monitors', 'odin_stop_monitor']) {
    assert.equal(mcp.includes(name), false, name);
  }
  const { catalog } = tools(() => ({}));
  const byName = Object.fromEntries(catalog.map((entry) => [entry.name, entry]));
  assert.deepEqual([byName.odin_correct_memory.write, byName.odin_correct_memory.destructive], [true, true]);
  assert.deepEqual([byName.odin_forget_memory.write, byName.odin_forget_memory.destructive], [true, true]);
  assert.equal(toolNeedsConfirmation('odin_forget_memory', { expectedVersion: 3, memoryId: 'memory-1' }), true);
  assert.equal(toolNeedsConfirmation('odin_forget_memory', { dryRun: true, expectedVersion: 3, memoryId: 'memory-1' }), false);
  assert.equal(toolNeedsConfirmation('odin_correct_memory', { content: 'x', expectedVersion: 3, memoryId: 'memory-1' }), false);
});

test('a correction sends only the changed fields with the version read, and returns a compact memory', async () => {
  const { call, calls } = tools(() => ({ embeddingStatus: 'disabled', memory: { ...memory, content: 'Launch moved to 8 December.', version: 4 }, ok: true }));
  const result = await call('odin_correct_memory', { content: 'Launch moved to 8 December.', expectedVersion: 3, memoryId: 'memory-1' });
  assert.deepEqual(calls, [['PATCH', '/api/agent-memory/memory-1', { body: { content: 'Launch moved to 8 December.', expectedVersion: 3 } }]]);
  assert.deepEqual(result, { changed: true, memory: { confidence: 0.9, content: 'Launch moved to 8 December.', id: 'memory-1', memoryType: 'decision', projectId: 'project-1', sensitivity: 'internal', title: 'Launch date', updatedAt: '2026-10-01T00:00:00.000Z', version: 4 }, ok: true });
  await assert.rejects(call('odin_correct_memory', { expectedVersion: 3, memoryId: 'memory-1' }), { code: 'nothing_to_change' });
  assert.throws(() => tools(() => ({})).catalog.find((entry) => entry.name === 'odin_correct_memory').schema.parse({ embedding: [], expectedVersion: 3, memoryId: 'memory-1', title: 'x' }));
  const preview = await call('odin_correct_memory', { dryRun: true, expectedVersion: 3, memoryId: 'memory-1', sensitivity: 'restricted' });
  assert.deepEqual([preview.dryRun, preview.request.body, calls.length], [true, { expectedVersion: 3, sensitivity: 'restricted' }, 1]);
});

test('forgetting sends the version read; Odin\'s refusals say what to do next', async () => {
  const { call, calls } = tools(() => ({ forgottenMemoryId: 'memory-1', ok: true, version: 4 }));
  assert.deepEqual(await call('odin_forget_memory', { expectedVersion: 3, memoryId: 'memory-1' }), { forgottenMemoryId: 'memory-1', ok: true });
  assert.deepEqual(calls, [['DELETE', '/api/agent-memory/memory-1', { body: { expectedVersion: 3 } }]]);
  for (const [status, code, pattern] of [[404, 'memory_not_found', /odin_search_memory/], [409, 'version_conflict', /current version/], [423, 'legal_hold', /legal hold/], [403, 'memory_not_changeable', /author/]]) {
    const refused = tools(() => { throw new OdinApiError(status, `http_${status}`, 'upstream'); });
    await assert.rejects(refused.call('odin_forget_memory', { expectedVersion: 3, memoryId: 'memory-1' }), (error) => error.code === code && pattern.test(error.message));
    await assert.rejects(refused.call('odin_correct_memory', { expectedVersion: 3, memoryId: 'memory-1', title: 'x' }), { code });
  }
});
