import { apiClient, authSession } from '../auth/index.js';
import { createNotificationsStore } from './notifications.js';

export const notificationsStore = createNotificationsStore({ apiClient, authSession });
