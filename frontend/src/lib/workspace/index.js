import { apiClient, authSession } from '../auth/index.js';
import { createWorkspaceModulesStore } from './workspace-modules.js';

export const workspaceModules = createWorkspaceModulesStore({ apiClient, authSession });
