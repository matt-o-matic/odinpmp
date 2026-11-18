// Listens on the project event stream for requirements invalidations and reports them in
// debounced batches. A dropped stream reconnects with backoff; the first batch after a
// reconnect is flagged so the caller refetches everything it may have missed.

export const REQUIREMENTS_EVENT_PREFIX = 'requirements.';

export const REQUIREMENTS_EVENT_TYPES = Object.freeze({
  decisions: 'requirements.decisions.invalidated',
  links: 'requirements.links.invalidated',
  packages: 'requirements.packages.invalidated',
  // Track plans: { track, planId, version, reason }. Team only.
  plans: 'requirements.plans.invalidated',
  // Feedback inside a round (annotations, verdicts, answers): { roundId, screenId?, annotationId? }.
  review: 'requirements.review.updated',
  // Round lifecycle, reviewers, and submissions: { roundId, track }.
  rounds: 'requirements.rounds.invalidated',
  summary: 'requirements.summary.updated',
  topics: 'requirements.topics.invalidated',
});

export function isRequirementsEvent(type) {
  return typeof type === 'string' && type.startsWith(REQUIREMENTS_EVENT_PREFIX);
}

function emptyBatch() {
  return { packageIds: [], reconnected: false, topicIds: [], tracks: [], types: [] };
}

function addUnique(list, value) {
  if (value != null && value !== '' && !list.includes(value)) list.push(value);
}

/** Merges one event into a pending batch. Exported for tests. */
export function mergeRequirementsEvent(batch, { data = {}, type = '' } = {}) {
  const next = batch ?? emptyBatch();
  addUnique(next.types, type);
  for (const topicId of Array.isArray(data?.topicIds) ? data.topicIds : []) addUnique(next.topicIds, topicId);
  for (const packageId of Array.isArray(data?.packageIds) ? data.packageIds : []) addUnique(next.packageIds, packageId);
  if (data?.scopeType === 'topic') addUnique(next.topicIds, data.scopeId);
  // `roundIds` appears once an event names a round, so batches without rounds keep their shape.
  const roundId = data?.roundId ?? roundIdOfSummaryScope(data);
  if (roundId != null && roundId !== '') {
    if (!Array.isArray(next.roundIds)) next.roundIds = [];
    addUnique(next.roundIds, roundId);
  }
  addUnique(next.tracks, data?.track ?? null);
  return next;
}

/** The round a round or screen summary belongs to (screen scope ids are `<roundId>:<screenId>`). */
function roundIdOfSummaryScope(data = {}) {
  if (data?.scopeType === 'round') return data.scopeId ?? null;
  if (data?.scopeType === 'screen') {
    const value = String(data.scopeId ?? '');
    const separator = value.indexOf(':');
    return separator > 0 ? value.slice(0, separator) : null;
  }
  return null;
}

// Events that never change a topic's page. Round and review events cover rounds only:
// publishing creates topics and closing records a decision, and each of those publishes
// its own topics or decisions event. Annotation saves are frequent, so they must not
// refetch topic pages.
const NON_TOPIC_TYPES = new Set([
  REQUIREMENTS_EVENT_TYPES.links,
  REQUIREMENTS_EVENT_TYPES.packages,
  REQUIREMENTS_EVENT_TYPES.plans,
  REQUIREMENTS_EVENT_TYPES.review,
  REQUIREMENTS_EVENT_TYPES.rounds,
]);

export function isTopicEventType(type) {
  return !NON_TOPIC_TYPES.has(type);
}

/** True when the only topic-relevant events in a batch are Odin summaries of rounds or screens. */
function onlyRoundSummaries(batch) {
  const types = batch.types.filter(isTopicEventType);
  return types.length === 1
    && types[0] === REQUIREMENTS_EVENT_TYPES.summary
    && batch.topicIds.length === 0
    && (batch.roundIds ?? []).length > 0;
}

/** True when a batch may change one topic's page (or anything, after a reconnect). */
export function batchTouchesTopic(batch, topicId) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  if (!batch.types.some(isTopicEventType)) return false;
  if (onlyRoundSummaries(batch)) return false;
  // Events that name no topic (a preference accepted) may still matter, so refetch.
  return batch.topicIds.length === 0 || batch.topicIds.includes(topicId);
}

