// Uploads a file in parts straight to storage: Odin starts the
// upload and signs part URLs in batches, the browser sends several parts at once, retries a part
// that fails, and after a reload resumes from the parts storage already has. Completing is a
// separate step, so the caller can handle a version conflict.

export const PART_CONCURRENCY = 4;
const URL_BATCH = 20;
const PART_ATTEMPTS = 4;
const STORE_KEY = 'odin.largeUploads.v1';

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(abortError());
  }, { once: true });
});

function abortError() {
  return Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' });
}

// Uploads left unfinished in this browser, so a reload can offer to resume them. Browser storage
// is a convenience here: without it, an interrupted upload starts again.
function readStore(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(storage, entries) {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(entries.slice(-20)));
  } catch {
    // Private windows and full storage: resume is unavailable, the upload still works.
  }
}

const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Uploads in this project that this browser started and did not finish, newest first. */
export function readPendingUploads(projectId, { now = Date.now(), storage = defaultStorage() } = {}) {
  return readStore(storage)
    .filter((entry) => entry.projectId === projectId && new Date(entry.expiresAt).getTime() > now)
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
}

export function rememberUpload(entry, { storage = defaultStorage() } = {}) {
  writeStore(storage, [...readStore(storage).filter((item) => item.uploadId !== entry.uploadId), entry]);
}

export function forgetUpload(uploadId, { storage = defaultStorage() } = {}) {
  writeStore(storage, readStore(storage).filter((item) => item.uploadId !== uploadId));
}

/** The pending upload a chosen file continues: same name, size and modified time, same place. */
export function matchPendingUpload(pending = [], file, { fileId = null, targetId, targetType } = {}) {
  if (!file) return null;
  return pending.find((entry) => entry.fileName === file.name
    && entry.size === file.size
    && entry.lastModified === file.lastModified
    && (entry.fileId ?? null) === (fileId ?? null)
    && (fileId || (entry.targetId === targetId && entry.targetType === targetType))) ?? null;
}

/**
 * Sends one part with XMLHttpRequest, which reports upload progress where fetch does not.
 * Rejects with the response status, or 0 for a network failure.
 */
export function sendPartWithXhr(url, blob, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error(`Part upload failed (${xhr.status}).`), { status: xhr.status })));
    xhr.onerror = () => reject(Object.assign(new Error('The connection dropped.'), { status: 0 }));
    xhr.onabort = () => reject(abortError());
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

const partSizeOf = (upload, partNumber) => (partNumber < upload.partCount ? upload.partSize : upload.size - upload.partSize * (upload.partCount - 1));

/**
 * Sends every part of a file not yet in storage. Resumes the upload in `resume` when storage
 * still has it, otherwise starts one. Returns the upload, ready to complete.
 */
export async function sendLargeUpload({
  api,
  file,
  onProgress = () => {},
  projectId,
  resolveUrl = (url) => url,
  resume = null,
  sendPart = sendPartWithXhr,
  signal = null,
  sleep = delay,
  start,
  storage = defaultStorage(),
  token,
}) {
  let upload = null;
  if (resume) {
    try {
      const state = (await api.getFileUpload(projectId, resume.uploadId, token)).upload;
      if (state.status === 'uploading' && state.size === file.size) upload = state;
    } catch {
      // Gone or expired: start again.
    }
    if (!upload) forgetUpload(resume.uploadId, { storage });
  }
  if (!upload) {
    upload = (await api.startFileUpload(projectId, { contentType: file.type || 'application/octet-stream', fileName: file.name, fileSize: file.size, ...start }, token)).upload;
    upload.parts = [];
  }
  rememberUpload({
    expiresAt: upload.expiresAt,
    fileId: start.fileId ?? null,
    fileName: file.name,
    lastModified: file.lastModified,
    projectId,
    size: file.size,
    startedAt: new Date().toISOString(),
    targetId: start.targetId ?? null,
    targetType: start.targetType ?? null,
    uploadId: upload.id,
  }, { storage });

  const received = new Set((upload.parts ?? []).filter((part) => part.size === partSizeOf(upload, part.partNumber)).map((part) => part.partNumber));
  let doneBytes = [...received].reduce((sum, partNumber) => sum + partSizeOf(upload, partNumber), 0);
  const inFlight = new Map();
  const report = () => onProgress({ sentBytes: doneBytes + [...inFlight.values()].reduce((sum, value) => sum + value, 0), totalBytes: upload.size });
  report();

  const queue = [];
  for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) if (!received.has(partNumber)) queue.push(partNumber);
  const urls = new Map();
  let signing = null;
  async function urlFor(partNumber) {
    while (!urls.has(partNumber)) {
      if (!signing) {
        const batch = [partNumber, ...queue.filter((number) => !urls.has(number) && number !== partNumber)].slice(0, URL_BATCH);
        signing = api.signFileUploadParts(projectId, upload.id, batch, token)
          .then((result) => { for (const part of result.parts) urls.set(part.partNumber, resolveUrl(part.url)); })
          .finally(() => { signing = null; });
      }
      await signing;
    }
    return urls.get(partNumber);
  }

  async function sendOne(partNumber) {
    const begin = (partNumber - 1) * upload.partSize;
    const blob = file.slice(begin, begin + partSizeOf(upload, partNumber));
    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw abortError();
      try {
        const url = await urlFor(partNumber);
        inFlight.set(partNumber, 0);
        await sendPart(url, blob, { onProgress: (loaded) => { inFlight.set(partNumber, loaded); report(); }, signal });
        inFlight.delete(partNumber);
        doneBytes += blob.size;
        report();
        return;
      } catch (error) {
        inFlight.delete(partNumber);
        report();
        if (error?.name === 'AbortError' || signal?.aborted) throw abortError();
        // An expired or refused link is signed again on the next try.
        if (error?.status === 403) urls.delete(partNumber);
        if (attempt >= PART_ATTEMPTS) throw Object.assign(new Error('Part of the file would not upload. Check the connection and try again to resume.'), { code: 'part_failed', cause: error });
        await sleep(1000 * (2 ** (attempt - 1)), signal);
      }
    }
  }

  // A part that will not go stops the others taking new parts; what they have sent stays.
  let failed = false;
  const workers = Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
    while (queue.length && !failed) {
      try {
        await sendOne(queue.shift());
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return upload;
}
