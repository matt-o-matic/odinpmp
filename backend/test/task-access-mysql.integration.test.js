import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlAccessRepository } from '../src/modules/access/access.repository.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createMysqlResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';

// The MySQL side of task access: migrations 0078-0083, access links and
// task access grants, resource emails, remaining hours, and revisions, comments and requirements
// tokens made by someone without a login.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

// Runs `run` against a fresh database built from the legacy schema plus every migration.
async function withDatabase(suffix, run) {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_${suffix}_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });
    const tenantId = randomUUID();
    const projectId = randomUUID();
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Task Access Tenant']);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Launch', '', statuses[0].id]);
    await run({ pool, projectId, tenantId });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
}

async function columnOf(pool, table, column) {
  const [rows] = await pool.execute(
    'SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength, DATA_TYPE AS dataType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column],
  );
  return rows[0] ?? null;
}

test('MySQL migrations make room for actors without a login and add task access storage', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withDatabase('access_schema', async ({ pool }) => {
    assert.equal(Number((await columnOf(pool, 'project_item_revisions', 'actor_user_id')).maxLength), 128);
    assert.equal(Number((await columnOf(pool, 'comments', 'user_id')).maxLength), 128);
    const [foreignKeys] = await pool.execute("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME IS NOT NULL");
    assert.deepEqual(foreignKeys, []);
    assert.equal((await columnOf(pool, 'tasks', 'remaining_hours')).dataType, 'decimal');
    assert.equal(Number((await columnOf(pool, 'enterprise_resources', 'email')).maxLength), 255);
    for (const table of ['access_links', 'access_link_tokens', 'project_task_access']) {
      const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
      assert.equal(Number(rows[0].count), 1, table);
    }
  });
});

