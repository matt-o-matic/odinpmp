import assert from 'node:assert/strict';
import test from 'node:test';

import { createMysqlAgentMemoryRepository } from '../src/modules/memory/agent-memory.repository.js';

const row = {
  confidence: '0.9000', content: 'Vendor fallback evidence', created_at: new Date('2026-07-11T12:00:00Z'), created_by: 'user-1', deleted_at: null,
  embedded_at: new Date('2026-07-11T12:00:00Z'), embedding_content_hash: 'a'.repeat(64), embedding_dimensions: 2, embedding_model: 'test-embedding',
  expires_at: null, freshness_at: null, id: 'memory-1', legal_hold: 0, memory_type: 'decision', owner_user_id: 'user-1', project_id: 'project-1',
  provenance_json: '{"sourceType":"decision_register"}', retention_policy_id: null, sensitivity: 'internal', source_at: new Date('2026-07-11T12:00:00Z'),
  tenant_id: 'tenant-1', title: 'Vendor fallback', updated_at: new Date('2026-07-11T12:00:00Z'), version: 2,
};

function fakePool({ updateAffectedRows = 1, version = 2 } = {}) {
  const executed = [];
  return {
    executed,
    async execute(sql, params = []) {
      executed.push({ params, sql });
      if (sql.includes('information_schema')) return [[{ count: 1 }]];
      if (sql.startsWith('CREATE TABLE')) return [{}];
      if (sql.startsWith('SELECT COUNT(*) AS count FROM agent_memory_items')) return [[{ count: 7 }]];
      if (sql.startsWith('SELECT id, tenant_id')) return [[row]];
      if (sql.startsWith('SELECT provenance_json, version')) return [[{ provenance_json: row.provenance_json, version }]];
      if (sql.startsWith('UPDATE agent_memory_items')) return [{ affectedRows: updateAffectedRows }];
      if (sql.startsWith('SELECT version')) return [[{ version: version + 1 }]];
      if (sql.startsWith('SELECT * FROM agent_memory_items')) return [[{ ...row, content: 'Corrected', version: version + 1 }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('MySQL memory browse scopes, filters, escapes, and pages without loading vectors', async () => {
  const pool = fakePool();
  const page = await createMysqlAgentMemoryRepository({ pool }).browse({
    includePersonal: true, includeRestricted: false, limit: 25, offset: 50, ownerUserId: 'user-1', projectIds: ['project-1', 'project-2'],
    query: '50%_off', sensitivities: ['internal'], sort: 'oldest', tenantId: 'tenant-1', types: ['decision', 'risk'],
  });
  assert.equal(page.total, 7);
  assert.equal(page.memories[0].embedding.model, 'test-embedding');
  assert.equal('vector' in page.memories[0].embedding, false);
  const select = pool.executed.find((entry) => entry.sql.startsWith('SELECT id, tenant_id'));
  assert.equal(select.sql.includes('embedding_vector_json'), false);
  assert.match(select.sql, /\(project_id IN \(\?,\?\) OR \(project_id IS NULL AND owner_user_id = \?\)\)/);
  assert.match(select.sql, /\(sensitivity <> 'restricted' OR created_by = \?\)/);
  assert.match(select.sql, /memory_type IN \(\?,\?\) AND sensitivity IN \(\?\) AND \(title LIKE \? OR content LIKE \?\)/);
  assert.match(select.sql, /ORDER BY source_at ASC, id LIMIT 25 OFFSET 50$/);
  assert.deepEqual(select.params, ['tenant-1', 'project-1', 'project-2', 'user-1', 'user-1', 'decision', 'risk', 'internal', '%50\\%\\_off%', '%50\\%\\_off%']);
  const count = pool.executed.find((entry) => entry.sql.startsWith('SELECT COUNT(*) AS count FROM agent_memory_items'));
  assert.deepEqual(count.params, select.params);
});

test('MySQL memory browse returns nothing when no scope is visible', async () => {
  const pool = fakePool();
  assert.deepEqual(await createMysqlAgentMemoryRepository({ pool }).browse({ includePersonal: false, includeRestricted: true, limit: 25, offset: 0, ownerUserId: 'user-1', projectIds: [], query: '', sensitivities: [], sort: 'newest', tenantId: 'tenant-1', types: [] }), { memories: [], total: 0 });
  assert.equal(pool.executed.some((entry) => entry.sql.includes('FROM agent_memory_items WHERE')), false);
});

test('MySQL memory correction is version-guarded and records the correction in provenance', async () => {
  const pool = fakePool();
  const correction = { at: '2026-07-12T00:00:00.000Z', by: 'user-1', fields: ['content'], previousContentHash: 'c'.repeat(64), previousVersion: 2 };
  const memory = await createMysqlAgentMemoryRepository({ pool }).correct({ changes: { content: 'Corrected' }, correction, embedding: null, expectedVersion: 2, id: 'memory-1', tenantId: 'tenant-1' });
  assert.equal(memory.version, 3);
  const update = pool.executed.find((entry) => entry.sql.startsWith('UPDATE agent_memory_items'));
  assert.match(update.sql, /^UPDATE agent_memory_items SET content = \?, provenance_json = \?, embedding_model = \?, embedding_dimensions = \?, embedding_vector_json = \?, embedding_content_hash = \?, embedded_at = \?, updated_at = NOW\(3\), version = version \+ 1 WHERE id = \? AND tenant_id = \? AND deleted_at IS NULL AND version = \?$/);
  assert.deepEqual(JSON.parse(update.params[1]), { corrections: [correction], sourceType: 'decision_register' });
  assert.deepEqual(update.params.slice(2), [null, null, null, null, null, 'memory-1', 'tenant-1', 2]);

  const keepEmbedding = fakePool();
  await createMysqlAgentMemoryRepository({ pool: keepEmbedding }).correct({ changes: { confidence: 0.5 }, correction, embedding: undefined, expectedVersion: 2, id: 'memory-1', tenantId: 'tenant-1' });
  assert.equal(keepEmbedding.executed.find((entry) => entry.sql.startsWith('UPDATE')).sql.includes('embedding_model'), false);

  await assert.rejects(
    createMysqlAgentMemoryRepository({ pool: fakePool({ version: 5 }) }).correct({ changes: { content: 'Late' }, correction, expectedVersion: 2, id: 'memory-1', tenantId: 'tenant-1' }),
    (error) => error.code === 'agent_memory_version_conflict' && error.actualVersion === 5,
  );
  await assert.rejects(
    createMysqlAgentMemoryRepository({ pool: fakePool({ updateAffectedRows: 0 }) }).correct({ changes: { content: 'Raced' }, correction, expectedVersion: 2, id: 'memory-1', tenantId: 'tenant-1' }),
    (error) => error.code === 'agent_memory_version_conflict' && error.actualVersion === 3,
  );
});
