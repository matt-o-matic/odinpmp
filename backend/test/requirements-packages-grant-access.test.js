import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createGrantAccessCheck, GRANT_RECHECK_MS } from '../src/modules/requirements/packages/package-grant-access.js';
import { createPackageGrant, verifyPackageGrant } from '../src/modules/requirements/packages/package-grants.js';
import { createReviewOriginApp } from '../src/review-origin/app.js';
import { createRoundsTestApp, GRANT_SECRET, REVIEW_PUBLIC_URL, roundPackageFiles, ROLE_USERS } from './helpers/requirements-rounds-app.js';

// AC-06 for package files: a grant keeps working only while its viewer still has access.
// The review origin here is the real app with the real access check over the same
// repositories the API uses, with no recheck cache so each request sees the current state.

const DAY_MS = 24 * 60 * 60 * 1000;

function accessDeps(harness) {
  return {
    assistantRepository: harness.assistantRepository,
    clock: () => new Date(Date.now() + harness.clock.offsetMs),
    projectRepository: harness.projectRepository,
    requirementsRepository: harness.requirementsRepository,
    roundsRepository: harness.roundsRepository,
  };
}

async function openRound() {
  const harness = await createRoundsTestApp();
  const pkg = await harness.uploadPackage(roundPackageFiles());
  const jamie = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [{ actorId: jamie.id, actorType: 'stakeholder' }, { actorId: casey.id, actorType: 'stakeholder' }],
  });
  const links = harness.portalLinksInMail();
  const tokenFor = (stakeholder) => links.find((link) => link.recipient === stakeholder.email).token;
  const reviewOrigin = createReviewOriginApp({
    frontendAppUrl: 'http://localhost:5173/app',
    grantSecret: GRANT_SECRET,
    mayViewGrant: createGrantAccessCheck(accessDeps(harness), { cacheMs: 0 }),
    packagesRepository: harness.packagesRepository,
    storage: harness.storage,
  });
  // What a reviewer keeps: the review-origin path of one screen from their review state.
  const screenPath = async (token) => {
    const state = await harness.portal(token, round.id).get();
    assert.equal(state.status, 200, JSON.stringify(state.body));
    return state.body.screens.find((screen) => screen.screenId === 'home').entryUrl.slice(REVIEW_PUBLIC_URL.length);
  };
  const linkOf = (stakeholder) => harness.requirementsRepository.state.links.find((link) => link.stakeholderId === stakeholder.id);
  return { casey, caseyToken: tokenFor(casey), harness, jamie, jamieToken: tokenFor(jamie), linkOf, pkg, reviewOrigin, round, screenPath };
}

test('AC-06 revoking a stakeholder link stops its earlier package grants at once', async () => {
  const { caseyToken, harness, jamie, jamieToken, linkOf, pkg, reviewOrigin, round, screenPath } = await openRound();
  const jamiePath = await screenPath(jamieToken);
  const caseyPath = await screenPath(caseyToken);
  const grant = verifyPackageGrant({ grant: jamiePath.split('/')[3], packageId: pkg.id, secret: GRANT_SECRET });
  assert.equal(grant.viewerRef, `stakeholder:${jamie.id}`);
  assert.equal(grant.linkId, linkOf(jamie).id, 'the grant names the link it came from');
  assert.ok(grant.tokenId, 'and the token');
  assert.equal((await request(reviewOrigin).get(jamiePath)).status, 200);

  const revoked = await harness.as('projectManager').post(`/links/${linkOf(jamie).id}/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal((await harness.portal(jamieToken, round.id).get()).status, 410);
  const after = await request(reviewOrigin).get(jamiePath);
  assert.equal(after.status, 404, 'a fresh request with the earlier grant is refused');
  assert.equal(after.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(reviewOrigin).get(caseyPath)).status, 200, 'other reviewers are unaffected');
});

test('AC-06 a stakeholder removed from the round, or whose link expired, stops getting package files', async () => {
  const { casey, caseyToken, harness, jamieToken, reviewOrigin, round, screenPath } = await openRound();
  const jamiePath = await screenPath(jamieToken);
  const caseyPath = await screenPath(caseyToken);
  const caseyReviewer = (await harness.as('member').get(`/rounds/${round.id}`)).body.round.reviewers.find((reviewer) => reviewer.actorId === casey.id);
  const updated = await harness.as('member').patch(`/rounds/${round.id}`, { removeReviewerIds: [caseyReviewer.id] });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal((await request(reviewOrigin).get(caseyPath)).status, 404);
  assert.equal((await request(reviewOrigin).get(jamiePath)).status, 200);

  // A closed round stays readable until the link expires, 14 days after involvement ends.
  assert.equal((await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'screens-accepted' })).status, 200);
  assert.equal((await request(reviewOrigin).get(jamiePath)).status, 200);
  harness.clock.offsetMs = 15 * DAY_MS;
  assert.equal((await harness.portal(jamieToken, round.id).get()).status, 410);
  assert.equal((await request(reviewOrigin).get(jamiePath)).status, 404);
});

test('AC-06 a member grant works only while the member can read the project', async () => {
  const { harness, pkg, reviewOrigin } = await openRound();
  const team = await harness.as('viewer').get(`/packages/${pkg.id}/grant`);
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.equal((await request(reviewOrigin).get(team.body.entryUrls.home.slice(REVIEW_PUBLIC_URL.length))).status, 200);

  // A correctly signed grant for someone without access to the project (as after removal).
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  for (const viewerRef of [`user:${ROLE_USERS.outsider.id}`, 'user:not-a-user', 'stakeholder:no-link', 'assistant:odin']) {
    const grant = createPackageGrant({ expiresAt, packageId: pkg.id, screenId: 'home', secret: GRANT_SECRET, viewerRef });
    assert.equal((await request(reviewOrigin).get(`/p/${pkg.id}/${grant}/screens/home.png`)).status, 404, viewerRef);
  }
});

test('the access answer is cached per viewer for a short window, then checked again', async () => {
  const { harness, jamie, jamieToken, linkOf, pkg, screenPath } = await openRound();
  const grant = verifyPackageGrant({ grant: (await screenPath(jamieToken)).split('/')[3], packageId: pkg.id, secret: GRANT_SECRET });
  const clock = { now: 1_000_000 };
  const mayView = createGrantAccessCheck(accessDeps(harness), { now: () => clock.now });
  const viewed = await harness.packagesRepository.getPackageById(pkg.id);
  assert.equal(await mayView({ grant, pkg: viewed }), true);
  await harness.as('projectManager').post(`/links/${linkOf(jamie).id}/revoke`);
  clock.now += GRANT_RECHECK_MS - 1;
  assert.equal(await mayView({ grant, pkg: viewed }), true, 'within the window the cached answer stands');
  clock.now += 1;
  assert.equal(await mayView({ grant, pkg: viewed }), false, 'after it, revocation applies');
  assert.equal(GRANT_RECHECK_MS, 15_000);
});
