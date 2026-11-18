import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import {
  createTopicCommentForUser,
  createTrackTopicForUser,
  getTopicForUser,
  listTopicSummaryHistoryForUser,
  listTrackTopicsForUser,
  refreshTopicSummaryForUser,
  voteTopicCommentForUser,
} from '../src/modules/requirements/requirements.service.js';
import { createRequirementsSummaryEngine } from '../src/modules/requirements/summary/summary-engine.js';
import { summarizeWithLocalFixture } from '../src/modules/requirements/summary/summary-fixture.js';
import { emptySummaryOutput } from '../src/modules/requirements/summary/summary-output.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: Odin summary runs are stored as rows and the newest ok row is current', { skip: !databaseUrl, timeout: 300_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_sum_${process.pid}`;
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
    await bootstrapMysqlSchema({ executor: pool });

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const memberId = randomUUID();
    const editorId = randomUUID();
    const fixtures = await mysql.createConnection({ ...connectionOptions, database });
    try {
      await fixtures.query('SET FOREIGN_KEY_CHECKS = 0');
      await fixtures.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Summary Tenant']);
      const [statuses] = await fixtures.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
      await fixtures.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Client booking', '', statuses[0].id]);
      for (const [userId, name] of [[memberId, 'Mona Member'], [editorId, 'Eddie Editor']]) {
        await fixtures.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, name, `${userId}@acme.test`]);
        await fixtures.execute('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), userId, projectId, 'member']);
      }
    } finally {
      await fixtures.end();
    }

    const ai = {
      calls: 0,
      handler: ({ modelInput }) => ({ model: 'stub-model', output: summarizeWithLocalFixture(modelInput) }),
      provider: 'stub',
      async summarize(args) {
        ai.calls += 1;
        return ai.handler(args);
      },
    };
    const assistantRepository = createMysqlAssistantRepository({ pool });
    const requirementsRepository = createMysqlRequirementsRepository({ pool });
    const projectRepository = createMysqlProjectsRepository({ pool });
    const liveEventBus = createLiveEventBus();
    const engine = createRequirementsSummaryEngine({ assistantRepository, liveEventBus, projectRepository, requirementsRepository, summaryAi: ai });
    const deps = { assistantRepository, liveEventBus, projectRepository, requirementsRepository, requirementsSummaries: engine };
    const member = { id: memberId, memberships: [{ role: 'user', tenantId }], name: 'Mona Member' };
    const editor = { id: editorId, memberships: [{ role: 'user', tenantId }], name: 'Eddie Editor' };
    const events = [];
    liveEventBus.subscribe(`project:${projectId}`, (event) => events.push(event));

    const { topic } = await createTrackTopicForUser(deps, {
      input: { assignments: [], prompt: 'Should clients see a price estimate?', rationale: '', settles: 'Price display', sourceRef: null, suggestedOwnerRole: 'Finance' },
      projectId,
      track: 'experience',
      user: member,
    });
    const job = { projectId, scopeId: topic.id, scopeType: 'topic', tenantId };

    // Activity schedules a run; flushing it stores one ok row.
    const first = await createTopicCommentForUser(deps, { input: { body: 'Show the estimate before booking.', parentCommentId: '' }, projectId, topicId: topic.id, user: member });
    assert.equal(engine.isPending(job), true);
    await voteTopicCommentForUser(deps, { commentId: first.comment.id, input: { vote: 'up' }, projectId, topicId: topic.id, user: editor });
    const reply = await createTopicCommentForUser(deps, { input: { body: 'Agree, show it early.', parentCommentId: first.comment.id }, projectId, topicId: topic.id, user: editor });
    await engine.flush();
    assert.equal(ai.calls, 1);

    const [rows] = await pool.execute(
      `SELECT id, track, scope_type AS scopeType, scope_id AS scopeId, status, output_json AS output, dropped_json AS dropped,
              error_message AS errorMessage, model, input_digest AS inputDigest, created_at AS createdAt
       FROM requirements_summaries WHERE tenant_id = ? AND project_id = ? ORDER BY created_at`,
      [tenantId, projectId],
    );
    assert.equal(rows.length, 1);
    const okRow = rows[0];
    assert.deepEqual([okRow.track, okRow.scopeType, okRow.scopeId, okRow.status, okRow.model, okRow.errorMessage], ['experience', 'topic', topic.id, 'ok', 'stub-model', null]);
    assert.match(okRow.inputDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(okRow.dropped, []);
    assert.deepEqual(okRow.output.aligned[0].sources, [`comment:${first.comment.id}`, `comment:${reply.comment.id}`]);
    assert.deepEqual(okRow.output.aligned[0].supporters, [`user:${memberId}`, `user:${editorId}`]);
    assert.equal(okRow.output.proposedAnswer, 'Show the estimate before booking.');
    assert.ok(events.some((event) => event.type === 'requirements.summary.updated' && event.summaryId === okRow.id && event.status === 'ok'));

    const detail = await getTopicForUser(deps, { projectId, topicId: topic.id, user: member });
    assert.equal(detail.topic.summary.id, okRow.id);
    assert.deepEqual(detail.topic.summary.output.aligned[0].supporterNames, ['Mona Member', 'Eddie Editor']);
    assert.equal(detail.topic.state, 'ready');

    // A failed run is a new row; the ok row stays current.
    ai.handler = () => { throw new Error('upstream timeout'); };
    await createTopicCommentForUser(deps, { input: { body: 'What about repeat clients?', parentCommentId: '' }, projectId, topicId: topic.id, user: member });
    const failed = await refreshTopicSummaryForUser(deps, { projectId, topicId: topic.id, user: member });
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.summary.id, okRow.id);
    assert.equal(failed.summaryStatus.lastAttemptStatus, 'failed');
    const [[failedRow]] = await pool.execute("SELECT output_json AS output, error_message AS errorMessage FROM requirements_summaries WHERE status = 'failed' AND scope_id = ?", [topic.id]);
    assert.equal(failedRow.output, null);
    assert.match(failedRow.errorMessage, /^ai_request_failed: upstream timeout/);

    assert.equal((await requirementsRepository.getCurrentSummary({ projectId, scopeId: topic.id, scopeType: 'topic', tenantId })).id, okRow.id);
    const attempts = await requirementsRepository.listLatestSummaryAttempts({ projectId, scopeType: 'topic', tenantId });
    assert.deepEqual(attempts.map((attempt) => [attempt.scopeId, attempt.status]), [[topic.id, 'failed']]);
    const latestOk = await requirementsRepository.listLatestSummaries({ projectId, scopeType: 'topic', tenantId });
    assert.deepEqual(latestOk.map((summary) => summary.id), [okRow.id]);
    const register = await listTrackTopicsForUser(deps, { projectId, query: { q: '', view: 'all' }, track: 'experience', user: member });
    assert.deepEqual([register.topics[0].summary.id, register.topics[0].summaryStatus.lastAttemptStatus, register.topics[0].state], [okRow.id, 'failed', 'ready']);

    // Drops round-trip through dropped_json; the newest ok run becomes current.
    ai.handler = () => ({
      model: 'stub-model',
      output: { ...emptySummaryOutput(), aligned: [{ sources: ['C1', 'C9'], statement: 'Show the estimate early.', supporters: ['P1', 'P8'] }], proposedAnswer: 'Show the estimate early.' },
    });
    const recovered = await refreshTopicSummaryForUser(deps, { projectId, topicId: topic.id, user: member });
    assert.equal(recovered.outcome, 'ok');
    const current = await requirementsRepository.getCurrentSummary({ projectId, scopeId: topic.id, scopeType: 'topic', tenantId });
    assert.equal(current.id, recovered.run.id);
    assert.deepEqual(current.dropped.map((record) => [record.reason, record.refs]), [['unknown-source', ['C9']], ['unknown-actor', ['P8']]]);
    assert.deepEqual(current.output.aligned[0].sources, [`comment:${first.comment.id}`]);

    const history = await listTopicSummaryHistoryForUser(deps, { projectId, topicId: topic.id, user: member });
    assert.deepEqual(history.runs.map((run) => [run.status, run.current]), [['ok', true], ['failed', false], ['ok', false]]);
    assert.equal((await requirementsRepository.listSummaryRuns({ limit: 2, projectId, scopeId: topic.id, scopeType: 'topic', tenantId })).length, 2);

    // Millisecond ordering: a later failed row never displaces the newest ok row.
    const base = Date.parse(current.createdAt);
    await requirementsRepository.createSummary({ projectId, summary: { createdAt: new Date(base + 5), output: { ...emptySummaryOutput(), proposedAnswer: 'Later ok' }, scopeId: topic.id, scopeType: 'topic', status: 'ok', track: 'experience' }, tenantId });
    await requirementsRepository.createSummary({ projectId, summary: { createdAt: new Date(base + 9), errorMessage: 'ai_request_failed: x', output: null, scopeId: topic.id, scopeType: 'topic', status: 'failed', track: 'experience' }, tenantId });
    assert.equal((await requirementsRepository.getCurrentSummary({ projectId, scopeId: topic.id, scopeType: 'topic', tenantId })).output.proposedAnswer, 'Later ok');
    assert.equal((await requirementsRepository.listLatestSummaryAttempts({ projectId, scopeType: 'topic', tenantId }))[0].status, 'failed');
    engine.stop();
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
