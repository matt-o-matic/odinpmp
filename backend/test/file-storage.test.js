import assert from 'node:assert/strict';
import test from 'node:test';

import { createS3FileStorage } from '../src/lib/files/file-storage.js';

function fakeClient({ versioning = 'Enabled' } = {}) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      switch (command.constructor.name) {
        case 'GetBucketVersioningCommand':
          return { Status: versioning };
        case 'GetObjectLockConfigurationCommand':
          return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } };
        case 'PutObjectCommand':
          return { ETag: 'etag-write', VersionId: 'version-write' };
        case 'GetObjectCommand':
          return {
            Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) },
            ETag: 'etag-read',
            VersionId: 'version-read',
          };
        case 'HeadObjectCommand':
          return { ContentLength: 3, ETag: 'etag-read', VersionId: 'version-read' };
        case 'DeleteObjectCommand':
          return { DeleteMarker: true, VersionId: 'version-delete' };
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    },
  };
}

test('S3 object storage uses namespaced encrypted versioned objects', async () => {
  const client = fakeClient();
  const storage = createS3FileStorage({
    bucket: 'odin-test',
    client,
    prefix: '/tenant-assets/vault/',
    region: 'us-east-1',
  });

  assert.deepEqual(await storage.verify(), {
    bucket: 'odin-test',
    versioning: 'Enabled',
  });
  assert.deepEqual(await storage.verifyImmutable(), {
    bucket: 'odin-test',
    objectLock: 'Enabled',
  });
  assert.deepEqual(await storage.write('opaque-id', Buffer.from([1, 2, 3])), {
    etag: 'etag-write',
    versionId: 'version-write',
  });
  await storage.writeImmutable('evidence-id', Buffer.from([4, 5, 6]), {
    retainUntil: '2035-01-01T00:00:00.000Z',
  });
  assert.deepEqual(await storage.read('opaque-id'), {
    bytes: Buffer.from([1, 2, 3]),
    etag: 'etag-read',
    size: 3,
    versionId: 'version-read',
  });
  await storage.delete('opaque-id');

  const put = client.commands.find((command) => command.constructor.name === 'PutObjectCommand');
  assert.equal(put.input.Bucket, 'odin-test');
  assert.equal(put.input.Key, 'tenant-assets/vault/opaque-id');
  assert.equal(put.input.ServerSideEncryption, 'AES256');
  const immutable = client.commands.filter((command) => command.constructor.name === 'PutObjectCommand')[1];
  assert.equal(immutable.input.ObjectLockMode, 'COMPLIANCE');
  assert.equal(immutable.input.ObjectLockRetainUntilDate.toISOString(), '2035-01-01T00:00:00.000Z');
  assert.ok(client.commands.some((command) => command.constructor.name === 'DeleteObjectCommand'));
});

test('S3 object storage fails readiness without bucket versioning and rejects path keys', async () => {
  const storage = createS3FileStorage({
    bucket: 'odin-test',
    client: fakeClient({ versioning: 'Suspended' }),
    region: 'us-east-1',
  });
  await assert.rejects(storage.verify(), /versioning enabled/);
  await assert.rejects(storage.write('../secret', Buffer.from('x')), /opaque single-segment/);
});
