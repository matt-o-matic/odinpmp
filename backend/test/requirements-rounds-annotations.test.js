import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createRoundsTestApp, PROJECT_ID, REVIEW_PUBLIC_URL, roundPackageFiles, ROLE_USERS } from './helpers/requirements-rounds-app.js';
import { makePng } from './helpers/review-packages.js';

// The team's "Marks and comments" view of a round: every mark with its thread, and the
// written screen notes, in screen order.

const style = { color: '#c2410c', stroke: 3 };
const pin = (x, y) => ({ number: 1, schemaVersion: 1, style, type: 'pin', x, y });

test('the annotations view lists every mark with its thread and the written notes, in screen order', async () => {
  const harness = await createRoundsTestApp();
  const pkg = await harness.uploadPackage(roundPackageFiles());
  const jamieRecord = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [
      { actorId: ROLE_USERS.reviewer.id, actorType: 'user', required: true },
      { actorId: jamieRecord.id, actorType: 'stakeholder', required: true },
    ],
  });
  const link = harness.portalLinksInMail().filter((entry) => entry.recipient === jamieRecord.email).at(-1);
  const jamie = harness.portal(link.token, round.id);
  const ravi = harness.team('reviewer', round.id);

  const bookingMark = randomUUID();
  const homeMark = randomUUID();
  assert.equal((await ravi.put(`/annotations/${bookingMark}`, { anchor: { snapshotUnavailable: true }, screenId: 'booking', shapes: [pin(5, 5)] })).status, 201);
  assert.equal((await jamie.put(`/annotations/${homeMark}`, { category: 'hierarchy', screenId: 'home', shapes: [pin(10, 10)] })).status, 201);
  const first = await jamie.post(`/annotations/${homeMark}/comments`, { body: 'The price is too loud.' });
  await ravi.post(`/annotations/${homeMark}/comments`, { body: 'Agree, make it smaller.', parentCommentId: first.body.comment.id });
  await jamie.put('/screens/home/verdict', { change: 'Smaller price.', overall: 'keep-with-changes', stay: 'One button.' });
  await ravi.put('/screens/home/verdict', { overall: 'keep' });

  const response = await harness.as('viewer').get(`/rounds/${round.id}/annotations`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { annotations, notes, screens } = response.body;
  assert.deepEqual(screens.map((screen) => screen.screenId), ['home', 'booking', 'gone']);
  assert.deepEqual(annotations.map((annotation) => annotation.id), [homeMark, bookingMark], 'screen order, then number');

  const home = annotations[0];
  assert.equal(home.authorName, 'Jamie Ortiz');
  assert.equal(home.category, 'hierarchy');
  assert.ok(home.categoryLabel);
  assert.equal(home.status, 'open');
  assert.deepEqual(
    home.thread.map((comment) => [comment.authorName, comment.body, comment.label, Boolean(comment.parentCommentId)]),
    [['Jamie Ortiz', 'The price is too loud.', 'C1', false], [home.thread[1].authorName, 'Agree, make it smaller.', 'C2', true]],
  );
  assert.equal(annotations[1].thread.length, 0);

  // Only verdicts with written notes are listed.
  assert.deepEqual(notes.map((note) => [note.name, note.screenId, note.stay, note.change]), [['Jamie Ortiz', 'home', 'One button.', 'Smaller price.']]);

  // Each mark carries what the view draws it with, and everyone involved in it.
  assert.deepEqual(home.shapes.map((shape) => [shape.type, shape.x, shape.y]), [['pin', 10, 10]]);
  assert.equal(home.snapshotUrl, null);
  assert.equal(home.snapshotUnavailable, false);
  assert.deepEqual(home.participants.map((person) => [person.name, person.roles]), [['Jamie Ortiz', ['posted', 'commented']], [home.thread[1].authorName, ['commented']]]);
  assert.equal(home.lastActivityAt, home.thread[1].createdAt);
  assert.equal(annotations[1].snapshotUnavailable, true);
  assert.deepEqual(annotations[1].participants.map((person) => person.roles), [['posted']]);
  const homeScreen = screens.find((screen) => screen.screenId === 'home');
  assert.equal(homeScreen.kind, 'image');
  assert.ok(homeScreen.imageUrl.startsWith(`${REVIEW_PUBLIC_URL}/p/`), homeScreen.imageUrl);
  const bookingScreen = screens.find((screen) => screen.screenId === 'booking');
  assert.deepEqual([bookingScreen.kind, bookingScreen.imageUrl, bookingScreen.viewport], ['prototype', null, { height: 800, width: 1280 }]);

  // Someone tagged in a comment is involved too, and a mark on a snapshot links to its image.
  const snapshot = await jamie.raw('/snapshots?screenId=booking', makePng(1280, 800));
  const onSnapshot = randomUUID();
  assert.equal((await jamie.put(`/annotations/${onSnapshot}`, { screenId: 'booking', shapes: [pin(40, 40)], snapshotFileId: snapshot.body.snapshotFileId })).status, 201);
  const tagged = await ravi.post(`/annotations/${onSnapshot}/comments`, { body: `Can you check this, @[Jamie Ortiz](stakeholder:${jamieRecord.id})?` });
  assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
  const again = (await harness.as('viewer').get(`/rounds/${round.id}/annotations`)).body.annotations.find((annotation) => annotation.id === onSnapshot);
  assert.equal(again.snapshotUrl, `/api/projects/${PROJECT_ID}/requirements/rounds/${round.id}/snapshots/${snapshot.body.snapshotFileId}`);
  assert.deepEqual(again.participants.map((person) => [person.name, person.roles]), [['Jamie Ortiz', ['posted', 'tagged']], [again.thread[0].authorName, ['commented']]]);

  // The same access as the round itself.
  assert.equal((await harness.as('outsider').get(`/rounds/${round.id}/annotations`)).status, 404);
  assert.equal((await harness.as('viewer').get(`/rounds/${randomUUID()}/annotations`)).status, 404);
});
