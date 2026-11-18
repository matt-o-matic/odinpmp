import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoundsTestApp, PROJECT_ID, roundPackageFiles, ROLE_USERS, TENANT_ID } from './helpers/requirements-rounds-app.js';

// A round question whose topic the team deleted or dismissed after publishing: reviewers see
// it as removed and cannot answer it, stored answers are kept, and a topic delete counts
// round answers even when they never reached the topic thread.

const REMOVED_MESSAGE = 'This question has been removed and no longer needs an answer.';

/** Makes `object[method]` throw once, then behave normally again. */
function failOnce(object, method) {
  const original = object[method];
  object[method] = async () => {
    object[method] = original;
    throw new Error(`injected ${method} failure`);
  };
}

async function openRound() {
  const harness = await createRoundsTestApp();
  const priceTopic = await harness.createTopic('Where should the price first appear?');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: priceTopic.id }));
  const jamie = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [
      { actorId: ROLE_USERS.reviewer.id, actorType: 'user' },
      { actorId: jamie.id, actorType: 'stakeholder', required: true },
      { actorId: casey.id, actorType: 'stakeholder' },
    ],
  });
  const jamieToken = harness.portalLinksInMail().find((link) => link.recipient === jamie.email).token;
  return { casey, harness, jamie, jamieToken, priceTopic, round };
}

/** Waits a few turns of the event loop for listeners that run after the response. */
async function eventually(check) {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  return check();
}

const storedAnswers = (harness, questionId) => harness.roundsRepository.state.answers.filter((answer) => answer.questionId === questionId);

