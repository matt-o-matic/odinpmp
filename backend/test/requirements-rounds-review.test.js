import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { verifyPackageGrant } from '../src/modules/requirements/packages/package-grants.js';
import { screenScopeId } from '../src/modules/requirements/rounds/round-summaries.js';
import { makePng } from './helpers/review-packages.js';
import { createRoundsTestApp, GRANT_SECRET, PROJECT_ID, REVIEW_PUBLIC_URL, roundPackageFiles, ROLE_USERS, TENANT_ID } from './helpers/requirements-rounds-app.js';

const style = { color: '#C2410C', stroke: 4 };
const pin = (x, y, extra = {}) => ({ number: 7, schemaVersion: 1, style, type: 'pin', x, y, ...extra });
const box = (x, y, w, h, extra = {}) => ({ h, schemaVersion: 1, style, type: 'box', w, x, y, ...extra });

async function openRound() {
  const harness = await createRoundsTestApp();
  const priceTopic = await harness.createTopic('Where should the price first appear?');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: priceTopic.id }));
  const jamie = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const outside = await harness.seedStakeholder({ email: 'sam@client.example', name: 'Sam Outside' });
  const published = await harness.publish({
    packageId: pkg.id,
    reviewers: [
      { actorId: ROLE_USERS.reviewer.id, actorType: 'user', required: true },
      { actorId: jamie.id, actorType: 'stakeholder', required: true },
      { actorId: casey.id, actorType: 'stakeholder' },
    ],
  });
  const links = harness.portalLinksInMail();
  const tokenFor = (stakeholder) => links.find((link) => link.recipient === stakeholder.email).token;
  const outsideLink = await harness.as('projectManager').post('/links', { stakeholderId: outside.id });
  return {
    casey,
    caseyToken: tokenFor(casey),
    harness,
    jamie,
    jamieToken: tokenFor(jamie),
    outsideToken: outsideLink.body.token,
    pkg,
    priceTopic,
    round: published.round,
  };
}

test('review state: package, screens with grant entry URLs, empty progress, and resume position', async () => {
  const { harness, jamieToken, pkg, round } = await openRound();
  const state = await harness.portal(jamieToken, round.id).get();
  assert.equal(state.status, 200, JSON.stringify(state.body));
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.body.round.id, round.id);
  assert.equal(state.body.round.readOnly, false);
  assert.deepEqual(state.body.round.publishedBy, { name: ROLE_USERS.member.name }, 'the review state names who asked, by name only');
  assert.equal(state.body.package.id, pkg.id);
  assert.equal(state.body.package.manifest.generator, undefined);
  assert.deepEqual(state.body.package.feedbackDimensions.map((dimension) => dimension.key), ['type', 'density', 'hierarchy', 'tone-of-voice']);
  assert.deepEqual(state.body.screens.map((screen) => [screen.screenId, screen.kind, screen.change]), [['home', 'image', null], ['booking', 'prototype', null], ['gone', 'image', null]]);
  for (const screen of state.body.screens) assert.ok(screen.entryUrl.startsWith(`${REVIEW_PUBLIC_URL}/p/${pkg.id}/`));
  for (const screen of state.body.screens) {
    const verified = verifyPackageGrant({ grant: screen.entryUrl.split('/')[5], packageId: pkg.id, secret: GRANT_SECRET });
    assert.match(verified.viewerRef, /^stakeholder:/, 'grants name the stakeholder as viewer');
    assert.equal(verified.screenId, screen.screenId, 'and the screen they load');
  }
  assert.deepEqual(Object.keys(state.body.grant), ['expiresAt']);
  assert.deepEqual(state.body.progress, { directions: { done: 0, total: 2 }, done: 0, questions: { done: 0, total: 4 }, screens: { done: 0, total: 3 }, total: 9 });
  assert.deepEqual([state.body.verdicts, state.body.directions, state.body.answers, state.body.previousAnswers, state.body.annotations], [{}, {}, {}, {}, []]);
  assert.equal(state.body.me.isReviewer, true);
  assert.equal(state.body.me.required, true);
  assert.equal(state.body.me.canSubmit, true);
  assert.match(state.body.me.actorRef, /^person:[0-9a-f]{20}$/, 'the portal never shows stakeholder ids');
  assert.equal(JSON.stringify(state.body).includes(harness.requirementsRepository.state.links[0].stakeholderId), false);
  assert.deepEqual(state.body.questions.map((question) => [question.id, question.kind, Boolean(question.topicId)]), [
    ['price-placement', 'single', true], ['before-tax', 'multi', true], ['notice', 'text', true], ['speed', 'scale', true],
  ]);

  const position = await harness.portal(jamieToken, round.id).put('/position', { screenId: 'booking', stateKey: 'done', step: 'screens' });
  assert.equal(position.status, 200);
  const resumed = await harness.portal(jamieToken, round.id).get();
  assert.deepEqual(resumed.body.me.position, { screenId: 'booking', stateKey: 'done', step: 'screens' });
  assert.ok((await harness.as('member').get(`/rounds/${round.id}`)).body.round.reviewers.find((reviewer) => reviewer.actorType === 'stakeholder' && reviewer.required).lastSeenAt);

  // Without a review origin the state still loads; screens have no entry URL.
  const bare = await createRoundsTestApp({ reviewPublicUrl: '' });
  const bareStakeholder = await bare.seedStakeholder();
  const barePackage = await bare.uploadPackage(roundPackageFiles());
  const bareRound = await bare.publish({ packageId: barePackage.id, reviewers: [{ actorId: bareStakeholder.id, actorType: 'stakeholder' }] });
  const bareState = await bare.portal(bare.portalLinksInMail()[0].token, bareRound.round.id).get();
  assert.equal(bareState.status, 200);
  assert.equal(bareState.body.grant, null);
  assert.ok(bareState.body.screens.every((screen) => screen.entryUrl === null));
});

