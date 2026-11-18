import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { createInMemoryObjectStorage } from '../src/modules/requirements/packages/package-storage.js';
import { createMysqlPackagesRepository } from '../src/modules/requirements/packages/packages.repository.js';
import { ingestPackage } from '../src/modules/requirements/packages/packages.service.js';
import {
  buildZip,
  createPackagesTestApp,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  standardFiles,
  TENANT_ID,
} from './helpers/review-packages.js';

// Replacing an unpublished draft (UI route and MCP upload URLs): the replacement becomes the
// track's next draft version and the old draft is withdrawn in the same step. A rejected zip,
// a failure, or a draft that changed first leaves everything as it was.

const REQUIREMENTS = `/api/projects/${PROJECT_ID}/requirements`;

function replace(harness, role, packageId, bytes, contentType = 'application/zip') {
  return request(harness.app)
    .post(`${REQUIREMENTS}/packages/${packageId}/replace`)
    .set('Authorization', `Bearer ${harness.tokens[role]}`)
    .set('Content-Type', contentType)
    .send(bytes);
}

function putUpload(app, url, bytes) {
  const { pathname } = new URL(url);
  return request(app).put(pathname).set('Content-Type', 'application/zip').send(bytes);
}

async function uploadOk(harness, files = standardFiles()) {
  const response = await harness.as('member').upload(await buildZip(files));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.package;
}

function setStatus(harness, pkg, from, to) {
  return harness.packagesRepository.setPackageStatus({ from, packageId: pkg.id, projectId: PROJECT_ID, tenantId: TENANT_ID, to });
}

function storedKeys(harness, pkg) {
  return [...harness.storage.objects.keys()].filter((key) => key.startsWith(`review-package-${pkg.id}-`));
}

async function statuses(harness) {
  const list = await harness.as('member').get('?track=experience');
  return list.body.packages.map((pkg) => [pkg.version, pkg.status]);
}

test('a member replaces a draft: the zip becomes the next draft version, and the old draft is withdrawn with its files', async () => {
  const harness = await createPackagesTestApp();
  const published = await uploadOk(harness);
  await setStatus(harness, published, 'draft', 'published');
  const round = await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    round: { number: 1, packageId: published.id, status: 'closed', track: 'experience' },
    tenantId: TENANT_ID,
  });
  const draft = await uploadOk(harness);
  const publishedKeys = storedKeys(harness, published);
  const events = [];
  harness.liveEventBus.subscribe(LIVE_EVENT_CHANNELS.project(PROJECT_ID), (event) => events.push(event));

  const response = await replace(harness, 'projectManager', draft.id, await buildZip(standardFiles({ css: 'body { color: #000; }' })));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const next = response.body.package;
  assert.equal(next.version, 3);
  assert.equal(next.status, 'draft');
  assert.equal(next.source, 'ui');
  assert.equal(next.uploadedBy, 'user:user-pmanager');
  assert.deepEqual(next.changes.baseline, { packageId: published.id, roundId: round.id, roundNumber: 1, title: 'Client booking', version: 1 });
  assert.deepEqual(next.changes.counts, { changed: 1, new: 0, removed: 0, unchanged: 1 });
  assert.deepEqual(
    (({ id, status, uploadedBy, version }) => ({ id, status, uploadedBy, version }))(response.body.replaced),
    { id: draft.id, status: 'withdrawn', uploadedBy: 'user:user-member', version: 2 },
  );

  assert.deepEqual(await statuses(harness), [[3, 'draft'], [2, 'withdrawn'], [1, 'published']]);
  assert.deepEqual(storedKeys(harness, draft), [], 'the replaced draft’s files are deleted');
  assert.equal(storedKeys(harness, { id: next.id }).length, next.fileCount);
  assert.deepEqual(storedKeys(harness, published), publishedKeys, 'the published package is untouched');
  const old = await harness.as('member').get(`/${draft.id}`);
  assert.equal(old.body.package.status, 'withdrawn', 'the replaced draft stays for history');
  assert.equal(old.body.package.manifest.title, 'Client booking');
  assert.equal((await harness.as('member').get(`/${draft.id}/grant`)).status, 404);
  assert.equal((await harness.as('member').get(`/${next.id}/grant`)).status, 200);
  assert.deepEqual(
    events.filter((event) => event.type === 'requirements.packages.invalidated').map((event) => [event.reason, event.packageIds]),
    [['uploaded', [next.id]], ['replaced', [draft.id]]],
  );

  const mine = await request(harness.app).get(`${REQUIREMENTS}/my-items`).set('Authorization', `Bearer ${harness.tokens.member}`);
  assert.deepEqual(mine.body.groups.drafts, [], 'the replaced draft leaves its uploader’s drafts');
});

