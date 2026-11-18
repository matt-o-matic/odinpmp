import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { purgeMysqlItemChangeRequests } from '../src/modules/changes/item-change-requests.js';
import { runWithChangeNote } from '../src/modules/changes/project-change-log.js';
import { createMysqlGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';

// The MySQL reads behind odin_get_item_details and the stale check of odin_apply_item_changes
// (docs/mcp-change-feed/plan.md): newest comments and changes per item in one windowed query,
// links and dependencies from either end, and the idempotency keys.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

async function withDatabase(run) {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_feed_${process.pid}`;
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
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Change Feed Tenant']);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Change feed', '', statuses[0].id]);
    await run({ governance: createMysqlGovernanceRepository({ pool }), pool, projectId, repository: createMysqlProjectsRepository({ pool }), tenantId, user: { id: userId, name: 'Feed Tester' } });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
}

test('MySQL item details: newest comments and changes per item, paged back, and links and dependencies from either end', { skip: !databaseUrl, timeout: 600_000 }, async () => {
  await withDatabase(async ({ governance, pool, projectId, repository, tenantId, user }) => {
    const create = async (itemType, name, parentId = null) => (await repository.createProjectItem({ input: { item: { name, status: 'Not Started' }, itemType, parentId }, projectId, tenantId, user })).item;
    const epic = await create('epic', 'Launch');
    const story = await create('story', 'Pay by card', epic.id);
    const taskA = await create('task', 'Card form', story.id);
    const taskB = await create('task', 'Card errors', story.id);
    for (const text of ['one', 'two', 'three']) {
      await repository.addComment({ comment: `<p>${text}</p>`, parentId: null, projectId, targetId: taskA.id, targetType: 'task', tenantId, user });
      // Comments store whole seconds; space them so their order is their time.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const link = await repository.createWorkItemRelation({ input: { relationType: 'blocks', toItemId: taskA.id }, itemId: taskB.id, projectId, tenantId, user });
    const dependency = await governance.createDependency({ input: { dependencyType: 'FS', lagDays: 0, predecessorId: taskA.id, successorId: story.id }, projectId, tenantId });
    await repository.recordProjectChanges([{ action: 'create', actorId: user.id, detail: { predecessorId: taskA.id, successorId: story.id }, entityId: dependency.id, entityType: 'dependency', itemId: story.id, projectId, relatedItemId: taskA.id, tenantId }]);

    const comments = await repository.listItemComments({ limit: 2, projectId, targets: [{ targetId: taskA.id }, { targetId: taskB.id }], tenantId });
    const first = comments.get(taskA.id);
    assert.deepEqual([first.comments.map((comment) => comment.comment.replace(/<[^>]+>/g, '')), first.more, first.comments[0].author.name], [['two', 'three'], true, 'Unknown user']);
    assert.deepEqual(comments.get(taskB.id), { comments: [], more: false });
    const older = (await repository.listItemComments({ limit: 2, projectId, targets: [{ before: { createdAt: first.comments[0].createdAt, id: first.comments[0].id }, targetId: taskA.id }], tenantId })).get(taskA.id);
    assert.deepEqual([older.comments.map((comment) => comment.comment.replace(/<[^>]+>/g, '')), older.more], [['one'], false]);

    // taskA's history holds its own changes, its comments, and the link and dependency that name it.
    const history = await repository.listItemChanges({ items: [{ itemId: taskA.id }, { itemId: story.id }], limit: 3, projectId, tenantId });
    const own = history.get(taskA.id);
    assert.deepEqual(own.entries.map((entry) => entry.entityType), ['dependency', 'relation', 'comment']);
    assert.deepEqual([own.more, own.latestSeq, own.entries[1].relatedItemId], [true, own.entries[0].seq, taskA.id]);
    const page = (await repository.listItemChanges({ items: [{ beforeSeq: own.entries.at(-1).seq, itemId: taskA.id }], limit: 3, projectId, tenantId })).get(taskA.id);
    assert.deepEqual([page.entries.map((entry) => entry.entityType), page.more, page.latestSeq], [['comment', 'comment', 'item'], false, null]);
    assert.deepEqual(history.get(story.id).entries.map((entry) => entry.entityType), ['dependency', 'item']);
    // The feed's item filter finds a link from the other end too.
    const since = await repository.listProjectChanges({ afterSeq: 0, itemId: taskA.id, limit: 50, projectId, settleMs: 0, tenantId });
    assert.ok(since.entries.some((entry) => entry.entityId === link.relation.id));
    // Reads stop at the newest settled change in the log, and say which that is; a later change
    // waits out the settle window.
    const all = await repository.listProjectChanges({ afterSeq: 0, limit: 500, projectId, settleMs: 0, tenantId });
    assert.equal(all.settledSeq, all.entries.at(-1).seq);
    const waiting = await repository.listProjectChanges({ afterSeq: 0, limit: 500, projectId, settleMs: 60_000, tenantId });
    assert.deepEqual([waiting.entries.length, waiting.settledSeq < all.settledSeq], [0, true]);

    assert.deepEqual((await repository.listRelationsForItems({ itemIds: [taskA.id], projectId, tenantId })).map((relation) => [relation.fromItemId, relation.toItemId]), [[taskB.id, taskA.id]]);
    assert.deepEqual((await governance.listDependenciesForItems({ itemIds: [taskA.id], projectId, tenantId })).map((record) => [record.predecessorId, record.successorId]), [[taskA.id, story.id]]);
    const activity = await repository.listCommentActivity({ projectId, targetIds: [taskA.id, taskB.id], tenantId });
    assert.equal(activity.get(taskA.id).count, 3);

    // An agent's note rides on every row its change writes.
    await runWithChangeNote({ evidence: [{ ref: 'ci:42' }], key: 'note-key-0001', reason: 'CI passed' }, () => repository.updateProjectItem({
      input: { expectedVersion: taskB.version, patch: { status: 'In Progress' } }, itemId: taskB.id, projectId, tenantId, user,
    }));
    const noted = (await repository.listItemChanges({ items: [{ itemId: taskB.id }], limit: 1, projectId, tenantId })).get(taskB.id).entries[0];
    assert.deepEqual([noted.detail.note, noted.detail.fields.status.to], [{ evidence: [{ ref: 'ci:42' }], key: 'note-key-0001', reason: 'CI passed' }, 'In Progress']);
  });
});

test('MySQL idempotency keys: one claim per key, the first result kept, stale claims taken over, old keys purged', { skip: !databaseUrl, timeout: 600_000 }, async () => {
  await withDatabase(async ({ pool, projectId, repository, tenantId, user }) => {
    const store = repository.itemChangeRequests;
    const key = { actorId: user.id, key: 'claim-key-0001', tenantId };
    const claims = await Promise.all([1, 2].map(() => store.claim({ ...key, itemId: 'item-1', projectId, requestHash: 'a'.repeat(64) })));
    assert.deepEqual(claims.map((claim) => claim.claimed).sort(), [false, true]);
    const held = claims.find((claim) => !claim.claimed).record;
    assert.deepEqual([held.status, held.requestHash, held.result], ['pending', 'a'.repeat(64), null]);
    assert.equal(await store.takeOver(key), false);
    await pool.execute('UPDATE item_change_requests SET updated_at = NOW(3) - INTERVAL 3 MINUTE WHERE idempotency_key = ?', [key.key]);
    assert.equal(await store.takeOver(key), true);
    await store.finish({ ...key, result: { status: 'applied' } });
    const done = await store.claim({ ...key, itemId: 'item-1', projectId, requestHash: 'a'.repeat(64) });
    assert.deepEqual([done.claimed, done.record.status, done.record.result], [false, 'done', { status: 'applied' }]);
    // A key freed after a failure that wrote nothing can be claimed again.
    const other = { ...key, key: 'claim-key-0002' };
    await store.claim({ ...other, itemId: 'item-1', projectId, requestHash: 'b'.repeat(64) });
    await store.release(other);
    assert.equal((await store.claim({ ...other, itemId: 'item-1', projectId, requestHash: 'b'.repeat(64) })).claimed, true);
    await pool.execute('UPDATE item_change_requests SET created_at = NOW(3) - INTERVAL 31 DAY WHERE idempotency_key = ?', [key.key]);
    assert.equal(await purgeMysqlItemChangeRequests(pool), 1);
  });
});