test('directions and verdicts: stances, dimension validation, untouched stays absent, clearing, and progress', async () => {
  const { harness, jamieToken, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);

  const stance = await jamie.put('/directions/action-first', { remix: 'Keep the price card.', stance: 'preferred' });
  assert.equal(stance.status, 200, JSON.stringify(stance.body));
  assert.deepEqual({ remix: stance.body.direction.remix, stance: stance.body.direction.stance }, { remix: 'Keep the price card.', stance: 'preferred' });
  assert.equal(stance.body.progress.directions.done, 1);
  assert.equal((await jamie.put('/directions/action-first', { stance: 'loved' })).status, 400);
  assert.equal((await jamie.put('/directions/nope', { stance: 'rejected' })).status, 404);

  const verdict = await jamie.put('/screens/home/verdict', {
    change: 'Make the price smaller.',
    dimensions: { hierarchy: 'keep', 'tone-of-voice': 'change', type: 'undecided' },
    overall: 'keep-with-changes',
    stay: 'The single booking button.',
  });
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
  assert.deepEqual(verdict.body.verdict.dimensions, { hierarchy: 'keep', 'tone-of-voice': 'change', type: 'undecided' });
  assert.equal(verdict.body.verdict.overall, 'keep-with-changes');
  assert.equal(verdict.body.verdict.mixed, undefined, 'notes nobody wrote are absent');

  const badDimension = await jamie.put('/screens/home/verdict', { dimensions: { color: 'keep' }, overall: 'keep' });
  assert.equal(badDimension.status, 400);
  assert.equal(badDimension.body.details.code, 'dimension_invalid');
  assert.deepEqual(badDimension.body.details.dimensions, ['color']);
  assert.equal((await jamie.put('/screens/home/verdict', { dimensions: { type: 'keep-with-changes' }, overall: 'keep' })).status, 400);
  assert.equal((await jamie.put('/screens/home/verdict', { overall: 'love-it' })).status, 400);
  assert.equal((await jamie.put('/screens/home/verdict', {})).status, 400);
  assert.equal((await jamie.put('/screens/nope/verdict', { overall: 'keep' })).status, 404);

  // Replacing drops dimensions no longer rated; Undecided counts as reviewed.
  const replaced = await jamie.put('/screens/home/verdict', { dimensions: { type: 'keep' }, overall: 'change' });
  assert.deepEqual(replaced.body.verdict.dimensions, { type: 'keep' });
  assert.equal((await jamie.put('/screens/gone/verdict', { overall: 'undecided' })).body.progress.screens.done, 2);

  const state = await jamie.get();
  assert.deepEqual(Object.keys(state.body.verdicts).sort(), ['gone', 'home'], 'booking stays not reviewed');
  assert.equal(state.body.verdicts.home.overall, 'change');

  const cleared = await jamie.del('/screens/gone/verdict');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.verdict, null);
  assert.equal(cleared.body.progress.screens.done, 1);
  assert.equal((await jamie.del('/directions/action-first')).body.progress.directions.done, 0);
});

