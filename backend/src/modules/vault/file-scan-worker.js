import { createHash } from 'node:crypto';

import { publishProjectChanged } from '../../lib/events/project-live-events.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { FILE_INFECTED_TEMPLATE_ID } from '../mail/mail.templates.js';
import { abortExpiredUploads } from './large-files.service.js';

// The scan worker. It reads each stored object waiting for a scan, streams it to ClamAV and
// hashes it (SHA-256, and MD5 for the file's signature) in the same pass, and records the
// result on every row that holds the object:
//
// - clean: the file can be downloaded.
// - infected: the object is purged from storage, the uploader is emailed, and the row stays,
//   marked infected (an old version is also marked deleted).
// - ClamAV unavailable: the file stays pending and the worker tries again with backoff, for as
//   long as it takes. After an hour of that, isDegraded() says so and readiness reports it.
// - Any other failure (ClamAV could not scan it, say) is retried with backoff, and after
//   maxAttempts the file is marked failed. It is never downloadable.
//
// With no ClamAV configured (development and tests), the noop scanner passes every file once it
// is read and hashed. server.js says so at start.
//
// It also aborts uploads left open for 24 hours. Backoff is held in memory: after a restart every
// pending object is tried again at once.

const DEGRADED_AFTER_MS = 60 * 60 * 1000;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function createFileScanProcessor({
  clock = () => new Date(),
  frontendAppUrl = '',
  liveEventBus = null,
  mailRepository = null,
  maxAttempts = 5,
  projectRepository,
  scanner,
  storage,
} = {}) {
  const retries = new Map();
  let unavailableSince = null;
  let unavailableStreak = 0;
  let lastError = null;

  const backoff = (attempt, baseMs, maxMs) => Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));

  async function notifyInfected(entries) {
    for (const entry of entries) {
      if (!mailRepository?.queueMail || !entry.uploader?.email) continue;
      const fileUrl = new URL(`${String(frontendAppUrl || 'http://localhost:5173/app').replace(/\/$/, '')}/projects/${encodeURIComponent(entry.projectId)}`);
      fileUrl.searchParams.set('projectSettings', 'files');
      fileUrl.searchParams.set('file', entry.fileId);
      const rendered = await renderEmailFromTemplate({
        mailRepository,
        templateId: FILE_INFECTED_TEMPLATE_ID,
        vars: {
          fileName: escapeHtml(entry.fileName),
          fileUrl: escapeHtml(fileUrl.toString()),
          projectName: escapeHtml(entry.projectName || 'your project'),
          recipientName: escapeHtml(entry.uploader.name || 'there'),
          version: escapeHtml(entry.version),
        },
      });
      await mailRepository.queueMail({ ...rendered, recipientEmail: entry.uploader.email, targetId: `file-infected:${entry.fileId}:${entry.version}`, templateId: FILE_INFECTED_TEMPLATE_ID });
    }
  }

  function announce(entries) {
    for (const projectId of new Set(entries.map((entry) => entry.projectId))) {
      publishProjectChanged(liveEventBus, projectId, { reason: 'file scanned' });
    }
  }

  async function record(storageKey, result) {
    const touched = await projectRepository.recordObjectScan({ storageKey, ...result });
    announce(touched);
    return touched;
  }

  async function scanOne({ storageKey }) {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    let opened;
    try {
      opened = await projectRepository.openStoredObject(storageKey);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        await record(storageKey, { scanStatus: 'failed' });
        return 'failed';
      }
      throw error;
    }
    const verdict = await scanner.scanStream(opened.stream, { onChunk: (chunk) => { sha256.update(chunk); md5.update(chunk); } });
    if (verdict.clean) {
      await record(storageKey, { md5: md5.digest('hex'), scanStatus: 'clean', sha256: sha256.digest('hex') });
      return 'clean';
    }
    // ClamAV may stop reading at the virus, so the hashes would be of part of the file.
    // Marked first, so it is never downloadable even if the purge fails.
    const touched = await record(storageKey, { scanStatus: 'infected' });
    try {
      if (typeof storage.purge === 'function') await storage.purge(storageKey);
      else await storage.delete(storageKey);
    } catch (error) {
      logBackendError({ context: buildOperationLogContext('vault.scan.purge', { storageKey }), error, level: 'error', message: 'Could not remove an infected file from storage.' });
    }
    await notifyInfected(touched);
    return 'infected';
  }

  return {
    /** Scans what is due, one object at a time. Returns what happened to each. */
    async processBatch({ limit = 4 } = {}) {
      const now = clock();
      const pending = await projectRepository.listPendingScanObjects({ limit: 100 });
      const due = pending.filter((entry) => (retries.get(entry.storageKey)?.nextAt ?? 0) <= now.getTime()).slice(0, limit);
      const results = [];
      for (const entry of due) {
        try {
          const status = await scanOne(entry);
          retries.delete(entry.storageKey);
          unavailableSince = null;
          unavailableStreak = 0;
          results.push({ status, storageKey: entry.storageKey });
        } catch (error) {
          lastError = error;
          if (error?.code === 'scanner_unavailable') {
            // Nothing will scan until ClamAV is back: wait for it, and keep every file pending.
            unavailableSince ??= now;
            unavailableStreak += 1;
            const nextAt = now.getTime() + backoff(unavailableStreak, 5_000, 5 * 60_000);
            for (const waiting of pending) retries.set(waiting.storageKey, { attempts: retries.get(waiting.storageKey)?.attempts ?? 0, nextAt });
            results.push({ status: 'pending', storageKey: entry.storageKey });
            break;
          }
          const attempts = (retries.get(entry.storageKey)?.attempts ?? 0) + 1;
          if (attempts >= maxAttempts) {
            retries.delete(entry.storageKey);
            await record(entry.storageKey, { scanStatus: 'failed' });
            results.push({ error: error?.message ?? String(error), status: 'failed', storageKey: entry.storageKey });
          } else {
            retries.set(entry.storageKey, { attempts, nextAt: now.getTime() + backoff(attempts, 10_000, 10 * 60_000) });
            results.push({ error: error?.message ?? String(error), status: 'retry', storageKey: entry.storageKey });
          }
        }
      }
      return results;
    },
    /** True after an hour in which ClamAV could not be reached while files waited. */
    isDegraded(now = clock()) {
      return Boolean(unavailableSince && now.getTime() - unavailableSince.getTime() >= DEGRADED_AFTER_MS);
    },
    get lastError() {
      return lastError;
    },
  };
}

/**
 * Runs the scan processor every intervalMs and the expired-upload sweep every sweepIntervalMs,
 * one poll at a time. Shaped like the connector workers, for server.js's worker group.
 */
export function startFileScanWorker({ intervalMs = 5_000, largeFileDeps, onError = () => {}, processor, sweepIntervalMs = 15 * 60_000 } = {}) {
  let inFlight = false;
  let stopped = false;
  let lastSweep = 0;
  const waiters = new Set();
  const poll = async () => {
    if (stopped || inFlight) return [];
    inFlight = true;
    try {
      if (Date.now() - lastSweep >= sweepIntervalMs) {
        lastSweep = Date.now();
        await abortExpiredUploads(largeFileDeps).catch((error) => onError(error));
      }
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
    isDegraded: () => processor.isDegraded(),
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

export function logFileScanFailure(error) {
  logBackendError({ context: buildOperationLogContext('vault.scan', {}), error, level: 'warn', message: 'File scan worker poll failed.' });
}
