import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { ensureMysqlPostReactionsSchema } from '../src/modules/channels/post-reactions-schema.js';
import { ensureMysqlPostReplyToSchema } from '../src/modules/channels/post-reply-to-schema.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// The MySQL side of reactions (0106_post_reactions) and replies to a reply (0107_post_reply_to):
// the table and column, re-running each migration, and the repository methods. Emoji that a
// case-insensitive collation would treat as the same stay apart. channels.test.js covers the
// routes in memory.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: reactions are one per post, person and emoji, and a reply keeps the reply it answers', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_reactions_${process.pid}`;
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
    // Both migrations run again without harm.
    await ensureMysqlPostReactionsSchema(pool);
    await ensureMysqlPostReplyToSchema(pool);
    const [[{ collation }]] = await pool.execute("SELECT COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_post_reactions' AND COLUMN_NAME = 'emoji'");
    assert.equal(collation, 'utf8mb4_bin');

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    const bo = { id: randomUUID(), name: 'Bo Builder' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Reactions Tenant']);
    for (const person of [ada, bo]) await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [person.id, person.name, `${person.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Reactions', '', statuses[0].id]);

    const repository = createMysqlProjectsRepository({ fileStorage: createMemoryLargeFileStorage(), pool });
    const general = await repository.ensureGeneralChannel({ projectId, tenantId, userId: ada.id });
    const post = (body, extra = {}) => repository.createPost({ post: { authorId: ada.id, authorType: 'user', body, projectId, targetId: general.id, targetType: 'channel', tenantId, ...extra } });
    const root = await post('Agenda');
    const first = await post('Add budget', { parentId: root.id });
    const answer = await post('Agreed', { parentId: root.id, replyToId: first.id });
    assert.equal(answer.replyToId, first.id);
    assert.equal(first.replyToId, null);
    const page = await repository.listPosts({ targetId: general.id, targetType: 'channel', tenantId });
    assert.deepEqual(page.replies.map((reply) => reply.replyToId), [null, first.id]);

    const react = (person, emoji, reacted = true) => repository.setPostReaction({ emoji, postId: root.id, principal: { id: person.id, type: 'user' }, reacted, tenantId });
    assert.equal(await react(ada, '👍'), true);
    assert.equal(await react(ada, '👍'), false, 'the same one twice changes nothing');
    assert.equal(await react(bo, '👍'), true);
    // Skin tones and the plain sign are different emoji, as are the two hearts.
    assert.equal(await react(bo, '👍🏽'), true);
    assert.equal(await react(bo, '❤️'), true);
    assert.equal(await react(bo, '❤'), true);
    const rows = await repository.listPostReactions({ postIds: [root.id], tenantId });
    assert.deepEqual(rows.map((row) => [row.emoji, row.name]), [['👍', 'Ada Admin'], ['👍', 'Bo Builder'], ['👍🏽', 'Bo Builder'], ['❤️', 'Bo Builder'], ['❤', 'Bo Builder']]);
    assert.equal(await react(ada, '👍', false), true);
    assert.equal(await react(ada, '👍', false), false);
    assert.deepEqual((await repository.listPostReactions({ postIds: [root.id], tenantId })).map((row) => row.principalId), [bo.id, bo.id, bo.id, bo.id]);
    assert.deepEqual(await repository.listPostReactions({ postIds: [root.id], tenantId: randomUUID() }), [], 'another tenant sees none');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
