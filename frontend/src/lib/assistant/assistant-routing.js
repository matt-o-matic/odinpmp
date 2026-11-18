export const ASSISTANT_ROUTE_QUERY_KEYS = [
  'assistant',
  'assistantFresh',
  'assistantMode',
  'assistantProjectId',
  'assistantSessionId',
];

function firstQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function isTruthyQueryFlag(value) {
  const normalized = String(firstQueryValue(value) ?? '').trim().toLowerCase();
  if (!normalized) {
    return value != null;
  }

  return ['1', 'true', 'yes', 'open'].includes(normalized);
}

export function parseAssistantRouteQuery(query = {}) {
  const open = isTruthyQueryFlag(query.assistant);
  const sessionId = String(firstQueryValue(query.assistantSessionId) ?? '').trim() || null;
  const projectId = String(firstQueryValue(query.assistantProjectId) ?? '').trim() || null;
  const requestedMode = String(firstQueryValue(query.assistantMode) ?? '').trim();
  const fresh = isTruthyQueryFlag(query.assistantFresh);
  const mode = requestedMode === 'project-context' && projectId ? 'project-context' : 'create-project';

  return {
    fresh,
    mode,
    open,
    projectId: mode === 'project-context' ? projectId : null,
    sessionId,
  };
}

export function buildAssistantRouteQuery(query = {}, state = {}) {
  const nextQuery = { ...query };

  for (const key of ASSISTANT_ROUTE_QUERY_KEYS) {
    delete nextQuery[key];
  }

  if (!state.open) {
    return nextQuery;
  }

  nextQuery.assistant = '1';

  if (state.sessionId) {
    nextQuery.assistantSessionId = state.sessionId;
    return nextQuery;
  }

  const mode = state.mode === 'project-context' && state.projectId ? 'project-context' : 'create-project';
  nextQuery.assistantMode = mode;

  if (state.fresh) {
    nextQuery.assistantFresh = '1';
  }

  if (mode === 'project-context') {
    nextQuery.assistantProjectId = state.projectId;
  }

  return nextQuery;
}

export function createAssistantRouteSignature(state = {}) {
  if (!state.open) {
    return 'closed';
  }

  if (state.sessionId) {
    return `session:${state.sessionId}`;
  }

  return `${state.mode ?? 'create-project'}:${state.projectId ?? ''}:${state.fresh ? 'fresh' : 'resume'}`;
}
