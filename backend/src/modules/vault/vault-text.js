import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { HttpError } from '../../lib/errors/http-error.js';

// Text from Word documents and PDFs, extracted in a worker thread (vault-text-worker.js) that is
// ended past its time or memory limit, and only two at a time, so a hostile file cannot stall
// Odin. The worker's heap limit misses the buffers pdf.js and jszip inflate into, so the process's
// own growth is watched too. These files may be larger than plain text, since images and fonts
// make up most of them: 15 MB covers the mail attachments Odin keeps (10 MiB at most).
export const DOCUMENT_TEXT_LIMITS = Object.freeze({
  bytes: 15 * 1024 * 1024,
  chars: 5_000_000,
  extraMemoryBytes: 768 * 1024 * 1024,
  pages: 2000,
  running: 2,
  timeoutMs: 10_000,
  waiting: 8,
});
const WORKER_URL = new URL('./vault-text-worker.js', import.meta.url);
const CACHE = { chars: 8_000_000, entries: 32 };
// Outcomes that depend on the server's load rather than the file, so are not remembered.
const TRANSIENT = new Set(['too_slow', 'too_complex']);

let running = 0;
const waiting = [];
// Recent outcomes by the file's hash, so reading a long document a window at a time parses it once.
const recent = new Map();

async function takeSlot() {
  if (running < DOCUMENT_TEXT_LIMITS.running) { running += 1; return; }
  if (waiting.length >= DOCUMENT_TEXT_LIMITS.waiting) throw new HttpError(503, 'Odin is reading other documents right now. Try again in a moment.', { details: { code: 'text_busy' } });
  await new Promise((resolve) => { waiting.push(resolve); });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function remember(key, outcome) {
  recent.delete(key);
  recent.set(key, outcome);
  let chars = [...recent.values()].reduce((sum, entry) => sum + (entry.text?.length ?? 0), 0);
  for (const [oldest, entry] of recent) {
    if (recent.size <= 1 || (chars <= CACHE.chars && recent.size <= CACHE.entries)) break;
    chars -= entry.text?.length ?? 0;
    recent.delete(oldest);
  }
}

function runWorker(kind, bytes, limits) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { bytes, kind, maxChars: limits.chars, maxPages: limits.pages } });
    const started = Date.now();
    const ceiling = process.memoryUsage.rss() + limits.extraMemoryBytes;
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      worker.terminate().catch(() => {});
      resolve(outcome);
    };
    const tooComplex = { code: 'too_complex', message: 'This file is too complex to read as text.', ok: false };
    const watch = setInterval(() => {
      if (Date.now() - started > limits.timeoutMs) finish({ code: 'too_slow', message: `This file took longer than ${limits.timeoutMs / 1000} s to read as text, so Odin stopped.`, ok: false });
      else if (process.memoryUsage.rss() > ceiling) finish(tooComplex);
    }, 50);
    worker.once('message', finish);
    worker.once('error', (error) => finish(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooComplex : { code: 'corrupt', message: 'This file could not be read as text.', ok: false }));
    worker.once('exit', () => finish({ code: 'corrupt', message: 'This file could not be read as text.', ok: false }));
  });
}

/**
 * The text of a Word document (kind 'docx'), Excel workbook ('xlsx'), PowerPoint deck ('pptx') or
 * PDF ('pdf'). A file that is password-protected,
 * damaged, has no text (a scan) or is too slow or complex to read is refused with a 422.
 */
export async function extractDocumentText(kind, bytes, limits = DOCUMENT_TEXT_LIMITS) {
  const key = `${kind}:${createHash('sha256').update(bytes).digest('hex')}`;
  let outcome = recent.get(key);
  if (!outcome) {
    await takeSlot();
    try {
      outcome = await runWorker(kind, bytes, limits);
    } finally {
      releaseSlot();
    }
    if (outcome.ok || !TRANSIENT.has(outcome.code)) remember(key, outcome);
  }
  if (!outcome.ok) throw new HttpError(422, outcome.message, { details: { code: outcome.code } });
  return outcome.text;
}
