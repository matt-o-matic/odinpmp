import assert from 'node:assert/strict';
import test from 'node:test';

import { emptySummaryOutput } from '../src/modules/requirements/summary/summary-output.js';
import { closingDecisionFor } from '../src/modules/requirements/rounds/round-close-topics.js';
import { createRoundsTestApp, PROJECT_ID, roundPackageFiles, ROLE_USERS, TENANT_ID } from './helpers/requirements-rounds-app.js';

// Closing a round closes out its questions' topics, and round preferences stay out of Decide.

const ROUND = { id: 'round-1', number: 2 };
const answer = (status, extra = {}) => ({
  id: 'summary-1',
  output: { ...emptySummaryOutput(), proposedAnswer: 'A range on the home screen.', proposedAnswerSources: ['comment:c1'], proposedAnswerStatus: status, ...extra },
  status: 'ok',
});

test('the closing decision follows the topic: Odin\'s answer, a deferral, or nothing', () => {
  const open = { id: 't1', status: 'open' };
  assert.equal(closingDecisionFor({ round: ROUND, topic: null }), null, 'deleted');
  assert.equal(closingDecisionFor({ round: ROUND, topic: { id: 't1', status: 'dismissed' } }), null, 'dismissed');
  assert.equal(closingDecisionFor({ round: ROUND, summary: answer('agreed'), topic: { id: 't1', status: 'resolved' } }), null, 'already decided');

  const agreed = closingDecisionFor({
    round: ROUND,
    summary: answer('agreed', { aligned: [{ sources: ['comment:c2', 'comment:c1'], statement: 'x', supporters: [] }] }),
    topic: open,
  });
  assert.deepEqual(agreed, {
    outcome: 'agreed',
    sourceSummaryId: 'summary-1',
    sources: ['comment:c1', 'comment:c2'],
    statement: 'A range on the home screen.',
    supersedesId: null,
    topicStatus: 'resolved',
  });
  // An owner's or one person's answer is recorded as Decided, and replaces a deferral.
  assert.equal(closingDecisionFor({ round: ROUND, summary: answer('owner-answered'), topic: open }).outcome, 'decided');
  const replacing = closingDecisionFor({ activeDecision: { id: 'd-defer', outcome: 'deferred' }, round: ROUND, summary: answer('awaiting-confirmation'), topic: open });
  assert.equal(replacing.outcome, 'decided');
  assert.equal(replacing.supersedesId, 'd-defer');

  // No answer: deferred once; a topic already deferred stays as it is.
  const deferred = closingDecisionFor({ round: ROUND, summary: { id: 's2', output: emptySummaryOutput({ insufficientInput: true }), status: 'ok' }, topic: open });
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(deferred.topicStatus, null);
  assert.match(deferred.statement, /review round 2 closed/);
  assert.equal(closingDecisionFor({ activeDecision: { id: 'd-defer', outcome: 'deferred' }, round: ROUND, topic: open }), null);
});

async function publishedRound() {
  const harness = await createRoundsTestApp();
  const priceTopic = await harness.createTopic('Where should the price first appear?');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: priceTopic.id }));
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [{ actorId: ROLE_USERS.reviewer.id, actorType: 'user', required: true }],
  });
  const stored = harness.roundsRepository.state.rounds.find((entry) => entry.id === round.id);
  return { harness, questionTopics: stored.questionTopics, round };
}

function seedSummary(harness, { output, scopeId, scopeType = 'topic' }) {
  return harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: { createdAt: '2099-01-01T00:00:00.000Z', output, scopeId, scopeType, status: 'ok', track: 'experience' },
    tenantId: TENANT_ID,
  });
}

