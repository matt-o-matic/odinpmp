// The tab's one Chat badge store (chat-unread-store.js), on the app's API client and session.
import { apiClient, authSession } from '../auth/index.js';
import { createChatUnreadStore } from './chat-unread-store.js';

export { createChatUnreadStore };
export const chatUnread = createChatUnreadStore({ api: apiClient, session: authSession });
