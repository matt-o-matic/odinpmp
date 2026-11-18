import { apiActivity } from '../api/activity-tracker.js';
import { createApiClient } from '../api/client.js';
import { resolveApiBaseUrl } from '../api/base-url.js';
import { createSessionStore } from './session.js';

const apiClient = createApiClient({
  activityTracker: apiActivity,
  baseUrl: resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    configuredBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
    mode: import.meta.env.DEV ? 'development' : 'production',
  }),
});

export const authSession = createSessionStore({
  appBaseUrl: import.meta.env.BASE_URL ?? '/',
  apiClient,
});

apiClient.setSessionRefreshHandler((failedToken) => authSession.refreshSession(failedToken));

apiClient.setUnauthorizedHandler(() => {
  authSession.handleUnauthorized();
});

export { apiClient };
