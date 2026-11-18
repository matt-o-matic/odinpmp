import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// The MySQL side of renaming and moving a file in the project's file tree (docs/engagements/
// plan.md, Folders): projects.repository.js moveFile, its name check in the destination folder,
// and the change log entry. file-tree.test.js covers the routes and tools in memory.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const base64 = (text) => Buffer.from(text).toString('base64');

test('MySQL: a file renames and moves between folders, channels and the project, with its name taken per folder', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_filetree_${process.pid}`;
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
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'File Tree Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [ada.id, ada.name, `${ada.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Tree', '', statuses[0].id]);

    const repository = createMysqlProjectsRepository({ fileStorage: createMemoryLargeFileStorage(), pool });
    const general = await repository.ensureGeneralChannel({ projectId, tenantId, userId: ada.id });
    const design = await repository.createChannel({ name: 'Design', projectId, tenantId, user: ada });
    const contracts = await repository.createFolder({ channelId: general.id, name: 'Contracts', projectId, tenantId, user: ada });
    const save = (fileName, target) => repository.saveFile({ fileContentsBase64: base64(fileName), fileDescription: '', fileName, fileType: 'text/plain', projectId, tenantId, user: ada, ...target });
    const sow = await save('sow.txt', { targetId: general.id, targetType: 'channel' });
    await save('taken.txt', { folderId: contracts.id, targetId: general.id, targetType: 'channel' });
    const move = (changes) => repository.moveFile({ fileId: sow.id, fileName: 'sow.txt', folderId: null, projectId, targetId: general.id, targetType: 'channel', tenantId, user: ada, ...changes });

    const renamed = await move({ fileName: 'SOW final.txt' });
    assert.deepEqual([renamed.changed, renamed.file.id, renamed.file.fileName], [true, sow.id, 'SOW final.txt']);
    assert.equal((await move({ fileName: 'SOW final.txt' })).changed, false, 'the same place and name change nothing');
    await assert.rejects(move({ fileName: 'TAKEN.txt', folderId: contracts.id }), (error) => error.details?.code === 'file_exists', 'a name is taken within its folder, without regard to case');
    const inFolder = await move({ fileName: 'SOW final.txt', folderId: contracts.id });
    assert.deepEqual([inFolder.file.folderId, inFolder.file.targetId], [contracts.id, general.id]);
    const inDesign = await move({ fileName: 'SOW final.txt', targetId: design.id });
    assert.deepEqual([inDesign.file.folderId, inDesign.file.targetId, inDesign.file.targetType], [null, design.id, 'channel']);
    const atRoot = await move({ fileName: 'SOW final.txt', targetId: projectId, targetType: 'project' });
    assert.deepEqual([atRoot.file.targetId, atRoot.file.targetType, atRoot.file.folderId], [projectId, 'project', null]);
    await assert.rejects(move({ targetId: randomUUID() }), /Invalid file target/);
    assert.equal(await repository.moveFile({ fileId: randomUUID(), fileName: 'x.txt', projectId, targetId: projectId, targetType: 'project', tenantId, user: ada }), null);

    // The project's file list sees it where it is now, and the change log says where it was.
    const listed = (await repository.listFiles({ projectId, targetId: projectId, targetType: 'project', tenantId })).find((file) => file.id === sow.id);
    assert.deepEqual([listed.targetType, listed.fileName], ['project', 'SOW final.txt']);
    const [changes] = await pool.execute("SELECT action, detail_json AS detail FROM project_change_log WHERE entity_id = ? AND entity_type = 'file' ORDER BY seq", [sow.id]);
    const parsedDetail = (row) => (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail);
    assert.deepEqual(changes.map((row) => [row.action, parsedDetail(row).from?.targetType ?? null]), [['create', null], ['rename', 'channel'], ['move', 'channel'], ['move', 'channel'], ['move', 'channel']]);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
