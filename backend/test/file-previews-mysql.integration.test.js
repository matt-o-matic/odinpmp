import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { NO_PREVIEW, previewStorageKeyFor } from '../src/lib/files/file-preview.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// The MySQL side of previews (lib/files/file-preview.js): which rows wait for a conversion, how a
// result lands on every row that holds the object, and how previews follow versions, restores
// and deletes. file-previews.test.js covers the same on the in-memory repository.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const base64 = (text) => Buffer.from(text).toString('base64');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('MySQL: Office files wait for a preview, results land on every row of the object, and previews follow versions, restores and deletes', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_preview_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const user = { id: userId, name: 'Ada Admin' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Preview Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, user.name, `${userId}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Previews', '', statuses[0].id]);

    const storage = createMemoryLargeFileStorage();
    const repository = createMysqlProjectsRepository({ fileStorage: storage, pool });
    const scope = { projectId, tenantId, user };
    const save = (fileName, fileType, contents) => repository.saveFile({ ...scope, fileContentsBase64: base64(contents), fileDescription: '', fileName, fileType, targetId: projectId, targetType: 'project' });
    const keyOf = async (fileId) => (await repository.describeFileVersion({ fileId, tenantId })).storageKey;

    const report = await save('report.docx', DOCX, 'first draft');
    const untyped = await save('DECK.PPTX', 'application/octet-stream', 'a deck');
    const big = await save('huge.xlsx', 'application/vnd.ms-excel', 'x'.repeat(2000));
    const text = await save('notes.txt', 'text/plain', 'not office');
    const scanning = await save('waiting.odt', 'application/vnd.oasis.opendocument.text', 'not scanned yet');
    await pool.execute("UPDATE file_vault SET scan_status = 'pending' WHERE id = ?", [scanning.id]);

    // Office files that passed their scan, by type or name, within the limit; each object once.
    const pending = await repository.listPendingPreviewObjects({ limit: 10, maxBytes: 1000 });
    assert.deepEqual(pending.map((entry) => entry.fileName).sort(), ['DECK.PPTX', 'report.docx']);
    assert.ok((await repository.listPendingPreviewObjects({ limit: 10 })).some((entry) => entry.fileName === 'huge.xlsx'), 'with no limit the large one waits too');
    assert.equal((await repository.listPendingPreviewObjects({ limit: 10 })).some((entry) => [text.fileName, scanning.fileName].includes(entry.fileName)), false);
    assert.equal(big.fileName, 'huge.xlsx');

    // A result lands once; a second result for the same object changes nothing.
    const reportKey = await keyOf(report.id);
    const preview1 = previewStorageKeyFor(reportKey);
    storage.objects.set(preview1, Buffer.from('%PDF v1'));
    const touched = await repository.recordObjectPreview({ previewStorageKey: preview1, storageKey: reportKey });
    assert.deepEqual(touched.map(({ current, fileId, projectId: project, version }) => [current, fileId, project, version]), [[true, report.id, projectId, 1]]);
    assert.deepEqual(await repository.recordObjectPreview({ previewStorageKey: NO_PREVIEW, storageKey: reportKey }), []);
    assert.equal((await repository.describeFileVersion({ fileId: report.id, tenantId })).previewStorageKey, preview1);
    assert.equal('previewStorageKey' in (await repository.getFileRecord({ fileId: report.id, tenantId })), false, 'readers never see it');
    await repository.recordObjectPreview({ previewStorageKey: NO_PREVIEW, storageKey: await keyOf(untyped.id) });
    assert.equal((await repository.describeFileVersion({ fileId: untyped.id, tenantId })).previewStorageKey, NO_PREVIEW);
    assert.deepEqual((await repository.listPendingPreviewObjects({ maxBytes: 1000 })).map((entry) => entry.fileName), []);

    // A new version waits for its own; the old one keeps its PDF.
    await repository.saveFileVersion({ ...scope, expectedVersion: 1, fileContentsBase64: base64('second draft'), fileId: report.id, note: '' });
    assert.equal((await repository.describeFileVersion({ fileId: report.id, tenantId, version: 1 })).previewStorageKey, preview1);
    assert.equal((await repository.describeFileVersion({ fileId: report.id, tenantId })).previewStorageKey, null);
    const v2Key = await keyOf(report.id);
    assert.deepEqual((await repository.listPendingPreviewObjects({ maxBytes: 1000 })).map((entry) => entry.storageKey), [v2Key]);
    const preview2 = previewStorageKeyFor(v2Key);
    storage.objects.set(preview2, Buffer.from('%PDF v2'));
    await repository.recordObjectPreview({ previewStorageKey: preview2, storageKey: v2Key });

    // Restoring version 1 brings its PDF back as the current preview.
    const restored = await repository.restoreFileVersion({ ...scope, expectedVersion: 2, fileId: report.id, version: 1 });
    assert.equal(restored.file.version, 3);
    assert.equal((await repository.describeFileVersion({ fileId: report.id, tenantId })).previewStorageKey, preview1);
    assert.deepEqual(await repository.listPendingPreviewObjects({ maxBytes: 1000 }), []);

    // Deleting version 2, whose object nothing else holds, hands back its PDF to delete too.
    const deleted = await repository.deleteFileVersion({ ...scope, fileId: report.id, version: 2 });
    assert.deepEqual([deleted.storageKey, deleted.previewStorageKey], [v2Key, preview2]);
    // Version 1 shares its object with the current version: nothing to delete.
    const shared = await repository.deleteFileVersion({ ...scope, fileId: report.id, version: 1 });
    assert.deepEqual([shared.storageKey, shared.previewStorageKey], [null, null]);

    // Deleting the file deletes its PDFs with its objects; "no preview" is no object.
    await repository.deleteFile({ fileId: report.id, tenantId, user });
    assert.equal(storage.objects.has(preview1), false);
    const deletes = storage.calls.filter(([name]) => name === 'delete').map(([, key]) => key);
    await repository.deleteFile({ fileId: untyped.id, tenantId, user });
    assert.equal(storage.calls.filter(([name, key]) => name === 'delete' && key === NO_PREVIEW).length, 0, 'NO_PREVIEW is never deleted as an object');
    assert.ok(deletes.includes(preview1));
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
