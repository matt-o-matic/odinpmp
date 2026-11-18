import { reactive } from 'vue';

// Which optional modules the signed-in person's workspace has on. The navigation shows
// Engagements only while the Consulting module is on. Loaded once per workspace; an admin's
// switch updates it at once, and everyone else sees a switch on their next page load.
export function createWorkspaceModulesStore({ apiClient, authSession }) {
  const state = reactive({ consulting: false, loaded: false, tenantId: null });
  let inFlight = null;

  function apply(modules = []) {
    state.consulting = modules.some((entry) => entry.key === 'consulting' && entry.enabled === true);
  }

  async function load({ force = false } = {}) {
    const tenantId = authSession.state.currentUser?.tenantId ?? null;
    if (!authSession.state.isAuthenticated || !tenantId) {
      Object.assign(state, { consulting: false, loaded: false, tenantId: null });
      return state;
    }
    if (!force && state.loaded && state.tenantId === tenantId) return state;
    if (inFlight) return inFlight;
    inFlight = apiClient.passive.getWorkspaceModules(authSession.state.token)
      .then((result) => {
        apply(result?.modules);
        Object.assign(state, { loaded: true, tenantId });
        return state;
      })
      // Off when the switch cannot be read: nothing of the module shows.
      .catch(() => {
        Object.assign(state, { consulting: false, loaded: true, tenantId });
        return state;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { apply, load, state };
}
