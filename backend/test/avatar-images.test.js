import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';

test('uploaded avatars are served from object storage at their saved picture URL', async () => {
  const objects = new Map();
  const avatarStorage = {
    async read(fileName) {
      if (!objects.has(fileName)) {
        const error = new Error('Object not found');
        error.name = 'NoSuchKey';
        throw error;
      }
      return { bytes: objects.get(fileName) };
    },
    async write(fileName, bytes) {
      objects.set(fileName, Buffer.from(bytes));
    },
  };
  const app = createApp({ assistantStaleRunSweepIntervalMs: 0, avatarStorage });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await avatarStorage.write('user-1.png', bytes);

  const response = await request(app).get('/images/users/user-1.png');

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body, bytes);
  assert.equal((await request(app).get('/images/users/missing.png')).status, 404);
  assert.equal((await request(app).get('/images/users/invalid.svg')).status, 404);
});

test('uploaded avatars remain available from local storage', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'odin-avatar-test-'));

  try {
    const avatarStorage = createLocalFileStorage({ rootDir });
    const bytes = Buffer.from('local avatar bytes');
    await avatarStorage.write('user-2.jpg', bytes);
    const app = createApp({ assistantStaleRunSweepIntervalMs: 0, avatarStorage });

    const response = await request(app).get('/images/users/user-2.jpg');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.deepEqual(response.body, bytes);
    assert.equal((await request(app).get('/images/users/missing.jpg')).status, 404);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});
