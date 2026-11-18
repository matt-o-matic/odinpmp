export function startAssistantDurableWorker({
  intervalMs = 1_000,
  onError = () => {},
  queue,
  run,
  // The run types this worker takes; run() gets each claimed run as executionRun (runType says which).
  runTypes = ['assistant_turn'],
} = {}) {
  if (!queue?.workOnce || typeof run !== 'function') {
    throw new Error('Assistant durable worker requires a queue and run handler.');
  }

  let inFlight = false;
  let stopped = false;
  const idleWaiters = new Set();

  const poll = async () => {
    if (stopped || inFlight) return null;
    inFlight = true;
    try {
      return await queue.workOnce({ run, runTypes });
    } catch (error) {
      onError(error);
      return null;
    } finally {
      inFlight = false;
      for (const resolve of idleWaiters) resolve(true);
      idleWaiters.clear();
    }
  };

  const timer = setInterval(poll, Math.max(100, Number(intervalMs) || 1_000));
  timer.unref?.();
  void poll();

  return {
    isHealthy() { return !stopped; },
    isIdle() { return !inFlight; },
    poll,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    waitForIdle({ timeoutMs = 30_000 } = {}) {
      if (!inFlight) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timerId); idleWaiters.delete(done); resolve(value); };
        const timerId = setTimeout(() => done(false), timeoutMs);
        idleWaiters.add(done);
      });
    },
  };
}
