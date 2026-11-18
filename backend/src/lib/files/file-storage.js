import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream as openReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function safeObjectId(value) {
  const objectId = String(value ?? '').trim();
  if (!objectId || objectId.includes('/') || objectId.includes('\\') || objectId === '.' || objectId === '..' || objectId.startsWith('.')) {
    throw new TypeError('Object storage ids must be opaque single-segment identifiers.');
  }
  return objectId;
}

function resolveFilePath(rootDir, fileId) {
  return path.join(rootDir, safeObjectId(fileId));
}

function storageError(code, message) {
  return Object.assign(new Error(message), { code });
}

const isMissing = (error) => error?.code === 'ENOENT' || error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

/**
 * A pass-through that counts bytes and hashes them, and fails once more than maxBytes pass.
 * The stream never holds more than one chunk.
 */
function measuringStream({ algorithm = 'md5', maxBytes = Infinity } = {}) {
  const hash = createHash(algorithm);
  let size = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(storageError('part_too_large', `This part is larger than ${maxBytes} bytes.`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { digest: () => hash.digest('hex'), size: () => size, stream };
}

/**
 * Objects on local disk, for development and tests. Multipart uploads keep each part in its own
 * file under .uploads/<uploadId>/ and join them on completion, all by streaming.
 */
export function createLocalFileStorage({ rootDir }) {
  async function ensureRoot() {
    await mkdir(rootDir, { recursive: true });
  }
  const uploadDir = (uploadId) => path.join(rootDir, '.uploads', safeObjectId(uploadId));
  const partPath = (uploadId, partNumber) => path.join(uploadDir(uploadId), String(Number(partNumber)));

  async function requireUpload(uploadId) {
    try {
      await stat(uploadDir(uploadId));
    } catch (error) {
      if (isMissing(error)) throw storageError('upload_not_found', 'That upload is not in storage.');
      throw error;
    }
  }

  async function listParts(_fileId, uploadId) {
    await requireUpload(uploadId);
    const names = (await readdir(uploadDir(uploadId))).filter((name) => /^[1-9]\d*$/.test(name));
    const parts = [];
    for (const name of names) {
      const info = await stat(path.join(uploadDir(uploadId), name));
      parts.push({ etag: null, partNumber: Number(name), size: info.size });
    }
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  return {
    kind: 'local',
    rootDir,
    async delete(fileId) {
      await ensureRoot();
      await rm(resolveFilePath(rootDir, fileId), {
        force: true,
      });
    },
    // Local disk keeps no earlier versions, so purging is deleting.
    async purge(fileId) {
      await this.delete(fileId);
    },
    async read(fileId) {
      await ensureRoot();
      const filePath = resolveFilePath(rootDir, fileId);
      const bytes = await readFile(filePath);
      const fileStat = await stat(filePath);

      return {
        bytes,
        size: fileStat.size,
      };
    },
    async write(fileId, bytes) {
      await ensureRoot();
      await writeFile(resolveFilePath(rootDir, fileId), bytes);
    },
    /** Streams an object to disk. It appears whole or not at all. */
    async writeStream(fileId, body) {
      await ensureRoot();
      const target = resolveFilePath(rootDir, fileId);
      const temporary = `${target}.${randomUUID()}.partial`;
      try {
        await pipeline(body, createWriteStream(temporary));
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    /** The object's size, or null when it is not there. */
    async stat(fileId) {
      try {
        return { size: (await stat(resolveFilePath(rootDir, fileId))).size };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    /** A stream of the object, or of the bytes start to end (inclusive) of it. */
    async createReadStream(fileId, { end, start } = {}) {
      const filePath = resolveFilePath(rootDir, fileId);
      const info = await stat(filePath);
      return { size: info.size, stream: openReadStream(filePath, { end, start }) };
    },
    async createMultipartUpload() {
      const uploadId = randomUUID();
      await mkdir(uploadDir(uploadId), { recursive: true });
      return { uploadId };
    },
    /** Streams one part to disk. A part over maxBytes is refused and leaves nothing behind. */
    async writePart(_fileId, uploadId, partNumber, body, { maxBytes = Infinity } = {}) {
      await requireUpload(uploadId);
      const target = partPath(uploadId, partNumber);
      const temporary = `${target}.${randomUUID()}.partial`;
      const measure = measuringStream({ maxBytes });
      try {
        await pipeline(body, measure.stream, createWriteStream(temporary));
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { etag: `"${measure.digest()}"`, size: measure.size() };
    },
    listParts,
    /** Joins the parts, in order, into the object, by streaming each in turn. */
    async completeMultipartUpload(fileId, uploadId, parts) {
      await ensureRoot();
      const target = resolveFilePath(rootDir, fileId);
      const temporary = `${target}.${randomUUID()}.partial`;
      const output = createWriteStream(temporary);
      const failed = new Promise((_resolve, reject) => output.once('error', reject));
      failed.catch(() => {});
      try {
        for (const part of [...parts].sort((left, right) => left.partNumber - right.partNumber)) {
          for await (const chunk of openReadStream(partPath(uploadId, part.partNumber))) {
            if (!output.write(chunk)) await Promise.race([once(output, 'drain'), failed]);
          }
        }
        await Promise.race([new Promise((resolve) => output.end(resolve)), failed]);
        await rename(temporary, target);
      } catch (error) {
        output.destroy();
        await rm(temporary, { force: true });
        throw error;
      }
      await rm(uploadDir(uploadId), { force: true, recursive: true });
      return { size: (await stat(target)).size };
    },
    async abortMultipartUpload(_fileId, uploadId) {
      await rm(uploadDir(uploadId), { force: true, recursive: true });
    },
  };
}

/** The storage the app was configured with, for one kind of object. */
export function createApplicationObjectStorage(env, { localRoot, namespace }) {
  if (env.objectStorageProvider === 's3') {
    return createS3FileStorage({
      bucket: env.objectStorageBucket,
      endpoint: env.objectStorageEndpoint,
      forcePathStyle: env.objectStorageForcePathStyle,
      prefix: `${env.objectStoragePrefix}/${namespace}`,
      publicEndpoint: env.objectStoragePublicEndpoint,
      region: env.objectStorageRegion,
    });
  }
  return createLocalFileStorage({ rootDir: localRoot });
}

export function createS3FileStorage({
  bucket,
  client = null,
  endpoint = '',
  forcePathStyle = false,
  prefix = '',
  // Where browsers reach the bucket, when that differs from where the server does (a MinIO
  // container, say). Signed URLs name this host.
  publicEndpoint = '',
  region,
  // Signs URLs. Defaults to a client that adds no checksum to what it signs, since a browser
  // sending a part or fetching a file sends none.
  signingClient = null,
} = {}) {
  if (!String(bucket ?? '').trim()) throw new TypeError('An object storage bucket is required.');
  if (!String(region ?? '').trim()) throw new TypeError('An object storage region is required.');
  const resolvedClient = client ?? new S3Client({
    endpoint: endpoint || undefined,
    forcePathStyle,
    region,
  });
  const presignClient = signingClient ?? (client && !publicEndpoint ? client : new S3Client({
    endpoint: publicEndpoint || endpoint || undefined,
    forcePathStyle,
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }));
  const normalizedPrefix = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
  const keyFor = (fileId) => [normalizedPrefix, safeObjectId(fileId)].filter(Boolean).join('/');

  async function listParts(fileId, uploadId) {
    const parts = [];
    let marker;
    for (;;) {
      let page;
      try {
        page = await resolvedClient.send(new ListPartsCommand({ Bucket: bucket, Key: keyFor(fileId), PartNumberMarker: marker, UploadId: uploadId }));
      } catch (error) {
        if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) throw storageError('upload_not_found', 'That upload is not in storage.');
        throw error;
      }
      for (const part of page.Parts ?? []) parts.push({ etag: part.ETag ?? null, partNumber: Number(part.PartNumber), size: Number(part.Size ?? 0) });
      if (!page.IsTruncated) break;
      marker = page.NextPartNumberMarker;
    }
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  return {
    bucket,
    kind: 's3',
    prefix: normalizedPrefix,
    region,
    async delete(fileId) {
      await resolvedClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(fileId) }));
    },
    // Every stored version of the object, not only the current one: the bucket keeps versions,
    // and an infected file must not stay in any of them.
    async purge(fileId) {
      const Key = keyFor(fileId);
      let KeyMarker;
      let VersionIdMarker;
      for (;;) {
        const page = await resolvedClient.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker, Prefix: Key, VersionIdMarker }));
        for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter((item) => item.Key === Key)) {
          await resolvedClient.send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId: entry.VersionId }));
        }
        if (!page.IsTruncated) break;
        KeyMarker = page.NextKeyMarker;
        VersionIdMarker = page.NextVersionIdMarker;
      }
      await resolvedClient.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
    },
    async read(fileId) {
      const Key = keyFor(fileId);
      const [object, metadata] = await Promise.all([
        resolvedClient.send(new GetObjectCommand({ Bucket: bucket, Key })),
        resolvedClient.send(new HeadObjectCommand({ Bucket: bucket, Key })),
      ]);
      const bytes = Buffer.from(await object.Body.transformToByteArray());
      return {
        bytes,
        etag: metadata.ETag ?? object.ETag ?? null,
        size: Number(metadata.ContentLength ?? bytes.length),
        versionId: object.VersionId ?? metadata.VersionId ?? null,
      };
    },
    async stat(fileId) {
      try {
        const metadata = await resolvedClient.send(new HeadObjectCommand({ Bucket: bucket, Key: keyFor(fileId) }));
        return { size: Number(metadata.ContentLength ?? 0) };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async createReadStream(fileId, { end, start } = {}) {
      const ranged = start != null || end != null;
      const object = await resolvedClient.send(new GetObjectCommand({
        Bucket: bucket,
        Key: keyFor(fileId),
        Range: ranged ? `bytes=${start ?? 0}-${end ?? ''}` : undefined,
      }));
      const total = ranged ? Number(String(object.ContentRange ?? '').split('/')[1] ?? object.ContentLength ?? 0) : Number(object.ContentLength ?? 0);
      return { size: total, stream: object.Body };
    },
    /** A URL that gets the object for expiresIn seconds, sent with this disposition and type. */
    async presignDownload(fileId, { contentDisposition, contentType, expiresIn = 300 } = {}) {
      return getSignedUrl(presignClient, new GetObjectCommand({
        Bucket: bucket,
        Key: keyFor(fileId),
        ResponseCacheControl: 'private, no-store',
        ResponseContentDisposition: contentDisposition,
        ResponseContentType: contentType,
      }), { expiresIn });
    },
    async createMultipartUpload(fileId, { contentType } = {}) {
      const result = await resolvedClient.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        ContentType: contentType || 'application/octet-stream',
        Key: keyFor(fileId),
        ServerSideEncryption: 'AES256',
      }));
      return { uploadId: result.UploadId };
    },
    /** A URL a browser PUTs one part to, for expiresIn seconds. */
    async presignUploadPart(fileId, uploadId, partNumber, { expiresIn = 3600 } = {}) {
      return getSignedUrl(presignClient, new UploadPartCommand({ Bucket: bucket, Key: keyFor(fileId), PartNumber: partNumber, UploadId: uploadId }), { expiresIn });
    },
    listParts,
    async completeMultipartUpload(fileId, uploadId, parts) {
      const Key = keyFor(fileId);
      await resolvedClient.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key,
        MultipartUpload: { Parts: [...parts].sort((left, right) => left.partNumber - right.partNumber).map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })) },
        UploadId: uploadId,
      }));
      const metadata = await resolvedClient.send(new HeadObjectCommand({ Bucket: bucket, Key }));
      return { size: Number(metadata.ContentLength ?? 0) };
    },
    async abortMultipartUpload(fileId, uploadId) {
      try {
        await resolvedClient.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: keyFor(fileId), UploadId: uploadId }));
      } catch (error) {
        if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) return;
        throw error;
      }
    },
    async verify() {
      const versioning = await resolvedClient.send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
      );
      if (versioning.Status !== 'Enabled') {
        throw new Error('The production object storage bucket must have versioning enabled.');
      }
      return { bucket, versioning: versioning.Status };
    },
    async verifyImmutable() {
      const configuration = await resolvedClient.send(
        new GetObjectLockConfigurationCommand({ Bucket: bucket }),
      );
      if (configuration.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
        throw new Error('The compliance object storage bucket must have Object Lock enabled.');
      }
      return { bucket, objectLock: 'Enabled' };
    },
    async write(fileId, bytes) {
      const result = await resolvedClient.send(new PutObjectCommand({
        Body: bytes,
        Bucket: bucket,
        Key: keyFor(fileId),
        ServerSideEncryption: 'AES256',
      }));
      return { etag: result.ETag ?? null, versionId: result.VersionId ?? null };
    },
    /** Streams an object of a known size to the bucket. */
    async writeStream(fileId, body, { contentType = 'application/octet-stream', size } = {}) {
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('A streamed object needs its size.');
      const result = await resolvedClient.send(new PutObjectCommand({
        Body: body,
        Bucket: bucket,
        ContentLength: size,
        ContentType: contentType,
        Key: keyFor(fileId),
        ServerSideEncryption: 'AES256',
      }));
      return { etag: result.ETag ?? null, versionId: result.VersionId ?? null };
    },
    async writeImmutable(fileId, bytes, { retainUntil }) {
      const retentionDate = new Date(retainUntil);
      if (!Number.isFinite(retentionDate.getTime()) || retentionDate <= new Date()) {
        throw new TypeError('Immutable object retention must end in the future.');
      }
      const result = await resolvedClient.send(new PutObjectCommand({
        Body: bytes,
        Bucket: bucket,
        Key: keyFor(fileId),
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retentionDate,
        ServerSideEncryption: 'AES256',
      }));
      return { etag: result.ETag ?? null, versionId: result.VersionId ?? null };
    },
  };
}

/** Whether a storage can take multipart uploads and stream objects. */
export const supportsLargeFiles = (storage) => Boolean(storage
  && typeof storage.createMultipartUpload === 'function'
  && typeof storage.listParts === 'function'
  && typeof storage.completeMultipartUpload === 'function'
  && typeof storage.createReadStream === 'function');
