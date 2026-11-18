// Runs async tasks one at a time, in the order they were queued. Callers stay responsive:
// `enqueue` returns at once with a promise for that task's result, and later tasks wait
// for earlier ones instead of racing them.

export function createSerialQueue({ onChange } = {}) {
  const pending = [];
  let running = false;

  function snapshot() {
    return { busy: running || pending.length > 0, size: pending.length + (running ? 1 : 0) };
  }

  function notify() {
    onChange?.(snapshot());
  }

  async function drain() {
    running = true;
    while (pending.length > 0) {
      const { reject, resolve, task } = pending.shift();
      notify();
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      }
    }
    running = false;
    notify();
  }

  return {
    get busy() {
      return snapshot().busy;
    },
    get size() {
      return snapshot().size;
    },
    /** Drops tasks that have not started yet; each one rejects with `reason`. */
    clear(reason) {
      const dropped = pending.splice(0);
      for (const entry of dropped) {
        entry.reject(reason);
      }
      if (dropped.length > 0) notify();
    },
    enqueue(task) {
      const promise = new Promise((resolve, reject) => {
        pending.push({ reject, resolve, task });
      });
      notify();
      if (!running) drain();
      return promise;
    },
  };
}
