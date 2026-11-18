import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { summarizeWithLocalFixture } from '../src/modules/requirements/summary/summary-fixture.js';
import { emptySummaryOutput } from '../src/modules/requirements/summary/summary-output.js';
import { createRequirementsTestApp, PROJECT_ID, ROLE_USERS, TENANT_ID } from './helpers/requirements-test-app.js';

const SUMMARY_EVENT = 'requirements.summary.updated';

// A requirements AI stub with summarize(). By default it answers like the local fixture.
function summaryAiStub(handler = ({ modelInput }) => ({ model: 'stub-model', output: summarizeWithLocalFixture(modelInput) })) {
  const stub = {
    calls: [],
    handler,
    provider: 'stub',
    async summarize(args) {
      stub.calls.push(args);
      return stub.handler(args);
    },
  };
  return stub;
}

function topicJob(topicId) {
  return { projectId: PROJECT_ID, scopeId: topicId, scopeType: 'topic', tenantId: TENANT_ID };
}

function summaryEvents(recorder) {
  return recorder.events
    .filter((event) => event.type === SUMMARY_EVENT)
    .map(({ scopeId, scopeType, status, summaryId, track }) => ({ scopeId, scopeType, status, summaryId, track }));
}

async function comment(harness, role, topicId, body, parentCommentId = '') {
  const response = await harness.as(role).post(`/topics/${topicId}/comments`, { body, parentCommentId });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.comment;
}

test('comment activity schedules a debounced refresh; the run is stored, published, and presented with names', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const engine = harness.app.locals.requirementsSummaries;
  const topic = await harness.createTopic({ prompt: 'Should clients see a price estimate?' });
  const projectEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.project(PROJECT_ID));

  const first = await comment(harness, 'member', topic.id, 'Show the estimate before booking.');
  assert.equal(engine.isPending(topicJob(topic.id)), true);
  assert.equal(engine.schedulerState(topicJob(topic.id)).timerKind, 'debounce');
  const dueAt = engine.schedulerState(topicJob(topic.id)).dueAt;
  assert.ok(dueAt - Date.now() > 15_000 && dueAt - Date.now() <= 20_000, 'due about 20 seconds out');

  assert.equal((await harness.as('editor').post(`/topics/${topic.id}/comments/${first.id}/vote`, { vote: 'up' })).status, 200);
  const reply = await comment(harness, 'editor', topic.id, 'Agree, show it early.', first.id);
  assert.equal(ai.calls.length, 0, 'nothing runs before the debounce elapses');

  await engine.flush();
  assert.equal(ai.calls.length, 1, 'three activities coalesce into one run');
  const stored = harness.requirementsRepository.state.summaries;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'ok');
  assert.equal(stored[0].model, 'stub-model');
  assert.match(stored[0].inputDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(stored[0].output.aligned[0].sources, [`comment:${first.id}`, `comment:${reply.id}`]);
  assert.deepEqual(summaryEvents(projectEvents), [{ scopeId: topic.id, scopeType: 'topic', status: 'ok', summaryId: stored[0].id, track: 'experience' }]);

  const detail = await harness.as('viewer').get(`/topics/${topic.id}`);
  assert.equal(detail.status, 200);
  const { summary, summaryStatus } = detail.body.topic;
  assert.equal(summary.id, stored[0].id);
  assert.equal(summary.status, 'ok');
  assert.deepEqual(summary.output.aligned[0].supporters, [`user:${ROLE_USERS.member.id}`, `user:${ROLE_USERS.editor.id}`]);
  assert.deepEqual(summary.output.aligned[0].supporterNames, [ROLE_USERS.member.name, ROLE_USERS.editor.name]);
  assert.deepEqual(summary.sources, [
    { available: true, label: 'C1', ref: `comment:${first.id}` },
    { available: true, label: 'C2', ref: `comment:${reply.id}` },
  ]);
  assert.deepEqual(summaryStatus, { lastAttemptAt: stored[0].createdAt, lastAttemptStatus: 'ok', refreshPending: false });
  assert.equal(detail.body.topic.state, 'ready', 'the summary proposes an answer two people back');
  assert.equal(engine.isPending(topicJob(topic.id)), false, 'reading a fresh topic schedules nothing');

  const register = await harness.as('viewer').get('/tracks/experience/topics');
  const row = register.body.topics.find((entry) => entry.id === topic.id);
  assert.deepEqual(row.signals, { aligned: 1, blocking: 0, divergent: 0, outstanding: 0, underExplored: 1 });
  assert.equal(row.summaryStatus.lastAttemptStatus, 'ok');
});

