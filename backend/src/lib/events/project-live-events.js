import { LIVE_EVENT_CHANNELS } from './live-event-bus.js';

// Project screens refresh when any project-scoped write succeeds. Events carry the actor
// and the originating browser tab so a tab can ignore the echo of its own saves.
//
// Screens that span projects (the project list, Home, resources, tickets, workflows) listen on
// the workspace channel instead. Its events say only which area changed, never which project or
// who changed it, because everyone in the workspace receives them; each screen then refetches
// what its viewer may see.

export const CLIENT_ID_HEADER = 'x-odin-client-id';
export const PROJECT_CHANGED_EVENT = 'project.assets.invalidated';
export const WORKSPACE_CHANGED_EVENT = 'workspace.changed';
export const WORKSPACE_AREAS = Object.freeze(['chat', 'projects', 'resources', 'workflows']);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Writes that only touch the caller's own view state, or read-only POST endpoints.
const IGNORED_PATH_PATTERNS = [
  /^\/events\/?$/,
  // Starting, resuming, cancelling and signing parts of a large upload change no file; completing
  // one does.
  /^\/uploads(?:\/[^/]+(?:\/parts)?)?\/?$/,
  /^\/kanban\/config\/?$/,
  /^\/ai(\/|$)/,
  // Channel conversations publish channel.updated themselves (modules/channels/channel-events.js):
  // a busy channel must not reload every project screen, and reading one changes nothing shared.
  // A person's own notification level for a channel changes nothing anyone else sees, and a
  // typing signal changes nothing at all.
  /^\/channels\/[^/]+\/(?:posts|read|notification-level|typing)\/?$/,
  /^\/posts\/[^/]+\/?$/,
];

function originClientId(request) {
  return String(request.get?.(CLIENT_ID_HEADER) ?? '').trim().slice(0, 120) || null;
}

function actorFor(request) {
  const user = request.auth?.user;
  return user?.id ? { id: user.id, name: user.name ?? '' } : null;
}

function tenantIdOf(request) {
  return request.auth?.user?.memberships?.[0]?.tenantId ?? null;
}

export function publishWorkspaceChanged(liveEventBus, tenantId, { area, originClientId: clientId = null } = {}) {
  if (!liveEventBus || !tenantId || !WORKSPACE_AREAS.includes(area)) return;

  liveEventBus.publish(LIVE_EVENT_CHANNELS.workspace(tenantId), {
    area,
    originClientId: clientId,
    type: WORKSPACE_CHANGED_EVENT,
  });
}

export function publishProjectChanged(liveEventBus, projectId, { actor = null, originClientId: clientId = null, reason = 'project-changed', ...details } = {}) {
  if (!liveEventBus || !projectId) return;

  liveEventBus.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    ...details,
    actor,
    originClientId: clientId,
    projectId,
    reason,
    type: PROJECT_CHANGED_EVENT,
  });
}

/**
 * Mount at `/api/projects/:projectId`. Publishes once per successful mutating request,
 * after the response is sent, so every project-scoped route is covered without each
 * handler remembering to publish.
 */
export function createProjectMutationEventsMiddleware({ liveEventBus }) {
  return (request, response, next) => {
    const projectId = request.params?.projectId;
    const subPath = request.path ?? '';

    if (
      !liveEventBus
      || !projectId
      || !MUTATING_METHODS.has(request.method)
      || IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(subPath))
    ) {
      next();
      return;
    }

    response.on('finish', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return;
      const clientId = originClientId(request);
      publishProjectChanged(liveEventBus, projectId, {
        actor: actorFor(request),
        originClientId: clientId,
        reason: response.locals?.projectEventReason ?? `${request.method.toLowerCase()} ${subPath}`.trim(),
      });
      publishWorkspaceChanged(liveEventBus, tenantIdOf(request), { area: 'projects', originClientId: clientId });
    });
    next();
  };
}

// Routes that refuse a write unless the body's projectId is the record's project, so a
// successful one names its project truthfully. Elsewhere a body could name any project.
const BODY_PROJECT_CHECKED = [
  /^\/api\/workflows\/approvals\/[^/]+\/decision$/,
  /^\/api\/workflows\/custom-values\/[^/]+$/,
];

// The projects a resource-planning or workflow write touched: the one in a
// /api/resource-planning/projects/:id path, the saved record's, or a checked body's.
export function projectIdsNamedByWrite({ body, path, responseBody }) {
  return [
    /^\/api\/resource-planning\/projects\/([^/]+)/.exec(path)?.[1],
    responseBody?.value?.projectId,
    BODY_PROJECT_CHECKED.some((pattern) => pattern.test(path)) ? body?.projectId : null,
  ];
}

/**
 * For writes outside /api/projects/:projectId, such as creating a project, resource planning
 * and workflows. Once a mutating request succeeds, publishes a workspace event for `area`, and
 * a project event for each project that `projectIdsOf({ body, path, responseBody })` names.
 */
export function createWorkspaceMutationEventsMiddleware({ area, liveEventBus, projectIdsOf = () => [] }) {
  if (!WORKSPACE_AREAS.includes(area)) throw new TypeError(`Unknown workspace area ${area}.`);

  return (request, response, next) => {
    if (!liveEventBus || !MUTATING_METHODS.has(request.method)) {
      next();
      return;
    }

    // Routers rewrite the request's path as they match, so take the full path now.
    const path = String(request.originalUrl ?? '').split('?')[0];
    let responseBody;
    const sendJson = response.json.bind(response);
    response.json = (body) => {
      responseBody = body;
      return sendJson(body);
    };

    response.once('finish', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return;
      const clientId = originClientId(request);
      const named = projectIdsOf({ body: request.body ?? {}, path, responseBody }) ?? [];
      for (const projectId of new Set(named.filter((value) => typeof value === 'string' && value))) {
        publishProjectChanged(liveEventBus, projectId, {
          actor: actorFor(request),
          originClientId: clientId,
          reason: `${request.method.toLowerCase()} ${path}`,
        });
      }
      publishWorkspaceChanged(liveEventBus, tenantIdOf(request), { area, originClientId: clientId });
    });
    next();
  };
}

/**
 * For routers whose paths do not carry the project id: resolves affected projects from
 * the JSON response body once the request succeeds.
 */
export function createProjectEventsFromResponseMiddleware({ liveEventBus, resolveProjectIds }) {
  return (request, response, next) => {
    if (!liveEventBus || !MUTATING_METHODS.has(request.method)) {
      next();
      return;
    }

    const sendJson = response.json.bind(response);
    response.json = (body) => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        const projectIds = [...new Set((resolveProjectIds(body, request) ?? []).filter(Boolean))];
        response.once('finish', () => {
          for (const projectId of projectIds) {
            publishProjectChanged(liveEventBus, projectId, {
              actor: actorFor(request),
              originClientId: originClientId(request),
              reason: `${request.method.toLowerCase()} ${request.baseUrl}${request.path}`,
            });
          }
        });
      }
      return sendJson(body);
    };
    next();
  };
}
