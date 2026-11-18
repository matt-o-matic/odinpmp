import { reactive } from 'vue';

import { createLiveUpdates } from '../live/live-updates.js';

// The bell's state: the person's notifications, the unread count in the tab title, live
// updates from GET /api/me/events, the focus heartbeat that keeps push away while a tab is
// focused, and device push through the service worker. One store per tab, shared by every bell
// (Odin proper's top bar now, Odin Chat's header later): start() and stop() count their
// callers.

export const NOTIFICATION_CREATED_EVENT = 'notification.created';
export const NOTIFICATION_READ_EVENT = 'notification.read';
export const FOCUS_HEARTBEAT_MS = 25_000;
// A hidden tab closes its live streams (lib/projects/shared-project-events.js), so it checks for
// new notifications this often instead, and keeps the count in its title current.
export const HIDDEN_CHECK_MS = 30_000;
// What the service worker tells open tabs when a push arrives (public/sw.js).
export const PUSH_ARRIVED_MESSAGE = 'odin-notification';
const TITLE_COUNT = /^\(\d+\+?\) /;

/** "(3) Odin" for 3 unread, the bare title for none; any earlier count is replaced. */
export function titleWithCount(title, count) {
  const bare = String(title ?? '').replace(TITLE_COUNT, '');
  const value = Number(count ?? 0);
  if (!(value > 0)) return bare;
  return `(${value > 99 ? '99+' : value}) ${bare}`;
}

/** "3", or "99+" past 99; empty for none. */
export function badgeLabel(count) {
  const value = Number(count ?? 0);
  if (!(value > 0)) return '';
  return value > 99 ? '99+' : String(value);
}

export const SYSTEM_GROUP_ID = 'system';
export const DIRECT_GROUP_ID = 'direct';

/**
 * Notifications grouped by the project or engagement they belong to, each group newest first,
 * groups by their newest entry. Direct messages have their own group; anything else without a
 * project goes under System, always last.
 */
export function groupByProject(notifications = []) {
  const sorted = [...notifications].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const groups = new Map();
  for (const entry of sorted) {
    const [id, label] = entry.projectId
      ? [`project:${entry.projectId}`, entry.projectName || 'Project']
      : (entry.conversationId || entry.kind === 'direct_message' ? [DIRECT_GROUP_ID, 'Direct messages'] : [SYSTEM_GROUP_ID, 'System']);
    if (!groups.has(id)) groups.set(id, { entries: [], id, label, unreadCount: 0 });
    const group = groups.get(id);
    group.entries.push(entry);
    if (!entry.readAt) group.unreadCount += 1;
  }
  const list = [...groups.values()];
  return [...list.filter((group) => group.id !== SYSTEM_GROUP_ID), ...list.filter((group) => group.id === SYSTEM_GROUP_ID)];
}

