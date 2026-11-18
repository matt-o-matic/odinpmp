import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema, mysqlMigrationDefinitions } from '../src/jobs/bootstrap-schema.lib.js';
import { runMysqlMigrations } from '../src/lib/database/schema-migrations.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// Migration 0097 and the MySQL side of large files: rows from before it read as clean, uploads
// land pending, scans record their result, old versions delete, and storage used counts each
// object once. large-files.test.js covers the routes on the in-memory repository.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const base64 = (text) => Buffer.from(text).toString('base64');

test('MySQL: 0097 keeps earlier files clean, and uploads, scans, version deletes and storage used work', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_large_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    // Everything before 0097, then a file saved by the release before it, then 0097.
    await runMysqlMigrations({ executor: pool, migrations: mysqlMigrationDefinitions().filter((migration) => migration.id < '0097') });
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const user = { id: userId, name: 'Ada Admin' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'File Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, user.name, `${userId}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Files', '', statuses[0].id]);
    const legacyId = randomUUID();
    await pool.execute("INSERT INTO file_vault (id, tenant_id, user_id, target_id, target_type, file_name, file_desc, file_type, file_size, signature) VALUES (?, ?, ?, ?, 'project', 'legacy.txt', '', 'text/plain', 6, ?)", [legacyId, tenantId, userId, projectId, createHash('md5').update('legacy').digest('hex')]);
    await bootstrapMysqlSchema({ executor: pool });
    const [columns] = await pool.execute("SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_DEFAULT AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('file_vault', 'file_versions') AND COLUMN_NAME IN ('file_size', 'scan_status')");
    assert.ok(columns.filter((column) => column.name === 'file_size').every((column) => column.type === 'bigint'), 'sizes are BIGINT');
    assert.ok(columns.filter((column) => column.name === 'scan_status').every((column) => column.def === 'pending'), 'new rows default to pending');
    await bootstrapMysqlSchema({ executor: pool });

    const storage = createMemoryLargeFileStorage();
    storage.objects.set(legacyId, Buffer.from('legacy'));
    const repository = createMysqlProjectsRepository({ fileStorage: storage, pool });
    const scope = { projectId, tenantId, user };
    const vault = { targetId: projectId, targetType: 'project' };
    assert.equal((await repository.getFileRecord({ fileId: legacyId, tenantId })).scanStatus, 'clean', 'a file saved before 0097 was scanned before saving');
    assert.equal((await repository.getFileAsset({ fileId: legacyId, tenantId })).bytes.toString(), 'legacy');

    // The base64 path: clean, with its SHA-256.
    const file = await repository.saveFile({ ...scope, ...vault, fileContentsBase64: base64('first'), fileDescription: '', fileName: 'sow.txt', fileType: 'text/plain' });
    assert.deepEqual([file.scanStatus, file.sha256], ['clean', sha256('first')]);

    // A large upload as version 2, then a stale one that keeps both.
    const now = Date.now();
    const uploadRecord = (overrides) => ({ baseVersion: 1, contentType: 'text/plain', createdAt: new Date(now).toISOString(), createdBy: userId, expiresAt: new Date(now + 86_400_000).toISOString(), fileId: file.id, fileName: 'sow.txt', folderId: null, id: randomUUID(), partSize: 8 * 1024 * 1024, projectId, size: 2_500_000_000, status: 'uploading', storageKey: randomUUID(), storageUploadId: 'upload-id', targetId: projectId, targetType: 'project', tenantId, ...overrides });
    const first = await repository.createFileUpload(uploadRecord({}));
    assert.equal((await repository.getFileUpload({ tenantId, uploadId: first.id })).size, 2_500_000_000, 'sizes past 2 GB fit');
    await assert.rejects(repository.saveUploadedFile({ size: 9, upload: first, user }), (error) => error.details?.code === 'upload_not_ready');
    assert.equal(await repository.setFileUploadStatus({ from: ['uploading'], status: 'assembled', tenantId, uploadId: first.id }), true);
    assert.equal(await repository.setFileUploadStatus({ from: ['uploading'], status: 'assembled', tenantId, uploadId: first.id }), false, 'a status moves once');
    storage.objects.set(first.storageKey, Buffer.from('second v2'));
    const second = await repository.saveUploadedFile({ note: 'Big one', size: 9, upload: first, user });
    assert.deepEqual([second.file.version, second.file.scanStatus, second.file.fileSize, second.file.versionNote], [2, 'pending', 9, 'Big one']);
    await assert.rejects(repository.getFileAsset({ fileId: file.id, tenantId }), (error) => error.statusCode === 409 && error.details.code === 'file_scanning');
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId, version: 1 })).bytes.toString(), 'first');

    const stale = await repository.createFileUpload(uploadRecord({ status: 'assembled' }));
    storage.objects.set(stale.storageKey, Buffer.from('stale'));
    await assert.rejects(repository.saveUploadedFile({ size: 5, upload: stale, user }), (error) => error.statusCode === 409 && error.details.code === 'file_changed' && error.details.currentVersion === 2);
    const kept = await repository.saveUploadedFile({ keepBoth: true, size: 5, upload: stale, user });
    assert.deepEqual([kept.file.fileName, kept.file.version, kept.file.scanStatus], ['sow (2).txt', 1, 'pending']);

    // Scans.
    const pending = await repository.listPendingScanObjects({ limit: 10 });
    assert.deepEqual(pending.map((entry) => entry.storageKey).sort(), [first.storageKey, stale.storageKey].sort());
    const cleaned = await repository.recordObjectScan({ md5: 'a'.repeat(32), scanStatus: 'clean', sha256: sha256('second v2'), storageKey: first.storageKey });
    assert.deepEqual(cleaned.map((entry) => [entry.fileId, entry.version, entry.current, entry.uploader.email]), [[file.id, 2, true, `${userId}@acme.test`]]);
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId })).bytes.toString(), 'second v2');
    const source = await repository.getFileVersionSource({ fileId: file.id, includeBytes: false, tenantId });
    assert.deepEqual([source.sha256, source.bytes], [sha256('second v2'), undefined]);
    const infected = await repository.recordObjectScan({ scanStatus: 'infected', storageKey: stale.storageKey });
    assert.equal(infected[0].fileId, kept.file.id);
    assert.equal((await repository.getFileRecord({ fileId: kept.file.id, tenantId })).scanStatus, 'infected');
    assert.equal((await repository.listPendingScanObjects()).length, 0);
    const [scanned] = await pool.execute("SELECT COUNT(*) AS n FROM project_change_log WHERE project_id = ? AND action = 'scanned'", [projectId]);
    assert.equal(Number(scanned[0].n), 2);

    // A third version, then delete version 1; storage used counts live, uninfected objects once.
    await repository.saveFileVersion({ ...scope, expectedVersion: 2, fileContentsBase64: base64('third!'), fileId: file.id, note: '' });
    const before = await repository.getProjectFileStorage({ projectId, tenantId });
    assert.deepEqual(before, { bytes: 'legacy'.length + 'first'.length + 'second v2'.length + 'third!'.length, files: 3, versions: 5 });
    await assert.rejects(repository.deleteFileVersion({ ...scope, fileId: file.id, version: 3 }), (error) => error.details?.code === 'current_version');
    const deleted = await repository.deleteFileVersion({ ...scope, fileId: file.id, version: 1 });
    assert.equal(deleted.storageKey, file.id, 'the object of version 1 is no longer held');
    assert.equal(await repository.deleteFileVersion({ ...scope, fileId: file.id, version: 1 }), null);
    assert.equal((await repository.getProjectFileStorage({ projectId, tenantId })).bytes, before.bytes - 'first'.length);
    assert.ok((await repository.listFileVersions({ fileId: file.id, tenantId })).find((entry) => entry.version === 1).deletedAt);
    assert.equal(await repository.describeFileVersion({ fileId: file.id, tenantId, version: 1 }), null);
    await assert.rejects(repository.restoreFileVersion({ ...scope, expectedVersion: 3, fileId: file.id, version: 1 }), (error) => error.details?.code === 'version_unavailable');

    // Expired uploads.
    const old = await repository.createFileUpload(uploadRecord({ createdAt: new Date(now - 90_000_000).toISOString(), expiresAt: new Date(now - 3_600_000).toISOString() }));
    assert.deepEqual((await repository.listExpiredFileUploads({ now: new Date() })).map((entry) => entry.id), [old.id]);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