test('a rejected replacement leaves the draft exactly as it was', async () => {
  const harness = await createPackagesTestApp({ reviewPackageMaxBytes: 64 * 1024 });
  const draft = await uploadOk(harness);
  const keys = storedKeys(harness, draft);

  const cases = [
    ['disallowed file', await buildZip({ ...standardFiles(), 'tools/run.exe': randomBytes(32) }), 'type_not_allowed'],
    ['over the size limit', await buildZip({ ...standardFiles(), 'assets/noise.txt': randomBytes(100 * 1024) }), 'zip_limit'],
    ['not a zip', randomBytes(512), 'zip_invalid'],
    ['other track', await buildZip(standardFiles({ manifest: { ...JSON.parse(standardFiles()['manifest.json']), track: 'architecture' } })), 'track_mismatch'],
  ];
  for (const [label, bytes, code] of cases) {
    const response = await replace(harness, 'member', draft.id, bytes);
    assert.equal(response.status, 422, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.status, 'rejected');
    assert.ok(response.body.errors.some((error) => error.code === code), `${label}: ${JSON.stringify(response.body.errors)}`);
  }
  assert.equal((await replace(harness, 'member', draft.id, Buffer.from('{}'), 'application/json')).status, 415);

  assert.deepEqual(await statuses(harness), [[1, 'draft']]);
  assert.equal(harness.storage.objects.size, keys.length);
  assert.deepEqual(storedKeys(harness, draft), keys);
  assert.equal((await harness.as('member').get(`/${draft.id}/grant`)).status, 200);
});

test('only an unpublished draft no round uses can be replaced; viewers, outsiders, and other projects get 404', async () => {
  const harness = await createPackagesTestApp();
  const published = await uploadOk(harness);
  await setStatus(harness, published, 'draft', 'published');
  const withdrawn = await uploadOk(harness);
  await harness.as('member').del(`/${withdrawn.id}`);
  const inRound = await uploadOk(harness);
  await harness.requirementsRepository.insertRound({ projectId: PROJECT_ID, round: { number: 1, packageId: inRound.id, status: 'draft', track: 'experience' }, tenantId: TENANT_ID });
  const draft = await uploadOk(harness);
  const other = await request(harness.app)
    .post(`/api/projects/${OTHER_PROJECT_ID}/requirements/packages/upload?track=experience`)
    .set('Authorization', `Bearer ${harness.tokens.member}`)
    .set('Content-Type', 'application/zip')
    .send(await buildZip(standardFiles()));
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const before = harness.storage.objects.size;
  const zip = await buildZip(standardFiles());

  const publishedResponse = await replace(harness, 'member', published.id, zip);
  assert.equal(publishedResponse.status, 409);
  assert.deepEqual(publishedResponse.body.details, { code: 'package_not_draft', packageId: published.id, packageStatus: 'published' });
  assert.match(publishedResponse.body.error, /Version 1 is no longer a draft/);
  const withdrawnResponse = await replace(harness, 'member', withdrawn.id, zip);
  assert.equal(withdrawnResponse.status, 409);
  assert.equal(withdrawnResponse.body.details.packageStatus, 'withdrawn');
  const inRoundResponse = await replace(harness, 'member', inRound.id, zip);
  assert.equal(inRoundResponse.status, 409);
  assert.equal(inRoundResponse.body.details.code, 'package_in_round');
  // A stale request is refused before its body is read or its type checked.
  assert.equal((await replace(harness, 'member', published.id, randomBytes(10), 'text/plain')).status, 409);

  assert.equal((await replace(harness, 'viewer', draft.id, zip)).status, 404);
  assert.equal((await replace(harness, 'viewer', draft.id, randomBytes(10), 'text/plain')).status, 404, 'capability before body checks');
  assert.equal((await replace(harness, 'outsider', draft.id, zip)).status, 404);
  assert.equal((await replace(harness, 'member', other.body.package.id, zip)).status, 404, 'another project’s draft');
  assert.equal((await replace(harness, 'member', 'no-such-package', zip)).status, 404);

  assert.equal(harness.storage.objects.size, before, 'nothing was stored');
  assert.deepEqual(await statuses(harness), [[4, 'draft'], [3, 'draft'], [2, 'withdrawn'], [1, 'published']]);
});

