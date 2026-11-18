import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { createMysqlAssistantRepository, ensureMysqlClarificationSchema } from '../src/modules/assistant/assistant.repository.js';
import { flushDueClarificationInvitationDigests } from '../src/modules/assistant/clarification-invitation-digest.service.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { ensureMysqlRequirementsTracksSchema } from '../src/modules/requirements/requirements.repository.js';

// Real MySQL for the clarification digest: the in-place upgrade of an existing invitations
// table, the delivery table's unique recipient key, scheduling inside the save transaction,
// claims serialized across connections, lease takeover with fencing, the deadline re-check
// under lock, and releases fenced by owner, lease and schedule. Needs ODIN_TEST_DATABASE_URL pointing at a disposable loopback
// odinpmp_test_* schema; skipped otherwise.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const T0 = new Date('2026-10-10T09:00:00.123Z');
const at = (minutes, ms = 0) => new Date(T0.getTime() + minutes * 60_000 + ms);
const TENANT = 'tenant-digest';
const PROJECT = 'project-digest';
const recipient = { projectId: PROJECT, stakeholderId: 'stake-1', tenantId: TENANT };
const TABLES = [
  'project_clarification_invitation_digests', 'project_clarification_email_messages', 'project_clarification_invitations',
  'project_clarification_comment_reactions', 'project_clarification_comments', 'project_clarification_assignments',
  'project_clarifications', 'project_stakeholders', 'assistant_other_intent_logs', 'preferences',
];

