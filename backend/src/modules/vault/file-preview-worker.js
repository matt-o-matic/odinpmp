import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { publishProjectChanged } from '../../lib/events/project-live-events.js';
import { DEFAULT_PREVIEW_MAX_BYTES, extensionOf, NO_PREVIEW, OFFICE_EXTENSIONS, previewStorageKeyFor } from '../../lib/files/file-preview.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';

// The preview worker. After a file's scan passes, it converts Word, Excel, PowerPoint and
// OpenDocument files up to maxBytes to PDF, one at a time, and records the PDF on every row that
// holds the object (lib/files/file-preview.js):
//
// - The source streams from storage to a temporary directory, LibreOffice converts it there
//   (lib/files/soffice-converter.js), and the PDF streams back to storage. The directory goes
//   afterwards, whatever happened.
// - A conversion that fails or times out records "no preview", and is not tried again.
// - A storage failure is tried again with backoff, up to maxAttempts, then records "no preview".
// - Without LibreOffice nothing is converted and nothing is recorded, so files convert once it is
//   installed (and the server restarted). The API then reports previews as unavailable.
//
// Each change publishes the project's live event, so an open files panel shows the preview.

const CONTENT_TYPE_EXTENSIONS = {
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/rtf': 'rtf',
};

// LibreOffice picks its import filter partly by extension, so the temporary copy keeps one.
function sourceExtension({ contentType, fileName }) {
  const extension = extensionOf(fileName);
  if (OFFICE_EXTENSIONS.includes(extension)) return extension;
  return CONTENT_TYPE_EXTENSIONS[String(contentType ?? '').split(';')[0].trim().toLowerCase()] ?? 'bin';
}

const isMissing = (error) => error?.code === 'ENOENT' || error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;

async function writePreview(storage, key, pdfPath) {
  const { size } = await stat(pdfPath);
  if (typeof storage.writeStream === 'function') {
    await storage.writeStream(key, createReadStream(pdfPath), { contentType: 'application/pdf', size });
  } else {
    await storage.write(key, await readFile(pdfPath));
  }
}

export function createFilePreviewProcessor({
  clock = () => new Date(),
  converter,
  liveEventBus = null,
  log = (message) => console.warn(message),
  maxAttempts = 3,
  maxBytes = DEFAULT_PREVIEW_MAX_BYTES,
  projectRepository,
  storage,
  tempRoot = os.tmpdir(),
} = {}) {
  const retries = new Map();
  let warnedUnavailable = false;
  let warnedIsolation = false;

  const backoff = (attempt) => Math.min(10 * 60_000, 30_000 * (2 ** Math.max(0, attempt - 1)));

  async function record(storageKey, previewStorageKey) {
    const touched = await projectRepository.recordObjectPreview({ previewStorageKey, storageKey });
    for (const projectId of new Set(touched.map((entry) => entry.projectId))) {
      publishProjectChanged(liveEventBus, projectId, { reason: 'file preview' });
    }
    return touched;
  }

  async function convertOne(entry) {
    const workDir = await mkdtemp(path.join(tempRoot, 'odin-preview-'));
    try {
      const inputPath = path.join(workDir, `source.${sourceExtension(entry)}`);
      let opened;
      try {
        opened = await storage.createReadStream(entry.storageKey);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await record(entry.storageKey, NO_PREVIEW);
        return 'failed';
      }
      await pipeline(opened.stream, createWriteStream(inputPath));
      let pdf;
      try {
        pdf = await converter.convert({ inputPath, workDir });
      } catch (error) {
        if (error?.code !== 'conversion_failed' && error?.code !== 'conversion_timeout') throw error;
        logBackendError({ context: buildOperationLogContext('vault.preview.convert', { storageKey: entry.storageKey }), error, level: 'warn', message: 'A file could not be converted for its preview.' });
        await record(entry.storageKey, NO_PREVIEW);
        return error.code === 'conversion_timeout' ? 'timeout' : 'failed';
      }
      const previewKey = previewStorageKeyFor(entry.storageKey);
      await writePreview(storage, previewKey, pdf.pdfPath);
      const touched = await record(entry.storageKey, previewKey);
      // Every row went while it converted: nothing will ever show it.
      if (!touched.length) await storage.delete(previewKey).catch(() => {});
      return 'ready';
    } finally {
      await rm(workDir, { force: true, maxRetries: 3, recursive: true }).catch(() => {});
    }
  }

  return {
    /** Converts what is due, at most limit files, one at a time. Returns what happened to each. */
    async processBatch({ limit = 1 } = {}) {
      if (!await converter.available()) {
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          log('LibreOffice (PREVIEW_SOFFICE_PATH) is not installed, so Office files get no preview.');
        }
        return [];
      }
      if (!warnedIsolation && typeof converter.isolated === 'function' && process.platform === 'linux' && !await converter.isolated()) {
        warnedIsolation = true;
        log('File previews: unshare --net is not available, so LibreOffice runs without a network namespace of its own. Its profile blocks linked content and its proxies point at a closed port.');
      }
      const now = clock().getTime();
      const pending = await projectRepository.listPendingPreviewObjects({ limit: 50, maxBytes });
      const due = pending.filter((entry) => (retries.get(entry.storageKey)?.nextAt ?? 0) <= now).slice(0, limit);
      const results = [];
      for (const entry of due) {
        try {
          const status = await convertOne(entry);
          retries.delete(entry.storageKey);
          results.push({ status, storageKey: entry.storageKey });
        } catch (error) {
          if (error?.code === 'soffice_missing') {
            results.push({ status: 'unavailable', storageKey: entry.storageKey });
            break;
          }
          const attempts = (retries.get(entry.storageKey)?.attempts ?? 0) + 1;
          logBackendError({ context: buildOperationLogContext('vault.preview', { attempts, storageKey: entry.storageKey }), error, level: 'warn', message: 'File preview failed.' });
          if (attempts >= maxAttempts) {
            retries.delete(entry.storageKey);
            await record(entry.storageKey, NO_PREVIEW).catch(() => {});
            results.push({ error: error?.message ?? String(error), status: 'failed', storageKey: entry.storageKey });
          } else {
            retries.set(entry.storageKey, { attempts, nextAt: now + backoff(attempts) });
            results.push({ error: error?.message ?? String(error), status: 'retry', storageKey: entry.storageKey });
          }
        }
      }
      return results;
    },
  };
}

/** Runs the preview processor every intervalMs, one poll at a time, for server.js's worker group. */
export function startFilePreviewWorker({ intervalMs = 5_000, onError = () => {}, processor } = {}) {
  let inFlight = false;
  let stopped = false;
  const waiters = new Set();
  const poll = async () => {
    if (stopped || inFlight) return [];
    inFlight = true;
    try {
      return await processor.processBatch();
    } catch (error) {
      onError(error);
      return [];
    } finally {
      inFlight = false;
      for (const resolve of waiters) resolve(true);
      waiters.clear();
    }
  };
  const timer = setInterval(poll, Math.max(100, Number(intervalMs) || 5_000));
  timer.unref?.();
  void poll();
  return {
    isHealthy: () => !stopped,
    isIdle: () => !inFlight,
    poll,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    waitForIdle({ timeoutMs = 30_000 } = {}) {
      if (!inFlight) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value) => {
          clearTimeout(timerId);
          waiters.delete(done);
          resolve(value);
        };
        const timerId = setTimeout(() => done(false), timeoutMs);
        waiters.add(done);
      });
    },
  };
}

export function logFilePreviewFailure(error) {
  logBackendError({ context: buildOperationLogContext('vault.preview', {}), error, level: 'warn', message: 'File preview worker poll failed.' });
}
