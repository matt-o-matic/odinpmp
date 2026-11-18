import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema, mysqlMigrationDefinitions } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createMysqlAccessRepository } from '../src/modules/access/access.repository.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlAuthRepository } from '../src/modules/auth/auth.repository.js';
import { addEngagementGuestsAsStakeholders } from '../src/modules/engagements/engagements.service.js';
import { createMysqlGuestSessionsRepository } from '../src/modules/guests/guest-sessions.repository.js';
import { guestMemberships } from '../src/modules/guests/guests.service.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// Migration 0098 and the MySQL side of channel guests: sign-in codes and sessions stored hashed,
// with times that survive the session time zone; guests added to and removed from channels; the
// memberships every guest route goes through; the access link a guest signs in with; and the
// conversion check that keeps every guest a stakeholder. guests.test.js covers the routes.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: 0098 guest sessions, channel guests, memberships and the conversion check', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_guests_${process.pid}`;
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
    // The release before 0098, then 0098 and the rest, twice.
    await runMysqlMigrations({ executor: pool, migrations: mysqlMigrationDefinitions().filter((migration) => migration.id < '0098') });
    const [before] = await pool.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('access_sign_in_codes', 'access_sessions')");
    assert.equal(before.length, 0);
    await bootstrapMysqlSchema({ executor: pool });
    await bootstrapMysqlSchema({ executor: pool });
    const [tables] = await pool.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('access_sign_in_codes', 'access_sessions') ORDER BY TABLE_NAME");
    assert.deepEqual(tables.map((row) => row.name), ['access_sessions', 'access_sign_in_codes']);
    const [indexes] = await pool.execute("SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'access_sessions' AND INDEX_NAME = 'uq_access_sessions_token'");
    assert.equal(Number(indexes[0]?.nonUnique), 0, 'one session per token hash');

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Guest Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [ada.id, ada.name, `${ada.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    for (const [id, name] of [[projectId, 'Pursuit'], [otherProjectId, 'Other']]) {
      await pool.execute("INSERT INTO projects (id, tenant_id, name, description, project_status, deleted, kind, engagement_status, engagement_customer) VALUES (?, ?, ?, '', ?, 0, 'engagement', 'open', 'Northwind')", [id, tenantId, name, statuses[0].id]);
    }

    const storage = createMemoryLargeFileStorage();
    const projects = createMysqlProjectsRepository({ fileStorage: storage, pool });
    const assistant = createMysqlAssistantRepository({ pool });
    const access = createMysqlAccessRepository({ pool });
    const sessions = createMysqlGuestSessionsRepository({ pool });
    const auth = createMysqlAuthRepository({ pool });
    const modules = createMysqlWorkspaceModulesRepository({ pool });

    assert.deepEqual(await projects.getProjectHeader({ projectId, tenantId }), { customer: 'Northwind', engagementStatus: 'open', id: projectId, kind: 'engagement', name: 'Pursuit', tenantId });
    assert.equal(await projects.getProjectHeader({ projectId, tenantId: randomUUID() }), null, 'another workspace sees no header');

    // The guest: a stakeholder on the project, the workspace's access link, two channels.
    const email = 'gina@northwind.example';
    const stakeholder = await assistant.createProjectStakeholder({ projectId, tenantId, value: { email, name: 'Gina Guest', roleTitle: 'Northwind' } });
    const link = await access.ensureLink({ createdBy: ada.id, email, now: new Date(), tenantId });
    assert.equal((await access.ensureLink({ createdBy: ada.id, email: email.toUpperCase(), now: new Date(), tenantId })).id, link.id, 'one link per workspace and email');
    assert.deepEqual((await access.listLinksByEmail({ email })).map((entry) => entry.id), [link.id]);
    assert.equal((await access.findLinkById({ linkId: link.id })).email, email);
    await access.revokeLink({ linkId: link.id, now: new Date(), revokedBy: ada.id, tenantId });
    assert.equal((await access.ensureLink({ createdBy: ada.id, email, now: new Date(), tenantId })).revokedAt, null, 'inviting again brings a revoked link back');

    const general = await projects.ensureGeneralChannel({ projectId, tenantId, userId: ada.id });
    const deal = await projects.createChannel({ name: 'Deal room', projectId, tenantId, user: ada });
    const first = await projects.addChannelGuest({ channel: deal, invitedBy: ada.id, stakeholder });
    assert.equal(first.added, true);
    assert.equal((await projects.addChannelGuest({ channel: deal, invitedBy: ada.id, stakeholder })).added, false, 'once per channel');
    assert.deepEqual((await projects.listChannelGuests({ channelId: deal.id, tenantId })).map((guest) => [guest.stakeholderId, guest.email, guest.name, guest.invitedBy]), [[stakeholder.id, email, 'Gina Guest', ada.id]]);
    assert.deepEqual(await projects.listChannelGuests({ channelId: general.id, tenantId }), []);
    const rows = await projects.listGuestMemberships({ stakeholderIds: [stakeholder.id], tenantId });
    assert.deepEqual(rows.map((row) => [row.channelId, row.projectId]), [[deal.id, projectId]]);
    assert.deepEqual(await projects.listGuestMemberships({ stakeholderIds: [stakeholder.id], tenantId: randomUUID() }), [], 'by workspace');

    // The shared membership function over MySQL: engagements need the Consulting module.
    const deps = { assistantRepository: assistant, projectRepository: projects, workspaceModulesRepository: modules };
    assert.deepEqual(await guestMemberships(deps, { email, tenantId }), [], 'module off: no engagement channels');
    await modules.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId, userId: ada.id });
    assert.deepEqual((await guestMemberships(deps, { email, tenantId })).map((entry) => [entry.channelId, entry.stakeholder.id, entry.project.name]), [[deal.id, stakeholder.id, 'Pursuit']]);

    // Change log rows carry no name or address.
    const [changes] = await pool.execute("SELECT action, detail_json AS detail FROM project_change_log WHERE entity_type = 'channel_guest' AND project_id = ?", [projectId]);
    assert.deepEqual(changes.map((row) => row.action), ['invite']);
    assert.ok(!JSON.stringify(changes).includes(email));

    // Sign-in codes: one per link, replaced by a new one, attempts counted, used once.
    const sentAt = new Date('2026-11-14T09:00:00.000Z');
    await sessions.saveSignInCode({ accessLinkId: link.id, codeHash: 'a'.repeat(64), sentAt, tenantId });
    await sessions.saveSignInCode({ accessLinkId: link.id, codeHash: 'b'.repeat(64), sentAt, tenantId });
    const code = await sessions.getSignInCode({ accessLinkId: link.id });
    assert.deepEqual([code.codeHash, code.sentAt, code.attempts, code.usedAt], ['b'.repeat(64), sentAt.toISOString(), 0, null]);
    assert.equal(await sessions.recordCodeAttempt({ accessLinkId: link.id, codeHash: 'b'.repeat(64) }), 1);
    assert.equal(await sessions.recordCodeAttempt({ accessLinkId: link.id, codeHash: 'a'.repeat(64) }), null, 'a replaced code counts nothing');
    assert.equal(await sessions.useSignInCode({ accessLinkId: link.id, at: sentAt, codeHash: 'b'.repeat(64), maxAttempts: 1 }), false, 'a locked code cannot be used');
    await sessions.saveSignInCode({ accessLinkId: link.id, codeHash: 'c'.repeat(64), sentAt, tenantId });
    const uses = await Promise.all([1, 2, 3].map(() => sessions.useSignInCode({ accessLinkId: link.id, at: sentAt, codeHash: 'c'.repeat(64), maxAttempts: 5 })));
    assert.deepEqual(uses.filter(Boolean).length, 1, 'used once however many ask at once');

    // Sessions: created, renewed only while live, revoked, and last seen per link.
    const created = await sessions.createSession({ accessLinkId: link.id, createdAt: sentAt, expiresAt: new Date(sentAt.valueOf() + 30 * 86_400_000), id: randomUUID(), ip: '203.0.113.9', lastSeenAt: sentAt, tenantId, tokenHash: 'd'.repeat(64), userAgent: 'Safari' });
    assert.equal(created.expiresAt, new Date(sentAt.valueOf() + 30 * 86_400_000).toISOString());
    const found = await sessions.findSessionByTokenHash({ tokenHash: 'd'.repeat(64) });
    assert.deepEqual([found.id, found.ip, found.userAgent, found.revokedAt], [created.id, '203.0.113.9', 'Safari', null]);
    const later = new Date(sentAt.valueOf() + 10 * 86_400_000);
    assert.equal(await sessions.touchSession({ at: later, expiresAt: new Date(later.valueOf() + 30 * 86_400_000), id: created.id }), true);
    assert.equal((await sessions.findSessionByTokenHash({ tokenHash: 'd'.repeat(64) })).expiresAt, new Date(later.valueOf() + 30 * 86_400_000).toISOString());
    const tooLate = new Date(later.valueOf() + 31 * 86_400_000);
    assert.equal(await sessions.touchSession({ at: tooLate, expiresAt: new Date(tooLate.valueOf() + 30 * 86_400_000), id: created.id }), false, 'an expired session is not renewed');
    assert.equal((await sessions.lastSeenByLinks({ accessLinkIds: [link.id] })).get(link.id), later.toISOString());
    await sessions.createSession({ accessLinkId: link.id, createdAt: later, expiresAt: tooLate, id: randomUUID(), lastSeenAt: later, tenantId, tokenHash: 'e'.repeat(64) });
    assert.equal(await sessions.revokeSessionsForLink({ accessLinkId: link.id, at: later }), 2);
    assert.ok((await sessions.findSessionByTokenHash({ tokenHash: 'e'.repeat(64) })).revokedAt);
    await assert.rejects(sessions.createSession({ accessLinkId: link.id, createdAt: later, expiresAt: tooLate, id: randomUUID(), lastSeenAt: later, tenantId, tokenHash: 'e'.repeat(64) }), (error) => error.code === 'ER_DUP_ENTRY');

    // The file owner account guests' files are recorded under.
    const owner = await auth.findOrCreateStakeholderOwner({ email, name: 'Gina Guest' });
    assert.ok(owner?.id);
    assert.equal((await auth.findUserById(owner.id)).loginDisabled, true, 'it cannot sign in');

    // Conversion: every guest is a stakeholder; one whose record went refuses the conversion.
    const connection = await pool.getConnection();
    try {
      assert.equal(await addEngagementGuestsAsStakeholders({ executor: connection, projectId, projectRepository: projects, tenantId }), 1);
      const stray = { email: 'stray@x.example', id: randomUUID(), name: 'Stray' };
      await projects.addChannelGuest({ channel: deal, invitedBy: ada.id, stakeholder: stray });
      await assert.rejects(addEngagementGuestsAsStakeholders({ executor: connection, projectId, projectRepository: projects, tenantId }), (error) => error.details?.code === 'guest_stakeholder_missing');
      await projects.removeChannelGuest({ channel: deal, removedBy: ada.id, stakeholderId: stray.id });
      assert.equal(await addEngagementGuestsAsStakeholders({ executor: connection, projectId, projectRepository: projects, tenantId }), 1);
    } finally {
      connection.release();
    }

    // Removal: the membership goes, and the row stays with who removed it.
    assert.equal(await projects.removeChannelGuest({ channel: deal, removedBy: ada.id, stakeholderId: stakeholder.id }), true);
    assert.equal(await projects.removeChannelGuest({ channel: deal, removedBy: ada.id, stakeholderId: stakeholder.id }), false);
    assert.deepEqual(await guestMemberships(deps, { email, tenantId }), []);
    const [kept] = await pool.execute('SELECT removed_by AS removedBy FROM project_channel_guests WHERE channel_id = ? AND stakeholder_id = ?', [deal.id, stakeholder.id]);
    assert.equal(kept[0].removedBy, ada.id);
    assert.equal((await projects.addChannelGuest({ channel: deal, invitedBy: ada.id, stakeholder })).added, true, 'invited again');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