function assertDisposableTarget() {
  const target = new URL(databaseUrl);
  assert.equal(target.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Digest database tests require loopback MySQL.');
  assert.match(decodeURIComponent(target.pathname.slice(1)), /^odinpmp_test_[A-Za-z0-9_]+$/, 'Digest database tests require a disposable test schema.');
}

test('MySQL digest schema, scheduling, claims, fencing and deadline under lock', { skip: !databaseUrl, timeout: 60_000 }, async () => {
  assertDisposableTarget();
  const pool = mysql.createPool(databaseUrl);
  const other = mysql.createPool(databaseUrl);
  const dropAll = async () => { for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS ${table}`); };
  try {
    await dropAll();
    // The invitations table as it exists in production today, before this change.
    await pool.query(`CREATE TABLE project_clarification_invitations (
      id VARCHAR(36) NOT NULL PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, clarification_id VARCHAR(36) NOT NULL,
      stakeholder_id VARCHAR(36) NOT NULL, invitation_token VARCHAR(120) NOT NULL, reply_token VARCHAR(120) NOT NULL,
      mail_status VARCHAR(24) NOT NULL DEFAULT 'pending', queued_at DATETIME NULL, sent_at DATETIME NULL, last_inbound_at DATETIME NULL,
      last_provider_message_id VARCHAR(255) NULL, last_error TEXT NULL, deactivated_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_project_clarification_invitations_token (invitation_token), UNIQUE KEY uq_project_clarification_reply_token (reply_token),
      KEY idx_project_clarification_invitations_scope (tenant_id, project_id, clarification_id), KEY idx_project_clarification_invitations_stakeholder (stakeholder_id))`);
    await ensureMysqlClarificationSchema(pool);
    await ensureMysqlClarificationSchema(pool);
    await ensureMysqlRequirementsTracksSchema(pool);
    const [columns] = await pool.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_clarification_invitations' AND COLUMN_NAME IN ('scheduled_at', 'delivery_id')`);
    assert.deepEqual(Object.fromEntries(columns.map((column) => [column.name, column.type])), { delivery_id: 'varchar(36)', scheduled_at: 'datetime(3)' }, 'the upgrade added the columns in place');
    const [keys] = await pool.query(`SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_clarification_invitation_digests' GROUP BY INDEX_NAME, NON_UNIQUE`);
    assert.deepEqual(keys.find((key) => key.name === 'uq_project_clarification_invitation_digests_recipient'), { columns: 'tenant_id,project_id,stakeholder_id', name: 'uq_project_clarification_invitation_digests_recipient', nonUnique: 0 });

    const repo = createMysqlAssistantRepository({ pool });
    const otherRepo = createMysqlAssistantRepository({ pool: other });
    await repo.createProjectStakeholder({ projectId: PROJECT, tenantId: TENANT, value: { email: 'sam@client.example', id: 'stake-1', name: 'Sam' } });
    await repo.syncProjectClarifications({ clarifications: ['c-1', 'c-2', 'c-3'].map((id) => ({ assignments: [], id, prompt: `Question ${id}?`, status: 'open' })), projectId: PROJECT, tenantId: TENANT });
    const people = [{ actorId: 'stake-1', actorType: 'stakeholder', role: 'primary' }];
    const invitation = async (clarificationId) => {
      const [rows] = await pool.query('SELECT * FROM project_clarification_invitations WHERE clarification_id = ? AND deactivated_at IS NULL', [clarificationId]);
      return rows[0] ?? null;
    };

    // A refused save leaves nothing behind; a saved one is scheduled in the same transaction, to the millisecond.
    await assert.rejects(repo.updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: people, expectedInvitationStakeholderIds: [], scheduleInvitationsAt: at(0) }, projectId: PROJECT, tenantId: TENANT }), (error) => error.statusCode === 409);
    assert.equal(await invitation('c-1'), null);
    await repo.updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: people, expectedInvitationStakeholderIds: ['stake-1'], scheduleInvitationsAt: at(0) }, projectId: PROJECT, tenantId: TENANT });
    assert.equal(new Date((await invitation('c-1')).scheduled_at).toISOString(), at(0).toISOString());

    // Not due at exactly 20 minutes; due just after.
    assert.deepEqual(await repo.listDueClarificationInvitationDigests({ dueBefore: at(0), now: at(20) }), []);
    assert.equal((await repo.listDueClarificationInvitationDigests({ dueBefore: at(0, 1), now: at(20, 1) })).length, 1);

    // A claimant mid-transaction holds the recipient's invitation rows: a second claimant waits
    // for it, then sees its delivery row and backs off.
    const holder = await other.getConnection();
    try {
      await holder.beginTransaction();
      await holder.query("SELECT id FROM project_clarification_invitations WHERE tenant_id = ? AND project_id = ? AND stakeholder_id = ? AND deactivated_at IS NULL AND queued_at IS NULL AND mail_status = 'pending' FOR UPDATE", [TENANT, PROJECT, 'stake-1']);
      await holder.query('INSERT INTO project_clarification_invitation_digests (id, tenant_id, project_id, stakeholder_id, claim_token, claimed_until, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)', ['held-delivery', TENANT, PROJECT, 'stake-1', 'held-token', at(41), at(21), at(21)]);
      let settled = false;
      const waiting = repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(0, 1), leaseUntil: at(41), now: at(21) }).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(settled, false, 'the second claimant waits on the invitation row locks');
      await holder.commit();
      assert.equal(await waiting, null, 'and then backs off from the live claim');
    } finally {
      holder.release();
    }
    await pool.query('DELETE FROM project_clarification_invitation_digests WHERE id = ?', ['held-delivery']);

    // Two connections claim at once: the invitation row locks and the unique key allow one.
    const claims = await Promise.all([
      repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(0, 1), leaseUntil: at(41), now: at(21) }),
      otherRepo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(0, 1), leaseUntil: at(41), now: at(21) }),
    ]);
    const winner = claims.find(Boolean);
    assert.equal(claims.filter(Boolean).length, 1);
    await assert.rejects(pool.query('INSERT INTO project_clarification_invitation_digests (id, tenant_id, project_id, stakeholder_id, attempts, created_at, updated_at) VALUES (UUID(), ?, ?, ?, 0, NOW(3), NOW(3))', [TENANT, PROJECT, 'stake-1']), (error) => error.code === 'ER_DUP_ENTRY');

    // The winner's lease expires; a replacement takes over and the old owner is fenced out.
    const takeover = await otherRepo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(0, 1), leaseUntil: at(62), now: at(42) });
    assert.equal(takeover.deliveryId, winner.deliveryId);
    assert.notEqual(takeover.claimToken, winner.claimToken);
    const c1 = (await invitation('c-1')).id;
    assert.deepEqual(await repo.beginClarificationDigestSend({ ...recipient, claimToken: winner.claimToken, deliveryId: winner.deliveryId, dueBefore: at(0, 1), leaseUntil: at(63), now: at(43), sendIds: [c1] }), { ok: false, reason: 'fenced' });

    // A new assignment while the replacement holds the claim: the re-check under lock postpones the send.
    await repo.updateProjectClarification({ clarificationId: 'c-2', patch: { assignments: people, scheduleInvitationsAt: at(43) }, projectId: PROJECT, tenantId: TENANT });
    assert.deepEqual(await otherRepo.beginClarificationDigestSend({ ...recipient, claimToken: takeover.claimToken, deliveryId: takeover.deliveryId, dueBefore: at(23), leaseUntil: at(64), now: at(43, 500), sendIds: [c1] }), { ok: false, reason: 'not-due' });
    assert.equal((await repo.getClarificationInvitationDigest(recipient)).claimToken, null, 'the postponed claim is released');

    // After the newest deadline: claim, begin and complete the whole batch.
    const final = await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(43, 1), leaseUntil: at(84), now: at(63, 1) });
    const c2 = (await invitation('c-2')).id;
    assert.deepEqual(await repo.beginClarificationDigestSend({ ...recipient, claimToken: final.claimToken, deliveryId: final.deliveryId, dueBefore: at(43, 1), leaseUntil: at(84), now: at(63, 2), sendIds: [c1, c2] }), { ok: true });
    await repo.completeClarificationDigestSend({ ...recipient, claimToken: final.claimToken, deliveryId: final.deliveryId, now: at(63, 3), providerMessageId: '<m@fixture>', sentIds: [c1, c2] });
    for (const id of ['c-1', 'c-2']) {
      const row = await invitation(id);
      assert.deepEqual([row.mail_status, row.delivery_id, Boolean(row.queued_at)], ['sent', final.deliveryId, true], id);
    }
    assert.equal(await repo.getClarificationInvitationDigest(recipient), null);
    // The fenced owner's late completion changes nothing.
    await repo.completeClarificationDigestSend({ ...recipient, claimToken: winner.claimToken, deliveryId: winner.deliveryId, now: at(70), providerMessageId: '<late@fixture>', sentIds: [c1] });
    assert.equal((await invitation('c-1')).last_provider_message_id, '<m@fixture>');

    // A session sync that schedules runs in its own transaction; a project-wide schedule picks up the rest.
    await repo.updateProjectClarification({ clarificationId: 'c-3', patch: { assignments: people }, projectId: PROJECT, tenantId: TENANT });
    assert.equal((await invitation('c-3')).scheduled_at, null);
    await repo.syncProjectClarifications({ clarifications: [], projectId: PROJECT, scheduleInvitations: { at: at(80), clarificationIds: null }, tenantId: TENANT });
    assert.equal(new Date((await invitation('c-3')).scheduled_at).toISOString(), at(80).toISOString());

    // Recheck finding 2: an owner's send began, its lease ran out and a replacement took over.
    // Its late completion, which had decided to leave c-3 out, must not release c-3.
    const c3 = (await invitation('c-3')).id;
    const c3Release = { id: c3, reason: 'digest: the clarification is closed', scheduledAt: at(80).toISOString() };
    const stale = await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(80, 1), leaseUntil: at(121), now: at(101) });
    assert.deepEqual(await repo.beginClarificationDigestSend({ ...recipient, claimToken: stale.claimToken, deliveryId: stale.deliveryId, dueBefore: at(80, 1), leaseUntil: at(122), now: at(101, 1), sendIds: [c3] }), { ok: true });
    const replacement = await otherRepo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(80, 1), leaseUntil: at(143), now: at(123) });
    assert.equal(replacement.interruptedSend, true);
    await repo.completeClarificationDigestSend({ ...recipient, claimToken: stale.claimToken, deliveryId: stale.deliveryId, now: at(124), released: [c3Release], sentIds: [] });
    assert.equal(new Date((await invitation('c-3')).scheduled_at).toISOString(), at(80).toISOString(), 'the obsolete owner released nothing');
    assert.equal((await repo.getClarificationInvitationDigest(recipient)).claimToken, replacement.claimToken, 'and left the replacement\'s claim alone');

    // The replacement's final check found a change: it gives up before SMTP.
    await otherRepo.abortClarificationDigestSend({ ...recipient, claimToken: replacement.claimToken, deliveryId: replacement.deliveryId, now: at(124) });
    const aborted = await repo.getClarificationInvitationDigest(recipient);
    assert.deepEqual([aborted.claimToken, aborted.claimedUntil, aborted.sendStartedAt], [null, null, null]);

    // An owner whose lease ran out, with no replacement yet, fails and releases nothing.
    const lapsed = await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(80, 1), leaseUntil: at(126), now: at(125) });
    assert.deepEqual(await repo.failClarificationDigestAttempt({ ...recipient, claimToken: lapsed.claimToken, deliveryId: lapsed.deliveryId, error: 'late', invitationIds: [c3], maxAttempts: 1, now: at(127) }), { fenced: true });
    assert.deepEqual(await repo.releaseClarificationDigest({ ...recipient, claimToken: lapsed.claimToken, deliveryId: lapsed.deliveryId, now: at(127), released: [c3Release] }), { fenced: true });
    assert.deepEqual([(await invitation('c-3')).mail_status, new Date((await invitation('c-3')).scheduled_at).toISOString()], ['pending', at(80).toISOString()]);

    // A live owner's release applies only to the schedule it decided on, to the millisecond.
    const mismatched = await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(80, 1), leaseUntil: at(148), now: at(128) });
    await repo.releaseClarificationDigest({ ...recipient, claimToken: mismatched.claimToken, deliveryId: mismatched.deliveryId, now: at(129), released: [{ ...c3Release, scheduledAt: at(80, 1).toISOString() }] });
    assert.equal(new Date((await invitation('c-3')).scheduled_at).toISOString(), at(80).toISOString());
    const matched = await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(80, 1), leaseUntil: at(150), now: at(130) });
    assert.deepEqual(await repo.releaseClarificationDigest({ ...recipient, claimToken: matched.claimToken, deliveryId: matched.deliveryId, now: at(131), released: [c3Release] }), { fenced: false });
    assert.deepEqual([(await invitation('c-3')).scheduled_at, (await invitation('c-3')).last_error], [null, c3Release.reason]);
    assert.equal(await repo.getClarificationInvitationDigest(recipient), null);
  } finally {
    await dropAll().catch(() => {});
    await pool.end();
    await other.end();
  }
});

