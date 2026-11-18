import assert from 'node:assert/strict';
import test from 'node:test';

import { createHash } from 'node:crypto';

import { createChangeRecorder, snapshotVersions, undoChanges } from '../src/lib/agent/agent-changes.js';

const sameName = (left, right) => left.trim().toLowerCase() === right.trim().toLowerCase();

// A fake vault. With replaceByName, as in MySQL, a file saved under a name already on its target
// is saved over that file: its id and createdAt stay, its contents, signature and updatedAt
// change. Without, every upload is a new file, as records from before versions may show. The clock moves
// `tick` seconds a save.
function fakeVault({ replaceByName, tick = 1 }) {
  let clock = 0;
  let made = 0;
  const files = [];
  const log = [];
  const save = (body, userId = 'me') => {
    const at = new Date(Date.UTC(2026, 9, 1, 9, 0, clock)).toISOString();
    clock += tick;
    const bytes = Buffer.from(body.fileContentsBase64, 'base64');
    const contents = { contentType: body.fileType, description: body.fileDescription ?? '', fileSize: bytes.length, signature: createHash('md5').update(bytes).digest('hex'), updatedAt: at, uploadedBy: { id: userId, name: userId } };
    const existing = replaceByName && files.find((file) => file.targetType === body.targetType && file.targetId === body.targetId && sameName(file.fileName, body.fileName));
    if (existing) return Object.assign(existing, contents);
    made += 1;
    const file = { ...contents, createdAt: at, fileName: body.fileName, id: `file-${made}`, projectId: 'p1', targetId: body.targetId, targetType: body.targetType };
    files.push(file);
    return file;
  };
  const api = {
    async request(method, path, { body, query } = {}) {
      log.push(`${method} ${path}`);
      if (method === 'GET' && path === '/api/projects/p1/files') {
        const whole = query.targetType === 'project' && query.targetId === 'p1';
        return structuredClone({ files: files.filter((file) => whole || (file.targetType === query.targetType && file.targetId === query.targetId)), ok: true });
      }
      if (method === 'POST' && path === '/api/projects/p1/files') return structuredClone({ file: save(body), ok: true });
      const id = path.match(/^\/api\/files\/(.+)$/)?.[1];
      if (method === 'DELETE' && id) {
        const index = files.findIndex((file) => file.id === id);
        if (index < 0) throw Object.assign(new Error('not found'), { status: 404 });
        files.splice(index, 1);
        return { deletedFileId: id, ok: true };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  return { api, deletes: () => log.filter((entry) => entry.startsWith('DELETE')), files, save };
}

test('a new version, a restore and a link are each undone, and a version someone added since is left alone', async () => {
  const log = [];
  let refuse = false;
  const stored = { createdAt: 'a', fileName: 'spec.md', id: 'f1', updatedAt: 'b', version: 2, links: [{ id: 'link-1', targetId: 'story-1', targetName: 'Checkout', targetType: 'story' }] };
  const api = {
    async request(method, path, { body } = {}) {
      log.push(`${method} ${path}`);
      if (path.endsWith('/restore') && refuse) throw Object.assign(new Error('changed'), { status: 409 });
      if (method === 'GET') return { files: [stored], ok: true };
      if (path.endsWith('/links') && method === 'POST') return { file: stored, linked: true, ok: true };
      return { file: stored, ok: true, unchanged: false };
    },
  };
  const recorder = createChangeRecorder({ api });
  await recorder.api.request('POST', '/api/projects/p1/files/f1/versions', { body: { expectedVersion: 1 } });
  await recorder.api.request('POST', '/api/projects/p1/files/f1/versions/1/restore', { body: { expectedVersion: 2 } });
  await recorder.api.request('POST', '/api/projects/p1/files/f1/links', { body: { targetId: 'story-1', targetType: 'story' } });
  await recorder.api.request('DELETE', '/api/projects/p1/files/f1/links/link-1');
  const records = recorder.records();
  assert.deepEqual(records.map((record) => record.label), ['Uploaded version 2 of "spec.md"', 'Restored "spec.md" to version 1', 'Linked "spec.md" to "Checkout"', 'Unlinked "spec.md" from "Checkout"']);
  assert.deepEqual(records.map((record) => record.undo?.kind), ['restore_file_version', 'restore_file_version', 'unlink_file', 'link_file']);
  assert.deepEqual(records[0].undo, { expectedVersion: 2, fileId: 'f1', kind: 'restore_file_version', projectId: 'p1', version: 1 });

  const undone = await undoChanges({ api, changes: { records: records.slice(2), status: 'applied', versions: {} } });
  assert.deepEqual(undone.records.map((record) => record.status), ['undone', 'undone']);
  assert.ok(log.includes('POST /api/projects/p1/files/f1/links') && log.includes('DELETE /api/projects/p1/files/f1/links/link-1'));

  refuse = true;
  const left = await undoChanges({ api, changes: { records: records.slice(0, 1), status: 'applied', versions: {} } });
  assert.deepEqual(left.records.map((record) => [record.status, record.note]), [['kept', 'Changed since, so it was left as it is.']]);
});

// A vault that keeps versions as Odin does, for undoing them.
function versionedVault(start) {
  const file = { createdAt: 'a', fileName: 'spec.md', id: 'f1', updatedAt: 'a', contents: start, version: 1, history: { 1: start } };
  const view = () => ({ createdAt: file.createdAt, fileName: file.fileName, fileSize: file.contents.length, id: file.id, signature: file.contents, updatedAt: file.updatedAt, version: file.version });
  const add = (contents) => { file.version += 1; file.contents = contents; file.history[file.version] = contents; file.updatedAt = `t${file.version}`; };
  const api = {
    async request(method, path, { body } = {}) {
      if (method === 'GET') return { files: file.gone ? [] : [view()], ok: true };
      if (method === 'DELETE') { file.gone = true; return { ok: true }; }
      const restore = path.match(/versions\/(\d+)\/restore$/);
      if (body?.expectedVersion !== undefined && body.expectedVersion !== file.version) throw Object.assign(new Error('changed'), { status: 409 });
      if (restore) { add(file.history[restore[1]]); return { file: view(), ok: true, unchanged: false }; }
      if (body.contents === file.contents) return { file: { ...view(), unchanged: true }, ok: true, unchanged: true };
      add(body.contents);
      return { file: view(), ok: true, unchanged: false };
    },
  };
  return { add, api, file };
}

async function versionTurn(vault, writes) {
  const recorder = createChangeRecorder({ api: vault.api });
  for (const contents of writes) await recorder.api.request('POST', '/api/projects/p1/files/f1/versions', { body: { contents, expectedVersion: vault.file.version } });
  const records = recorder.records();
  return { records, status: 'applied', versions: await snapshotVersions({ api: vault.api, records }) };
}

test('undoing an upload of the same contents leaves the file alone', async () => {
  const vault = versionedVault('v1');
  vault.add('theirs');
  const changes = await versionTurn(vault, ['theirs']);
  assert.equal(changes.records[0].undoable, false);
  const undone = await undoChanges({ api: vault.api, changes });
  assert.deepEqual([undone.records[0].status, vault.file.contents, vault.file.version], ['not_undoable', 'theirs', 2]);

  const replaced = createChangeRecorder({ api: { async request() { return { file: { createdAt: 'a', fileName: 'spec.md', id: 'f1', unchanged: true, updatedAt: 'b', version: 2 }, ok: true }; } } });
  await replaced.api.request('POST', '/api/projects/p1/files', { body: upload('spec.md', 'theirs') });
  assert.equal(replaced.records()[0].undo, undefined, 'no version was added, so none is taken back');
});

test('two versions in one turn both undo, back to what was there', async () => {
  const vault = versionedVault('v1');
  const changes = await versionTurn(vault, ['two', 'three']);
  const undone = await undoChanges({ api: vault.api, changes });
  assert.deepEqual(undone.records.map((record) => record.status), ['undone', 'undone']);
  assert.equal(vault.file.contents, 'v1');
  assert.deepEqual(Object.values(vault.file.history), ['v1', 'two', 'three', 'two', 'v1'], 'undoing adds versions and loses none');
});

test('a version someone added between two of the turn\'s is never taken back', async () => {
  const vault = versionedVault('v1');
  const recorder = createChangeRecorder({ api: vault.api });
  await recorder.api.request('POST', '/api/projects/p1/files/f1/versions', { body: { contents: 'ours one', expectedVersion: 1 } });
  vault.add('theirs');
  await recorder.api.request('POST', '/api/projects/p1/files/f1/versions', { body: { contents: 'ours two', expectedVersion: 3 } });
  const records = recorder.records();
  const undone = await undoChanges({ api: vault.api, changes: { records, status: 'applied', versions: await snapshotVersions({ api: vault.api, records }) } });
  assert.deepEqual(undone.records.map((record) => record.status), ['kept', 'undone']);
  assert.equal(vault.file.contents, 'theirs');
});

test('a version someone added after the turn stops the undo', async () => {
  const vault = versionedVault('v1');
  const changes = await versionTurn(vault, ['two', 'three']);
  vault.add('theirs');
  const undone = await undoChanges({ api: vault.api, changes });
  assert.deepEqual(undone.records.map((record) => record.status), ['kept', 'kept']);
  assert.equal(vault.file.contents, 'theirs');
});

test('a file the turn created and then versioned goes altogether on undo', async () => {
  const vault = versionedVault('v1');
  const created = { fileName: 'spec.md', id: 'f1', createdAt: 'a', updatedAt: 'a', fileSize: 2, signature: 'v1', version: 1 };
  const api = { async request(method, path, options) { if (method === 'POST' && path.endsWith('/files')) return { file: created, ok: true }; if (method === 'GET' && !recorded) return { files: [], ok: true }; return vault.api.request(method, path, options); } };
  let recorded = false;
  const turn = createChangeRecorder({ api });
  await turn.api.request('POST', '/api/projects/p1/files', { body: upload('spec.md', 'v1') });
  recorded = true;
  await turn.api.request('POST', '/api/projects/p1/files/f1/versions', { body: { contents: 'two', expectedVersion: 1 } });
  const records = turn.records();
  assert.deepEqual(records.map((record) => record.undo?.kind), ['delete_file', 'restore_file_version']);
  const undone = await undoChanges({ api, changes: { records, status: 'applied', versions: await snapshotVersions({ api, records }) } });
  assert.deepEqual(undone.records.map((record) => record.status), ['undone', 'undone']);
  assert.equal(vault.file.gone, true);
});

const upload = (fileName, text, { targetId = 'p1', targetType = 'project' } = {}) => ({ fileContentsBase64: Buffer.from(text).toString('base64'), fileDescription: '', fileName, fileType: 'text/markdown', targetId, targetType });

async function turn(api, uploads) {
  const recorder = createChangeRecorder({ api });
  for (const body of uploads) await recorder.api.request('POST', '/api/projects/p1/files', { body });
  const records = recorder.records();
  return { records, status: 'applied', versions: await snapshotVersions({ api, records }) };
}

// Runs `edit` once, right after the first read of the project's files through this client.
function editAfterRead(api, edit) {
  let pending = edit;
  return {
    async request(method, path, options) {
      const result = await api.request(method, path, options);
      if (pending && method === 'GET' && path === '/api/projects/p1/files') {
        pending();
        pending = null;
      }
      return result;
    },
  };
}

test('a file an upload saved over is never deleted on undo', async () => {
  const vault = fakeVault({ replaceByName: true });
  vault.save(upload('Spec.md', 'theirs'), 'pat');
  const changes = await turn(vault.api, [upload(' spec.md', 'ours, longer')]);
  assert.deepEqual(changes.records.map((record) => [record.label, record.undoable]), [['Replaced file "Spec.md" with a new upload', false]]);
  const undone = await undoChanges({ api: vault.api, changes });
  assert.deepEqual(undone.records.map((record) => record.status), ['not_undoable']);
  assert.deepEqual(vault.deletes(), []);
  assert.deepEqual(vault.files.map((file) => file.id), ['file-1']);
});

test('an upload that saved over a file someone added after the check is not undoable either', async () => {
  const vault = fakeVault({ replaceByName: true });
  // The name is free when the recorder looks; someone uploads it before the assistant's lands.
  const changes = await turn(editAfterRead(vault.api, () => vault.save(upload('notes.md', 'theirs'), 'pat')), [upload('notes.md', 'ours')]);
  assert.deepEqual(changes.records.map((record) => [record.label, record.undoable]), [['Replaced file "notes.md" with a new upload', false]]);
  await undoChanges({ api: vault.api, changes });
  assert.deepEqual(vault.deletes(), []);
});

for (const replaceByName of [true, false]) {
  const vaultKind = replaceByName ? 'a vault that saves over by name' : 'a vault that keeps every upload';

  test(`a new upload is deleted on undo, in ${vaultKind}`, async () => {
    const vault = fakeVault({ replaceByName });
    vault.save(upload('spec.md', 'theirs'), 'pat');
    const changes = await turn(vault.api, [upload('notes.md', 'ours', { targetId: 'story-1', targetType: 'story' })]);
    assert.deepEqual(changes.records.map((record) => [record.label, record.undoable]), [['Uploaded "notes.md"', true]]);
    assert.deepEqual((await undoChanges({ api: vault.api, changes })).records.map((record) => record.status), ['undone']);
    assert.deepEqual(vault.files.map((file) => file.fileName), ['spec.md']);
  });

  test(`a file someone uploads under the same name after the turn stays on undo, in ${vaultKind}`, async () => {
    const vault = fakeVault({ replaceByName });
    const changes = await turn(vault.api, [upload('notes.md', 'ours')]);
    vault.save(upload('notes.md', 'theirs, longer'), 'pat');
    const undone = await undoChanges({ api: vault.api, changes });
    // Saved over, the assistant's file is now theirs; kept apart, only the assistant's goes.
    assert.deepEqual(undone.records.map((record) => [record.status, record.note ?? null]), [replaceByName ? ['kept', 'Changed since, so it was left as it is.'] : ['undone', null]]);
    assert.deepEqual(vault.files.map(({ fileSize, id }) => [id, fileSize]), replaceByName ? [['file-1', 14]] : [['file-2', 14]]);
  });
}

test('a file saved over between undo\'s check and its delete is left', async () => {
  const vault = fakeVault({ replaceByName: true });
  const changes = await turn(vault.api, [upload('notes.md', 'ours')]);
  const undone = await undoChanges({ api: editAfterRead(vault.api, () => vault.save(upload('notes.md', 'theirs'), 'pat')), changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note]), [['kept', 'Changed since, so it was left as it is.']]);
  assert.deepEqual(vault.deletes(), []);
  assert.equal(vault.files[0].uploadedBy.id, 'pat');
});

test('an upload recorded before uploads were told apart goes only if it was never saved over', async () => {
  const vault = fakeVault({ replaceByName: true });
  vault.save(upload('spec.md', 'theirs'), 'pat');
  vault.save(upload('spec.md', 'ours'));
  vault.save(upload('notes.md', 'ours'));
  const old = (id, fileId) => ({ id, label: 'Uploaded a file', status: 'applied', touches: [], undo: { fileId, kind: 'delete_file', projectId: 'p1' }, undoable: true });
  const undone = await undoChanges({ api: vault.api, changes: { records: [old('change-1', 'file-1'), old('change-2', 'file-2')], status: 'applied', versions: {} } });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note ?? null]), [['kept', 'It was saved over since it was first uploaded, so it was left as it is.'], ['undone', null]]);
  assert.deepEqual(vault.files.map((file) => file.fileName), ['spec.md']);
});