test('answers post into the linked topic thread as the reviewer, edits update the same comment, and a summary refresh is scheduled', async () => {
  const { harness, jamieToken, priceTopic, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);
  const topicEvents = harness.recordEvents(harness.projectChannel);

  const answer = await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.answer.text, 'A range on the home screen');
  assert.equal(answer.body.answer.topicId, priceTopic.id);
  const commentId = answer.body.answer.postedCommentId;
  assert.ok(commentId);
  assert.ok(harness.summaries.isPending({ projectId: PROJECT_ID, scopeId: priceTopic.id, scopeType: 'topic', tenantId: TENANT_ID }), 'the topic summary refresh is scheduled');
  assert.ok(harness.summaries.isPending({ projectId: PROJECT_ID, scopeId: round.id, scopeType: 'round', tenantId: TENANT_ID }));
  assert.ok(topicEvents.events.some((event) => event.type === 'requirements.topics.invalidated' && event.reason === 'round-answer-posted' && event.topicIds.includes(priceTopic.id)));

  let topic = (await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic;
  assert.equal(topic.comments.length, 1);
  assert.deepEqual(
    { actorType: topic.comments[0].actorType, authorName: topic.comments[0].authorName, id: topic.comments[0].id, source: topic.comments[0].source },
    { actorType: 'stakeholder', authorName: 'Jamie Ortiz', id: commentId, source: 'round-answer' },
  );
  assert.equal(topic.comments[0].body, 'A range on the home screen\n\nAnswered in review round 1: "Where should the price first appear?"');
  assert.equal(topic.status, 'open', 'answers never change a topic\'s status');
  assert.equal(topic.evidence.roundAnswers, 1);

  const edited = await jamie.put('/questions/price-placement/answer', { value: 'after-time' });
  assert.equal(edited.body.answer.postedCommentId, commentId, 'the same comment is edited');
  topic = (await harness.as('member').get(`/topics/${priceTopic.id}`)).body.topic;
  assert.equal(topic.comments.length, 1);
  assert.match(topic.comments[0].body, /^Only after a time is picked/);
  assert.ok(topic.comments[0].editedAt);

  // Validation by kind.
  assert.equal((await jamie.put('/questions/price-placement/answer', { value: 'nope' })).status, 400);
  assert.equal((await jamie.put('/questions/before-tax/answer', { value: [] })).status, 400);
  assert.equal((await jamie.put('/questions/before-tax/answer', { value: ['web', 'web'] })).status, 400);
  assert.equal((await jamie.put('/questions/speed/answer', { value: 6 })).status, 400);
  assert.equal((await jamie.put('/questions/speed/answer', { value: 2.5 })).status, 400);
  assert.equal((await jamie.put('/questions/notice/answer', { value: '   ' })).status, 400);
  assert.equal((await jamie.put('/questions/unknown/answer', { value: 'x' })).status, 404);
  const multi = await jamie.put('/questions/before-tax/answer', { value: ['sms', 'web'] });
  assert.deepEqual(multi.body.answer.value, ['web', 'sms'], 'multi answers keep option order');
  assert.equal(multi.body.answer.text, 'On the web, In texts');
  const scale = await jamie.put('/questions/speed/answer', { value: 4 });
  assert.equal(scale.body.answer.text, '4 on a 1-5 scale (1 = Slow, 5 = Very quick)');
  assert.equal(scale.body.progress.questions.done, 3);

  // Unanswered questions stay absent; clearing removes the posted comment.
  const state = await jamie.get();
  assert.deepEqual(Object.keys(state.body.answers).sort(), ['before-tax', 'price-placement', 'speed']);
  const speedTopic = round.questionTopics.speed;
  assert.equal((await harness.as('member').get(`/topics/${speedTopic}`)).body.topic.comments.length, 1);
  const cleared = await jamie.del('/questions/speed/answer');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.progress.questions.done, 2);
  assert.equal((await harness.as('member').get(`/topics/${speedTopic}`)).body.topic.comments.length, 0);

  // A team reviewer's answer posts as that user.
  const ravi = harness.team('reviewer', round.id);
  const raviAnswer = await ravi.put('/questions/notice/answer', { value: 'Two days, except emergencies.' });
  assert.equal(raviAnswer.status, 200);
  const noticeTopic = (await harness.as('member').get(`/topics/${round.questionTopics.notice}`)).body.topic;
  assert.deepEqual([noticeTopic.comments[0].actorType, noticeTopic.comments[0].actorId, noticeTopic.comments[0].authorName], ['user', ROLE_USERS.reviewer.id, 'Ravi Reviewer']);
});

test('members review vs submit: any collaborator annotates and comments; only invited reviewers give verdicts, answers, and submit', async () => {
  const { harness, round } = await openRound();
  const mona = harness.team('member', round.id);
  const state = await mona.get();
  assert.equal(state.status, 200);
  assert.equal(state.body.me.isReviewer, false);
  assert.equal(state.body.me.canSubmit, false);
  for (const [method, path, body] of [
    ['put', '/screens/home/verdict', { overall: 'keep' }],
    ['put', '/directions/action-first', { stance: 'preferred' }],
    ['put', '/questions/notice/answer', { value: 'x' }],
    ['put', '/position', { step: 'overview' }],
    ['post', '/submit', {}],
  ]) {
    const response = await mona[method](path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.body.details.code, 'not_a_reviewer');
  }
  const annotationId = randomUUID();
  const created = await mona.put(`/annotations/${annotationId}`, { screenId: 'home', shapes: [pin(10, 10)] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await mona.post(`/annotations/${annotationId}/comments`, { body: 'Members can discuss.' })).status, 201);
});

