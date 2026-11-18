import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createOdinMcpServer } from '../src/mcp/server.js';

const delivery = { createdAt: '2026-10-01T12:00:00.000Z', id: 'project-1', kind: 'delivery', name: 'Delivery', role: 'admin', status: 'Planned', updatedAt: '2026-10-01T12:00:00.000Z' };
const engagement = { ...delivery, id: 'project-2', kind: 'engagement', name: 'Engagement' };

async function session(t, respond) {
  const calls = [];
  const api = { request: async (...args) => { calls.push(args); return respond(...args); } };
  const server = createOdinMcpServer({ api });
  const client = new Client({ name: 'odin-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (args = {}) => (await client.callTool({ name: 'odin_list_projects', arguments: args }, undefined, { timeout: 2000 })).structuredContent;
  return { call, calls };
}

test('odin_list_projects gives each project its kind and asks for engagements only when told to', async (t) => {
  // Odin answers /api/projects with delivery projects, and adds engagements for include=engagements.
  const { call, calls } = await session(t, (_method, _path, { query = {} } = {}) => ({ ok: true, projects: query.include === 'engagements' ? [delivery, engagement] : [delivery] }));

  const plain = await call();
  assert.deepEqual(calls.at(-1), ['GET', '/api/projects', { query: { include: undefined } }]);
  assert.deepEqual(plain.items.map((project) => [project.id, project.kind]), [['project-1', 'delivery']]);
  assert.deepEqual(Object.keys(plain.items[0]).sort(), ['createdAt', 'id', 'kind', 'name', 'role', 'status', 'updatedAt']);

  const all = await call({ includeEngagements: true });
  assert.deepEqual(calls.at(-1), ['GET', '/api/projects', { query: { include: 'engagements' } }]);
  assert.deepEqual(all.items.map((project) => [project.id, project.kind]), [['project-1', 'delivery'], ['project-2', 'engagement']]);

  // A cursor from one listing does not continue the other.
  const first = await call({ includeEngagements: true, limit: 1 });
  assert.equal((await call({ cursor: first.nextCursor })).error.code, 'stale_cursor');
});
