// The guest's bell: the members' notification store over the guest API, which serves
// /api/guest/me and the guest stream. The session is a cookie, so the store's token only says
// someone is signed in.
import { createNotificationsStore } from '../notifications/notifications.js';
import { guestApi } from './guest-client.js';

export const guestNotificationsStore = createNotificationsStore({ apiClient: guestApi, authSession: { state: { token: 'guest-session' } } });
