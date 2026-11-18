// Runs `refresh` every `intervalMs` while the page is visible. A hidden tab stops polling;
// when it is shown again it refreshes once at once and starts the interval over.

export function createVisibleRefresh({
  intervalMs = 30_000,
  refresh,
  target = typeof document !== 'undefined' ? document : null,
  timers = globalThis,
} = {}) {
  let timer = null;
  let started = false;

  const visible = () => !target || target.visibilityState !== 'hidden';

  function clear() {
    if (timer != null) timers.clearInterval(timer);
    timer = null;
  }

  function schedule() {
    clear();
    timer = timers.setInterval(() => refresh(), intervalMs);
  }

  function handleVisibility() {
    if (!started) return;
    if (visible()) {
      refresh();
      schedule();
    } else {
      clear();
    }
  }

  return {
    get running() {
      return timer != null;
    },
    start() {
      if (started) return;
      started = true;
      target?.addEventListener?.('visibilitychange', handleVisibility);
      if (visible()) schedule();
    },
    stop() {
      started = false;
      clear();
      target?.removeEventListener?.('visibilitychange', handleVisibility);
    },
  };
}
