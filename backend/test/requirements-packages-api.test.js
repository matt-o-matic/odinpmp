import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { verifyPackageGrant } from '../src/modules/requirements/packages/package-grants.js';
import {
  buildExampleZip,
  buildZip,
  createPackagesTestApp,
  GRANT_SECRET,
  imageScreen,
  makePng,
  manifestWith,
  PROJECT_ID,
  prototypeScreen,
  PROTOTYPE_HTML,
  REVIEW_PUBLIC_URL,
  standardFiles,
  TENANT_ID,
} from './helpers/review-packages.js';

const REQUIREMENTS = `/api/projects/${PROJECT_ID}/requirements`;

function threeScreenFiles({ css = 'body { color: #1d2a24; }', extraScreens = [], omit = [], basedOnRoundId } = {}) {
  const screens = [imageScreen('home'), prototypeScreen('booking'), imageScreen('gone'), ...extraScreens].filter((screen) => !omit.includes(screen.id));
  const files = {
    ...standardFiles({ css }),
    'manifest.json': JSON.stringify(manifestWith({ basedOnRoundId, sections: [{ id: 'screens', items: screens, type: 'screens' }] })),
    'screens/gone.png': makePng(320, 200, [200, 10, 10]),
  };
  for (const screen of extraScreens) files[screen.src] = makePng(320, 200, [10, 10, 200]);
  if (omit.includes('gone')) delete files['screens/gone.png'];
  return files;
}

async function uploadOk(harness, files, { role = 'member', track = 'experience' } = {}) {
  const response = await harness.as(role).upload(await buildZip(files), track);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.package;
}

function putUpload(app, url, bytes) {
  const { pathname } = new URL(url);
  return request(app).put(pathname).set('Content-Type', 'application/zip').send(bytes);
}