test('annotations: client ids, server display numbers per screen, own-only edits, soft delete and restore, moderator delete', async () => {
  const { casey, caseyToken, harness, jamieToken, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);
  const casey2 = harness.portal(caseyToken, round.id);
  const ravi = harness.team('reviewer', round.id);
  const first = randomUUID();
  const second = randomUUID();
  const third = randomUUID();

  const a = await jamie.put(`/annotations/${first}`, {
    category: 'hierarchy',
    elementHint: { box: { height: 20, width: 80, x: 10, y: 10 }, odinId: 'book-button', tag: 'button', text: 'Book now' },
    screenId: 'home',
    shapes: [pin(100.04, 50), box(20, 20, 60, 40)],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.created, true);
  assert.equal(a.body.annotation.id, first);
  assert.equal(a.body.annotation.number, 1);
  assert.equal(a.body.annotation.shapes[0].number, 1, 'pins show the server number, whatever the client sent');
  assert.equal(a.body.annotation.shapes[0].x, 100);
  assert.equal(a.body.annotation.shapes[0].style.color, '#c2410c');
  assert.equal(a.body.annotation.status, 'open');
  assert.equal(a.body.annotation.authorName, 'Jamie Ortiz');
  assert.equal(a.body.annotation.isMine, true);
  assert.deepEqual(a.body.annotation.actions, { carry: false, changeStatus: true, close: false, comment: true, delete: true, edit: true });

  const b = await casey2.put(`/annotations/${second}`, { screenId: 'home', shapes: [box(100, 100, 50, 50)] });
  assert.equal(b.body.annotation.number, 2);
  const c = await ravi.put(`/annotations/${third}`, { screenId: 'gone', shapes: [pin(5, 5)] });
  assert.equal(c.body.annotation.number, 1, 'numbers are per screen');

  // Updates keep the number; nudges are cheap upserts.
  for (let x = 21; x <= 25; x += 1) {
    const nudged = await jamie.put(`/annotations/${first}`, { screenId: 'home', shapes: [pin(100, 50), box(x, 20, 60, 40)] });
    assert.equal(nudged.status, 200);
    assert.equal(nudged.body.created, false);
    assert.equal(nudged.body.annotation.number, 1);
  }
  assert.equal(harness.summaryAi.calls.length, 0, 'no summary model call per save');

  // Others' annotations are visible as layers but not editable or deletable by a stakeholder.
  const caseyView = await casey2.get();
  const jamieMark = caseyView.body.annotations.find((item) => item.id === first);
  assert.equal(jamieMark.isMine, false);
  assert.equal(jamieMark.authorName, 'Jamie Ortiz');
  assert.match(jamieMark.authorRef, /^person:/);
  assert.equal(jamieMark.actions.edit, false);
  assert.equal(jamieMark.shapes[1].x, 25);
  assert.equal((await casey2.put(`/annotations/${first}`, { screenId: 'home', shapes: [pin(1, 1)] })).status, 404);
  const caseyDelete = await casey2.del(`/annotations/${first}`);
  assert.equal(caseyDelete.status, 403);
  assert.equal((await casey2.post(`/annotations/${first}/status`, { status: 'resolved' })).status, 403);

  // Team view shows real actor refs.
  const teamView = await harness.team('member', round.id).get();
  assert.equal(teamView.body.annotations.find((item) => item.id === second).authorRef, `stakeholder:${casey.id}`);

  // Delete is soft: the number stays taken, a plain PUT is refused, restored brings back the same id and number.
  assert.equal((await jamie.del(`/annotations/${first}`)).status, 200);
  assert.equal((await jamie.get()).body.annotations.some((item) => item.id === first), false);
  const fourth = await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'home', shapes: [pin(30, 30)] });
  assert.equal(fourth.body.annotation.number, 3);
  const stale = await jamie.put(`/annotations/${first}`, { screenId: 'home', shapes: [pin(40, 40)] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'annotation_deleted');
  const restored = await jamie.put(`/annotations/${first}`, { restored: true, screenId: 'home', shapes: [pin(40, 40)] });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.annotation.id, first);
  assert.equal(restored.body.annotation.number, 1);
  assert.equal(restored.body.annotation.shapes[0].number, 1);

  // A new id with restored: true simply creates; ids must be UUIDs; screens cannot change.
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { restored: true, screenId: 'gone', shapes: [pin(1, 1)] })).status, 201);
  assert.equal((await jamie.put('/annotations/not-a-uuid', { screenId: 'home', shapes: [pin(1, 1)] })).status, 400);
  assert.equal((await jamie.put(`/annotations/${first}`, { screenId: 'gone', shapes: [pin(1, 1)] })).body.details.code, 'screen_invalid');
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'nope', shapes: [pin(1, 1)] })).body.details.code, 'screen_invalid');
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { category: 'color', screenId: 'home', shapes: [pin(1, 1)] })).body.details.code, 'category_invalid');

  // Status: author or decision rights.
  const resolved = await jamie.post(`/annotations/${first}/status`, { status: 'resolved' });
  assert.equal(resolved.body.annotation.status, 'resolved');
  const reopened = await harness.team('projectManager', round.id).post(`/annotations/${first}/status`, { status: 'open' });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.annotation.status, 'open');
  assert.equal((await jamie.post(`/annotations/${first}/status`, { status: 'carried' })).status, 400);

  // Admins and managers may delete any annotation on the team side; members only their own.
  assert.equal((await harness.team('member', round.id).del(`/annotations/${second}`)).status, 403);
  assert.equal((await harness.team('projectManager', round.id).del(`/annotations/${second}`)).status, 200);
});

