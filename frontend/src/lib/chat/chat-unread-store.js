import { reactive } from 'vue';

import { createLiveUpdates, deferWhileHidden } from '../live/live-updates.js';
import { NOTIFICATION_CREATED_EVENT, NOTIFICATION_READ_EVENT } from '../notifications/notifications.js';

// The Chat badge in Odin proper's top bar: unread posts in the
// person's channels and direct messages, from /api/chat/unread. It reads the count once on start,
// then again only when the person's own stream (GET /api/me/events, the one the bell opens)
// says one of their notifications was made or read, and when Odin Chat reports its totals. No
// other workspace activity makes it ask.
export function createChatUnreadStore({ api, debounceMs = 300, session }) {
  const state = reactive({ loaded: false, mentions: 0, unread: 0 });
  let stop = null;
  let run = 0;

  async function refresh() {
    const token = session.state.token;
    if (!session.state.isAuthenticated || !token) {
      Object.assign(state, { loaded: false, mentions: 0, unread: 0 });
      return state;
    }
    const mine = ++run;
    try {
      const totals = await api.passive.getChatUnread(token);
      if (mine === run) Object.assign(state, { loaded: true, mentions: Number(totals?.mentions ?? 0), unread: Number(totals?.unread ?? 0) });
    } catch {
      // The badge keeps its last count.
    }
    return state;
  }

  /** Puts in the totals a screen already has (Odin Chat's sidebar), without a request. */
  function apply(totals) {
    if (!totals) return;
    Object.assign(state, { loaded: true, mentions: Number(totals.mentions ?? 0), unread: Number(totals.unread ?? 0) });
  }

  function start() {
    stop?.();
    stop = null;
    if (!session.state.isAuthenticated || !session.state.token) return;
    void refresh();
    const deferred = deferWhileHidden(() => { void refresh(); });
    const stops = [NOTIFICATION_CREATED_EVENT, NOTIFICATION_READ_EVENT].map((eventType) => createLiveUpdates({
      debounceMs,
      eventType,
      getToken: () => session.state.token,
      onChange: deferred.run,
      open: (token, handlers) => api.subscribeToMyEvents(token, handlers),
    }));
    stop = () => {
      for (const stopUpdates of stops) stopUpdates();
      deferred.stop();
    };
  }

  function end() {
    stop?.();
    stop = null;
    Object.assign(state, { loaded: false, mentions: 0, unread: 0 });
  }

  return { apply, end, refresh, start, state };
}
