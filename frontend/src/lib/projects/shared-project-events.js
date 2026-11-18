// Shares one project event stream among every listener in the tab. The project page, the
// assistant store, and the Requirements tab each subscribe to the same project; without
// sharing that is three long-lived requests for the same events.
//
// `open(key, handlers)` opens the real stream and returns a stop function. Listeners get
// the same callbacks they would from their own stream: every event, then onClose or onError
// once when the stream ends. A listener that joins after the stream connected gets the
// `connected` event replayed, so reconnect logic that waits for it still works.
//
// Given `document`, the streams close while the tab is hidden and open again when it shows.
// Each stream holds a connection, and over HTTP/1.1 a browser opens at most 6 to a host for
// all its tabs together. A chat page holds 3, so two open tabs used all 6, and the next
// request (the channel's messages) waited for a free connection that never came. The listeners
// stay subscribed. The first `connected` event after the stream opens again has
// `resumed: true`, so they can fetch again what changed while the tab was hidden.

export function createSharedEventStreams({ defer = (callback) => queueMicrotask(callback), document: doc = null, open }) {
  const streams = new Map();
  const hidden = () => Boolean(doc?.hidden);

  function deliver(listener, method, payload) {
    try {
      listener[method]?.(payload);
    } catch (error) {
      // One listener's failure must not end the stream for the others.
      defer(() => {
        throw error;
      });
    }
  }

  function end(key, entry, method, payload) {
    if (entry.ended) return;
    entry.ended = true;
    if (streams.get(key) === entry) streams.delete(key);
    const listeners = [...entry.listeners];
    entry.listeners.clear();
    for (const listener of listeners) deliver(listener, method, payload);
  }

  // Opens the real stream. Callbacks from a stream that was since closed for a hidden tab
  // are ignored: `run` changes each time the stream opens or pauses.
  function start(key, entry, { resumed = false } = {}) {
    const run = ++entry.run;
    const current = () => entry.run === run && !entry.ended;
    let markResumed = resumed;
    entry.stop = open(key, {
      onClose: () => { if (current()) end(key, entry, 'onClose'); },
      onError: (error) => { if (current()) end(key, entry, 'onError', error); },
      onEvent: (event) => {
        if (!current()) return;
        let shown = event;
        if (event?.type === 'connected') {
          entry.connected = event;
          if (markResumed) shown = { ...event, resumed: true };
          markResumed = false;
        }
        for (const listener of [...entry.listeners]) deliver(listener, 'onEvent', shown);
      },
    });
  }

  function pause(entry) {
    if (entry.ended || entry.paused) return;
    entry.paused = true;
    entry.run += 1;
    entry.connected = null;
    const stop = entry.stop;
    entry.stop = null;
    stop?.();
  }

  function resume(key, entry) {
    if (entry.ended || !entry.paused) return;
    entry.paused = false;
    try {
      start(key, entry, { resumed: true });
    } catch (error) {
      end(key, entry, 'onError', error);
    }
  }

  doc?.addEventListener?.('visibilitychange', () => {
    for (const [key, entry] of [...streams]) {
      if (hidden()) pause(entry);
      else resume(key, entry);
    }
  });

  function subscribe(key, handlers = {}) {
    let entry = streams.get(key);
    if (!entry) {
      const created = { connected: null, ended: false, listeners: new Set(), paused: false, run: 0, stop: null };
      entry = created;
      streams.set(key, created);
      if (hidden()) {
        // A tab opened in the background connects when it is first shown.
        created.paused = true;
      } else {
        try {
          start(key, created);
        } catch (error) {
          streams.delete(key);
          throw error;
        }
      }
    }

    const current = entry;
    const listener = { onClose: handlers.onClose, onError: handlers.onError, onEvent: handlers.onEvent };
    current.listeners.add(listener);
    if (current.connected) {
      const connected = current.connected;
      defer(() => {
        if (current.listeners.has(listener)) deliver(listener, 'onEvent', connected);
      });
    }

    return () => {
      if (!current.listeners.delete(listener)) return;
      if (current.listeners.size > 0 || current.ended) return;
      current.ended = true;
      if (streams.get(key) === current) streams.delete(key);
      current.stop?.();
    };
  }

  return {
    get size() {
      return streams.size;
    },
    subscribe,
  };
}
