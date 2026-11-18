// In-process scheduling for Odin summary refreshes, keyed by scope:
//   - activity schedules a run `delayMs` after the latest request (trailing debounce), but
//     never later than `maxWaitMs` after the first request in a burst;
//   - at most one run per scope is in flight; requests that arrive meanwhile coalesce into
//     one follow-up run;
//   - a failed run is retried with backoff, up to `maxAttempts` runs per trigger. New
//     activity resets the count.
// The clock and timers are injectable so tests control time.

const DEFAULT_TIMERS = Object.freeze({
  clear: (handle) => clearTimeout(handle),
  set: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { forced: false, promise, reject, resolve };
}

export function createSummaryScheduler({
  delayMs = 20_000,
  maxAttempts = 3,
  maxWaitMs = 120_000,
  now = () => Date.now(),
  onError = null,
  retryDelaysMs = [30_000, 120_000],
  run,
  timers = DEFAULT_TIMERS,
}) {
  const entries = new Map();
  let stopped = false;

  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { attempt: 1, dueAt: null, firstRequestedAt: null, job: null, rerun: null, running: null, timer: null, timerKind: null };
      entries.set(key, entry);
    }
    return entry;
  }

  function clearTimer(entry) {
    if (entry.timer !== null) timers.clear(entry.timer);
    entry.timer = null;
    entry.timerKind = null;
    entry.dueAt = null;
  }

  function releaseIfIdle(key, entry) {
    if (!entry.running && entry.timer === null && !entry.rerun && entries.get(key) === entry) entries.delete(key);
  }

  function setTimer(key, entry, waitMs, kind) {
    clearTimer(entry);
    const wait = Math.max(0, waitMs);
    entry.dueAt = now() + wait;
    entry.timerKind = kind;
    entry.timer = timers.set(() => {
      entry.timer = null;
      entry.timerKind = null;
      entry.dueAt = null;
      entry.firstRequestedAt = null;
      void start(key, { forced: false });
    }, wait);
  }

  async function execute(entry, forced) {
    try {
      return (await run(entry.job, { attempt: entry.attempt, forced })) ?? { status: 'skipped' };
    } catch (error) {
      onError?.(error, entry.job);
      return { retryable: true, status: 'failed' };
    }
  }

  function start(key, { forced }) {
    const entry = entryFor(key);
    if (entry.running) {
      if (!entry.rerun) entry.rerun = deferred();
      entry.rerun.forced = entry.rerun.forced || forced;
      return entry.rerun.promise;
    }

    entry.running = (async () => {
      const result = await execute(entry, forced);
      entry.running = null;

      if (entry.rerun) {
        const rerun = entry.rerun;
        entry.rerun = null;
        clearTimer(entry);
        entry.firstRequestedAt = null;
        entry.attempt = 1;
        start(key, { forced: rerun.forced }).then(rerun.resolve, rerun.reject);
      } else if (result.status === 'failed'
        && result.retryable !== false
        && entry.timer === null
        && !stopped
        && entry.attempt < maxAttempts) {
        const waitMs = retryDelaysMs[Math.min(entry.attempt - 1, retryDelaysMs.length - 1)] ?? delayMs;
        entry.attempt += 1;
        setTimer(key, entry, waitMs, 'retry');
      } else {
        entry.attempt = 1;
        releaseIfIdle(key, entry);
      }
      return result;
    })();
    return entry.running;
  }

  return {
    /** Debounced request. Returns the time (ms) the run is due, or null after stop(). */
    schedule(key, job) {
      if (stopped) return null;
      const entry = entryFor(key);
      entry.job = job;
      entry.attempt = 1;
      const current = now();
      if (entry.firstRequestedAt === null) entry.firstRequestedAt = current;
      const latest = entry.firstRequestedAt + maxWaitMs - current;
      setTimer(key, entry, Math.min(delayMs, latest), 'debounce');
      return entry.dueAt;
    },

    /** Runs now (forced). Joins an in-flight run by queueing one follow-up and returning its result. */
    runNow(key, job) {
      const entry = entryFor(key);
      entry.job = job;
      clearTimer(entry);
      entry.firstRequestedAt = null;
      entry.attempt = 1;
      return start(key, { forced: true });
    },

    isPending(key) {
      const entry = entries.get(key);
      return Boolean(entry && (entry.timer !== null || entry.running || entry.rerun));
    },

    /** Snapshot for tests and diagnostics. */
    state(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      return { attempt: entry.attempt, dueAt: entry.dueAt, running: Boolean(entry.running), rerunQueued: Boolean(entry.rerun), timerKind: entry.timerKind };
    },

    /** Runs every debounced request now and waits for in-flight work. Retries stay scheduled. */
    async flush() {
      const waiting = [];
      for (const [key, entry] of entries) {
        if (entry.timer !== null && entry.timerKind === 'debounce') {
          clearTimer(entry);
          entry.firstRequestedAt = null;
          waiting.push(start(key, { forced: false }));
        } else if (entry.running) {
          waiting.push(entry.running);
        }
        if (entry.rerun) waiting.push(entry.rerun.promise);
      }
      await Promise.allSettled(waiting);
    },

    stop() {
      stopped = true;
      for (const [key, entry] of entries) {
        clearTimer(entry);
        releaseIfIdle(key, entry);
      }
    },
  };
}