test('shape validation: types, schema version, stroke 1-24, min size 4 px, bounds, pen point limits, text', async () => {
  const { harness, jamieToken, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);
  const put = (shapes, screenId = 'home') => jamie.put(`/annotations/${randomUUID()}`, { screenId, shapes });
  const rejectCode = async (shapes, code, screenId = 'home') => {
    const response = await put(shapes, screenId);
    assert.equal(response.status, 400, `${code}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.details.code, 'shapes_invalid');
    assert.equal(response.body.details.issues[0].code, code, JSON.stringify(response.body.details.issues));
  };

  await rejectCode([{ ...pin(1, 1), type: 'circle' }], 'unknown_type');
  await rejectCode([{ ...pin(1, 1), schemaVersion: 2 }], 'unsupported_schema_version');
  await rejectCode([{ ...pin(1, 1), style: { color: 'orange', stroke: 3 } }], 'invalid_style');
  await rejectCode([box(10, 10, 20, 20, { style: { color: '#000000', stroke: 25 } })], 'invalid_style');
  await rejectCode([box(10, 10, 20, 20, { style: { color: '#000000', stroke: 0.5 } })], 'invalid_style');
  await rejectCode([box(10, 10, 3.9, 20)], 'too_small');
  await rejectCode([{ schemaVersion: 1, style, type: 'arrow', x: 10, x2: 12, y: 10, y2: 12 }], 'too_small');
  await rejectCode([{ points: [[10, 10], [11, 12], [12, 11]], schemaVersion: 1, style, type: 'pen' }], 'too_small');
  await rejectCode([box(300, 150, 30, 30)], 'out_of_bounds');
  await rejectCode([pin(-1, 5)], 'out_of_bounds');
  await rejectCode([pin(Number.NaN, 5)], 'invalid_shape');
  await rejectCode([{ points: [[10, 10]], schemaVersion: 1, style, type: 'pen' }], 'invalid_points');
  await rejectCode([{ points: Array.from({ length: 2001 }, (_, index) => [index % 300, index % 200]), schemaVersion: 1, style, type: 'pen' }], 'invalid_points');
  await rejectCode([{ ...box(10, 10, 100, 30), fontSize: 16, text: '   ', type: 'text' }], 'empty_text');
  await rejectCode([{ ...box(10, 10, 100, 30), fontSize: 600, text: 'Hi', type: 'text' }], 'invalid_number');

  const empty = await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'home', shapes: [] });
  assert.equal(empty.status, 400);

  // Every valid type, at the edges, stroke 1 and 24, a 3-digit color, unknown fields dropped.
  const ok = await put([
    pin(320, 200),
    box(0, 0, 4, 4, { style: { color: '#fff', stroke: 1 } }),
    { h: 50, schemaVersion: 1, style: { color: '#facc15', stroke: 24 }, type: 'highlight', w: 100, x: 200, y: 150 },
    { schemaVersion: 1, style, type: 'arrow', x: 0, x2: 4, y: 0, y2: 0 },
    { points: [[0, 0], [10, 10], [20, 0]], schemaVersion: 1, style, type: 'pen' },
    { fontSize: 16, h: 30, schemaVersion: 1, style, text: 'Too loud', type: 'text', w: 100, x: 10, y: 10, extra: 'dropped' },
  ]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.annotation.shapes.length, 6);
  assert.equal(ok.body.annotation.shapes[1].style.color, '#ffffff');
  assert.equal(ok.body.annotation.shapes[5].extra, undefined);

  // A blank frame, when the prototype's snapshot failed, uses the declared viewport (1280x800).
  const blank = { snapshotUnavailable: true };
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { anchor: blank, screenId: 'booking', shapes: [pin(1200, 700)] })).status, 201);
  const outside = await jamie.put(`/annotations/${randomUUID()}`, { anchor: blank, screenId: 'booking', shapes: [pin(1300, 700)] });
  assert.equal(outside.body.details.issues[0].code, 'out_of_bounds');
});

test('snapshots: PNG only, validated, 10 MB limit, served as image/png with nosniff, bounds come from the snapshot', async () => {
  const { harness, jamieToken, outsideToken, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);

  const png = makePng(1280, 800, [240, 240, 240]);
  const upload = await jamie.raw('/snapshots?screenId=booking&stateKey=pick-time', png);
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.deepEqual([upload.body.width, upload.body.height], [1280, 800]);
  const { snapshotFileId } = upload.body;
  const stored = await harness.roundsRepository.getSnapshot({ projectId: PROJECT_ID, snapshotId: snapshotFileId, tenantId: TENANT_ID });
  assert.equal(stored.screenId, 'booking');
  assert.equal(stored.stateKey, 'pick-time');
  assert.equal(stored.uploadedBy.startsWith('stakeholder:'), true);
  assert.ok(harness.storage.objects.has(stored.storageKey));

  // Rejections: wrong type, not a PNG, truncated, corrupt header, wrong screen, too large.
  assert.equal((await jamie.raw('/snapshots', Buffer.from('<html><script>alert(1)</script></html>'), 'text/html')).status, 415);
  const notPng = await jamie.raw('/snapshots', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  assert.equal(notPng.status, 400);
  assert.equal(notPng.body.details.code, 'snapshot_invalid');
  assert.equal((await jamie.raw('/snapshots', png.subarray(0, png.length - 12))).body.details.code, 'snapshot_invalid');
  const corrupt = Buffer.from(png);
  corrupt[18] ^= 0xff;
  assert.equal((await jamie.raw('/snapshots', corrupt)).body.details.code, 'snapshot_invalid');
  assert.equal((await jamie.raw('/snapshots?screenId=home', png)).body.details.code, 'screen_invalid');
  const huge = Buffer.concat([png.subarray(0, png.length - 12), Buffer.alloc(10 * 1024 * 1024 + 1), png.subarray(png.length - 12)]);
  const tooLarge = await jamie.raw('/snapshots', huge);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.details.code, 'snapshot_too_large');

  // An annotation on the snapshot records screen, state, snapshot, and element hint.
  const annotationId = randomUUID();
  const annotated = await jamie.put(`/annotations/${annotationId}`, {
    elementHint: { odinId: 'time-slot', tag: 'button', text: '10:30' },
    screenId: 'booking',
    shapes: [pin(1270, 790)],
    snapshotFileId,
    stateKey: 'pick-time',
  });
  assert.equal(annotated.status, 201, JSON.stringify(annotated.body));
  const record = await harness.roundsRepository.getAnnotation({ annotationId });
  assert.deepEqual([record.screenId, record.stateKey, record.snapshotFileId, record.elementHint.odinId], ['booking', 'pick-time', snapshotFileId, 'time-slot']);
  assert.equal(annotated.body.annotation.snapshotUrl, `/api/public/requirements/${jamieToken}/rounds/${round.id}/snapshots/${snapshotFileId}`);
  // A prototype mark needs its snapshot, and a later save that leaves it out keeps it there.
  const bare = await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'booking', shapes: [pin(5, 5)], stateKey: 'pick-time' });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.details.code, 'snapshot_required');
  const moved = await jamie.put(`/annotations/${annotationId}`, { anchor: { scroll: { x: 0, y: 120 } }, screenId: 'booking', shapes: [pin(1200, 700)], stateKey: 'pick-time' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.annotation.snapshotFileId, snapshotFileId);
  assert.deepEqual(moved.body.annotation.anchor, { scroll: { x: 0, y: 120 } });
  // A smaller snapshot bounds the marks.
  const small = await jamie.raw('/snapshots?screenId=booking', makePng(400, 300));
  const outside = await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'booking', shapes: [pin(500, 100)], snapshotFileId: small.body.snapshotFileId });
  assert.equal(outside.body.details.issues[0].code, 'out_of_bounds');
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'home', shapes: [pin(1, 1)], snapshotFileId })).body.details.code, 'snapshot_invalid');
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'booking', shapes: [pin(1, 1)], snapshotFileId: randomUUID() })).body.details.code, 'snapshot_invalid');

  // A blank-frame fallback keeps a note when capture failed.
  const fallback = await jamie.put(`/annotations/${randomUUID()}`, { anchor: { note: 'Canvas did not capture.', snapshotUnavailable: true }, screenId: 'booking', shapes: [pin(5, 5)] });
  assert.deepEqual(fallback.body.annotation.anchor, { note: 'Canvas did not capture.', snapshotUnavailable: true });

  // Served back as image/png, nosniff, sandboxed, to round participants only.
  const served = await harness.portal(jamieToken, round.id).get(`/snapshots/${snapshotFileId}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.match(served.headers['content-security-policy'], /sandbox/);
  assert.equal(served.headers['cache-control'], 'no-store');
  assert.ok(Buffer.compare(served.body, png) === 0);
  const team = await harness.as('viewer').get(`/rounds/${round.id}/snapshots/${snapshotFileId}`);
  assert.equal(team.status, 200);
  assert.equal(team.headers['content-type'], 'image/png');
  assert.match(team.headers['cache-control'], /private/);
  assert.equal((await harness.portal(outsideToken, round.id).get(`/snapshots/${snapshotFileId}`)).status, 404);
  assert.equal((await harness.as('viewer').get(`/rounds/${round.id}/snapshots/${randomUUID()}`)).status, 404);
  assert.equal((await harness.as('outsider').get(`/rounds/${round.id}/snapshots/${snapshotFileId}`)).status, 404);
});

test('annotation threads: replies, own-only edits and deletes, removed comments keep their place', async () => {
  const { harness, jamieToken, caseyToken, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);
  const casey = harness.portal(caseyToken, round.id);
  const annotationId = randomUUID();
  await jamie.put(`/annotations/${annotationId}`, { screenId: 'home', shapes: [pin(10, 10)] });

  const first = await jamie.post(`/annotations/${annotationId}/comments`, { body: 'The price is too loud.' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.comment.body, 'The price is too loud.');
  assert.equal(first.body.comment.isMine, true);
  const reply = await casey.post(`/annotations/${annotationId}/comments`, { body: 'Agree, smaller please.', parentCommentId: first.body.comment.id });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.comment.parentCommentId, first.body.comment.id);
  assert.equal(reply.body.annotation.thread.length, 2);
  assert.equal((await casey.post(`/annotations/${annotationId}/comments`, { body: 'x', parentCommentId: randomUUID() })).status, 400);
  assert.equal((await casey.post(`/annotations/${annotationId}/comments`, { body: '' })).status, 400);

  assert.equal((await casey.patch(`/annotations/${annotationId}/comments/${first.body.comment.id}`, { body: 'Hijack' })).status, 404);
  const edited = await jamie.patch(`/annotations/${annotationId}/comments/${first.body.comment.id}`, { body: 'The price card is too loud.' });
  assert.equal(edited.body.comment.body, 'The price card is too loud.');
  assert.ok(edited.body.comment.editedAt);
  assert.equal((await casey.del(`/annotations/${annotationId}/comments/${first.body.comment.id}`)).status, 404);
  const removed = await jamie.del(`/annotations/${annotationId}/comments/${first.body.comment.id}`);
  assert.equal(removed.status, 200);
  const kept = removed.body.annotation.thread.find((entry) => entry.id === first.body.comment.id);
  assert.deepEqual([kept.isDeleted, kept.body], [true, '']);
  assert.equal((await casey.post(`/annotations/${annotationId}/comments`, { body: 'x', parentCommentId: first.body.comment.id })).status, 409);
  assert.equal((await jamie.post(`/annotations/${randomUUID()}/comments`, { body: 'x' })).status, 404);
});

test('submit records submitted_at with a not-reviewed summary; comments continue until close; closed rounds are read-only', async () => {
  const { harness, jamieToken, round } = await openRound();
  const jamie = harness.portal(jamieToken, round.id);
  await jamie.put('/screens/home/verdict', { overall: 'keep' });
  await jamie.put('/directions/schedule-first', { stance: 'rejected' });
  const annotationId = randomUUID();
  await jamie.put(`/annotations/${annotationId}`, { screenId: 'home', shapes: [pin(10, 10)] });
  const events = harness.recordEvents(harness.projectChannel);

  const submitted = await jamie.post('/submit', {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.ok(submitted.body.submittedAt);
  assert.deepEqual(submitted.body.summary.screens, [{ overall: 'keep', screenId: 'home' }, { overall: null, screenId: 'booking' }, { overall: null, screenId: 'gone' }]);
  assert.deepEqual(submitted.body.summary.directions, [{ directionId: 'action-first', stance: null }, { directionId: 'schedule-first', stance: 'rejected' }]);
  assert.ok(submitted.body.summary.questions.every((entry) => entry.answered === false));
  assert.ok(events.events.some((event) => event.type === 'requirements.rounds.invalidated' && event.reason === 'review-submitted'));
  const again = await jamie.post('/submit', {});
  assert.equal(again.body.submittedAt, submitted.body.submittedAt, 'submitting twice keeps the first time');
  assert.equal((await jamie.get()).body.me.submittedAt, submitted.body.submittedAt);
  const detail = (await harness.as('member').get(`/rounds/${round.id}`)).body.round;
  assert.equal(detail.counts.submitted, 1);

  // Comments and annotations still work after submitting.
  assert.equal((await jamie.post(`/annotations/${annotationId}/comments`, { body: 'One more thought.' })).status, 201);
  assert.equal((await jamie.put(`/annotations/${randomUUID()}`, { screenId: 'gone', shapes: [pin(1, 1)] })).status, 201);

  // After close, everything is read-only.
  await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'changes-requested' });
  const readOnly = await jamie.get();
  assert.equal(readOnly.status, 200);
  assert.equal(readOnly.body.round.readOnly, true);
  assert.equal(readOnly.body.me.canSubmit, false);
  assert.ok(readOnly.body.annotations.every((annotation) => !annotation.actions.edit && !annotation.actions.comment));
  for (const [method, path, body] of [
    ['put', '/screens/home/verdict', { overall: 'change' }],
    ['put', '/directions/action-first', { stance: 'preferred' }],
    ['put', '/questions/notice/answer', { value: 'x' }],
    ['put', `/annotations/${annotationId}`, { screenId: 'home', shapes: [pin(5, 5)] }],
    ['del', `/annotations/${annotationId}`],
    ['post', `/annotations/${annotationId}/comments`, { body: 'late' }],
    ['post', `/annotations/${annotationId}/status`, { status: 'resolved' }],
    ['post', '/submit', {}],
  ]) {
    const response = await jamie[method](path, body);
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.equal(response.body.details.code, 'round_closed');
  }
  assert.equal((await jamie.raw('/snapshots', makePng(10, 10))).status, 409);
});

test('live events: annotation saves reach the project channel and the invited stakeholders\' portal channels only', async () => {
  const { harness, jamieToken, outsideToken, round } = await openRound();
  const links = harness.requirementsRepository.state.links;
  const tokenLink = async (token) => (await harness.requirementsRepository.findAccessTokenByHash({ tokenHash: (await import('../src/modules/requirements/requirements-access-links.js')).hashAccessToken(token) })).link.id;
  const invitedChannels = round.reviewers.filter((reviewer) => reviewer.actorType === 'stakeholder').map((reviewer) => links.find((link) => link.stakeholderId === reviewer.actorId).id);
  const outsideChannel = await tokenLink(outsideToken);
  const project = harness.recordEvents(harness.projectChannel);
  const invited = invitedChannels.map((linkId) => harness.recordEvents(LIVE_EVENT_CHANNELS.publicRequirements(linkId)));
  const outsider = harness.recordEvents(LIVE_EVENT_CHANNELS.publicRequirements(outsideChannel));

  const annotationId = randomUUID();
  await harness.portal(jamieToken, round.id).put(`/annotations/${annotationId}`, { screenId: 'home', shapes: [pin(10, 10)] });
  const teamEvent = project.events.find((event) => event.type === 'requirements.review.updated');
  assert.deepEqual(
    { annotationId: teamEvent.annotationId, reason: teamEvent.reason, roundId: teamEvent.roundId, screenId: teamEvent.screenId, track: teamEvent.track },
    { annotationId, reason: 'annotation-saved', roundId: round.id, screenId: 'home', track: 'experience' },
  );
  assert.deepEqual(teamEvent.actor, { name: 'Jamie Ortiz', type: 'stakeholder' });
  for (const channel of invited) {
    const event = channel.events.find((item) => item.type === 'requirements.review.updated');
    assert.deepEqual({ annotationId: event.annotationId, roundId: event.roundId, screenId: event.screenId }, { annotationId, roundId: round.id, screenId: 'home' });
    assert.equal(event.actor, undefined, 'portal events carry no actor');
  }
  assert.equal(outsider.events.length, 0, 'stakeholders not invited to the round hear nothing');

  // Debounced summaries: one scheduled refresh per scope, not a run per save.
  assert.ok(harness.summaries.isPending({ projectId: PROJECT_ID, scopeId: screenScopeId(round.id, 'home'), scopeType: 'screen', tenantId: TENANT_ID }));
  assert.equal(harness.summaryAi.calls.length, 0);
});
