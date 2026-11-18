import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';

// A project exported from one workspace and imported into another on the same server. Record
// ids are unique across the server, so the import must come in as a copy with new ids, and it
// must never delete or change the first workspace's records, whatever overwrite it asks for.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

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

test('an archive from another workspace imports as a copy and leaves that workspace alone', { skip: !databaseUrl, timeout: 300_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_copy_${process.pid}`;
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

    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    const workspace = async (name) => {
      const tenantId = randomUUID();
      const user = { id: randomUUID(), name: `${name} Admin` };
      await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, name]);
      await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [user.id, user.name, `${user.id}@${name.toLowerCase()}.test`]);
      return { tenantId, user };
    };
    const source = await workspace('Source');
    const target = await workspace('Target');
    const storage = memoryStorage();
    const repository = createMysqlProjectsRepository({ fileStorage: storage, pool });

    // The source project: work items with their logs, a member, a sprint, a comment that links
    // to an item, a stakeholder with a portal token, and a file.
    const projectId = randomUUID();
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, source.tenantId, 'Payroll sync', '', statuses[0].id]);
    await pool.execute('INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())', [randomUUID(), source.user.id, projectId, 'admin']);
    const scope = { projectId, tenantId: source.tenantId, user: source.user };
    const create = async (itemType, parentId, name) => (await repository.createProjectItem({ ...scope, input: { item: { name }, itemType, parentId } })).item;
    const epic = await create('epic', null, 'Sync');
    const story = await create('story', epic.id, 'Map fields');
    await pool.execute('INSERT INTO project_sprints (id, project_id, name, goal, sprint_status, sort_order, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW(), 0)', [randomUUID(), projectId, 'Sprint 1', '', 'planned']);
    const link = `/app/projects/${projectId}/items/${story.id}`;
    await pool.execute('INSERT INTO comments (id, tenant_id, user_id, target_id, target_type, parent_id, comment, upvotes, downvotes, date_added, date_updated) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, NOW(), NOW())', [randomUUID(), source.tenantId, source.user.id, story.id, 'story', `See ${link}`]);
    const accessToken = randomUUID().replace(/-/g, '');
    await pool.execute('INSERT INTO project_stakeholders (id, tenant_id, project_id, name, email, role_title, access_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())', [randomUUID(), source.tenantId, projectId, 'Pat Client', 'pat@client.test', 'Sponsor', accessToken]);
    const file = await repository.saveFile({ ...scope, fileContentsBase64: Buffer.from('signed sow').toString('base64'), fileDescription: '', fileName: 'sow.txt', fileType: 'text/plain', targetId: projectId, targetType: 'project' });

    const sourceState = async () => {
      const count = async (sql, params) => Number((await pool.execute(sql, params))[0][0].n);
      return {
        comments: await count('SELECT COUNT(*) n FROM comments WHERE tenant_id = ?', [source.tenantId]),
        files: await count('SELECT COUNT(*) n FROM file_vault WHERE tenant_id = ?', [source.tenantId]),
        logs: await count('SELECT COUNT(*) n FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE t.project_id = ?', [projectId]),
        members: await count('SELECT COUNT(*) n FROM user_project WHERE project_id = ?', [projectId]),
        projects: await count('SELECT COUNT(*) n FROM projects WHERE tenant_id = ?', [source.tenantId]),
        sprints: await count('SELECT COUNT(*) n FROM project_sprints WHERE project_id = ?', [projectId]),
        stakeholders: await count('SELECT COUNT(*) n FROM project_stakeholders WHERE access_token = ?', [accessToken]),
        tasks: await count('SELECT COUNT(*) n FROM tasks WHERE project_id = ?', [projectId]),
      };
    };
    const before = await sourceState();
    assert.ok(before.logs > 0, 'creating items logs them');
    assert.deepEqual([before.tasks, before.members, before.sprints, before.comments, before.stakeholders, before.files], [2, 1, 1, 1, 1, 1]);

    const archive = await repository.exportProjectArchiveData({ projectId, tenantId: source.tenantId });
    const vaultFiles = () => new Map([...archive.files, ...(archive.fileVersions ?? [])].map((entry) => [entry.id, Buffer.from(entry.contentsBase64, 'base64')]));
    const importInto = (destination, archiveData, overwriteMode) => repository.importProjectArchiveData({
      archiveData: structuredClone(archiveData),
      overwriteMode,
      tenantId: destination.tenantId,
      user: destination.user,
      userMappings: [{ sourceUserId: source.user.id, targetUserId: destination.user.id }],
      vaultFiles: vaultFiles(),
    });

    // The import drawer offers a copy, with nothing to overwrite.
    const inspection = await repository.inspectProjectArchiveData({ archiveData: archive, tenantId: target.tenantId });
    assert.deepEqual([inspection.importsAsCopy, inspection.conflicts], [true, []]);

    // Even asked to overwrite everything, the import makes a copy.
    const copied = await importInto(target, archive, 'all');
    assert.equal(copied.copied, true);
    assert.notEqual(copied.importedProjectId, projectId);
    assert.deepEqual(await sourceState(), before, 'the source workspace keeps every record');

    const copyId = copied.importedProjectId;
    const [[copyRow]] = await pool.execute('SELECT tenant_id AS tenantId, name FROM projects WHERE id = ?', [copyId]);
    assert.deepEqual(copyRow, { name: 'Payroll sync', tenantId: target.tenantId });
    const [copyTasks] = await pool.execute('SELECT id, name, parent_task_id AS parentId FROM tasks WHERE project_id = ? ORDER BY name', [copyId]);
    assert.deepEqual(copyTasks.map((row) => row.name), ['Map fields', 'Sync']);
    assert.ok(copyTasks.every((row) => ![epic.id, story.id].includes(row.id)), 'work items get new ids');
    const copyStory = copyTasks.find((row) => row.name === 'Map fields');
    assert.equal(copyStory.parentId, copyTasks.find((row) => row.name === 'Sync').id, 'the hierarchy follows the new ids');
    const [[copyComment]] = await pool.execute('SELECT target_id AS targetId, comment FROM comments WHERE tenant_id = ?', [target.tenantId]);
    assert.deepEqual(copyComment, { comment: `See /app/projects/${copyId}/items/${copyStory.id}`, targetId: copyStory.id }, 'links in text point at the copy');
    const [[copyStakeholder]] = await pool.execute('SELECT access_token AS token FROM project_stakeholders WHERE project_id = ?', [copyId]);
    assert.notEqual(copyStakeholder.token, accessToken, 'the copy gets its own portal link');
    const [[copyFile]] = await pool.execute('SELECT id FROM file_vault WHERE tenant_id = ?', [target.tenantId]);
    assert.notEqual(copyFile.id, file.id);
    assert.equal((await repository.getFileAsset({ fileId: copyFile.id, tenantId: target.tenantId })).bytes.toString(), 'signed sow');
    const [[copyMembers]] = await pool.execute('SELECT COUNT(*) n FROM user_project WHERE project_id = ? AND user_id = ?', [copyId, target.user.id]);
    assert.equal(Number(copyMembers.n), 1);

    // A crafted archive with only a new project and the source's item ids, asking to overwrite
    // everything, still can't touch the source's records.
    const crafted = { project: { ...structuredClone(archive.project), id: randomUUID() } };
    assert.equal((await importInto(target, crafted, 'all')).copied, true);
    assert.deepEqual(await sourceState(), before);

    // Nor can one that reuses the source's project id.
    assert.equal((await importInto(target, archive, 'project')).copied, true);
    assert.deepEqual(await sourceState(), before);

    // Back into its own workspace, the archive is a conflict to resolve, as before.
    const ownInspection = await repository.inspectProjectArchiveData({ archiveData: archive, tenantId: source.tenantId });
    assert.equal(ownInspection.importsAsCopy, false);
    assert.ok(ownInspection.conflicts.some((conflict) => conflict.type === 'project' && conflict.id === projectId));
    assert.ok(ownInspection.conflicts.some((conflict) => conflict.type === 'task' && conflict.id === story.id));
    await assert.rejects(importInto(source, archive, 'none'), (error) => error.statusCode === 409);
    const restored = await importInto(source, archive, 'project');
    assert.deepEqual([restored.copied, restored.importedProjectId], [false, projectId]);
    assert.equal((await sourceState()).tasks, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