test('a draft published while its replacement is checked stays published, and the replacement stores nothing', async () => {
  const harness = await createPackagesTestApp();
  const draft = await uploadOk(harness);
  const keys = storedKeys(harness, draft);
  const original = harness.packagesRepository.replaceDraftPackage;
  harness.packagesRepository.replaceDraftPackage = async (input) => {
    await setStatus(harness, draft, 'draft', 'published');
    return original.call(harness.packagesRepository, input);
  };

  const response = await replace(harness, 'member', draft.id, await buildZip(standardFiles({ css: 'body { color: red; }' })));
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body.details, { code: 'package_not_draft', packageId: draft.id, packageStatus: 'published' });
  assert.deepEqual(await statuses(harness), [[1, 'published']]);
  assert.equal(harness.storage.objects.size, keys.length, 'the replacement’s files were removed');
  assert.deepEqual(storedKeys(harness, draft), keys);
});

test('two replacements of one draft at once: exactly one wins and the other stores nothing', async () => {
  const harness = await createPackagesTestApp();
  const draft = await uploadOk(harness);
  const [first, second] = await Promise.all([
    replace(harness, 'member', draft.id, await buildZip(standardFiles({ css: 'body { color: red; }' }))),
    replace(harness, 'projectManager', draft.id, await buildZip(standardFiles({ css: 'body { color: blue; }' }))),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409], `${JSON.stringify(first.body)} ${JSON.stringify(second.body)}`);
  const winner = first.status === 201 ? first.body.package : second.body.package;
  const loser = first.status === 409 ? first.body : second.body;
  assert.equal(loser.details.code, 'package_not_draft');

  const list = (await harness.as('member').get('?track=experience')).body.packages;
  assert.deepEqual(list.map((pkg) => [pkg.id, pkg.status]), [[winner.id, 'draft'], [draft.id, 'withdrawn']]);
  assert.equal(harness.storage.objects.size, winner.fileCount, 'only the winner’s files are stored');
});

test('a storage or database failure while replacing keeps the draft and removes what was written', async () => {
  const harness = await createPackagesTestApp();
  const draft = await uploadOk(harness);
  const keys = storedKeys(harness, draft);
  const zip = await buildZip(standardFiles({ css: 'body { color: red; }' }));

  const originalWrite = harness.storage.write;
  let writes = 0;
  harness.storage.write = async (key, bytes) => {
    writes += 1;
    if (writes === 3) throw new Error('disk full');
    return originalWrite.call(harness.storage, key, bytes);
  };
  assert.equal((await replace(harness, 'member', draft.id, zip)).status, 500);
  harness.storage.write = originalWrite;

  const originalReplace = harness.packagesRepository.replaceDraftPackage;
  harness.packagesRepository.replaceDraftPackage = async () => { throw new Error('connection lost'); };
  assert.equal((await replace(harness, 'member', draft.id, zip)).status, 500);
  harness.packagesRepository.replaceDraftPackage = originalReplace;

  assert.deepEqual(await statuses(harness), [[1, 'draft']]);
  assert.equal(harness.storage.objects.size, keys.length);
  assert.deepEqual(storedKeys(harness, draft), keys);
});

