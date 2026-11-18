import assert from 'node:assert/strict';
import test from 'node:test';

import { REVIEW_ROUND_REMINDER_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';
import { processRoundReminders } from '../src/modules/requirements/rounds/round-reminders.js';
import { createRoundsTestApp, PROJECT_ID, roundPackageFiles, ROLE_USERS, TENANT_ID } from './helpers/requirements-rounds-app.js';

// Partial failures in rounds: each operation either completes, leaves nothing half done, or
// can be finished by doing it again. Failures are injected into the in-memory repositories
// and the mail queue, then removed, and the same request is repeated.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Makes `object[method]` throw `times` times, then behave normally again. */
function failNext(object, method, times = 1) {
  const original = object[method];
  let remaining = times;
  object[method] = async (...args) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error(`injected ${method} failure`);
    }
    return original.apply(object, args);
  };
  return () => { object[method] = original; };
}

async function openRound(extra = {}) {
  const harness = await createRoundsTestApp();
  const priceTopic = await harness.createTopic('Where should the price first appear?');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: priceTopic.id }));
  const jamie = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [{ actorId: ROLE_USERS.reviewer.id, actorType: 'user' }, { actorId: jamie.id, actorType: 'stakeholder' }],
    ...extra,
  });
  const jamieToken = harness.portalLinksInMail().find((link) => link.recipient === jamie.email).token;
  return { harness, jamie: harness.portal(jamieToken, round.id), pkg, priceTopic, round };
}

const roundDecisions = (harness, round) => harness.requirementsRepository.state.decisions.filter((decision) => decision.roundId === round.id);

test('closing a round records its decision with it: a failed decision leaves the round open, and the retry closes it', async () => {
  const { harness, round } = await openRound();
  const restore = failNext(harness.requirementsRepository, 'createDecision');
  const failed = await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'changes-requested' });
  assert.equal(failed.status, 500);
  restore();
  const afterFailure = (await harness.as('member').get(`/rounds/${round.id}`)).body;
  assert.deepEqual([afterFailure.round.status, afterFailure.round.outcome, afterFailure.round.closedAt], ['open', null, null], 'the round is still open');
  assert.equal(roundDecisions(harness, round).length, 0);

  const retried = await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'changes-requested' });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.round.status, 'closed');
  assert.equal(retried.body.decision.statement, 'Round 1: Changes requested.');
  assert.equal(roundDecisions(harness, round).length, 1);
  assert.equal((await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'abandoned' })).status, 409);
});