/** True when a batch may change a track's register or decision log. */
export function batchTouchesTrack(batch, track) {
  if (!batch) return false;
  if (batch.reconnected || batch.tracks.length === 0) return true;
  return batch.tracks.includes(track);
}

/** Like batchTouchesTrack, but false for batches that only carry link, package, round, or review changes. */
export function batchTouchesTopicList(batch, track) {
  if (!batchTouchesTrack(batch, track)) return false;
  if (batch.reconnected) return true;
  return batch.types.some(isTopicEventType) && !onlyRoundSummaries(batch);
}

export function batchHasType(batch, type) {
  return Boolean(batch?.reconnected) || Boolean(batch?.types?.includes(type));
}

/** True when a batch may change a track's package list. */
export function batchTouchesPackages(batch, track) {
  if (!batchHasType(batch, REQUIREMENTS_EVENT_TYPES.packages)) return false;
  return batchTouchesTrack(batch, track);
}

/**
 * True when a batch may change the workspace overview or My open items. Feedback inside a
 * round (annotation saves, verdicts, answers) changes neither, and arrives often while
 * people review, so a batch of only those skips the reload.
 */
export function batchNeedsSharedRefresh(batch) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  return (batch.types ?? []).some((type) => type !== REQUIREMENTS_EVENT_TYPES.review);
}

/**
 * True when a batch may change a track's plans: a plan event for the track, or a decision
 * (a plan's citations go stale when a decision it cites is superseded).
 */
export function batchTouchesPlans(batch, track) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  const types = batch.types ?? [];
  if (!types.includes(REQUIREMENTS_EVENT_TYPES.plans) && !types.includes(REQUIREMENTS_EVENT_TYPES.decisions)) return false;
  return batchTouchesTrack(batch, track);
}

/** True when a batch may change a track's rounds list (published, closed, reviewers, submissions). */
export function batchTouchesRounds(batch, track) {
  if (!batchHasType(batch, REQUIREMENTS_EVENT_TYPES.rounds)) return false;
  return batchTouchesTrack(batch, track);
}

/**
 * True when a batch may change one round's page: its lifecycle and reviewers, feedback in
 * it, an Odin summary of it or one of its screens, or a decision (accepting a proposed
 * preference removes it from the round's list).
 */
export function batchTouchesRound(batch, roundId) {
  if (!batch) return false;
  if (batch.reconnected) return true;
  const types = batch.types ?? [];
  const roundIds = batch.roundIds ?? [];
  const named = roundIds.length === 0 || roundIds.includes(roundId);
  if (types.includes(REQUIREMENTS_EVENT_TYPES.rounds) || types.includes(REQUIREMENTS_EVENT_TYPES.review)) {
    if (named) return true;
  }
  if (types.includes(REQUIREMENTS_EVENT_TYPES.summary) && roundIds.includes(roundId)) return true;
  if (types.includes(REQUIREMENTS_EVENT_TYPES.decisions)) return true;
  return false;
}

/** True when a batch may change one package (its status, after a withdrawal). */
export function batchTouchesPackage(batch, packageId) {
  if (!batchHasType(batch, REQUIREMENTS_EVENT_TYPES.packages)) return false;
  if (batch.reconnected || (batch.packageIds ?? []).length === 0) return true;
  return batch.packageIds.includes(packageId);
}

export function createRequirementsLiveUpdates({
  apiClient,
  debounceMs = 250,
  getToken,
  onChange,
  projectId,
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

  function schedule() {
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
    if (!token || typeof apiClient?.subscribeToProjectEvents !== 'function') {
      scheduleReconnect();
      return;
    }

    stopStream = apiClient.subscribeToProjectEvents(projectId, token, {
      onClose: scheduleReconnect,
      onError: scheduleReconnect,
      onEvent({ data, resumed, type }) {
        if (type === 'connected') {
          attempts = 0;
          // `resumed`: the shared stream opened again after the tab was hidden.
          if (isReconnect || resumed) {
            pending = pending ?? emptyBatch();
            pending.reconnected = true;
            schedule();
          }
          return;
        }
        if (!isRequirementsEvent(type)) return;
        pending = mergeRequirementsEvent(pending, { data, type });
        schedule();
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
