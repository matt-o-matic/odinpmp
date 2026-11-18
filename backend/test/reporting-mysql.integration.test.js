import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const MIGRATIONS = ['0017_reporting_search', '0041_reporting_warehouse'];

test('MySQL reporting repository persists search, views, reports, schedules, runs, snapshots, and versions', { skip: !databaseUrl, timeout: 15_000 }, async () => {
  const pool = mysql.createPool(databaseUrl); const tenantId = randomUUID(); const repository = createMysqlReportingRepository({ pool });
  try {
    await applyMysqlMigrations(pool, MIGRATIONS);
    await repository.replaceDocuments({ documents: [{ content: 'Customer launch onboarding and delivery', documentType: 'project', facets: { status: 'active' }, projectId: 'project-1', sourceId: 'project-1', title: 'Launch delivery', updatedAt: '2026-07-11T00:00:00.000Z', url: '/projects/project-1' }], tenantId });
    const search = await repository.searchDocuments({ limit: 25, offset: 0, projectIds: ['project-1'], query: 'launch', tenantId, types: ['project'] }); assert.equal(search.total, 1); assert.equal(search.records[0].title, 'Launch delivery');
    const view = await repository.createView({ input: { columns: ['name'], filters: { status: 'active' }, name: 'Active', projectId: 'project-1', sort: [], surface: 'projects', visibility: 'private' }, ownerUserId: 'user-1', tenantId });
    const report = await repository.createReport({ input: { columns: ['projectName'], dataset: 'project', description: '', filters: {}, groupBy: [], name: 'Projects', projectId: null, status: 'active', visibility: 'tenant', visualization: 'table' }, ownerUserId: 'user-1', tenantId });
    const subscription = await repository.createSubscription({ input: { deliveryChannel: 'in_app', enabled: true, format: 'csv', nextRunAt: new Date('2026-07-11T12:00:00.000Z'), recipients: [], reportId: report.id, schedule: { intervalMinutes: 60, timezone: 'UTC' } }, ownerUserId: 'user-1', tenantId });
    const due = await repository.listDueSubscriptions({ limit: 10, now: new Date('2026-07-11T12:00:00.000Z'), tenantId }); assert.equal(due.length, 1);
    const run = await repository.createRun({ format: 'csv', parameters: {}, reportId: report.id, requestedBy: 'user-1', tenantId }); await repository.createSnapshot({ data: [{ projectName: 'Launch' }], freshness: { asOf: '2026-07-11T12:00:00.000Z' }, reportId: report.id, runId: run.id, tenantId }); const finished = await repository.finishRun({ rowCount: 1, runId: run.id, status: 'completed', tenantId }); assert.equal(finished.status, 'completed'); assert.equal(finished.rowCount, 1);
    const advanced = await repository.markSubscriptionRun({ expectedVersion: 1, lastRunAt: '2026-07-11T12:00:00.000Z', nextRunAt: '2026-07-11T13:00:00.000Z', subscriptionId: subscription.id, tenantId }); assert.equal(advanced.version, 2); assert.equal(advanced.nextRunAt, '2026-07-11T13:00:00.000Z');
    await assert.rejects(repository.updateView({ input: { expectedVersion: 99, name: 'Changed' }, tenantId, viewId: view.id }), (error) => error.statusCode === 409 && error.details.code === 'reporting_version_conflict');
    await assert.rejects(repository.deleteReport({ expectedVersion: 1, reportId: report.id, tenantId }), /subscriptions/i);
    const snapshot = await repository.listSnapshot({ tenantId }); assert.equal(snapshot.reports.length, 1); assert.equal(snapshot.runs[0].status, 'completed'); assert.equal(snapshot.snapshots[0].data[0].projectName, 'Launch');
  } finally { await pool.end(); }
});

test('MySQL reporting warehouse incrementally indexes, materializes CDC facts, invalidates cache, and fences schedules', { skip: !databaseUrl, timeout: 15_000 }, async () => {
  const pool = mysql.createPool(databaseUrl); const tenantId = randomUUID(); const repository = createMysqlReportingRepository({ pool });
  try {
    await applyMysqlMigrations(pool, MIGRATIONS);
    await repository.syncDocuments({ documents: [{ content: 'Supplier staffing threatens delivery.', documentType: 'risk', embedding: { contentHash: 'b'.repeat(64), dimensions: 2, embeddedAt: '2026-07-11T00:00:00.000Z', model: 'test', vector: [1, 0] }, facets: { impact: 'high' }, projectId: 'project-1', sourceHash: 'a'.repeat(64), sourceId: 'risk-1', title: 'Capacity exposure', updatedAt: '2026-07-11T00:00:00.000Z', url: '/risk-1' }], tenantId });
    const semantic = await repository.searchDocuments({ limit: 10, offset: 0, projectIds: ['project-1'], query: 'vendor bottleneck', queryEmbedding: { vector: [0.99, 0.01] }, tenantId, types: [] }); assert.equal(semantic.records[0].retrievalMode, 'semantic');
    const event = { createdAt: '2026-07-11T12:00:00.000Z', eventType: 'workflow.transitioned', id: randomUUID(), payload: {}, projectId: 'project-1', tenantId };
    assert.equal((await repository.captureWarehouseChange({ event })).created, true); assert.equal((await repository.captureWarehouseChange({ event })).created, false); assert.equal((await repository.materializeWarehouseChanges()).processed, 1);
    assert.equal((await repository.getReportingAnalytics({ projectIds: ['project-1'], tenantId }))[0].occurrenceCount, 1);
    await repository.writeReportingCache({ cacheKey: 'a'.repeat(64), sourceSequenceId: await repository.getWarehouseSequence({ tenantId }), tenantId, value: { ok: true } }); assert.deepEqual(await repository.readReportingCache({ cacheKey: 'a'.repeat(64), sourceSequenceId: await repository.getWarehouseSequence({ tenantId }), tenantId }), { ok: true });
    const report = await repository.createReport({ input: { columns: ['projectName'], dataset: 'project', description: '', filters: {}, groupBy: [], name: 'Projects', projectId: null, status: 'active', visibility: 'tenant', visualization: 'table' }, ownerUserId: 'user-1', tenantId });
    const subscription = await repository.createSubscription({ input: { deliveryChannel: 'in_app', enabled: true, format: 'json', nextRunAt: new Date('2026-07-11T12:00:00.000Z'), recipients: [], reportId: report.id, schedule: { intervalMinutes: 60, timezone: 'UTC' } }, ownerUserId: 'user-1', tenantId });
    const claimed = await repository.claimDueSubscriptions({ leaseMs: 1000, limit: 10, now: new Date('2026-07-11T12:00:00.000Z') }); assert.equal(claimed.length, 1); assert.equal((await repository.claimDueSubscriptions({ leaseMs: 1000, limit: 10, now: new Date('2026-07-11T12:00:00.500Z') })).length, 0);
    assert.equal(await repository.completeSubscriptionClaim({ lastRunAt: new Date('2026-07-11T12:00:00.000Z'), leaseToken: claimed[0].leaseToken, nextRunAt: new Date('2026-07-11T13:00:00.000Z'), subscriptionId: subscription.id, tenantId }), true);
  } finally { await pool.end(); }
});
