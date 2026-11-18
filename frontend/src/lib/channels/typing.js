// "Ana is typing…" in channels. The browser sends a signal at most once per
// TYPING_SEND_INTERVAL_MS while someone types, and a stop when the box empties. The server
// publishes `channel.typing` on the project stream (the guest stream for guests) to everyone
// who can read the channel but the typer. Nothing is stored: each screen drops a person
// TYPING_EXPIRY_MS after their last signal.
import { createLiveUpdates } from '../live/live-updates.js';

export const CHANNEL_TYPING_EVENT = 'channel.typing';
export const TYPING_SEND_INTERVAL_MS = 3000;
// Longer than the send interval, so a slow signal does not make the line flicker.
export const TYPING_EXPIRY_MS = 6000;

const realTimers = { clear: (id) => clearTimeout(id), set: (callback, delay) => setTimeout(callback, delay) };

/**
 * Sends typing signals for one box. `update(text)` on every change: text sends `true` at most
 * once per interval; an empty box sends `false` once. `stop()` when the box closes or the message
 * is sent. A failed signal is dropped; the next keypress after the interval tries again.
 */
export function createTypingSender({ intervalMs = TYPING_SEND_INTERVAL_MS, now = () => Date.now(), send }) {
  let active = false;
  let lastSentAt = 0;

  function emit(typing) {
    try {
      Promise.resolve(send(typing)).catch(() => {});
    } catch {
      // Same as a failed request.
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    lastSentAt = 0;
    emit(false);
  }

  return {
    get active() {
      return active;
    },
    stop,
    update(text) {
      if (!String(text ?? '').trim()) {
        stop();
        return;
      }
      const at = now();
      if (active && at - lastSentAt < intervalMs) return;
      active = true;
      lastSentAt = at;
      emit(true);
    },
  };
}

const personKey = (actor) => `${actor?.type ?? ''}:${actor?.id ?? ''}`;

/**
 * Who is typing where, from `channel.typing` events: one entry per person and box (the channel's
 * box, or a thread's by `parentId`). Each entry expires `expiryMs` after its last signal, and goes
 * at once on a stop. `onChange(list)` gets [{ key, name, parentId }] in the order people started.
 */
export function createTypingTracker({ expiryMs = TYPING_EXPIRY_MS, onChange = () => {}, timers = realTimers } = {}) {
  const entries = new Map();

  const list = () => [...entries.entries()].map(([key, entry]) => ({ key, name: entry.name, parentId: entry.parentId }));
  const changed = () => onChange(list());

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    timers.clear(entry.timer);
    entries.delete(key);
    return true;
  }

  return {
    list,
    receive(event) {
      if (!event?.actor?.id) return;
      const parentId = event.parentId ?? null;
      const key = `${parentId ?? ''}|${personKey(event.actor)}`;
      if (!event.typing) {
        if (remove(key)) changed();
        return;
      }
      const entry = entries.get(key);
      if (entry) timers.clear(entry.timer);
      entries.set(key, {
        name: String(event.actor.name ?? '').trim() || 'Someone',
        parentId,
        timer: timers.set(() => {
          if (remove(key)) changed();
        }, expiryMs),
      });
      if (!entry) changed();
    },
    /** Forgets everyone, such as when the channel changes. */
    clear() {
      if (!entries.size) return;
      for (const key of [...entries.keys()]) remove(key);
      changed();
    },
  };
}

/** "Ana is typing…", "Ana and Ben are typing…", "Ana, Ben and Cy are typing…", "Ana, Ben and 2 others are typing…". */
export function typingLabel(names = []) {
  const people = [...new Set(names.filter(Boolean))];
  if (!people.length) return '';
  if (people.length === 1) return `${people[0]} is typing…`;
  if (people.length === 2) return `${people[0]} and ${people[1]} are typing…`;
  if (people.length === 3) return `${people[0]}, ${people[1]} and ${people[2]} are typing…`;
  return `${people[0]}, ${people[1]} and ${people.length - 2} others are typing…`;
}

/** The label for the channel's own box (`parentId` null) or one thread, from a tracker list. */
export function typingLabelFor(list = [], parentId = null) {
  return typingLabel(list.filter((entry) => (entry.parentId ?? null) === (parentId ?? null)).map((entry) => entry.name));
}

/** Whether these channel screens can send and hear typing: channels only, not direct messages. */
export function supportsTyping(api) {
  return typeof api?.sendChannelTyping === 'function'
    && (typeof api.subscribeToEvents === 'function' || typeof api.subscribeToProjectEvents === 'function');
}

/**
 * `channel.typing` events for one channel, through the stream the channel screens already use:
 * the project stream for members, the guest stream for guests. Reconnects as other live
 * updates do. Returns a stop function.
 */
export function createTypingLiveUpdates({ api, channelId, getToken = () => '', onEvent, projectId, timers }) {
  const guest = typeof api.subscribeToEvents === 'function';
  return createLiveUpdates({
    accept: (data) => data?.channelId === channelId,
    debounceMs: 0,
    eventType: CHANNEL_TYPING_EVENT,
    getToken: guest ? () => 'guest' : getToken,
    keepDetails: true,
    onChange: (batch) => {
      for (const event of batch.details ?? []) onEvent(event);
    },
    open: guest
      ? (_token, handlers) => api.subscribeToEvents(handlers)
      : (token, handlers) => api.subscribeToProjectEvents(projectId, token, handlers),
    ownClientId: api.clientId ?? null,
    ...(timers ? { timers } : {}),
  });
}
