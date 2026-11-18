import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema, mysqlMigrationDefinitions } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// Migration 0103 and the MySQL side of Odin Chat: direct message conversations (one per set of
// people, even when two start it at once), their posts, unread and mention counts and reads,
// files filed under a conversation, channels across projects, Mentions and Threads.
// odin-chat.test.js covers the routes on in-memory repositories.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: 0103 direct messages, Mentions, Threads and channels across projects', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_chat_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  // A session time zone far from UTC: stored times must not move with it.
  pool.on('connection', (connection) => connection.query("SET time_zone = '+09:00'"));
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    // The release before 0103, then 0103 and the rest, twice.
    await runMysqlMigrations({ executor: pool, migrations: mysqlMigrationDefinitions().filter((migration) => migration.id < '0103') });
    const tablesNamed = "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('direct_conversations', 'direct_conversation_members') ORDER BY TABLE_NAME";
    assert.equal((await pool.execute(tablesNamed))[0].length, 0);
    await bootstrapMysqlSchema({ executor: pool });
    await bootstrapMysqlSchema({ executor: pool });
    assert.deepEqual((await pool.execute(tablesNamed))[0].map((row) => row.name), ['direct_conversation_members', 'direct_conversations']);
    const [unique] = await pool.execute("SELECT NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'direct_conversations' AND INDEX_NAME = 'uq_direct_conversations_members'");
    assert.equal(Number(unique[0]?.nonUnique), 0, 'one conversation per set of people');
    const [collations] = await pool.execute("SELECT TABLE_NAME AS name, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('direct_conversations', 'discussion_posts')");
    assert.equal(new Set(collations.map((row) => row.collation)).size, 1, 'the posts table’s collation');

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const hiddenProjectId = randomUUID();
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    const bo = { id: randomUUID(), name: 'Bo Builder' };
    const cy = { id: randomUUID(), name: 'Cy Checker' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Chat Tenant']);
    for (const person of [ada, bo, cy]) {
      await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [person.id, person.name, `${person.id}@acme.test`]);
      await pool.execute("INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, 'user')", [randomUUID(), person.id, tenantId]);
    }
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    for (const [id, name] of [[projectId, 'Rollout'], [hiddenProjectId, 'Hidden']]) {
      await pool.execute("INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, '', ?, 0)", [id, tenantId, name, statuses[0].id]);
    }
    const repository = createMysqlProjectsRepository({ fileStorage: createMemoryLargeFileStorage(), pool });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual((await repository.listWorkspaceMembers({ tenantId })).map((member) => member.name), ['Ada Admin', 'Bo Builder', 'Cy Checker']);

    // Channels across projects.
    const general = await repository.ensureGeneralChannel({ projectId, tenantId, userId: ada.id });
    const hidden = await repository.ensureGeneralChannel({ projectId: hiddenProjectId, tenantId, userId: ada.id });
    assert.deepEqual((await repository.listChannelsInProjects({ projectIds: [projectId], tenantId })).map((channel) => channel.id), [general.id]);
    assert.equal((await repository.listChannelsInProjects({ projectIds: [projectId, hiddenProjectId], tenantId })).length, 2);
    assert.deepEqual(await repository.listChannelsInProjects({ projectIds: [], tenantId }), []);

    // Conversations: the same people reach one, whoever starts it and even at the same moment.
    const raced = await Promise.all([
      repository.createDirectConversation({ createdBy: ada.id, memberIds: [ada.id, bo.id], tenantId }),
      repository.createDirectConversation({ createdBy: bo.id, memberIds: [bo.id, ada.id], tenantId }),
    ]);
    assert.equal(raced[0].conversation.id, raced[1].conversation.id);
    assert.equal(raced.filter((entry) => entry.created).length, 1);
    const pair = raced[0].conversation;
    assert.deepEqual(pair.members.map((member) => member.name).sort(), ['Ada Admin', 'Bo Builder']);
    const trio = (await repository.createDirectConversation({ createdBy: ada.id, memberIds: [ada.id, bo.id, cy.id], tenantId })).conversation;
    assert.notEqual(trio.id, pair.id);
    assert.equal(await repository.getDirectConversation({ conversationId: pair.id, tenantId: randomUUID() }), null, 'another workspace sees none');

    // Posts: stored under the conversation, newest first, with replies; no change log rows.
    const [logBefore] = await pool.execute('SELECT COUNT(*) AS n FROM project_change_log');
    const first = await repository.createDirectPost({ post: { authorId: ada.id, authorType: 'user', body: `@[Bo Builder](user:${bo.id}) rates?`, targetId: pair.id, tenantId } });
    await pause();
    const second = await repository.createDirectPost({ post: { authorId: ada.id, authorType: 'user', body: 'Second', targetId: pair.id, tenantId } });
    await pause();
    const reply = await repository.createDirectPost({ post: { authorId: bo.id, authorType: 'user', body: 'Here', parentId: first.id, targetId: pair.id, tenantId } });
    assert.deepEqual([first.targetType, first.projectId, first.authorName], ['dm', pair.id, 'Ada Admin']);
    const [logAfter] = await pool.execute('SELECT COUNT(*) AS n FROM project_change_log');
    assert.equal(Number(logAfter[0].n), Number(logBefore[0].n), 'direct messages are not project work');
    const page = await repository.listPosts({ limit: 10, targetId: pair.id, targetType: 'dm', tenantId });
    assert.deepEqual(page.posts.map((post) => post.id), [second.id, first.id]);
    assert.deepEqual(page.replies.map((post) => post.id), [reply.id]);
    assert.equal((await repository.getPost({ postId: first.id, tenantId })).createdAt, first.createdAt, 'times survive the session time zone');

    // Unread and mentions per member; reading clears them.
    let mine = (await repository.listDirectConversationsForUser({ tenantId, userId: bo.id })).find((entry) => entry.id === pair.id);
    assert.deepEqual([mine.unreadCount, mine.mentionCount], [2, 1], 'Ada’s two posts, one tagging Bo; not Bo’s reply');
    assert.ok(mine.lastPostAt >= reply.createdAt);
    const adaView = (await repository.listDirectConversationsForUser({ tenantId, userId: ada.id })).find((entry) => entry.id === pair.id);
    assert.equal(adaView.unreadCount, 1, 'Bo’s reply; Ada started the conversation and wrote the rest');
    assert.ok(await repository.markDirectConversationRead({ conversationId: pair.id, userId: bo.id }));
    mine = (await repository.listDirectConversationsForUser({ tenantId, userId: bo.id })).find((entry) => entry.id === pair.id);
    assert.deepEqual([mine.unreadCount, mine.mentionCount], [0, 0]);
    assert.equal(await repository.markDirectConversationRead({ conversationId: pair.id, userId: cy.id }), null, 'only members have a read marker');
    assert.equal((await repository.listDirectConversationsForUser({ tenantId, userId: cy.id })).some((entry) => entry.id === pair.id), false);

    // Edits and deletes of direct posts only.
    assert.equal((await repository.updateDirectPost({ body: 'Second, edited', postId: second.id, tenantId })).body, 'Second, edited');
    assert.equal((await repository.deleteDirectPost({ postId: second.id, tenantId, userId: ada.id })).deletedAt !== null, true);
    assert.equal(await repository.updateDirectPost({ body: 'x', postId: second.id, tenantId }), null, 'a deleted post takes no edit');

    // Files under a conversation: it stands in for the project.
    assert.equal(await repository.isFileTarget({ projectId: pair.id, targetId: pair.id, targetType: 'dm', tenantId }), true);
    assert.equal(await repository.isFileTarget({ projectId, targetId: pair.id, targetType: 'dm', tenantId }), false);
    const fileId = randomUUID();
    await pool.execute("INSERT INTO file_vault (id, tenant_id, user_id, target_id, target_type, file_name, file_desc, file_type, file_size, file_modified, created_at, updated_at, storage_key, scan_status) VALUES (?, ?, ?, ?, 'dm', 'rates.txt', '', 'text/plain', 5, NOW(), NOW(), NOW(), ?, 'clean')", [fileId, tenantId, ada.id, pair.id, randomUUID()]);
    assert.equal((await repository.getFileRecord({ fileId, tenantId })).projectId, pair.id);
    assert.deepEqual((await repository.listFiles({ projectId: pair.id, targetId: pair.id, targetType: 'dm', tenantId })).map((file) => file.id), [fileId]);

    // Channel mentions, Mentions and Threads.
    const bodyFor = (person) => `@[${person.name}](user:${person.id}) look`;
    const tagged = await repository.createPost({ post: { authorId: ada.id, authorType: 'user', body: bodyFor(cy), projectId, targetId: general.id, targetType: 'channel', tenantId } });
    await pause();
    await repository.createPost({ post: { authorId: ada.id, authorType: 'user', body: bodyFor(cy), projectId: hiddenProjectId, targetId: hidden.id, targetType: 'channel', tenantId } });
    await repository.createPost({ post: { authorId: cy.id, authorType: 'user', body: bodyFor(cy), projectId, targetId: general.id, targetType: 'channel', tenantId } });
    await repository.createPost({ post: { authorId: ada.id, authorType: 'user', body: '50%_off @[Cy](user:not-cy)', projectId, targetId: general.id, targetType: 'channel', tenantId } });
    assert.equal((await repository.countUnreadChannelMentions({ channelIds: [general.id], tenantId, userId: cy.id })).get(general.id), 1);
    await repository.markChannelRead({ channelId: general.id, principalId: cy.id });
    assert.equal((await repository.countUnreadChannelMentions({ channelIds: [general.id], tenantId, userId: cy.id })).get(general.id), 0);
    const mentions = await repository.listMentionPosts({ channelIds: [general.id], conversationIds: [trio.id], limit: 10, tenantId, userId: cy.id });
    assert.deepEqual(mentions.posts.map((post) => post.id), [tagged.id], 'not the hidden channel, not Cy’s own post');
    const both = await repository.listMentionPosts({ channelIds: [general.id], conversationIds: [pair.id], limit: 1, tenantId, userId: bo.id });
    assert.deepEqual([both.posts.map((post) => post.id), both.hasMore], [[first.id], false]);
    assert.deepEqual((await repository.listMentionPosts({ channelIds: [], conversationIds: [], tenantId, userId: bo.id })).posts, []);

    const threads = await repository.listThreadsForMember({ channelIds: [general.id], conversationIds: [pair.id], tenantId, userId: bo.id });
    assert.deepEqual(threads.map((thread) => [thread.root.id, thread.replies.map((entry) => entry.id)]), [[first.id, [reply.id]]], 'Bo replied in Ada’s thread');
    assert.equal((await repository.listThreadsForMember({ channelIds: [general.id], conversationIds: [], tenantId, userId: bo.id })).length, 0);
    assert.deepEqual((await repository.listChannelReads({ channelIds: [general.id], userId: cy.id })).has(general.id), true);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
