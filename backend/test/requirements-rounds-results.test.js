import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { makePng } from './helpers/review-packages.js';
import { createRoundsTestApp, PROJECT_ID, roundPackageFiles, ROLE_USERS, TENANT_ID } from './helpers/requirements-rounds-app.js';

const style = { color: '#c2410c', stroke: 3 };
const pin = (x, y) => ({ number: 1, schemaVersion: 1, style, type: 'pin', x, y });
// A prototype mark on a blank frame, as when the snapshot could not be taken.
const BLANK = { snapshotUnavailable: true };

async function roundWithReviewers() {
  const harness = await createRoundsTestApp();
  const pkg = await harness.uploadPackage(roundPackageFiles());
  const jamie = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [
      { actorId: ROLE_USERS.reviewer.id, actorType: 'user', required: true },
      { actorId: jamie.id, actorType: 'stakeholder', required: true },
      { actorId: casey.id, actorType: 'stakeholder' },
    ],
  });
  const links = harness.portalLinksInMail();
  const token = (stakeholder) => links.filter((link) => link.recipient === stakeholder.email).at(-1).token;
  return {
    casey: harness.portal(token(casey), round.id),
    caseyRecord: casey,
    harness,
    jamie: harness.portal(token(jamie), round.id),
    jamieRecord: jamie,
    jamieToken: token(jamie),
    pkg,
    ravi: harness.team('reviewer', round.id),
    round,
  };
}

