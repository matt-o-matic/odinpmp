// What Odin Chat's shell gives the screens inside it (views/chat): the sidebar's data, a way to
// refetch it, and starting a conversation. Also the Home Screen install: under /app/chat the page
// links Odin Chat's own manifest and icon, so it installs as its own app (docs/odin-chat/plan.md).
import { inject } from 'vue';

export const CHAT_SHELL_KEY = Symbol('chat-shell');
export const CHAT_MANIFEST = '/app/chat.webmanifest';
export const CHAT_TOUCH_ICON = '/app/brand/odin-chat-192.png';
export const CHAT_APP_TITLE = 'Odin Chat';

export function useChatShell() {
  return inject(CHAT_SHELL_KEY, null);
}

/**
 * Points the page's manifest, Home Screen icon and title at Odin Chat's, and returns a function
 * that puts Odin's back. Safari and Chrome read these when the person adds the page to their
 * Home Screen.
 */
export function linkChatInstall(doc = globalThis.document) {
  if (!doc?.head) return () => {};
  const changes = [];
  const set = (selector, attribute, value, create) => {
    let element = doc.head.querySelector(selector);
    const created = !element;
    if (created) {
      element = create();
      doc.head.append(element);
    }
    const previous = element.getAttribute(attribute);
    element.setAttribute(attribute, value);
    changes.push(() => (created ? element.remove() : element.setAttribute(attribute, previous ?? '')));
  };
  set('link[rel="manifest"]', 'href', CHAT_MANIFEST, () => Object.assign(doc.createElement('link'), { rel: 'manifest' }));
  set('link[rel="apple-touch-icon"]', 'href', CHAT_TOUCH_ICON, () => Object.assign(doc.createElement('link'), { rel: 'apple-touch-icon' }));
  set('meta[name="apple-mobile-web-app-title"]', 'content', CHAT_APP_TITLE, () => Object.assign(doc.createElement('meta'), { name: 'apple-mobile-web-app-title' }));
  return () => {
    for (const undo of changes.reverse()) undo();
  };
}
