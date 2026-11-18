// Live updates in the guest view (docs/engagements/plan.md, Live updates): batches of
// channel.updated events for the guest's channels, as members get them, from the guest stream.
// A stream the server refuses (signed out, removed from every channel) calls `onEnded`;
// guest.changed (added to or removed from a channel) calls `onAccessChanged`.
import { CHANNEL_UPDATED_EVENT } from '../channels/channels.js';
import { createLiveUpdates } from '../live/live-updates.js';

export const GUEST_CHANGED_EVENT = 'guest.changed';

export function createGuestLiveUpdates({ api, debounceMs = 150, onAccessChanged = () => {}, onChange, onEnded = () => {}, ...options }) {
  return createLiveUpdates({
    ...options,
    debounceMs,
    eventType: CHANNEL_UPDATED_EVENT,
    getToken: () => 'guest',
    keepDetails: true,
    onChange,
    open: (_token, handlers) => api.subscribeToEvents({
      onClose: handlers.onClose,
      onError(error) {
        if (error?.status === 401) onEnded(error);
        handlers.onError(error);
      },
      onEvent(event) {
        if (event?.type === GUEST_CHANGED_EVENT) onAccessChanged();
        handlers.onEvent(event);
      },
    }),
    ownClientId: api.clientId,
  });
}
