import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlMentionsRepository, ensureMysqlMentionReasonSchema, ensureMysqlMentionsSchema } from '../src/modules/requirements/mentions/mentions.repository.js';

// Real MySQL for the mentions store: schema and keys, dedupe per comment and person, the due
// query, claims serialized across connections, lease takeover with fencing, the deadline
// re-check under lock, retries, and releases only by a live owner. Needs
// ODIN_TEST_DATABASE_URL pointing at a disposable loopback odinpmp_test_* schema; skipped
// otherwise.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const T0 = new Date('2026-10-12T09:00:00.123Z');
const at = (minutes, ms = 0) => new Date(T0.getTime() + minutes * 60_000 + ms);
const TENANT = 'tenant-mentions';
const PROJECT = 'project-mentions';
const uma = { projectId: PROJECT, recipientId: 'user-uma', recipientType: 'user', tenantId: TENANT };
const jamie = { projectId: PROJECT, recipientId: 'stakeholder-jamie', recipientType: 'stakeholder', tenantId: TENANT };
const LEASE = 20 * 60_000;
const QUIET = 20 * 60_000;

function assertDisposableTarget() {
  const target = new URL(databaseUrl);
  assert.equal(target.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Mention database tests require loopback MySQL.');
  assert.match(decodeURIComponent(target.pathname.slice(1)), /^odinpmp_test_[A-Za-z0-9_]+$/, 'Mention database tests require a disposable test schema.');
}

function record(repo, { commentId, recipients, scheduledAt, sourceType = 'topic' }) {
  return repo.recordMentions({
    author: { actorId: 'user-mona', actorType: 'user', name: 'Mona Member' },
    projectId: PROJECT,
    recipients,
    scheduledAt,
    source: sourceType === 'topic'
      ? { commentId, topicId: 'topic-1', type: 'topic' }
      : { annotationId: 'annotation-1', commentId, roundId: 'round-1', type: 'annotation' },
    tenantId: TENANT,
  });
}

const claimAt = (repo, recipient, now) => repo.claimMentionDigest({ ...recipient, dueBefore: new Date(now.getTime() - QUIET), leaseUntil: new Date(now.getTime() + LEASE), now });

test('MySQL mentions schema, dedupe, due list, claims, fencing, retries and releases', { skip: !databaseUrl, timeout: 60_000 }, async () => {
  assertDisposableTarget();
  const pool = mysql.createPool(databaseUrl);
  const other = mysql.createPool(databaseUrl);
  try {
    await pool.query('DROP TABLE IF EXISTS requirements_mention_digests');
    await pool.query('DROP TABLE IF EXISTS requirements_mentions');
    await ensureMysqlMentionsSchema(pool);
    await ensureMysqlMentionsSchema(pool);
    await ensureMysqlMentionReasonSchema(pool);
    const [keys] = await pool.query(`SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('requirements_mentions', 'requirements_mention_digests')
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`);
    const key = (name) => keys.find((entry) => entry.name === name);
    assert.deepEqual(key('uq_requirements_mentions_comment_recipient'), { columns: 'source_type,comment_id,recipient_type,recipient_id', name: 'uq_requirements_mentions_comment_recipient', nonUnique: 0, tableName: 'requirements_mentions' });
    assert.deepEqual(key('uq_requirements_mention_digests_recipient'), { columns: 'tenant_id,project_id,recipient_type,recipient_id', name: 'uq_requirements_mention_digests_recipient', nonUnique: 0, tableName: 'requirements_mention_digests' });
    const [collations] = await pool.query(`SELECT DISTINCT TABLE_COLLATION AS collation FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('requirements_mentions', 'requirements_mention_digests')`);
    assert.deepEqual(collations.map((row) => row.collation), ['utf8mb4_unicode_ci'], 'both tables share one collation, so the due join compares directly');

    const repo = createMysqlMentionsRepository({ pool });
    const rival = createMysqlMentionsRepository({ pool: other });

    // Dedupe: the same comment and person is recorded once, across both connections.
    const people = [{ actorId: 'user-uma', actorType: 'user' }, { actorId: 'stakeholder-jamie', actorType: 'stakeholder' }];
    assert.equal((await record(repo, { commentId: 'c1', recipients: people, scheduledAt: at(0) })).length, 2);
    assert.equal((await record(rival, { commentId: 'c1', recipients: [people[0]], scheduledAt: at(1) })).length, 0, 'the unique key rejects a duplicate');
    assert.equal((await record(repo, { commentId: 'c1', recipients: [people[0]], scheduledAt: at(1), sourceType: 'annotation' })).length, 1, 'an annotation comment with the same id is a different source');
    await record(repo, { commentId: 'c2', recipients: [people[0]], scheduledAt: at(10, 456) });
    const pending = await repo.listPendingMentions(uma);
    assert.deepEqual(pending.map((row) => [row.commentId, row.sourceType, row.scheduledAt]), [
      ['c1', 'topic', at(0).toISOString()],
      ['c1', 'annotation', at(1).toISOString()],
      ['c2', 'topic', at(10, 456).toISOString()],
    ], 'scheduled_at keeps milliseconds');

    // Due once the newest mention is more than the quiet period old, strictly.
    const due = async (now) => (await repo.listDueMentionDigests({ dueBefore: new Date(now.getTime() - QUIET), now })).map((row) => row.recipientId).sort();
    assert.deepEqual(await due(at(20, 123)), ['stakeholder-jamie']);
    assert.deepEqual(await due(at(30, 456)), ['stakeholder-jamie'], 'exactly the quiet period is not past it');
    assert.deepEqual(await due(at(30, 457)), ['stakeholder-jamie', 'user-uma']);

    // Two concurrent claims from separate pools: one winner.
    const now = at(31);
    const claims = await Promise.all([claimAt(repo, uma, now), claimAt(rival, uma, now)]);
    const winner = claims.filter(Boolean);
    assert.equal(winner.length, 1, 'exactly one claimant wins');
    const owner = { ...uma, claimToken: winner[0].claimToken, deliveryId: winner[0].deliveryId };
    assert.deepEqual(await due(at(32)), ['stakeholder-jamie'], 'a live claim is not listed as due');

    // A new mention during the claim makes the send not due and gives up the claim.
    await record(repo, { commentId: 'c3', recipients: [people[0]], scheduledAt: at(32) });
    const sendIds = pending.map((row) => row.id);
    assert.deepEqual(await repo.beginMentionDigestSend({ ...owner, dueBefore: new Date(at(33).getTime() - QUIET), leaseUntil: at(53), now: at(33), sendIds }), { ok: false, reason: 'not-due' });
    assert.equal(await claimAt(repo, uma, at(40)), null, 'still inside the new quiet period');

    // After the new deadline: claim, a failed send retries, then completes.
    const second = await claimAt(repo, uma, at(53));
    assert.ok(second);
    const owner2 = { ...uma, claimToken: second.claimToken, deliveryId: second.deliveryId };
    const allIds = (await repo.listPendingMentions(uma)).map((row) => row.id);
    assert.deepEqual(await repo.beginMentionDigestSend({ ...owner2, dueBefore: new Date(at(53).getTime() - QUIET), leaseUntil: at(73), now: at(53), sendIds: allIds }), { ok: true });
    assert.deepEqual(await repo.failMentionDigestAttempt({ ...owner2, error: '421 later', maxAttempts: 3, mentionIds: allIds, now: at(54), retryAt: at(59) }), { attempts: 1, terminal: false });
    assert.equal(await claimAt(repo, uma, at(58)), null, 'waits for the retry time');
    const third = await claimAt(repo, uma, at(59, 1));
    const owner3 = { ...uma, claimToken: third.claimToken, deliveryId: third.deliveryId };
    assert.equal(third.attempts, 1);

    // The lease runs out; a new owner takes over and the old one is fenced.
    const takeover = await claimAt(rival, uma, at(80));
    assert.ok(takeover, 'an expired lease is taken over');
    const owner4 = { ...uma, claimToken: takeover.claimToken, deliveryId: takeover.deliveryId };
    assert.deepEqual(await repo.releaseMentionDigest({ ...owner3, now: at(81), released: [{ id: allIds[0], reason: 'stale' }] }), { fenced: true });
    assert.deepEqual(await repo.failMentionDigestAttempt({ ...owner3, error: 'x', maxAttempts: 3, mentionIds: allIds, now: at(81), retryAt: null }), { fenced: true });
    assert.equal((await repo.listPendingMentions(uma)).length, 4, 'the fenced owner changed nothing');

    // The live owner sends three, releases one.
    const [released, ...sent] = allIds;
    assert.deepEqual(await rival.beginMentionDigestSend({ ...owner4, dueBefore: new Date(at(81).getTime() - QUIET), leaseUntil: at(101), now: at(81), sendIds: sent }), { ok: true });
    await rival.completeMentionDigestSend({ ...owner4, now: at(82), providerMessageId: '<m1>', released: [{ id: released, reason: 'mention digest: the comment was removed' }], sentIds: sent });
    const [rows] = await pool.query('SELECT id, status, last_error AS lastError, delivery_id AS deliveryId FROM requirements_mentions WHERE recipient_id = ? ORDER BY scheduled_at', ['user-uma']);
    assert.deepEqual(rows.map((row) => row.status).sort(), ['released', 'sent', 'sent', 'sent']);
    assert.equal(rows.find((row) => row.id === released).lastError, 'mention digest: the comment was removed');
    assert.ok(rows.filter((row) => row.status === 'sent').every((row) => row.deliveryId === takeover.deliveryId));
    assert.equal(await repo.getMentionDigest(uma), null, 'the delivery row is gone');

    // Terminal failure marks the stakeholder's mention failed.
    const jamieClaim = await claimAt(repo, jamie, at(90));
    const jamieOwner = { ...jamie, claimToken: jamieClaim.claimToken, deliveryId: jamieClaim.deliveryId };
    const jamieIds = (await repo.listPendingMentions(jamie)).map((row) => row.id);
    await repo.beginMentionDigestSend({ ...jamieOwner, dueBefore: new Date(at(90).getTime() - QUIET), leaseUntil: at(110), now: at(90), sendIds: jamieIds });
    assert.deepEqual(await repo.failMentionDigestAttempt({ ...jamieOwner, error: '550 no such user', maxAttempts: 3, mentionIds: jamieIds, now: at(91), retryAt: null }), { attempts: 1, terminal: true });
    const [jamieRows] = await pool.query('SELECT status FROM requirements_mentions WHERE recipient_id = ?', ['stakeholder-jamie']);
    assert.deepEqual(jamieRows.map((row) => row.status), ['failed']);
    assert.deepEqual(await due(at(200)), [], 'nothing is left to send');
  } finally {
    await pool.query('DROP TABLE IF EXISTS requirements_mention_digests').catch(() => {});
    await pool.query('DROP TABLE IF EXISTS requirements_mentions').catch(() => {});
    await pool.end();
    await other.end();
  }
});
