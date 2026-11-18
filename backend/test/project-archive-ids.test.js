import assert from 'node:assert/strict';
import test from 'node:test';

import { archiveRecordIds, copyArchiveWithNewIds } from '../src/modules/projects/project-archive-ids.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const EPIC = '22222222-2222-4222-8222-222222222222';
const STORY = '33333333-3333-4333-8333-333333333333';
const FILE = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

function archive() {
  return {
    assistantProjectState: { stakeholders: [{ access_token: TOKEN, email: 'pat@client.test', id: 'stakeholder-1' }], [STORY]: { note: 'keyed by item' } },
    comments: [{ comment: `See /app/projects/${PROJECT}/items/${STORY}`, id: 'c-1', target_id: STORY, user_id: USER }],
    fileLinks: [{ file_id: FILE, target_id: STORY }],
    fileVersions: [{ file_id: FILE, id: 'version-1' }],
    files: [{ id: FILE, target_id: PROJECT }],
    project: { epics: [{ id: EPIC, name: 'Sync', sortOrder: 1, stories: [{ id: STORY, name: 'Map fields', parentId: EPIC }] }], id: PROJECT, name: 'Payroll sync' },
    stakeholders: [{ access_token: TOKEN, email: 'pat@client.test', id: 'stakeholder-1' }],
  };
}

test('the archive lists the ids of every record it creates', () => {
  const ids = archiveRecordIds(archive());
  assert.deepEqual(ids.get('project'), [PROJECT]);
  assert.deepEqual(ids.get('task'), [EPIC, STORY]);
  assert.deepEqual(ids.get('file'), [FILE]);
  assert.deepEqual(ids.get('stakeholder'), ['stakeholder-1']);
});

test('a copy gives records and tokens new values and keeps every reference pointing at the copy', () => {
  const original = archive();
  const vaultFiles = new Map([[FILE, Buffer.from('sow')], ['version-1', Buffer.from('v1')]]);
  const { archiveData: copy, vaultFiles: copiedFiles } = copyArchiveWithNewIds({ archiveData: original, vaultFiles });

  const project = copy.project.id; const epic = copy.project.epics[0].id; const story = copy.project.epics[0].stories[0].id; const file = copy.files[0].id;
  for (const [before, after] of [[PROJECT, project], [EPIC, epic], [STORY, story], [FILE, file]]) assert.notEqual(after, before);
  assert.equal(copy.project.epics[0].stories[0].parentId, epic);
  assert.deepEqual(copy.comments[0], { comment: `See /app/projects/${project}/items/${story}`, id: copy.comments[0].id, target_id: story, user_id: USER }, 'users stay; they are mapped separately');
  assert.deepEqual([copy.fileLinks[0].file_id, copy.fileLinks[0].target_id, copy.files[0].target_id, copy.fileVersions[0].file_id], [file, story, project, file]);
  assert.ok(copy.assistantProjectState[story], 'ids used as keys follow too');

  const token = copy.stakeholders[0].access_token;
  assert.notEqual(token, TOKEN);
  assert.equal(copy.assistantProjectState.stakeholders[0].access_token, token, 'one token gets one replacement everywhere');
  assert.equal(copy.stakeholders[0].id, copy.assistantProjectState.stakeholders[0].id);

  assert.deepEqual([...copiedFiles.keys()].sort(), [file, 'version-1'].sort(), 'file contents follow the new file id');
  assert.equal(copiedFiles.get(file).toString(), 'sow');
  assert.equal(original.project.id, PROJECT, 'the original archive is untouched');
});

test('a short id is replaced only where a value is exactly that id', () => {
  const { archiveData: copy } = copyArchiveWithNewIds({ archiveData: { comments: [{ comment: 'c-1 and c-10 are different', id: 'c-1' }], project: { epics: [], id: PROJECT } } });
  assert.notEqual(copy.comments[0].id, 'c-1');
  assert.equal(copy.comments[0].comment, 'c-1 and c-10 are different');
});

test('in memory, an archive from another workspace imports as a copy and leaves that workspace alone', async () => {
  const objects = new Map();
  const repository = createInMemoryProjectsRepository({
    // Seeded projects load only with a workspace and a user to own them.
    authRepository: { state: { tenants: [{ id: 'tenant-source' }], users: [{ id: 'user-source', name: 'Source Admin' }] } },
    fileStorage: {
      async delete(key) { objects.delete(key); },
      async read(key) { return { bytes: objects.get(key), size: objects.get(key).length }; },
      async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    },
    seed: {
      files: [{ contentType: 'text/plain', fileName: 'sow.txt', fileSize: 3, id: FILE, projectId: PROJECT, targetId: PROJECT, targetType: 'project', tenantId: 'tenant-source' }],
      projects: [{ epics: [{ id: EPIC, name: 'Sync', stories: [], type: 'epic' }], id: PROJECT, name: 'Payroll sync', role: 'admin', status: 'Planned', tenantId: 'tenant-source' }],
    },
  });
  const archiveData = { files: [{ contentType: 'text/plain', fileName: 'sow.txt', id: FILE, targetId: PROJECT, targetType: 'project' }], project: { epics: [{ id: EPIC, name: 'Sync', stories: [] }], id: PROJECT, name: 'Payroll sync', status: 'Planned' }, projectUsers: [] };
  const user = { email: 'admin@target.test', id: 'user-target', name: 'Target Admin' };

  const inspection = await repository.inspectProjectArchiveData({ archiveData, tenantId: 'tenant-target' });
  assert.deepEqual([inspection.importsAsCopy, inspection.conflicts], [true, []]);

  const result = await repository.importProjectArchiveData({ archiveData, overwriteMode: 'all', tenantId: 'tenant-target', user, userMappings: [], vaultFiles: new Map([[FILE, Buffer.from('sow')]]) });
  assert.equal(result.copied, true);
  assert.notEqual(result.importedProjectId, PROJECT);
  const sourceProject = await repository.getProjectDetail({ projectId: PROJECT, tenantId: 'tenant-source' });
  assert.deepEqual(sourceProject.epics.map((epic) => epic.id), [EPIC], 'the source project keeps its items');
  assert.equal((await repository.listFiles({ projectId: PROJECT, targetId: PROJECT, targetType: 'project', tenantId: 'tenant-source' })).length, 1, 'and its file');
  const copy = await repository.getProjectDetail({ projectId: result.importedProjectId, tenantId: 'tenant-target' });
  assert.equal(copy.epics.length, 1);
  assert.notEqual(copy.epics[0].id, EPIC);
  const [copiedFile] = await repository.listFiles({ projectId: copy.id, targetId: copy.id, targetType: 'project', tenantId: 'tenant-target' });
  assert.notEqual(copiedFile.id, FILE);
  assert.equal((await repository.getFileAsset({ fileId: copiedFile.id, tenantId: 'tenant-target' })).bytes.toString(), 'sow');
});
