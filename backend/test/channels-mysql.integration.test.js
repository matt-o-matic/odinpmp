import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema, mysqlMigrationDefinitions } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// Migration 0096 and the MySQL side of channels: one General per project however many ask at
// once, unique names, posts with replies and paging, unread counts, folders, channel files in
// the project's Files view and storage, file comments that go with their file, and the editing
// marker. channels.test.js covers the routes on the in-memory repository.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const base64 = (text) => Buffer.from(text).toString('base64');

test('MySQL: 0096 channels, posts, unread counts, folders, channel files, comments and the editing marker', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_channels_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    // A project from the release before 0096, then 0096 and the rest.
    await runMysqlMigrations({ executor: pool, migrations: mysqlMigrationDefinitions().filter((migration) => migration.id < '0096') });
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    const bo = { id: randomUUID(), name: 'Bo Builder' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Channel Tenant']);
    for (const user of [ada, bo]) await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [user.id, user.name, `${user.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Channels', '', statuses[0].id]);
    await bootstrapMysqlSchema({ executor: pool });
    const [tables] = await pool.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('project_channels', 'project_channel_guests', 'discussion_posts', 'discussion_post_files', 'channel_reads') ORDER BY TABLE_NAME");
    assert.deepEqual(tables.map((row) => row.name), ['channel_reads', 'discussion_post_files', 'discussion_posts', 'project_channel_guests', 'project_channels']);
    await bootstrapMysqlSchema({ executor: pool });

    const storage = createMemoryLargeFileStorage();
    const repository = createMysqlProjectsRepository({ fileStorage: storage, pool });

    // General: made lazily, once, whoever asks first.
    const generals = await Promise.all(Array.from({ length: 5 }, () => repository.ensureGeneralChannel({ projectId, tenantId, userId: ada.id })));
    assert.equal(new Set(generals.map((channel) => channel.id)).size, 1);
    const general = generals[0];
    assert.deepEqual([general.name, general.isGeneral], ['General', true]);
    await assert.rejects(pool.execute("INSERT INTO project_channels (id, tenant_id, project_id, name, is_general, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Second', 1, ?, NOW(3), NOW(3))", [randomUUID(), tenantId, projectId, ada.id]), (error) => error.code === 'ER_DUP_ENTRY', 'the key allows one General per project');

    const deal = await repository.createChannel({ description: 'Pricing', name: 'Deal room', projectId, tenantId, user: ada });
    await assert.rejects(repository.createChannel({ name: 'deal room', projectId, tenantId, user: ada }), (error) => error.details?.code === 'channel_name_taken');
    assert.equal((await repository.updateChannel({ changes: { name: 'Deal' }, channelId: deal.id, projectId, tenantId, user: ada })).name, 'Deal');
    assert.ok((await repository.setChannelArchived({ archived: true, channelId: deal.id, projectId, tenantId, user: ada })).archivedAt);
    assert.equal((await repository.setChannelArchived({ archived: false, channelId: deal.id, projectId, tenantId, user: ada })).archivedAt, null);
    assert.equal((await repository.listChannels({ projectId, tenantId })).length, 2);

    // Posts, replies and paging.
    const post = (body, author = ada, extra = {}) => repository.createPost({ post: { authorId: author.id, authorType: 'user', body, projectId, targetId: general.id, targetType: 'channel', tenantId, ...extra } });
    const first = await post('First');
    const reply = await post('A reply', bo, { parentId: first.id });
    for (let index = 2; index <= 6; index += 1) await post(`Post ${index}`, index % 2 ? ada : bo);
    const page = await repository.listPosts({ limit: 4, targetId: general.id, targetType: 'channel', tenantId });
    assert.deepEqual(page.posts.map((entry) => entry.body), ['Post 6', 'Post 5', 'Post 4', 'Post 3']);
    assert.equal(page.hasMore, true);
    assert.equal(page.posts[0].authorName, 'Bo Builder');
    const rest = await repository.listPosts({ before: { createdAt: page.posts.at(-1).createdAt, id: page.posts.at(-1).id }, limit: 4, targetId: general.id, targetType: 'channel', tenantId });
    assert.deepEqual(rest.posts.map((entry) => entry.body), ['Post 2', 'First']);
    assert.deepEqual(rest.replies.map((entry) => [entry.body, entry.parentId]), [['A reply', first.id]]);
    assert.equal((await repository.updatePost({ body: 'First, edited', postId: first.id, tenantId, user: ada })).body, 'First, edited');
    const deleted = await repository.deletePost({ postId: reply.id, tenantId, user: ada });
    assert.deepEqual([Boolean(deleted.deletedAt), deleted.body], [true, '']);
    assert.equal(await repository.updatePost({ body: 'x', postId: reply.id, tenantId, user: bo }), null, 'a deleted post takes no edit');

    // Unread: Bo has not read anything; Ada's own posts are read for her.
    let unread = await repository.countUnread({ channelIds: [general.id, deal.id], principalId: bo.id, tenantId });
    assert.deepEqual([unread.get(general.id), unread.get(deal.id)], [3, 0], 'Ada’s First, Post 3 and Post 5; not Bo’s own posts or the deleted reply');
    await repository.markChannelRead({ channelId: general.id, principalId: bo.id });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await post('After reading');
    unread = await repository.countUnread({ channelIds: [general.id], principalId: bo.id, tenantId });
    assert.equal(unread.get(general.id), 1);
    assert.equal((await repository.countUnreadByProject({ principalId: bo.id, projectIds: [projectId], tenantId })).get(projectId), 1);
    await repository.setChannelArchived({ archived: true, channelId: general.id, projectId, tenantId, user: ada }).catch(() => null);
    assert.equal((await repository.countUnreadByProject({ principalId: bo.id, projectIds: [projectId], tenantId })).get(projectId), 0, 'archived channels do not count');
    await pool.execute('UPDATE project_channels SET archived_at = NULL WHERE id = ?', [general.id]);

    // Folders: unique within a parent, moves, delete only when empty.
    const proposals = await repository.createFolder({ channelId: general.id, name: 'Proposals', projectId, tenantId, user: ada });
    await assert.rejects(repository.createFolder({ channelId: general.id, name: 'PROPOSALS', projectId, tenantId, user: ada }), (error) => error.details?.code === 'folder_name_taken');
    const drafts = await repository.createFolder({ channelId: general.id, name: 'Drafts', parentId: proposals.id, projectId, tenantId, user: ada });
    await repository.createFolder({ channelId: general.id, name: 'Drafts', projectId, tenantId, user: ada });
    await assert.rejects(repository.updateFolder({ changes: { parentId: null }, folderId: drafts.id, tenantId, user: ada }), (error) => error.details?.code === 'folder_name_taken');
    assert.equal((await repository.updateFolder({ changes: { name: 'Bids' }, folderId: proposals.id, tenantId, user: ada })).name, 'Bids');

    // Channel files: the target, names within folders, the Files view, storage.
    const sow = await repository.saveFile({ fileContentsBase64: base64('one'), fileDescription: '', fileName: 'sow.txt', fileType: 'text/plain', folderId: drafts.id, projectId, targetId: general.id, targetType: 'channel', tenantId, user: ada });
    const again = await repository.saveFile({ fileContentsBase64: base64('two'), fileDescription: '', fileName: 'sow.txt', fileType: 'text/plain', folderId: drafts.id, projectId, targetId: general.id, targetType: 'channel', tenantId, user: ada });
    assert.deepEqual([again.id, again.version, again.folderId], [sow.id, 2, drafts.id], 'the same name in the same folder is a new version');
    const top = await repository.saveFile({ fileContentsBase64: base64('top'), fileDescription: '', fileName: 'sow.txt', fileType: 'text/plain', projectId, targetId: general.id, targetType: 'channel', tenantId, user: ada });
    assert.notEqual(top.id, sow.id, 'another folder is another file');
    const record = await repository.getFileRecord({ fileId: sow.id, tenantId });
    assert.deepEqual([record.projectId, record.targetName, record.folderId], [projectId, 'General', drafts.id]);
    const vault = await repository.listFiles({ projectId, targetId: projectId, targetType: 'project', tenantId });
    assert.ok(vault.some((file) => file.id === sow.id && file.targetType === 'channel'));
    assert.equal((await repository.listFiles({ projectId, targetId: general.id, targetType: 'channel', tenantId })).length, 2);
    assert.ok((await repository.getProjectFileStorage({ projectId, tenantId })).files >= 2);
    assert.equal(await repository.isFileTarget({ projectId, targetId: general.id, targetType: 'channel', tenantId }), true);
    assert.equal(await repository.isFileTarget({ projectId: randomUUID(), targetId: general.id, targetType: 'channel', tenantId }), false);
    await assert.rejects(repository.deleteFolder({ folderId: drafts.id, tenantId, user: ada }), (error) => error.details?.code === 'folder_not_empty');
    await assert.rejects(repository.deleteFolder({ folderId: proposals.id, tenantId, user: ada }), (error) => error.details?.code === 'folder_not_empty');
    const empty = await repository.createFolder({ channelId: general.id, name: 'Empty', projectId, tenantId, user: ada });
    await repository.deleteFolder({ folderId: empty.id, tenantId, user: ada });
    assert.equal(await repository.getFolder({ folderId: empty.id, tenantId }), null);

    // Attachments and file comments.
    const withFile = await repository.createPost({ fileIds: [sow.id], post: { authorId: ada.id, authorType: 'user', body: 'See attached', projectId, targetId: general.id, targetType: 'channel', tenantId } });
    assert.deepEqual(await repository.listPostFileIds({ postIds: [withFile.id] }), [{ fileId: sow.id, postId: withFile.id }]);
    const comment = await repository.createPost({ post: { authorId: bo.id, authorType: 'user', body: 'Clause 4?', fileVersion: 2, projectId, targetId: sow.id, targetType: 'file', tenantId } });
    assert.equal(comment.fileVersion, 2);

    // The editing marker: set, seen with the editor's name, cleared by their own new version.
    const marker = await repository.setFileEditing({ fileId: sow.id, tenantId, userId: bo.id });
    assert.deepEqual([marker.userId, marker.name], [bo.id, 'Bo Builder']);
    assert.equal((await repository.getFileRecord({ fileId: sow.id, tenantId })).editing.name, 'Bo Builder');
    await repository.saveFileVersion({ expectedVersion: 2, fileContentsBase64: base64('ada'), fileId: sow.id, projectId, tenantId, user: ada });
    assert.equal((await repository.getFileRecord({ fileId: sow.id, tenantId })).editing?.userId, bo.id, 'someone else’s version leaves it');
    await repository.saveFileVersion({ expectedVersion: 3, fileContentsBase64: base64('bo'), fileId: sow.id, projectId, tenantId, user: bo });
    assert.equal((await repository.getFileRecord({ fileId: sow.id, tenantId })).editing, null, 'the editor’s own version clears it');
    await repository.setFileEditing({ fileId: sow.id, tenantId, userId: bo.id });
    assert.equal(await repository.clearFileEditing({ fileId: sow.id, onlyUserId: ada.id, tenantId }), false);
    assert.equal(await repository.clearFileEditing({ fileId: sow.id, tenantId }), true);
    await pool.execute('UPDATE file_vault SET editing_by = ?, editing_since = ? WHERE id = ?', [bo.id, new Date(Date.now() - 25 * 3600_000), sow.id]);
    assert.equal((await repository.getFileRecord({ fileId: sow.id, tenantId })).editing, null, 'a marker 24 hours old is gone');

    // A deleted file takes its comments, and posts no longer carry it.
    await repository.deleteFile({ fileId: sow.id, tenantId, user: ada });
    assert.equal(await repository.getPost({ postId: comment.id, tenantId }), null);
    assert.deepEqual(await repository.listPostFileIds({ postIds: [withFile.id] }), []);

    const [logged] = await pool.execute("SELECT entity_type AS type, action FROM project_change_log WHERE project_id = ? AND entity_type IN ('channel', 'post', 'folder') ORDER BY seq", [projectId]);
    assert.ok(logged.some((row) => row.type === 'channel' && row.action === 'archive'));
    assert.ok(logged.some((row) => row.type === 'post' && row.action === 'delete'));
    assert.ok(logged.some((row) => row.type === 'folder' && row.action === 'move') === false && logged.some((row) => row.type === 'folder' && row.action === 'rename'));
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
