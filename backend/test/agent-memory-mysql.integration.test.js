import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlAgentMemoryRepository } from '../src/modules/memory/agent-memory.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
test('MySQL agent memory persists provenance, filters projects, and forgets records', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await applyMysqlMigrations(pool, ['0011_agent_memory', '0013_agent_memory_governance', '0030_agent_memory_semantic']);
    const repository = createMysqlAgentMemoryRepository({ pool });
    const item = await repository.create({ confidence: 0.8, content: 'Vendor fallback decision evidence', createdBy: 'user-1', embedding: { contentHash: 'a'.repeat(64), dimensions: 2, embeddedAt: '2026-07-11T12:00:00.000Z', model: 'test-embedding', vector: [1, 0] }, freshnessAt: new Date('2026-01-01T00:00:00Z'), memoryType: 'decision', ownerUserId: 'user-1', projectId: 'project-1', provenance: { contentHash: 'sha256:test', sourceId: 'decision-1', sourceType: 'decision_register' }, sensitivity: 'internal', sourceAt: new Date('2026-07-11T12:00:00Z'), tenantId: 'tenant-1', title: 'Vendor fallback' });
    assert.equal(item.provenance.sourceId, 'decision-1');
    const found = await repository.search({ limit: 10, ownerUserId: 'user-1', projectIds: ['project-1'], query: 'vendor', tenantId: 'tenant-1', types: [] });
    assert.equal(found.length, 1);
    assert.equal(found[0].isStale, true);
    const semantic = await repository.search({ limit: 10, ownerUserId: 'user-1', projectIds: ['project-1'], query: 'continuity', queryEmbedding: { vector: [1, 0] }, tenantId: 'tenant-1', types: [] });
    assert.equal(semantic[0].retrievalMode, 'semantic');
    assert.equal((await repository.search({ limit: 10, ownerUserId: 'user-2', projectIds: ['project-2'], query: 'vendor', tenantId: 'tenant-1', types: [] })).length, 0);
    await repository.forget({ expectedVersion: 1, id: item.id, tenantId: 'tenant-1' });
    const [forgottenRows] = await pool.execute('SELECT embedding_vector_json FROM agent_memory_items WHERE id = ?', [item.id]);
    assert.equal(forgottenRows[0].embedding_vector_json, null);
    assert.equal((await repository.search({ limit: 10, ownerUserId: 'user-1', projectIds: ['project-1'], query: 'vendor', tenantId: 'tenant-1', types: [] })).length, 0);

    const retained = await repository.create({ confidence: 1, content: 'Legal hold retention evidence', createdBy: 'user-1', memoryType: 'fact', ownerUserId: 'user-1', projectId: 'project-1', provenance: { sourceId: 'case-1', sourceType: 'legal_case' }, sensitivity: 'restricted', sourceAt: new Date('2026-01-01T00:00:00Z'), tenantId: 'tenant-1', title: 'Held evidence' });
    await repository.updateGovernance({ expectedVersion: 1, expiresAt: new Date('2026-01-02T00:00:00Z'), id: retained.id, legalHold: true, retentionPolicyId: 'case-1', tenantId: 'tenant-1' });
    assert.equal((await repository.search({ limit: 10, ownerUserId: 'user-1', projectIds: ['project-1'], query: 'held', tenantId: 'tenant-1', types: [] })).length, 1);
    assert.equal(await repository.purgeExpired({ cutoffAt: new Date('2026-07-11T00:00:00Z'), tenantId: 'tenant-1' }), 0);
    await repository.updateGovernance({ expectedVersion: 2, id: retained.id, legalHold: false, tenantId: 'tenant-1' });
    assert.equal(await repository.purgeExpired({ cutoffAt: new Date('2026-07-11T00:00:00Z'), tenantId: 'tenant-1' }), 1);
    assert.equal((await repository.search({ limit: 10, ownerUserId: 'user-1', projectIds: ['project-1'], query: 'held', tenantId: 'tenant-1', types: [] })).length, 0);

    const browsed = await repository.create({ confidence: 0.7, content: 'Release train runs every second Tuesday', createdBy: 'user-1', memoryType: 'fact', ownerUserId: 'user-1', projectId: 'project-1', provenance: { sourceType: 'human' }, sensitivity: 'internal', sourceAt: new Date('2026-07-12T00:00:00Z'), tenantId: 'tenant-1', title: 'Release cadence' });
    const page = await repository.browse({ includePersonal: true, includeRestricted: false, limit: 10, offset: 0, ownerUserId: 'user-1', projectIds: ['project-1'], query: 'tuesday', sensitivities: [], sort: 'newest', tenantId: 'tenant-1', types: ['fact'] });
    assert.deepEqual(page.memories.map((memory) => memory.id), [browsed.id]);
    assert.equal(page.total, 1);
    const corrected = await repository.correct({ changes: { content: 'Release train runs every Wednesday' }, correction: { at: new Date().toISOString(), by: 'user-1', fields: ['content'], previousContentHash: 'x', previousVersion: 1 }, embedding: null, expectedVersion: 1, id: browsed.id, tenantId: 'tenant-1' });
    assert.equal(corrected.version, 2);
    assert.equal(corrected.provenance.corrections.length, 1);
  } finally { await pool.end(); }
});