test('one contributor gets "not enough input" without a model call', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const topic = await harness.createTopic({ prompt: 'Is booking the first task on the home screen?' });
  await comment(harness, 'member', topic.id, 'Yes, put it first.');
  await comment(harness, 'member', topic.id, 'And keep it above the fold.');

  const refreshed = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.outcome, 'ok');
  assert.deepEqual(refreshed.body.summary.output, { ...emptySummaryOutput({ insufficientInput: true }) });
  assert.equal(ai.calls.length, 0);
  const stored = harness.requirementsRepository.state.summaries[0];
  assert.equal(stored.model, null);
  assert.equal((await harness.as('viewer').get(`/topics/${topic.id}`)).body.topic.state, 'open');
});

test('the refresh endpoint needs project.collaborate; viewers, outsiders, and stakeholder links cannot trigger it', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const topic = await harness.createTopic({ prompt: 'Who approves refunds?' });
  await comment(harness, 'member', topic.id, 'Finance approves refunds.');
  await comment(harness, 'editor', topic.id, 'Agreed, Finance.');

  assert.equal((await harness.as('viewer').post(`/topics/${topic.id}/summary/refresh`)).status, 404);
  assert.equal((await harness.as('outsider').post(`/topics/${topic.id}/summary/refresh`)).status, 404);
  assert.equal((await request(harness.app).post(`/api/projects/${PROJECT_ID}/requirements/topics/${topic.id}/summary/refresh`)).status, 401);
  assert.equal((await harness.portal(token).post(`/topics/${topic.id}/summary/refresh`)).status, 404);
  assert.equal((await harness.portal(token).get(`/topics/${topic.id}/summary/history`)).status, 404);
  assert.equal(ai.calls.length, 0);
  assert.equal(harness.requirementsRepository.state.summaries.length, 0);

  assert.equal((await harness.as('member').post('/topics/not-a-topic/summary/refresh')).status, 404);
  const allowed = await harness.as('contributor').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.run.status, 'ok');
  assert.equal(ai.calls.length, 1);

  // A forced refresh runs even when nothing changed.
  assert.equal((await harness.as('member').post(`/topics/${topic.id}/summary/refresh`)).body.outcome, 'ok');
  assert.equal(ai.calls.length, 2);
});

test('without a summary provider, refresh says AI is not configured unless no model is needed', async () => {
  const harness = await createRequirementsTestApp();
  const topic = await harness.createTopic({ prompt: 'Which browsers?' });
  await comment(harness, 'member', topic.id, 'Phones first.');
  const lonely = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(lonely.status, 200);
  assert.equal(lonely.body.summary.output.insufficientInput, true);

  await comment(harness, 'editor', topic.id, 'Desktop too.');
  const refused = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.details.code, 'ai_not_configured');
  assert.equal(harness.requirementsRepository.state.summaries.length, 1, 'no failed row for missing configuration');
});

