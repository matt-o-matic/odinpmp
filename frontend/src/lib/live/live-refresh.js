import { inject, onBeforeUnmount, provide, watch } from 'vue';

import { apiClient, authSession } from '../auth/index.js';
import { createWorkspaceLiveUpdates, deferWhileHidden } from './live-updates.js';

const PROJECT_REFRESH = Symbol('project-refresh-version');

/**
 * While the calling screen is mounted, calls `refresh(batch)` when someone else (a person, the
 * assistant or an MCP client) changes one of `areas` anywhere in the workspace. Refreshes wait
 * while the page is hidden. For screens that span projects; they share one stream per tab.
 */
export function useWorkspaceLiveRefresh(areas, refresh) {
  let stop = null;

  function restart(token) {
    stop?.();
    stop = null;
    if (!token) return;
    const deferred = deferWhileHidden(refresh);
    const stopUpdates = createWorkspaceLiveUpdates({ apiClient, areas, getToken: () => authSession.state.token, onChange: deferred.run });
    stop = () => {
      stopUpdates();
      deferred.stop();
    };
  }

  watch(() => authSession.state.token, restart, { immediate: true });
  onBeforeUnmount(() => {
    stop?.();
    stop = null;
  });
}

/**
 * Gives the panels below a screen (files, comments, related work) a counter that moves when
 * someone else changes the project, so they need no stream of their own.
 */
export function provideProjectRefresh(version) {
  provide(PROJECT_REFRESH, version);
}

/** Calls `refresh` each time the counter from provideProjectRefresh moves. */
export function onProjectRefresh(refresh) {
  const version = inject(PROJECT_REFRESH, null);
  if (version) watch(version, () => refresh());
}
