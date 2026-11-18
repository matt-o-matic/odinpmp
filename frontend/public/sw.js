const SHELL_CACHE = 'odin-pmp-shell-v4';
const SHELL_URL = '/app/';
// Odin Chat (/app/chat/) installs as its own app with its own manifest and icons; this worker's
// /app/ scope covers it too.
const PRECACHE = ['/app/manifest.webmanifest', '/app/chat.webmanifest', '/app/favicon.svg', '/app/brand/odin-mark.png', '/app/brand/odin-mark-192.png', '/app/brand/odin-mark-512.png', '/app/brand/odin-chat-192.png', '/app/brand/odin-chat-512.png'];

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const shell = await fetch(SHELL_URL, { cache: 'reload' });
  if (!shell.ok) throw new Error('Application shell could not be cached.');
  await cache.put(SHELL_URL, shell.clone());
  const html = await shell.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+)"/g)].map((match) => match[1]);
  await cache.addAll([...PRECACHE, ...new Set(assets)]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' && url.pathname.startsWith('/app/')) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) void caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, response.clone()));
      return response;
    }).catch(() => caches.match(SHELL_URL)));
    return;
  }

  if (url.pathname.startsWith('/app/assets/') || url.pathname.startsWith('/app/brand/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) void caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
  }
});

// Web Push (docs/odin-chat/plan.md, Delivery: Push). The server sends { title, body, url, tag,
// notificationId }; the same tag replaces an earlier one, so a busy channel shows one entry.
self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  // Open Odin tabs are told too: a hidden tab has no live stream, and its title and bell count
  // should show the new notification now (lib/notifications/notifications.js).
  const tellTabs = self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((tabs) => tabs.forEach((tab) => tab.postMessage({ type: 'odin-notification' })))
    .catch(() => null);
  event.waitUntil(Promise.all([self.registration.showNotification(message.title || 'Odin', {
    badge: '/app/brand/odin-mark-192.png',
    body: message.body || '',
    data: { notificationId: message.notificationId ?? null, url: message.url || SHELL_URL },
    icon: '/app/brand/odin-mark-192.png',
    renotify: Boolean(message.tag),
    tag: message.tag || undefined,
  }), tellTabs]));
});

// Asks an open tab to show the address without loading the page again
// (lib/notifications/open-from-push.js). True when the tab answers in time.
function openInTab(tab, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    tab.postMessage({ type: 'odin-open', url }, [channel.port2]);
  });
}

// Opening a push opens its item: in an Odin tab already open if there is one, in place, else a
// new one. A tab that doesn't answer loads the address. Only addresses inside the app are opened.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = new URL(event.notification.data?.url || SHELL_URL, self.location.origin);
  const target = wanted.origin === self.location.origin && wanted.pathname.startsWith('/app/') ? wanted.href : new URL(SHELL_URL, self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    const tab = tabs.find((client) => new URL(client.url).pathname.startsWith('/app/'));
    if (tab) {
      await tab.focus();
      if (await openInTab(tab, target)) return null;
      return tab.navigate ? tab.navigate(target) : null;
    }
    return self.clients.openWindow(target);
  })());
});
