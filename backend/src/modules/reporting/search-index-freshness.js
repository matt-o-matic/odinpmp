import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';

export const DEFAULT_SEARCH_INDEX_MAX_AGE_MS = 5 * 60_000;

// Per repository instance so separate apps (and tests) sharing a tenant id don't share state.
const trackers = new WeakMap();

function trackerFor(repository) {
  let tracker = trackers.get(repository);
  if (!tracker) {
    tracker = { attempts: new Map(), inflight: new Map() };
    trackers.set(repository, tracker);
  }
  return tracker;
}

// Rebuilds a tenant's search index when its newest row is older than maxAgeMs. Concurrent
// searches in one process share a single rebuild, and a failed rebuild is not retried until
// maxAgeMs has passed, so a broken source can't turn every search into a full rebuild.
// Failures leave the existing index in place; the caller still searches it.
export async function ensureSearchIndexFresh({ maxAgeMs = DEFAULT_SEARCH_INDEX_MAX_AGE_MS, now = () => Date.now(), refresh, repository, tenantId }) {
  if (!repository?.getSearchIndexFreshness || !(maxAgeMs > 0)) return { refreshed: false, status: 'disabled' };
  const tracker = trackerFor(repository);
  const pending = tracker.inflight.get(tenantId);
  if (pending) return pending;
  if (now() - (tracker.attempts.get(tenantId) ?? 0) < maxAgeMs) return { refreshed: false, status: 'recently-attempted' };

  const run = (async () => {
    try {
      const indexedAt = await repository.getSearchIndexFreshness({ tenantId });
      if (indexedAt && now() - Date.parse(indexedAt) < maxAgeMs) return { refreshed: false, status: 'fresh' };
      tracker.attempts.set(tenantId, now());
      await refresh();
      return { refreshed: true, status: 'refreshed' };
    } catch (error) {
      logBackendError({ context: buildOperationLogContext('reporting.search.refresh', { tenantId }), error, level: 'warn', message: 'Search index refresh failed; serving the existing index.' });
      return { refreshed: false, status: 'stale' };
    } finally {
      tracker.inflight.delete(tenantId);
    }
  })();
  tracker.inflight.set(tenantId, run);
  return run;
}