test('a file saved over in the same second, at the same size and name, is left on undo', async () => {
  // MySQL keeps updatedAt to the second, so only the contents' signature shows the new save.
  const vault = fakeVault({ replaceByName: true, tick: 0 });
  const changes = await turn(vault.api, [upload('notes.md', 'ours')]);
  vault.save(upload('notes.md', 'mine'));
  const undone = await undoChanges({ api: vault.api, changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note]), [['kept', 'Changed since, so it was left as it is.']]);
  assert.deepEqual(vault.deletes(), []);
});

test('an upload fingerprinted before files carried a signature is checked as it was', async () => {
  const vault = fakeVault({ replaceByName: true });
  const file = vault.save(upload('notes.md', 'ours'));
  const fingerprint = JSON.stringify({ contentType: file.contentType, description: file.description, fileName: file.fileName, fileSize: file.fileSize, updatedAt: file.updatedAt, uploadedBy: 'me' });
  const record = { id: 'change-1', label: 'Uploaded "notes.md"', status: 'applied', touches: [{ id: file.id, kind: 'file', projectId: 'p1' }], undo: { file: fingerprint, fileId: file.id, kind: 'delete_file', projectId: 'p1' }, undoable: true };
  const undone = await undoChanges({ api: vault.api, changes: { records: [record], status: 'applied', versions: { [`file:${file.id}`]: fingerprint } } });
  assert.deepEqual(undone.records.map((entry) => entry.status), ['undone']);
  assert.deepEqual(vault.files, []);
});
