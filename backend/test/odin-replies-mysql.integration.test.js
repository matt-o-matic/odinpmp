import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { ensureMysqlChannelOdinSchema } from '../src/modules/channels/channel-odin-schema.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';

// Migration 0101 and the MySQL side of Odin in channels: one reply record per tagging post,
// Odin's own posts (author type 'odin') in a thread and in unread counts, and each channel's
// "Let Odin answer when tagged" from 0105_channel_odin, with its backfill from the project setting
// it replaced. odin-channels.test.js covers the flow on the in-memory repository.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: 0101 Odin reply records, Odin posts, and the per-channel setting from 0105', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_odin_${process.pid}`;
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
    const [tables] = await pool.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'odin_replies'");
    assert.equal(tables.length, 1);
    const [[applied]] = await pool.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0101_odin_replies'");
    assert.equal(Number(applied.n), 1);
    // Applied once: a second bootstrap changes nothing.
    await bootstrapMysqlSchema({ executor: pool });

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Odin Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [ada.id, ada.name, `${ada.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Odin', '', statuses[0].id]);
    const repository = createMysqlProjectsRepository({ pool });

    const general = await repository.ensureGeneralChannel({ projectId, tenantId, userId: ada.id });
    const tagging = await repository.createPost({ post: { authorId: ada.id, authorType: 'user', body: '@[Odin](odin:odin) status?', projectId, targetId: general.id, targetType: 'channel', tenantId } });

    // One record per tagging post, whoever asks twice.
    const input = { channelId: general.id, chatId: randomUUID(), postId: tagging.id, projectId, requesterId: ada.id, requesterType: 'user', status: 'queued', tenantId, threadId: tagging.id };
    const [first, second] = await Promise.all([repository.createOdinReply({ reply: input }), repository.createOdinReply({ reply: { ...input, chatId: randomUUID() } })]);
    assert.deepEqual([first.created, second.created].sort(), [false, true]);
    assert.equal(first.reply.id, second.reply.id);
    const reply = first.reply;
    assert.deepEqual([reply.status, reply.requesterType, reply.threadId], ['queued', 'user', tagging.id]);

    // Odin's post: author type 'odin', author id the record, in the thread and in unread counts.
    const odinPost = await repository.createPost({ post: { authorId: reply.id, authorType: 'odin', body: 'On track.', id: randomUUID(), parentId: tagging.id, projectId, targetId: general.id, targetType: 'channel', tenantId } });
    assert.deepEqual([odinPost.authorType, odinPost.authorId, odinPost.authorName], ['odin', reply.id, null]);
    assert.deepEqual((await repository.listThreadReplies({ parentId: tagging.id, tenantId })).map((post) => post.id), [odinPost.id]);
    await repository.markChannelRead({ channelId: general.id, principalId: ada.id, principalType: 'user' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repository.createPost({ post: { authorId: reply.id, authorType: 'odin', body: 'One more thing.', parentId: tagging.id, projectId, targetId: general.id, targetType: 'channel', tenantId } });
    assert.equal((await repository.countUnread({ channelIds: [general.id], principalId: ada.id, principalType: 'user', tenantId })).get(general.id), 1);

    const updated = await repository.updateOdinReply({ changes: { replyPostId: odinPost.id, status: 'replied' }, replyId: reply.id, tenantId });
    assert.deepEqual([updated.status, updated.replyPostId, updated.error], ['replied', odinPost.id, null]);
    const listed = await repository.listOdinReplies({ postIds: [tagging.id], replyIds: [reply.id], tenantId });
    assert.equal(listed.length, 1);
    assert.deepEqual(await repository.listOdinReplies({ postIds: [tagging.id], tenantId: randomUUID() }), [], 'other workspaces see nothing');

    // 0105: each channel's setting is on by default, and saving it touches only that channel.
    const deal = await repository.createChannel({ name: 'Deal room', projectId, tenantId, user: ada });
    assert.deepEqual([general.odinEnabled, deal.odinEnabled], [true, true]);
    assert.equal((await repository.updateChannel({ changes: { odinEnabled: false }, channelId: deal.id, projectId, tenantId, user: ada })).odinEnabled, false);
    assert.deepEqual((await repository.listChannels({ projectId, tenantId })).map((channel) => [channel.name, channel.odinEnabled]).sort(), [['Deal room', false], ['General', true]]);

    // The backfill: a project that had switched Odin off (0100's project_settings) starts with
    // Odin off in every channel; other projects keep it on. The column is dropped to run 0105's
    // body again as it runs on an upgrade.
    const otherProjectId = randomUUID();
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [otherProjectId, tenantId, 'Other', '', statuses[0].id]);
    const otherGeneral = await repository.ensureGeneralChannel({ projectId: otherProjectId, tenantId, userId: ada.id });
    await pool.execute('ALTER TABLE project_channels DROP COLUMN odin_enabled');
    await pool.execute('INSERT INTO project_settings (project_id, tenant_id, guests_see_board, odin_replies_enabled, updated_by, updated_at, version) VALUES (?, ?, 0, 0, ?, NOW(3), 1)', [projectId, tenantId, ada.id]);
    assert.equal((await repository.getChannel({ channelId: general.id, tenantId })).odinEnabled, true, 'read as on before 0105 runs');
    await ensureMysqlChannelOdinSchema(pool);
    assert.deepEqual((await repository.listChannels({ projectId, tenantId })).map((channel) => channel.odinEnabled), [false, false]);
    assert.equal((await repository.getChannel({ channelId: otherGeneral.id, tenantId })).odinEnabled, true);
    // Run again, it changes nothing: a channel switched back on stays on.
    await repository.updateChannel({ changes: { odinEnabled: true }, channelId: general.id, projectId, tenantId, user: ada });
    await ensureMysqlChannelOdinSchema(pool);
    assert.equal((await repository.getChannel({ channelId: general.id, tenantId })).odinEnabled, true);
    // The board settings no longer carry Odin, and saving them leaves the old column alone.
    const board = await repository.saveProjectSettings({ expectedVersion: 1, input: { guestsSeeBoard: true }, projectId, tenantId, user: ada });
    assert.deepEqual([board.guestsSeeBoard, board.version, 'odinRepliesEnabled' in board], [true, 2, false]);
    const [[legacy]] = await pool.execute('SELECT odin_replies_enabled AS enabled FROM project_settings WHERE project_id = ?', [projectId]);
    assert.equal(Number(legacy.enabled), 0);
    // odin_replies is 0101's alone: its columns, not the ones 0100 once planned.
    const [columns] = await pool.execute("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'odin_replies' AND COLUMN_NAME IN ('requester_type', 'thread_id', 'principal_type', 'assistant_turn_id') ORDER BY COLUMN_NAME");
    assert.deepEqual(columns.map((column) => column.name), ['requester_type', 'thread_id']);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
