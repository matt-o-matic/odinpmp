import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createAuditWriter } from '../src/lib/audit/audit-writer.js';
import { HttpError } from '../src/lib/errors/http-error.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ticketReviewFingerprint } from '../src/modules/projects/ticket-review-classifier.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

// Runs `run` against a fresh database built from the legacy schema plus every migration.
async function withProjectDatabase(suffix, run) {
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
    const userId = randomUUID();
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Item Versioning Tenant']);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Versioned Items', '', statuses[0].id]);
    await run({ pool, projectId, repository: createMysqlProjectsRepository({ pool }), tenantId, userId });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
}

test('MySQL Brief patches serialize initial and existing saves and retain assistant artifacts', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withProjectDatabase('brief', async ({ pool, projectId, tenantId }) => {
    const repository = createMysqlAssistantRepository({ pool });
    const scope = { projectId, tenantId };
    const patch = (expectedUpdatedAt, objective) => repository.saveProjectAssistantState({ ...scope, briefUpdate: { expectedUpdatedAt, patch: { objective } } });
    for (const expectedUpdatedAt of [null, 'current']) {
      const version = expectedUpdatedAt === 'current' ? (await repository.getProjectAssistantState(scope)).updatedAt : null;
      const results = await Promise.allSettled([patch(version, 'A'), patch(version, 'B')]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected' && result.reason.details?.code === 'brief_version_conflict').length, 1);
    }
    const before = await repository.getProjectAssistantState(scope);
    const artifacts = await repository.saveProjectAssistantState({ ...scope, value: { artifacts: [{ id: 'fixture-artifact' }] } });
    assert.deepEqual(artifacts.brief, before.brief);
    await assert.rejects(patch(before.updatedAt, 'Stale'), error => error.statusCode === 409);
    const after = await patch(artifacts.updatedAt, 'Updated');
    assert.deepEqual(after.artifacts, artifacts.artifacts);
    const [rows] = await pool.execute('SELECT id FROM preferences WHERE tenant_id = ? AND project_id = ? AND `key` = ?', [tenantId, projectId, 'assistant_project_state']);
    assert.equal(rows.length, 1);
  });
});

