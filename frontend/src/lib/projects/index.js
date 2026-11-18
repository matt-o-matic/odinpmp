import { apiClient } from '../auth/index.js';
import { authSession } from '../auth/index.js';
import { createProjectStore } from './project-store.js';

export const projectStore = createProjectStore({
  apiClient,
  authSession,
});