test('an upload URL can replace a draft: checked when issued and again, atomically, when the zip arrives', async () => {
  const harness = await createPackagesTestApp();
  const draft = await uploadOk(harness);

  const issued = await harness.as('member').post('/upload-urls', { replacesPackageId: draft.id, track: 'experience' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.deepEqual(issued.body.replaces, { packageId: draft.id, version: 1 });
  const record = await harness.packagesRepository.getUpload({ projectId: PROJECT_ID, tenantId: TENANT_ID, uploadId: issued.body.uploadId });
  assert.equal(record.replacesPackageId, draft.id);
  const pending = await harness.as('member').get(`/uploads/${issued.body.uploadId}`);
  assert.deepEqual(pending.body, { expiresAt: issued.body.expiresAt, ok: true, replacesPackageId: draft.id, state: 'pending', track: 'experience', uploadId: issued.body.uploadId });

  // A rejected zip spends the URL and leaves the draft alone.
  const rejected = await putUpload(harness.app, issued.body.url, await buildZip({ ...standardFiles(), 'run.exe': 'x' }));
  assert.equal(rejected.status, 422);
  assert.deepEqual(await statuses(harness), [[1, 'draft']]);

  const second = (await harness.as('member').post('/upload-urls', { replacesPackageId: draft.id, track: 'experience' })).body;
  const accepted = await putUpload(harness.app, second.url, await buildZip(standardFiles({ css: 'body { color: red; }' })));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.package.version, 2);
  assert.equal(accepted.body.package.source, 'mcp');
  assert.deepEqual(await statuses(harness), [[2, 'draft'], [1, 'withdrawn']]);
  assert.deepEqual(storedKeys(harness, draft), []);
  const status = await harness.as('viewer').get(`/uploads/${second.uploadId}`);
  assert.equal(status.body.state, 'accepted');
  assert.equal(status.body.replacesPackageId, draft.id);
  assert.equal(status.body.package.id, accepted.body.package.id);

  // The draft changes after the URL was issued: the PUT stores nothing and says why.
  const next = accepted.body.package;
  const stale = (await harness.as('member').post('/upload-urls', { replacesPackageId: next.id, track: 'experience' })).body;
  await setStatus(harness, next, 'draft', 'published');
  const before = harness.storage.objects.size;
  const conflict = await putUpload(harness.app, stale.url, await buildZip(standardFiles({ css: 'body { color: blue; }' })));
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.deepEqual(conflict.body.details, { code: 'package_not_draft', packageId: next.id, packageStatus: 'published', state: 'rejected', uploadId: stale.uploadId });
  assert.equal(harness.storage.objects.size, before);
  const conflictStatus = await harness.as('member').get(`/uploads/${stale.uploadId}`);
  assert.equal(conflictStatus.body.state, 'rejected');
  assert.deepEqual(conflictStatus.body.errors.map((error) => error.code), ['package_not_draft']);
  assert.equal((await putUpload(harness.app, stale.url, await buildZip(standardFiles()))).status, 404, 'the URL is spent');
  assert.deepEqual(await statuses(harness), [[2, 'published'], [1, 'withdrawn']]);
});

test('an upload URL is refused for a package that cannot be replaced', async () => {
  const harness = await createPackagesTestApp();
  const draft = await uploadOk(harness);
  const published = await uploadOk(harness);
  await setStatus(harness, published, 'draft', 'published');

  // Review is project-wide: a track in the request is ignored, so naming another one still replaces.
  const otherTrack = await harness.as('member').post('/upload-urls', { replacesPackageId: draft.id, track: 'architecture' });
  assert.equal(otherTrack.status, 201, JSON.stringify(otherTrack.body));
  assert.equal(otherTrack.body.replaces.packageId, draft.id);
  const notDraft = await harness.as('member').post('/upload-urls', { replacesPackageId: published.id, track: 'experience' });
  assert.equal(notDraft.status, 409);
  assert.equal(notDraft.body.details.code, 'package_not_draft');
  assert.equal((await harness.as('member').post('/upload-urls', { replacesPackageId: 'no-such-package', track: 'experience' })).status, 404);
  assert.equal((await harness.as('viewer').post('/upload-urls', { replacesPackageId: draft.id, track: 'experience' })).status, 404);

  const plain = await harness.as('member').post('/upload-urls', { track: 'experience' });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.replaces, undefined, 'a plain upload URL replaces nothing');
});

/**
 * A stand-in for a mysql2 pool with one draft row. Statements on the transaction's connection
 * act on the rows (rolled back on rollback); after the commit, every pool statement fails, as
 * when the database goes away just after committing. `failBeforeCommit` fails the first
 * connection statement starting with that text.
 */