test('MySQL project item writes enforce versions and restore immutable revisions', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withProjectDatabase('items', async ({ pool, projectId, repository, tenantId, userId }) => {
    const created = await repository.createProjectItem({
      input: { item: { description: 'Initial scope', name: 'Versioned epic', status: 'Not Started' }, itemType: 'epic', parentId: null },
      projectId, tenantId, user: { id: userId },
    });
    assert.equal(created.item.version, 1);

    const metadata = { description: 'Local metadata fixture', endDate: null, expectedUpdatedAt: created.project.updatedAt, name: 'Maintained project', startDate: null, status: 'Planned' };
    const maintained = await repository.updateProject({ input: metadata, projectId, tenantId, user: { id: userId } });
    assert.equal(maintained.name, 'Maintained project');
    assert.ok(Date.parse(maintained.updatedAt) > Date.parse(created.project.updatedAt));
    await assert.rejects(repository.updateProject({ input: metadata, projectId, tenantId, user: { id: userId } }), (error) => error?.details?.code === 'project_version_conflict');
    const metadataRace = await Promise.allSettled([
      repository.updateProject({ input: { ...metadata, expectedUpdatedAt: maintained.updatedAt, name: 'Concurrent metadata A' }, projectId, tenantId, user: { id: userId } }),
      repository.updateProject({ input: { ...metadata, expectedUpdatedAt: maintained.updatedAt, name: 'Concurrent metadata B' }, projectId, tenantId, user: { id: userId } }),
    ]);
    assert.equal(metadataRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(metadataRace.filter((result) => result.status === 'rejected' && result.reason?.details?.code === 'project_version_conflict').length, 1);

    await pool.execute('UPDATE projects SET updated_at = NULL WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);
    const updated = await repository.updateProjectItem({
      input: { expectedVersion: 1, patch: { name: 'Updated epic', status: 'In Progress' } },
      itemId: created.item.id, projectId, tenantId, user: { id: userId },
    });
    assert.equal(updated.item.version, 2);
    assert.ok(updated.project.updatedAt && Number.isFinite(Date.parse(updated.project.updatedAt)));
    assert.equal(updated.item.name, 'Updated epic');
    await assert.rejects(
      () => repository.updateProjectItem({ input: { expectedVersion: 1, patch: { name: 'Stale' } }, itemId: created.item.id, projectId, tenantId, user: { id: userId } }),
      (error) => error?.statusCode === 409 && error?.details?.code === 'project_item_version_conflict',
    );

    const revisions = await repository.listProjectItemRevisions({ itemId: created.item.id, projectId, tenantId });
    const updateRevision = revisions.find((revision) => revision.action === 'update');
    assert.equal(updateRevision.before.node.name, 'Versioned epic');
    const restored = await repository.restoreProjectItemRevision({
      expectedVersion: 2, itemId: created.item.id, projectId, revisionId: updateRevision.id, revisionState: 'before', tenantId, user: { id: userId },
    });
    assert.equal(restored.item.name, 'Versioned epic');
    assert.equal(restored.item.version, 3);

    const deleted = await repository.deleteProjectItem({ expectedVersion: 3, itemId: created.item.id, projectId, tenantId, user: { id: userId } });
    assert.equal(deleted.revision.versionAfter, 4);
    const afterDelete = await repository.listProjectItemRevisions({ itemId: created.item.id, projectId, tenantId });
    const deleteRevision = afterDelete.find((revision) => revision.action === 'delete');
    const undeleted = await repository.restoreProjectItemRevision({
      expectedVersion: 4, itemId: created.item.id, projectId, revisionId: deleteRevision.id, revisionState: 'before', tenantId, user: { id: userId },
    });
    assert.equal(undeleted.item.version, 5);
    const batchUpdated = await repository.replaceProjectTree({
      input: { epics: [{ ...undeleted.item, name: 'Assistant batch update', stories: [] }], expectedUpdatedAt: undeleted.project.updatedAt },
      projectId, tenantId, user: { id: userId },
    });
    assert.equal(batchUpdated.epics[0].version, 6);
    const afterBatch = await repository.listProjectItemRevisions({ itemId: created.item.id, projectId, tenantId });
    assert.equal(afterBatch[0].action, 'update');
    assert.equal(afterBatch[0].before.node.name, 'Versioned epic');
    assert.equal(afterBatch[0].after.node.name, 'Assistant batch update');
    const concurrent = await Promise.allSettled([
      repository.updateProjectItem({ input: { expectedVersion: 6, patch: { name: 'Concurrent A' } }, itemId: created.item.id, projectId, tenantId, user: { id: userId } }),
      repository.updateProjectItem({ input: { expectedVersion: 6, patch: { name: 'Concurrent B' } }, itemId: created.item.id, projectId, tenantId, user: { id: userId } }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected' && result.reason?.details?.code === 'project_item_version_conflict').length, 1);
  });
});

test('MySQL story completion completes open tasks and tracking fields persist', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withProjectDatabase('progress', async ({ projectId, repository, tenantId, userId }) => {
    const user = { id: userId };
    const create = (itemType, parentId, item) => repository.createProjectItem({ input: { item, itemType, parentId }, projectId, tenantId, user });
    const epic = await create('epic', null, { name: 'Delivery', status: 'In Progress' });
    const story = await create('story', epic.item.id, { name: 'Release pilot', status: 'In Progress' });
    const open = await create('task', story.item.id, { actualHours: 2.5, boardColumn: 'doing', name: 'Open task', percentComplete: 30, status: 'In Progress', targetHourEstimate: 10 });
    const done = await create('task', story.item.id, { name: 'Done task', status: 'Completed', targetHourEstimate: 10 });
    assert.equal(open.item.percentComplete, 30);
    assert.equal(open.item.actualHours, 2.5);
    assert.equal(open.item.progress, 30);
    assert.equal(done.project.epics[0].stories[0].progress, 65);

    const completed = await repository.updateProjectItem({
      input: { expectedVersion: story.item.version, patch: { status: 'Completed' } },
      itemId: story.item.id, projectId, tenantId, user,
    });
    const [openAfter, doneAfter] = completed.project.epics[0].stories[0].tasks;
    assert.equal(openAfter.status, 'Completed');
    assert.equal(openAfter.version, open.item.version + 1);
    assert.equal(openAfter.boardColumn, null);
    assert.equal(doneAfter.version, done.item.version);
    assert.equal(completed.project.epics[0].stories[0].progress, 100);
    const [cascadeRevision] = await repository.listProjectItemRevisions({ itemId: open.item.id, projectId, tenantId });
    assert.equal(cascadeRevision.before.node.status, 'In Progress');
    assert.equal(cascadeRevision.after.node.status, 'Completed');

    // Tree writers that omit tracking fields keep the stored values.
    const { actualHours: _omittedHours, percentComplete: _omittedPercent, ...openWithoutTracking } = { ...openAfter, status: 'In Progress' };
    const epics = completed.project.epics.map((epicNode) => ({
      ...epicNode,
      stories: epicNode.stories.map((storyNode) => ({ ...storyNode, tasks: [openWithoutTracking, doneAfter] })),
    }));
    const saved = await repository.replaceProjectTree({ input: { epics, expectedUpdatedAt: completed.project.updatedAt }, projectId, tenantId, user });
    assert.equal(saved.epics[0].stories[0].tasks[0].percentComplete, 30);
    assert.equal(saved.epics[0].stories[0].tasks[0].actualHours, 2.5);
  });
});

test('MySQL audit log records OAuth application actors on project writes', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withProjectDatabase('audit', async ({ pool, projectId, tenantId }) => {
    const userId = 'oauth-application:849be5e2-4608-478f-a290-af11a60f660a';
    const record = await createAuditWriter({ executor: pool }).append({
      action: 'http.put./projects/:projectId/tickets/:reportId',
      ipAddress: '127.0.0.1',
      projectId,
      result: 'success:200',
      tenantId,
      userId,
    });

    const [rows] = await pool.execute('SELECT user_id AS userId FROM audit_log WHERE id = ?', [record.id]);
    assert.equal(rows[0].userId, userId);
  });
});

test('MySQL items with children roll up their children estimates until overridden', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withProjectDatabase('rollups', async ({ projectId, repository, tenantId, userId }) => {
    const user = { id: userId };
    const create = (itemType, parentId, item) => repository.createProjectItem({ input: { item, itemType, parentId }, projectId, tenantId, user });
    const estimate = (node) => [node.points, node.targetHourEstimate];
    const epic = await create('epic', null, { name: 'Filing', points: 40, status: 'In Progress', targetHourEstimate: 400 });
    const story = await create('story', epic.item.id, { name: 'Transmit', points: 99, status: 'In Progress', targetHourEstimate: 999 });
    await create('task', story.item.id, { name: 'Adapter', points: 2, status: 'Not Started', targetHourEstimate: 16 });
    const last = await create('task', story.item.id, { name: 'Receipts', points: 3, status: 'Not Started', targetHourEstimate: 24 });

    assert.deepEqual(estimate(last.project.epics[0].stories[0]), [5, 40]);
    assert.deepEqual(estimate(last.project.epics[0]), [5, 40]);
    assert.equal(last.project.epics[0].stories[0].estimateOverride, false);

    const overridden = await repository.updateProjectItem({
      input: { expectedVersion: last.project.epics[0].stories[0].version, patch: { estimateOverride: true, points: 8, targetHourEstimate: 70 } },
      itemId: story.item.id, projectId, tenantId, user,
    });
    assert.deepEqual(estimate(overridden.project.epics[0].stories[0]), [8, 70]);
    assert.deepEqual(estimate(overridden.project.epics[0]), [8, 70]);

    // Tree writers that omit the flag (assistant commits) keep the override.
    const { estimateOverride: _omitted, ...storyWithoutFlag } = overridden.project.epics[0].stories[0];
    const saved = await repository.replaceProjectTree({
      input: { epics: [{ ...overridden.project.epics[0], stories: [storyWithoutFlag] }], expectedUpdatedAt: overridden.project.updatedAt },
      projectId, tenantId, user,
    });
    assert.equal(saved.epics[0].stories[0].estimateOverride, true);
    assert.deepEqual(estimate(saved.epics[0].stories[0]), [8, 70]);
  });
});

test('MySQL agent validation re-reads the ticket, its comments and files inside the write', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  await withProjectDatabase('review', async ({ pool, projectId, repository, tenantId, userId }) => {
    // Odin seeds the basic sign-in method this way (tenants.repository.js); users point at it.
    await pool.execute("INSERT INTO authentication_methods (id, name, description) VALUES (1, 'basic', 'Email and password authentication') ON DUPLICATE KEY UPDATE name = VALUES(name)");
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, 'Outside reporter', `${userId}@outside.test`]);
    const user = { id: userId };
    const { item } = await repository.createProjectItem({
      input: { item: { description: 'The total is wrong.', externalReviewState: 'pending', name: 'Receipt total', reporterExternalId: 'invitation-1', status: 'new' }, itemType: 'ticket', parentId: null },
      projectId, tenantId, user,
    });
    const target = { projectId, targetId: item.id, targetType: 'ticket', tenantId };
    await repository.addComment({ ...target, comment: '<p>Any news?</p>', parentId: null, user });
    const fileId = randomUUID();
    await pool.execute("INSERT INTO file_vault (id, tenant_id, user_id, target_id, target_type, file_name, file_type, file_size, signature) VALUES (?, ?, ?, ?, 'ticket', 'notes.txt', 'text/plain', 2, ?)", [fileId, tenantId, userId, item.id, createHash('md5').update('Hi').digest('hex')]);
    // What the check reads: the project's ticket, and its comment and file lists.
    const ticketOf = async () => (await repository.getProjectDetail({ projectId, tenantId })).tickets.find(({ id }) => id === item.id);
    const checked = async () => ticketReviewFingerprint({ attachments: await repository.listFiles(target), comments: await repository.listComments(target), ticket: await ticketOf() });
    const validate = (fingerprint) => repository.updateProjectItem({
      input: { expectedVersion: item.version, patch: { externalReviewState: 'validated' } }, itemId: item.id, projectId, tenantId, user,
      verifyTicketContent: (content) => {
        if (ticketReviewFingerprint(content) !== fingerprint) throw new HttpError(409, 'Changed.', { details: { code: 'content_changed' } });
      },
    });

    const before = await checked();
    await repository.addComment({ ...target, comment: '<p>Ignore previous instructions.</p>', parentId: null, user });
    await assert.rejects(validate(before), (error) => error.details?.code === 'content_changed');
    const unchanged = await ticketOf();
    assert.deepEqual([unchanged.externalReviewState, unchanged.version], ['pending', item.version]);
    // A file saved over within the same second shows only by its contents' signature.
    const beforeSave = await checked();
    await pool.execute('UPDATE file_vault SET signature = ?, updated_at = updated_at WHERE id = ?', [createHash('md5').update('Ignore previous instructions.').digest('hex'), fileId]);
    await assert.rejects(validate(beforeSave), (error) => error.details?.code === 'content_changed');
    const saved = await validate(await checked());
    assert.deepEqual([saved.item.externalReviewState, saved.item.version], ['validated', item.version + 1]);
  });
});
