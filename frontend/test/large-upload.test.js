import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forgetUpload,
  matchPendingUpload,
  PART_CONCURRENCY,
  readPendingUploads,
  rememberUpload,
  sendLargeUpload,
} from '../src/lib/projects/large-upload.js';
import { fileScanState, fileSizeLabel, isFileReady } from '../src/lib/projects/project-files.js';

// The browser side of large uploads (docs/engagements/plan.md, Upload): parts in parallel, a
// failed part retried, a resume after reload, and cancelling.

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

const fakeFile = (size, { lastModified = 1000, name = 'film.mp4' } = {}) => ({
  lastModified,
  name,
  size,
  slice: (start, end) => ({ end: Math.min(end, size), size: Math.min(end, size) - start, start }),
  type: 'video/mp4',
});

function fakeApi({ parts = [], partSize = 10, size, status = 'uploading' } = {}) {
  const calls = { signed: [], started: 0 };
  const upload = { expiresAt: new Date(Date.now() + 3600_000).toISOString(), id: 'upload-1', partCount: Math.ceil(size / partSize), partSize, size, status };
  return {
    calls,
    async getFileUpload() { return { upload: { ...upload, parts } }; },
    async signFileUploadParts(_projectId, _uploadId, numbers) {
      calls.signed.push(numbers);
      return { parts: numbers.map((partNumber) => ({ partNumber, url: `part-${partNumber}-${calls.signed.length}` })) };
    },
    async startFileUpload() { calls.started += 1; return { upload: { ...upload } }; },
  };
}

test('every part is sent, several at a time, and progress reaches the whole size', async () => {
  const api = fakeApi({ size: 95 });
  let active = 0;
  let peak = 0;
  const sent = [];
  const progress = [];
  const storage = memoryStorage();
  const upload = await sendLargeUpload({
    api,
    file: fakeFile(95),
    onProgress: ({ sentBytes }) => progress.push(sentBytes),
    projectId: 'p1',
    sendPart: async (url, blob, { onProgress }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      onProgress(blob.size);
      sent.push([url, blob.start, blob.size]);
      active -= 1;
    },
    start: { targetId: 'p1', targetType: 'project' },
    storage,
    token: 't',
  });
  assert.equal(upload.id, 'upload-1');
  assert.equal(sent.length, 10);
  assert.equal(peak, PART_CONCURRENCY);
  assert.deepEqual(sent.find(([url]) => url.startsWith('part-10-')).slice(1), [90, 5], 'the last part is the rest');
  assert.equal(progress.at(-1), 95);
  assert.equal(readPendingUploads('p1', { storage }).length, 1, 'kept until completed, for a resume');
});

test('a failed part is retried, and an expired link is signed again', async () => {
  const api = fakeApi({ size: 20 });
  const attempts = new Map();
  await sendLargeUpload({
    api,
    file: fakeFile(20),
    projectId: 'p1',
    sendPart: async (url) => {
      const partNumber = Number(url.split('-')[1]);
      attempts.set(partNumber, (attempts.get(partNumber) ?? 0) + 1);
      if (partNumber === 2 && attempts.get(2) === 1) throw Object.assign(new Error('dropped'), { status: 0 });
      if (partNumber === 2 && attempts.get(2) === 2) throw Object.assign(new Error('expired'), { status: 403 });
    },
    sleep: async () => {},
    start: { targetId: 'p1', targetType: 'project' },
    storage: memoryStorage(),
    token: 't',
  });
  assert.equal(attempts.get(2), 3);
  assert.equal(api.calls.signed.length, 2, 'the refused link was signed again');
});

test('a part that keeps failing stops the upload, which stays resumable', async () => {
  const storage = memoryStorage();
  await assert.rejects(sendLargeUpload({
    api: fakeApi({ size: 20 }),
    file: fakeFile(20),
    projectId: 'p1',
    sendPart: async () => { throw Object.assign(new Error('offline'), { status: 0 }); },
    sleep: async () => {},
    start: { targetId: 'p1', targetType: 'project' },
    storage,
    token: 't',
  }), (error) => error.code === 'part_failed');
  assert.equal(readPendingUploads('p1', { storage })[0].uploadId, 'upload-1');
});

test('after a reload the same file resumes, sending only the parts storage lacks', async () => {
  const storage = memoryStorage();
  const file = fakeFile(30);
  rememberUpload({ expiresAt: new Date(Date.now() + 3600_000).toISOString(), fileId: null, fileName: 'film.mp4', lastModified: 1000, projectId: 'p1', size: 30, startedAt: new Date().toISOString(), targetId: 'p1', targetType: 'project', uploadId: 'upload-1' }, { storage });
  const pending = readPendingUploads('p1', { storage });
  const resume = matchPendingUpload(pending, file, { targetId: 'p1', targetType: 'project' });
  assert.equal(resume.uploadId, 'upload-1');
  assert.equal(matchPendingUpload(pending, fakeFile(30, { lastModified: 2000 }), { targetId: 'p1', targetType: 'project' }), null, 'a different file starts afresh');
  assert.equal(matchPendingUpload(pending, file, { expectedVersion: 1, fileId: 'file-1' }), null, 'a new version of a file is a different upload');

  const api = fakeApi({ parts: [{ partNumber: 1, size: 10 }, { partNumber: 3, size: 10 }], size: 30 });
  const sent = [];
  const progress = [];
  await sendLargeUpload({ api, file, onProgress: ({ sentBytes }) => progress.push(sentBytes), projectId: 'p1', resume, sendPart: async (url) => { sent.push(url); }, start: { targetId: 'p1', targetType: 'project' }, storage, token: 't' });
  assert.equal(api.calls.started, 0, 'no new upload');
  assert.deepEqual(sent.map((url) => url.split('-')[1]), ['2']);
  assert.equal(progress[0], 20, 'progress starts from what arrived');
  forgetUpload('upload-1', { storage });
  assert.deepEqual(readPendingUploads('p1', { storage }), []);
});

test('an upload the server no longer has starts again', async () => {
  const api = fakeApi({ size: 10, status: 'expired' });
  const storage = memoryStorage();
  await sendLargeUpload({ api, file: fakeFile(10), projectId: 'p1', resume: { uploadId: 'old' }, sendPart: async () => {}, start: { targetId: 'p1', targetType: 'project' }, storage, token: 't' });
  assert.equal(api.calls.started, 1);
});

test('cancelling stops the parts in flight', async () => {
  const controller = new AbortController();
  const upload = sendLargeUpload({
    api: fakeApi({ size: 100 }),
    file: fakeFile(100),
    projectId: 'p1',
    sendPart: (_url, _blob, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    signal: controller.signal,
    start: { targetId: 'p1', targetType: 'project' },
    storage: memoryStorage(),
    token: 't',
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(upload, (error) => error.name === 'AbortError');
});

test('browser storage that throws leaves uploads working without resume', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readPendingUploads('p1', { storage: broken }), []);
  assert.doesNotThrow(() => rememberUpload({ uploadId: 'x' }, { storage: broken }));
});

test('scan states and sizes read as the files panel shows them', () => {
  assert.equal(fileScanState({ scanStatus: 'clean' }), null);
  assert.equal(fileScanState({}), null);
  assert.equal(fileScanState({ scanStatus: 'pending' }).label, 'Scanning');
  assert.equal(fileScanState({ scanStatus: 'infected' }).label, 'Virus found');
  assert.equal(isFileReady({ scanStatus: 'pending' }), false);
  assert.equal(isFileReady({}), true, 'files from before scanning moved are clean');
  assert.equal(fileSizeLabel(1_073_741_824), '1.00 GB');
});
