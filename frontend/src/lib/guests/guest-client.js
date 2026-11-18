// The tab's one guest API (lib/guests/guest-api.js), on the same API origin the app uses
// (VITE_API_BASE_URL in development).
import { apiClient } from '../auth/index.js';
import { createGuestApi } from './guest-api.js';

export const guestApi = createGuestApi({ baseUrl: apiClient.baseUrl });
