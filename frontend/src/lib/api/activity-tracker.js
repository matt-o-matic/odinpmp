// Tracks every in-flight API call so the app can show one shared "Working..." indicator.
//
// Each call has a working mode:
// - blocking: show the full-screen dialog right away (sign-in, setup, sign-out).
// - default: show the banner right away; switch to the dialog once default calls have
//   been in flight for 5 seconds without a break (anything the user started).
// - passive: show the banner only after 1 second of unbroken activity, and never the
//   dialog (automatic refreshes, polling, streams, lazy loads).
// A call without a mode takes the mode of the abort signal it was given, else default.
//
// The store publishes `{ count, visible, blocking }`: `visible` means some indicator is
// showing, and `blocking` means that indicator is the dialog.

export const WORKING_MODES = Object.freeze(['blocking', 'default', 'passive']);
export const DEFAULT_ESCALATE_MS = 5000;
export const PASSIVE_DELAY_MS = 1000;

const signalModes = new WeakMap();

export function normalizeWorkingMode(mode) {
  return WORKING_MODES.includes(mode) ? mode : null;
}

/** Tags a signal so calls that receive it inherit its working mode. */
export function setSignalWorkingMode(signal, mode) {
  const normalized = normalizeWorkingMode(mode);
  if (signal && normalized) {
    signalModes.set(signal, normalized);
  }
  return signal;
}

export function getSignalWorkingMode(signal) {
  return signal ? signalModes.get(signal) ?? null : null;
}

/** An AbortController whose signal carries a working mode. */
export function createWorkingController(mode) {
  const controller = new AbortController();
  setSignalWorkingMode(controller.signal, mode);
  return controller;
}

export function resolveWorkingMode({ mode, signal } = {}) {
  return normalizeWorkingMode(mode) ?? getSignalWorkingMode(signal) ?? 'default';
}

export class WorkingCancelledError extends Error {
  constructor() {
    super('Request cancelled.');
    this.name = 'AbortError';
    this.cancelled = true;
  }
}

export function isWorkingCancellation(error) {
  return error?.cancelled === true;
}

export function createActivityTracker({
  clearTimer = (id) => clearTimeout(id),
  escalateMs = DEFAULT_ESCALATE_MS,
  passiveDelayMs = PASSIVE_DELAY_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
} = {}) {
  const calls = new Map();
  const listeners = new Set();
  let nextId = 1;
  let escalateTimer = null;
  let escalated = false;
  let passiveTimer = null;
  let passiveElapsed = false;
  let latched = false;
  let state = { blocking: false, count: 0, visible: false };

  function stopEscalateTimer() {
    if (escalateTimer != null) clearTimer(escalateTimer);
    escalateTimer = null;
  }

  function stopPassiveTimer() {
    if (passiveTimer != null) clearTimer(passiveTimer);
    passiveTimer = null;
  }

  function update() {
    const modes = [...calls.values()].map((call) => call.mode);
    const count = modes.length;
    const anyDefault = modes.includes('default');

    if (count === 0) {
      stopPassiveTimer();
      passiveElapsed = false;
      latched = false;
    } else if (!passiveElapsed && passiveTimer == null) {
      // The passive delay runs from the start of the current stretch of any activity.
      passiveTimer = setTimer(() => {
        passiveTimer = null;
        passiveElapsed = true;
        update();
      }, passiveDelayMs);
    }

    if (!anyDefault) {
      // The countdown restarts whenever no default call is in flight.
      stopEscalateTimer();
      escalated = false;
    } else if (!escalated && escalateTimer == null) {
      escalateTimer = setTimer(() => {
        escalateTimer = null;
        escalated = true;
        update();
      }, escalateMs);
    }

    const blocking = count > 0 && (modes.includes('blocking') || escalated);
    // Once anything shows, the indicator stays up until nothing is in flight.
    const visible = count > 0 && (blocking || anyDefault || passiveElapsed || latched);
    latched = visible;

    if (state.count !== count || state.visible !== visible || state.blocking !== blocking) {
      state = { blocking, count, visible };
      for (const listener of listeners) listener(state);
    }
  }

  /**
   * Registers one call. Returns the signal the request must use, plus `end()` to call once
   * the request settles. The returned signal aborts when the caller's signal aborts or when
   * the user cancels from the blocking dialog.
   */
  function begin({ mode, signal } = {}) {
    const id = nextId++;
    const controller = new AbortController();
    const resolvedMode = resolveWorkingMode({ mode, signal });
    const call = { cancelled: false, controller, mode: resolvedMode };
    let abortFromCaller = null;

    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else if (signal) {
      abortFromCaller = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abortFromCaller, { once: true });
    }

    calls.set(id, call);
    update();

    return {
      end() {
        if (!calls.has(id)) return;
        if (abortFromCaller) signal.removeEventListener('abort', abortFromCaller);
        calls.delete(id);
        update();
      },
      mode: resolvedMode,
      signal: controller.signal,
      wasCancelled: () => call.cancelled,
    };
  }

  /** Cancels every call that isn't passive. Background traffic keeps running. */
  function cancel() {
    for (const call of calls.values()) {
      if (call.mode === 'passive') continue;
      call.cancelled = true;
      call.controller.abort(new WorkingCancelledError());
    }
  }

  async function track(options, run) {
    const activity = begin(options);
    try {
      return await run(activity.signal);
    } catch (error) {
      if (activity.wasCancelled()) throw new WorkingCancelledError();
      throw error;
    } finally {
      activity.end();
    }
  }

  return {
    begin,
    cancel,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    track,
  };
}

export const apiActivity = createActivityTracker();
