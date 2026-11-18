// Subscribes to a live event stream and reports batched changes made elsewhere. Events this tab
// caused are skipped. A dropped stream reconnects with backoff, and the first batch after a
// reconnect is flagged so callers can refetch anything they missed. So is the first batch after a
// shared stream opens again for a tab that was hidden (`resumed`, shared-project-events.js).
//
// `open(token, handlers)` opens the stream and returns a stop function. `accept(data)` picks the
// events of `eventType` the caller cares about.

export const WORKSPACE_CHANGED_EVENT = 'workspace.changed';

export function createLiveUpdates({
  accept = () => true,
  debounceMs = 300,
  eventType,
  getToken,
  // Keeps each accepted event in the batch's `details`, for screens that refetch only what changed.
  keepDetails = false,
  onChange,
  open,
  ownClientId = null,
  retryDelaysMs = [1000, 2000, 5000, 10000, 30000],
  timers = { clear: (id) => clearTimeout(id), set: (callback, delay) => setTimeout(callback, delay) },
}) {
  let stopStream = null;
  let stopped = false;
  let attempts = 0;
  let debounceTimer = null;
  let retryTimer = null;
  let pending = null;

  function flush() {
    debounceTimer = null;
    const batch = pending;
    pending = null;
    if (batch && !stopped) onChange(batch);
  }

  function queue({ actor = null, detail = null, reconnected = false } = {}) {
    pending = pending ?? { actors: [], reconnected: false, ...(keepDetails ? { details: [] } : {}) };
    if (actor?.name && !pending.actors.some((entry) => entry.id === actor.id)) {
      pending.actors.push(actor);
    }
    if (keepDetails && detail) pending.details.push(detail);
    pending.reconnected = pending.reconnected || reconnected;
    timers.clear(debounceTimer);
    debounceTimer = timers.set(flush, debounceMs);
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    stopStream = null;
    const delay = retryDelaysMs[Math.min(attempts, retryDelaysMs.length - 1)];
    attempts += 1;
    retryTimer = timers.set(() => {
      retryTimer = null;
      connect(true);
    }, delay);
  }

  function connect(isReconnect) {
    if (stopped) return;
    const token = getToken();
    if (!token) {
      scheduleReconnect();
      return;
    }

    stopStream = open(token, {
      onClose: scheduleReconnect,
      onError: scheduleReconnect,
      onEvent({ data, resumed, type }) {
        if (type === 'connected') {
          attempts = 0;
          if (isReconnect || resumed) queue({ reconnected: true });
          return;
        }

        if (type !== eventType || !accept(data)) return;
        if (data?.originClientId && data.originClientId === ownClientId) return;
        queue({ actor: data?.actor ?? null, detail: data ?? null });
      },
    });
  }

  connect(false);

  return () => {
    stopped = true;
    stopStream?.();
    timers.clear(debounceTimer);
    timers.clear(retryTimer);
  };
}

/**
 * Changes anywhere in the workspace, for screens that span projects. `areas` lists the areas the
 * screen shows: 'projects' (projects and their contents), 'resources' (resource planning, time
 * and finance) and 'workflows'. Events name no project or person, so batches have no actors.
 * Workspace screens are heavier to reload than one project, so a burst of changes (an agent
 * working through a board) waits for a two-second pause.
 */
export function createWorkspaceLiveUpdates({ apiClient, areas, debounceMs = 2000, ...options }) {
  const wanted = new Set(areas);
  return createLiveUpdates({
    ...options,
    accept: (data) => wanted.has(data?.area),
    debounceMs,
    eventType: WORKSPACE_CHANGED_EVENT,
    open: (token, handlers) => apiClient.subscribeToWorkspaceEvents(token, handlers),
    ownClientId: apiClient.clientId,
  });
}

/**
 * Holds a refresh while the page is hidden and runs one when it is shown again, so tabs in the
 * background don't refetch on every change. Batches held meanwhile merge into one.
 */
export function deferWhileHidden(callback, { document: doc = globalThis.document } = {}) {
  let held = null;

  function onVisibilityChange() {
    if (doc.hidden || !held) return;
    const batch = held;
    held = null;
    callback(batch);
  }

  doc?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    run(batch = { actors: [], reconnected: false }) {
      if (!doc?.hidden) {
        callback(batch);
        return;
      }
      held = {
        actors: [...(held?.actors ?? []), ...batch.actors.filter((actor) => !held?.actors.some((entry) => entry.id === actor.id))],
        reconnected: Boolean(held?.reconnected || batch.reconnected),
      };
    },
    stop() {
      held = null;
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
}
