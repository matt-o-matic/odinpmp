import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { convertEngagementForUser, createEngagementForUser } from '../src/modules/engagements/engagements.service.js';
import { createProjectItemForUser, saveProjectTreeForUser, updateProjectItemForUser } from '../src/modules/projects/projects.service.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ensureMysqlPursuitSchema } from '../src/modules/pursuit/pursuit-schema.js';
import { movePursuitTasksForUser } from '../src/modules/pursuit/pursuit.service.js';
import { createBillingSowLinkReader, readSowLink } from '../src/modules/pursuit/sow-link.js';
import { createMysqlBillingRepository } from '../src/modules/billing/billing.repository.js';
import { createMysqlWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

// A fresh database built from the legacy schema plus every migration, dropped afterwards.
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

const task = (name, extra = {}) => ({ item: { name, status: 'Not Started', ...extra }, itemType: 'task' });

test('MySQL pursuit: the 0100 schema, the hidden Pursuit story, delivery views without pursuit work, settings, conversion and moving tasks', { skip: !databaseUrl, timeout: 560_000 }, async (t) => {
  await withDatabase('pursuit', async ({ pool }) => {
    const tenantId = randomUUID();
    const ids = { admin: randomUUID(), member: randomUUID() };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Pursuit Tenant']);
    for (const [key, id] of Object.entries(ids)) {
      await pool.execute('INSERT INTO users (id, name, email) VALUES (?, ?, ?)', [id, `User ${key}`, `${key}-${id}@example.com`]);
      await pool.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), id, tenantId, key === 'admin' ? 'admin' : 'user']);
    }
    const admin = { id: ids.admin, memberships: [{ role: 'admin', tenantId }], name: 'User admin' };
    const member = { email: 'member@example.com', id: ids.member, memberships: [{ role: 'user', tenantId }], name: 'User member' };
    const repository = createMysqlProjectsRepository({ fileStorage: { async delete() {}, async read() { return { bytes: Buffer.alloc(0), size: 0 }; }, async write() {} }, pool });
    const workspaceModulesRepository = createMysqlWorkspaceModulesRepository({ pool });
    await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId, userId: ids.admin });
    const deps = { projectRepository: repository, workspaceModulesRepository };

    await t.test('0100 adds tasks.pursuit and project_settings, and runs again unchanged; odin_replies is 0101\u2019s', async () => {
      const [columns] = await pool.execute("SELECT COLUMN_DEFAULT AS def, IS_NULLABLE AS nullable, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'pursuit'");
      assert.deepEqual(columns[0], { def: '0', nullable: 'NO', type: 'tinyint(1)' });
      const [index] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND INDEX_NAME = 'idx_tasks_project_pursuit'");
      assert.equal(index[0].cols, 'project_id,pursuit');
      const [settings] = await pool.execute("SELECT COLUMN_NAME AS name, COLUMN_DEFAULT AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_settings' AND COLUMN_NAME IN ('guests_see_board', 'odin_replies_enabled') ORDER BY COLUMN_NAME");
      assert.deepEqual(settings, [{ def: '0', name: 'guests_see_board' }, { def: '1', name: 'odin_replies_enabled' }]);
      // 0100 makes no odin_replies: the table bootstrap built has 0101's columns.
      const [replyColumns] = await pool.execute("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'odin_replies' AND COLUMN_NAME IN ('principal_type', 'requester_type')");
      assert.deepEqual(replyColumns.map((column) => column.name), ['requester_type']);
      await ensureMysqlPursuitSchema(pool);
      // 0096 made author_type a VARCHAR, which takes `odin` as it is.
      const [authorType] = await pool.execute("SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'author_type'");
      assert.deepEqual(authorType[0], { nullable: 'NO', type: 'varchar(16)' });
    });

    const { project: engagement } = await createEngagementForUser({ ...deps, input: { customer: 'Northwind', name: 'Northwind pursuit' }, user: member });
    const full = await repository.getProjectDetail({ includePursuit: true, projectId: engagement.id, tenantId });
    const pursuitStory = full.epics[0].stories[0];
    const add = (input) => createProjectItemForUser(member, engagement.id, { ...input, parentId: pursuitStory.id }, repository);

    await t.test('a new engagement has a hidden Pursuit epic and story; its tasks are pursuit work', async () => {
      assert.deepEqual([full.epics.length, full.epics[0].name, full.epics[0].pursuit, pursuitStory.name, pursuitStory.pursuit], [1, 'Pursuit', true, 'Pursuit tasks', true]);
      assert.deepEqual(await repository.ensurePursuitStory({ projectId: engagement.id, tenantId }), { epicId: full.epics[0].id, storyId: pursuitStory.id }, 'ensuring again makes nothing new');
      const created = await add(task('Kickoff deck', { assigneeId: 'resource:r-1' }));
      assert.equal(created.item.pursuit, true);
      const [rows] = await pool.execute('SELECT pursuit FROM tasks WHERE id = ?', [created.item.id]);
      assert.equal(Number(rows[0].pursuit), 1);
      assert.deepEqual((await repository.getProjectDetail({ projectId: engagement.id, tenantId })).epics, [], 'delivery views get no pursuit work');
      const board = await repository.getKanbanBoard({ filters: {}, projectId: engagement.id, scope: 'pursuit', tenantId, user: member });
      assert.deepEqual(board.cards.map((card) => [card.name, card.issueType]), [['Kickoff deck', 'task']]);
      assert.deepEqual((await repository.getKanbanBoard({ filters: {}, projectId: engagement.id, scope: 'delivery', tenantId, user: member })).cards, []);
      assert.deepEqual(await repository.listPursuitAssignments({ assigneeIds: ['resource:r-1'], tenantId }), [{ assigneeId: 'resource:r-1', projectId: engagement.id }]);
      assert.equal(await repository.reorderKanbanItem({ afterItemId: null, beforeItemId: null, itemId: created.item.id, projectId: engagement.id, scope: 'pursuit', tenantId }), true);
    });

    await t.test('settings start at their defaults and keep a version', async () => {
      assert.deepEqual(await repository.getProjectSettings({ projectId: engagement.id, tenantId }), { guestsSeeBoard: false, updatedAt: null, updatedBy: null, version: 0 });
      const saved = await repository.saveProjectSettings({ expectedVersion: 0, input: { guestsSeeBoard: true }, projectId: engagement.id, tenantId, user: member });
      assert.deepEqual([saved.guestsSeeBoard, saved.version, saved.updatedBy], [true, 1, member.id]);
      await assert.rejects(repository.saveProjectSettings({ expectedVersion: 0, input: { guestsSeeBoard: false }, projectId: engagement.id, tenantId, user: member }), (error) => error.details?.code === 'settings_version_conflict');
      assert.equal((await repository.saveProjectSettings({ expectedVersion: 1, input: { guestsSeeBoard: false }, projectId: engagement.id, tenantId, user: member })).version, 2);
    });

    const open = await add(task('Open task', { status: 'In Progress' }));
    const done = await add(task('Done task', { status: 'Completed' }));

    await t.test('converting with "Move open pursuit tasks" moves only the open ones, in the conversion\'s step', async () => {
      const result = await convertEngagementForUser({ ...deps, input: { moveOpenPursuitTasks: true }, projectId: engagement.id, user: member });
      assert.equal(result.movedPursuitTaskIds.length, 2, 'Kickoff deck and Open task are open');
      assert.ok(result.movedPursuitTaskIds.includes(open.item.id) && !result.movedPursuitTaskIds.includes(done.item.id));
      const plan = await repository.getProjectDetail({ projectId: engagement.id, tenantId });
      assert.deepEqual(plan.epics.map((epic) => [epic.name, epic.stories.map((story) => [story.name, story.tasks.map((entry) => entry.name).sort()])]), [['Pursuit handover', [['Open pursuit tasks', ['Kickoff deck', 'Open task']]]]]);
      const [rows] = await pool.execute('SELECT name, pursuit FROM tasks WHERE project_id = ? AND id IN (?, ?) ORDER BY name', [engagement.id, open.item.id, done.item.id]);
      assert.deepEqual(rows.map((row) => [row.name, Number(row.pursuit)]), [['Done task', 1], ['Open task', 0]]);
      const [revisions] = await pool.execute("SELECT JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.parentId')) AS parentId FROM project_item_revisions WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [open.item.id]);
      assert.equal(revisions[0].parentId, plan.epics[0].stories[0].id, 'the move has a revision');
    });

    await t.test('saving the plan keeps pursuit work, and a later move puts tasks under the chosen story, all or none', async () => {
      const plan = await repository.getProjectDetail({ projectId: engagement.id, tenantId });
      const saved = await saveProjectTreeForUser(admin, engagement.id, { epics: [...plan.epics, { description: '', id: randomUUID(), name: 'Build', status: 'Not Started', stories: [{ description: '', id: randomUUID(), name: 'Platform', status: 'Not Started', tasks: [] }] }], expectedUpdatedAt: plan.updatedAt }, repository);
      assert.equal(saved.project.epics.length, 2);
      const [kept] = await pool.execute('SELECT deleted FROM tasks WHERE id = ?', [done.item.id]);
      assert.equal(Number(kept[0].deleted), 0, 'the plan\'s save left the pursuit task alone');
      const story = saved.project.epics.find((epic) => epic.name === 'Build').stories[0];
      const another = await add(task('Another pursuit task'));

      await assert.rejects(movePursuitTasksForUser({ deps, input: { storyId: story.id, taskIds: [another.item.id, open.item.id] }, projectId: engagement.id, user: admin }), (error) => error.details?.code === 'not_a_pursuit_task');
      const [unmoved] = await pool.execute('SELECT parent_task_id AS parentId, pursuit FROM tasks WHERE id = ?', [another.item.id]);
      assert.deepEqual([unmoved[0].parentId, Number(unmoved[0].pursuit)], [pursuitStory.id, 1], 'a refused move moves nothing');

      const moved = await movePursuitTasksForUser({ deps, input: { storyId: story.id, taskIds: [another.item.id, done.item.id] }, projectId: engagement.id, user: admin });
      assert.deepEqual(moved.moved.map((entry) => entry.id), [another.item.id, done.item.id]);
      assert.deepEqual(moved.project.epics.find((epic) => epic.name === 'Build').stories[0].tasks.map((entry) => entry.name), ['Another pursuit task', 'Done task']);
      assert.deepEqual(moved.pursuit.epics[0].stories[0].tasks, []);
      // A task moved back under the Pursuit story becomes pursuit work again.
      const current = (await repository.getProjectDetail({ projectId: engagement.id, tenantId })).epics.find((epic) => epic.name === 'Build').stories[0].tasks[0];
      await updateProjectItemForUser(admin, engagement.id, current.id, { expectedVersion: current.version, parentId: pursuitStory.id, patch: {} }, repository);
      const [back] = await pool.execute('SELECT pursuit FROM tasks WHERE id = ?', [current.id]);
      assert.equal(Number(back[0].pursuit), 1);
    });

    await t.test('the SOW reader reads billing\u2019s project_billing_links (0099): no SOW unlinked, then the linked agreement', async () => {
      const billingRepository = createMysqlBillingRepository({ pool });
      const reader = createBillingSowLinkReader({ billingRepository });
      assert.equal(await readSowLink({ projectId: engagement.id, reader, tenantId }), null);
      const link = (agreement, sourceUpdatedAt) => ({ agreement, customer: { id: 12, name: 'Northwind' }, lineOfBusiness: null, sourceUpdatedAt });
      await billingRepository.putLink({ link: link(null, '2026-11-01T09:00:00Z'), projectId: engagement.id, tenantId });
      assert.equal(await readSowLink({ projectId: engagement.id, reader, tenantId }), null, 'a customer-level link has no SOW');
      await billingRepository.putLink({ link: link({ id: 41, link: 'https://invoice.example/sows/1', status: 'awaiting_signature', title: 'Northwind SOW' }, '2026-11-05T09:00:00Z'), projectId: engagement.id, tenantId });
      let sow = await readSowLink({ projectId: engagement.id, reader, tenantId });
      assert.deepEqual([sow.state, sow.label, sow.title, sow.url, sow.history], ['awaiting_signature', 'Awaiting signature', 'Northwind SOW', 'https://invoice.example/sows/1', []]);
      await billingRepository.putLink({ link: link({ executedAt: '2026-11-10T09:00:00Z', id: 41, status: 'executed', title: 'Northwind SOW', url: 'https://invoice.example/sows/1' }, '2026-11-10T09:00:01Z'), projectId: engagement.id, tenantId });
      sow = await readSowLink({ projectId: engagement.id, reader, tenantId });
      assert.deepEqual([sow.state, sow.label, sow.executedAt, sow.history.map((entry) => [entry.label, entry.at])], ['signed', 'Signed', '2026-11-10T09:00:00.000Z', [['Signed', '2026-11-10T09:00:00.000Z']]]);
      await billingRepository.deleteLink({ projectId: engagement.id, tenantId });
      assert.equal(await readSowLink({ projectId: engagement.id, reader, tenantId }), null);
    });

    await t.test('channel activity for the Insights cards: posts by channel since a date, deleted posts and other projects left out', async () => {
      const general = await repository.ensureGeneralChannel({ projectId: engagement.id, tenantId, userId: ids.member });
      const deal = await repository.createChannel({ name: 'Deal room', projectId: engagement.id, tenantId, user: member });
      const post = (channelId, authorId, body, projectId = engagement.id) => repository.createPost({ post: { authorId, authorType: 'user', body, projectId, targetId: channelId, targetType: 'channel', tenantId } });
      await post(general.id, ids.member, 'Kickoff');
      await post(deal.id, ids.admin, 'Pricing');
      const gone = await post(deal.id, ids.admin, 'Oops');
      await repository.deletePost({ postId: gone.id, tenantId, user: admin });
      // Day-sized bounds: like insights history, the bound is passed as a JS date and the posts
      // carry the database clock, which agree on prod (both UTC) but not on every dev machine.
      const DAY = 86_400_000;
      const since = new Date(Date.now() - DAY).toISOString();
      const activity = await repository.listChannelPostActivity({ projectId: engagement.id, since, tenantId });
      assert.deepEqual(activity.map((entry) => [entry.channelName, entry.actorId, entry.actorType]).sort(), [['Deal room', ids.admin, 'user'], ['General', ids.member, 'user']]);
      assert.ok(activity.every((entry) => Number.isFinite(Date.parse(entry.at))));
      assert.deepEqual(await repository.listChannelPostActivity({ projectId: engagement.id, since: new Date(Date.now() + DAY).toISOString(), tenantId }), [], 'nothing after the date');
    });
  });
});
