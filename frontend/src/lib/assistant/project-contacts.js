import { reactive } from 'vue';

import { apiClient, authSession } from '../auth/index.js';
import { withWorkingMode } from '../api/client.js';

// A project's clarifications and stakeholder contacts, shared by the Stakeholders panel and the
// Requirements stakeholder pickers. Reloads when the project's assets change.
export function createProjectContactsStore({ api = apiClient, session = authSession } = {}) {
  const state = reactive({
    clarifications: [],
    errorMessage: '',
    projectId: null,
    stakeholders: [],
  });
  let unsubscribe = null;
  let reloading = null;

  function apply(result) {
    state.clarifications = result?.clarifications ?? [];
    state.stakeholders = result?.stakeholders ?? result?.stakeholderContacts ?? [];
  }

  function watchProject(projectId) {
    unsubscribe?.();
    unsubscribe = null;
    if (!projectId || !api.subscribeToProjectEvents) return;
    unsubscribe = api.subscribeToProjectEvents(projectId, session.state.token, {
      onEvent(event) {
        if ((event?.type ?? event?.data?.type) === 'project.assets.invalidated' && state.projectId === projectId) void reload(projectId);
      },
    });
  }

  async function reload(projectId) {
    if (!projectId || reloading) return reloading;
    reloading = withWorkingMode(api, 'passive').getProjectAssistantClarifications(projectId, session.state.token)
      .then((result) => { if (state.projectId === projectId) apply(result); return result; })
      .finally(() => { reloading = null; });
    return reloading;
  }

  return {
    state,
    async load(projectId) {
      state.errorMessage = '';
      if (state.projectId !== projectId) {
        state.projectId = projectId ?? null;
        apply({});
        watchProject(projectId);
      }
      try {
        const result = await api.getProjectAssistantClarifications(projectId, session.state.token);
        apply(result);
        return result;
      } catch (error) {
        state.errorMessage = error.message ?? 'Unable to load project clarifications.';
        throw error;
      }
    },
    setStakeholders(stakeholders = []) {
      state.stakeholders = stakeholders;
    },
  };
}

export const projectContacts = createProjectContactsStore();