test('results: the verdict grid matches stored verdicts, directions tally, and summaries cite real annotations and comments', async () => {
  const { casey, caseyRecord, harness, jamie, jamieRecord, ravi, round } = await roundWithReviewers();

  await jamie.put('/screens/home/verdict', { change: 'Smaller price.', dimensions: { hierarchy: 'keep' }, overall: 'keep-with-changes', stay: 'One button.' });
  await casey.put('/screens/home/verdict', { overall: 'keep' });
  await ravi.put('/screens/home/verdict', { mixed: 'Unsure about color.', overall: 'change' });
  await ravi.put('/screens/booking/verdict', { overall: 'undecided' });
  await jamie.put('/directions/action-first', { remix: 'Keep the price card.', stance: 'preferred' });
  await casey.put('/directions/action-first', { stance: 'acceptable' });
  await ravi.put('/directions/schedule-first', { stance: 'rejected' });
  await jamie.put('/questions/price-placement/answer', { value: 'range-on-home' });
  const annotationId = randomUUID();
  await jamie.put(`/annotations/${annotationId}`, { category: 'hierarchy', screenId: 'home', shapes: [pin(10, 10)] });
  const firstComment = await jamie.post(`/annotations/${annotationId}/comments`, { body: 'The price is too loud.' });
  await casey.post(`/annotations/${annotationId}/comments`, { body: 'Agree.', parentCommentId: firstComment.body.comment.id });
  await ravi.post('/submit', {});

  const results = await harness.as('viewer').get(`/rounds/${round.id}/results`);
  assert.equal(results.status, 200, JSON.stringify(results.body));
  const body = results.body;
  assert.deepEqual(body.screens.map((screen) => screen.screenId), ['home', 'booking', 'gone']);
  assert.deepEqual(body.dimensions.map((dimension) => dimension.key), ['type', 'density', 'hierarchy', 'tone-of-voice']);

  // Grid: one row per active reviewer; cells only where a verdict exists, matching storage.
  const stored = await harness.roundsRepository.listVerdicts({ roundIds: [round.id] });
  const overallRows = stored.filter((row) => row.targetType === 'screen' && row.dimension === 'overall');
  assert.equal(body.grid.length, 3);
  let cells = 0;
  for (const row of body.grid) {
    for (const [screenId, cell] of Object.entries(row.verdicts)) {
      cells += 1;
      const match = overallRows.find((item) => `${item.actorType}:${item.actorId}` === row.actorRef && item.targetId === screenId);
      assert.ok(match, `${row.actorRef} ${screenId}`);
      assert.equal(cell.overall, match.value);
      assert.equal(cell.verdictId, match.id);
    }
  }
  assert.equal(cells, overallRows.length);
  const jamieRow = body.grid.find((row) => row.actorRef === `stakeholder:${jamieRecord.id}`);
  assert.equal(jamieRow.name, 'Jamie Ortiz');
  assert.deepEqual(jamieRow.verdicts.home, { change: 'Smaller price.', dimensions: { hierarchy: 'keep' }, overall: 'keep-with-changes', stay: 'One button.', updatedAt: jamieRow.verdicts.home.updatedAt, verdictId: jamieRow.verdicts.home.verdictId });
  assert.equal(jamieRow.verdicts.booking, undefined, 'not reviewed stays absent');

  const actionFirst = body.directions.find((direction) => direction.directionId === 'action-first');
  assert.deepEqual(actionFirst.tallies, { acceptable: 1, preferred: 1, rejected: 0 });
  assert.deepEqual(actionFirst.remixNotes, [{ actorRef: `stakeholder:${jamieRecord.id}`, name: 'Jamie Ortiz', remix: 'Keep the price card.' }]);
  assert.deepEqual(body.directions.find((direction) => direction.directionId === 'schedule-first').tallies, { acceptable: 0, preferred: 0, rejected: 1 });

  const raviProgress = body.reviewers.find((reviewer) => reviewer.actorRef === `user:${ROLE_USERS.reviewer.id}`);
  assert.ok(raviProgress.submittedAt);
  assert.deepEqual(raviProgress.progress.screens, { done: 2, total: 3 });
  assert.deepEqual(body.annotationCounts.home, { carried: 0, open: 1, outdated: 0, resolved: 0, superseded: 0, total: 1 });
  assert.equal(body.questions.find((question) => question.questionId === 'price-placement').answers[0].text, 'A range on the home screen');

  // Summaries: debounced; run them now with the stub, then every cited source resolves.
  assert.equal(body.summaries.screens.home.current, null);
  assert.equal(body.summaries.screens.home.status.refreshPending, true);
  await harness.summaries.flush();
  const scopes = harness.summaryAi.calls.map((call) => `${call.scopeType}:${call.scopeId}`);
  assert.ok(scopes.includes(`screen:${round.id}:home`));
  assert.ok(scopes.includes(`round:${round.id}`));
  const homeInput = harness.summaryAi.calls.find((call) => call.scopeId === `${round.id}:home`).modelInput;
  assert.deepEqual(homeInput.citableSourceRefs.slice(0, 3), ['A1', 'C1', 'C2']);
  assert.equal(homeInput.untrustedContent.sources.find((source) => source.ref === 'C2').replyTo, 'C1');
  assert.ok(homeInput.untrustedContent.sources.some((source) => source.kind === 'verdict' && /Verdict on "Screen home": Keep with changes/.test(source.text)));

  const after = (await harness.as('viewer').get(`/rounds/${round.id}/results`)).body;
  const home = after.summaries.screens.home.current;
  assert.ok(home, 'the home screen has an Odin summary');
  assert.deepEqual(home.sources.map((source) => [source.ref, source.kind, source.available]), [
    [`annotation:${annotationId}`, 'annotation', true],
    [`comment:${firstComment.body.comment.id}`, 'comment', true],
  ]);
  assert.equal(home.sources[0].label, '#1');
  // The stub cites A1 and C1, both Jamie's.
  assert.deepEqual(home.output.aligned[0].supporters, [`stakeholder:${jamieRecord.id}`]);
  assert.deepEqual(home.output.aligned[0].supporterNames, ['Jamie Ortiz']);
  const roundSummary = after.summaries.round.current;
  assert.ok(roundSummary);
  for (const source of roundSummary.sources) assert.equal(source.available, true, source.ref);
  // A screen with one reviewer is summarized too, so their feedback gets themes.
  const booking = after.summaries.screens.booking.current;
  assert.equal(booking.output.insufficientInput, false);
  assert.equal(harness.summaryAi.calls.some((call) => call.scopeId === `${round.id}:booking`), true);

  // Proposed preferences from screen, round, and topic summaries reach the preferences
  // endpoint. Jamie's answer posted into its topic is a lone client answer, which is
  // summarized too.
  const preferences = await harness.as('viewer').get('/tracks/experience/preferences');
  assert.deepEqual([...new Set(preferences.body.proposed.map((item) => item.scopeType))].sort(), ['round', 'screen', 'topic']);

  // Refresh on request; members only.
  assert.equal((await harness.as('viewer').post(`/rounds/${round.id}/summary/refresh`, {})).status, 404);
  const refreshed = await harness.as('member').post(`/rounds/${round.id}/summary/refresh`, { screenId: 'home' });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.scopeType, 'screen');
  assert.equal(refreshed.body.outcome, 'ok');
  assert.equal((await harness.as('member').post(`/rounds/${round.id}/summary/refresh`, { screenId: 'nope' })).status, 404);

  // A deleted comment stops resolving as a source.
  await jamie.del(`/annotations/${annotationId}/comments/${firstComment.body.comment.id}`);
  const stale = (await harness.as('viewer').get(`/rounds/${round.id}/results`)).body.summaries.screens.home.current;
  assert.deepEqual(stale.sources.find((source) => source.ref === `comment:${firstComment.body.comment.id}`).available, false);
});

