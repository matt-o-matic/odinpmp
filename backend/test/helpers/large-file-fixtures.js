import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { Readable } from 'node:stream';

// Test doubles for large files: object storage with multipart uploads held in memory, and a
// clamd that speaks INSTREAM and finds the EICAR test string.

/** Object storage in memory with the multipart and stream API of lib/files/file-storage.js. */
export function createMemoryLargeFileStorage() {
  const objects = new Map();
  const uploads = new Map();
  const calls = [];
  return {
    calls,
    kind: 'memory',
    objects,
    uploads,
    async delete(key) { calls.push(['delete', key]); objects.delete(key); },
    async purge(key) { calls.push(['purge', key]); objects.delete(key); },
    async read(key) {
      calls.push(['read', key]);
      if (!objects.has(key)) throw Object.assign(new Error(`No object ${key}`), { code: 'ENOENT' });
      return { bytes: objects.get(key), size: objects.get(key).length };
    },
    async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async writeStream(key, body) {
      calls.push(['writeStream', key]);
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    async stat(key) { return objects.has(key) ? { size: objects.get(key).length } : null; },
    async createReadStream(key, { end, start } = {}) {
      calls.push(['stream', key]);
      if (!objects.has(key)) throw Object.assign(new Error(`No object ${key}`), { code: 'ENOENT' });
      const bytes = objects.get(key);
      return { size: bytes.length, stream: Readable.from([bytes.subarray(start ?? 0, end == null ? bytes.length : end + 1)]) };
    },
    async createMultipartUpload(key) {
      const uploadId = randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    async writePart(key, uploadId, partNumber, body, { maxBytes = Infinity } = {}) {
      const upload = uploads.get(uploadId);
      if (!upload) throw Object.assign(new Error('No upload'), { code: 'upload_not_found' });
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error('Too large'), { code: 'part_too_large' });
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      upload.parts.set(partNumber, bytes);
      return { etag: `"${createHash('md5').update(bytes).digest('hex')}"`, size };
    },
    /** Puts a part straight in, as a browser does with a signed S3 URL. */
    putPart(uploadId, partNumber, bytes) {
      uploads.get(uploadId).parts.set(partNumber, Buffer.from(bytes));
    },
    async listParts(_key, uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) throw Object.assign(new Error('No upload'), { code: 'upload_not_found' });
      return [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([partNumber, bytes]) => ({ etag: null, partNumber, size: bytes.length }));
    },
    async completeMultipartUpload(key, uploadId, parts) {
      calls.push(['complete', key]);
      const upload = uploads.get(uploadId);
      const bytes = Buffer.concat(parts.map((part) => upload.parts.get(part.partNumber)));
      objects.set(key, bytes);
      uploads.delete(uploadId);
      return { size: bytes.length };
    },
    async abortMultipartUpload(key, uploadId) { calls.push(['abort', key]); uploads.delete(uploadId); },
  };
}

// Built from pieces so the source file itself is not the test virus.
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS', '-TEST-FILE!$H+H*'].join('');

/** A clamd on a loopback port: FOUND for anything holding the EICAR string, OK otherwise. */
export async function startFakeClamd({ port = 0 } = {}) {
  const scanned = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    const chunks = [];
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        commandRead = true;
        buffer = buffer.subarray(end + 1);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const body = Buffer.concat(chunks);
          scanned.push(body.length);
          socket.end(body.includes(Buffer.from(EICAR, 'latin1')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + length) return;
        chunks.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: server.address().port,
    scanned,
  };
}

/** A loopback port nothing listens on. */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
