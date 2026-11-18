import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import {
  createPortalCommentForToken,
  getPortalForToken,
  resolvePortalAccess,
} from '../src/modules/requirements/requirements-portal.service.js';
import { attachRequirementsBridge, createRequirementsAssistantBridge } from '../src/modules/requirements/requirements-bridge.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import {
  createAccessLinkForUser,
  createTrackTopicForUser,
  deleteTopicForUser,
  extendAccessLinkForUser,
  getMyItemsForUser,
  getRequirementsOverviewForUser,
  listTrackTopicsForUser,
  moveTopicForUser,
  recordDecisionForUser,
  updateDecisionForUser,
  updateTopicForUser,
} from '../src/modules/requirements/requirements.service.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const REQUIREMENTS_MIGRATION_IDS = [
  '0051_requirements_tracks',
  '0052_requirements_links',
  '0053_review_packages',
  '0054_review_rounds',
  '0055_review_feedback',
  '0056_requirements_decisions',
  '0057_review_package_storage',
  '0061_review_round_details',
  '0062_requirements_plan_details',
  '0063_clarification_topics_backfill',
  '0064_review_package_replacement',
];
const DAY_MS = 24 * 60 * 60 * 1000;

test('MySQL: requirements migrations apply on top of the existing 50 and topics, links, and decisions work', { skip: !databaseUrl, timeout: 300_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_req_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());

  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try {
      await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8'));
    } finally {
      await importer.end();
    }

    // What main ships first (0001-0050 and 0058-0060), then the full list on top of it, as
    // an existing database upgrades.
    let firstMigrations = [];
    const first = await bootstrapMysqlSchema({
      executor: pool,
      runMigrations: async (options) => {
        firstMigrations = options.migrations.filter((migration) => !REQUIREMENTS_MIGRATION_IDS.includes(migration.id) && migration.id < '0061');
        const { runMysqlMigrations } = await import('../src/lib/database/schema-migrations.js');
        return runMysqlMigrations({ ...options, migrations: firstMigrations });
      },
    });
    assert.equal(first.applied.length, firstMigrations.length);
    assert.ok(first.applied.includes('0060_project_item_estimate_override'));

    // A clarification from before requirements topics: 0063 makes it an Experience topic.
    const preexistingId = randomUUID();
    await pool.execute(
      `INSERT INTO project_clarifications (id, tenant_id, project_id, linked_section, blocking_area, prompt, rationale, proposed_draft_impact,
        lifecycle_state, clarification_status, current_answer, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, 'brief', '', 'Who signs off on launch?', '', '', 'committed', 'open', '', NOW(), NOW(), NOW())`,
      [preexistingId, randomUUID(), randomUUID()],
    );

    const second = await bootstrapMysqlSchema({ executor: pool });
    assert.deepEqual(second.applied.filter((id) => id < '0065'), REQUIREMENTS_MIGRATION_IDS);
    const [[preexisting]] = await pool.execute('SELECT track, topic_origin AS origin FROM project_clarifications WHERE id = ?', [preexistingId]);
    assert.deepEqual({ ...preexisting }, { origin: 'clarification', track: 'experience' });
    const third = await bootstrapMysqlSchema({ executor: pool });
    assert.deepEqual(third.applied, [], 'checksums match and nothing reapplies');
    const [[{ migrationCount }]] = await pool.query('SELECT COUNT(*) AS migrationCount FROM schema_migrations');
    const { migrationCount: registered } = await bootstrapMysqlSchema({ executor: pool, runMigrations: async ({ migrations }) => ({ migrationCount: migrations.length }) });
    assert.equal(Number(migrationCount), registered, 'every registered migration is recorded');
    const [tables] = await pool.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'requirements_%' OR TABLE_NAME LIKE 'review_%') ORDER BY TABLE_NAME",
    );
    assert.deepEqual(tables.map((row) => row.name), [
      'requirements_access_link_tokens',
      'requirements_access_links',
      'requirements_decisions',
      'requirements_mention_digests',
      'requirements_mentions',
      'requirements_plan_proposals',
      'requirements_plans',
      'requirements_summaries',
      'review_annotations',
      'review_answers',
      'review_comments',
      'review_package_files',
      'review_package_screens',
      'review_package_uploads',
      'review_packages',
      'review_round_reviewers',
      'review_rounds',
      'review_snapshots',
      'review_verdicts',
    ]);
    const [trackColumns] = await pool.query(
      "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_clarifications' AND COLUMN_NAME IN ('track', 'topic_origin', 'created_by', 'source_ref', 'suggested_owner_role') ORDER BY COLUMN_NAME",
    );
    assert.deepEqual(trackColumns.map((row) => row.name), ['created_by', 'source_ref', 'suggested_owner_role', 'topic_origin', 'track']);

    // Fixtures: a tenant, a project, a member, and a manager.
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const memberId = randomUUID();
    const managerId = randomUUID();
    const fixtures = await mysql.createConnection({ ...connectionOptions, database });
    try {
      await fixtures.query('SET FOREIGN_KEY_CHECKS = 0');
      await fixtures.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Requirements Tenant']);
      const [statuses] = await fixtures.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
      await fixtures.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Client booking', '', statuses[0].id]);
      for (const [userId, name, role] of [[memberId, 'Mona Member', 'member'], [managerId, 'Pia Manager', 'manager']]) {
        await fixtures.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, name, `${userId}@acme.test`]);
        await fixtures.execute('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), userId, projectId, role]);
      }
    } finally {
      await fixtures.end();
    }

    const clock = { offsetMs: 0 };
    const assistantRepository = createMysqlAssistantRepository({ pool });
    const requirementsRepository = createMysqlRequirementsRepository({ pool });
    const deps = {
      assistantRepository,
      clock: () => new Date(Date.now() + clock.offsetMs),
      frontendAppUrl: 'http://localhost:5173/app',
      liveEventBus: createLiveEventBus(),
      projectRepository: createMysqlProjectsRepository({ pool }),
      requirementsRepository,
    };
    const member = { id: memberId, memberships: [{ role: 'user', tenantId }], name: 'Mona Member' };
    const manager = { id: managerId, memberships: [{ role: 'user', tenantId }], name: 'Pia Manager' };
    const stakeholder = await assistantRepository.createProjectStakeholder({
      projectId,
      tenantId,
      value: { email: 'jamie@client.example', name: 'Jamie Ortiz', roleTitle: 'Operations lead' },
    });

    // Topic create and the register query.
    const { topic } = await createTrackTopicForUser(deps, {
      input: { assignments: [], prompt: 'Should clients see a price estimate?', rationale: '', settles: 'Price display', sourceRef: 'brief:requirements:0', suggestedOwnerRole: 'Finance' },
      projectId,
      track: 'experience',
      user: member,
    });
    const unassigned = (await createTrackTopicForUser(deps, {
      input: { assignments: [], prompt: 'Which payment provider do we integrate?', rationale: '', settles: '', sourceRef: null, suggestedOwnerRole: '' },
      projectId,
      track: 'architecture',
      user: member,
    })).topic;
    assert.equal(topic.origin, 'manual');
    assert.equal(topic.createdBy.ref, `user:${memberId}`);
    assert.equal(await requirementsRepository.getTopicTrack({ clarificationId: topic.id, projectId, tenantId }), 'experience');
    const [[storedTopic]] = await pool.execute(
      'SELECT track, topic_origin AS origin, created_by AS createdBy, source_ref AS sourceRef, suggested_owner_role AS ownerRole, lifecycle_state AS lifecycle, clarification_status AS status FROM project_clarifications WHERE id = ?',
      [topic.id],
    );
    assert.deepEqual(storedTopic, { createdBy: `user:${memberId}`, lifecycle: 'committed', origin: 'manual', ownerRole: 'Finance', sourceRef: 'brief:requirements:0', status: 'open', track: 'experience' });

    await requirementsRepository.createSummary({
      projectId,
      summary: { createdAt: new Date(Date.now() - 1000), output: { insufficientInput: true, proposedAnswer: '' }, scopeId: topic.id, scopeType: 'topic', track: 'experience' },
      tenantId,
    });
    await requirementsRepository.createSummary({
      projectId,
      summary: { output: { aligned: [{ sources: ['c1'], statement: 'Yes', supporters: [] }], insufficientInput: false, proposedAnswer: 'Show the estimate.' }, scopeId: topic.id, scopeType: 'topic', track: 'experience' },
      tenantId,
    });
    const register = await listTrackTopicsForUser(deps, { projectId, query: { q: '', view: 'needs-decision' }, track: 'experience', user: member });
    assert.deepEqual(register.topics.map((row) => [row.id, row.state, row.signals.aligned]), [[topic.id, 'ready', 1]]);
    const architecture = await listTrackTopicsForUser(deps, { projectId, query: { q: 'payment', view: 'all' }, track: 'architecture', user: member });
    assert.deepEqual(architecture.topics.map((row) => row.id), [unassigned.id]);

    // Stakeholder assignment, then link validation against data written with NOW().
    await updateTopicForUser(deps, {
      input: { assignments: [{ actorId: stakeholder.id, actorType: 'stakeholder', label: '', role: 'primary' }] },
      projectId,
      topicId: topic.id,
      user: member,
    });
    const created = await createAccessLinkForUser(deps, { input: { stakeholderId: stakeholder.id }, projectId, user: manager });
    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(createAccessLinkForUser(deps, { input: { stakeholderId: stakeholder.id }, projectId, user: member }), (error) => error.statusCode === 404);

    // Every email gets its own token on the stakeholder's one link.
    const bridge = createRequirementsAssistantBridge({ clock: deps.clock, frontendAppUrl: deps.frontendAppUrl, requirementsRepository });
    const invited = await bridge.issueInvitationUrl({ projectId, stakeholderId: stakeholder.id, tenantId });
    const invitationToken = /\/requirements\/([A-Za-z0-9_-]{43})$/.exec(invited.url)[1];
    assert.equal(invited.linkId, created.link.id);
    const [tokenRows] = await pool.execute(
      'SELECT token_hash AS tokenHash, purpose, revoked_at AS revokedAt FROM requirements_access_link_tokens WHERE link_id = ? ORDER BY created_at, purpose',
      [created.link.id],
    );
    assert.deepEqual(tokenRows.map((row) => row.purpose).sort(), ['invitation', 'manual']);
    assert.ok(tokenRows.every((row) => row.tokenHash.length === 64 && row.tokenHash !== created.token && row.tokenHash !== invitationToken));
    assert.equal((await resolvePortalAccess(deps, { token: invitationToken })).link.id, created.link.id);

    // Clarifications the AI Workspace saves are Experience topics.
    const assistantClarificationId = randomUUID();
    await assistantRepository.syncProjectClarifications({
      clarifications: [{
        assignments: [{ actorId: stakeholder.id, actorType: 'stakeholder', label: 'Jamie Ortiz', role: 'primary' }],
        blockingArea: 'Assistant', id: assistantClarificationId, linkedSection: 'brief', prompt: 'Assistant clarification', proposedDraftImpact: '', rationale: '',
      }],
      projectId,
      tenantId,
    });
    const [[assistantRow]] = await pool.execute('SELECT track, topic_origin AS origin FROM project_clarifications WHERE id = ?', [assistantClarificationId]);
    assert.deepEqual({ ...assistantRow }, { origin: 'assistant', track: 'experience' });
    attachRequirementsBridge(assistantRepository, bridge);
    const after = await assistantRepository.getProjectClarificationAccessContext({ accessToken: stakeholder.accessToken });
    assert.deepEqual(after.clarifications, [], 'the older stakeholder token reaches nothing');
    const [[oldInvitation]] = await pool.execute('SELECT invitation_token AS token FROM project_clarification_invitations WHERE clarification_id = ? LIMIT 1', [topic.id]);
    assert.equal(await assistantRepository.getProjectClarificationAccessContext({ accessToken: oldInvitation.token }), null);

    // Deleting needs a topic nobody engaged with.
    const spare = (await createTrackTopicForUser(deps, {
      input: { assignments: [], prompt: 'Drafted question that missed', rationale: '', settles: '', sourceRef: null, suggestedOwnerRole: '' },
      projectId,
      track: 'experience',
      user: member,
    })).topic;
    assert.deepEqual(await deleteTopicForUser(deps, { projectId, topicId: spare.id, user: member }), { deleted: { id: spare.id, track: 'experience' }, ok: true });
    const [[{ remaining }]] = await pool.execute('SELECT COUNT(*) AS remaining FROM project_clarifications WHERE id = ?', [spare.id]);
    assert.equal(Number(remaining), 0);
    await assert.rejects(
      deleteTopicForUser(deps, { projectId, topicId: topic.id, user: member }),
      (error) => error.statusCode === 409 && error.details?.code === 'topic_has_activity' && error.details.activity.stakeholderAssignments === 1,
    );

    clock.offsetMs = 30 * DAY_MS;
    const involved = await resolvePortalAccess(deps, { token: created.token });
    assert.equal(involved.linkStatus.involvementActive, true);
    clock.offsetMs = 0;
    const portal = await getPortalForToken(deps, { token: created.token });
    assert.deepEqual(portal.topics.assigned.map((row) => row.id).sort(), [topic.id, assistantClarificationId].sort(), 'assistant clarifications reach the portal as topics');
    assert.deepEqual(portal.topics.open.map((row) => row.id), [unassigned.id]);
    const comment = await createPortalCommentForToken(deps, { input: { body: 'Before they pick a time.', parentCommentId: '' }, token: created.token, topicId: topic.id });
    assert.equal(comment.topic.status, 'open', 'a stakeholder comment leaves the status alone');

    // Decision recording resolves the topic and ends the involvement.
    const recorded = await recordDecisionForUser(deps, {
      input: { outcome: 'deferred', sourceSummaryId: '', sources: ['comment:c1'], statement: 'Wait for finance.', supersedesId: '', topicId: topic.id },
      projectId,
      user: manager,
    });
    assert.equal(recorded.topic.status, 'open');
    await assert.rejects(
      recordDecisionForUser(deps, { input: { outcome: 'decided', sourceSummaryId: '', sources: [], statement: 'x', supersedesId: '', topicId: topic.id }, projectId, user: manager }),
      (error) => error.statusCode === 409 && error.details?.code === 'decision_exists',
    );
    const decided = await recordDecisionForUser(deps, {
      input: { outcome: 'decided', sourceSummaryId: 'summary-x', sources: ['comment:c1'], statement: 'Show the estimate before a time is picked.', supersedesId: recorded.decision.id, topicId: topic.id },
      projectId,
      user: manager,
    });
    assert.equal(decided.topic.status, 'resolved');
    assert.deepEqual(decided.decision.chain, [recorded.decision.id]);
    assert.equal(decided.decision.decidedBy.ref, `user:${managerId}`);
    const [[decisionRow]] = await pool.execute(
      'SELECT decided_by AS decidedBy, source_summary_id AS sourceSummaryId, sources_json AS sources, version FROM requirements_decisions WHERE id = ?',
      [decided.decision.id],
    );
    assert.equal(decisionRow.decidedBy, `user:${managerId}`);
    assert.equal(decisionRow.sourceSummaryId, 'summary-x');
    assert.deepEqual(typeof decisionRow.sources === 'string' ? JSON.parse(decisionRow.sources) : decisionRow.sources, ['comment:c1']);
    const [[supersededRow]] = await pool.execute('SELECT superseded_by_id AS supersededById, version FROM requirements_decisions WHERE id = ?', [recorded.decision.id]);
    assert.equal(supersededRow.supersededById, decided.decision.id);
    assert.equal(supersededRow.version, 2);

    // Moving a decided topic takes its whole decision chain along, and needs decision rights.
    await assert.rejects(moveTopicForUser(deps, { projectId, topicId: topic.id, track: 'architecture', user: member }), (error) => error.statusCode === 404);
    const moved = await moveTopicForUser(deps, { projectId, topicId: topic.id, track: 'architecture', user: manager });
    assert.equal(moved.topic.track, 'architecture');
    const [movedDecisions] = await pool.execute('SELECT DISTINCT track FROM requirements_decisions WHERE topic_id = ?', [topic.id]);
    assert.deepEqual(movedDecisions.map((row) => row.track), ['architecture']);
    const [[movedTopic]] = await pool.execute('SELECT track FROM project_clarifications WHERE id = ?', [topic.id]);
    assert.equal(movedTopic.track, 'architecture');
    assert.equal((await moveTopicForUser(deps, { projectId, topicId: topic.id, track: 'experience', user: manager })).topic.track, 'experience');

    // The portal lists the active decision, and the stakeholder can still comment on it.
    const decidedPortal = await getPortalForToken(deps, { token: created.token });
    assert.deepEqual(decidedPortal.decisions.map((entry) => [entry.id, entry.topicId, entry.outcome, entry.decidedBy.name]), [[decided.decision.id, topic.id, 'decided', 'Pia Manager']]);
    const disagree = await createPortalCommentForToken(deps, { input: { body: 'I disagree.', parentCommentId: '' }, token: created.token, topicId: topic.id });
    assert.equal(disagree.topic.status, 'resolved');
    assert.equal(disagree.topic.decision.id, decided.decision.id);

    const edited = await updateDecisionForUser(deps, { decisionId: decided.decision.id, input: { statement: 'Show the estimate first.', version: 1 }, projectId, user: manager });
    assert.equal(edited.decision.version, 2);
    await assert.rejects(
      updateDecisionForUser(deps, { decisionId: decided.decision.id, input: { statement: 'Stale.', version: 1 }, projectId, user: manager }),
      (error) => error.statusCode === 409 && error.details?.code === 'decision_version_conflict',
    );

    // Jamie's other topic closes too, so nothing keeps the link alive.
    await assistantRepository.updateProjectClarification({ clarificationId: assistantClarificationId, patch: { status: 'dismissed' }, projectId, tenantId });
    clock.offsetMs = 13 * DAY_MS;
    assert.equal((await resolvePortalAccess(deps, { token: created.token })).linkStatus.status, 'active');
    clock.offsetMs = 15 * DAY_MS;
    await assert.rejects(resolvePortalAccess(deps, { token: created.token }), (error) => error.statusCode === 410 && error.message === 'link_expired');

    // An admin or manager can extend an expired link to a date.
    const extended = await extendAccessLinkForUser(deps, {
      input: { until: new Date(Date.now() + 20 * DAY_MS).toISOString() },
      linkId: created.link.id,
      projectId,
      user: manager,
    });
    assert.equal(extended.link.status, 'active');
    assert.equal((await resolvePortalAccess(deps, { token: created.token })).linkStatus.status, 'active');

    // An open round invitation keeps it alive again; revocation ends it at once.
    clock.offsetMs = 0;
    await requirementsRepository.insertRound({
      projectId,
      reviewers: [
        { actorId: stakeholder.id, actorType: 'stakeholder', required: true },
        { actorId: managerId, actorType: 'user' },
      ],
      round: { number: 1, packageId: randomUUID(), status: 'open', track: 'experience' },
      tenantId,
    });
    await requirementsRepository.insertPackage({ pkg: { title: 'Fieldwork round 2', track: 'experience', uploadedBy: `user:${memberId}`, version: 1 }, projectId, tenantId });
    await requirementsRepository.insertPlan({ plan: { body: '# Plan', createdBy: `user:${managerId}`, criteria: [], status: 'draft', track: 'architecture', version: 1 }, projectId, tenantId });
    await updateTopicForUser(deps, { input: { prompt: 'Which payment provider do we integrate first?' }, projectId, topicId: unassigned.id, user: member });

    const overview = await getRequirementsOverviewForUser(deps, { projectId, user: manager });
    assert.equal(overview.canDecide, true);
    assert.equal(overview.tracks.experience.stages.review.latestRound.reviewersTotal, 2);
    assert.equal(overview.tracks.experience.stages.discuss.decided, 1);
    assert.equal(overview.tracks.architecture.stages.plan.state, 'draft');
    const managerItems = await getMyItemsForUser(deps, { projectId, user: manager });
    assert.deepEqual(managerItems.groups.review.map((item) => item.kind), ['round']);
    const memberItems = await getMyItemsForUser(deps, { projectId, user: member });
    assert.equal(memberItems.canDecide, false);
    assert.deepEqual(memberItems.groups.drafts.map((item) => item.title), ['Fieldwork round 2']);
    const renamed = await listTrackTopicsForUser(deps, { projectId, query: { q: 'first', view: 'open' }, track: 'architecture', user: member });
    assert.deepEqual(renamed.topics.map((row) => row.prompt), ['Which payment provider do we integrate first?']);

    clock.offsetMs = 40 * DAY_MS;
    assert.equal((await resolvePortalAccess(deps, { token: created.token })).linkStatus.involvementActive, true);
    await requirementsRepository.revokeAccessLink({ linkId: created.link.id, now: new Date(), projectId, revokedBy: `user:${managerId}`, tenantId });
    for (const token of [created.token, invitationToken]) {
      await assert.rejects(resolvePortalAccess(deps, { token }), (error) => error.statusCode === 410 && error.message === 'link_revoked');
    }
    const [[{ liveTokens }]] = await pool.execute('SELECT COUNT(*) AS liveTokens FROM requirements_access_link_tokens WHERE link_id = ? AND revoked_at IS NULL', [created.link.id]);
    assert.equal(Number(liveTokens), 0);
    assert.equal(await bridge.issueInvitationUrl({ projectId, stakeholderId: stakeholder.id, tenantId }), null, 'an invitation does not reopen a revoked link');
    assert.equal(await bridge.stakeholderLinkStatus({ projectId, stakeholderId: stakeholder.id, tenantId }), 'revoked', 'email replies are refused');
    assert.equal(await bridge.stakeholderLinkStatus({ projectId, stakeholderId: randomUUID(), tenantId }), 'missing');
    const reopened = await createAccessLinkForUser(deps, { input: { stakeholderId: stakeholder.id }, projectId, user: manager });
    assert.equal(reopened.reactivated, true);
    assert.equal((await resolvePortalAccess(deps, { token: reopened.token })).link.id, created.link.id);
    await assert.rejects(resolvePortalAccess(deps, { token: created.token }), (error) => error.statusCode === 410);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