test('feedback export returns exactly the odin.round-feedback/v1 shape, omits what nobody gave, and pages annotations', async () => {
  const { casey, caseyRecord, harness, jamie, jamieRecord, pkg, ravi, round } = await roundWithReviewers();
  await jamie.put('/screens/home/verdict', { dimensions: { type: 'keep' }, overall: 'keep', stay: 'The button.' });
  await casey.put('/screens/gone/verdict', { overall: 'change' });
  await jamie.put('/directions/action-first', { remix: 'Price card', stance: 'preferred' });
  await casey.put('/directions/schedule-first', { stance: 'acceptable' });
  const answer = await jamie.put('/questions/speed/answer', { value: 4 });
  const snapshot = await jamie.raw('/snapshots?screenId=booking', makePng(1280, 800));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await jamie.put(`/annotations/${ids[0]}`, { category: 'hierarchy', elementHint: { odinId: 'slot', tag: 'button', text: '10:30' }, screenId: 'booking', shapes: [pin(5, 5)], snapshotFileId: snapshot.body.snapshotFileId, stateKey: 'pick-time' });
  await casey.put(`/annotations/${ids[1]}`, { screenId: 'home', shapes: [pin(6, 6)] });
  await ravi.put(`/annotations/${ids[2]}`, { screenId: 'home', shapes: [pin(7, 7)] });
  const comment = await casey.post(`/annotations/${ids[1]}/comments`, { body: 'Too bright.' });
  await ravi.post(`/annotations/${ids[1]}/comments`, { body: 'Removed later.' }).then((response) => ravi.del(`/annotations/${ids[1]}/comments/${response.body.comment.id}`));
  await harness.summaries.flush();

  const response = await harness.as('viewer').get(`/rounds/${round.id}/feedback`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const feedback = response.body;
  assert.deepEqual(Object.keys(feedback), ['schema', 'round', 'reviewers', 'directions', 'verdicts', 'annotations', 'answers', 'summaries', 'page']);
  assert.equal(feedback.schema, 'odin.round-feedback/v1');
  assert.deepEqual(feedback.round, { id: round.id, number: 1, packageVersion: pkg.version, status: 'open', track: 'experience' }, 'no due date: omitted');
  assert.deepEqual(feedback.reviewers, [
    { actorRef: `user:${ROLE_USERS.reviewer.id}`, name: 'Ravi Reviewer', required: true, submittedAt: null },
    { actorRef: `stakeholder:${jamieRecord.id}`, name: 'Jamie Ortiz', required: true, submittedAt: null },
    { actorRef: `stakeholder:${caseyRecord.id}`, name: 'Casey Lin', required: false, submittedAt: null },
  ]);
  assert.deepEqual(feedback.directions, [
    { actorRef: `stakeholder:${jamieRecord.id}`, directionId: 'action-first', remix: 'Price card', stance: 'preferred' },
    { actorRef: `stakeholder:${caseyRecord.id}`, directionId: 'schedule-first', stance: 'acceptable' },
  ]);
  assert.deepEqual(feedback.verdicts, [
    { actorRef: `stakeholder:${jamieRecord.id}`, dimensions: { type: 'keep' }, overall: 'keep', screenId: 'home', stay: 'The button.' },
    { actorRef: `stakeholder:${caseyRecord.id}`, overall: 'change', screenId: 'gone' },
  ]);
  assert.deepEqual(feedback.annotations.map((annotation) => annotation.id), [ids[1], ids[2], ids[0]], 'screen order, then display number');
  const onSnapshot = feedback.annotations.find((annotation) => annotation.id === ids[0]);
  assert.deepEqual(Object.keys(onSnapshot), ['id', 'screenId', 'stateKey', 'snapshotUrl', 'actorRef', 'category', 'status', 'elementHint', 'shapes', 'thread']);
  assert.equal(onSnapshot.snapshotUrl, `http://localhost:3001/api/projects/${PROJECT_ID}/requirements/rounds/${round.id}/snapshots/${snapshot.body.snapshotFileId}`);
  assert.equal(onSnapshot.stateKey, 'pick-time');
  assert.deepEqual(onSnapshot.shapes, [{ number: 1, schemaVersion: 1, style, type: 'pin', x: 5, y: 5 }]);
  const plain = feedback.annotations.find((annotation) => annotation.id === ids[1]);
  assert.deepEqual([plain.stateKey, plain.snapshotUrl, plain.elementHint, plain.category], [null, null, null, undefined]);
  assert.deepEqual(plain.thread, [{ actorRef: `stakeholder:${caseyRecord.id}`, body: 'Too bright.', createdAt: comment.body.comment.createdAt }], 'removed comments are left out');
  assert.deepEqual(feedback.answers, [{ actorRef: `stakeholder:${jamieRecord.id}`, questionId: 'speed', value: 4, postedCommentId: answer.body.answer.postedCommentId }]);
  assert.ok(feedback.summaries.round.aligned, 'the round summary uses the plan structure');
  assert.deepEqual(Object.keys(feedback.summaries.screens).sort(), ['booking', 'gone', 'home']);
  assert.equal(feedback.summaries.screens.gone.insufficientInput, false, 'one client stakeholder is enough for a summary');
  assert.deepEqual(feedback.page, { annotationsTotal: 3, limit: 200, nextCursor: null });

  // Paging: annotations only; everything else repeats.
  const first = await harness.as('viewer').get(`/rounds/${round.id}/feedback?limit=2`);
  assert.deepEqual(first.body.annotations.map((annotation) => annotation.id), [ids[1], ids[2]]);
  assert.ok(first.body.page.nextCursor);
  const second = await harness.as('viewer').get(`/rounds/${round.id}/feedback?limit=2&cursor=${first.body.page.nextCursor}`);
  assert.deepEqual(second.body.annotations.map((annotation) => annotation.id), [ids[0]]);
  assert.equal(second.body.page.nextCursor, null);
  assert.deepEqual(second.body.verdicts, feedback.verdicts);
  assert.equal((await harness.as('viewer').get(`/rounds/${round.id}/feedback?cursor=bogus`)).status, 400);
  assert.equal((await harness.as('viewer').get(`/rounds/${round.id}/feedback?limit=0`)).status, 400);
  assert.equal((await harness.as('outsider').get(`/rounds/${round.id}/feedback`)).status, 404);

  // The snapshot URL works for project readers.
  const { pathname } = new URL(onSnapshot.snapshotUrl);
  const served = await harness.as('viewer').get(pathname.replace(`/api/projects/${PROJECT_ID}/requirements`, ''));
  assert.equal(served.headers['content-type'], 'image/png');
});

test('carry-forward: unchanged screens carry, changed ones go outdated, removed ones are superseded; carry and close move or settle outdated marks', async () => {
  const { casey, harness, jamie, jamieRecord, jamieToken, ravi, round } = await roundWithReviewers();
  const marks = {
    deleted: randomUUID(), gone: randomUUID(), home: randomUUID(), homeRavi: randomUUID(), proto: randomUUID(), resolved: randomUUID(),
  };
  await jamie.put(`/annotations/${marks.home}`, { screenId: 'home', shapes: [pin(10, 10)] });
  await ravi.put(`/annotations/${marks.homeRavi}`, { screenId: 'home', shapes: [pin(20, 20)] });
  await casey.put(`/annotations/${randomUUID()}`, { anchor: BLANK, screenId: 'booking', shapes: [pin(1, 1)] });
  await jamie.put(`/annotations/${marks.proto}`, { anchor: BLANK, screenId: 'booking', shapes: [pin(30, 30)] });
  const thread = await jamie.post(`/annotations/${marks.proto}/comments`, { body: 'Keep this flow.' });
  await jamie.put(`/annotations/${marks.resolved}`, { anchor: BLANK, screenId: 'booking', shapes: [pin(40, 40)] });
  await jamie.post(`/annotations/${marks.resolved}/status`, { status: 'resolved' });
  await jamie.put(`/annotations/${marks.gone}`, { screenId: 'gone', shapes: [pin(5, 5)] });
  await jamie.put(`/annotations/${marks.deleted}`, { anchor: BLANK, screenId: 'booking', shapes: [pin(50, 50)] });
  await jamie.del(`/annotations/${marks.deleted}`);
  await jamie.put('/questions/notice/answer', { value: 'Two days.' });
  await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'changes-requested' });

  // Version 2 changes home, keeps the prototype, and drops "gone".
  const v2 = await harness.uploadPackage(roundPackageFiles({ homeColor: [200, 200, 30], omit: ['gone'] }));
  const published = await harness.publish({
    packageId: v2.id,
    reviewers: [
      { actorId: ROLE_USERS.reviewer.id, actorType: 'user' },
      { actorId: jamieRecord.id, actorType: 'stakeholder' },
    ],
  });
  assert.deepEqual(published.carryForward, { carried: 2, outdated: 2, superseded: 1 });
  const round2 = published.round;
  const status = async (id) => harness.roundsRepository.getAnnotation({ annotationId: id });

  const carried = await status(marks.proto);
  assert.deepEqual([carried.status, carried.roundId, carried.packageId, carried.packageVersion, carried.originRoundId, carried.carriedFromRoundId], ['carried', round2.id, v2.id, 2, round.id, round.id]);
  assert.equal((await status(marks.home)).status, 'outdated');
  assert.equal((await status(marks.home)).roundId, round.id);
  assert.equal((await status(marks.gone)).status, 'superseded');
  assert.equal((await status(marks.resolved)).status, 'resolved', 'resolved marks stay where they are');
  assert.equal((await status(marks.resolved)).roundId, round.id);
  assert.equal((await status(marks.deleted)).roundId, round.id, 'deleted marks are not carried');

  // Carried marks keep their thread and get numbers in the new round, in their old order.
  const portal2 = harness.portal(harness.portalLinksInMail().filter((link) => link.roundId === round2.id && link.recipient === 'jamie@client.example').at(-1).token, round2.id);
  const state = await portal2.get();
  assert.equal(state.status, 200, JSON.stringify(state.body));
  assert.deepEqual(state.body.screens.map((screen) => [screen.screenId, screen.change]), [['home', 'changed'], ['booking', 'unchanged']]);
  const carriedView = state.body.annotations.find((annotation) => annotation.id === marks.proto);
  assert.equal(carriedView.status, 'carried');
  assert.equal(carriedView.roundId, round2.id);
  assert.equal(carriedView.number, 2);
  assert.equal(carriedView.shapes[0].number, 2);
  assert.deepEqual(carriedView.thread.map((entry) => entry.id), [thread.body.comment.id]);
  assert.equal(carriedView.actions.edit, true);
  const outdatedView = state.body.annotations.find((annotation) => annotation.id === marks.home);
  assert.deepEqual([outdatedView.status, outdatedView.roundId, outdatedView.roundNumber], ['outdated', round.id, 1]);
  assert.deepEqual(outdatedView.actions, { carry: true, changeStatus: false, close: true, comment: true, delete: false, edit: false });
  assert.equal(state.body.annotations.some((annotation) => annotation.id === marks.gone), false, 'superseded marks have no screen to show on');
  assert.equal(state.body.annotations.find((annotation) => annotation.id === marks.homeRavi).actions.carry, false, 'only the author or a manager carries');

  // Answers carry forward by question id, shown as given on version 1, not re-submitted.
  assert.deepEqual(
    { ...state.body.previousAnswers.notice, answeredAt: undefined },
    { answeredAt: undefined, packageVersion: 1, roundId: round.id, roundNumber: 1, text: 'Two days.', value: 'Two days.' },
  );
  assert.equal(state.body.answers.notice, undefined);
  assert.equal(state.body.progress.questions.done, 0);

  // Carry: the author moves an outdated mark into round 2; others cannot.
  const jamieOld = harness.portal(jamieToken, round2.id);
  assert.equal((await harness.team('member', round2.id).post(`/annotations/${marks.home}/carry`, {})).status, 403);
  const moved = await portal2.post(`/annotations/${marks.home}/carry`, {});
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.annotation.status, moved.body.annotation.roundId, moved.body.annotation.number], ['carried', round2.id, 1]);
  assert.equal((await portal2.post(`/annotations/${marks.home}/carry`, {})).status, 409);
  // A manager closes Ravi's outdated mark where it is.
  const closed = await harness.team('projectManager', round2.id).post(`/annotations/${marks.homeRavi}/close`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.annotation.status, 'resolved');
  assert.equal((await status(marks.homeRavi)).roundId, round.id);
  // Old links still reach only rounds the stakeholder is invited to.
  assert.equal((await jamieOld.get()).status, 200);

  // Round 1's feedback keeps what stayed there; round 2's has the carried marks.
  const feedback1 = (await harness.as('viewer').get(`/rounds/${round.id}/feedback`)).body;
  assert.deepEqual(feedback1.annotations.map((annotation) => [annotation.id, annotation.status]).sort(), [
    [marks.gone, 'superseded'], [marks.homeRavi, 'resolved'], [marks.resolved, 'resolved'],
  ].sort());
  const feedback2 = (await harness.as('viewer').get(`/rounds/${round2.id}/feedback`)).body;
  assert.ok(feedback2.annotations.some((annotation) => annotation.id === marks.proto && annotation.status === 'carried'));

  // A round 3 compares against version 2: carried marks on unchanged screens carry again.
  await harness.as('projectManager').post(`/rounds/${round2.id}/close`, { outcome: 'changes-requested' });
  const v3 = await harness.uploadPackage(roundPackageFiles({ homeColor: [200, 200, 30], omit: ['gone'] }));
  const third = await harness.publish({ packageId: v3.id, reviewers: [{ actorId: ROLE_USERS.reviewer.id, actorType: 'user' }] });
  assert.equal(third.carryForward.carried, 3);
  assert.equal((await status(marks.home)).roundId, third.round.id);
  const projectId = PROJECT_ID;
  assert.equal((await harness.roundsRepository.listAnnotations({ projectId, roundIds: [third.round.id], tenantId: TENANT_ID })).length, 3);
});