test('closing a round records each undecided question from Odin\'s answer or defers it, and leaves decided ones alone', async () => {
  const { harness, questionTopics, round } = await publishedRound();
  const topicFor = (questionId) => questionTopics[questionId];

  await seedSummary(harness, {
    output: { ...emptySummaryOutput(), proposedAnswer: 'Show a range on the home screen.', proposedAnswerSources: ['comment:c1'], proposedAnswerStatus: 'owner-answered' },
    scopeId: topicFor('price-placement'),
  });
  await seedSummary(harness, {
    output: { ...emptySummaryOutput(), proposedAnswer: 'Say "before tax" on the web.', proposedAnswerSources: ['comment:c2'], proposedAnswerStatus: 'agreed' },
    scopeId: topicFor('before-tax'),
  });
  const manual = await harness.as('projectManager').post('/decisions', {
    outcome: 'decided',
    sources: [],
    statement: 'Two days of notice.',
    topicId: topicFor('notice'),
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));

  const closed = await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'screens-accepted' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual(closed.body.closedTopics, { decided: 2, deferred: 1 });

  const { body } = await harness.as('viewer').get('/tracks/experience/decisions?kind=topic');
  const active = new Map(body.decisions.filter((decision) => decision.status === 'active').map((decision) => [decision.topicId, decision]));
  assert.deepEqual(
    ['price-placement', 'before-tax', 'notice', 'speed'].map((questionId) => {
      const decision = active.get(topicFor(questionId));
      return [questionId, decision?.outcome, decision?.decidedBy?.ref];
    }),
    [
      ['price-placement', 'decided', 'user:user-pmanager'],
      ['before-tax', 'agreed', 'user:user-pmanager'],
      ['notice', 'decided', 'user:user-pmanager'],
      ['speed', 'deferred', 'user:user-pmanager'],
    ],
  );
  assert.equal(active.get(topicFor('price-placement')).statement, 'Show a range on the home screen.');
  assert.deepEqual(active.get(topicFor('price-placement')).sources, ['comment:c1']);
  assert.equal(active.get(topicFor('notice')).statement, 'Two days of notice.', 'a decided topic keeps its decision');
  assert.equal(body.decisions.filter((decision) => decision.topicId === topicFor('notice')).length, 1);

  // Nothing from the round waits in Decide.
  const topics = await harness.as('projectManager').get('/tracks/experience/topics');
  const roundTopics = topics.body.topics.filter((topic) => Object.values(questionTopics).includes(topic.id));
  assert.equal(roundTopics.length, 4);
  assert.deepEqual(roundTopics.filter((topic) => topic.state === 'ready'), []);
});

test('round and screen preferences stay out of Decide; topic ones still show', async () => {
  const { harness, questionTopics, round } = await publishedRound();
  const preference = (statement) => ({ ...emptySummaryOutput(), proposedPreferences: [{ dimension: 'color', sources: ['comment:c1'], stance: 'keep', statement }] });
  await seedSummary(harness, { output: preference('Keep the green buttons.'), scopeId: round.id, scopeType: 'round' });
  await seedSummary(harness, { output: preference('Keep the large type.'), scopeId: `${round.id}:home`, scopeType: 'screen' });
  await seedSummary(harness, { output: preference('Keep the price in bold.'), scopeId: questionTopics['price-placement'] });

  const overview = await harness.as('projectManager').get('/');
  assert.equal(overview.body.tracks.experience.stages.decide.proposedPreferences, 1);
  const mine = await harness.as('projectManager').get('/my-items');
  assert.deepEqual(mine.body.groups.decide.filter((item) => item.kind === 'preference').map((item) => item.title), ['Keep the price in bold.']);

  // The round page still reads all of them; accepted ones say where they came from.
  const listed = await harness.as('projectManager').get('/tracks/experience/preferences');
  assert.equal(listed.body.proposed.length, 3);
  const roundItem = listed.body.proposed.find((item) => item.scopeType === 'round');
  const accepted = await harness.as('projectManager').post('/preferences/accept', {
    dimension: roundItem.dimension,
    key: roundItem.key,
    outcome: 'agreed',
    sources: roundItem.sources,
    stance: roundItem.stance,
    statement: roundItem.statement,
    track: 'experience',
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.decision.preference.origin, 'round');
  const decisions = await harness.as('viewer').get('/tracks/experience/decisions?kind=preference');
  assert.deepEqual(decisions.body.decisions.map((decision) => decision.preference.origin), ['round']);
});
