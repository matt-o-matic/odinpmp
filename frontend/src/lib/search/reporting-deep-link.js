// /reports keeps its project filter and tab in the URL: ?projectId=<id>&tab=<tab>.

export const REPORTING_TABS = Object.freeze(['dashboards', 'search', 'reports', 'views', 'subscriptions', 'runs']);
export const DEFAULT_REPORTING_TAB = 'dashboards';

function single(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function reportingStateFromQuery(query = {}) {
  const projectId = String(single(query.projectId) ?? '').trim();
  const tab = String(single(query.tab) ?? '').trim().toLowerCase();
  return { projectId, tab: REPORTING_TABS.includes(tab) ? tab : DEFAULT_REPORTING_TAB };
}

/** The current query with the project and tab replaced; defaults are left out. */
export function reportingQueryFor(query = {}, { projectId = '', tab = DEFAULT_REPORTING_TAB } = {}) {
  const next = { ...query };
  delete next.projectId;
  delete next.tab;
  if (projectId) next.projectId = projectId;
  if (tab && tab !== DEFAULT_REPORTING_TAB) next.tab = tab;
  return next;
}
