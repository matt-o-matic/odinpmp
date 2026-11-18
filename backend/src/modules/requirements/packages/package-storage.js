import { createHash } from 'node:crypto';

// Package files go through the same object storage interface as the vault (file-storage.js),
// whose ids are single path segments. Each file is stored as
// `review-package-<packageId>-<sha256(path)>`; the review_package_files index maps the
// package path to that key. server.js gives packages their own storage namespace
// (`review-packages`), so in S3 the objects sit under <prefix>/review-packages/.

export function packageStorageKey(packageId, path) {
  return `review-package-${packageId}-${createHash('sha256').update(String(path), 'utf8').digest('hex')}`;
}

export function createInMemoryObjectStorage() {
  const objects = new Map();
  return {
    objects,
    async delete(key) {
      objects.delete(key);
    },
    async read(key) {
      const bytes = objects.get(key);
      if (!bytes) {
        const error = new Error('Object not found.');
        error.code = 'ENOENT';
        throw error;
      }
      return { bytes: Buffer.from(bytes), size: bytes.length };
    },
    async write(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
  };
}

export function isMissingObjectError(error) {
  return error?.code === 'ENOENT'
    || error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.$metadata?.httpStatusCode === 404;
}

/** Runs `task` over `items` with at most `limit` in flight. */
export async function eachLimited(items, limit, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await task(queue.shift());
    }
  });
  await Promise.all(workers);
}
