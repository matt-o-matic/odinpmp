import assert from 'node:assert/strict';
import test from 'node:test';

import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { REVIEW_ROUND_INVITATION_TEMPLATE_ID, REVIEW_ROUND_REMINDER_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';
import { hashAccessToken } from '../src/modules/requirements/requirements-access-links.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { processRoundReminders, reminderTargetId } from '../src/modules/requirements/rounds/round-reminders.js';
import { createRoundsTestApp, PROJECT_ID, roundPackageFiles, ROLE_USERS, TENANT_ID } from './helpers/requirements-rounds-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup({ stakeholders = 2 } = {}) {
  const harness = await createRoundsTestApp();
  const priceTopic = await harness.createTopic('Where should the price first appear?');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: priceTopic.id }));
  const people = [];
  for (let index = 0; index < stakeholders; index += 1) {
    people.push(await harness.seedStakeholder({ email: `client${index + 1}@client.example`, name: `Client ${index + 1}` }));
  }
  return { harness, people, pkg, priceTopic };
}

function reviewersFor(people, users = ['member', 'reviewer']) {
  return [
    ...users.map((key, index) => ({ actorId: ROLE_USERS[key].id, actorType: 'user', required: index === 0 })),
    ...people.map((stakeholder, index) => ({ actorId: stakeholder.id, actorType: 'stakeholder', required: index === 0 })),
  ];
}

