import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import mysql from 'mysql2/promise';
import request from 'supertest';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createPackageGrant } from '../src/modules/requirements/packages/package-grants.js';
import { createMysqlPackagesRepository } from '../src/modules/requirements/packages/packages.repository.js';
import { ingestPackage } from '../src/modules/requirements/packages/packages.service.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createReviewOriginApp } from '../src/review-origin/app.js';
import { buildZip, imageScreen, makePng, manifestWith, prototypeScreen, PROTOTYPE_HTML } from './helpers/review-packages.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

function packageFiles({ css = 'body{}', title = 'Client booking', track = 'experience' } = {}) {
  return {
    'manifest.json': JSON.stringify(manifestWith({
      sections: [{ id: 'screens', items: [imageScreen('home'), prototypeScreen('booking')], type: 'screens' }],
      theme: 'dark',
      title,
      track,
    })),
    'prototypes/booking/app.js': 'void 0;',
    'prototypes/booking/index.html': PROTOTYPE_HTML,
    'prototypes/booking/styles.css': css,
    'screens/home.png': makePng(320, 200),
  };
}

test('MySQL: migrations 0057 and 0064, package storage, versions, files, uploads, and the review origin', { skip: !databaseUrl, timeout: 600_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_pkg_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'odin-review-packages-'));

  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try {
      await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8'));
    } finally {
      await importer.end();
    }

    // The migration lock is server-wide, and other suites may be bootstrapping their own databases.
    const runMigrations = (options) => runMysqlMigrations({ ...options, lockTimeoutSeconds: 240 });
    const first = await bootstrapMysqlSchema({ executor: pool, runMigrations });
    assert.ok(first.applied.includes('0063_clarification_topics_backfill'));
    assert.deepEqual((await bootstrapMysqlSchema({ executor: pool, runMigrations })).applied, [], 'checksums match and nothing reapplies');
    const [tables] = await pool.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'review_package%' ORDER BY TABLE_NAME");
    assert.deepEqual(tables.map((row) => row.name), ['review_package_files', 'review_package_screens', 'review_package_uploads', 'review_packages']);
    const [warningColumn] = await pool.query("SELECT DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'review_packages' AND COLUMN_NAME = 'warnings_json'");
    assert.equal(warningColumn[0]?.type, 'json');

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const packagesRepository = createMysqlPackagesRepository({ pool });
    const requirementsRepository = createMysqlRequirementsRepository({ pool });
    const packageStorage = createLocalFileStorage({ rootDir: storageRoot });
    const deps = { mermaidValidator: null, packageStorage, packagesRepository, requirementsRepository };
    const ingest = async (files, { track = 'experience', uploadedBy = 'user:u-1', source = 'ui' } = {}) => {
      const outcome = await ingestPackage(deps, { bytes: await buildZip(files), projectId, source, tenantId, track, uploadedBy });
      assert.equal(outcome.status, 'accepted', JSON.stringify(outcome.errors));
      return outcome.package;
    };

    // Versions per track, including concurrent uploads.
    const v1 = await ingest(packageFiles());
    const v2 = await ingest(packageFiles({ css: 'body{color:red}' }));
    const architecture = await ingest(packageFiles({ track: 'architecture' }), { track: 'architecture' });
    const concurrent = await Promise.all([1, 2, 3].map((index) => ingest(packageFiles({ title: `Concurrent ${index}` }))));
    assert.deepEqual([v1.version, v2.version, architecture.version], [1, 2, 1]);
    assert.deepEqual(concurrent.map((pkg) => pkg.version).sort(), [3, 4, 5]);

    // Detail: manifest without unknown fields, warnings, screens with hashes in manifest order.
    const detail = await packagesRepository.getPackage({ packageId: v1.id, projectId, tenantId });
    assert.equal(detail.status, 'draft');
    assert.equal(detail.source, 'ui');
    assert.equal(detail.uploadedBy, 'user:u-1');
    assert.equal(detail.fileCount, 5);
    assert.equal(detail.manifest.theme, undefined);
    assert.deepEqual(detail.warnings.map((warning) => warning.code), ['unknown_field']);
    assert.deepEqual(detail.screens.map((screen) => [screen.screenId, screen.kind, screen.src]), [
      ['home', 'image', 'screens/home.png'],
      ['booking', 'prototype', 'prototypes/booking/index.html'],
    ]);
    const v2Detail = await packagesRepository.getPackage({ packageId: v2.id, projectId, tenantId });
    assert.equal(v2Detail.screens[0].contentHash, detail.screens[0].contentHash);
    assert.notEqual(v2Detail.screens[1].contentHash, detail.screens[1].contentHash);
    assert.equal(await packagesRepository.getPackage({ packageId: v1.id, projectId: randomUUID(), tenantId }), null, 'scoped to the project');

    // The U1 My open items query reads the same rows.
    const drafts = await requirementsRepository.listPackages({ projectId, status: 'draft', tenantId, uploadedBy: 'user:u-1' });
    assert.equal(drafts.length, 6);
    assert.ok(drafts.some((pkg) => pkg.id === v1.id && pkg.version === 1 && pkg.track === 'experience'));

    // File index and storage.
    const file = await packagesRepository.getPackageFile({ packageId: v1.id, path: 'prototypes/booking/index.html' });
    assert.equal(file.contentType, 'text/html; charset=utf-8');
    assert.equal(file.sha256, createHash('sha256').update(PROTOTYPE_HTML).digest('hex'));
    assert.equal(await packagesRepository.getPackageFile({ packageId: v1.id, path: 'PROTOTYPES/booking/index.html' }), null);
    assert.equal((await packagesRepository.listPackageFiles({ packageId: v1.id })).length, 5);
    assert.equal((await readdir(storageRoot)).length, 6 * 5);

    // Baseline for change detection is the latest published version below this one.
    assert.equal(await packagesRepository.findBaselinePackage({ beforeVersion: 3, projectId, tenantId, track: 'experience' }), null);
    await packagesRepository.setPackageStatus({ from: 'draft', packageId: v1.id, projectId, tenantId, to: 'published' });
    assert.equal(await packagesRepository.setPackageStatus({ from: 'draft', packageId: v1.id, projectId, tenantId, to: 'withdrawn' }), null, 'conditional on the current status');
    assert.equal((await packagesRepository.findBaselinePackage({ beforeVersion: 3, projectId, tenantId, track: 'experience' })).id, v1.id);
    assert.equal(await packagesRepository.findBaselinePackage({ beforeVersion: 1, projectId, tenantId, track: 'experience' }), null);

    // The review origin serves from MySQL plus disk.
    const secret = 'mysql-review-secret-0123456789abcdefgh';
    const reviewApp = createReviewOriginApp({ frontendAppUrl: 'http://localhost:5173/app', grantSecret: secret, mayViewGrant: async () => true, packagesRepository, storage: packageStorage });
    const grant = createPackageGrant({ expiresAt: new Date(Date.now() + 60_000), packageId: v2.id, screenId: 'booking', secret, viewerRef: 'user:u-1' });
    const served = await request(reviewApp).get(`/p/${v2.id}/${grant}/prototypes/booking/styles.css`);
    assert.equal(served.status, 200);
    assert.equal(served.text, 'body{color:red}');
    assert.equal((await request(reviewApp).get(`/p/${v2.id}/${grant}/prototypes/booking/missing.css`)).status, 404);

    // Withdrawing removes the file index; the review origin then has nothing to serve.
    await packagesRepository.setPackageStatus({ from: 'draft', packageId: v2.id, projectId, tenantId, to: 'withdrawn' });
    await packagesRepository.deletePackageFiles({ packageId: v2.id });
    assert.deepEqual(await packagesRepository.listPackageFiles({ packageId: v2.id }), []);
    assert.equal((await request(reviewApp).get(`/p/${v2.id}/${grant}/prototypes/booking/styles.css`)).status, 404);

    // Upload URLs: hashed token, single claim, expiry, results.
    const tokenHash = createHash('sha256').update('odin_pkgup_example').digest('hex');
    const upload = await packagesRepository.createUpload({ upload: { expiresAt: new Date(Date.now() + 600_000), issuedTo: 'user:u-1', projectId, tenantId, tokenHash, track: 'experience' } });
    assert.equal(upload.state, 'pending');
    assert.equal((await packagesRepository.findUploadByTokenHash({ tokenHash })).id, upload.id);
    const claimed = await packagesRepository.claimUpload({ now: new Date(), tokenHash });
    assert.equal(claimed.state, 'processing');
    assert.ok(claimed.usedAt);
    assert.equal(await packagesRepository.claimUpload({ now: new Date(), tokenHash }), null, 'single use');
    const completed = await packagesRepository.completeUpload({ now: new Date(), packageId: v1.id, result: { errors: [], warnings: [{ code: 'unknown_field' }] }, state: 'accepted', uploadId: upload.id });
    assert.equal(completed.state, 'accepted');
    assert.equal(completed.packageId, v1.id);
    assert.deepEqual(completed.result.warnings, [{ code: 'unknown_field' }]);
    assert.equal((await packagesRepository.getUpload({ projectId, tenantId, uploadId: upload.id })).state, 'accepted');
    assert.equal(await packagesRepository.getUpload({ projectId: randomUUID(), tenantId, uploadId: upload.id }), null);

    const expiredHash = createHash('sha256').update('odin_pkgup_expired').digest('hex');
    await packagesRepository.createUpload({ upload: { expiresAt: new Date(Date.now() - 1000), issuedTo: 'user:u-1', projectId, tenantId, tokenHash: expiredHash, track: 'experience' } });
    assert.equal(await packagesRepository.claimUpload({ now: new Date(), tokenHash: expiredHash }), null, 'expired');

    const [uploadRows] = await pool.query('SELECT * FROM review_package_uploads');
    assert.equal(JSON.stringify(uploadRows).includes('odin_pkgup_'), false, 'no raw token is stored');

    // Migration 0064: an upload URL can name the draft it replaces.
    const replacingHash = createHash('sha256').update('odin_pkgup_replacing').digest('hex');
    const replacing = await packagesRepository.createUpload({
      upload: { expiresAt: new Date(Date.now() + 600_000), issuedTo: 'user:u-1', projectId, replacesPackageId: concurrent[0].id, tenantId, tokenHash: replacingHash, track: 'experience' },
    });
    assert.equal(replacing.replacesPackageId, concurrent[0].id);
    assert.equal((await packagesRepository.findUploadByTokenHash({ tokenHash: replacingHash })).replacesPackageId, concurrent[0].id);
    assert.equal(upload.replacesPackageId, null);

    // Replacing a draft: one transaction stores the next version and withdraws the draft.
    // Of two replacements of the same draft, one wins; the other stores nothing.
    const filesBefore = (await readdir(storageRoot)).length;
    const replace = async (files, replacesPackageId) => ingestPackage(deps, {
      bytes: await buildZip(files), projectId, replacesPackageId, source: 'ui', tenantId, track: 'experience', uploadedBy: 'user:u-2',
    });
    const outcomes = await Promise.allSettled([
      replace(packageFiles({ css: 'body{color:blue}' }), concurrent[0].id),
      replace(packageFiles({ css: 'body{color:green}' }), concurrent[0].id),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(won.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.reason?.message)));
    assert.equal(lost[0].reason.statusCode, 409);
    assert.equal(lost[0].reason.details.code, 'package_not_draft');
    assert.equal(won[0].value.package.version, 6);
    assert.equal(won[0].value.package.status, 'draft');
    assert.equal(won[0].value.replaced.id, concurrent[0].id);
    assert.equal(won[0].value.replaced.status, 'withdrawn');
    assert.equal((await packagesRepository.getPackage({ packageId: concurrent[0].id, projectId, tenantId })).status, 'withdrawn');
    assert.deepEqual(await packagesRepository.listPackageFiles({ packageId: concurrent[0].id }), []);
    assert.equal((await packagesRepository.listPackageFiles({ packageId: won[0].value.package.id })).length, 5);
    assert.equal((await readdir(storageRoot)).length, filesBefore, 'the winner’s five files replace the draft’s five; the loser’s are gone');

    // A published package is never replaced, and the attempt stores nothing.
    const [[{ count: packageCount }]] = await pool.query('SELECT COUNT(*) AS count FROM review_packages');
    await assert.rejects(() => replace(packageFiles({ css: 'body{color:teal}' }), v1.id), (error) => error.statusCode === 409 && error.details.packageStatus === 'published');
    assert.equal((await packagesRepository.getPackage({ packageId: v1.id, projectId, tenantId })).status, 'published');
    const [[{ count: packageCountAfter }]] = await pool.query('SELECT COUNT(*) AS count FROM review_packages');
    assert.equal(Number(packageCountAfter), Number(packageCount));
    assert.equal((await readdir(storageRoot)).length, filesBefore);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
    await rm(storageRoot, { force: true, recursive: true });
  }
});
