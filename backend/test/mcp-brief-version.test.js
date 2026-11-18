import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryAssistantRepository, createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

const scope = { projectId: 'fixture-project', tenantId: 'fixture-tenant' };
const conflict = (error) => error.statusCode === 409 && error.details.code === 'brief_version_conflict';

test('Brief saves serialize initial writes, advance versions with a fixed clock, and preserve unrelated state', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T12:00:00.000Z') });
  const repository = createInMemoryAssistantRepository();
  const patch = (expectedUpdatedAt, values) => repository.saveProjectAssistantState({ ...scope, briefUpdate: { expectedUpdatedAt, patch: values } });
  const race = await Promise.allSettled([patch(null, { objective: 'A' }), patch(null, { objective: 'B' })]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter(result => result.status === 'rejected' && conflict(result.reason)).length, 1);
  const initial = race.find(result => result.status === 'fulfilled').value;
  const next = await patch(initial.updatedAt.replace('12:00:00.000Z', '08:00:00.000-04:00'), { constraints: ['C'] });
  assert.ok(Date.parse(next.updatedAt) > Date.parse(initial.updatedAt));
  assert.equal(next.brief.objective, initial.brief.objective);
  const artifactSave = await repository.saveProjectAssistantState({ ...scope, value: { artifacts: [{ id: 'artifact' }] } });
  assert.deepEqual(artifactSave.brief, next.brief);
  assert.ok(Date.parse(artifactSave.updatedAt) > Date.parse(next.updatedAt));
  await assert.rejects(patch(next.updatedAt, { objective: 'stale' }), conflict);
  const updated = await patch(artifactSave.updatedAt, { objective: '', constraints: [] });
  assert.deepEqual(updated.artifacts, artifactSave.artifacts);
  assert.deepEqual(updated.brief, {});
  await assert.rejects(patch(null, { objective: 'still stale despite empty brief' }), conflict);
  assert.deepEqual((await repository.getProjectAssistantState(scope)).artifacts, [{ id: 'artifact' }]);
});

test('Brief route grants allow only versioned patches with write scope and the selected project', () => {
  const path = `/api/projects/${scope.projectId}/assistant-brief`;
  const grant = { scopes: ['projects.read', 'projects.write'], projectIds: [scope.projectId] };
  const check = (method, originalUrl = path, value = grant) => requireMcpRouteAccess({ method, originalUrl }, value);
  assert.doesNotThrow(() => check('PATCH'));
  for (const method of ['GET', 'PUT', 'POST', 'DELETE']) assert.throws(() => check(method), error => error.statusCode === 403);
  assert.throws(() => check('PATCH', path, { ...grant, scopes: ['projects.read'] }), error => error.statusCode === 403);
  assert.throws(() => check('PATCH', '/api/projects/other/assistant-brief'), error => error.statusCode === 404);
  for (const suffix of ['/stakeholders', '/permissions', '/assistant-brief/other']) assert.throws(() => check('PATCH', `/api/projects/${scope.projectId}${suffix}`), error => error.statusCode === 403);
});

test('MySQL Brief conflict rolls back while holding the tenant-scoped project lock before reading state', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM projects')) return [[{ id: scope.projectId }]];
      if (sql.includes('SELECT value')) return [[{ value: JSON.stringify({ brief: { objective: 'Retain' }, updatedAt: '2026-10-01T12:00:00.000Z' }) }]];
      throw new Error('A conflicting patch must not write.');
    },
  };
  const repository = createMysqlAssistantRepository({ pool: { async getConnection() { return connection; } } });
  await assert.rejects(repository.saveProjectAssistantState({ ...scope, briefUpdate: { expectedUpdatedAt: null, patch: { objective: 'Stale' } } }), conflict);
  assert.equal(calls[0], 'begin');
  assert.match(calls[1].sql, /FROM projects WHERE id = \? AND tenant_id = \? FOR UPDATE/);
  assert.deepEqual(calls[1].params, [scope.projectId, scope.tenantId]);
  assert.match(calls[2].sql, /SELECT value/);
  assert.deepEqual(calls.slice(3), ['rollback', 'release']);
});

test('MySQL Brief patch commits on the locked connection and preserves provenance and artifacts', async () => {
  const calls = [];
  const existing = { brief: { objective: 'Retain', narrative: 'Original', sourceSessionId: 'fixture-session' }, artifacts: [{ id: 'artifact' }], updatedAt: '2026-10-01T12:00:00.000Z' };
  let stored;
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
    async execute(sql, params) {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('FROM projects')) return [[{ id: scope.projectId }]];
      if (sql.includes('SELECT value')) return [[{ value: JSON.stringify(existing) }]];
      if (sql.includes('SELECT id') && sql.includes('FROM preferences')) return [[{ id: 'preference' }]];
      if (sql.startsWith('UPDATE preferences')) { stored = JSON.parse(params[0]); return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected write SQL: ${sql}`);
    },
  };
  const pool = {
    async getConnection() { return connection; },
    async execute(sql) {
      assert.deepEqual(calls.slice(-2), ['commit', 'release']);
      assert.match(sql.trim(), /^SELECT/);
      assert.doesNotMatch(sql, /FROM preferences/);
      if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [[{ columnName: 'tenant_id' }, { columnName: 'project_id' }, { columnName: 'id' }]];
      if (sql.includes('information_schema')) return [[{ count: 1 }]];
      return [[]];
    },
  };
  const repository = createMysqlAssistantRepository({ pool });
  const saved = await repository.saveProjectAssistantState({ ...scope, briefUpdate: { expectedUpdatedAt: existing.updatedAt, patch: { requirements: ['New'] } } });
  assert.deepEqual(saved.brief.requirements, ['New']);
  assert.equal(saved.brief.objective, existing.brief.objective);
  assert.equal(saved.brief.narrative, existing.brief.narrative);
  assert.equal(saved.brief.sourceSessionId, existing.brief.sourceSessionId);
  assert.deepEqual(saved.artifacts, existing.artifacts);
  assert.equal(saved.updatedAt, stored.updatedAt);
  assert.ok(Date.parse(saved.updatedAt) > Date.parse(existing.updatedAt));
  assert.deepEqual(calls, ['begin', 'SELECT id FROM', 'SELECT value FROM', 'SELECT id FROM', 'UPDATE preferences SET', 'commit', 'release']);
});