test('AC-06 a member publishes a draft as round 1: package published, four invitations queued, question topics created or resolved', async () => {
  const { harness, people, pkg, priceTopic } = await setup();
  const events = harness.recordEvents(harness.projectChannel);
  const dueAt = new Date(Date.now() + 5 * DAY_MS).toISOString();

  const response = await harness.as('member').post('/rounds', {
    dueAt,
    note: 'Focus on the price range.',
    packageId: pkg.id,
    reminder: { daysBefore: 1 },
    reviewers: reviewersFor(people),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { round } = response.body;
  assert.equal(round.number, 1);
  assert.equal(round.status, 'open');
  assert.equal(round.track, 'experience');
  assert.equal(round.packageId, pkg.id);
  assert.equal(round.packageVersion, 1);
  assert.equal(round.title, 'Client booking');
  assert.equal(round.dueAt, dueAt);
  assert.equal(round.note, 'Focus on the price range.');
  assert.deepEqual(round.reminder, { daysBefore: 1 });
  assert.deepEqual(round.publishedBy, { id: ROLE_USERS.member.id, name: 'Mona Member', ref: 'user:user-member', type: 'user' });
  assert.deepEqual(round.counts, { required: 2, requiredSubmitted: 0, reviewers: 4, submitted: 0 });
  assert.deepEqual(round.package, { id: pkg.id, status: 'published', title: 'Client booking', version: 1 });
  assert.deepEqual(response.body.carryForward, { carried: 0, outdated: 0, superseded: 0 });

  // Package status flips to published.
  const stored = await harness.packagesRepository.getPackage({ packageId: pkg.id, projectId: PROJECT_ID, tenantId: TENANT_ID });
  assert.equal(stored.status, 'published');

  // Questions: the linked topic resolves; the others become open package-question topics in the track.
  assert.equal(round.questionTopics['price-placement'], priceTopic.id);
  assert.equal(response.body.createdTopicIds.length, 3);
  for (const questionId of ['before-tax', 'notice', 'speed']) assert.ok(response.body.createdTopicIds.includes(round.questionTopics[questionId]));
  const meta = await harness.requirementsRepository.listTopicMeta({ projectId: PROJECT_ID, tenantId: TENANT_ID });
  const created = meta.filter((entry) => response.body.createdTopicIds.includes(entry.id));
  assert.deepEqual(created.map((entry) => [entry.track, entry.topicOrigin, entry.createdBy]), Array(3).fill(['experience', 'package-question', 'user:user-member']));
  const topics = (await harness.as('viewer').get('/tracks/experience/topics')).body.topics;
  const notice = topics.find((topic) => topic.id === round.questionTopics.notice);
  assert.equal(notice.prompt, 'How much notice do clients need to reschedule?');
  assert.equal(notice.status, 'open');
  assert.equal(notice.rationale, 'Hours or days.');

  // Four invitations: members get the app URL, stakeholders a fresh portal token deep-linked to the round.
  const queue = harness.mail.state.queue.filter((row) => row.templateId === REVIEW_ROUND_INVITATION_TEMPLATE_ID);
  assert.equal(queue.length, 4);
  assert.ok(queue.every((row) => row.targetId.length <= 36), 'mail_queue.mail_target_id is VARCHAR(36) in production');
  assert.deepEqual(queue.map((row) => row.recipientEmail).sort(), ['client1@client.example', 'client2@client.example', 'user-member@acme.com', 'user-reviewer@acme.com']);
  const memberMail = queue.find((row) => row.recipientEmail === 'user-member@acme.com');
  assert.match(memberMail.subject, /Review round 1 for Client booking/);
  assert.ok(memberMail.body.includes(`http://localhost:5173/app/projects/${PROJECT_ID}/requirements/review?round=${round.id}`));
  assert.ok(memberMail.body.includes('Focus on the price range.'));
  assert.equal(/\/requirements\/[A-Za-z0-9_-]{40,}\/rounds\//.test(memberMail.body), false, 'members get no portal token');
  const links = harness.portalLinksInMail();
  assert.equal(links.length, 2);
  assert.ok(links.every((link) => link.roundId === round.id));
  const storedTokens = harness.requirementsRepository.state.tokens;
  for (const link of links) {
    const tokenRow = storedTokens.find((entry) => entry.tokenHash === hashAccessToken(link.token));
    assert.ok(tokenRow, 'the emailed token is stored hashed');
    assert.equal(tokenRow.purpose, 'invitation');
    assert.equal(tokenRow.createdBy, 'user:user-member');
  }
  assert.equal(JSON.stringify(harness.requirementsRepository.state).includes(links[0].token), false, 'tokens are never stored in clear');
  for (const reviewer of round.reviewers) {
    assert.equal(reviewer.mail.status, 'queued');
    assert.ok(reviewer.mail.queuedAt);
  }
  assert.equal(round.reviewers.find((reviewer) => reviewer.actorType === 'stakeholder').email, 'client1@client.example');

  // The emailed link opens the portal without signing in, and the round is listed for that stakeholder.
  const portalRounds = await harness.portal(links[0].token).get('/rounds');
  assert.equal(portalRounds.status, 200, JSON.stringify(portalRounds.body));
  assert.deepEqual(portalRounds.body.rounds.map((item) => [item.id, item.number, item.status, item.title]), [[round.id, 1, 'open', 'Client booking']]);
  // "Mona Member asked you to review...": the publisher by name only, never an id.
  assert.deepEqual(portalRounds.body.rounds[0].publishedBy, { name: ROLE_USERS.member.name });
  assert.equal(JSON.stringify(portalRounds.body).includes(ROLE_USERS.member.id), false);
  assert.deepEqual(portalRounds.body.rounds[0].progress, {
    directions: { done: 0, total: 2 }, done: 0, questions: { done: 0, total: 4 }, screens: { done: 0, total: 3 }, total: 9,
  });

  // Live events: the round, the package, and the new topics.
  const types = events.events.map((event) => `${event.type}:${event.reason}`);
  assert.ok(types.includes('requirements.rounds.invalidated:round-published'));
  assert.ok(types.includes('requirements.packages.invalidated:published'));
  assert.ok(types.includes('requirements.topics.invalidated:topics-created-from-package'));
  assert.equal(types.some((type) => type.startsWith('project.assets.invalidated')), false, 'round writes skip the generic project refresh');

  // My open items and the overview's Review stage see the round.
  const mine = await harness.as('reviewer').get('/my-items');
  assert.deepEqual(mine.body.groups.review.map((item) => [item.id, item.title, item.meta.required]), [[round.id, 'Round 1', false]]);
  const overview = await harness.as('viewer').get('/');
  assert.deepEqual(
    { id: overview.body.tracks.experience.stages.review.latestRound.id, state: overview.body.tracks.experience.stages.review.state, total: overview.body.tracks.experience.stages.review.latestRound.reviewersTotal },
    { id: round.id, state: 'open', total: 4 },
  );
});

test('one open round at a time: publishing another returns 409, and closePrevious needs decision rights', async () => {
  const { harness, people, pkg } = await setup({ stakeholders: 1 });
  const first = await harness.publish({ packageId: pkg.id, reviewers: reviewersFor(people, ['reviewer']) });
  const second = await harness.uploadPackage(roundPackageFiles({ css: 'body { color: red; }' }));
  assert.equal(second.version, 2);

  const blocked = await harness.as('member').post('/rounds', { packageId: second.id, reviewers: reviewersFor(people, ['reviewer']) });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.code, 'round_open');
  assert.equal(blocked.body.details.openRoundId, first.round.id);
  assert.equal((await harness.packagesRepository.getPackage({ packageId: second.id, projectId: PROJECT_ID, tenantId: TENANT_ID })).status, 'draft', 'nothing changes on 409');

  // A member cannot close the previous round on the way (decision rights, Q-04).
  const memberClose = await harness.as('member').post('/rounds', {
    closePrevious: { outcome: 'changes-requested' },
    packageId: second.id,
    reviewers: reviewersFor(people, ['reviewer']),
  });
  assert.equal(memberClose.status, 404);

  // Republishing a package that is already published is a conflict too.
  const again = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: reviewersFor(people, ['reviewer']) });
  assert.equal(again.status, 409);
  assert.equal(again.body.details.code, 'package_not_draft');

  const managed = await harness.as('projectManager').post('/rounds', {
    closePrevious: { outcome: 'changes-requested', statement: 'Round 1 asked for a calmer price card.' },
    packageId: second.id,
    reviewers: reviewersFor(people, ['reviewer']),
  });
  assert.equal(managed.status, 201, JSON.stringify(managed.body));
  assert.equal(managed.body.round.number, 2);
  assert.equal(managed.body.round.packageVersion, 2);
  const previous = (await harness.as('viewer').get(`/rounds/${first.round.id}`)).body.round;
  assert.equal(previous.status, 'closed');
  assert.equal(previous.outcome, 'changes-requested');
  assert.equal(previous.decision.statement, 'Round 1 asked for a calmer price card.');

  // Question topics are reused by question id across rounds of the track.
  for (const questionId of ['before-tax', 'notice', 'speed']) {
    assert.equal(managed.body.round.questionTopics[questionId], first.round.questionTopics[questionId]);
  }
  assert.deepEqual(managed.body.createdTopicIds, []);

  // Rounds list, newest first per track, filtered by track.
  const list = await harness.as('viewer').get('/rounds?track=experience');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.rounds.map((round) => [round.number, round.status, round.packageVersion]), [[2, 'open', 2], [1, 'closed', 1]]);
  assert.deepEqual((await harness.as('viewer').get('/rounds?track=architecture')).body.rounds, []);
  assert.equal((await harness.as('viewer').get('/rounds?track=backend')).status, 400);
});

