import { apiClient, authSession } from '../auth/index.js';
import { createAssistantStore } from './assistant-store.js';

export const assistantStore = createAssistantStore({
  apiClient,
  authSession,
});
