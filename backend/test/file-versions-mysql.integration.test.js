import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { prepareFilesForRollback } from '../src/jobs/prepare-file-rollback.lib.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';

// Versions and links on MySQL, from a database built like production's: the legacy schema plus
// every migration, in production's collation. file-versions-links.test.js covers the
// routes on the in-memory repository.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const base64 = (text) => Buffer.from(text).toString('base64');

function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    async delete(id) { objects.delete(id); },
    async read(id) {
      if (!objects.has(id)) throw new Error(`No object ${id}`);
      return { bytes: objects.get(id), size: objects.get(id).length };
    },
    async write(id, bytes) { objects.set(id, Buffer.from(bytes)); },
  };
}

test('MySQL keeps versions in their own objects, links files to items, and removes it all together', { skip: !databaseUrl, timeout: 300_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_files_${process.pid}`;
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
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'File Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, user.name, `${userId}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Files', '', statuses[0].id]);
    const storage = memoryStorage();
    const repository = createMysqlProjectsRepository({ fileStorage: storage, pool });
    const create = async (itemType, parentId, name) => (await repository.createProjectItem({ input: { item: { name }, itemType, parentId }, projectId, tenantId, user })).item;
    const epic = await create('epic', null, 'Billing');
    const story = await create('story', epic.id, 'Invoices');
    const scope = { projectId, tenantId, user };
    const vaultTarget = { targetId: projectId, targetType: 'project' };

    const file = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('first'), fileDescription: 'The SOW', fileName: 'sow.txt', fileType: 'text/plain' });
    assert.equal(file.version, 1);
    assert.deepEqual([...storage.objects.keys()], [file.id], 'a first upload is stored under the file id, as files always were');

    // Saving over the name keeps the id and the first contents.
    const second = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('second'), fileDescription: 'The SOW', fileName: 'SOW.txt', fileType: 'text/plain' });
    assert.deepEqual([second.id, second.version, second.fileName], [file.id, 2, 'sow.txt']);
    assert.equal(storage.objects.get(file.id).toString(), 'first', 'stored bytes are never rewritten');
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId })).bytes.toString(), 'second');
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId, version: 1 })).bytes.toString(), 'first');

    // A version by id, with a new name and a stale refusal.
    await assert.rejects(repository.saveFileVersion({ ...scope, expectedVersion: 1, fileContentsBase64: base64('third'), fileId: file.id, note: '' }), (error) => error.statusCode === 409);
    const third = await repository.saveFileVersion({ ...scope, expectedVersion: 2, fileContentsBase64: base64('third'), fileId: file.id, fileName: 'sow-final.txt', fileType: 'text/plain', note: 'Signed' });
    assert.deepEqual([third.unchanged, third.file.version, third.file.fileName, third.file.versionNote, third.file.description], [false, 3, 'sow-final.txt', 'Signed', 'The SOW']);
    assert.equal((await repository.saveFileVersion({ ...scope, expectedVersion: 3, fileContentsBase64: base64('third'), fileId: file.id, note: '' })).unchanged, true);

    await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('other'), fileDescription: '', fileName: 'other.txt', fileType: 'text/plain' });
    await assert.rejects(repository.saveFileVersion({ ...scope, expectedVersion: 3, fileContentsBase64: base64('fourth'), fileId: file.id, fileName: 'other.txt', note: '' }), (error) => error.statusCode === 409);

    const versions = await repository.listFileVersions({ fileId: file.id, tenantId });
    assert.deepEqual(versions.map((entry) => [entry.version, entry.current, entry.fileName, entry.uploadedBy.name]), [[3, true, 'sow-final.txt', 'Ada Admin'], [2, false, 'sow.txt', 'Ada Admin'], [1, false, 'sow.txt', 'Ada Admin']]);

    const restored = await repository.restoreFileVersion({ ...scope, expectedVersion: 3, fileId: file.id, version: 1 });
    assert.deepEqual([restored.file.version, restored.file.fileName, restored.file.versionNote], [4, 'sow.txt', 'Restored from version 1']);
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId })).bytes.toString(), 'first');

    // Links name their items as they are now.
    const linked = await repository.linkFile({ ...scope, fileId: file.id, targetId: story.id, targetType: 'story' });
    assert.deepEqual([linked.linked, linked.file.links.map((link) => [link.targetName, link.targetType])], [true, [['Invoices', 'story']]]);
    assert.equal((await repository.linkFile({ ...scope, fileId: file.id, targetId: story.id, targetType: 'story' })).linked, false);
    await assert.rejects(repository.linkFile({ ...scope, fileId: file.id, targetId: story.id, targetType: 'task' }), /Invalid file target/);
    const onStory = await repository.listFiles({ includeLinked: true, projectId, targetId: story.id, targetType: 'story', tenantId });
    assert.deepEqual(onStory.map((entry) => [entry.id, entry.projectId]), [[file.id, projectId]]);
    assert.equal((await repository.listFiles({ projectId, targetId: story.id, targetType: 'story', tenantId })).length, 0, 'other callers see only files uploaded there');
    const vault = await repository.listFiles({ includeLinked: true, projectId, ...vaultTarget, tenantId });
    assert.equal(vault.find((entry) => entry.id === file.id).links[0].targetId, story.id);

    const removed = await repository.unlinkFile({ ...scope, fileId: file.id, linkId: linked.file.links[0].id });
    assert.deepEqual(removed.file.links, []);
    await repository.linkFile({ ...scope, fileId: file.id, targetId: story.id, targetType: 'story' });

    const [logged] = await pool.execute("SELECT action, item_id AS itemId FROM project_change_log WHERE project_id = ? AND entity_type = 'file' AND entity_id = ? ORDER BY seq", [projectId, file.id]);
    assert.deepEqual(logged.map((row) => row.action), ['create', 'version', 'version', 'restore', 'link', 'unlink', 'link']);

    // An archive carries it all, and bringing it back over the project restores it.
    const archive = await repository.exportProjectArchiveData({ projectId, tenantId });
    assert.deepEqual([archive.files.length, archive.fileVersions.length, archive.fileLinks.length], [2, 3, 1]);
    assert.equal(archive.files.some((entry) => 'storage_key' in entry), false);
    assert.equal(archive.fileVersions.some((entry) => 'storage_key' in entry), false);
    const keysBefore = new Set(storage.objects.keys());
    const vaultFiles = new Map([...archive.files, ...archive.fileVersions].map((entry) => [entry.id, Buffer.from(entry.contentsBase64, 'base64')]));
    await repository.importProjectArchiveData({ archiveData: JSON.parse(JSON.stringify(archive)), overwriteMode: 'project', tenantId, user, userMappings: [{ sourceUserId: userId, targetUserId: userId }], vaultFiles });
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId })).bytes.toString(), 'first');
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId, version: 3 })).bytes.toString(), 'third');
    assert.equal((await repository.listFiles({ includeLinked: true, projectId, targetId: story.id, targetType: 'story', tenantId })).length, 1);
    const [importedKeys] = await pool.execute('SELECT id, storage_key FROM file_versions WHERE file_id = ?', [file.id]);
    assert.equal(importedKeys.some((row) => keysBefore.has(row.storage_key)), false, 'an import makes its own storage keys');
    assert.ok(importedKeys.every((row) => row.id === row.storage_key));

    // A link only names items in its own project.
    const otherProject = randomUUID();
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [otherProject, tenantId, 'Other', '', statuses[0].id]);
    const [{ item: foreign }] = [await repository.createProjectItem({ input: { item: { name: 'Elsewhere' }, itemType: 'epic', parentId: null }, projectId: otherProject, tenantId, user })];
    await pool.execute('INSERT INTO file_links (id, tenant_id, project_id, file_id, target_type, target_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))', [randomUUID(), tenantId, projectId, file.id, 'epic', foreign.id, userId]);
    assert.equal((await repository.getFileRecord({ fileId: file.id, tenantId })).links.some((link) => link.targetName === 'Elsewhere'), false);
    assert.equal((await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('first'), fileDescription: '', fileName: 'sow.txt', fileType: 'text/plain' })).unchanged, true);

    // Two files renamed to one name at once: exactly one gets it.
    const racerA = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('a'), fileDescription: '', fileName: 'race-a.txt', fileType: 'text/plain' });
    const racerB = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('b'), fileDescription: '', fileName: 'race-b.txt', fileType: 'text/plain' });
    const race = (file, contents) => repository.saveFileVersion({ ...scope, expectedVersion: 1, fileContentsBase64: base64(contents), fileId: file.id, fileName: 'final.txt', fileType: 'text/plain', note: '' });
    const raced = await Promise.allSettled([race(racerA, 'a2'), race(racerB, 'b2')]);
    assert.deepEqual(raced.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(raced.find((result) => result.status === 'rejected').reason.statusCode, 409);
    const [named] = await pool.execute("SELECT id FROM file_vault WHERE tenant_id = ? AND target_id = ? AND file_name = 'final.txt'", [tenantId, projectId]);
    assert.equal(named.length, 1);

    // A rejected overwrite leaves every object where it was.
    const before = new Map(storage.objects);
    const fresh = await repository.exportProjectArchiveData({ projectId, tenantId });
    const freshFiles = new Map([...fresh.files, ...fresh.fileVersions].map((entry) => [entry.id, Buffer.from(entry.contentsBase64, 'base64')]));
    const broken = JSON.parse(JSON.stringify(fresh));
    broken.fileVersions[0].file_id = randomUUID();
    await assert.rejects(repository.importProjectArchiveData({ archiveData: broken, overwriteMode: 'project', tenantId, user, userMappings: [{ sourceUserId: userId, targetUserId: userId }], vaultFiles: freshFiles }), /without its file/);
    const late = JSON.parse(JSON.stringify(fresh));
    late.summaryDocuments = [{ entity_id: 'x' }];
    await assert.rejects(repository.importProjectArchiveData({ archiveData: late, overwriteMode: 'project', tenantId, user, userMappings: [{ sourceUserId: userId, targetUserId: userId }], vaultFiles: freshFiles }));
    for (const [key, bytes] of before) assert.deepEqual(storage.objects.get(key), bytes, 'a failed import deletes nothing');
    assert.equal((await repository.getFileAsset({ fileId: file.id, tenantId })).bytes.toString(), 'first');

    // Before rolling back to a release that reads bytes by file id: current contents under the
    // id, earlier versions clear of it, and this release unaffected.
    const legacy = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('old one'), fileDescription: '', fileName: 'legacy.txt', fileType: 'text/plain' });
    await repository.saveFileVersion({ ...scope, expectedVersion: 1, fileContentsBase64: base64('new one'), fileId: legacy.id, fileName: 'legacy.txt', fileType: 'text/plain', note: '' });
    assert.equal(storage.objects.get(legacy.id).toString(), 'old one');
    const dry = await prepareFilesForRollback({ dryRun: true, pool, storage });
    assert.ok(dry.files > 0);
    assert.equal(storage.objects.get(legacy.id).toString(), 'old one', 'a dry run moves nothing');
    await prepareFilesForRollback({ pool, storage });
    assert.equal(storage.objects.get(legacy.id).toString(), 'new one', 'what an older release reads is the current version');
    storage.objects.set(legacy.id, Buffer.from('written by the older release'));
    assert.equal((await repository.getFileAsset({ fileId: legacy.id, tenantId, version: 1 })).bytes.toString(), 'old one', 'its writes cannot reach history');
    assert.equal((await repository.getFileAsset({ fileId: legacy.id, tenantId })).bytes.toString(), 'written by the older release');
    assert.deepEqual(await prepareFilesForRollback({ pool, storage }), { currentMoved: 0, files: 0, versionsMoved: 0 }, 'a second run finds nothing to do');

    // Storage writes don't roll back: wherever the job stops, every version still reads true.
    const fragile = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('v1 bytes'), fileDescription: '', fileName: 'fragile.txt', fileType: 'text/plain' });
    await repository.saveFileVersion({ ...scope, expectedVersion: 1, fileContentsBase64: base64('v2 bytes'), fileId: fragile.id, fileName: 'fragile.txt', fileType: 'text/plain', note: '' });
    const failing = {
      delete: (key) => storage.delete(key),
      read: (key) => storage.read(key),
      // The write lands, then the step fails, as a lost connection would after it.
      async write(key, bytes) {
        await storage.write(key, bytes);
        if (key === fragile.id) throw new Error('Lost the connection.');
      },
    };
    await assert.rejects(prepareFilesForRollback({ pool, storage: failing }), /Lost the connection/);
    assert.equal((await repository.getFileAsset({ fileId: fragile.id, tenantId, version: 1 })).bytes.toString(), 'v1 bytes');
    assert.equal((await repository.getFileAsset({ fileId: fragile.id, tenantId })).bytes.toString(), 'v2 bytes');
    await prepareFilesForRollback({ pool, storage });
    assert.equal((await repository.getFileAsset({ fileId: fragile.id, tenantId, version: 1 })).bytes.toString(), 'v1 bytes', 'running it again keeps history');
    assert.equal(storage.objects.get(fragile.id).toString(), 'v2 bytes');

    // An upload arriving while the job works on a file waits for it, and nothing is lost.
    const busy = await repository.saveFile({ ...scope, ...vaultTarget, fileContentsBase64: base64('one'), fileDescription: '', fileName: 'busy.txt', fileType: 'text/plain' });
    const busyTwo = await repository.saveFileVersion({ ...scope, expectedVersion: 1, fileContentsBase64: base64('two'), fileId: busy.id, fileName: 'busy.txt', fileType: 'text/plain', note: '' });
    let upload = null;
    const racing = {
      ...storage,
      delete: (key) => storage.delete(key),
      async read(key) {
        upload ??= repository.saveFileVersion({ ...scope, expectedVersion: busyTwo.file.version, fileContentsBase64: base64('three'), fileId: busy.id, fileName: 'busy.txt', fileType: 'text/plain', note: '' });
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        return storage.read(key);
      },
      write: (key, bytes) => storage.write(key, bytes),
    };
    await prepareFilesForRollback({ pool, storage: racing });
    assert.equal((await upload).file.version, 3);
    assert.equal((await repository.getFileAsset({ fileId: busy.id, tenantId })).bytes.toString(), 'three', 'the upload that came during the job is the current version');
    assert.equal((await repository.getFileAsset({ fileId: busy.id, tenantId, version: 2 })).bytes.toString(), 'two');
    assert.equal((await repository.getFileAsset({ fileId: busy.id, tenantId, version: 1 })).bytes.toString(), 'one');
    // Whichever step it landed in, one more run leaves nothing to do, and what an older release
    // would read is the upload.
    await prepareFilesForRollback({ pool, storage });
    assert.equal((await prepareFilesForRollback({ dryRun: true, pool, storage })).files, 0);
    assert.equal(storage.objects.get(busy.id).toString(), 'three');

    // A project overwrite and an upload meet in one lock order: one waits, neither deadlocks.
    const snapshot = await repository.exportProjectArchiveData({ projectId, tenantId });
    const snapshotFiles = new Map([...snapshot.files, ...snapshot.fileVersions].map((entry) => [entry.id, Buffer.from(entry.contentsBase64, 'base64')]));
    const overlapping = await Promise.allSettled([
      repository.importProjectArchiveData({ archiveData: JSON.parse(JSON.stringify(snapshot)), overwriteMode: 'project', tenantId, user, userMappings: [{ sourceUserId: userId, targetUserId: userId }], vaultFiles: snapshotFiles }),
      repository.saveFileVersion({ ...scope, expectedVersion: 3, fileContentsBase64: base64('four'), fileId: busy.id, fileName: 'busy.txt', fileType: 'text/plain', note: '' }),
    ]);
    assert.equal(overlapping.some((result) => result.status === 'rejected' && result.reason?.code === 'ER_LOCK_DEADLOCK'), false, JSON.stringify(overlapping.map((result) => result.reason?.code ?? result.status)));

    // Deleting takes every object, version and link.
    await repository.deleteFile({ fileId: file.id, tenantId, user });
    assert.equal(await repository.getFileRecord({ fileId: file.id, tenantId }), null);
    const [versionRows] = await pool.execute('SELECT id FROM file_versions WHERE file_id = ?', [file.id]);
    const [linkRows] = await pool.execute('SELECT id FROM file_links WHERE file_id = ?', [file.id]);
    assert.deepEqual([versionRows.length, linkRows.length, storage.objects.has(file.id)], [0, 0, false]);
    const [remaining] = await pool.execute('SELECT id, storage_key AS storageKey FROM file_vault WHERE tenant_id = ?', [tenantId]);
    const [remainingVersions] = await pool.execute('SELECT storage_key AS storageKey FROM file_versions WHERE tenant_id = ?', [tenantId]);
    assert.deepEqual([...storage.objects.keys()].sort(), [...new Set([...remaining.map((row) => row.storageKey ?? row.id), ...remainingVersions.map((row) => row.storageKey)])].sort(), 'only what rows hold is left');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