test('review is project-wide: a question may settle an architecture topic, and an open round on either track blocks a publish', async () => {
  const harness = await createRoundsTestApp();
  const architectureTopic = await harness.createTopic('Which queue carries reminders?', { track: 'architecture' });
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: architectureTopic.id }));
  const stakeholder = await harness.seedStakeholder({ email: 'client@client.example', name: 'Client' });
  const reviewers = [{ actorId: stakeholder.id, actorType: 'stakeholder', required: true }];

  // An open round stored on the architecture track (before review became project-wide) blocks this one.
  const legacy = await harness.roundsRepository.createRound({
    projectId: PROJECT_ID,
    reviewers: [],
    round: { packageId: 'legacy-architecture-package', publishedAt: new Date(), questionTopics: {}, track: 'architecture' },
    tenantId: TENANT_ID,
  });
  const blocked = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers });
  assert.equal(blocked.status, 409);
  assert.deepEqual([blocked.body.details.code, blocked.body.details.openRoundId], ['round_open', legacy.id]);
  assert.match(blocked.body.error ?? blocked.body.message ?? '', /open for this project/);
  harness.roundsRepository.state.rounds.find((round) => round.id === legacy.id).status = 'closed';

  const published = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.round.questionTopics['price-placement'], architectureTopic.id, 'the question posts to the architecture topic');
  assert.equal(published.body.round.number, 2, 'rounds are numbered across the project');
  const all = await harness.as('viewer').get('/rounds');
  assert.deepEqual(all.body.rounds.map((round) => round.id).sort(), [legacy.id, published.body.round.id].sort());
});

