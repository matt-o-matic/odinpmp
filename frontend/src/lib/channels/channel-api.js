// Which API the channel screens call (docs/engagements/plan.md, Guests). Members use the app's API
// client, as before. The guest view provides the guest API (lib/guests/guest-api.js) and who is
// looking, so the same conversation, library, comments and viewer serve guests in their channels.
import { inject } from 'vue';

import { apiClient } from '../auth/index.js';

export const CHANNEL_API_KEY = Symbol('channel-api');
export const CHANNEL_VIEWER_KEY = Symbol('channel-viewer');

/** The API for the channel screens: the app's, unless a guest view provided its own. */
export function useChannelApi() {
  return inject(CHANNEL_API_KEY, apiClient);
}

/** In the guest view, { guest: true, fileActorId, name }; null for members. */
export function useChannelViewer() {
  return inject(CHANNEL_VIEWER_KEY, null);
}
