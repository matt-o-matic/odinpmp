import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createMysqlMailRepository } from '../src/modules/mail/mail.repository.js';
import { flushDueChatDigests } from '../src/modules/notifications/chat-digest.service.js';
import { createMysqlNotificationsRepository } from '../src/modules/notifications/notifications.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// Migration 0102_notifications on MySQL and the MySQL notifications repository: levels, records
// and collapsing through the open-collapse unique key, reading, the digest's claim and send on a
// fake clock, push subscriptions, focus, retention, thread authors, and that an assignment is
// observed only once its transaction commits. notifications.test.js covers the rules in memory.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const MINUTE = 60_000;

test('MySQL: 0102 notifications schema and repository', { skip: !databaseUrl, timeout: 560_000 }, async (t) => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_notif_${process.pid}`;
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
    // Running the migrations again changes nothing.
    await bootstrapMysqlSchema({ executor: pool });

    const repository = createMysqlNotificationsRepository({ pool });
    const tenantId = randomUUID();
    const mo = { id: randomUUID(), name: 'Mo Member' };
    const lena = { id: randomUUID(), name: 'Lena Lead' };
    const principal = { principalId: mo.id, principalType: 'user', tenantId };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Notify Tenant']);
    for (const person of [mo, lena]) {
      await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [person.id, person.name, `${person.id}@acme.test`]);
      await pool.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), person.id, tenantId, 'user']);
    }
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    const projectId = randomUUID();
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Northwind rollout', '', statuses[0].id]);
    for (const person of [mo, lena]) await pool.execute('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), person.id, projectId, 'user']);
    const projectRepository = createMysqlProjectsRepository({ fileStorage: createMemoryLargeFileStorage(), pool });
    const general = await projectRepository.ensureGeneralChannel({ projectId, tenantId, userId: lena.id });

    await t.test('0102 adds the tables, with the open-collapse key on a generated column', async () => {
      const [tables] = await pool.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('channel_notification_levels', 'notifications', 'chat_digest_deliveries', 'push_subscriptions', 'notification_focus') ORDER BY TABLE_NAME");
      assert.deepEqual(tables.map((row) => row.name), ['channel_notification_levels', 'chat_digest_deliveries', 'notification_focus', 'notifications', 'push_subscriptions']);
      const [generated] = await pool.execute("SELECT EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'open_collapse_key'");
      assert.match(generated[0].extra, /STORED GENERATED/);
      const [key] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND INDEX_NAME = 'uq_notifications_open_collapse'");
      assert.equal(key[0].cols, 'tenant_id,principal_type,principal_id,open_collapse_key');
      const [migration] = await pool.execute("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0102_notifications'");
      assert.equal(Number(migration[0].count), 1);
    });

    await t.test('levels: set, read, and back to the default', async () => {
      await repository.setChannelLevel({ ...principal, channelId: general.id, level: 'all' });
      await repository.setChannelLevel({ ...principal, channelId: general.id, level: 'off' });
      assert.deepEqual([...await repository.getChannelLevels({ ...principal, channelIds: [general.id, 'none'] })], [[general.id, 'off']]);
      assert.deepEqual([...await repository.listChannelLevels({ channelId: general.id })], [[`user:${mo.id}`, 'off']]);
      await repository.setChannelLevel({ ...principal, channelId: general.id, level: null });
      assert.equal((await repository.getChannelLevels({ ...principal, channelIds: [general.id] })).size, 0);
    });

    const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, 0) + minutes * MINUTE);
    const watched = (minutes, postId) => repository.recordNotification({
      notification: { ...principal, actorId: lena.id, actorType: 'user', channelId: general.id, collapseKey: `channel:${general.id}`, digestAfter: at(minutes + 10), kind: 'channel_post', postId, projectId, summary: { actorName: 'Lena Lead', channelName: 'General', excerpt: postId, projectKind: 'delivery', projectName: 'Northwind rollout' } },
      now: at(minutes),
    });

    await t.test('collapsing: one unread row per channel, a new one once read, back into the digest once emailed', async () => {
      const first = await watched(0, 'post-1');
      const second = await watched(1, 'post-2');
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.notification.id, first.notification.id);
      assert.deepEqual([second.notification.collapseCount, second.notification.postId, second.notification.digestAfter], [2, 'post-2', at(10).toISOString()], 'joins the digest when the first post would');
      assert.equal(await repository.countUnread(principal), 1);
      assert.deepEqual(await repository.markNotificationsRead({ ...principal, channelId: general.id, now: at(2) }), [first.notification.id]);
      assert.equal((await repository.getNotification({ ...principal, id: first.notification.id })).digestState, 'read');
      const third = await watched(3, 'post-3');
      assert.equal(third.created, true, 'a read row no longer collapses');
      assert.deepEqual((await repository.listNotifications({ ...principal })).map((row) => row.postId), ['post-3', 'post-2']);
      assert.deepEqual(await repository.markNotificationsRead({ ...principal, all: true, now: at(4) }), [third.notification.id]);
    });

    await t.test('the digest: due after the quiet period, claimed, sent once, with items read meanwhile left out', async () => {
      await pool.execute('DELETE FROM notifications');
      const one = await watched(0, 'post-a');
      const mention = await repository.recordNotification({ notification: { ...principal, actorId: lena.id, actorType: 'user', channelId: general.id, digestAfter: at(15), kind: 'mention', postId: 'post-b', projectId, summary: { actorName: 'Lena Lead', channelName: 'General', excerpt: 'take a look', projectKind: 'delivery', projectName: 'Northwind rollout' } }, now: at(5) });
      const readFirst = await repository.recordNotification({ notification: { ...principal, actorId: lena.id, actorType: 'user', channelId: general.id, digestAfter: at(16), kind: 'mention', postId: 'post-c', projectId, summary: { actorName: 'Lena Lead', excerpt: 'already seen' } }, now: at(6) });
      await repository.markNotificationsRead({ ...principal, ids: [readFirst.notification.id], now: at(7) });
      assert.deepEqual(await repository.listDueChatDigests({ dueBefore: new Date(at(30).getTime() - 20 * MINUTE), now: at(30) }), [], 'the mention joined 15 minutes ago');
      const due = await repository.listDueChatDigests({ dueBefore: new Date(at(36).getTime() - 20 * MINUTE), now: at(36) });
      assert.deepEqual(due.map((row) => row.principalId), [mo.id]);

      const sent = [];
      const deps = {
        authRepository: createMysqlAuthRepository({ pool }), env: { mailFromAddress: 'noreply@odin.test', mailFromName: 'Odin' }, frontendAppUrl: 'https://app.example/app', mailRepository: createMysqlMailRepository({ pool }),
        notificationsRepository: repository, now: () => at(36), projectRepository, transport: { async sendMail(message) { sent.push(message); return { messageId: 'm-1' }; } },
      };
      const summary = await flushDueChatDigests(deps);
      assert.equal(summary.sent, 1, JSON.stringify(summary));
      assert.equal(sent[0].to, `${mo.id}@acme.test`);
      assert.equal(sent[0].subject, "2 things you haven't seen in Odin");
      assert.doesNotMatch(sent[0].html, /already seen/);
      const states = await Promise.all([one, mention, readFirst].map((entry) => repository.getNotification({ ...principal, id: entry.notification.id })));
      assert.deepEqual(states.map((row) => row.digestState), ['sent', 'sent', 'read']);
      assert.ok(states[0].digestDeliveryId && states[0].digestSentAt);
      assert.equal(await repository.getChatDigest(principal), null, 'the delivery row is gone once sent');
      assert.equal((await flushDueChatDigests({ ...deps, now: () => at(90) })).due, 0, 'sent once');

      // A collapsed row that was emailed goes back into the digest with a new post.
      await watched(100, 'post-d');
      const reopened = await repository.getNotification({ ...principal, id: one.notification.id });
      assert.deepEqual([reopened.digestState, reopened.digestAfter, reopened.collapseCount], ['pending', at(110).toISOString(), 2]);

      // Claims are exclusive while their lease runs.
      const claimed = await repository.claimChatDigest({ ...principal, dueBefore: at(115), leaseUntil: at(200), now: at(135) });
      assert.ok(claimed?.claimToken);
      assert.equal(await repository.claimChatDigest({ ...principal, dueBefore: at(115), leaseUntil: at(200), now: at(136) }), null);
      assert.deepEqual(await repository.listDueChatDigests({ dueBefore: at(116), now: at(136) }), [], 'a claimed digest is not listed');
      const released = await repository.releaseChatDigest({ ...principal, claimToken: claimed.claimToken, deliveryId: claimed.deliveryId, now: at(137), released: [{ id: one.notification.id, reason: 'test release' }] });
      assert.equal(released.fenced, false);
      const after = await repository.getNotification({ ...principal, id: one.notification.id });
      assert.deepEqual([after.digestState, after.digestError], ['released', 'test release']);
    });

    await t.test('push subscriptions: one row per endpoint, taken over by whoever subscribes last, expired on 410', async () => {
      const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
      const keys = { auth: 'auth-secret-1', p256dh: 'p'.repeat(87) };
      const first = await repository.savePushSubscription({ endpoint, keys, principalId: mo.id, principalType: 'user', userAgent: 'Safari' });
      const again = await repository.savePushSubscription({ endpoint, keys: { ...keys, auth: 'auth-secret-2' }, principalId: lena.id, principalType: 'user', userAgent: 'Safari' });
      assert.equal(again.id, first.id);
      assert.equal(again.principalId, lena.id);
      assert.deepEqual(await repository.listPushSubscriptions({ principalId: mo.id, principalType: 'user' }), []);
      assert.equal((await repository.listPushSubscriptions({ principalId: lena.id, principalType: 'user' }))[0].keys.auth, 'auth-secret-2');
      await repository.touchPushSubscription({ id: first.id });
      await repository.expirePushSubscription({ id: first.id });
      assert.deepEqual(await repository.listPushSubscriptions({ principalId: lena.id, principalType: 'user' }), []);
      assert.equal(await repository.removePushSubscription({ endpoint, principalId: mo.id, principalType: 'user' }), false, 'only the owner removes it');
      assert.equal(await repository.removePushSubscription({ endpoint, principalId: lena.id, principalType: 'user' }), true);
    });

    await t.test('focus: a heartbeat holds until it runs out or the tab blurs', async () => {
      await repository.setFocus({ clientId: 'tab-1', focusedUntil: at(1), principalId: mo.id, principalType: 'user' });
      assert.equal(await repository.isFocused({ now: at(0), principalId: mo.id, principalType: 'user' }), true);
      assert.equal(await repository.isFocused({ now: at(2), principalId: mo.id, principalType: 'user' }), false);
      await repository.setFocus({ clientId: 'tab-1', focusedUntil: at(5), principalId: mo.id, principalType: 'user' });
      await repository.clearFocus({ clientId: 'tab-1', principalId: mo.id, principalType: 'user' });
      assert.equal(await repository.isFocused({ now: at(0), principalId: mo.id, principalType: 'user' }), false);
    });

    await t.test('retention: rows with no activity in 90 days go', async () => {
      await pool.execute('DELETE FROM notifications');
      await watched(0, 'old');
      await repository.recordNotification({ notification: { ...principal, actorId: lena.id, actorType: 'user', digestAfter: null, kind: 'mention', summary: {} }, now: at(60 * 24 * 60) });
      await repository.setFocus({ clientId: 'stale', focusedUntil: at(0), principalId: mo.id, principalType: 'user' });
      assert.equal(await repository.purgeNotifications({ before: at(30 * 24 * 60), now: at(91 * 24 * 60) }), 1);
      assert.equal((await repository.listNotifications(principal)).length, 1);
      const [focus] = await pool.execute('SELECT COUNT(*) AS count FROM notification_focus');
      assert.equal(Number(focus[0].count), 0);
    });

    await t.test('thread authors, and assignments observed only after their transaction commits', async () => {
      const root = await projectRepository.createPost({ post: { authorId: mo.id, authorType: 'user', body: 'Root', projectId, targetId: general.id, targetType: 'channel', tenantId } });
      for (const author of [lena, lena, mo]) await projectRepository.createPost({ post: { authorId: author.id, authorType: 'user', body: 'Reply', parentId: root.id, projectId, targetId: general.id, targetType: 'channel', tenantId } });
      assert.deepEqual((await projectRepository.listThreadAuthors({ parentId: root.id, tenantId })).map((row) => row.authorId).sort(), [lena.id, mo.id].sort());

      const seen = [];
      const stop = projectRepository.observeItemRevisions((revision) => { seen.push(revision); });
      t.after(stop);
      const user = { id: lena.id, memberships: [{ role: 'user', tenantId }], name: lena.name };
      const created = await projectRepository.createProjectItem({ input: { item: { assigneeId: mo.id, name: 'Draft the SOW' }, itemType: 'epic', parentId: null }, projectId, tenantId, user });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const revision = seen.find((entry) => entry.itemId === (created.item?.id ?? created.id));
      assert.ok(revision, JSON.stringify(seen.map((entry) => entry.itemId)));
      assert.equal(revision.after.node.assigneeId, mo.id);
      const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM project_item_revisions WHERE item_id = ?', [revision.itemId]);
      assert.equal(Number(rows[0].count) >= 1, true, 'committed before the observer ran');
    });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