test('publish validation: reviewers must be collaborators or project stakeholders; question topics must resolve; due dates are in the future', async () => {
  const harness = await createRoundsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const doomedTopic = await harness.createTopic('Doomed topic');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: doomedTopic.id }));
  const valid = [{ actorId: stakeholder.id, actorType: 'stakeholder', required: true }];

  const viewerReviewer = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: [{ actorId: ROLE_USERS.viewer.id, actorType: 'user' }] });
  assert.equal(viewerReviewer.status, 400);
  assert.equal(viewerReviewer.body.details.code, 'reviewer_invalid');
  const outsider = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: [{ actorId: ROLE_USERS.outsider.id, actorType: 'user' }] });
  assert.equal(outsider.status, 400);
  const strangerStakeholder = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: [{ actorId: 'nobody', actorType: 'stakeholder' }] });
  assert.equal(strangerStakeholder.status, 400);
  const duplicate = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: [...valid, ...valid] });
  assert.equal(duplicate.status, 400);
  const none = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: [] });
  assert.equal(none.status, 400);
  const past = await harness.as('member').post('/rounds', { dueAt: new Date(Date.now() - DAY_MS).toISOString(), packageId: pkg.id, reviewers: valid });
  assert.equal(past.status, 400);
  const reminderWithoutDue = await harness.as('member').post('/rounds', { packageId: pkg.id, reminder: { daysBefore: 2 }, reviewers: valid });
  assert.equal(reminderWithoutDue.status, 400);
  const unknownPackage = await harness.as('member').post('/rounds', { packageId: 'missing', reviewers: valid });
  assert.equal(unknownPackage.status, 404);

  // The linked topic disappears after upload: publishing reports the unresolved question.
  await harness.requirementsRepository.deleteTopic({ projectId: PROJECT_ID, tenantId: TENANT_ID, topicId: doomedTopic.id });
  const unresolved = await harness.as('member').post('/rounds', { packageId: pkg.id, reviewers: valid });
  assert.equal(unresolved.status, 409);
  assert.equal(unresolved.body.details.code, 'question_topic_missing');
  assert.deepEqual(unresolved.body.details.questionIds, ['price-placement']);
  assert.equal((await harness.packagesRepository.getPackage({ packageId: pkg.id, projectId: PROJECT_ID, tenantId: TENANT_ID })).status, 'draft');
  assert.equal(harness.mail.state.queue.length, 0);

  // Tenant admins review without a project membership.
  const ok = await harness.as('member').post('/rounds', { packageId: (await harness.uploadPackage(roundPackageFiles())).id, reviewers: [{ actorId: ROLE_USERS.tenantAdmin.id, actorType: 'user' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('AC-11 AC-15 permissions: viewers read rounds but get 404 on writes; only decision rights close; stakeholders see only invited rounds', async () => {
  const { harness, people, pkg } = await setup({ stakeholders: 2 });
  const { round } = await harness.publish({ packageId: pkg.id, reviewers: reviewersFor([people[0]], ['reviewer']) });
  const [invited, uninvited] = people;

  assert.equal((await harness.as('viewer').get('/rounds')).status, 200);
  assert.equal((await harness.as('viewer').get(`/rounds/${round.id}`)).status, 200);
  assert.equal((await harness.as('viewer').get(`/rounds/${round.id}/results`)).status, 200);
  assert.equal((await harness.as('viewer').get(`/rounds/${round.id}/feedback`)).status, 200);
  for (const [method, path, body] of [
    ['post', '/rounds', { packageId: pkg.id, reviewers: [] }],
    ['patch', `/rounds/${round.id}`, { note: 'x' }],
    ['post', `/rounds/${round.id}/close`, { outcome: 'abandoned' }],
    ['post', `/rounds/${round.id}/reviewers/${round.reviewers[0].id}/resend`, {}],
    ['get', `/rounds/${round.id}/review`],
    ['put', `/rounds/${round.id}/review/screens/home/verdict`, { overall: 'keep' }],
    ['post', `/rounds/${round.id}/review/submit`, {}],
  ]) {
    const response = await harness.as('viewer')[method](path, body);
    assert.equal(response.status, 404, `viewer ${method} ${path}`);
  }
  assert.equal((await harness.as('outsider').get('/rounds')).status, 404);

  // Members cannot close; managers can, and the decision stores outcome, sources, and decider.
  assert.equal((await harness.as('member').post(`/rounds/${round.id}/close`, { outcome: 'abandoned' })).status, 404);
  const badDirection = await harness.as('projectManager').post(`/rounds/${round.id}/close`, { directionId: 'nope', outcome: 'direction-chosen' });
  assert.equal(badDirection.status, 400);
  const closed = await harness.as('projectManager').post(`/rounds/${round.id}/close`, { directionId: 'action-first', outcome: 'direction-chosen' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.round.status, 'closed');
  assert.equal(closed.body.round.outcome, 'direction-chosen');
  assert.equal(closed.body.round.outcomeDirectionId, 'action-first');
  assert.equal(closed.body.decision.statement, 'Round 1: Direction chosen: Action first.');
  const decisions = await harness.as('viewer').get('/tracks/experience/decisions?kind=round');
  assert.equal(decisions.body.decisions.length, 1);
  assert.deepEqual(
    { by: decisions.body.decisions[0].decidedBy.ref, kind: decisions.body.decisions[0].kind, roundId: decisions.body.decisions[0].roundId, sources: decisions.body.decisions[0].sources },
    { by: 'user:user-pmanager', kind: 'round', roundId: round.id, sources: [`round:${round.id}`, 'direction:action-first'] },
  );
  assert.equal((await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'abandoned' })).status, 409);

  // Stakeholders: only rounds they are invited to.
  const invitedLink = harness.portalLinksInMail().find((link) => link.recipient === invited.email);
  const other = await harness.as('projectManager').post('/links', { stakeholderId: uninvited.id });
  assert.equal((await harness.portal(invitedLink.token, round.id).get()).status, 200);
  assert.equal((await harness.portal(other.body.token, round.id).get()).status, 404);
  assert.deepEqual((await harness.portal(other.body.token).get('/rounds')).body.rounds, []);
  assert.equal((await harness.portal('not-a-token', round.id).get()).status, 404);
});

test('PATCH changes the due date, note, reminder, and reviewers; removed stakeholders lose the round; resend issues a fresh token', async () => {
  const { harness, people, pkg } = await setup({ stakeholders: 2 });
  const { round } = await harness.publish({ packageId: pkg.id, reviewers: reviewersFor([people[0]], ['reviewer']) });
  const firstLink = harness.portalLinksInMail()[0];
  const stakeholderReviewer = round.reviewers.find((reviewer) => reviewer.actorType === 'stakeholder');
  const memberReviewer = round.reviewers.find((reviewer) => reviewer.actorType === 'user');
  const portalEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.publicRequirements(harness.requirementsRepository.state.links[0].id));

  const dueAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
  const patched = await harness.as('member').patch(`/rounds/${round.id}`, {
    addReviewers: [{ actorId: people[1].id, actorType: 'stakeholder', required: false }],
    dueAt,
    note: 'Updated note',
    reminder: { daysBefore: 2 },
    updateReviewers: [{ id: memberReviewer.id, required: true }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.round.dueAt, dueAt);
  assert.equal(patched.body.round.note, 'Updated note');
  assert.deepEqual(patched.body.round.reminder, { daysBefore: 2 });
  assert.equal(patched.body.round.reviewers.find((reviewer) => reviewer.id === memberReviewer.id).required, true);
  const added = patched.body.round.reviewers.find((reviewer) => reviewer.actorId === people[1].id);
  assert.equal(added.mail.status, 'queued');
  assert.equal(harness.portalLinksInMail().filter((link) => link.recipient === people[1].email).length, 1, 'the added stakeholder is invited');
  assert.ok(portalEvents.events.some((event) => event.type === 'requirements.rounds.invalidated' && event.reason === 'round-updated'));

  // Unknown reviewer ids are rejected.
  assert.equal((await harness.as('member').patch(`/rounds/${round.id}`, { removeReviewerIds: ['nope'] })).status, 400);

  // Resend: a fresh token in a new email; the first link keeps working.
  const resent = await harness.as('member').post(`/rounds/${round.id}/reviewers/${stakeholderReviewer.id}/resend`);
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  assert.equal(resent.body.reviewer.mail.status, 'queued');
  const tokens = harness.portalLinksInMail().filter((link) => link.recipient === people[0].email).map((link) => link.token);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal((await harness.portal(tokens[1], round.id).get()).status, 200);
  assert.equal((await harness.portal(firstLink.token, round.id).get()).status, 200);

  // Removing the stakeholder takes the round away from their portal and tells it so.
  const before = portalEvents.events.length;
  const removed = await harness.as('member').patch(`/rounds/${round.id}`, { removeReviewerIds: [stakeholderReviewer.id] });
  assert.equal(removed.status, 200);
  assert.ok(removed.body.round.reviewers.find((reviewer) => reviewer.id === stakeholderReviewer.id).removedAt);
  assert.equal(removed.body.round.counts.reviewers, 2);
  assert.ok(portalEvents.events.slice(before).some((event) => event.reason === 'round-updated'));
  assert.equal((await harness.portal(tokens[1], round.id).get()).status, 404);
  assert.equal((await harness.as('member').post(`/rounds/${round.id}/reviewers/${stakeholderReviewer.id}/resend`)).status, 404);

  // Re-adding reactivates the same reviewer row.
  const readded = await harness.as('member').patch(`/rounds/${round.id}`, { addReviewers: [{ actorId: people[0].id, actorType: 'stakeholder', required: true }] });
  assert.equal(readded.body.round.reviewers.find((reviewer) => reviewer.id === stakeholderReviewer.id).removedAt, null);

  // Closed rounds cannot change.
  await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'abandoned' });
  const late = await harness.as('member').patch(`/rounds/${round.id}`, { note: 'late' });
  assert.equal(late.status, 409);
  assert.equal(late.body.details.code, 'round_closed');
});

test('AC-06 delivery status: a failed send shows on the reviewer, a queue error is recorded, and Resend queues again', async () => {
  const harness = await createRoundsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const noEmail = await harness.seedStakeholder({ email: '', name: 'No Email' });
  const pkg = await harness.uploadPackage(roundPackageFiles());
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [
      { actorId: stakeholder.id, actorType: 'stakeholder' },
      { actorId: noEmail.id, actorType: 'stakeholder' },
      { actorId: ROLE_USERS.reviewer.id, actorType: 'user' },
    ],
  });
  const byActor = (detail, id) => detail.reviewers.find((reviewer) => reviewer.actorId === id);
  assert.deepEqual(byActor(round, noEmail.id).mail, { queuedAt: null, reason: 'no-email', status: 'not-sent' });

  // The mail worker marks the stakeholder's email failed (hard bounce).
  const row = harness.mail.state.queue.find((item) => item.recipientEmail === 'jamie@client.example');
  await harness.mail.markFailed({ id: row.id });
  let detail = (await harness.as('member').get(`/rounds/${round.id}`)).body.round;
  assert.equal(byActor(detail, stakeholder.id).mail.status, 'failed');
  assert.equal(byActor(detail, stakeholder.id).mail.reason, 'delivery-failed');
  await harness.mail.markSent({ id: harness.mail.state.queue.find((item) => item.recipientEmail === 'user-reviewer@acme.com').id });
  detail = (await harness.as('member').get(`/rounds/${round.id}`)).body.round;
  assert.equal(byActor(detail, ROLE_USERS.reviewer.id).mail.status, 'sent');

  // Resend queues a new email with a new target; the status follows the newest email.
  const resent = await harness.as('member').post(`/rounds/${round.id}/reviewers/${byActor(detail, stakeholder.id).id}/resend`);
  assert.equal(resent.body.reviewer.mail.status, 'queued');
  assert.equal(harness.mail.state.queue.filter((item) => item.recipientEmail === 'jamie@client.example').length, 2);

  // A queue that throws records a failed status instead of failing the request.
  const originalQueue = harness.mail.queueMail;
  harness.mail.queueMail = async () => { throw new Error('mail database down'); };
  const failing = await harness.as('member').post(`/rounds/${round.id}/reviewers/${byActor(detail, stakeholder.id).id}/resend`);
  harness.mail.queueMail = originalQueue;
  assert.equal(failing.status, 200);
  assert.deepEqual(failing.body.reviewer.mail, { queuedAt: null, reason: 'queue-error', status: 'failed' });

  // A revoked link is not silently reactivated by an invitation.
  const linkId = harness.requirementsRepository.state.links.find((link) => link.stakeholderId === stakeholder.id).id;
  await harness.as('projectManager').post(`/links/${linkId}/revoke`);
  const revoked = await harness.as('member').post(`/rounds/${round.id}/reviewers/${byActor(detail, stakeholder.id).id}/resend`);
  assert.deepEqual(revoked.body.reviewer.mail, { queuedAt: null, reason: 'link-revoked', status: 'not-sent' });
});

