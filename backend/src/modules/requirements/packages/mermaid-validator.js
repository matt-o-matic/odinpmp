import { Worker } from 'node:worker_threads';

// Runs Mermaid parsing in a worker thread. The first call loads mermaid and jsdom (about a
// second warm, ~140 MB resident), so it gets a longer deadline than later calls. The worker
// stops after a few idle minutes to give that memory back. A call that runs past its
// deadline terminates the worker; the next call starts a fresh one.

const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_MS = 2 * 60 * 1000;

export function createMermaidValidator({
  idleMs = DEFAULT_IDLE_MS,
  loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let worker = null;
  let idleTimer = null;
  let warmed = false;
  let sequence = 0;
  const pending = new Map();

  function settleAll(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleStop() {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pending.size === 0) stop();
    }, idleMs);
    idleTimer.unref?.();
  }

  function stop() {
    clearIdle();
    const current = worker;
    worker = null;
    warmed = false;
    if (current) void current.terminate();
  }

  function start() {
    worker = new Worker(new URL('./mermaid-worker.js', import.meta.url));
    worker.unref();
    const current = worker;
    current.on('message', ({ error, id, results }) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (pending.size === 0) {
        current.unref();
        scheduleIdleStop();
      }
      if (error) entry.reject(new Error(error));
      else {
        warmed = true;
        entry.resolve(results);
      }
    });
    current.on('error', (error) => {
      if (worker === current) worker = null;
      settleAll(error);
    });
    current.on('exit', () => {
      if (worker === current) worker = null;
      settleAll(new Error('The Mermaid checker stopped.'));
    });
  }

  return {
    /** Resolves to `[{ ok, error? }]`, one per source, in order. Rejects if the check cannot run. */
    validate(sources = []) {
      if (sources.length === 0) return Promise.resolve([]);
      clearIdle();
      if (!worker) start();
      const current = worker;
      current.ref();
      sequence += 1;
      const id = sequence;
      const deadline = warmed ? timeoutMs : loadTimeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          stop();
          reject(new Error('The Mermaid check timed out.'));
        }, deadline);
        pending.set(id, { reject, resolve, timer });
        current.postMessage({ id, sources: sources.map((source) => String(source ?? '')) });
      });
    },
    close() {
      settleAll(new Error('The Mermaid checker was closed.'));
      stop();
    },
  };
}

let sharedValidator = null;

export function getSharedMermaidValidator() {
  sharedValidator ??= createMermaidValidator();
  return sharedValidator;
}