function standInPool({ draft, failBeforeCommit = '' }) {
  const rows = new Map([[draft.id, { ...draft }]]);
  const state = { committed: false, rolledBack: false, rows };
  let snapshot = null;
  const columns = (row) => ({
    createdAt: 1_790_000_000, fileCount: row.fileCount, id: row.id, manifestJson: JSON.stringify(row.manifest), projectId: row.projectId,
    sizeBytes: row.sizeBytes, source: row.source, status: row.status, tenantId: row.tenantId, title: row.title, track: row.track,
    updatedAt: 1_790_000_000, uploadedBy: row.uploadedBy, version: row.version, warningsJson: '[]',
  });
  const connection = {
    async beginTransaction() {
      snapshot = new Map([...rows].map(([id, row]) => [id, { ...row }]));
    },
    async execute(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (failBeforeCommit && text.startsWith(failBeforeCommit)) throw new Error('The connection was lost before the commit.');
      if (text.startsWith('UPDATE review_packages SET status')) {
        const row = rows.get(params[4]);
        if (row?.status !== 'draft') return [{ affectedRows: 0 }];
        row.status = 'withdrawn';
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('SELECT COALESCE(MAX(version), 0)')) return [[{ version: Math.max(...[...rows.values()].map((row) => row.version)) }]];
      if (text.startsWith('INSERT INTO review_packages')) {
        const [id, tenantId, projectId, track, version, title, manifestJson, , source, sizeBytes, fileCount, uploadedBy] = params;
        rows.set(id, { fileCount, id, manifest: JSON.parse(manifestJson), projectId, sizeBytes, source, status: 'draft', tenantId, title, track, uploadedBy, version });
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('INSERT INTO review_package_screens')) return [{ affectedRows: 1 }];
      if (text.includes('FROM review_packages WHERE id = ?')) return [rows.has(params[0]) ? [columns(rows.get(params[0]))] : []];
      if (text.includes('FROM review_package_screens')) return [[]];
      throw new Error(`Unexpected statement: ${text}`);
    },
    async query() {
      return [{ affectedRows: 1 }];
    },
    async commit() {
      state.committed = true;
    },
    async rollback() {
      state.rolledBack = true;
      rows.clear();
      for (const [id, row] of snapshot) rows.set(id, row);
    },
    release() {},
  };
  const pool = {
    async execute(sql) {
      if (sql.includes('information_schema')) return [[{ count: 1 }]];
      throw new Error(state.committed ? 'The database went away after the commit.' : `Unexpected pool statement: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  return { pool, state };
}

const STAND_IN_DRAFT = {
  fileCount: 5, id: 'draft-1', manifest: { title: 'Client booking' }, projectId: PROJECT_ID, sizeBytes: 900, source: 'ui',
  status: 'draft', tenantId: TENANT_ID, title: 'Client booking', track: 'experience', uploadedBy: 'user:user-member', version: 1,
};

function replaceThroughMysql(pool, storage) {
  return async () => ingestPackage(
    { mermaidValidator: null, packageStorage: storage, packagesRepository: createMysqlPackagesRepository({ pool }), requirementsRepository: null },
    { bytes: await buildZip(standardFiles()), projectId: PROJECT_ID, replacesPackageId: STAND_IN_DRAFT.id, source: 'ui', tenantId: TENANT_ID, track: 'experience', uploadedBy: 'user:user-member' },
  );
}

test('MySQL repository: once a replacement commits, a failing database cannot make it delete the new files', async () => {
  const { pool, state } = standInPool({ draft: STAND_IN_DRAFT });
  const storage = createInMemoryObjectStorage();
  const outcome = await replaceThroughMysql(pool, storage)();

  assert.equal(state.committed, true);
  assert.equal(outcome.status, 'accepted');
  assert.deepEqual([outcome.package.version, outcome.package.status], [2, 'draft']);
  assert.deepEqual([outcome.replaced.id, outcome.replaced.status], [STAND_IN_DRAFT.id, 'withdrawn']);
  const keys = [...storage.objects.keys()];
  assert.equal(keys.length, 5, 'the committed package keeps its files');
  assert.ok(keys.every((key) => key.startsWith(`review-package-${outcome.package.id}-`)));
});

test('MySQL repository: a replacement that fails before its commit rolls back and removes the new files', async () => {
  const { pool, state } = standInPool({ draft: STAND_IN_DRAFT, failBeforeCommit: 'INSERT INTO review_package_screens' });
  const storage = createInMemoryObjectStorage();
  await assert.rejects(replaceThroughMysql(pool, storage), /lost before the commit/);

  assert.deepEqual([state.committed, state.rolledBack], [false, true]);
  assert.equal(state.rows.get(STAND_IN_DRAFT.id).status, 'draft');
  assert.equal(state.rows.size, 1);
  assert.equal(storage.objects.size, 0);
});
