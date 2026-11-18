import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreateBucketCommand, ListObjectVersionsCommand, PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';

import { createNoopFileScanner } from '../src/lib/files/file-scanner.js';
import { createS3FileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createFileScanProcessor } from '../src/modules/vault/file-scan-worker.js';
import {
  cancelUploadForUser,
  completeUploadForUser,
  getDownloadUrlForUser,
  getUploadForUser,
  signUploadPartsForUser,
  startUploadForUser,
} from '../src/modules/vault/large-files.service.js';

// Large files against real S3 multipart behavior, on MinIO. Skipped unless
// ODIN_TEST_S3_ENDPOINT names one, with its keys in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
//
//   docker run -d --name odin-minio -p 127.0.0.1:19000:9000 -e MINIO_ROOT_USER=odintest -e MINIO_ROOT_PASSWORD=<secret> minio/minio server /data
//   ODIN_TEST_S3_ENDPOINT=http://127.0.0.1:19000 AWS_ACCESS_KEY_ID=odintest AWS_SECRET_ACCESS_KEY=<secret> node --test test/large-files-s3.integration.test.js

const endpoint = String(process.env.ODIN_TEST_S3_ENDPOINT ?? '').trim();
const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const MiB = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function setup() {
  const bucket = `odin-large-${randomUUID().slice(0, 8)}`;
  const admin = new S3Client({ endpoint, forcePathStyle: true, region: 'us-east-1' });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  await admin.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  const storage = createS3FileStorage({ bucket, endpoint, forcePathStyle: true, prefix: 'odin-test/vault', region: 'us-east-1' });
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: [{ authMethod: 'basic', email: 'ada@acme.example', id: 'user-ada', memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Ada', password: 'Fixture-password-123!' }],
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, fileStorage: storage, seed: { projects: [{ epics: [], id: PROJECT, name: 'One', status: 'In Progress', tenantId: TENANT_ID }] } });
  const deps = { fileStorage: storage, projectRepository };
  const user = { id: 'user-ada', memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Ada' };
  return { admin, bucket, deps, projectRepository, storage, user };
}

test('S3 multipart: parts go to signed URLs, an upload resumes from ListParts, and the file downloads intact from a signed URL', { skip: !endpoint, timeout: 120_000 }, async () => {
  const { deps, projectRepository, user } = await setup();
  const bytes = randomBytes(17 * MiB + 5);
  const started = await startUploadForUser(deps, user, PROJECT, { contentType: 'video/mp4', fileName: 'film.mp4', fileSize: bytes.length, targetId: PROJECT, targetType: 'project' });
  const { id, partCount, partSize } = started.upload;
  assert.deepEqual([partCount, partSize], [3, 8 * MiB]);
  const { parts } = await signUploadPartsForUser(deps, user, PROJECT, id, { partNumbers: [1, 2, 3] });
  assert.match(parts[0].url, /X-Amz-Signature=/);
  assert.doesNotMatch(parts[0].url, /x-amz-checksum|x-amz-sdk-checksum/i, 'a browser sends no checksum, so none is signed');
  const put = async (part) => {
    const response = await fetch(part.url, { body: bytes.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize), method: 'PUT' });
    assert.equal(response.status, 200, await response.text());
    assert.ok(response.headers.get('etag'));
  };
  await put(parts[0]);
  await put(parts[2]);
  const resumed = await getUploadForUser(deps, user, PROJECT, id);
  assert.deepEqual(resumed.upload.parts, [{ partNumber: 1, size: 8 * MiB }, { partNumber: 3, size: MiB + 5 }]);
  await put(parts[1]);
  const { file } = await completeUploadForUser(deps, user, PROJECT, id, {});
  assert.deepEqual([file.fileSize, file.scanStatus], [bytes.length, 'pending']);
  await assert.rejects(getDownloadUrlForUser(deps, user, PROJECT, file.id), (error) => error.statusCode === 409);

  await createFileScanProcessor({ projectRepository, scanner: createNoopFileScanner(), storage: deps.fileStorage }).processBatch();
  const link = await getDownloadUrlForUser(deps, user, PROJECT, file.id, { inline: true });
  assert.match(link.url, /X-Amz-Expires=300/);
  const downloaded = await fetch(link.url);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /^inline; filename="film\.mp4"/);
  assert.equal(downloaded.headers.get('content-type'), 'video/mp4');
  assert.equal(sha256(Buffer.from(await downloaded.arrayBuffer())), sha256(bytes));
  assert.equal(link.sha256, sha256(bytes), 'the scan hashed what S3 holds');
  const ranged = await fetch(link.url, { headers: { Range: 'bytes=8388600-8388615' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(8388600, 8388616));
});

test('S3 multipart: a cancelled upload is aborted in S3, and purging removes every stored version', { skip: !endpoint, timeout: 120_000 }, async () => {
  const { admin, bucket, deps, storage, user } = await setup();
  const started = await startUploadForUser(deps, user, PROJECT, { fileName: 'drop.bin', fileSize: 6 * MiB, targetId: PROJECT, targetType: 'project' });
  const [part] = (await signUploadPartsForUser(deps, user, PROJECT, started.upload.id, { partNumbers: [1] })).parts;
  assert.equal((await fetch(part.url, { body: randomBytes(6 * MiB), method: 'PUT' })).status, 200);
  assert.equal((await cancelUploadForUser(deps, user, PROJECT, started.upload.id)).cancelled, true);
  const upload = await deps.projectRepository.getFileUpload({ tenantId: TENANT_ID, uploadId: started.upload.id });
  await assert.rejects(storage.listParts(upload.storageKey, upload.storageUploadId), (error) => error.code === 'upload_not_found');

  await storage.write('purge-me', Buffer.from('one'));
  await storage.write('purge-me', Buffer.from('two'));
  await storage.delete('purge-me');
  await storage.purge('purge-me');
  const versions = await admin.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: 'odin-test/vault/purge-me' }));
  assert.deepEqual([versions.Versions ?? [], versions.DeleteMarkers ?? []].map((list) => list.length), [0, 0]);
});