test('MySQL access links, task access grants and resource emails', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withDatabase('access_links', async ({ pool, projectId, tenantId }) => {
    const access = createMysqlAccessRepository({ pool });
    const resources = createMysqlResourceFinanceRepository({ pool });
    const at = (iso) => new Date(iso);

    const first = await access.issueLinkToken({ createdBy: 'user:manager', email: 'Casey@Vendor.Example', now: at('2026-10-01T10:00:00.000Z'), purpose: 'manual', tenantId, tokenHash: 'a'.repeat(64) });
    const second = await access.issueLinkToken({ createdBy: 'user:manager', email: 'casey@vendor.example', now: at('2026-10-02T10:00:00.000Z'), purpose: 'email', tenantId, tokenHash: 'b'.repeat(64) });
    assert.deepEqual([first.linkCreated, second.linkCreated, second.link.id, second.link.email, second.link.issuedAt], [true, false, first.link.id, 'casey@vendor.example', '2026-10-02T10:00:00.000Z']);
    const found = await access.findTokenByHash({ tokenHash: 'a'.repeat(64) });
    assert.deepEqual([found.link.id, found.token.purpose, found.token.revokedAt], [first.link.id, 'manual', null]);
    await access.touchLink({ linkId: first.link.id, now: at('2026-10-03T10:00:00.000Z'), tokenId: found.token.id });
    assert.equal((await access.findLinkByEmail({ email: 'CASEY@vendor.example', tenantId })).lastUsedAt, '2026-10-03T10:00:00.000Z');
    const revoked = await access.revokeLink({ linkId: first.link.id, now: at('2026-10-04T10:00:00.000Z'), revokedBy: 'user:manager', tenantId });
    assert.equal(revoked.revokedAt, '2026-10-04T10:00:00.000Z');
    assert.equal((await access.findTokenByHash({ tokenHash: 'b'.repeat(64) })).token.revokedAt, '2026-10-04T10:00:00.000Z');
    const reissued = await access.issueLinkToken({ createdBy: 'user:manager', email: 'casey@vendor.example', now: at('2026-10-05T10:00:00.000Z'), purpose: 'manual', tenantId, tokenHash: 'c'.repeat(64) });
    assert.deepEqual([reissued.reactivated, reissued.link.revokedAt, reissued.link.issuedAt], [true, null, '2026-10-05T10:00:00.000Z']);

    const set = (scope, iso) => access.setTaskAccess({ by: 'manager', now: at(iso), projectId, resourceId: 'res-1', scope, tenantId });
    const own = await set('own', '2026-10-01T00:00:00.000Z');
    const off = await set('off', '2026-10-02T00:00:00.000Z');
    assert.deepEqual([off.id, off.scope, off.revokedAt], [own.id, 'own', '2026-10-02T00:00:00.000Z']);
    const all = await set('all', '2026-10-03T00:00:00.000Z');
    assert.deepEqual([all.id, all.scope, all.revokedAt, all.grantedAt], [own.id, 'all', null, '2026-10-03T00:00:00.000Z']);
    assert.deepEqual((await access.listTaskAccess({ resourceIds: ['res-1', 'res-2'], tenantId })).map((grant) => grant.scope), ['all']);
    assert.deepEqual(await access.listTaskAccess({ resourceIds: [], tenantId }), []);

    const casey = await resources.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: 'casey@vendor.example', location: '', minBillRate: null, name: 'Casey Contractor', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId });
    assert.equal(casey.email, 'casey@vendor.example');
    assert.deepEqual((await resources.listResourcesByEmail({ email: ' CASEY@vendor.example', tenantId })).map((resource) => resource.id), [casey.id]);
    const changed = await resources.updateResource({ input: { email: 'casey@new.example', expectedVersion: casey.version }, resourceId: casey.id, tenantId });
    assert.equal(changed.email, 'casey@new.example');
    await resources.createAllocation({ input: { allocationPercent: 50, billRate: null, endDate: '2026-12-31', hoursPerWeek: 20, origin: 'manual', projectId, resourceId: casey.id, role: '', scenario: 'baseline', startDate: '2026-01-01', status: 'active' }, tenantId });
    assert.deepEqual((await resources.listAllocationsForResources({ resourceIds: [casey.id], tenantId })).map((record) => record.projectId), [projectId]);
    await resources.createTimeEntry({ input: { billable: false, hours: 2, note: '', periodId: null, projectId, resourceId: casey.id, status: 'submitted', workDate: '2026-10-01', workItemId: 'task-1' }, tenantId });
    assert.deepEqual((await resources.listTimeEntries({ projectId, resourceId: casey.id, tenantId, workItemId: 'task-1' })).map((entry) => entry.hours), [2]);
  });
});