test('AC-06 link lifetime counts the open round, ends 14 days after close, and stops at revocation', async () => {
  const harness = await createRoundsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const pkg = await harness.uploadPackage(roundPackageFiles());
  const { round } = await harness.publish({ packageId: pkg.id, reviewers: [{ actorId: stakeholder.id, actorType: 'stakeholder' }] });
  const [link] = harness.portalLinksInMail();

  harness.clock.offsetMs = 60 * DAY_MS;
  assert.equal((await harness.portal(link.token, round.id).get()).status, 200, 'valid while the round is open, however long');

  harness.clock.offsetMs = 61 * DAY_MS;
  assert.equal((await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'screens-accepted' })).status, 200);
  harness.clock.offsetMs = 74 * DAY_MS;
  const closedView = await harness.portal(link.token, round.id).get();
  assert.equal(closedView.status, 200);
  assert.equal(closedView.body.round.readOnly, true);
  harness.clock.offsetMs = 76 * DAY_MS;
  const expired = await harness.portal(link.token, round.id).get();
  assert.equal(expired.status, 410);
  assert.equal(expired.body.details.code, 'link_expired');

  // Revocation stops a link at once.
  harness.clock.offsetMs = 0;
  const second = await harness.uploadPackage(roundPackageFiles({ css: 'body{}' }));
  const next = await harness.publish({ packageId: second.id, reviewers: [{ actorId: stakeholder.id, actorType: 'stakeholder' }] });
  const fresh = harness.portalLinksInMail().find((entry) => entry.roundId === next.round.id);
  assert.equal((await harness.portal(fresh.token, next.round.id).get()).status, 200);
  await harness.as('projectManager').post(`/links/${harness.requirementsRepository.state.links[0].id}/revoke`);
  assert.equal((await harness.portal(fresh.token, next.round.id).get()).status, 410);
});

