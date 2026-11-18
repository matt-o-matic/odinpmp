import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createLiveEventBus, LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlMailRepository, ensureMysqlMailDeliverySchema } from '../src/modules/mail/mail.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryObjectStorage } from '../src/modules/requirements/packages/package-storage.js';
import { createMysqlPackagesRepository } from '../src/modules/requirements/packages/packages.repository.js';
import { ingestPackage } from '../src/modules/requirements/packages/packages.service.js';
import { generateAccessToken, hashAccessToken, pendingLinkRequest } from '../src/modules/requirements/requirements-access-links.js';
import { attachRequirementsBridge, createRequirementsAssistantBridge } from '../src/modules/requirements/requirements-bridge.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createTrackTopicForUser, getMyItemsForUser } from '../src/modules/requirements/requirements.service.js';
import {
  carryAnnotation,
  createAnnotationComment,
  deleteAnnotation,
  getReviewState,
  loadReviewContext,
  portalReviewActor,
  putAnswer,
  putDirection,
  putVerdict,
  readSnapshotForReview,
  submitReview,
  teamReviewActor,
  uploadSnapshot,
  upsertAnnotation,
} from '../src/modules/requirements/rounds/review.service.js';
import { createGrantAccessCheck } from '../src/modules/requirements/packages/package-grant-access.js';
import { processRoundReminders } from '../src/modules/requirements/rounds/round-reminders.js';
import { registerRoundSummaryScopes } from '../src/modules/requirements/rounds/round-summaries.js';
import { createMysqlRoundsRepository } from '../src/modules/requirements/rounds/rounds.repository.js';
import {
  closeRoundForUser,
  getRoundFeedbackForUser,
  getRoundForUser,
  getRoundResultsForUser,
  publishRoundForUser,
} from '../src/modules/requirements/rounds/rounds.service.js';
import { createRequirementsSummaryEngine } from '../src/modules/requirements/summary/summary-engine.js';
import { buildZip, makePng } from './helpers/review-packages.js';
import { createStubSummaryAi, roundPackageFiles } from './helpers/requirements-rounds-app.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const DAY_MS = 24 * 60 * 60 * 1000;
const style = { color: '#c2410c', stroke: 3 };
const pin = (x, y) => ({ number: 1, schemaVersion: 1, style, type: 'pin', x, y });

