import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { convertEngagementForUser } from '../src/modules/engagements/engagements.service.js';
import { createMysqlMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { getContributorLeaderboardForUser } from '../src/modules/metrics/metrics.service.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlRankingRepository } from '../src/modules/ranking/ranking.repository.js';
import { createMysqlWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { createMysqlWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

// A fresh database built from the legacy schema plus every migration, dropped afterwards. It takes
// the legacy tables' collation, as the file vault tests do, so file listings can join them.
async function withDatabase(suffix, run) {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_${suffix}_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });
    await run({ pool });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
}

const storyFlow = {
  description: 'Story delivery', itemTypes: ['story', 'task'],
  states: [{ category: 'backlog', initial: true, key: 'ready', label: 'Ready' }, { category: 'done', key: 'done', label: 'Done', terminal: true }],
  transitions: [{ fromState: 'ready', key: 'finish', toState: 'done' }],
};
const outline = { epics: [{ description: 'Kickoff work', name: 'Kickoff', points: null, stories: [{ name: 'Plan the kickoff', points: 3, tasks: [{ name: 'Book the room', points: 1 }] }] }] };

test('MySQL engagements: the 0095 schema, module switch, delivery-view filters, conversion with a template, and lost and reopen', { skip: !databaseUrl, timeout: 560_000 }, async (t) => {
  await withDatabase('engage', async ({ pool }) => {
    const tenantId = randomUUID();
    const ids = { admin: randomUUID(), member: randomUUID(), outsider: randomUUID() };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Engagements Tenant']);
    for (const [key, id] of Object.entries(ids)) {
      await pool.execute('INSERT INTO users (id, name, email) VALUES (?, ?, ?)', [id, `User ${key}`, `${key}-${id}@example.com`]);
      await pool.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), id, tenantId, key === 'admin' ? 'admin' : 'user']);
    }
    const admin = { id: ids.admin, memberships: [{ role: 'admin', tenantId }] };
    const member = { email: 'member@example.com', id: ids.member, memberships: [{ role: 'user', tenantId }], name: 'User member' };
    const outsider = { id: ids.outsider, memberships: [{ role: 'user', tenantId }] };
    const stored = new Map();
    const repository = createMysqlProjectsRepository({
      fileStorage: { async delete(key) { stored.delete(key); }, async read(key) { const bytes = stored.get(key) ?? Buffer.alloc(0); return { bytes, size: bytes.length }; }, async write(key, bytes) { stored.set(key, bytes); } },
      pool,
    });
    const modules = createMysqlWorkspaceModulesRepository({ pool });
    const workflowRepository = createMysqlWorkflowRepository({ pool });

    const delivery = await repository.createProject({ input: { description: '', endDate: null, name: 'Delivery launch', startDate: null, status: 'In Progress' }, tenantId, user: member });

    await t.test('0095 adds the kind and engagement columns, the index and tenant_modules; existing projects are delivery', async () => {
      const [columns] = await pool.execute("SELECT COLUMN_NAME AS name, COLUMN_DEFAULT AS def, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND COLUMN_NAME IN ('kind', 'engagement_status', 'engagement_customer', 'engagement_owner_id', 'converted_at', 'converted_by', 'closed_at') ORDER BY COLUMN_NAME");
      assert.equal(columns.length, 7);
      assert.deepEqual(columns.find((column) => column.name === 'kind'), { def: 'delivery', name: 'kind', nullable: 'NO' });
      const [index] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND INDEX_NAME = 'idx_projects_tenant_kind'");
      assert.equal(index[0].cols, 'tenant_id,kind');
      const [keys] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS cols FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_modules' AND CONSTRAINT_NAME = 'PRIMARY'");
      assert.equal(keys[0].cols, 'tenant_id,module_key');
      assert.equal((await repository.getProjectDetail({ projectId: delivery.id, tenantId })).kind, 'delivery');
    });

    await t.test('module switches are off by default and version-checked', async () => {
      assert.deepEqual(await modules.getModule({ moduleKey: 'consulting', tenantId }), { enabled: false, moduleKey: 'consulting', tenantId, updatedAt: null, updatedBy: null, version: 0 });
      const on = await modules.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId, userId: ids.admin });
      assert.equal(on.enabled, true);
      assert.equal(on.version, 1);
      await assert.rejects(modules.setModule({ enabled: false, expectedVersion: 0, moduleKey: 'consulting', tenantId, userId: ids.admin }), (error) => error.details?.code === 'module_version_conflict');
      const race = await Promise.allSettled([1, 1].map(() => modules.setModule({ enabled: true, expectedVersion: 1, moduleKey: 'consulting', tenantId, userId: ids.admin })));
      assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1, 'one of two concurrent switches wins');
      assert.equal((await modules.getModule({ moduleKey: 'consulting', tenantId })).version, 2);
    });

    const engagement = await repository.createEngagement({ input: { customer: 'Northwind', name: 'Northwind pursuit' }, tenantId, user: member });

    await t.test('an engagement is created with its creator as project admin, and lists only for its members and moderators', async () => {
      assert.equal(engagement.kind, 'engagement');
      assert.equal(engagement.engagementStatus, 'open');
      assert.equal(engagement.engagementCustomer, 'Northwind');
      assert.equal(engagement.engagementOwnerId, ids.member);
      assert.equal(engagement.status, 'Planned');
      assert.equal((await repository.getProjectAccess({ projectId: engagement.id, tenantId, userId: ids.member })).projectRole, 'admin');
      assert.deepEqual(await repository.getProjectKind({ projectId: engagement.id }), { engagementOwnerId: ids.member, engagementStatus: 'open', kind: 'engagement', name: engagement.name, tenantId });
      const listed = await repository.listEngagements({ tenantId, user: member });
      assert.deepEqual(listed.map((row) => [row.id, row.customer, row.ownerName, row.status, row.role]), [[engagement.id, 'Northwind', 'User member', 'open', 'admin']]);
      assert.ok(listed[0].lastActivityAt);
      assert.equal((await repository.listEngagements({ tenantId, user: admin })).length, 1);
      assert.deepEqual(await repository.listEngagements({ tenantId, user: outsider }), []);
      assert.equal(await repository.countOpenEngagements({ tenantId }), 1);
      const [log] = await pool.execute('SELECT entity_type AS entityType, action FROM project_change_log WHERE project_id = ?', [engagement.id]);
      assert.deepEqual(log.map((row) => [row.entityType, row.action]), [['engagement', 'create']]);
    });

    await t.test('delivery views leave the engagement out', async () => {
      await repository.createProjectItem({ input: { item: { name: 'Engagement ticket' }, itemType: 'ticket', parentId: null }, projectId: engagement.id, tenantId, user: member });
      await repository.createProjectItem({ input: { item: { name: 'Delivery ticket' }, itemType: 'ticket', parentId: null }, projectId: delivery.id, tenantId, user: member });
      for (const user of [admin, member]) {
        assert.deepEqual((await repository.listProjectsForTenant({ tenantId, user })).map((project) => [project.id, project.kind]), [[delivery.id, 'delivery']], 'projects list');
        assert.deepEqual((await repository.listProjectsForTenant({ includeEngagements: true, tenantId, user })).map((project) => project.kind).sort(), ['delivery', 'engagement']);
      }
      assert.deepEqual((await repository.listTickets({ tenantId, user: admin })).tickets.map((ticket) => ticket.name), ['Delivery ticket'], 'tenant ticket board');

      const ranking = createMysqlRankingRepository({ pool });
      assert.deepEqual((await ranking.getLeaderboard({ tenantId })).map((row) => row.id), [delivery.id], 'ranking');
      assert.equal(await ranking.getProjectHeadToHead({ projectId: engagement.id, tenantId }), null, 'ranking head-to-head');

      const metrics = createMysqlMetricsRepository({ pool });
      await metrics.record({ pointsCompleted: 40, projectId: engagement.id, tasksCompleted: 4, tenantId, userId: ids.outsider });
      await metrics.record({ pointsCompleted: 5, projectId: delivery.id, tasksCompleted: 1, tenantId, userId: ids.member });
      const leaderboard = await getContributorLeaderboardForUser(admin, { days: 30 }, metrics, null, repository);
      assert.deepEqual(leaderboard.leaderboard.map((row) => [row.id, row.points]), [[ids.member, 5]], 'leaderboard');
      assert.deepEqual(await repository.listEngagementProjectIds({ tenantId }), [engagement.id]);
    });

    const workflowTemplate = await workflowRepository.createTemplate({ input: { description: '', kind: 'workflow', name: 'Story flow', payload: storyFlow, status: 'active' }, tenantId });
    const projectTemplate = await workflowRepository.createTemplate({
      input: {
        description: '', kind: 'project', name: 'Consulting delivery', status: 'active',
        payload: {
          customFields: [{ fieldType: 'enum', name: 'Billing type', options: ['Fixed', 'T&M'], scope: 'story' }],
          outline,
          workflowBindings: [{ itemType: 'story', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' }, { itemType: 'task', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' }],
        },
      },
      tenantId,
    });
    await repository.saveFile({ fileContentsBase64: Buffer.from('proposal').toString('base64'), fileDescription: '', fileName: 'proposal.txt', fileType: 'text/plain', projectId: engagement.id, targetId: engagement.id, targetType: 'project', tenantId, user: member });
    const deps = { projectRepository: repository, workspaceModulesRepository: modules };

    await t.test('a failing template step or conversion step leaves the engagement open and unchanged', async () => {
      const before = await repository.getProjectDetail({ projectId: engagement.id, tenantId });
      const snapshotBefore = await workflowRepository.listSnapshot({ tenantId });
      const failingFields = { ...workflowRepository, async createCustomField() { throw new Error('forced custom field failure'); } };
      await assert.rejects(convertEngagementForUser({ ...deps, input: { templateId: projectTemplate.id }, projectId: engagement.id, user: member, workflowRepository: failingFields }), /forced custom field failure/);
      await assert.rejects(convertEngagementForUser({ ...deps, beforeCommit: async () => { throw new Error('forced guest step failure'); }, input: { templateId: projectTemplate.id }, projectId: engagement.id, user: member, workflowRepository }), /forced guest step failure/);

      const after = await repository.getProjectDetail({ projectId: engagement.id, tenantId });
      assert.equal(after.kind, 'engagement');
      assert.equal(after.engagementStatus, 'open');
      assert.equal(after.status, before.status);
      assert.deepEqual(after.epics, [], 'the seeded outline is removed again');
      const snapshot = await workflowRepository.listSnapshot({ tenantId });
      assert.equal(snapshot.workflows.length, snapshotBefore.workflows.length);
      assert.equal(snapshot.customFields.length, snapshotBefore.customFields.length);
      assert.deepEqual(snapshot.bindings.filter((binding) => binding.projectId === engagement.id), []);
      const [log] = await pool.execute("SELECT action FROM project_change_log WHERE project_id = ? AND entity_type = 'engagement'", [engagement.id]);
      assert.deepEqual(log.map((row) => row.action), ['create'], 'no conversion is logged');
    });

    await t.test('conversion keeps the id, files and people and applies the template in one step', async () => {
      const result = await convertEngagementForUser({ ...deps, input: { templateId: projectTemplate.id }, projectId: engagement.id, user: member, workflowRepository });
      const project = result.project;
      assert.equal(project.id, engagement.id);
      assert.equal(project.kind, 'delivery');
      assert.equal(project.engagementStatus, 'won');
      assert.equal(project.status, 'Planned');
      assert.equal(project.convertedBy, ids.member);
      assert.ok(project.convertedAt);
      assert.equal(project.epics[0].name, 'Kickoff');
      assert.deepEqual((await repository.listFiles({ projectId: engagement.id, targetId: engagement.id, targetType: 'project', tenantId })).map((file) => file.fileName), ['proposal.txt']);
      assert.equal((await repository.getProjectAccess({ projectId: engagement.id, tenantId, userId: ids.member })).projectRole, 'admin');
      assert.ok((await repository.listProjectsForTenant({ tenantId, user: admin })).some((entry) => entry.id === engagement.id), 'now in delivery views');
      const snapshot = await workflowRepository.listSnapshot({ tenantId });
      assert.deepEqual(snapshot.bindings.filter((binding) => binding.projectId === engagement.id).map((binding) => binding.itemType).sort(), ['story', 'task', 'ticket']);
      await assert.rejects(repository.convertEngagement({ projectId: engagement.id, tenantId, user: member }), (error) => error.details?.code === 'not_an_engagement');
    });

    await t.test('lost and reopen', async () => {
      const second = await repository.createEngagement({ input: { customer: 'Fabrikam', name: 'Fabrikam pursuit' }, tenantId, user: member });
      const lost = await repository.closeEngagement({ projectId: second.id, tenantId, user: member });
      assert.equal(lost.engagementStatus, 'lost');
      assert.equal(lost.status, 'Archived');
      assert.ok(lost.closedAt);
      assert.deepEqual(await repository.getProjectKind({ projectId: second.id }), { engagementOwnerId: ids.member, engagementStatus: 'lost', kind: 'engagement', name: second.name, tenantId });
      await assert.rejects(repository.closeEngagement({ projectId: second.id, tenantId, user: member }), (error) => error.details?.code === 'engagement_not_open');
      const reopened = await repository.reopenEngagement({ projectId: second.id, tenantId, user: member });
      assert.equal(reopened.engagementStatus, 'open');
      assert.equal(reopened.closedAt, null);
      assert.equal(reopened.status, 'Planned');
      const [log] = await pool.execute("SELECT action, JSON_UNQUOTE(JSON_EXTRACT(detail_json, '$.status')) AS status FROM project_change_log WHERE project_id = ? AND entity_type = 'engagement' ORDER BY seq", [second.id]);
      assert.deepEqual(log.map((row) => [row.action, row.status]), [['create', 'open'], ['close', 'lost'], ['reopen', 'open']]);
      const statuses = (await repository.listEngagements({ tenantId, user: admin })).map((row) => [row.name, row.status]).sort();
      assert.deepEqual(statuses, [['Fabrikam pursuit', 'open'], ['Northwind pursuit', 'won']]);
    });
  });
});
