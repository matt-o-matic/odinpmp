// Autosave for the guided review. Each change is an operation under a key, such as
// "verdict:booking-home" or "annotation:<id>". A newer operation for a key replaces one that
// has not started yet, so a burst of edits sends only the latest state. Operations for one
// key run one at a time and in order; different keys run independently.
//
// A failed operation stays queued until retry() runs it again or a newer operation for the
// same key replaces it, so nothing the reviewer did is dropped. `silent` operations (where
// the reviewer is in the review) never show as Saving or Couldn't save. `onError(key, error)` may
// return true to say the failure is handled elsewhere (for example a closed round), and the
// operation is then dropped instead of kept for Retry.

const defaultTimers = {
  clear: (id) => clearTimeout(id),
  set: (callback, delay) => setTimeout(callback, delay),
};

export function createAutosave({ now = () => new Date(), onChange = () => {}, onError = () => false, timers = defaultTimers } = {}) {
  const entries = new Map();
  let savedAt = null;
  let disposed = false;

  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { failed: null, queued: null, running: null };
      entries.set(key, entry);
    }
    return entry;
  }

  function cleanup(key) {
    const entry = entries.get(key);
    if (entry && !entry.queued && !entry.running && !entry.failed) entries.delete(key);
  }

  function status() {
    let saving = false;
    let failed = 0;
    let error = null;
    for (const entry of entries.values()) {
      if (entry.silent) continue;
      if (entry.queued || entry.running) saving = true;
      if (entry.failed) {
        failed += 1;
        error = error ?? entry.failed.error;
      }
    }
    const state = failed > 0 ? 'error' : saving ? 'saving' : savedAt ? 'saved' : 'idle';
    return { error, failed, savedAt, saving, state };
  }

  function notify() {
    if (!disposed) onChange(status());
  }

  function clearTimer(op) {
    if (op?.timer != null) {
      timers.clear(op.timer);
      op.timer = null;
    }
  }

  function start(key) {
    const entry = entries.get(key);
    if (!entry || entry.running || !entry.queued || entry.queued.timer != null) return;
    const op = entry.queued;
    entry.queued = null;
    entry.running = (async () => {
      try {
        await op.run();
        if (!entry.silent) savedAt = now();
        entry.failed = null;
      } catch (error) {
        let handled = false;
        try {
          handled = onError(key, error) === true;
        } catch {
          handled = false;
        }
        // A newer operation for this key already supersedes the failed one.
        if (!handled && !entry.queued) entry.failed = { error, run: op.run };
      } finally {
        entry.running = null;
        if (entry.queued && entry.queued.timer == null) start(key);
        cleanup(key);
        notify();
      }
    })();
  }

  /** Queues `run` for `key`. With `delay`, it waits that long for newer edits (trailing). */
  function schedule(key, run, { delay = 0, silent = false } = {}) {
    if (disposed) return;
    const entry = entryFor(key);
    entry.failed = null;
    entry.silent = silent;
    clearTimer(entry.queued);
    const op = { run, timer: null };
    entry.queued = op;
    if (delay > 0) {
      op.timer = timers.set(() => {
        op.timer = null;
        start(key);
      }, delay);
    } else {
      start(key);
    }
    notify();
  }

  /** Runs `key` now, waits for it, and throws when it failed. */
  async function flush(key) {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.queued) {
      clearTimer(entry.queued);
      start(key);
    }
    while (entry.running) {
      await entry.running;
      if (entry.queued) {
        clearTimer(entry.queued);
        start(key);
      }
    }
    if (entry.failed) throw entry.failed.error;
  }

  /** Runs everything that is waiting; resolves when all of it settled. */
  async function flushAll() {
    await Promise.allSettled([...entries.keys()].map((key) => flush(key)));
    return status();
  }

  /** Runs every failed operation again. */
  function retry() {
    for (const [key, entry] of entries) {
      if (!entry.failed || entry.queued) continue;
      entry.queued = { run: entry.failed.run, timer: null };
      entry.failed = null;
      start(key);
    }
    notify();
  }

  /** Drops what is queued or failed for `key`. A request already sent still finishes. */
  function cancel(key) {
    const entry = entries.get(key);
    if (!entry) return;
    clearTimer(entry.queued);
    entry.queued = null;
    entry.failed = null;
    cleanup(key);
    notify();
  }

  function hasPending(key) {
    const entry = entries.get(key);
    return Boolean(entry && (entry.queued || entry.running || entry.failed));
  }

  function pendingKeys() {
    return new Set([...entries.entries()].filter(([, entry]) => entry.queued || entry.running || entry.failed).map(([key]) => key));
  }

  function dispose() {
    disposed = true;
    for (const entry of entries.values()) clearTimer(entry.queued);
  }

  return { cancel, dispose, flush, flushAll, hasPending, pendingKeys, retry, schedule, status };
}

/** "Saved 10:42", "Saving…", "Couldn't save" for the header and its live region. */
export function describeSaveStatus(status, { locale } = {}) {
  if (!status) return { label: '', tone: 'idle' };
  if (status.state === 'error') return { label: 'Couldn’t save', tone: 'error' };
  if (status.state === 'saving') return { label: 'Saving…', tone: 'saving' };
  if (status.state === 'saved' && status.savedAt) {
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(status.savedAt);
    return { label: `Saved ${time}`, tone: 'saved' };
  }
  return { label: '', tone: 'idle' };
}
