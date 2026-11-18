// Live updates for the client portal and the guided review. One stream feeds
// any number of listeners with debounced batches. A dropped stream reconnects with backoff,
// and the first batch after a reconnect is flagged so listeners refetch what they missed.

export const REVIEW_EVENT_TYPES = Object.freeze({
  decisions: 'requirements.decisions.invalidated',
  links: 'requirements.links.invalidated',
  review: 'requirements.review.updated',
  rounds: 'requirements.rounds.invalidated',
  summary: 'requirements.summary.updated',
  topics: 'requirements.topics.invalidated',
});

const REVIEW_PREFIX = 'requirements.';

function emptyBatch() {
  return { annotationIds: [], reconnected: false, roundIds: [], screenIds: [], topicIds: [], types: [] };
}

function addUnique(list, value) {
  if (value != null && value !== '' && !list.includes(value)) list.push(value);
}

/** Merges one stream event into a pending batch. */
export function mergeReviewEvent(batch, { data = {}, type = '' } = {}) {
  const next = batch ?? emptyBatch();
  addUnique(next.types, type);
  addUnique(next.roundIds, data?.roundId ?? null);
  addUnique(next.screenIds, data?.screenId ?? null);
  addUnique(next.annotationIds, data?.annotationId ?? null);
  for (const topicId of Array.isArray(data?.topicIds) ? data.topicIds : []) addUnique(next.topicIds, topicId);
  if (data?.scopeType === 'topic') addUnique(next.topicIds, data.scopeId);
  return next;
}

/** True when a batch may change one round's review: its feedback or its lifecycle. */
export function batchTouchesRound(batch, roundId) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  const relevant = batch.types.some((type) => type === REVIEW_EVENT_TYPES.review || type === REVIEW_EVENT_TYPES.rounds);
  if (!relevant) return false;
  return batch.roundIds.length === 0 || batch.roundIds.includes(roundId);
}

/** True when a batch may change the portal inbox: rounds, questions, decisions, or summaries. */
export function batchTouchesInbox(batch) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  return batch.types.some((type) => [REVIEW_EVENT_TYPES.rounds, REVIEW_EVENT_TYPES.topics, REVIEW_EVENT_TYPES.decisions, REVIEW_EVENT_TYPES.summary, REVIEW_EVENT_TYPES.links].includes(type));
}

/** True when a batch may change one question page. */
export function batchTouchesQuestion(batch, topicId) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  if (!batch.types.some((type) => [REVIEW_EVENT_TYPES.topics, REVIEW_EVENT_TYPES.summary, REVIEW_EVENT_TYPES.decisions].includes(type))) return false;
  return batch.topicIds.length === 0 || batch.topicIds.includes(topicId);
}

/**
 * Opens a stream with `open({ onEvent, onClose, onError })` (which returns a stop function)
 * and keeps it open. `relevant(type)` filters events; by default every requirements event.
 */
export function createReviewLiveFeed({
  debounceMs = 250,
  open,
  relevant = (type) => typeof type === 'string' && type.startsWith(REVIEW_PREFIX),
  retryDelaysMs = [1000, 2000, 5000, 10000, 30000],
  timers = { clear: (id) => clearTimeout(id), set: (callback, delay) => setTimeout(callback, delay) },
}) {
  const listeners = new Set();
  let stopStream = null;
  let stopped = false;
  let attempts = 0;
  let debounceTimer = null;
  let retryTimer = null;
  let pending = null;
  let connected = false;

  function flush() {
    debounceTimer = null;
    const batch = pending;
    pending = null;
    if (!batch || stopped) return;
    for (const listener of [...listeners]) {
      try {
        listener(batch);
      } catch {
        // One listener's failure does not stop the others.
      }
    }
  }

  function schedule() {
    timers.clear(debounceTimer);
    debounceTimer = timers.set(flush, debounceMs);
  }

  function scheduleReconnect() {
    connected = false;
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
    try {
      stopStream = open({
        onClose: scheduleReconnect,
        onError: scheduleReconnect,
        onEvent({ data, resumed, type }) {
          if (type === 'connected') {
            attempts = 0;
            connected = true;
            // `resumed`: the shared stream opened again after the tab was hidden.
            if (isReconnect || resumed) {
              pending = pending ?? emptyBatch();
              pending.reconnected = true;
              schedule();
            }
            return;
          }
          if (!relevant(type)) return;
          pending = mergeReviewEvent(pending, { data, type });
          schedule();
        },
      });
    } catch {
      scheduleReconnect();
    }
  }

  connect(false);

  return {
    get connected() {
      return connected;
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      listeners.clear();
      stopStream?.();
      timers.clear(debounceTimer);
      timers.clear(retryTimer);
    },
  };
}