test('AC-03 a member uploads a valid package: it becomes draft version 1 with screens, hashes, and its uploader', { timeout: 120_000 }, async () => {
  const harness = await createPackagesTestApp();
  await harness.seedExampleContext();
  const events = [];
  harness.liveEventBus.subscribe(LIVE_EVENT_CHANNELS.project(PROJECT_ID), (event) => events.push(event));

  const response = await harness.as('member').upload(await buildExampleZip('fieldwork-round-2'));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const pkg = response.body.package;
  assert.equal(response.body.ok, true);
  assert.equal(pkg.version, 1);
  assert.equal(pkg.status, 'draft');
  assert.equal(pkg.source, 'ui');
  assert.equal(pkg.track, 'experience');
  assert.equal(pkg.title, 'Client booking — price and booking flow');
  assert.equal(pkg.uploadedBy, 'user:user-member');
  assert.deepEqual(pkg.uploader, { actorRef: 'user:user-member', id: 'user-member', name: 'Mona Member', type: 'user' });
  assert.equal(pkg.fileCount, 6);
  assert.ok(pkg.sizeBytes > 0);
  assert.deepEqual(pkg.warnings, []);
  assert.equal(pkg.manifest.sections.length, 7, 'every manifest section is returned for the preview');
  assert.deepEqual(pkg.screens.map((screen) => [screen.screenId, screen.kind, screen.title, screen.directionId]), [
    ['booking-home', 'image', 'Booking home', 'action-first'],
    ['booking-home-schedule', 'image', 'Booking home, schedule first', 'schedule-first'],
    ['booking-flow', 'prototype', 'Booking flow', null],
  ]);
  for (const screen of pkg.screens) assert.match(screen.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(pkg.changes, {
    baseline: null,
    counts: { changed: 0, new: 3, removed: 0, unchanged: 0 },
    screens: pkg.screens.map((screen) => ({ change: 'new', screenId: screen.screenId, title: screen.title })),
  });
  assert.equal(harness.storage.objects.size, 6, 'every file is stored');
  assert.ok([...harness.storage.objects.keys()].every((key) => key.startsWith(`review-package-${pkg.id}-`)));
  const packageEvents = events.filter((event) => String(event.type).startsWith('requirements.'));
  assert.deepEqual(packageEvents.map((event) => [event.type, event.reason, event.track, event.packageIds]), [['requirements.packages.invalidated', 'uploaded', 'experience', [pkg.id]]]);

  const detail = await harness.as('viewer').get(`/${pkg.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.package, pkg);

  const list = await harness.as('viewer').get('?track=experience');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.packages.map((item) => [item.id, item.version, item.status, item.warningCount]), [[pkg.id, 1, 'draft', 0]]);
  // Review is project-wide: a track in the request is ignored.
  assert.deepEqual((await harness.as('viewer').get('?track=architecture')).body.packages.map((item) => item.id), [pkg.id]);

  // My open items lists the draft under "your drafts" for the uploader only.
  const mine = await request(harness.app).get(`${REQUIREMENTS}/my-items`).set('Authorization', `Bearer ${harness.tokens.member}`);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.groups.drafts.map((item) => [item.id, item.kind, item.track, item.meta.version, item.meta.source]), [[pkg.id, 'package', 'experience', 1, 'ui']]);
  const others = await request(harness.app).get(`${REQUIREMENTS}/my-items`).set('Authorization', `Bearer ${harness.tokens.projectManager}`);
  assert.deepEqual(others.body.groups.drafts, []);
});

test('AC-04 rejected uploads report per-file reasons and store nothing', async () => {
  const harness = await createPackagesTestApp();
  const files = standardFiles();
  const missingSrcManifest = manifestWith({ sections: [{ id: 'screens', items: [imageScreen('home'), imageScreen('confirm'), prototypeScreen('booking')], type: 'screens' }] });
  const cases = [
    ['path traversal', { ...files, '../evil.png': makePng(320, 200) }, 'path_invalid', '../evil.png'],
    ['disallowed extension', { ...files, 'tools/run.exe': randomBytes(32) }, 'type_not_allowed', 'tools/run.exe'],
    ['missing src', { ...files, 'manifest.json': JSON.stringify(missingSrcManifest) }, 'missing_file', 'manifest.json'],
    ['absolute script URL', { ...files, 'prototypes/booking/index.html': PROTOTYPE_HTML.replace('app.js', 'https://cdn.example.com/app.js') }, 'external_url', 'prototypes/booking/index.html'],
    ['excessive compression ratio', { ...files, 'assets/zeros.txt': Buffer.alloc(4 * 1024 * 1024) }, 'zip_limit', 'assets/zeros.txt'],
  ];
  for (const [label, zipFiles, code, file] of cases) {
    const response = await harness.as('member').upload(await buildZip(zipFiles));
    assert.equal(response.status, 422, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.status, 'rejected');
    assert.ok(Array.isArray(response.body.warnings));
    assert.ok(response.body.errors.some((error) => error.code === code && error.file === file), `${label}: ${JSON.stringify(response.body.errors)}`);
    assert.equal(response.body.package, undefined);
  }
  assert.equal(harness.storage.objects.size, 0, 'storage listing is empty');
  assert.deepEqual((await harness.as('member').get('')).body.packages, []);
  assert.equal(harness.requirementsRepository.state.packages.length, 0);
});

test('AC-04 an oversize upload is a zip_limit rejection, as is an entry that inflates past its header', async () => {
  const harness = await createPackagesTestApp({ reviewPackageMaxBytes: 64 * 1024 });
  const oversize = await harness.as('member').upload(await buildZip({ ...standardFiles(), 'assets/noise.txt': randomBytes(100 * 1024) }));
  assert.equal(oversize.status, 422, JSON.stringify(oversize.body));
  assert.deepEqual(oversize.body.errors.map((error) => error.code), ['zip_limit']);
  assert.equal(harness.storage.objects.size, 0);

  const notZip = await harness.as('member').upload(Buffer.from('{"not":"a zip"}'), 'experience', 'application/json');
  assert.equal(notZip.status, 415);
  const badTrack = await harness.as('member').upload(await buildZip(standardFiles()), 'backend');
  assert.equal(badTrack.status, 400);
  const garbage = await harness.as('member').upload(randomBytes(512));
  assert.equal(garbage.status, 422);
  assert.deepEqual(garbage.body.errors.map((error) => error.code), ['zip_invalid']);
  assert.equal(harness.storage.objects.size, 0);
  // Review is project-wide, so an upload needs no track.
  const noTrack = await harness.as('member').upload(await buildZip(standardFiles()), '');
  assert.equal(noTrack.status, 201, JSON.stringify(noTrack.body));
  assert.equal(noTrack.body.package.track, 'experience');
});

test('versions run across the project whatever track a request names, and the zip path, Windows MIME type, and source are recorded', { timeout: 120_000 }, async () => {
  const harness = await createPackagesTestApp();
  const first = await uploadOk(harness, standardFiles());
  const secondResponse = await harness.as('projectManager').upload(await buildZip(standardFiles()), 'experience', 'application/x-zip-compressed');
  assert.equal(secondResponse.status, 201, JSON.stringify(secondResponse.body));
  const second = secondResponse.body.package;
  // Review is project-wide: an upload to "architecture" is the project's next version.
  const third = await uploadOk(harness, standardFiles(), { track: 'architecture' });
  assert.deepEqual([first.version, second.version, third.version, third.track], [1, 2, 3, 'experience']);
  assert.equal(second.uploadedBy, 'user:user-pmanager');
  // A manifest that names the architecture track is refused, with how to fix it.
  const architectureManifest = await harness.as('member').upload(await buildZip({
    'manifest.json': JSON.stringify(manifestWith({
      sections: [{ id: 'flows', items: [{ id: 'sync', mermaid: 'sequenceDiagram\n  A->>B: sync', title: 'Sync' }], type: 'flows' }],
      track: 'architecture',
    })),
  }), 'architecture');
  assert.equal(architectureManifest.status, 422);
  assert.deepEqual(architectureManifest.body.errors.map((error) => error.code), ['track_mismatch']);
  assert.match(architectureManifest.body.errors[0].message, /project-wide/);
  const list = await harness.as('member').get('');
  assert.deepEqual(list.body.packages.map((item) => [item.track, item.version]), [['experience', 3], ['experience', 2], ['experience', 1]]);
});

test('changes compare each screen to the latest published package: unchanged, changed, new, removed; stale base round warns', async () => {
  const harness = await createPackagesTestApp();
  const v1 = await uploadOk(harness, threeScreenFiles());
  await harness.packagesRepository.setPackageStatus({ from: 'draft', packageId: v1.id, projectId: PROJECT_ID, tenantId: TENANT_ID, to: 'published' });
  const round = await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    round: { number: 1, packageId: v1.id, status: 'closed', track: 'experience' },
    tenantId: TENANT_ID,
  });
  // An unpublished draft in between is not a baseline.
  await uploadOk(harness, threeScreenFiles({ css: 'body { color: red; }' }));

  const v3 = await uploadOk(harness, threeScreenFiles({
    basedOnRoundId: 'round-from-long-ago',
    css: 'body { color: #000; }',
    extraScreens: [imageScreen('fresh')],
    omit: ['gone'],
  }));
  assert.equal(v3.version, 3);
  assert.deepEqual(v3.changes.baseline, { packageId: v1.id, roundId: round.id, roundNumber: 1, title: 'Client booking', version: 1 });
  assert.deepEqual(v3.changes.counts, { changed: 1, new: 1, removed: 1, unchanged: 1 });
  assert.deepEqual(v3.changes.screens.map((screen) => [screen.screenId, screen.change]), [
    ['home', 'unchanged'],
    ['booking', 'changed'],
    ['fresh', 'new'],
    ['gone', 'removed'],
  ]);
  assert.equal(v3.changes.screens.find((screen) => screen.screenId === 'gone').title, 'Screen gone');
  assert.deepEqual(v3.warnings.map((warning) => warning.code), ['stale_base_round']);
  assert.match(v3.warnings[0].message, new RegExp(round.id));

  const v1Detail = await harness.as('member').get(`/${v1.id}`);
  assert.equal(v1Detail.body.package.changes.baseline, null, 'nothing was published before v1');
});

test('withdraw: drafts only, never a published package or one a round uses; files are deleted', async () => {
  const harness = await createPackagesTestApp();
  const draft = await uploadOk(harness, standardFiles());
  const published = await uploadOk(harness, standardFiles());
  const inRound = await uploadOk(harness, standardFiles());
  await harness.packagesRepository.setPackageStatus({ from: 'draft', packageId: published.id, projectId: PROJECT_ID, tenantId: TENANT_ID, to: 'published' });
  await harness.requirementsRepository.insertRound({ projectId: PROJECT_ID, round: { number: 1, packageId: inRound.id, status: 'draft', track: 'experience' }, tenantId: TENANT_ID });
  const before = harness.storage.objects.size;

  assert.equal((await harness.as('viewer').del(`/${draft.id}`)).status, 404);
  assert.equal((await harness.as('outsider').del(`/${draft.id}`)).status, 404);

  const withdrawn = await harness.as('member').del(`/${draft.id}`);
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.package.status, 'withdrawn');
  assert.equal(harness.storage.objects.size, before - draft.fileCount);
  assert.ok([...harness.storage.objects.keys()].every((key) => !key.includes(draft.id)));
  assert.equal((await harness.as('member').get(`/${draft.id}/grant`)).status, 404);
  assert.equal((await harness.as('member').get(`/${draft.id}`)).body.package.status, 'withdrawn', 'the record stays for history');

  assert.equal((await harness.as('member').del(`/${draft.id}`)).status, 409);
  const publishedResponse = await harness.as('projectManager').del(`/${published.id}`);
  assert.equal(publishedResponse.status, 409);
  assert.match(publishedResponse.body.error, /published/);
  assert.equal((await harness.as('member').del(`/${inRound.id}`)).status, 409);
  assert.equal((await harness.as('member').del('/no-such-package')).status, 404);

  const mine = await request(harness.app).get(`${REQUIREMENTS}/my-items`).set('Authorization', `Bearer ${harness.tokens.member}`);
  assert.deepEqual(mine.body.groups.drafts.map((item) => item.id), [inRound.id], 'withdrawn and published packages leave "your drafts"');
});

test('AC-15 permissions: viewers read but get 404 on every write, before the body is read; outsiders get 404 everywhere', async () => {
  const harness = await createPackagesTestApp();
  const pkg = await uploadOk(harness, standardFiles());
  const urlResponse = await harness.as('member').post('/upload-urls', { track: 'experience' });
  const zip = await buildZip(standardFiles());

  const viewerUpload = await harness.as('viewer').upload(zip);
  assert.equal(viewerUpload.status, 404);
  assert.equal((await harness.as('viewer').upload(randomBytes(10), 'experience', 'text/plain')).status, 404, 'capability before body checks');
  assert.equal((await harness.as('viewer').post('/upload-urls', { track: 'experience' })).status, 404);
  assert.equal((await harness.as('viewer').post('/upload-urls', {})).status, 404);
  assert.equal((await harness.as('viewer').del(`/${pkg.id}`)).status, 404);

  for (const route of ['', '?track=experience', `/${pkg.id}`, `/${pkg.id}/grant`, `/uploads/${urlResponse.body.uploadId}`]) {
    assert.equal((await harness.as('viewer').get(route)).status, 200, `viewer GET ${route}`);
    assert.equal((await harness.as('outsider').get(route)).status, 404, `outsider GET ${route}`);
  }
  assert.equal((await harness.as('outsider').upload(zip)).status, 404);
  assert.equal((await harness.as('outsider').post('/upload-urls', { track: 'experience' })).status, 404);
  assert.equal(harness.requirementsRepository.state.packages.length, 1);
});

test('upload URLs are single-use, expire after 10 minutes, are bound to project, track, and caller, and store only a hash', async () => {
  const harness = await createPackagesTestApp();
  const issued = await harness.as('member').post('/upload-urls', { track: 'experience' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(issued.headers['cache-control'], 'no-store');
  const { expiresAt, uploadId, url } = issued.body;
  assert.equal(issued.body.track, 'experience');
  assert.match(url, /^http:\/\/localhost:3001\/api\/public\/requirements-uploads\/odin_pkgup_[A-Za-z0-9_-]{43}$/);
  const ttl = Date.parse(expiresAt) - Date.now();
  assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000, `ttl ${ttl}`);

  const token = url.split('/').pop();
  const record = await harness.packagesRepository.findUploadByTokenHash({ tokenHash: createHash('sha256').update(token).digest('hex') });
  assert.equal(record.id, uploadId);
  assert.equal(record.issuedTo, 'user:user-member');
  assert.equal(JSON.stringify(record).includes(token), false, 'the token itself is not stored');

  assert.deepEqual((await harness.as('member').get(`/uploads/${uploadId}`)).body, { expiresAt, ok: true, state: 'pending', track: 'experience', uploadId });

  const accepted = await putUpload(harness.app, url, await buildZip(standardFiles()));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.headers['cache-control'], 'no-store');
  assert.equal(accepted.body.state, 'accepted');
  assert.equal(accepted.body.uploadId, uploadId);
  assert.equal(accepted.body.package.source, 'mcp');
  assert.equal(accepted.body.package.uploadedBy, 'user:user-member');
  assert.equal(accepted.body.package.version, 1);

  const reused = await putUpload(harness.app, url, await buildZip(standardFiles()));
  assert.equal(reused.status, 404, 'single-use');
  const status = await harness.as('viewer').get(`/uploads/${uploadId}`);
  assert.equal(status.body.state, 'accepted');
  assert.equal(status.body.package.id, accepted.body.package.id);
  assert.deepEqual(status.body.warnings, []);

  // A rejected upload spends the URL and keeps the errors for odin_get_package_status.
  const second = (await harness.as('member').post('/upload-urls', { track: 'experience' })).body;
  const rejected = await putUpload(harness.app, second.url, await buildZip({ ...standardFiles(), 'run.exe': 'x' }));
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.state, 'rejected');
  assert.equal(rejected.body.status, 'rejected');
  assert.deepEqual(rejected.body.errors.map((error) => error.code), ['type_not_allowed']);
  const rejectedStatus = await harness.as('member').get(`/uploads/${second.uploadId}`);
  assert.equal(rejectedStatus.body.state, 'rejected');
  assert.deepEqual(rejectedStatus.body.errors, rejected.body.errors);
  assert.equal((await putUpload(harness.app, second.url, await buildZip(standardFiles()))).status, 404);

  // Review is project-wide: a URL asked for "architecture" is an ordinary upload URL.
  const architecture = (await harness.as('member').post('/upload-urls', { track: 'architecture' })).body;
  assert.equal(architecture.track, 'experience');
  const noTrackUrl = await harness.as('member').post('/upload-urls', {});
  assert.equal(noTrackUrl.status, 201, JSON.stringify(noTrackUrl.body));

  // Expiry.
  const third = (await harness.as('member').post('/upload-urls', { track: 'experience' })).body;
  harness.clock.offsetMs = 10 * 60 * 1000 + 1000;
  assert.equal((await putUpload(harness.app, third.url, await buildZip(standardFiles()))).status, 404, 'expired');
  assert.equal((await harness.as('member').get(`/uploads/${third.uploadId}`)).body.state, 'expired');
  harness.clock.offsetMs = 0;

  for (const bogus of ['odin_pkgup_nope', 'not-a-token', 'x'.repeat(300)]) {
    assert.equal((await request(harness.app).put(`/api/public/requirements-uploads/${bogus}`).set('Content-Type', 'application/zip').send(Buffer.from('PK'))).status, 404);
  }
  assert.equal((await harness.as('member').post('/upload-urls', { track: 'backend' })).status, 400);
  assert.equal((await harness.as('member').get('/uploads/no-such-upload')).status, 404);
  assert.equal(harness.storage.objects.size, accepted.body.package.fileCount, 'only the accepted package is stored');
});

test('an upload URL stops working if its issuer loses access to the project', async () => {
  const harness = await createPackagesTestApp();
  const issued = (await harness.as('member').post('/upload-urls', { track: 'experience' })).body;
  const originalAccess = harness.projectRepository.getProjectAccess;
  harness.projectRepository.getProjectAccess = async (options) => (options.userId === 'user-member'
    ? { exists: true, projectRole: 'viewer' }
    : originalAccess.call(harness.projectRepository, options));
  try {
    const response = await putUpload(harness.app, issued.url, await buildZip(standardFiles()));
    assert.equal(response.status, 404);
  } finally {
    harness.projectRepository.getProjectAccess = originalAccess;
  }
  assert.equal((await harness.as('member').get(`/uploads/${issued.uploadId}`)).body.state, 'expired');
  assert.equal(harness.storage.objects.size, 0);
});

test('grants: members get review-origin URLs for every screen; stakeholders get them through issuePackageGrant', { timeout: 120_000 }, async () => {
  const harness = await createPackagesTestApp();
  await harness.seedExampleContext();
  const pkg = (await harness.as('member').upload(await buildExampleZip('fieldwork-round-2'))).body.package;

  const response = await harness.as('viewer').get(`/${pkg.id}/grant`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'], 'no-store');
  const { entryUrls, expiresAt } = response.body;
  assert.deepEqual(Object.keys(response.body).sort(), ['entryUrls', 'expiresAt', 'ok']);
  // Each screen gets its own grant, scoped to what that screen may load.
  const expected = { 'booking-flow': 'prototypes/booking/index.html', 'booking-home': 'screens/booking-home.png', 'booking-home-schedule': 'screens/booking-home-schedule.png' };
  assert.deepEqual(Object.keys(entryUrls).sort(), Object.keys(expected).sort());
  const grants = {};
  for (const [screenId, src] of Object.entries(expected)) {
    const match = new RegExp(`^${REVIEW_PUBLIC_URL.replace(/[.]/g, '\\.')}/p/${pkg.id}/([A-Za-z0-9_.-]+)/${src.replace(/[.]/g, '\\.')}$`).exec(entryUrls[screenId]);
    assert.ok(match, entryUrls[screenId]);
    grants[screenId] = verifyPackageGrant({ grant: match[1], packageId: pkg.id, secret: GRANT_SECRET });
    assert.deepEqual([grants[screenId].screenId, grants[screenId].viewerRef], [screenId, 'user:user-viewer']);
  }
  const ttl = Date.parse(expiresAt) - Date.now();
  assert.ok(ttl > 119 * 60 * 1000 && ttl <= 120 * 60 * 1000, `ttl ${ttl}`);
  assert.equal(grants['booking-flow'].tokenId, null, 'member grants name no token');

  const stakeholder = await harness.app.locals.issuePackageGrant({ linkId: 'link-1', packageId: pkg.id, tokenId: 'token-1', ttl: 15 * 60 * 1000, viewerRef: 'stakeholder:s-1' });
  const stakeholderGrant = stakeholder.entryUrls['booking-home'].split('/')[5];
  assert.deepEqual(
    (({ linkId, tokenId, viewerRef }) => ({ linkId, tokenId, viewerRef }))(verifyPackageGrant({ grant: stakeholderGrant, packageId: pkg.id, secret: GRANT_SECRET })),
    { linkId: 'link-1', tokenId: 'token-1', viewerRef: 'stakeholder:s-1' },
  );
  assert.ok(Date.parse(stakeholder.expiresAt) - Date.now() <= 15 * 60 * 1000);
  await assert.rejects(() => harness.app.locals.issuePackageGrant({ linkId: 'link-1', packageId: 'missing', tokenId: 'token-1', viewerRef: 'stakeholder:s-1' }), /Package not found/);
  await assert.rejects(() => harness.app.locals.issuePackageGrant({ packageId: pkg.id, viewerRef: 'stakeholder:s-1' }), /needs the portal link and token/);

  assert.equal((await harness.as('member').get('/missing/grant')).status, 404);

  const unconfigured = await createPackagesTestApp({ reviewPublicUrl: '' });
  const other = await uploadOk(unconfigured, standardFiles());
  const noOrigin = await unconfigured.as('member').get(`/${other.id}/grant`);
  assert.equal(noOrigin.status, 503);
  assert.equal(noOrigin.body.details.code, 'review_origin_not_configured');
});

test('AC-05 the app origin never serves package files or the bridge', async () => {
  const harness = await createPackagesTestApp();
  const pkg = await uploadOk(harness, standardFiles());
  const grant = (await harness.as('member').get(`/${pkg.id}/grant`)).body;
  const { pathname } = new URL(grant.entryUrls.booking);
  for (const path of [pathname, `${pathname.replace(/index\.html$/, '')}styles.css`, '/__odin/bridge.js', `/api${pathname}`]) {
    const response = await request(harness.app).get(path).set('Authorization', `Bearer ${harness.tokens.member}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['content-type'].startsWith('application/json'), true, path);
  }
});