test('MySQL: migration 0061, publish and invitations, the review API, results, feedback, carry-forward, and reminders', { skip: !databaseUrl, timeout: 600_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_rnd_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  let engine = null;

  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try {
      await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8'));
    } finally {
      await importer.end();
    }

    // Migrations: 0061 applies once. The migration lock is server-wide.
    const runMigrations = (options) => runMysqlMigrations({ ...options, lockTimeoutSeconds: 240 });
    const first = await bootstrapMysqlSchema({ executor: pool, runMigrations });
    assert.ok(first.applied.includes('0061_review_round_details'));
    assert.deepEqual((await bootstrapMysqlSchema({ executor: pool, runMigrations })).applied, [], 'checksums match and nothing reapplies');
    const [columns] = await pool.query(`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS length
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND (
        (TABLE_NAME = 'review_verdicts' AND COLUMN_NAME IN ('dimension', 'mixed_note'))
        OR (TABLE_NAME = 'review_annotations' AND COLUMN_NAME IN ('category', 'display_number', 'deleted_at', 'origin_round_id'))
        OR (TABLE_NAME = 'review_round_reviewers' AND COLUMN_NAME IN ('mail_target_id', 'reminded_at', 'position_json'))
        OR (TABLE_NAME = 'review_rounds' AND COLUMN_NAME IN ('reminder_days_before', 'question_topics_json'))
        OR (TABLE_NAME = 'review_answers' AND COLUMN_NAME = 'topic_id')
        OR (TABLE_NAME = 'review_snapshots' AND COLUMN_NAME = 'storage_key'))
      ORDER BY TABLE_NAME, COLUMN_NAME
    `);
    assert.equal(columns.length, 13);
    assert.equal(Number(columns.find((column) => column.name === 'dimension').length), 80);
    assert.equal(Number(columns.find((column) => column.name === 'category').length), 80);
    await ensureMysqlMailDeliverySchema(pool);

    // Fixtures: tenant, project, a member, a reviewer, and a manager.
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const ids = { manager: randomUUID(), member: randomUUID(), reviewer: randomUUID() };
    const fixtures = await mysql.createConnection({ ...connectionOptions, database });
    try {
      await fixtures.query('SET FOREIGN_KEY_CHECKS = 0');
      await fixtures.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Rounds Tenant']);
      const [statuses] = await fixtures.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
      await fixtures.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Client booking', '', statuses[0].id]);
      for (const [key, name, role] of [['member', 'Mona Member', 'member'], ['reviewer', 'Ravi Reviewer', 'member'], ['manager', 'Pia Manager', 'manager']]) {
        await fixtures.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [ids[key], name, `${key}-${ids[key]}@acme.test`]);
        await fixtures.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), ids[key], tenantId, 'user']);
        await fixtures.execute('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), ids[key], projectId, role]);
      }
    } finally {
      await fixtures.end();
    }
    const user = (key, name) => ({ id: ids[key], memberships: [{ role: 'user', tenantId }], name });
    const member = user('member', 'Mona Member');
    const reviewer = user('reviewer', 'Ravi Reviewer');
    const manager = user('manager', 'Pia Manager');

    const assistantRepository = createMysqlAssistantRepository({ pool });
    const requirementsRepository = createMysqlRequirementsRepository({ pool });
    const packagesRepository = createMysqlPackagesRepository({ pool });
    const roundsRepository = createMysqlRoundsRepository({ pool });
    const projectRepository = createMysqlProjectsRepository({ pool });
    const mailRepository = createMysqlMailRepository({ pool });
    const liveEventBus = createLiveEventBus();
    const summaryAi = createStubSummaryAi();
    engine = createRequirementsSummaryEngine({ assistantRepository, liveEventBus, projectRepository, requirementsRepository, summaryAi });
    registerRoundSummaryScopes(engine, { assistantRepository, packagesRepository, projectRepository, requirementsRepository, roundsRepository });
    attachRequirementsBridge(assistantRepository, createRequirementsAssistantBridge({ frontendAppUrl: 'http://localhost:5173/app', liveEventBus, requirementsRepository, summaries: engine }));
    const deps = {
      assistantRepository,
      backendPublicUrl: 'http://localhost:3001',
      frontendAppUrl: 'http://localhost:5173/app',
      liveEventBus,
      mailRepository,
      packageStorage: createInMemoryObjectStorage(),
      packagesRepository,
      projectRepository,
      requirementsRepository,
      requirementsSummaries: engine,
      reviewGrantSecret: 'test-review-grant-secret-0123456789abcdef',
      reviewPublicUrl: 'http://127.0.0.1:3902',
      roundsRepository,
    };
    const ingest = async (files) => {
      const outcome = await ingestPackage({ ...deps, mermaidValidator: null }, { bytes: await buildZip(files), projectId, source: 'ui', tenantId, track: 'experience', uploadedBy: `user:${ids.member}` });
      assert.equal(outcome.status, 'accepted', JSON.stringify(outcome.errors));
      return outcome.package;
    };

    // Publish round 1 to a member and a stakeholder.
    const { topic: priceTopic } = await createTrackTopicForUser(deps, {
      input: { assignments: [], prompt: 'Where should the price first appear?', rationale: '', settles: '', sourceRef: null, suggestedOwnerRole: '' },
      projectId,
      track: 'experience',
      user: member,
    });
    const v1 = await ingest(roundPackageFiles({ priceTopicId: priceTopic.id }));
    const stakeholder = await assistantRepository.createProjectStakeholder({ projectId, tenantId, value: { email: 'jamie@client.example', name: 'Jamie Ortiz', roleTitle: 'Ops' } });
    const dueAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const published = await publishRoundForUser(deps, {
      input: {
        dueAt,
        note: 'Price first.',
        packageId: v1.id,
        reminder: { daysBefore: 1 },
        reviewers: [{ actorId: ids.reviewer, actorType: 'user', required: true }, { actorId: stakeholder.id, actorType: 'stakeholder', required: false }],
      },
      projectId,
      user: member,
    });
    const round = published.round;
    assert.equal(round.number, 1);
    assert.equal(round.package.status, 'published');
    assert.equal(published.createdTopicIds.length, 3);
    assert.equal(round.questionTopics['price-placement'], priceTopic.id);
    const [topicRows] = await pool.execute(
      `SELECT topic_origin AS origin, track FROM project_clarifications WHERE id IN (${published.createdTopicIds.map(() => '?').join(',')})`,
      published.createdTopicIds,
    );
    assert.deepEqual(topicRows.map((row) => [row.origin, row.track]), Array(3).fill(['package-question', 'experience']));
    const [mailRows] = await pool.execute("SELECT recipient_email AS email, body, mail_target_id AS targetId, status FROM mail_queue WHERE mail_template_id = 'requirements-round-invitation-v1' ORDER BY id");
    assert.equal(mailRows.length, 2);
    assert.deepEqual(round.reviewers.map((item) => item.mail.status), ['queued', 'queued']);
    const token = /\/requirements\/([A-Za-z0-9_-]{43})\/rounds\//.exec(mailRows.find((row) => row.email === 'jamie@client.example').body)[1];
    const [[reviewerRow]] = await pool.execute('SELECT mail_target_id AS targetId, required FROM review_round_reviewers WHERE round_id = ? AND actor_type = ?', [round.id, 'stakeholder']);
    assert.ok(mailRows.some((row) => row.targetId === reviewerRow.targetId));

    // One open round per track, even when two publishes race.
    const v2Draft = await ingest(roundPackageFiles({ css: 'body { color: red; }' }));
    await assert.rejects(publishRoundForUser(deps, { input: { packageId: v2Draft.id, reviewers: [{ actorId: ids.reviewer, actorType: 'user' }] }, projectId, user: member }), (error) => error.statusCode === 409 && error.details.code === 'round_open');

    // Reads: link lifetime counts the open round; My open items lists it for the reviewer.
    const involvement = await requirementsRepository.listStakeholderInvolvement({ projectId, stakeholderId: stakeholder.id, tenantId });
    assert.deepEqual(involvement.rounds.map((entry) => [entry.roundId, entry.status]), [[round.id, 'open']]);
    const mine = await getMyItemsForUser(deps, { projectId, user: reviewer });
    assert.deepEqual(mine.groups.review.map((item) => item.id), [round.id]);

    // The review API through the stakeholder link and the team member.
    const portal = await loadReviewContext(deps, await portalReviewActor(deps, { token }), round.id);
    const team = await loadReviewContext(deps, await teamReviewActor(deps, { projectId, user: reviewer }), round.id);

    // The review origin's access recheck reads the same rows.
    const mayView = createGrantAccessCheck(deps, { cacheMs: 0 });
    const roundPackage = await packagesRepository.getPackageById(round.package.id);
    const stakeholderGrant = { linkId: portal.actor.linkId, tokenId: portal.actor.tokenId, viewerRef: `stakeholder:${stakeholder.id}` };
    assert.equal(await mayView({ grant: stakeholderGrant, pkg: roundPackage }), true);
    assert.equal(await mayView({ grant: { ...stakeholderGrant, tokenId: randomUUID() }, pkg: roundPackage }), false, 'a token of another link');
    assert.equal(await mayView({ grant: { linkId: null, tokenId: null, viewerRef: `user:${ids.reviewer}` }, pkg: roundPackage }), true);
    assert.equal(await mayView({ grant: { linkId: null, tokenId: null, viewerRef: `user:${randomUUID()}` }, pkg: roundPackage }), false);
    await putVerdict(deps, portal, { input: { change: 'Smaller', dimensions: { 'tone-of-voice': 'change', type: 'keep' }, mixed: '', overall: 'keep-with-changes', stay: '' }, screenId: 'home' });
    await putVerdict(deps, team, { input: { change: '', dimensions: {}, mixed: '', overall: 'change', stay: '' }, screenId: 'home' });
    await putDirection(deps, portal, { directionId: 'action-first', input: { remix: 'Price card', stance: 'preferred' } });
    const answer = await putAnswer(deps, portal, { input: { value: 'range-on-home' }, questionId: 'price-placement' });
    const [[posted]] = await pool.execute('SELECT comment_source AS source, actor_type AS actorType, comment_body AS body FROM project_clarification_comments WHERE id = ?', [answer.answer.postedCommentId]);
    assert.deepEqual([posted.source, posted.actorType], ['round-answer', 'stakeholder']);
    assert.match(posted.body, /^A range on the home screen\s+Answered in review round 1/, 'scalar JSON answers read back intact');
    const edited = await putAnswer(deps, portal, { input: { value: 'after-time' }, questionId: 'price-placement' });
    assert.equal(edited.answer.postedCommentId, answer.answer.postedCommentId);
    const [[editedComment]] = await pool.execute('SELECT comment_body AS body FROM project_clarification_comments WHERE id = ?', [answer.answer.postedCommentId]);
    assert.match(editedComment.body, /^Only after a time is picked/);
    // Topic delete counts round answers, and the review reads topic statuses to flag removed questions.
    assert.equal(await roundsRepository.countTopicAnswers({ projectId, tenantId, topicId: edited.answer.topicId }), 1);
    assert.deepEqual(await requirementsRepository.listTopicStatuses({ projectId, tenantId, topicIds: [edited.answer.topicId, randomUUID()] }), [{ id: edited.answer.topicId, status: 'open' }]);

    // Concurrent annotation creates on one screen get distinct display numbers.
    const marks = Array.from({ length: 4 }, () => randomUUID());
    const created = await Promise.all(marks.map((annotationId, index) => upsertAnnotation(deps, index % 2 ? team : portal, {
      annotationId,
      input: { anchor: {}, category: null, elementHint: null, restored: false, screenId: 'home', shapes: [pin(10 + index, 10)], snapshotFileId: null, stateKey: null },
    })));
    assert.deepEqual(created.map((result) => result.annotation.number).sort(), [1, 2, 3, 4]);
    const updated = await upsertAnnotation(deps, portal, { annotationId: marks[0], input: { anchor: {}, category: 'hierarchy', elementHint: null, restored: false, screenId: 'home', shapes: [pin(50, 50)], snapshotFileId: null, stateKey: null } });
    assert.equal(updated.annotation.number, created[0].annotation.number);
    assert.equal(updated.annotation.shapes[0].number, created[0].annotation.number);
    await deleteAnnotation(deps, portal, { annotationId: marks[0] });
    const restored = await upsertAnnotation(deps, portal, { annotationId: marks[0], input: { anchor: {}, category: null, elementHint: null, restored: true, screenId: 'home', shapes: [pin(60, 60)], snapshotFileId: null, stateKey: null } });
    assert.equal(restored.annotation.number, created[0].annotation.number);
    const comment = await createAnnotationComment(deps, portal, { annotationId: marks[0], input: { body: 'The price is too loud.', parentCommentId: '' } });
    await createAnnotationComment(deps, team, { annotationId: marks[0], input: { body: 'Agree.', parentCommentId: comment.comment.id } });

    const snapshot = await uploadSnapshot(deps, portal, { bytes: makePng(1280, 800), query: { screenId: 'booking', stateKey: 'pick-time' } });
    const onSnapshot = randomUUID();
    await upsertAnnotation(deps, portal, { annotationId: onSnapshot, input: { anchor: {}, category: null, elementHint: { odinId: 'slot', tag: 'button', text: '10:30' }, restored: false, screenId: 'booking', shapes: [pin(1200, 700)], snapshotFileId: snapshot.snapshotFileId, stateKey: 'pick-time' } });
    const [[annotationRow]] = await pool.execute('SELECT screen_id AS screenId, state_key AS stateKey, snapshot_file_id AS snapshotFileId, element_hint_json AS hint FROM review_annotations WHERE id = ?', [onSnapshot]);
    assert.deepEqual([annotationRow.screenId, annotationRow.stateKey, annotationRow.snapshotFileId, annotationRow.hint.odinId], ['booking', 'pick-time', snapshot.snapshotFileId, 'slot']);
    const served = await readSnapshotForReview(deps, portal, { snapshotId: snapshot.snapshotFileId });
    assert.equal(served.snapshot.width, 1280);

    const portalEvents = [];
    const linkId = (await requirementsRepository.getAccessLinkForStakeholder({ projectId, stakeholderId: stakeholder.id, tenantId })).id;
    liveEventBus.subscribe(LIVE_EVENT_CHANNELS.publicRequirements(linkId), (event) => portalEvents.push(event));
    await submitReview(deps, team);
    assert.ok(portalEvents.some((event) => event.type === 'requirements.rounds.invalidated' && event.reason === 'review-submitted'));
    const state = await getReviewState(deps, portal);
    assert.equal(state.annotations.length, 5);
    assert.deepEqual(state.verdicts.home.dimensions, { 'tone-of-voice': 'change', type: 'keep' });

    // A "Request a new link" row: stored on the link, revoked from the start, pending until
    // the link changes, and never found as a portal token.
    const requestHash = hashAccessToken(generateAccessToken());
    const linkRequest = await requirementsRepository.recordLinkRequest({ linkId, now: new Date(Date.now() + 1000), requestedBy: `stakeholder:${stakeholder.id}`, tokenHash: requestHash });
    assert.deepEqual([linkRequest.purpose, Boolean(linkRequest.revokedAt), linkRequest.createdBy], ['link-request', true, `stakeholder:${stakeholder.id}`]);
    const requestedLink = await requirementsRepository.getAccessLink({ linkId, projectId, tenantId });
    assert.deepEqual(pendingLinkRequest(requestedLink), { requestedAt: linkRequest.createdAt });
    assert.equal((await requirementsRepository.findAccessTokenByHash({ tokenHash: requestHash })).token.revokedAt !== null, true);

    // Results and summaries with the stub; every cited source resolves.
    await engine.flush();
    const results = await getRoundResultsForUser(deps, { projectId, roundId: round.id, user: member });
    assert.equal(results.grid.length, 2);
    assert.equal(results.grid.find((row) => row.actorRef === `user:${ids.reviewer}`).verdicts.home.overall, 'change');
    const home = results.summaries.screens.home.current;
    assert.ok(home);
    assert.ok(home.sources.length > 0 && home.sources.every((source) => source.available));
    assert.ok(results.summaries.round.current);

    const feedback = await getRoundFeedbackForUser(deps, { projectId, query: {}, roundId: round.id, user: member });
    assert.equal(feedback.schema, 'odin.round-feedback/v1');
    assert.equal(feedback.annotations.length, 5);
    assert.ok(feedback.annotations.find((item) => item.id === onSnapshot).snapshotUrl.endsWith(`/snapshots/${snapshot.snapshotFileId}`));
    assert.deepEqual(feedback.verdicts.find((item) => item.actorRef === `stakeholder:${stakeholder.id}`).dimensions, { 'tone-of-voice': 'change', type: 'keep' });
    assert.deepEqual(feedback.answers.map((item) => item.value), ['after-time']);

    // Reminders: once per reviewer per round, only for those who have not submitted.
    const reminderDeps = { ...deps };
    const window = new Date(Date.parse(dueAt) - 12 * 60 * 60 * 1000);
    // A queue failure gives the claim back, so the next run sends the reminder.
    const failingMail = { ...mailRepository, queueMail: async () => { throw new Error('mail queue unavailable'); } };
    assert.deepEqual(await processRoundReminders({ ...deps, mailRepository: failingMail }, { now: window }), { due: 1, failed: 1, notSent: 0, queued: 0, skipped: 0 });
    const [[{ claimed }]] = await pool.execute('SELECT COUNT(*) AS claimed FROM review_round_reviewers WHERE round_id = ? AND reminded_at IS NOT NULL', [round.id]);
    assert.equal(Number(claimed), 0);
    assert.deepEqual(await processRoundReminders(reminderDeps, { now: window }), { due: 1, failed: 0, notSent: 0, queued: 1, skipped: 0 });
    assert.deepEqual(await processRoundReminders(reminderDeps, { now: window }), { due: 0, failed: 0, notSent: 0, queued: 0, skipped: 0 });
    const [[{ reminders }]] = await pool.execute("SELECT COUNT(*) AS reminders FROM mail_queue WHERE mail_template_id = 'requirements-round-reminder-v1'");
    assert.equal(Number(reminders), 1);

    // The round closes only with its decision: a decision the database refuses rolls the close back.
    await assert.rejects(roundsRepository.closeRound({
      closedAt: new Date(),
      closedBy: `user:${ids.manager}`,
      decision: { decidedBy: `user:${ids.manager}`, kind: 'round', outcome: 'decided', roundId: round.id, sources: [], statement: null, track: 'experience' },
      outcome: 'abandoned',
      projectId,
      roundId: round.id,
      tenantId,
    }));
    const [[stillOpen]] = await pool.execute('SELECT status, outcome FROM review_rounds WHERE id = ?', [round.id]);
    assert.deepEqual(stillOpen, { outcome: null, status: 'open' });
    const [[{ none }]] = await pool.execute("SELECT COUNT(*) AS none FROM requirements_decisions WHERE kind = 'round'");
    assert.equal(Number(none), 0);

    // Close records a round decision owned by the manager.
    await assert.rejects(closeRoundForUser(deps, { input: { directionId: '', outcome: 'abandoned', statement: '' }, projectId, roundId: round.id, user: member }), (error) => error.statusCode === 404);
    const closed = await closeRoundForUser(deps, { input: { directionId: '', outcome: 'changes-requested', statement: '' }, projectId, roundId: round.id, user: manager });
    assert.equal(closed.round.status, 'closed');
    const [[decision]] = await pool.execute("SELECT kind, round_id AS roundId, decided_by AS decidedBy, statement FROM requirements_decisions WHERE kind = 'round'");
    assert.deepEqual(decision, { decidedBy: `user:${ids.manager}`, kind: 'round', roundId: round.id, statement: 'Round 1: Changes requested.' });

    // Version 3 changes home, keeps the prototype, drops "gone": carry-forward transitions.
    const goneMark = randomUUID();
    await roundsRepository.createAnnotation({
      annotation: {
        anchor: {}, authorId: stakeholder.id, authorName: 'Jamie Ortiz', authorType: 'stakeholder', id: goneMark, packageId: v1.id, packageVersion: v1.version,
        projectId, roundId: round.id, schemaVersion: 1, screenId: 'gone', shapes: [pin(1, 1)], status: 'open', tenantId,
      },
    });
    const v3 = await ingest(roundPackageFiles({ homeColor: [200, 200, 30], omit: ['gone'] }));
    const second = await publishRoundForUser(deps, { input: { packageId: v3.id, reviewers: [{ actorId: stakeholder.id, actorType: 'stakeholder' }] }, projectId, user: member });
    assert.equal(second.round.number, 2);
    assert.deepEqual(second.carryForward, { carried: 1, outdated: 4, superseded: 1 });
    const [statusRows] = await pool.execute('SELECT id, status, round_id AS roundId, display_number AS number, origin_round_id AS originRoundId FROM review_annotations WHERE id IN (?, ?, ?)', [onSnapshot, marks[0], goneMark]);
    const byId = new Map(statusRows.map((row) => [row.id, row]));
    assert.deepEqual([byId.get(onSnapshot).status, byId.get(onSnapshot).roundId, byId.get(onSnapshot).number, byId.get(onSnapshot).originRoundId], ['carried', second.round.id, 1, round.id]);
    assert.equal(byId.get(marks[0]).status, 'outdated');
    assert.equal(byId.get(goneMark).status, 'superseded');
    const portal2 = await loadReviewContext(deps, await portalReviewActor(deps, { token }), second.round.id);
    const carried = await carryAnnotation(deps, portal2, { annotationId: marks[0] });
    assert.deepEqual([carried.annotation.status, carried.annotation.roundId, carried.annotation.number], ['carried', second.round.id, 1]);
    assert.equal(carried.annotation.thread.length, 2, 'the thread moves with the annotation');
    const state2 = await getReviewState(deps, portal2);
    assert.equal(state2.previousAnswers['price-placement'].roundNumber, 1);
    assert.equal(state2.previousAnswers['price-placement'].value, 'after-time');
    assert.equal((await getRoundForUser(deps, { projectId, roundId: second.round.id, user: member })).round.packageVersion, 3);

    // Revoking the link stops grants issued through it.
    const secondPackage = await packagesRepository.getPackageById(second.round.package.id);
    const secondGrant = { linkId: portal2.actor.linkId, tokenId: portal2.actor.tokenId, viewerRef: `stakeholder:${stakeholder.id}` };
    assert.equal(await mayView({ grant: secondGrant, pkg: secondPackage }), true);
    await requirementsRepository.revokeAccessLink({ linkId: portal2.actor.linkId, now: new Date(), projectId, revokedBy: `user:${ids.manager}`, tenantId });
    assert.equal(await mayView({ grant: secondGrant, pkg: secondPackage }), false);
  } finally {
    engine?.stop();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