test('MySQL work items keep remaining hours, and revisions and comments by a resource show its name', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withDatabase('access_items', async ({ pool, projectId, tenantId }) => {
    const projects = createMysqlProjectsRepository({ pool });
    const resources = createMysqlResourceFinanceRepository({ pool });
    const manager = { id: randomUUID(), name: 'Manny Manager' };
    const resource = await resources.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', minBillRate: null, name: 'Casey Contractor', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId });
    const actor = { id: `resource:${resource.id}`, name: resource.name };

    const epic = await projects.createProjectItem({ input: { item: { name: 'Storefront', status: 'Not Started' }, itemType: 'epic', parentId: null }, projectId, tenantId, user: manager });
    const story = await projects.createProjectItem({ input: { item: { name: 'Checkout', status: 'Not Started' }, itemType: 'story', parentId: epic.item.id }, projectId, tenantId, user: manager });
    const task = await projects.createProjectItem({ input: { item: { assigneeId: actor.id, name: 'Card form', remainingHours: 5, status: 'Not Started' }, itemType: 'task', parentId: story.item.id }, projectId, tenantId, user: manager });
    assert.deepEqual([task.item.remainingHours, task.item.assigneeName], [5, 'Casey Contractor']);

    const updated = await projects.updateProjectItem({ input: { expectedVersion: 1, patch: { remainingHours: 2.25, status: 'In Progress' } }, itemId: task.item.id, projectId, tenantId, user: actor });
    assert.deepEqual([updated.item.remainingHours, updated.item.status, updated.item.version], [2.25, 'In Progress', 2]);
    const revisions = await projects.listProjectItemRevisions({ itemId: task.item.id, projectId, tenantId });
    assert.deepEqual(revisions.map((revision) => [revision.action, revision.actorUserId, revision.actorName]), [['update', actor.id, 'Casey Contractor'], ['create', manager.id, '']]);
    assert.deepEqual([revisions[0].before.node.remainingHours, revisions[0].after.node.remainingHours], [5, 2.25]);

    // A tree save that does not carry remaining hours keeps them.
    const detail = await projects.getProjectDetail({ projectId, tenantId });
    const strip = (nodes) => nodes.map(({ remainingHours: _remainingHours, stories, tasks, ...node }) => ({ ...node, ...(stories ? { stories: strip(stories) } : {}), ...(tasks ? { tasks: strip(tasks) } : {}) }));
    await projects.replaceProjectTree({ input: { epics: strip(detail.epics), expectedUpdatedAt: detail.updatedAt }, projectId, tenantId, user: manager });
    assert.equal((await projects.getProjectDetail({ projectId, tenantId })).epics[0].stories[0].tasks[0].remainingHours, 2.25);

    const comment = await projects.addComment({ comment: '<p>Started</p>', parentId: null, projectId, targetId: task.item.id, targetType: 'task', tenantId, user: actor });
    assert.deepEqual([comment.userId, comment.author.name], [actor.id, 'Casey Contractor']);
    const comments = await projects.listComments({ projectId, targetId: task.item.id, targetType: 'task', tenantId });
    assert.deepEqual(comments.map((entry) => entry.author.name), ['Casey Contractor']);
    assert.deepEqual(await projects.listSprintRows({ projectId, tenantId }), []);
    assert.equal(await projects.listSprintRows({ projectId: randomUUID(), tenantId }), null);
  });
});

test('MySQL requirements tokens minted by an access link leave the link alone and go when the access link does', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withDatabase('access_requirements', async ({ pool, projectId, tenantId }) => {
    const assistant = createMysqlAssistantRepository({ pool });
    const requirements = createMysqlRequirementsRepository({ pool });
    const stakeholder = await assistant.createProjectStakeholder({ projectId, tenantId, value: { email: 'Casey@Vendor.Example', name: 'Casey C.', roleTitle: 'Vendor lead' } });
    assert.deepEqual((await assistant.listStakeholdersByEmail({ email: 'casey@vendor.example', tenantId })).map((entry) => [entry.id, entry.projectId]), [[stakeholder.id, projectId]]);

    const issued = await requirements.issueAccessToken({ createdBy: 'user:manager', now: new Date('2026-10-01T10:00:00.000Z'), projectId, purpose: 'manual', stakeholderId: stakeholder.id, tenantId, tokenHash: 'd'.repeat(64) });
    const minted = await requirements.mintLinkToken({ createdBy: 'access-link:link-1', linkId: issued.link.id, now: new Date('2026-10-05T10:00:00.000Z'), purpose: 'access', tenantId, tokenHash: 'e'.repeat(64) });
    assert.deepEqual([minted.purpose, minted.createdBy, minted.revokedAt], ['access', 'access-link:link-1', null]);
    const link = await requirements.getAccessLink({ linkId: issued.link.id, projectId, tenantId });
    assert.equal(link.issuedAt, '2026-10-01T10:00:00.000Z');
    assert.equal(await requirements.mintLinkToken({ createdBy: 'access-link:link-1', linkId: issued.link.id, now: new Date(), purpose: 'access', tenantId: randomUUID(), tokenHash: 'f'.repeat(64) }), null);

    assert.equal(await requirements.revokeTokensCreatedBy({ createdBy: 'access-link:link-1', now: new Date('2026-10-06T10:00:00.000Z'), tenantId }), 1);
    assert.equal((await requirements.findAccessTokenByHash({ tokenHash: 'e'.repeat(64) })).token.revokedAt, '2026-10-06T10:00:00.000Z');
    assert.equal((await requirements.findAccessTokenByHash({ tokenHash: 'd'.repeat(64) })).token.revokedAt, null);
  });
});
