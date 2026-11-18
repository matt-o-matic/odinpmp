import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createInProcessAgentChats } from './helpers/in-process-agent.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { draftPlanWithLocalFixture, proposeWorkWithLocalFixture } from '../src/modules/requirements/plans/plan-fixture.js';
import { createMysqlPlansRepository } from '../src/modules/requirements/plans/plans.repository.js';
import {
  approvePlanForUser,
  draftPlanForUser,
  getPlanForUser,
  listPlansForUser,
  proposeWorkForUser,
  updatePlanForUser,
} from '../src/modules/requirements/plans/plans.service.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import {
  acceptPreferenceForUser,
  createTrackTopicForUser,
  getRequirementsOverviewForUser,
  recordDecisionForUser,
} from '../src/modules/requirements/requirements.service.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: migration 0062, plan versions, approval, and proposed work applied through the assistant', { skip: !databaseUrl, timeout: 300_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_plan_${process.pid}`;
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
    // The migration lock is server-wide, and other suites may be bootstrapping their own databases.
    const runMigrations = (options) => runMysqlMigrations({ ...options, lockTimeoutSeconds: 240 });
    const migrated = await bootstrapMysqlSchema({ executor: pool, runMigrations });
    assert.ok(migrated.applied.includes('0063_clarification_topics_backfill'));
    assert.deepEqual((await bootstrapMysqlSchema({ executor: pool, runMigrations })).applied, [], 'checksums match and nothing reapplies');
    const [columns] = await pool.query(
      "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'requirements_plans' ORDER BY ORDINAL_POSITION",
    );
    for (const name of ['content_json', 'audit_json', 'approved_by_name', 'based_on_id', 'updated_by', 'superseded_at']) {
      assert.ok(columns.some((column) => column.name === name), name);
    }

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const managerId = randomUUID();
    const editorId = randomUUID();
    const fixtures = await mysql.createConnection({ ...connectionOptions, database });
    try {
      await fixtures.query('SET FOREIGN_KEY_CHECKS = 0');
      await fixtures.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Plan Tenant']);
      const [statuses] = await fixtures.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
      await fixtures.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Client booking', '', statuses[0].id]);
      for (const [userId, name, role] of [[managerId, 'Morgan Lee', 'manager'], [editorId, 'Eddie Editor', 'editor']]) {
        await fixtures.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, name, `${userId}@acme.test`]);
        await fixtures.execute('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), userId, projectId, role]);
      }
    } finally {
      await fixtures.end();
    }

    const assistantRepository = createMysqlAssistantRepository({ pool });
    const projectRepository = createMysqlProjectsRepository({ pool });
    const requirementsRepository = createMysqlRequirementsRepository({ pool });
    const plansRepository = createMysqlPlansRepository({ pool });
    const liveEventBus = createLiveEventBus();
    const clock = { now: Date.parse('2026-10-07T09:00:00.000Z') };
    const ai = {
      provider: 'stub-provider',
      async draftPlan({ modelInput }) { return { model: 'stub-model', output: draftPlanWithLocalFixture(modelInput) }; },
      async proposeWork({ modelInput }) { return { model: 'stub-model', output: proposeWorkWithLocalFixture(modelInput) }; },
    };
    const chats = createInProcessAgentChats({ projectRepository });
    const deps = {
      agentChatService: chats.service,
      agentChatsRepository: chats.chatsRepository,
      assistantRepository,
      clock: () => new Date(clock.now),
      liveEventBus,
      plansRepository,
      projectRepository,
      requirementsAiService: ai,
      requirementsRepository,
    };
    const manager = { id: managerId, memberships: [{ role: 'user', tenantId }], name: 'Morgan Lee' };
    const editor = { id: editorId, memberships: [{ role: 'user', tenantId }], name: 'Eddie Editor' };
    const events = [];
    liveEventBus.subscribe(`project:${projectId}`, (event) => events.push(event));

    // Decisions: one agreed, one superseded, one deferred, and an accepted preference.
    const topic = async (prompt) => (await createTrackTopicForUser(deps, {
      input: { assignments: [], prompt, rationale: '', settles: '', sourceRef: null, suggestedOwnerRole: '' },
      projectId,
      track: 'experience',
      user: editor,
    })).topic;
    const decide = async (topicId, outcome, statement, supersedesId = '') => {
      clock.now += 60_000;
      return (await recordDecisionForUser(deps, { input: { outcome, sourceSummaryId: '', sources: [], statement, supersedesId, topicId }, projectId, user: manager })).decision;
    };
    const home = await topic('What comes first on the home screen?');
    const price = await topic('When does a client see the price?');
    const sms = await topic('Do we send SMS reminders?');
    const first = await decide(home.id, 'agreed', 'Booking is the first task on the home screen.');
    const oldPrice = await decide(price.id, 'decided', 'Show the price only after a time is picked.');
    await decide(sms.id, 'deferred', 'SMS reminders wait until phase 2.');
    const newPrice = await decide(price.id, 'agreed', 'Show a price range before tax on home.', oldPrice.id);
    clock.now += 60_000;
    const preference = (await acceptPreferenceForUser(deps, {
      input: { dimension: 'hierarchy', key: '', outcome: 'agreed', sourceSummaryId: '', sources: [], stance: 'keep', statement: 'One primary "Book a visit" action.', track: 'experience' },
      projectId,
      user: manager,
    })).decision;

    // Draft v1: stored with its structure and an internal audit the API never returns.
    const drafted = await draftPlanForUser(deps, { projectId, track: 'experience', user: editor });
    const v1 = drafted.plan;
    assert.deepEqual([v1.version, v1.status, v1.revision], [1, 'draft', 1]);
    assert.deepEqual(v1.criteria.map((criterion) => criterion.decisionIds), [[first.id], [newPrice.id], [preference.id]]);
    assert.equal(JSON.stringify(drafted).includes(oldPrice.id), false);
    assert.equal(JSON.stringify(drafted).includes('stub-'), false);
    const [[row]] = await pool.execute(
      'SELECT version, status, body_markdown AS body, criteria_json AS criteria, content_json AS content, audit_json AS audit, approved_by AS approvedBy FROM requirements_plans WHERE id = ?',
      [v1.id],
    );
    assert.deepEqual([row.version, row.status, row.approvedBy], [1, 'draft', null]);
    assert.match(row.body, /\| AC-E1 \| .* \| D-01 \|/);
    assert.equal(row.criteria.length, 3);
    assert.equal(row.content.nonGoals.length, 1);
    assert.deepEqual([row.audit.provider, row.audit.model], ['stub-provider', 'stub-model']);
    assert.equal(Object.keys(row.audit).some((key) => /drafted|^ai/i.test(key)), false, 'the internal audit keeps provider and model only, no drafted flag');

    // Edits: revision conflict, then an in-place edit.
    const edited = await updatePlanForUser(deps, { input: { objective: 'Clients book without calling.', revision: 1 }, planId: v1.id, projectId, user: editor });
    assert.equal(edited.plan.revision, 2);
    await assert.rejects(
      updatePlanForUser(deps, { input: { objective: 'Stale', revision: 1 }, planId: v1.id, projectId, user: editor }),
      (error) => error.statusCode === 409 && error.details.code === 'plan_revision_conflict',
    );

    // Under lock, approval takes only the revision the caller checked and checks citations
    // again: a superseded decision or a changed revision conflicts and nothing changes.
    const approveDirectly = (overrides) => plansRepository.approvePlan({
      approvedBy: `user:${managerId}`, approvedByName: 'Morgan Lee', citedDecisionIds: [], expectedRevision: 2, now: new Date(clock.now), planId: v1.id, projectId, tenantId, ...overrides,
    });
    await assert.rejects(approveDirectly({ citedDecisionIds: [first.id, oldPrice.id] }), (error) => error.statusCode === 409
      && error.details.code === 'plan_cites_superseded_decisions' && error.details.staleDecisionIds.join() === oldPrice.id);
    await assert.rejects(approveDirectly({ expectedRevision: 1 }), (error) => error.statusCode === 409 && error.details.code === 'plan_revision_conflict');
    const [[unchanged]] = await pool.execute('SELECT status, row_version AS revision FROM requirements_plans WHERE id = ?', [v1.id]);
    assert.deepEqual([unchanged.status, Number(unchanged.revision)], ['draft', 2]);

    // Approval: the manager owns v1; editing it starts v2; approving v2 supersedes v1.
    await assert.rejects(approvePlanForUser(deps, { input: { revision: 2 }, planId: v1.id, projectId, user: editor }), (error) => error.statusCode === 404);
    clock.now += 60_000;
    const approved = await approvePlanForUser(deps, { input: { revision: 2 }, planId: v1.id, projectId, user: manager });
    assert.deepEqual(approved.plan.owner, { id: managerId, name: 'Morgan Lee' });
    const forked = await updatePlanForUser(deps, {
      input: { revision: approved.plan.revision, scope: approved.plan.scope.slice(0, 2) },
      planId: v1.id,
      projectId,
      user: editor,
    });
    assert.equal(forked.createdVersion, true);
    assert.deepEqual([forked.plan.version, forked.plan.status, forked.plan.basedOn.id], [2, 'draft', v1.id]);
    await assert.rejects(
      plansRepository.insertPlanVersion({ expectedLatestVersion: 1, plan: { createdBy: `user:${editorId}`, track: 'experience' }, projectId, tenantId }),
      (error) => error.statusCode === 409 && error.details.code === 'plan_not_latest',
    );
    clock.now += 60_000;
    const v2 = (await approvePlanForUser(deps, { input: { revision: forked.plan.revision }, planId: forked.plan.id, projectId, user: manager })).plan;
    const listed = await listPlansForUser(deps, { projectId, track: 'experience', user: editor });
    assert.deepEqual(listed.plans.map((plan) => [plan.version, plan.status, plan.owner?.name]), [[2, 'approved', 'Morgan Lee'], [1, 'superseded', 'Morgan Lee']]);
    const [[supersededRow]] = await pool.execute('SELECT status, superseded_at AS supersededAt FROM requirements_plans WHERE id = ?', [v1.id]);
    assert.equal(supersededRow.status, 'superseded');
    assert.ok(supersededRow.supersededAt);
    const overview = await getRequirementsOverviewForUser(deps, { projectId, user: editor });
    assert.deepEqual([overview.tracks.experience.stages.plan.state, overview.tracks.experience.stages.plan.latestPlan.version], ['approved', 2]);

    // Propose work: a session in the assistant's storage, a proposal row, and no work items.
    const proposed = await proposeWorkForUser(deps, { planId: v2.id, projectId, user: editor });
    const stories = proposed.proposals.filter((item) => item.kind === 'story');
    assert.ok(stories.length > 0);
    const before = await projectRepository.getProjectDetail({ projectId, tenantId });
    assert.deepEqual(before.epics, []);
    const [[{ itemCount }]] = await pool.execute('SELECT COUNT(*) AS itemCount FROM tasks WHERE project_id = ? AND deleted = 0', [projectId]);
    assert.equal(Number(itemCount), 0, 'no work item rows before apply');
    const { chat } = await deps.agentChatService.getChat({ chatId: proposed.reviewLink.sessionId, user: editor });
    assert.equal(chat.messages.at(-1).proposal.items.length, proposed.reviewLink.actionIds.length);
    const [proposalRows] = await pool.execute('SELECT plan_id AS planId, session_id AS sessionId, proposed_by AS proposedBy, items_json AS items FROM requirements_plan_proposals WHERE project_id = ?', [projectId]);
    assert.deepEqual(proposalRows.map((entry) => [entry.planId, entry.sessionId, entry.proposedBy, entry.items.length]), [[v2.id, proposed.reviewLink.sessionId, `user:${editorId}`, proposed.proposals.length]]);

    // Apply through the assistant: stories carry their criteria and decision references.
    await chats.applyAll({ chatId: proposed.reviewLink.sessionId, user: editor });
    const after = await projectRepository.getProjectDetail({ projectId, tenantId });
    const appliedStories = after.epics.flatMap((epic) => epic.stories ?? []);
    assert.equal(appliedStories.length, stories.length);
    const [[{ appliedCount }]] = await pool.execute('SELECT COUNT(*) AS appliedCount FROM tasks WHERE project_id = ? AND deleted = 0', [projectId]);
    assert.equal(Number(appliedCount), after.epics.length + appliedStories.length);
    for (const proposal of stories) {
      // The MySQL tree writer gives inserted items fresh ids; the title and trace identify them.
      const story = appliedStories.find((entry) => entry.name === proposal.title);
      assert.ok(story, proposal.title);
      for (const decisionId of proposal.sourceDecisionIds) assert.ok(story.description.includes(`(decision ${decisionId})`));
      for (const criterion of proposal.acceptanceCriteria) assert.ok(story.description.includes(criterion.id));
    }
    const homeStory = appliedStories.find((story) => story.description.includes(`(decision ${first.id})`));
    assert.deepEqual(homeStory.sourceClarificationIds, [home.id]);
    const state = await getPlanForUser(deps, { planId: v2.id, projectId, user: editor });
    assert.equal(state.plan.proposedWork[0].counts.applied, proposed.proposals.length);
    assert.deepEqual(
      events.filter((event) => event.type === 'requirements.plans.invalidated').map((event) => event.reason),
      ['plan-drafted', 'plan-edited', 'plan-approved', 'plan-edit-drafted', 'plan-approved', 'work-proposed'],
    );
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
