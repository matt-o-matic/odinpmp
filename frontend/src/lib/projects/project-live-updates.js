import { createLiveUpdates } from '../live/live-updates.js';

// Subscribes to a project's live event stream and reports batched changes made elsewhere.
// Events this tab caused are skipped. A dropped stream reconnects with backoff, and the
// first batch after a reconnect is flagged so callers can refetch anything they missed.

const PROJECT_CHANGED_EVENT = 'project.assets.invalidated';

export function createProjectLiveUpdates({ apiClient, projectId, ...options }) {
  return createLiveUpdates({
    ...options,
    eventType: PROJECT_CHANGED_EVENT,
    open: (token, handlers) => apiClient.subscribeToProjectEvents(projectId, token, handlers),
    ownClientId: apiClient.clientId,
  });
}

export function describeLiveUpdateActors(actors = []) {
  const names = actors.map((actor) => actor?.name).filter(Boolean);
  if (names.length === 0) return 'Someone';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others`;
}