test('a failed run keeps the previous summary, reports the failure, queues a retry, and shows in history', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const engine = harness.app.locals.requirementsSummaries;
  const topic = await harness.createTopic({ prompt: 'Should clients see a price estimate?' });
  const projectEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.project(PROJECT_ID));
  const first = await comment(harness, 'member', topic.id, 'Show the estimate before booking.');
  await comment(harness, 'editor', topic.id, '+1, show it early.', first.id);

  const ok = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(ok.body.outcome, 'ok');
  const goodId = ok.body.run.id;

  ai.handler = () => { throw new Error('upstream timeout'); };
  await comment(harness, 'contributor', topic.id, 'What about repeat clients?');
  const failed = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.outcome, 'failed');
  assert.equal(failed.body.run.failureReason, 'ai_request_failed');
  assert.equal(failed.body.summary.id, goodId, 'the previous summary stays current');
  assert.equal(failed.body.summary.lastAttemptStatus, 'failed');
  assert.equal(failed.body.summary.lastAttemptAt, failed.body.run.createdAt);
  assert.deepEqual(failed.body.summaryStatus, { lastAttemptAt: failed.body.run.createdAt, lastAttemptStatus: 'failed', refreshPending: true });
  assert.equal(engine.schedulerState(topicJob(topic.id)).timerKind, 'retry');
  assert.deepEqual(summaryEvents(projectEvents).map((event) => event.status), ['ok', 'failed']);

  const detail = await harness.as('viewer').get(`/topics/${topic.id}`);
  assert.equal(detail.body.topic.summary.id, goodId);
  assert.equal(detail.body.topic.state, 'ready', 'readiness still comes from the newest ok summary');
  assert.equal(detail.body.topic.summaryStatus.lastAttemptStatus, 'failed');
  const row = (await harness.as('viewer').get('/tracks/experience/topics')).body.topics.find((entry) => entry.id === topic.id);
  assert.equal(row.summaryStatus.lastAttemptStatus, 'failed');
  assert.equal(row.summary.id, goodId);

  // Output that cites nothing real is also a failed run.
  ai.handler = () => ({ output: { ...emptySummaryOutput(), aligned: [{ sources: ['C42'], statement: 'Invented.', supporters: ['P1'] }] } });
  const invalid = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(invalid.body.outcome, 'failed');
  assert.equal(invalid.body.run.failureReason, 'no_valid_entries');
  assert.equal(invalid.body.summary.id, goodId);

  const history = await harness.as('viewer').get(`/topics/${topic.id}/summary/history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.currentSummaryId, goodId);
  assert.deepEqual(history.body.runs.map((run) => [run.status, run.failureReason, run.current]), [
    ['failed', 'no_valid_entries', false],
    ['failed', 'ai_request_failed', false],
    ['ok', null, true],
  ]);
  assert.deepEqual(history.body.runs[0].dropped.map((record) => [record.section, record.reason]), [['aligned', 'no-valid-source']]);
  assert.equal(history.body.runs[2].output.aligned[0].supporterNames[0], ROLE_USERS.member.name);
  assert.equal(history.body.runs[2].model, 'stub-model');
  assert.equal((await harness.as('viewer').get(`/topics/${topic.id}/summary/history?limit=1`)).body.runs.length, 1);
  assert.equal((await harness.as('outsider').get(`/topics/${topic.id}/summary/history`)).status, 404);
  assert.equal((await harness.as('viewer').get('/topics/missing/summary/history')).status, 404);
});

test('uncited entries and unknown actors are dropped from a stored run and recorded', async () => {
  const ai = summaryAiStub(() => ({
    output: {
      ...emptySummaryOutput(),
      aligned: [
        { sources: ['C1', 'C99'], statement: 'Finance approves refunds.', supporters: ['P1', 'P2', 'P9'] },
        { sources: ['C42'], statement: 'Invented point.', supporters: ['P1'] },
      ],
    },
  }));
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const topic = await harness.createTopic({ prompt: 'Who approves refunds?' });
  const first = await comment(harness, 'member', topic.id, 'Finance approves refunds.');
  await comment(harness, 'editor', topic.id, 'Yes, Finance.');

  const refreshed = await harness.as('member').post(`/topics/${topic.id}/summary/refresh`);
  assert.equal(refreshed.body.outcome, 'ok');
  assert.deepEqual(refreshed.body.summary.output.aligned, [{
    sources: [`comment:${first.id}`],
    statement: 'Finance approves refunds.',
    supporterNames: [ROLE_USERS.member.name, ROLE_USERS.editor.name],
    supporters: [`user:${ROLE_USERS.member.id}`, `user:${ROLE_USERS.editor.id}`],
  }]);
  const stored = harness.requirementsRepository.state.summaries[0];
  assert.deepEqual(stored.dropped.map((record) => [record.section, record.index, record.reason, record.refs ?? null]), [
    ['aligned', 0, 'unknown-source', ['C99']],
    ['aligned', 0, 'unknown-actor', ['P9']],
    ['aligned', 1, 'no-valid-source', null],
  ]);
});

test('portal summaries carry display names only, and summary events reach only links that can see the topic', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const jamie = await harness.seedStakeholder();
  const ravi = await harness.seedStakeholder({ email: 'ravi@client.example', name: 'Ravi Shah', roleTitle: 'Finance' });
  const jamieLink = await harness.createLink(jamie.id);
  const raviLink = await harness.createLink(ravi.id);
  const jamieEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.publicRequirements(jamieLink.link.id));
  const raviEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.publicRequirements(raviLink.link.id));

  // Unassigned topics are visible to every link (Q-13a).
  const open = await harness.createTopic({ prompt: 'Should clients see a price estimate?' });
  const first = await comment(harness, 'member', open.id, 'Show the estimate before booking.');
  const portalReply = await harness.portal(jamieLink.token).post(`/topics/${open.id}/comments`, { body: 'Agreed, show it before booking.', parentCommentId: first.id });
  assert.equal(portalReply.status, 201);
  assert.equal(harness.app.locals.requirementsSummaries.isPending(topicJob(open.id)), true, 'a portal comment schedules a refresh');
  assert.equal((await harness.portal(raviLink.token).post(`/topics/${open.id}/comments/${first.id}/vote`, { vote: 'down' })).status, 200);
  const refreshed = await harness.as('member').post(`/topics/${open.id}/summary/refresh`);
  assert.equal(refreshed.body.outcome, 'ok');
  const summaryId = refreshed.body.run.id;
  assert.deepEqual(summaryEvents(jamieEvents), [{ scopeId: open.id, scopeType: 'topic', status: 'ok', summaryId, track: 'experience' }]);
  assert.deepEqual(summaryEvents(raviEvents), [{ scopeId: open.id, scopeType: 'topic', status: 'ok', summaryId, track: 'experience' }]);

  // Team view: refs and names. Portal view: names only.
  const team = refreshed.body.summary.output;
  assert.ok(team.aligned[0].supporters.includes(`stakeholder:${jamie.id}`));
  assert.ok(team.aligned[0].supporterNames.includes('Jamie Ortiz'));
  assert.ok(team.divergent[0].positions.some((position) => position.actors.includes(`stakeholder:${ravi.id}`)));

  const portalTopic = await harness.portal(raviLink.token).get(`/topics/${open.id}`);
  assert.equal(portalTopic.status, 200);
  const portalSummary = portalTopic.body.topic.summary;
  assert.equal(portalSummary.id, summaryId);
  assert.deepEqual(portalSummary.output.aligned[0].supporterNames, [ROLE_USERS.member.name, 'Jamie Ortiz']);
  assert.equal('supporters' in portalSummary.output.aligned[0], false);
  const portalPosition = portalSummary.output.divergent[0].positions.find((position) => position.actorNames.includes('Ravi Shah'));
  assert.ok(portalPosition);
  assert.equal('actors' in portalPosition, false);
  assert.deepEqual(portalSummary.sources.map((source) => source.label), ['C1', 'C2']);
  assert.deepEqual(portalTopic.body.topic.summaryStatus, { lastAttemptAt: portalSummary.createdAt, lastAttemptStatus: 'ok', refreshPending: false });
  const portalList = await harness.portal(raviLink.token).get('');
  const listed = portalList.body.topics.open.find((entry) => entry.id === open.id);
  for (const view of [portalSummary, portalTopic.body.topic.summaryStatus, listed.summary, listed.summaryStatus]) {
    const text = JSON.stringify(view);
    for (const leaked of [jamie.id, ravi.id, ROLE_USERS.member.id, 'user:', 'stakeholder:', jamie.email, ravi.email, jamieLink.token, raviLink.token]) {
      assert.equal(text.includes(leaked), false, `${leaked} must not appear in a portal summary`);
    }
  }

  // An assigned topic is visible only to its stakeholder's link.
  const assigned = await harness.createTopic({ assignments: [{ actorId: jamie.id, actorType: 'stakeholder', role: 'primary' }], prompt: 'Which refund wording do we use?' });
  await comment(harness, 'member', assigned.id, 'Use the policy wording.');
  await harness.portal(jamieLink.token).post(`/topics/${assigned.id}/comments`, { body: 'Use the policy wording, yes.' });
  const assignedRun = await harness.as('member').post(`/topics/${assigned.id}/summary/refresh`);
  assert.equal(assignedRun.body.outcome, 'ok');
  assert.ok(summaryEvents(jamieEvents).some((event) => event.scopeId === assigned.id));
  assert.equal(summaryEvents(raviEvents).some((event) => event.scopeId === assigned.id), false);

  // A revoked link hears nothing more.
  assert.equal((await harness.as('projectManager').post(`/links/${raviLink.link.id}/revoke`)).status, 200);
  const before = summaryEvents(raviEvents).length;
  await comment(harness, 'editor', open.id, 'Show it with a note.');
  await harness.as('member').post(`/topics/${open.id}/summary/refresh`);
  assert.equal(summaryEvents(raviEvents).length, before);
});

test('reads catch up on topics whose discussion moved on while nothing was scheduled', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const engine = harness.app.locals.requirementsSummaries;
  const topic = await harness.createTopic({ prompt: 'Do technicians see client notes?' });
  const quiet = await harness.createTopic({ prompt: 'Nobody has said anything yet' });

  // Comments written straight to storage, as if the process restarted after they arrived.
  for (const [userId, name, body] of [[ROLE_USERS.member.id, ROLE_USERS.member.name, 'Yes, the evening before.'], [ROLE_USERS.editor.id, ROLE_USERS.editor.name, 'Agree, the evening before.']]) {
    await harness.assistantRepository.addProjectClarificationComment({
      clarificationId: topic.id,
      comment: { actorId: userId, actorType: 'user', authorName: name, body, source: 'comment' },
      preserveStatus: true,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
    });
  }
  assert.equal(engine.isPending(topicJob(topic.id)), false);

  await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(engine.isPending(topicJob(topic.id)), true);
  assert.equal(engine.isPending(topicJob(quiet.id)), false, 'a topic nobody has commented on is left alone');
  await engine.flush();
  assert.equal(ai.calls.length, 1);

  await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(engine.isPending(topicJob(topic.id)), false, 'fresh topics are not rescheduled');

  // Activity that changes nothing the summary reads (a vote added and removed) is checked once.
  const target = harness.assistantRepository.state.projectClarificationComments.find((entry) => entry.clarificationId === topic.id);
  await harness.as('contributor').post(`/topics/${topic.id}/comments/${target.id}/vote`, { vote: 'up' });
  await harness.as('contributor').post(`/topics/${topic.id}/comments/${target.id}/vote`, { vote: 'up' });
  await engine.flush();
  assert.equal(ai.calls.length, 1, 'same input digest: no model call');
  await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(engine.isPending(topicJob(topic.id)), false);
});

test('comment edits, deletes, and votes through the requirements routes schedule a refresh', async () => {
  const ai = summaryAiStub();
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  const engine = harness.app.locals.requirementsSummaries;
  const topic = await harness.createTopic({ prompt: 'Do technicians see client notes?' });
  const scheduledAfter = async (response, status) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    const scheduled = engine.isPending(topicJob(topic.id));
    await engine.flush();
    return scheduled;
  };

  const created = await comment(harness, 'tenantAdmin', topic.id, 'Yes, the evening before.');
  await engine.flush();
  assert.equal(await scheduledAfter(await harness.as('tenantAdmin').patch(`/topics/${topic.id}/comments/${created.id}`, { body: 'Yes, the evening before the visit.' }), 200), true, 'edit');
  assert.equal(await scheduledAfter(await harness.as('tenantManager').post(`/topics/${topic.id}/comments/${created.id}/vote`, { vote: 'up' }), 200), true, 'vote');
  await comment(harness, 'tenantManager', topic.id, 'Agreed, the evening before.');
  await engine.flush();
  const extra = await comment(harness, 'tenantAdmin', topic.id, 'Typo, ignore.');
  await engine.flush();
  assert.equal(await scheduledAfter(await harness.as('tenantAdmin').del(`/topics/${topic.id}/comments/${extra.id}`), 200), true, 'delete');

  // Two people contributed, so the last run reached the model.
  assert.ok(ai.calls.length >= 1);
  const current = await harness.requirementsRepository.getCurrentSummary({ projectId: PROJECT_ID, scopeId: topic.id, scopeType: 'topic', tenantId: TENANT_ID });
  assert.equal(current.output.insufficientInput, false);
  assert.equal((await harness.as('viewer').get(`/topics/${topic.id}`)).body.topic.status, 'open', 'comment activity does not change the status');
});

test('email replies and owner changes schedule a refresh; other edits do not', async () => {
  const harness = await createRequirementsTestApp({ requirementsAiService: summaryAiStub() });
  const engine = harness.app.locals.requirementsSummaries;
  const topic = await harness.createTopic({ prompt: 'Which payment provider?' });
  const bridge = harness.assistantRepository.requirementsBridge;

  await bridge.publishTopicChange({ projectId: PROJECT_ID, reason: 'topic-updated', tenantId: TENANT_ID, topicIds: [topic.id] });
  assert.equal(engine.isPending(topicJob(topic.id)), false);
  assert.equal((await harness.as('projectManager').patch(`/topics/${topic.id}`, { rationale: 'Cost matters' })).status, 200);
  assert.equal(engine.isPending(topicJob(topic.id)), false, 'editing the topic is not discussion activity');
  const assigned = await harness.as('projectManager').patch(`/topics/${topic.id}`, { assignments: [{ actorId: ROLE_USERS.member.id, actorType: 'user', role: 'primary' }] });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(engine.isPending(topicJob(topic.id)), true, 'a new owner refreshes the summary, which weighs the owner answer');

  await bridge.publishTopicChange({ projectId: PROJECT_ID, reason: 'topic-email-replied', tenantId: TENANT_ID, topicIds: [topic.id] });
  assert.equal(engine.isPending(topicJob(topic.id)), true);
  assert.equal(engine.schedulerState(topicJob(topic.id)).timerKind, 'debounce');
  engine.stop();
  assert.equal(engine.isPending(topicJob(topic.id)), false);
});
