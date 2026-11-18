// Clicking a push opens its post in an Odin tab that is already open, without loading the page
// again (public/sw.js, notificationclick). The service worker sends the address with a reply
// port; the page answers on it and moves there in the app. A page that doesn't answer is
// reloaded on the address instead.

export const OPEN_FROM_PUSH_MESSAGE = 'odin-open';

/** The app route for an address inside the app ("/chat/…?post=…"), or null for anything else. */
export function appRouteFor(url, { base = '/app/', origin }) {
  let target;
  try {
    target = new URL(String(url ?? ''), origin);
  } catch {
    return null;
  }
  if (target.origin !== origin || !target.pathname.startsWith(base)) return null;
  return `/${target.pathname.slice(base.length)}${target.search}${target.hash}`;
}

export function listenForPushOpens({ base = '/app/', container, origin, router }) {
  if (!container?.addEventListener) return () => {};
  const onMessage = (event) => {
    if (event?.data?.type !== OPEN_FROM_PUSH_MESSAGE) return;
    const path = appRouteFor(event.data.url, { base, origin });
    if (!path) return;
    event.ports?.[0]?.postMessage({ opened: true });
    void Promise.resolve(router.push(path)).catch(() => null);
  };
  container.addEventListener('message', onMessage);
  return () => container.removeEventListener('message', onMessage);
}