test('reminders: due reviewers who have not submitted get one reminder per round, with a fresh portal token', async () => {
  const { harness, people, pkg } = await setup({ stakeholders: 1 });
  const dueAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
  const { round } = await harness.publish({ dueAt, packageId: pkg.id, reminder: { daysBefore: 1 }, reviewers: reviewersFor(people, ['member', 'reviewer']) });
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

  assert.deepEqual(await processRoundReminders(deps, { now: new Date(Date.now() + DAY_MS) }), { due: 0, failed: 0, notSent: 0, queued: 0, skipped: 0 });

  // Ravi submits; the reminder window opens a day before the due date.
  const ravi = await harness.team('reviewer', round.id);
  assert.deepEqual((await harness.as('reviewer').get('/my-items')).body.groups.review.map((item) => item.id), [round.id]);
  assert.equal((await ravi.post('/submit', {})).status, 200);
  assert.deepEqual((await harness.as('reviewer').get('/my-items')).body.groups.review, [], 'submitted reviews leave "Needs your review"');
  const inWindow = new Date(Date.parse(dueAt) - 12 * 60 * 60 * 1000);
  assert.deepEqual(await processRoundReminders(deps, { now: inWindow }), { due: 2, failed: 0, notSent: 0, queued: 2, skipped: 0 });
  assert.deepEqual(reminders().map((row) => row.recipientEmail).sort(), ['client1@client.example', 'user-member@acme.com']);
  const stakeholderReviewer = round.reviewers.find((reviewer) => reviewer.actorType === 'stakeholder');
  assert.ok(reminders().some((row) => row.targetId === reminderTargetId(stakeholderReviewer.id)));
  assert.match(reminders()[0].subject, /Reminder: round 1 review/);
  const reminderTokens = harness.requirementsRepository.state.tokens.filter((token) => token.purpose === 'reminder');
  assert.equal(reminderTokens.length, 1);
  const reminderLink = harness.portalLinksInMail().at(-1);
  assert.equal((await harness.portal(reminderLink.token, round.id).get()).status, 200);

  // Idempotent: running again sends nothing.
  assert.deepEqual(await processRoundReminders(deps, { now: inWindow }), { due: 0, failed: 0, notSent: 0, queued: 0, skipped: 0 });
  assert.equal(reminders().length, 2);
  const detail = (await harness.as('member').get(`/rounds/${round.id}`)).body.round;
  assert.ok(detail.reviewers.find((reviewer) => reviewer.id === stakeholderReviewer.id).remindedAt);

  // After the due date, or on a closed round, nothing is sent.
  assert.deepEqual(await processRoundReminders(deps, { now: new Date(Date.parse(dueAt) + 1000) }), { due: 0, failed: 0, notSent: 0, queued: 0, skipped: 0 });
});

test('portal round routes use their own rate-limit buckets, separate from topic routes', async () => {
  const tight = () => createRequirementsPublicRateLimiter({ ip: { capacity: 2, refillPerSecond: 0.001 }, link: { capacity: 2, refillPerSecond: 0.001 } });
  const harness = await createRoundsTestApp({ rateLimiter: tight(), reviewRateLimiter: tight() });
  const stakeholder = await harness.seedStakeholder();
  const pkg = await harness.uploadPackage(roundPackageFiles());
  const { round } = await harness.publish({ packageId: pkg.id, reviewers: [{ actorId: stakeholder.id, actorType: 'stakeholder' }] });
  const [{ token }] = harness.portalLinksInMail();

  assert.equal((await harness.portal(token).get()).status, 200);
  assert.equal((await harness.portal(token).get()).status, 200);
  assert.equal((await harness.portal(token).get()).status, 429, 'topic routes spent their bucket');
  assert.equal((await harness.portal(token, round.id).get()).status, 200, 'round routes have their own');
  assert.equal((await harness.portal(token, round.id).get()).status, 200);
  const limited = await harness.portal(token, round.id).get();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.details.code, 'rate_limited');
});