/** "10:42" today; "12 Nov" before. */
export function notificationTimeLabel(value, now = new Date()) {
  const at = new Date(value ?? '');
  if (Number.isNaN(at.valueOf())) return '';
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return today
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** A VAPID public key (base64url) as the bytes PushManager.subscribe takes. */
export function applicationServerKey(publicKey) {
  const padded = String(publicKey).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(publicKey).length / 4) * 4, '=');
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function createNotificationsStore({
  apiClient,
  authSession,
  doc = globalThis.document,
  nav = globalThis.navigator,
  timers = { clear: (id) => clearInterval(id), every: (callback, ms) => setInterval(callback, ms) },
  win = globalThis.window,
}) {
  const state = reactive({
    error: '',
    loaded: false,
    notifications: [],
    push: { available: false, busy: false, enabled: false, error: '', publicKey: '', supported: false },
    unreadCount: 0,
  });
  let users = 0;
  let stops = [];
  let loading = null;
  let heartbeat = null;
  let hiddenCheck = null;
  let titleObserver = null;

  const token = () => authSession.state.token;
  const passive = () => apiClient.passive ?? apiClient;

  function applyTitle() {
    if (!doc) return;
    const next = titleWithCount(doc.title, state.unreadCount);
    if (doc.title !== next) doc.title = next;
  }

  function apply(result) {
    state.notifications = result?.notifications ?? [];
    state.unreadCount = Number(result?.unreadCount ?? 0);
    state.loaded = true;
    state.error = '';
    applyTitle();
  }

  async function load() {
    if (!token()) return;
    if (loading) return loading;
    loading = passive().listNotifications(token())
      .then(apply)
      .catch(() => { state.error = 'Notifications could not load.'; })
      .finally(() => { loading = null; });
    return loading;
  }

  async function markRead(ids) {
    if (!ids.length || !token()) return;
    const wanted = new Set(ids);
    const at = new Date().toISOString();
    state.notifications = state.notifications.map((entry) => (wanted.has(entry.id) && !entry.readAt ? { ...entry, readAt: at } : entry));
    const result = await passive().markNotificationsRead({ ids }, token()).catch(() => null);
    if (result) state.unreadCount = Number(result.unreadCount ?? 0);
    applyTitle();
  }

  async function markAllRead() {
    if (!token()) return;
    const result = await passive().markNotificationsRead({ all: true }, token()).catch(() => null);
    if (!result) { state.error = 'Notifications could not be marked read. Try again.'; return; }
    const at = new Date().toISOString();
    state.notifications = state.notifications.map((entry) => (entry.readAt ? entry : { ...entry, readAt: at }));
    state.unreadCount = Number(result.unreadCount ?? 0);
    applyTitle();
  }

  // --- the focus heartbeat ------------------------------------------------------------------
  const focused = () => Boolean(doc?.hasFocus?.()) && doc?.visibilityState !== 'hidden';
  function sendFocus(value) {
    if (token()) void passive().sendNotificationFocus(value, token()).catch(() => null);
  }
  function onFocusChange() {
    timers.clear(heartbeat);
    heartbeat = null;
    if (focused()) {
      sendFocus(true);
      heartbeat = timers.every(() => (focused() ? sendFocus(true) : onFocusChange()), FOCUS_HEARTBEAT_MS);
    } else {
      sendFocus(false);
    }
  }

  // A page that unloads (a reload, a link that loads a new page, a closed tab) is no longer
  // focused. Without saying so, its last heartbeat would hold pushes back for up to a minute,
  // since the server notices its closed stream only on the next write.
  function onPageHide() {
    timers.clear(heartbeat);
    heartbeat = null;
    if (token()) void passive().sendNotificationFocus(false, token(), { leaving: true }).catch(() => null);
  }

  // --- while the tab is hidden -----------------------------------------------------------------
  function checkWhileHidden() {
    timers.clear(hiddenCheck);
    hiddenCheck = null;
    if (doc?.visibilityState === 'hidden') hiddenCheck = timers.every(() => { void load(); }, HIDDEN_CHECK_MS);
  }
  function onVisibilityChange() {
    onFocusChange();
    checkWhileHidden();
  }
  // A push reached this device: the count is fetched now, not at the next check.
  function onWorkerMessage(event) {
    if (event?.data?.type === PUSH_ARRIVED_MESSAGE) void load();
  }

  // --- device push ----------------------------------------------------------------------------
  async function registration() {
    if (!nav?.serviceWorker?.getRegistration) return null;
    return (await nav.serviceWorker.getRegistration().catch(() => null)) ?? null;
  }

  async function loadPush() {
    const config = await passive().getPushConfig(token()).catch(() => null);
    const worker = await registration();
    state.push.available = Boolean(config?.available);
    state.push.publicKey = config?.publicKey ?? '';
    state.push.supported = Boolean(worker?.pushManager && win?.Notification);
    const existing = state.push.supported ? await worker.pushManager.getSubscription().catch(() => null) : null;
    state.push.enabled = Boolean(existing) && win?.Notification?.permission === 'granted';
  }

  async function enablePush() {
    if (state.push.busy) return;
    state.push.busy = true;
    state.push.error = '';
    try {
      const permission = await win.Notification.requestPermission();
      if (permission !== 'granted') {
        state.push.error = 'Notifications are blocked for Odin in this browser. Allow them in the browser’s site settings, then try again.';
        return;
      }
      const worker = await registration();
      const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ applicationServerKey: applicationServerKey(state.push.publicKey), userVisibleOnly: true });
      const { endpoint, keys } = subscription.toJSON();
      await apiClient.savePushSubscription({ endpoint, keys: { auth: keys.auth, p256dh: keys.p256dh } }, token());
      state.push.enabled = true;
    } catch {
      state.push.error = 'Device notifications could not be turned on. Try again.';
    } finally {
      state.push.busy = false;
    }
  }

  async function disablePush() {
    if (state.push.busy) return;
    state.push.busy = true;
    state.push.error = '';
    try {
      const subscription = await (await registration())?.pushManager.getSubscription();
      if (subscription) {
        await apiClient.removePushSubscription(subscription.endpoint, token()).catch(() => null);
        await subscription.unsubscribe();
      }
      state.push.enabled = false;
    } catch {
      state.push.error = 'Device notifications could not be turned off. Try again.';
    } finally {
      state.push.busy = false;
    }
  }

  function start() {
    users += 1;
    if (users > 1 || !token()) return;
    void load();
    void loadPush();
    // A dropped stream reconnects with backoff; the first batch after it refetches the count.
    for (const eventType of [NOTIFICATION_CREATED_EVENT, NOTIFICATION_READ_EVENT]) {
      stops.push(createLiveUpdates({ debounceMs: 150, eventType, getToken: token, onChange: () => { void load(); }, open: (value, handlers) => apiClient.subscribeToMyEvents(value, handlers) }));
    }
    if (win?.addEventListener) {
      win.addEventListener('focus', onFocusChange);
      win.addEventListener('blur', onFocusChange);
      win.addEventListener('pagehide', onPageHide);
      doc?.addEventListener?.('visibilitychange', onVisibilityChange);
      stops.push(() => {
        win.removeEventListener('focus', onFocusChange);
        win.removeEventListener('blur', onFocusChange);
        win.removeEventListener('pagehide', onPageHide);
        doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
        timers.clear(heartbeat);
        heartbeat = null;
        timers.clear(hiddenCheck);
        hiddenCheck = null;
      });
      onVisibilityChange();
    }
    if (nav?.serviceWorker?.addEventListener) {
      nav.serviceWorker.addEventListener('message', onWorkerMessage);
      stops.push(() => nav.serviceWorker.removeEventListener('message', onWorkerMessage));
    }
    // Pages set their own titles; the count goes back in front of each.
    const titleElement = doc?.querySelector?.('title');
    if (titleElement && globalThis.MutationObserver) {
      titleObserver = new MutationObserver(applyTitle);
      titleObserver.observe(titleElement, { characterData: true, childList: true, subtree: true });
    }
  }

  function stop() {
    users = Math.max(0, users - 1);
    if (users > 0) return;
    for (const stopOne of stops) stopOne();
    stops = [];
    titleObserver?.disconnect();
    titleObserver = null;
    state.unreadCount = 0;
    applyTitle();
  }

  return { disablePush, enablePush, load, markAllRead, markRead, start, state, stop };
}