// Production has the invitations table (and the tables beside it) in utf8mb4_0900_ai_ci and
// the digests table in utf8mb4_unicode_ci, the database default when it was created. The
// minute job's due selection joins the two. Both directions run, through the real job.
const COLLATION_LAYOUTS = [
  { digests: 'utf8mb4_unicode_ci', invitations: 'utf8mb4_0900_ai_ci' },
  { digests: 'utf8mb4_0900_ai_ci', invitations: 'utf8mb4_unicode_ci' },
];

for (const layout of COLLATION_LAYOUTS) {
  test(`MySQL digests are selected and sent with invitations in ${layout.invitations} and digests in ${layout.digests}`, { skip: !databaseUrl, timeout: 60_000 }, async () => {
    assertDisposableTarget();
    const pool = mysql.createPool(databaseUrl);
    const dropAll = async () => { for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS ${table}`); };
    try {
      await dropAll();
      await ensureMysqlClarificationSchema(pool);
      await ensureMysqlRequirementsTracksSchema(pool);
      await pool.query('CREATE TABLE preferences (id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NULL, project_id VARCHAR(36) NULL, `key` VARCHAR(191) NOT NULL, value MEDIUMTEXT NOT NULL)');
      const [tables] = await pool.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      for (const { name } of tables) {
        const collation = name === 'project_clarification_invitation_digests' ? layout.digests : layout.invitations;
        await pool.query(`ALTER TABLE ${name} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${collation}`);
      }
      const [keyColumns] = await pool.query(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLLATION_NAME AS collation FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('project_clarification_invitations', 'project_clarification_invitation_digests')
          AND COLUMN_NAME IN ('tenant_id', 'project_id', 'stakeholder_id')`);
      assert.equal(keyColumns.length, 6);
      for (const column of keyColumns) {
        assert.equal(column.collation, column.tableName === 'project_clarification_invitations' ? layout.invitations : layout.digests, `${column.tableName}.${column.columnName}`);
      }

      const repo = createMysqlAssistantRepository({ pool });
      await repo.createProjectStakeholder({ projectId: PROJECT, tenantId: TENANT, value: { email: 'sam@client.example', id: 'stake-1', name: 'Sam' } });
      await repo.syncProjectClarifications({ clarifications: [{ assignments: [], id: 'c-1', prompt: 'Question c-1?', status: 'open' }], projectId: PROJECT, tenantId: TENANT });
      await repo.updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: [{ actorId: 'stake-1', actorType: 'stakeholder', role: 'primary' }], scheduleInvitationsAt: at(0) }, projectId: PROJECT, tenantId: TENANT });
      const transport = {
        failures: [],
        sent: [],
        async sendMail(message) {
          if (transport.failures.length) throw new Error(transport.failures.shift());
          transport.sent.push(message);
          return { messageId: `<digest-${transport.sent.length}@fixture>` };
        },
      };
      const mailRepository = createInMemoryMailRepository();
      const flush = (now) => flushDueClarificationInvitationDigests({
        assistantRepository: repo, mailReplyDomain: 'reply.fixture.example', mailRepository, now: () => now,
        projectRepository: { getProjectDetail: async () => ({ name: 'Atlas' }) }, transport,
      });
      const due = (now) => repo.listDueClarificationInvitationDigests({ dueBefore: new Date(now.getTime() - 20 * 60_000), now });
      const group = [{ lastScheduledAt: at(0).toISOString(), projectId: PROJECT, stakeholderId: 'stake-1', tenantId: TENANT }];

      // Before the boundary nothing is selected; just after it the group is.
      assert.deepEqual(await due(at(20)), []);
      assert.deepEqual(await flush(at(20)), { deferred: 0, due: 0, errors: 0, failed: 0, retried: 0, sent: 0, skipped: 0 });
      assert.deepEqual(await due(at(20, 1)), group);

      // The join matches the delivery row across collations: a live claim is left out, an expired one is not.
      assert.ok(await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(0, 1), leaseUntil: at(21), now: at(20, 1) }));
      assert.deepEqual(await due(at(20, 2)), [], 'a live claim is excluded');
      assert.deepEqual(await due(at(21)), group, 'an expired claim is selected again');

      // The minute job: a soft failure waits for its retry, then the digest goes out once.
      transport.failures.push('421 try again later');
      assert.equal((await flush(at(22))).retried, 1);
      assert.deepEqual(await due(at(26)), [], 'a pending retry is excluded');
      assert.equal((await flush(at(27, 1))).sent, 1);
      assert.deepEqual(transport.sent.map((message) => message.to), ['sam@client.example']);
      assert.ok(transport.sent[0].html.includes('Question c-1?'));
      const [[row]] = await pool.query("SELECT mail_status AS status, delivery_id AS deliveryId FROM project_clarification_invitations WHERE clarification_id = 'c-1'");
      assert.equal(row.status, 'sent');
      assert.ok(row.deliveryId);
      assert.equal(await repo.getClarificationInvitationDigest(recipient), null);
      assert.deepEqual(await due(at(60)), []);
      assert.equal((await flush(at(60))).sent, 0);
    } finally {
      await dropAll().catch(() => {});
      await pool.end();
    }
  });
}
