import assert from 'node:assert/strict';
import test from 'node:test';

import { createMysqlReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { ensureSearchIndexFresh } from '../src/modules/reporting/search-index-freshness.js';

function fakeRepository(indexedAt = null) {
  return { indexedAt, reads: 0, async getSearchIndexFreshness() { this.reads += 1; return this.indexedAt; } };
}

test('a missing or old index is rebuilt and concurrent searches share one rebuild', async () => {
  const repository = fakeRepository(); let refreshes = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const refresh = async () => { refreshes += 1; await gate; repository.indexedAt = new Date().toISOString(); };
  const first = ensureSearchIndexFresh({ maxAgeMs: 60_000, refresh, repository, tenantId: 'tenant-1' });
  const second = ensureSearchIndexFresh({ maxAgeMs: 60_000, refresh, repository, tenantId: 'tenant-1' });
  release();
  assert.deepEqual(await first, { refreshed: true, status: 'refreshed' });
  assert.deepEqual(await second, { refreshed: true, status: 'refreshed' });
  assert.equal(refreshes, 1);
  assert.deepEqual(await ensureSearchIndexFresh({ maxAgeMs: 60_000, refresh, repository, tenantId: 'tenant-1' }), { refreshed: false, status: 'recently-attempted' });
  assert.equal(refreshes, 1); assert.equal(repository.reads, 1);
});

test('an index younger than the maximum age is left alone', async () => {
  const repository = fakeRepository(new Date(Date.now() - 1_000).toISOString()); let refreshes = 0;
  const result = await ensureSearchIndexFresh({ maxAgeMs: 60_000, refresh: async () => { refreshes += 1; }, repository, tenantId: 'tenant-1' });
  assert.deepEqual(result, { refreshed: false, status: 'fresh' }); assert.equal(refreshes, 0);
});

test('tenants are tracked separately', async () => {
  const repository = fakeRepository(); const refreshed = [];
  await ensureSearchIndexFresh({ maxAgeMs: 60_000, refresh: async () => { refreshed.push('a'); }, repository, tenantId: 'tenant-a' });
  await ensureSearchIndexFresh({ maxAgeMs: 60_000, refresh: async () => { refreshed.push('b'); }, repository, tenantId: 'tenant-b' });
  assert.deepEqual(refreshed, ['a', 'b']);
});

test('a failed rebuild serves the existing index and is not retried until the age elapses', async () => {
  const repository = fakeRepository(new Date(Date.now() - 120_000).toISOString()); let clock = Date.now(); let attempts = 0;
  const refresh = async () => { attempts += 1; throw new Error('source unavailable'); };
  const now = () => clock;
  assert.deepEqual(await ensureSearchIndexFresh({ maxAgeMs: 60_000, now, refresh, repository, tenantId: 'tenant-1' }), { refreshed: false, status: 'stale' });
  assert.deepEqual(await ensureSearchIndexFresh({ maxAgeMs: 60_000, now, refresh, repository, tenantId: 'tenant-1' }), { refreshed: false, status: 'recently-attempted' });
  assert.equal(attempts, 1);
  clock += 61_000;
  await ensureSearchIndexFresh({ maxAgeMs: 60_000, now, refresh, repository, tenantId: 'tenant-1' });
  assert.equal(attempts, 2);
});

test('a zero maximum age or a repository without freshness support disables search-time rebuilds', async () => {
  let refreshes = 0; const refresh = async () => { refreshes += 1; };
  assert.equal((await ensureSearchIndexFresh({ maxAgeMs: 0, refresh, repository: fakeRepository(), tenantId: 'tenant-1' })).status, 'disabled');
  assert.equal((await ensureSearchIndexFresh({ refresh, repository: {}, tenantId: 'tenant-1' })).status, 'disabled');
  assert.equal(refreshes, 0);
});

test('the MySQL repository reads index freshness as the newest indexed_at for the tenant', async () => {
  const statements = [];
  const pool = { async execute(sql, params = []) { statements.push(sql); if (/MAX\(indexed_at\)/.test(sql)) return [[{ indexed_at: params[0] === 'tenant-1' ? new Date('2026-10-09T12:00:00.000Z') : null }]]; return [[]]; } };
  const repository = createMysqlReportingRepository({ pool });
  assert.equal(await repository.getSearchIndexFreshness({ tenantId: 'tenant-1' }), '2026-10-09T12:00:00.000Z');
  assert.equal(await repository.getSearchIndexFreshness({ tenantId: 'tenant-2' }), null);
  assert.match(statements.find((sql) => /MAX\(indexed_at\)/.test(sql)), /FROM search_documents WHERE tenant_id = \?/);
});