test('two closes at once: one wins, the other is told the round is closed, and there is one decision', async () => {
  const { harness, round } = await openRound();
  const responses = await Promise.all([
    harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'changes-requested' }),
    harness.as('tenantAdmin').post(`/rounds/${round.id}/close`, { outcome: 'abandoned' }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const decisions = roundDecisions(harness, round);
  assert.equal(decisions.length, 1);
  const winner = responses.find((response) => response.status === 200).body;
  assert.equal(decisions[0].id, winner.decision.id);
  assert.equal((await harness.as('member').get(`/rounds/${round.id}`)).body.round.outcome, winner.round.outcome);
});

test('AC-07 an answer that could not reach its topic is reported, and saving again posts it exactly once', async () => {
  const { harness, jamie, priceTopic } = await openRound();
  const topicComments = async () => (await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic.comments;

  // The topic comment fails: the answer is kept in the round, and the reviewer is told.
  let restore = failNext(harness.assistantRepository, 'addProjectClarificationComment');
  const failed = await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' });
  restore();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.details.code, 'answer_not_posted');
  assert.deepEqual(Object.keys((await jamie.get()).body.answers), ['price-placement'], 'the round has the answer');
  assert.deepEqual(await topicComments(), []);

  const retried = await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const comments = await topicComments();
  assert.equal(comments.length, 1);
  assert.equal(retried.body.answer.postedCommentId, comments[0].id);

  // The comment is posted but linking it to the answer fails: the retry links that comment
  // instead of posting a second one.
  const { harness: second, jamie: reviewer, priceTopic: topic } = await openRound();
  restore = failNext(second.roundsRepository, 'setAnswerComment');
  const unlinked = await reviewer.put('/questions/price-placement/answer', { value: 'after-time' });
  restore();
  assert.equal(unlinked.status, 503);
  const posted = (await second.as('member').get(`/topics/${topic.id}`)).body.topic.comments;
  assert.equal(posted.length, 1, 'the comment went in before the link failed');
  const relinked = await reviewer.put('/questions/price-placement/answer', { value: 'after-time' });
  assert.equal(relinked.status, 200, JSON.stringify(relinked.body));
  assert.equal(relinked.body.answer.postedCommentId, posted[0].id);
  assert.equal((await second.as('member').get(`/topics/${topic.id}`)).body.topic.comments.length, 1, 'still one comment');
});

test('AC-07 clearing an answer whose topic comment cannot be removed keeps both, and clearing again removes both', async () => {
  const { harness, jamie, priceTopic } = await openRound();
  const topicComments = async () => (await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic.comments;
  assert.equal((await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' })).status, 200);
  assert.equal((await topicComments()).length, 1);

  const restore = failNext(harness.assistantRepository, 'deleteProjectClarificationComment');
  const failed = await jamie.del('/questions/price-placement/answer');
  restore();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.details.code, 'answer_not_cleared');
  assert.deepEqual(Object.keys((await jamie.get()).body.answers), ['price-placement'], 'the answer stays until its comment is gone');
  assert.equal((await topicComments()).length, 1);

  assert.equal((await jamie.del('/questions/price-placement/answer')).status, 200);
  assert.deepEqual((await jamie.get()).body.answers, {});
  assert.deepEqual(await topicComments(), []);
});

test('a reminder that could not be queued is tried again on the next run, and still sent only once', async () => {
  const dueAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
  const { harness, round } = await openRound({ dueAt, reminder: { daysBefore: 1 } });
  const deps = {
    assistantRepository: harness.assistantRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    mailRepository: harness.mail,
    packagesRepository: harness.packagesRepository,
    projectRepository: harness.projectRepository,
    requirementsRepository: harness.requirementsRepository,
    roundsRepository: harness.roundsRepository,
  };
  const reminders = () => harness.mail.state.queue.filter((row) => row.templateId === REVIEW_ROUND_REMINDER_TEMPLATE_ID);
  const remindedAt = async () => (await harness.as('member').get(`/rounds/${round.id}`)).body.round.reviewers.map((reviewer) => reviewer.remindedAt);
  const inWindow = new Date(Date.parse(dueAt) - 12 * 60 * 60 * 1000);

  const restore = failNext(harness.mail, 'queueMail');
  assert.deepEqual(await processRoundReminders(deps, { now: inWindow }), { due: 2, failed: 1, notSent: 0, queued: 1, skipped: 0 });
  restore();
  assert.equal(reminders().length, 1);
  assert.equal((await remindedAt()).filter(Boolean).length, 1, 'only the queued reminder counts as sent');

  const later = new Date(inWindow.valueOf() + 15 * 60 * 1000);
  assert.deepEqual(await processRoundReminders(deps, { now: later }), { due: 1, failed: 0, notSent: 0, queued: 1, skipped: 0 });
  assert.deepEqual(await processRoundReminders(deps, { now: later }), { due: 0, failed: 0, notSent: 0, queued: 0, skipped: 0 });
  assert.equal(reminders().length, 2, 'one reminder per reviewer');
  assert.equal(new Set(reminders().map((row) => row.recipientEmail)).size, 2);
  assert.ok((await remindedAt()).every(Boolean));
});

test('AC-07 clearing after a save that posted but did not link removes that comment, and a later answer is the only one', async () => {
  const { harness, jamie, priceTopic } = await openRound();
  const topicComments = async () => (await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic.comments;

  const restore = failNext(harness.roundsRepository, 'setAnswerComment');
  assert.equal((await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' })).status, 503);
  restore();
  assert.equal((await topicComments()).length, 1, 'posted, not linked');

  assert.equal((await jamie.del('/questions/price-placement/answer')).status, 200);
  assert.deepEqual((await jamie.get()).body.answers, {});
  assert.deepEqual(await topicComments(), [], 'the unlinked comment went with the answer');

  assert.equal((await jamie.put('/questions/price-placement/answer', { value: 'after-time' })).status, 200);
  const comments = await topicComments();
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^Only after a time is picked/);
});

test('AC-07 after a moderator removes an answer\'s replied-to comment, the next comment also survives an interrupted save and is cleared with the answer', async () => {
  const { harness, jamie, priceTopic } = await openRound();
  const flatten = (comments) => comments.flatMap((comment) => [comment, ...flatten(comment.replies ?? [])]);
  const liveAnswers = async () => flatten((await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic.comments)
    .filter((comment) => comment.source === 'round-answer' && !comment.deletedAt && !comment.isDeleted);
  const first = await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' });
  assert.equal(first.status, 200);
  const firstId = first.body.answer.postedCommentId;
  // With a reply, removing the comment keeps it in the thread as removed, so its id stays taken.
  assert.equal((await harness.as('member').post(`/topics/${priceTopic.id}/comments`, { body: 'Agreed.', parentCommentId: firstId })).status, 201);
  await harness.assistantRepository.deleteProjectClarificationComment({ clarificationId: priceTopic.id, commentId: firstId, preserveStatus: true, projectId: PROJECT_ID, tenantId: TENANT_ID });
  assert.deepEqual(await liveAnswers(), []);

  const restore = failNext(harness.roundsRepository, 'setAnswerComment');
  assert.equal((await jamie.put('/questions/price-placement/answer', { value: 'after-time' })).status, 503);
  restore();
  const posted = await liveAnswers();
  assert.equal(posted.length, 1);
  assert.notEqual(posted[0].id, firstId, 'the save posted under the next id in the sequence');

  const retried = await jamie.put('/questions/price-placement/answer', { value: 'after-time' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.answer.postedCommentId, posted[0].id, 'the retry links the comment the failed save posted');
  assert.equal((await liveAnswers()).length, 1);

  assert.equal((await jamie.del('/questions/price-placement/answer')).status, 200);
  assert.deepEqual(await liveAnswers(), []);
});

test('a reminder run that stops after queuing and before marking the reviewer is finished by the next run without a second email', async () => {
  const dueAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
  const { harness, round } = await openRound({ dueAt, reminder: { daysBefore: 1 } });
  const deps = {
    assistantRepository: harness.assistantRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    mailRepository: harness.mail,
    packagesRepository: harness.packagesRepository,
    projectRepository: harness.projectRepository,
    requirementsRepository: harness.requirementsRepository,
    roundsRepository: harness.roundsRepository,
  };
  const reminders = () => harness.mail.state.queue.filter((row) => row.templateId === REVIEW_ROUND_REMINDER_TEMPLATE_ID);
  const remindedAt = async () => (await harness.as('member').get(`/rounds/${round.id}`)).body.round.reviewers.map((reviewer) => reviewer.remindedAt);
  const inWindow = new Date(Date.parse(dueAt) - 12 * 60 * 60 * 1000);

  // The first reviewer's email is queued, then the run stops before recording it.
  const restore = failNext(harness.roundsRepository, 'markReminded');
  assert.deepEqual(await processRoundReminders(deps, { now: inWindow }), { due: 2, failed: 1, notSent: 0, queued: 1, skipped: 0 });
  restore();
  assert.equal(reminders().length, 2, 'both emails are in the queue');
  assert.equal((await remindedAt()).filter(Boolean).length, 1);

  const later = new Date(inWindow.valueOf() + 60 * 60 * 1000);
  assert.deepEqual(await processRoundReminders(deps, { now: later }), { due: 1, failed: 0, notSent: 0, queued: 1, skipped: 0 });
  assert.equal(reminders().length, 2, 'the next run queues nothing new');
  assert.ok((await remindedAt()).every(Boolean));
  assert.deepEqual(await processRoundReminders(deps, { now: later }), { due: 0, failed: 0, notSent: 0, queued: 0, skipped: 0 });
});