test('a topic asked only in a round nobody answered deletes without a prompt, and reviewers then see the question as removed', async () => {
  const { harness, jamieToken, round } = await openRound();
  const speedTopic = round.questionTopics.speed;
  const events = harness.recordEvents(harness.projectChannel);

  const deleted = await harness.as('member').del(`/topics/${speedTopic}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.ok(await eventually(() => events.events.some((event) => event.type === 'requirements.rounds.invalidated' && event.reason === 'question-changed' && event.roundId === round.id)),
    'open reviews are told to refetch');
  events.unsubscribe();

  const review = harness.portal(jamieToken, round.id);
  const state = await review.get();
  assert.equal(state.status, 200, 'the round still opens');
  assert.deepEqual(state.body.questions.map((question) => [question.id, question.removed]), [
    ['price-placement', false], ['before-tax', false], ['notice', false], ['speed', true],
  ]);
  assert.deepEqual(state.body.progress.questions, { done: 0, total: 3 }, 'a removed question is not part of progress');

  const refused = await review.put('/questions/speed/answer', { value: 4 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.code, 'question_removed');
  assert.equal(refused.body.details.message, REMOVED_MESSAGE);
  assert.deepEqual(storedAnswers(harness, 'speed'), [], 'nothing is stored for a removed question');
  assert.equal((await review.del('/questions/speed/answer')).body.details.code, 'question_removed');

  // Other questions still take answers, and progress counts only those still asked.
  const answered = await review.put('/questions/before-tax/answer', { value: ['web'] });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(answered.body.progress.questions, { done: 1, total: 3 });

  const inbox = await harness.portal(jamieToken).get('/rounds');
  assert.equal(inbox.body.rounds[0].progress.questions.total, 3, 'the portal inbox counts the same way');
  const team = await harness.as('member').get(`/rounds/${round.id}`);
  const jamieRow = team.body.round.reviewers.find((reviewer) => reviewer.actorType === 'stakeholder' && reviewer.required);
  assert.deepEqual(jamieRow.progress.questions, { done: 1, total: 3 }, 'so does the team view of reviewer progress');

  // A team reviewer sees the same.
  const ravi = harness.team('reviewer', round.id);
  assert.equal((await ravi.get()).body.questions.find((question) => question.id === 'speed').removed, true);
  assert.equal((await ravi.put('/questions/speed/answer', { value: 2 })).body.details.code, 'question_removed');

  const submitted = await review.post('/submit', {});
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.body.summary.questions.find((question) => question.questionId === 'speed'), { answered: false, questionId: 'speed', removed: true });
});

test('a dismissed topic\'s question is removed while it stays dismissed; the answer already given is kept, not shown', async () => {
  const { harness, jamieToken, priceTopic, round } = await openRound();
  const review = harness.portal(jamieToken, round.id);
  assert.equal((await review.put('/questions/price-placement/answer', { value: 'range-on-home' })).status, 200);

  assert.equal((await harness.as('projectManager').patch(`/topics/${priceTopic.id}`, { status: 'dismissed' })).status, 200);
  const state = await review.get();
  assert.equal(state.body.questions.find((question) => question.id === 'price-placement').removed, true);
  assert.equal(state.body.answers['price-placement'], undefined, 'the stored answer is no longer shown as asked for');
  assert.deepEqual(state.body.progress.questions, { done: 0, total: 3 });

  assert.equal((await review.put('/questions/price-placement/answer', { value: 'after-time' })).body.details.code, 'question_removed');
  assert.equal((await review.del('/questions/price-placement/answer')).body.details.code, 'question_removed');
  const kept = storedAnswers(harness, 'price-placement');
  assert.equal(kept.length, 1, 'the answer stays stored');
  assert.equal(kept[0].value, 'range-on-home');
  assert.equal((await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic.comments.length, 1, 'and so does its comment');

  // The round summary leaves the removed question and its answer out.
  assert.equal((await review.put('/screens/home/verdict', { overall: 'keep' })).status, 200);
  const refreshed = await harness.as('member').post(`/rounds/${round.id}/summary/refresh`, {});
  assert.ok(refreshed.status < 300, JSON.stringify(refreshed.body));
  const roundInput = harness.summaryAi.calls.filter((call) => call.scopeType === 'round').at(-1).modelInput;
  assert.deepEqual(roundInput.untrustedContent.sources.map((source) => source.kind), ['verdict']);
  assert.equal(roundInput.untrustedContent.context.questions.length, 3);
  assert.ok(!(roundInput.untrustedContent.context.linkedTopics ?? []).some((entry) => entry.state === 'removed'));

  // Reopening asks the question again, with the earlier answer.
  assert.equal((await harness.as('projectManager').patch(`/topics/${priceTopic.id}`, { status: 'open' })).status, 200);
  const reopened = await review.get();
  assert.equal(reopened.body.questions.find((question) => question.id === 'price-placement').removed, false);
  assert.equal(reopened.body.answers['price-placement'].value, 'range-on-home');
});

test('a topic deleted while an answer is being saved leaves no answer behind', async () => {
  const { harness, jamieToken, round } = await openRound();
  const speedTopic = round.questionTopics.speed;
  // The delete lands after the answerable check and the insert, before the post to the thread.
  const upsert = harness.roundsRepository.upsertAnswer;
  harness.roundsRepository.upsertAnswer = async (args) => {
    harness.roundsRepository.upsertAnswer = upsert;
    const stored = await upsert(args);
    const removed = await harness.requirementsRepository.deleteTopic({ projectId: PROJECT_ID, tenantId: TENANT_ID, topicId: speedTopic });
    assert.equal(removed.deleted, true);
    return stored;
  };
  const saved = await harness.portal(jamieToken, round.id).put('/questions/speed/answer', { value: 4 });
  assert.equal(saved.status, 409);
  assert.equal(saved.body.details.code, 'question_removed');
  assert.deepEqual(storedAnswers(harness, 'speed'), [], 'the answer stored before the delete is removed');
});

test('a topic deleted after the save read it, before the answer reached its thread, leaves no answer behind', async () => {
  const { harness, jamieToken, round } = await openRound();
  const speedTopic = round.questionTopics.speed;
  // The delete lands between reading the topic and posting the comment.
  const add = harness.assistantRepository.addProjectClarificationComment;
  harness.assistantRepository.addProjectClarificationComment = async (args) => {
    harness.assistantRepository.addProjectClarificationComment = add;
    await harness.requirementsRepository.deleteTopic({ projectId: PROJECT_ID, tenantId: TENANT_ID, topicId: speedTopic });
    return add(args);
  };
  const saved = await harness.portal(jamieToken, round.id).put('/questions/speed/answer', { value: 4 });
  assert.equal(saved.status, 409);
  assert.equal(saved.body.details.code, 'question_removed');
  assert.deepEqual(storedAnswers(harness, 'speed'), []);
});

test('a topic dismissed while an answer is being edited keeps the answer given before', async () => {
  const { harness, jamieToken, priceTopic, round } = await openRound();
  const review = harness.portal(jamieToken, round.id);
  assert.equal((await review.put('/questions/price-placement/answer', { value: 'range-on-home' })).status, 200);

  // The dismissal lands after the answerable check and the write.
  const upsert = harness.roundsRepository.upsertAnswer;
  harness.roundsRepository.upsertAnswer = async (args) => {
    harness.roundsRepository.upsertAnswer = upsert;
    const stored = await upsert(args);
    await harness.assistantRepository.updateProjectClarification({ clarificationId: priceTopic.id, patch: { status: 'dismissed' }, projectId: PROJECT_ID, tenantId: TENANT_ID });
    return stored;
  };
  const edited = await review.put('/questions/price-placement/answer', { value: 'after-time' });
  assert.equal(edited.status, 409);
  assert.equal(edited.body.details.code, 'question_removed');
  assert.deepEqual(storedAnswers(harness, 'price-placement').map((answer) => answer.value), ['range-on-home'], 'the earlier answer is put back');
});

test('a topic with a round answer that never reached its thread cannot be deleted, single or in bulk', async () => {
  const { harness, jamieToken, priceTopic, round } = await openRound();
  const review = harness.portal(jamieToken, round.id);

  // The answer is saved but posting it to the topic fails, so the thread stays empty.
  failOnce(harness.assistantRepository, 'addProjectClarificationComment');
  assert.equal((await review.put('/questions/price-placement/answer', { value: 'range-on-home' })).status, 503);
  assert.deepEqual((await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic.comments, []);

  const refused = await harness.as('member').del(`/topics/${priceTopic.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.code, 'topic_has_activity');
  assert.equal(refused.body.details.activity.answers, 1);
  assert.match(refused.body.details.message, /answered this topic's question in a review round/);
  const bulk = await harness.as('member').post('/topics/bulk', { action: 'delete', topicIds: [priceTopic.id] });
  assert.deepEqual(bulk.body.results.map((result) => [result.status, result.code]), [['skipped', 'topic_has_answers']]);
  assert.match(bulk.body.results[0].message, /review round/);
  assert.equal((await harness.as('member').get(`/topics/${priceTopic.id}`)).status, 200, 'the topic is still there');

  // An answer whose comment was removed from the thread afterwards still counts.
  const speedTopic = round.questionTopics.speed;
  const speed = await review.put('/questions/speed/answer', { value: 4 });
  assert.equal(speed.status, 200);
  const removedComment = await harness.portal(jamieToken).del(`/topics/${speedTopic}/comments/${speed.body.answer.postedCommentId}`);
  assert.equal(removedComment.status, 200, JSON.stringify(removedComment.body));
  assert.deepEqual((await harness.as('member').get(`/topics/${speedTopic}`)).body.topic.comments, []);
  const stillRefused = await harness.as('member').del(`/topics/${speedTopic}`);
  assert.equal(stillRefused.status, 409);
  assert.equal(stillRefused.body.details.activity.answers, 1);
});

test('a portal link to a deleted or dismissed question says it was removed; one shared with someone else stays not found', async () => {
  const { casey, harness, jamieToken } = await openRound();
  const portal = harness.portal(jamieToken);
  const doomed = await harness.createTopic('Do we still need the waitlist?');
  const shelved = await harness.createTopic('Should reminders go by text?');
  const theirs = await harness.createTopic('What does Casey\'s team need?');
  assert.equal((await portal.get(`/topics/${doomed.id}`)).status, 200);

  assert.equal((await harness.as('member').del(`/topics/${doomed.id}`)).status, 200);
  assert.equal((await harness.as('projectManager').patch(`/topics/${shelved.id}`, { status: 'dismissed' })).status, 200);
  assert.equal((await harness.as('member').patch(`/topics/${theirs.id}`, { assignments: [{ actorId: casey.id, actorType: 'stakeholder' }] })).status, 200);

  for (const topic of [doomed, shelved]) {
    const opened = await portal.get(`/topics/${topic.id}`);
    assert.equal(opened.status, 404, topic.prompt);
    assert.equal(opened.body.details.code, 'question_removed');
    assert.equal(opened.body.details.message, REMOVED_MESSAGE);
    const commented = await portal.post(`/topics/${topic.id}/comments`, { body: 'Still relevant?' });
    assert.equal(commented.body.details.code, 'question_removed', 'writes get the same answer');
  }
  const hidden = await portal.get(`/topics/${theirs.id}`);
  assert.equal(hidden.status, 404);
  assert.notEqual(hidden.body.details?.code, 'question_removed');
});
