import { createSharedEventStreams } from '../projects/shared-project-events.js';
import { getSignalWorkingMode, normalizeWorkingMode } from './activity-tracker.js';
import { resolveApiBaseUrl } from './base-url.js';
import { workspaceAccessMethods } from './workspace-access-api.js';
import { chatEndpoints } from './chat-endpoints.js';

export const BROWSER_SESSION_MARKER = 'cookie-session';
const CSRF_COOKIE_NAME = 'odin_csrf';

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = 'ApiError';
    this.status = options.status ?? 500;
    this.data = options.data ?? null;
  }
}

// Ticket list filters are CSV query params. Empty values are omitted so the
// server's defaults apply rather than an empty filter being sent as a restriction.
export function buildTicketQuery(filters = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.set(key, value.join(','));
      continue;
    }
    params.set(key, String(value));
  }

  return params.toString();
}

function pathSegment(value) {
  return encodeURIComponent(String(value ?? ''));
}

// `?scope=` for the kanban routes, or nothing when no board is named.
function boardScopeQuery(scope) {
  return scope ? `?scope=${encodeURIComponent(scope)}` : '';
}

export function requirementsPath(projectId, suffix = '') {
  return `/api/projects/${pathSegment(projectId)}/requirements${suffix}`;
}

// The client portal and the guided review.
export function signingPath(projectId, suffix = '') {
  return `/api/projects/${pathSegment(projectId)}/signing-requests${suffix}`;
}

export function requirementsPortalPath(portalToken, suffix = '') {
  return `/api/public/requirements/${pathSegment(portalToken)}${suffix}`;
}

// Task access by link: one link per email opens that person's tasks and requirements.
export function accessLinkPath(accessToken, suffix = '') {
  return `/api/public/access/${pathSegment(accessToken)}${suffix}`;
}

/** The review API for a round: the team's `/review` sub-path, or the portal's round path. */
export function requirementsReviewPath(scope = {}, suffix = '') {
  if (scope.portalToken) return requirementsPortalPath(scope.portalToken, `/rounds/${pathSegment(scope.roundId)}${suffix}`);
  return requirementsPath(scope.projectId, `/rounds/${pathSegment(scope.roundId)}/review${suffix}`);
}

/** Snapshot images the review API links to, for the team or a stakeholder link. */
export function isRequirementsSnapshotPath(path) {
  return /^\/api\/(?:public\/requirements\/[^/?#]+|projects\/[^/?#]+\/requirements)\/rounds\/[^/?#]+\/snapshots\/[^/?#]+$/.test(String(path ?? ''));
}

function reviewToken(scope, token) {
  return scope?.portalToken ? undefined : token;
}

/**
 * Returns the client scoped to a working mode. Stores receive their client by injection,
 * and test doubles may not support scoping, so those fall back to the client as given.
 */
export function withWorkingMode(client, mode) {
  return typeof client?.withWorking === 'function' ? client.withWorking(mode) : client;
}

function createRequestSignal({ signal, timeoutMs } = {}) {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!signal && !hasTimeout) {
    return {
      cleanup() {},
      didTimeout() {
        return false;
      },
      signal: undefined,
    };
  }

  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;
  let abortHandler = null;

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      abortHandler = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  if (hasTimeout) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    cleanup() {
      if (timeoutId != null) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    },
    didTimeout() {
      return timedOut;
    },
    signal: controller.signal,
  };
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function readCookie(name) {
  if (typeof document === 'undefined') {
    return '';
  }
  const prefix = `${name}=`;
  const part = String(document.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  if (!part) {
    return '';
  }
  try {
    return decodeURIComponent(part.slice(prefix.length));
  } catch (_error) {
    return '';
  }
}

function isUnsafeMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method ?? 'GET').toUpperCase());
}

export function createApiClient({
  activityTracker = null,
  baseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  // Identifies this browser tab on writes so live project events can skip their own echo.
  const clientId = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let sessionRefreshHandler = null;
  let unauthorizedHandler = null;

  function buildHeaders({ body, extra = {}, method, token } = {}) {
    const csrfToken = isUnsafeMethod(method) ? readCookie(CSRF_COOKIE_NAME) : '';
    return {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-Odin-Client-Id': clientId,
      ...(token && token !== BROWSER_SESSION_MARKER ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...extra,
    };
  }

  // `keepalive` lets a small request finish after the page is gone (sent while it unloads).
  async function rawRequest(path, { body, keepalive = false, method = 'GET', signal, skipAuthRedirect = false, timeoutMs, token } = {}, allowRetry = true) {
    const requestSignal = createRequestSignal({ signal, timeoutMs });
    let response;

    try {
      response = await fetch(new URL(path.replace(/^\//, ''), normalizedBaseUrl), {
        credentials: 'include',
        method,
        headers: buildHeaders({ body, method, token }),
        body: body ? JSON.stringify(body) : undefined,
        ...(keepalive ? { keepalive: true } : {}),
        signal: requestSignal.signal,
      });
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new ApiError('Request timed out.', {
          status: 408,
        });
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (
        response.status === 401
        && !skipAuthRedirect
        && allowRetry
        && typeof sessionRefreshHandler === 'function'
      ) {
        const refreshedToken = await sessionRefreshHandler(token).catch(() => '');

        if (refreshedToken) {
          return rawRequest(path, {
            body,
            method,
            signal,
            skipAuthRedirect,
            timeoutMs,
            token: token ? refreshedToken : undefined,
          }, false);
        }
      }

      const error = new ApiError(data.error ?? 'Request failed.', {
        data,
        status: response.status,
      });

      if (response.status === 401 && !skipAuthRedirect && typeof unauthorizedHandler === 'function') {
        unauthorizedHandler(error);
      }

      throw error;
    }

    return {
      data,
      status: response.status,
    };
  }

  async function rawBinaryRequest(path, { method = 'GET', signal, skipAuthRedirect = false, timeoutMs, token } = {}, allowRetry = true) {
    const requestSignal = createRequestSignal({ signal, timeoutMs });
    let response;

    try {
      response = await fetch(new URL(path.replace(/^\//, ''), normalizedBaseUrl), {
        credentials: 'include',
        method,
        headers: buildHeaders({ method, token }),
        signal: requestSignal.signal,
      });
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new ApiError('Request timed out.', {
          status: 408,
        });
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      if (
        response.status === 401
        && !skipAuthRedirect
        && allowRetry
        && typeof sessionRefreshHandler === 'function'
      ) {
        const refreshedToken = await sessionRefreshHandler(token).catch(() => '');

        if (refreshedToken) {
          return rawBinaryRequest(path, {
            method,
            signal,
            skipAuthRedirect,
            timeoutMs,
            token: token ? refreshedToken : undefined,
          }, false);
        }
      }

      const error = new ApiError(data.error ?? 'Request failed.', {
        data,
        status: response.status,
      });

      if (response.status === 401 && !skipAuthRedirect && typeof unauthorizedHandler === 'function') {
        unauthorizedHandler(error);
      }

      throw error;
    }

    return {
      blob: await response.blob(),
      contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
      status: response.status,
    };
  }

  async function rawStreamRequest(path, { body, method = 'POST', onEvent, signal, skipAuthRedirect = false, token } = {}, allowRetry = true) {
    let response;
    try {
      response = await fetch(new URL(path.replace(/^\//, ''), normalizedBaseUrl), {
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
        headers: buildHeaders({
          body,
          extra: {
            Accept: 'text/event-stream',
          },
          method,
          token,
        }),
        method,
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }
      throw error;
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      if (
        response.status === 401
        && !skipAuthRedirect
        && allowRetry
        && typeof sessionRefreshHandler === 'function'
      ) {
        const refreshedToken = await sessionRefreshHandler(token).catch(() => '');

        if (refreshedToken) {
          return rawStreamRequest(path, {
            body,
            method,
            onEvent,
            signal,
            skipAuthRedirect,
            token: token ? refreshedToken : undefined,
          }, false);
        }
      }

      const error = new ApiError(data.error ?? 'Request failed.', {
        data,
        status: response.status,
      });

      if (response.status === 401 && !skipAuthRedirect && typeof unauthorizedHandler === 'function') {
        unauthorizedHandler(error);
      }

      throw error;
    }

    if (!response.body) {
      throw new ApiError('Streaming response body is unavailable.', {
        status: response.status,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const flushFrame = async (frame) => {
      const lines = frame.split(/\r?\n/);
      let type = 'message';
      const dataLines = [];

      for (const line of lines) {
        if (!line) {
          continue;
        }

        if (line.startsWith('event:')) {
          type = line.slice('event:'.length).trim() || 'message';
          continue;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim());
        }
      }

      if (!dataLines.length) {
        return;
      }

      const payload = JSON.parse(dataLines.join('\n'));
      if (typeof onEvent === 'function') {
        await onEvent({
          data: payload,
          type,
        });
      }
    };

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (error) {
        if (error?.name === 'AbortError') {
          return;
        }
        throw error;
      }
      const { done, value } = readResult;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (frame) {
          await flushFrame(frame);
        }
        boundary = buffer.indexOf('\n\n');
      }

      if (done) {
        const trailing = buffer.trim();
        if (trailing) {
          await flushFrame(trailing);
        }
        break;
      }
    }
  }

  // Subscriptions stay open for the life of a screen, so they are not tracked as working
  // calls; a permanent "Working..." banner would tell the user nothing.
  function subscribe(path, { method = 'GET', onClose, onError, onEvent, skipAuthRedirect = false, token } = {}) {
    const controller = new AbortController();

    rawStreamRequest(path, {
      method,
      onEvent,
      signal: controller.signal,
      skipAuthRedirect,
      token,
    }).then(() => {
      if (!controller.signal.aborted && typeof onClose === 'function') {
        onClose();
      }
    }).catch((error) => {
      if (controller.signal.aborted) {
        return;
      }

      if (typeof onError === 'function') {
        onError(error);
      }
    });

    return () => controller.abort();
  }

  // One project event stream per project and session, shared by every subscriber in this tab.
  // Every shared stream closes while the tab is hidden (shared-project-events.js says why).
  const sharedProjectEvents = createSharedEventStreams({
    document: globalThis.document ?? null,
    open(key, handlers) {
      const [projectId, token] = JSON.parse(key);
      return subscribe(`/api/projects/${projectId}/events`, { ...handlers, method: 'GET', token: token || undefined });
    },
  });
  // One workspace event stream per session, shared the same way.
  const sharedWorkspaceEvents = createSharedEventStreams({
    document: globalThis.document ?? null,
    open(token, handlers) {
      return subscribe('/api/workspace/events', { ...handlers, method: 'GET', token: token || undefined });
    },
  });
  // The signed-in person's notification stream, shared the same way. It
  // names this tab, so the server forgets the tab's focus when the stream closes.
  const sharedPersonEvents = createSharedEventStreams({
    document: globalThis.document ?? null,
    open(token, handlers) {
      return subscribe(`/api/me/events?clientId=${encodeURIComponent(clientId)}`, { ...handlers, method: 'GET', token: token || undefined });
    },
  });

  function uploadFailure(status, data) {
    return new ApiError(data?.error ?? 'Request failed.', { data, status });
  }

  /**
   * Sends a raw body (a File or Blob) with upload progress. Uses XMLHttpRequest because
   * fetch reports no upload progress; falls back to fetch where XHR is unavailable.
   * `onProgress({ loaded, total })` is called while the body is sent.
   */
  async function rawUploadRequest(path, { body, contentType = 'application/octet-stream', method = 'POST', onProgress, signal, skipAuthRedirect = false, token } = {}, allowRetry = true) {
    const url = new URL(path.replace(/^\//, ''), normalizedBaseUrl).toString();
    const headers = buildHeaders({ extra: { 'Content-Type': contentType }, method, token });
    let outcome;

    if (typeof XMLHttpRequest === 'undefined') {
      const response = await fetch(url, { body, credentials: 'include', headers, method, signal });
      outcome = { data: await response.json().catch(() => ({})), status: response.status };
    } else {
      outcome = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const cleanup = () => signal?.removeEventListener?.('abort', abort);
        xhr.open(method, url);
        xhr.withCredentials = true;
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        if (typeof onProgress === 'function' && xhr.upload) {
          xhr.upload.onprogress = (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : Number(body?.size) || 0 });
        }
        xhr.onload = () => {
          cleanup();
          let data = {};
          try {
            data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          } catch (_error) {
            data = {};
          }
          resolve({ data, status: xhr.status });
        };
        xhr.onerror = () => {
          cleanup();
          reject(new ApiError('The upload could not reach the server.', { status: 0 }));
        };
        xhr.onabort = () => {
          cleanup();
          const error = new Error('Upload cancelled.');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          xhr.onabort();
          return;
        }
        signal?.addEventListener?.('abort', abort, { once: true });
        xhr.send(body);
      });
    }

    if (outcome.status >= 200 && outcome.status < 300) return outcome;

    if (outcome.status === 401 && !skipAuthRedirect && allowRetry && typeof sessionRefreshHandler === 'function') {
      const refreshedToken = await sessionRefreshHandler(token).catch(() => '');
      if (refreshedToken) {
        return rawUploadRequest(path, { body, contentType, method, onProgress, signal, skipAuthRedirect, token: token ? refreshedToken : undefined }, false);
      }
    }
    const error = uploadFailure(outcome.status, outcome.data);
    if (outcome.status === 401 && !skipAuthRedirect && typeof unauthorizedHandler === 'function') unauthorizedHandler(error);
    throw error;
  }

  function trackActivity(scope, options, fallbackMode, run) {
    const signal = options.signal ?? scope.signal;
    const explicitMode = normalizeWorkingMode(options.working) ?? scope.working ?? null;

    if (!activityTracker) {
      return run({ ...options, signal });
    }

    const mode = explicitMode ?? (getSignalWorkingMode(signal) ? null : fallbackMode);
    return activityTracker.track({ mode, signal }, (trackedSignal) => run({ ...options, signal: trackedSignal }));
  }

  const scopedClients = new Map();

  /**
   * Builds the method set for one working scope. `scope.working` sets the mode for every
   * call made through it, and `scope.signal` is passed to each call so its mode and abort
   * apply. Call sites pick a mode with `apiClient.passive`, `apiClient.blocking`,
   * `apiClient.withWorking(mode)` or `apiClient.withSignal(signal)`.
   */
  function buildClient(scope) {
    const request = (path, options = {}) => trackActivity(scope, options, null, (tracked) => rawRequest(path, tracked));
    const binaryRequest = (path, options = {}) => trackActivity(scope, options, null, (tracked) => rawBinaryRequest(path, tracked));
    // Streamed responses are background traffic unless the call site says otherwise.
    const streamRequest = (path, options = {}) => trackActivity(scope, options, 'passive', (tracked) => rawStreamRequest(path, tracked));
    const uploadRequest = (path, options = {}) => trackActivity(scope, options, null, (tracked) => rawUploadRequest(path, tracked));

    const client = {
      // Odin Chat (chat-endpoints.js).
      ...chatEndpoints({ request, segment: pathSegment, subscribe }),
      baseUrl: normalizedBaseUrl.replace(/\/$/, ''),
      clientId,
      setSessionRefreshHandler(handler) {
        sessionRefreshHandler = typeof handler === 'function' ? handler : null;
      },
      setUnauthorizedHandler(handler) {
        unauthorizedHandler = typeof handler === 'function' ? handler : null;
      },
      getFileContentUrl(fileId) {
        return new URL(`api/files/${fileId}/content`, normalizedBaseUrl).toString();
      },
      // A signed transfer URL as the API gave it: absolute for S3, a path on the API otherwise.
      resolveTransferUrl(url) {
        return /^https?:\/\//i.test(url) ? url : new URL(String(url).replace(/^\//, ''), normalizedBaseUrl).toString();
      },
      getGoogleStartUrl() {
        return `${normalizedBaseUrl}api/auth/google/start`;
      },
      async login(payload) {
        const result = await request('/api/auth/login', {
          body: payload,
          method: 'POST',
          skipAuthRedirect: true,
        });

        return result.data;
      },
      async getWorkspaceInvitation(inviteToken) {
        return (await request(`/api/auth/invites/${encodeURIComponent(inviteToken)}`, { skipAuthRedirect: true })).data;
      },
      async acceptWorkspaceInvitation(inviteToken, registration, token) {
        const action = registration ? 'register' : 'accept';
        return (await request(`/api/auth/invites/${encodeURIComponent(inviteToken)}/${action}`, { method: 'POST', body: registration ?? {}, token, skipAuthRedirect: Boolean(registration) })).data;
      },
      async register(payload) {
        const result = await request('/api/auth/register', {
          body: payload,
          method: 'POST',
          skipAuthRedirect: true,
        });

        return result.data;
      },
      async checkRegistrationAvailability(payload) {
        const result = await request('/api/auth/register/availability', {
          body: payload,
          method: 'POST',
        });

        return result.data;
      },
      async getSignupConfig() {
        return (await request('/api/auth/register/config', { skipAuthRedirect: true })).data;
      },
      async verifyRegistration(token) {
        return (await request('/api/auth/register/verify', { body: { token }, method: 'POST', skipAuthRedirect: true })).data;
      },
      async getCurrentUser(token, options = {}) {
        const result = await request('/api/auth/me', {
          ...options,
          token,
        });

        return result.data;
      },
      async getTenantSettings(token) {
        const result = await request('/api/tenants/settings', {
          token,
        });

        return result.data;
      },
      async updateTenantSettings(payload, token) {
        const result = await request('/api/tenants/settings', {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async getTenantOpenAiConfig(token) {
        const result = await request('/api/tenants/openai-config', {
          token,
        });

        return result.data;
      },
      async fetchTenantOpenAiModels(payload, token) {
        const result = await request('/api/tenants/openai-config/fetch-models', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async saveTenantOpenAiConfig(payload, token) {
        const result = await request('/api/tenants/openai-config', {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async deleteTenantOpenAiConfig(token) {
        const result = await request('/api/tenants/openai-config', {
          method: 'DELETE',
          token,
        });

        return result.data;
      },
      async getTenantUserRequests(token) {
        const result = await request('/api/tenants/user-requests', {
          token,
        });

        return result.data;
      },
      ...workspaceAccessMethods(request),
      async updateTenantUsers(payload, token) {
        const result = await request('/api/tenants/users', {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async getTenantInvites(token) {
        const result = await request('/api/tenants/invites', {
          token,
        });

        return result.data;
      },
      async inviteTenantUser(payload, token) {
        const result = await request('/api/tenants/invites', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async resendTenantInvite(payload, token) {
        return (await request('/api/tenants/invites/resend', { body: payload, method: 'POST', token })).data;
      },
      async revokeTenantInvite(payload, token) {
        const result = await request('/api/tenants/invites/revoke', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getTenantExistingUsers(token) {
        const result = await request('/api/tenants/existing-users', {
          token,
        });

        return result.data;
      },
      async removeTenantExistingUser(payload, token) {
        const result = await request('/api/tenants/existing-users/remove', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getTenantStatusDefinitions(token) {
        const result = await request('/api/tenants/status-definitions', {
          token,
        });

        return result.data;
      },
      async saveTenantStatusDefinitions(payload, token) {
        const result = await request('/api/tenants/status-definitions', {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async resetTenantStatusDefinitions(token) {
        const result = await request('/api/tenants/status-definitions/reset', {
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getTenantTaskTypeDefinitions(token) {
        const result = await request('/api/tenants/task-type-definitions', {
          token,
        });

        return result.data;
      },
      async saveTenantTaskTypeDefinitions(payload, token) {
        const result = await request('/api/tenants/task-type-definitions', {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async resetTenantTaskTypeDefinitions(token) {
        const result = await request('/api/tenants/task-type-definitions/reset', {
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getTenantAuditLogs(payload, token) {
        const result = await request('/api/tenants/audit-logs', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async backupTenant(token) {
        const result = await request('/api/tenants/backup', {
          method: 'POST',
          token,
        });

        return result.data;
      },
      async restoreTenant(payload, token) {
        const result = await request('/api/tenants/restore', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getUserProfile(token) {
        const result = await request('/api/users/me', {
          token,
        });

        return result.data;
      },
      async updateUserProfile(payload, token) {
        const result = await request('/api/users/me', {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async killUserSession(payload, token) {
        const result = await request('/api/users/kill-session', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getProjects(token) {
        const result = await request('/api/projects', {
          token,
        });

        return result.data;
      },
      async createProject(payload, token) {
        const result = await request('/api/projects', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      // Optional modules each workspace switches on (the Consulting module holds engagements).
      async getWorkspaceModules(token) {
        return (await request('/api/workspace/modules', { token })).data;
      },
      async updateWorkspaceModule(payload, token) {
        return (await request('/api/workspace/modules', { body: payload, method: 'PUT', token })).data;
      },
      async listEngagements(token) {
        return (await request('/api/engagements', { token })).data;
      },
      async createEngagement(payload, token) {
        return (await request('/api/engagements', { body: payload, method: 'POST', token })).data;
      },
      async convertEngagement(projectId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/convert`, { body: payload, method: 'POST', token })).data;
      },
      // An engagement's customer and owner.
      async updateEngagement(projectId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/engagement`, { body: payload, method: 'PATCH', token })).data;
      },
      async closeEngagement(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/close`, { body: {}, method: 'POST', token })).data;
      },
      async reopenEngagement(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/reopen`, { body: {}, method: 'POST', token })).data;
      },
      // A project's billing from invoice-gen, for finance-visible people.
      async getProjectBilling(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/billing`, { token })).data;
      },
      async getStoryMilestones(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/billing/milestones`, { token })).data;
      },
      async updateStoryMilestones(projectId, assignments, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/billing/milestones`, { body: { assignments }, method: 'PUT', token })).data;
      },
      // Pursuit board and insights.
      async getPursuit(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/pursuit`, { token })).data;
      },
      async movePursuitTasks(projectId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/pursuit/move`, { body: payload, method: 'POST', token })).data;
      },
      async getPursuitInsights(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/insights/pursuit`, { token })).data;
      },
      async getProjectSettings(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/settings`, { token })).data;
      },
      async saveProjectSettings(projectId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/settings`, { body: payload, method: 'PUT', token })).data;
      },
      async getProject(projectId, token) {
        const result = await request(`/api/projects/${projectId}`, {
          token,
        });

        return result.data;
      },
      async updateProject(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async deleteProject(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}`, { method: 'DELETE', token })).data;
      },
      async listDeletedProjects(token) {
        return (await request('/api/projects/deleted', { token })).data;
      },
      async restoreDeletedProject(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/restore`, { method: 'POST', token })).data;
      },
      async updateProjectAssistantBrief(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/assistant-brief`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async updateProjectTree(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/tree`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async createProjectItem(projectId, payload, token) {
        return (await request(`/api/projects/${projectId}/items`, { body: payload, method: 'POST', token })).data;
      },
      async updateProjectItem(projectId, itemId, payload, token) {
        return (await request(`/api/projects/${projectId}/items/${itemId}`, { body: payload, method: 'PATCH', token })).data;
      },
      async deleteProjectItem(projectId, itemId, payload, token) {
        return (await request(`/api/projects/${projectId}/items/${itemId}`, { body: payload, method: 'DELETE', token })).data;
      },
      async listProjectItemRevisions(projectId, itemId, token, { limit = 25 } = {}) {
        return (await request(`/api/projects/${projectId}/items/${itemId}/revisions?limit=${encodeURIComponent(limit)}`, { token })).data;
      },
      async restoreProjectItem(projectId, itemId, payload, token) {
        return (await request(`/api/projects/${projectId}/items/${itemId}/restore`, { body: payload, method: 'POST', token })).data;
      },
      async listTickets(filters, token) {
        const query = buildTicketQuery(filters);
        return (await request(`/api/projects/tickets${query ? `?${query}` : ''}`, { token })).data;
      },
      async listProjectTickets(projectId, filters, token) {
        const query = buildTicketQuery(filters);
        return (await request(`/api/projects/${projectId}/tickets${query ? `?${query}` : ''}`, { token })).data;
      },
      async listTicketReviewQueue(filters, token) {
        const query = buildTicketQuery(filters);
        return (await request(`/api/projects/ticket-review-queue${query ? `?${query}` : ''}`, { token })).data;
      },
      async listTicketsAwaitingReview(projectId, filters, token) {
        const query = buildTicketQuery(filters);
        return (await request(`/api/projects/${projectId}/tickets/awaiting-review${query ? `?${query}` : ''}`, { token })).data;
      },
      async decideTicketReview(projectId, itemId, payload, token) {
        return (await request(`/api/projects/${projectId}/items/${itemId}/review`, { body: payload, method: 'POST', token })).data;
      },
      async listWorkItemRelations(projectId, itemId, token) {
        return (await request(`/api/projects/${projectId}/items/${itemId}/relations`, { token })).data;
      },
      async createWorkItemRelation(projectId, itemId, payload, token) {
        return (await request(`/api/projects/${projectId}/items/${itemId}/relations`, { body: payload, method: 'POST', token })).data;
      },
      async deleteWorkItemRelation(projectId, relationId, token) {
        return (await request(`/api/projects/${projectId}/relations/${relationId}`, { method: 'DELETE', token })).data;
      },
      async listTicketIntakeInvitations(projectId, token) {
        return (await request(`/api/projects/${projectId}/ticket-intake-invitations`, { token })).data;
      },
      async createTicketIntakeInvitation(projectId, payload, token) {
        return (await request(`/api/projects/${projectId}/ticket-intake-invitations`, { body: payload, method: 'POST', token })).data;
      },
      async revokeTicketIntakeInvitation(projectId, invitationId, token) {
        return (await request(`/api/projects/${projectId}/ticket-intake-invitations/${invitationId}`, { method: 'DELETE', token })).data;
      },
      // Reporter page (/report/:token). The intake token is the only credential.
      async getTicketIntake(intakeToken) {
        return (await request(`/api/public/ticket-intake/${pathSegment(intakeToken)}`)).data;
      },
      async submitTicketIntake(intakeToken, payload) {
        return (await request(`/api/public/ticket-intake/${pathSegment(intakeToken)}`, { body: payload, method: 'POST' })).data;
      },
      // Task access pages (/access/:token). The link token is the only credential.
      async getAccessHub(accessToken) {
        return (await request(accessLinkPath(accessToken))).data;
      },
      async openAccessRequirements(accessToken, projectId) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/requirements`), { body: {}, method: 'POST' })).data;
      },
      async getAccessTasks(accessToken, projectId) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/tasks`))).data;
      },
      async updateAccessTask(accessToken, projectId, taskId, payload) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/tasks/${pathSegment(taskId)}`), { body: payload, method: 'PATCH' })).data;
      },
      async createAccessTask(accessToken, projectId, storyId, payload) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/stories/${pathSegment(storyId)}/tasks`), { body: payload, method: 'POST' })).data;
      },
      async listAccessTaskComments(accessToken, projectId, taskId) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/tasks/${pathSegment(taskId)}/comments`))).data;
      },
      async addAccessTaskComment(accessToken, projectId, taskId, payload) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/tasks/${pathSegment(taskId)}/comments`), { body: payload, method: 'POST' })).data;
      },
      async listAccessTaskTime(accessToken, projectId, taskId) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/tasks/${pathSegment(taskId)}/time`))).data;
      },
      async logAccessTaskTime(accessToken, projectId, taskId, payload) {
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/tasks/${pathSegment(taskId)}/time`), { body: payload, method: 'POST' })).data;
      },
      async deleteAccessTimeEntry(accessToken, projectId, entryId, expectedVersion) {
        const query = new URLSearchParams({ expectedVersion: String(expectedVersion ?? '') });
        return (await request(accessLinkPath(accessToken, `/projects/${pathSegment(projectId)}/time/${pathSegment(entryId)}?${query}`), { method: 'DELETE' })).data;
      },
      async listTicketConfig(kind, token) {
        return (await request(`/api/tenants/ticket-config/${kind}`, { token })).data;
      },
      async saveTicketConfig(kind, payload, token) {
        return (await request(`/api/tenants/ticket-config/${kind}`, { body: payload, method: 'PUT', token })).data;
      },
      async getProjectTicketConfig(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/ticket-config`, { token })).data;
      },
      async getComplianceWorkspace(token) {
        return (await request('/api/compliance', { token })).data;
      },
      async updateCompliancePolicy(payload, token) {
        return (await request('/api/compliance/policy', { body: payload, method: 'PUT', token })).data;
      },
      async createComplianceAuditExport(payload, token) {
        return (await request('/api/compliance/audit-exports', { body: payload, method: 'POST', token })).data;
      },
      async downloadComplianceAuditExport(exportId, token) {
        return binaryRequest(`/api/compliance/audit-exports/${pathSegment(exportId)}/content`, { token });
      },
      async createComplianceLegalHold(payload, token) {
        return (await request('/api/compliance/legal-holds', { body: payload, method: 'POST', token })).data;
      },
      async releaseComplianceLegalHold(holdId, payload, token) {
        return (await request(`/api/compliance/legal-holds/${pathSegment(holdId)}/release`, { body: payload, method: 'POST', token })).data;
      },
      async createComplianceControlAttestation(payload, token) {
        return (await request('/api/compliance/control-attestations', { body: payload, method: 'POST', token })).data;
      },
      async createPrivacyErasureRequest(payload, token) {
        return (await request('/api/compliance/privacy-erasure-requests', { body: payload, method: 'POST', token })).data;
      },
      async executePrivacyErasureRequest(requestId, payload, token) {
        return (await request(`/api/compliance/privacy-erasure-requests/${pathSegment(requestId)}/execute`, { body: payload, method: 'POST', token })).data;
      },
      async getProjectGovernance(projectId, token) {
        const result = await request(`/api/projects/${projectId}/governance`, { token });
        return result.data;
      },
      async getProjectScheduleAnalysis(projectId, token) {
        const result = await request(`/api/projects/${projectId}/governance/schedule-analysis`, { token });
        return result.data;
      },
      async updateProjectWorkingCalendar(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/working-calendar`, {
          body: payload,
          method: 'PUT',
          token,
        });
        return result.data;
      },
      async createProjectScheduleBaseline(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/schedule-baselines`, {
          body: payload,
          method: 'POST',
          token,
        });
        return result.data;
      },
      async createProjectGovernanceItem(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/items`, {
          body: payload,
          method: 'POST',
          token,
        });
        return result.data;
      },
      async updateProjectGovernanceItem(projectId, itemId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/items/${itemId}`, {
          body: payload,
          method: 'PATCH',
          token,
        });
        return result.data;
      },
      async deleteProjectGovernanceItem(projectId, itemId, expectedVersion, token) {
        const result = await request(`/api/projects/${projectId}/governance/items/${itemId}`, {
          body: { expectedVersion },
          method: 'DELETE',
          token,
        });
        return result.data;
      },
      async createProjectDependency(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/dependencies`, {
          body: payload,
          method: 'POST',
          token,
        });
        return result.data;
      },
      async updateProjectDependency(projectId, dependencyId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/dependencies/${dependencyId}`, {
          body: payload,
          method: 'PATCH',
          token,
        });
        return result.data;
      },
      async deleteProjectDependency(projectId, dependencyId, expectedVersion, token) {
        const result = await request(`/api/projects/${projectId}/governance/dependencies/${dependencyId}`, {
          body: { expectedVersion },
          method: 'DELETE',
          token,
        });
        return result.data;
      },
      async createProjectMilestone(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/milestones`, {
          body: payload,
          method: 'POST',
          token,
        });
        return result.data;
      },
      async updateProjectMilestone(projectId, milestoneId, payload, token) {
        const result = await request(`/api/projects/${projectId}/governance/milestones/${milestoneId}`, {
          body: payload,
          method: 'PATCH',
          token,
        });
        return result.data;
      },
      async deleteProjectMilestone(projectId, milestoneId, expectedVersion, token) {
        const result = await request(`/api/projects/${projectId}/governance/milestones/${milestoneId}`, {
          body: { expectedVersion },
          method: 'DELETE',
          token,
        });
        return result.data;
      },
      async getAgentGoals(projectId, token) {
        const result = await request(`/api/agent-goals?projectId=${encodeURIComponent(projectId)}`, { token });
        return result.data;
      },
      async getAgentGoal(goalId, token) {
        const result = await request(`/api/agent-goals/${goalId}`, { token });
        return result.data;
      },
      async createAgentGoal(payload, token) {
        const result = await request('/api/agent-goals', { body: payload, method: 'POST', token });
        return result.data;
      },
      async updateAgentGoal(goalId, payload, token) {
        const result = await request(`/api/agent-goals/${goalId}`, { body: payload, method: 'PATCH', token });
        return result.data;
      },
      async runAgentGoal(goalId, token) {
        const result = await request(`/api/agent-goals/${goalId}/runs`, { body: {}, method: 'POST', token });
        return result.data;
      },
      async getAgentGoalMonitors(goalId, token) {
        const result = await request(`/api/agent-goals/${goalId}/monitors`, { token });
        return result.data;
      },
      async getAgentGoalNotifications(goalId, token) {
        const result = await request(`/api/agent-goals/${goalId}/notifications`, { token });
        return result.data;
      },
      async updateAgentGoalNotification(notificationId, payload, token) {
        const result = await request(`/api/agent-goals/notifications/${notificationId}`, { body: payload, method: 'PATCH', token });
        return result.data;
      },
      async searchAgentMemory({ limit = 20, projectIds = [], query, types = [] }, token) {
        const params = new URLSearchParams({ limit: String(limit), query });
        if (projectIds.length) params.set('projectIds', projectIds.join(','));
        if (types.length) params.set('types', types.join(','));
        const result = await request(`/api/agent-memory?${params.toString()}`, { token });
        return result.data;
      },
      async browseAgentMemory(filters = {}, token) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
          const normalized = Array.isArray(value) ? value.join(',') : value;
          if (normalized !== '' && normalized != null) params.set(key, String(normalized));
        }
        const query = params.toString();
        const result = await request(`/api/agent-memory/browse${query ? `?${query}` : ''}`, { token });
        return result.data;
      },
      async createAgentMemory(payload, token) {
        const result = await request('/api/agent-memory', { body: payload, method: 'POST', token });
        return result.data;
      },
      async correctAgentMemory(memoryId, payload, token) {
        const result = await request(`/api/agent-memory/${memoryId}`, { body: payload, method: 'PATCH', token });
        return result.data;
      },
      async forgetAgentMemory(memoryId, expectedVersion, token) {
        const result = await request(`/api/agent-memory/${memoryId}`, { body: { expectedVersion }, method: 'DELETE', token });
        return result.data;
      },
      async updateAgentMemoryGovernance(memoryId, payload, token) {
        const result = await request(`/api/agent-memory/${memoryId}/governance`, { body: payload, method: 'PATCH', token });
        return result.data;
      },
      async purgeExpiredAgentMemory(payload = {}, token) {
        const result = await request('/api/agent-memory/purge-expired', { body: payload, method: 'POST', token });
        return result.data;
      },
      async getPortfolioWorkspace(filters = {}, token) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value));
        const query = params.toString();
        const result = await request(`/api/portfolio${query ? `?${query}` : ''}`, { token });
        return result.data;
      },
      async createPortfolioNode(payload, token) { return (await request('/api/portfolio/nodes', { body: payload, method: 'POST', token })).data; },
      async updatePortfolioNode(nodeId, payload, token) { return (await request(`/api/portfolio/nodes/${nodeId}`, { body: payload, method: 'PATCH', token })).data; },
      async deletePortfolioNode(nodeId, expectedVersion, token) { return (await request(`/api/portfolio/nodes/${nodeId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createStrategyObjective(payload, token) { return (await request('/api/portfolio/objectives', { body: payload, method: 'POST', token })).data; },
      async updateStrategyObjective(objectiveId, payload, token) { return (await request(`/api/portfolio/objectives/${objectiveId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteStrategyObjective(objectiveId, expectedVersion, token) { return (await request(`/api/portfolio/objectives/${objectiveId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createPortfolioAlignment(payload, token) { return (await request('/api/portfolio/alignments', { body: payload, method: 'POST', token })).data; },
      async updatePortfolioAlignment(alignmentId, payload, token) { return (await request(`/api/portfolio/alignments/${alignmentId}`, { body: payload, method: 'PATCH', token })).data; },
      async deletePortfolioAlignment(alignmentId, expectedVersion, token) { return (await request(`/api/portfolio/alignments/${alignmentId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createPortfolioPlan(payload, token) { return (await request('/api/portfolio/plans', { body: payload, method: 'POST', token })).data; },
      async updatePortfolioPlan(planId, payload, token) { return (await request(`/api/portfolio/plans/${planId}`, { body: payload, method: 'PATCH', token })).data; },
      async deletePortfolioPlan(planId, expectedVersion, token) { return (await request(`/api/portfolio/plans/${planId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async capturePortfolioBaseline(payload, token) { return (await request('/api/portfolio/baselines', { body: payload, method: 'POST', token })).data; },
      async getResourceFinanceWorkspace(filters = {}, token) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value));
        const query = params.toString();
        return (await request(`/api/resource-planning${query ? `?${query}` : ''}`, { token })).data;
      },
      async createResourcePool(payload, token) { return (await request('/api/resource-planning/pools', { body: payload, method: 'POST', token })).data; },
      async updateResourcePool(poolId, payload, token) { return (await request(`/api/resource-planning/pools/${poolId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteResourcePool(poolId, expectedVersion, token) { return (await request(`/api/resource-planning/pools/${poolId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createEnterpriseResource(payload, token) { return (await request('/api/resource-planning/resources', { body: payload, method: 'POST', token })).data; },
      async updateEnterpriseResource(resourceId, payload, token) { return (await request(`/api/resource-planning/resources/${resourceId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteEnterpriseResource(resourceId, expectedVersion, token) { return (await request(`/api/resource-planning/resources/${resourceId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createResourceCalendarEntry(payload, token) { return (await request('/api/resource-planning/calendar-entries', { body: payload, method: 'POST', token })).data; },
      async updateResourceCalendarEntry(calendarEntryId, payload, token) { return (await request(`/api/resource-planning/calendar-entries/${calendarEntryId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteResourceCalendarEntry(calendarEntryId, expectedVersion, token) { return (await request(`/api/resource-planning/calendar-entries/${calendarEntryId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createResourceAllocation(payload, token) { return (await request('/api/resource-planning/allocations', { body: payload, method: 'POST', token })).data; },
      async updateResourceAllocation(allocationId, payload, token) { return (await request(`/api/resource-planning/allocations/${allocationId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteResourceAllocation(allocationId, expectedVersion, token) { return (await request(`/api/resource-planning/allocations/${allocationId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async getProjectTeam(projectId, token) { return request(`/api/resource-planning/projects/${projectId}/team`, { token }).then((result) => result.data); },
      // Task access for resources without a login, and the link that opens it.
      async getProjectTaskAccess(projectId, token) { return (await request(`/api/resource-planning/projects/${pathSegment(projectId)}/task-access`, { token })).data; },
      async setProjectTaskAccess(projectId, resourceId, payload, token) { return (await request(`/api/resource-planning/projects/${pathSegment(projectId)}/task-access/${pathSegment(resourceId)}`, { body: payload, method: 'PUT', token })).data; },
      async sendProjectTaskAccessLink(projectId, resourceId, payload, token) { return (await request(`/api/resource-planning/projects/${pathSegment(projectId)}/task-access/${pathSegment(resourceId)}/link`, { body: payload, method: 'POST', token })).data; },
      async getResourceAccessLink(resourceId, token) { return (await request(`/api/resource-planning/resources/${pathSegment(resourceId)}/access-link`, { token })).data; },
      async revokeResourceAccessLink(resourceId, token) { return (await request(`/api/resource-planning/resources/${pathSegment(resourceId)}/access-link/revoke`, { body: {}, method: 'POST', token })).data; },
      async levelResourceAllocation(allocationId, payload, token) { return (await request(`/api/resource-planning/allocations/${allocationId}/level`, { body: payload, method: 'POST', token })).data; },
      async createAccountingPeriod(payload, token) { return (await request('/api/resource-planning/accounting-periods', { body: payload, method: 'POST', token })).data; },
      async updateAccountingPeriod(accountingPeriodId, payload, token) { return (await request(`/api/resource-planning/accounting-periods/${accountingPeriodId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteAccountingPeriod(accountingPeriodId, expectedVersion, token) { return (await request(`/api/resource-planning/accounting-periods/${accountingPeriodId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createFinancePolicy(payload, token) { return (await request('/api/resource-planning/finance-policies', { body: payload, method: 'POST', token })).data; },
      async updateFinancePolicy(financePolicyId, payload, token) { return (await request(`/api/resource-planning/finance-policies/${financePolicyId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteFinancePolicy(financePolicyId, expectedVersion, token) { return (await request(`/api/resource-planning/finance-policies/${financePolicyId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createProjectFinancialEntry(payload, token) { return (await request('/api/resource-planning/financial-entries', { body: payload, method: 'POST', token })).data; },
      async updateProjectFinancialEntry(financialEntryId, payload, token) { return (await request(`/api/resource-planning/financial-entries/${financialEntryId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteProjectFinancialEntry(financialEntryId, expectedVersion, token) { return (await request(`/api/resource-planning/financial-entries/${financialEntryId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createProjectTimeEntry(payload, token) { return (await request('/api/resource-planning/time-entries', { body: payload, method: 'POST', token })).data; },
      async updateProjectTimeEntry(timeEntryId, payload, token) { return (await request(`/api/resource-planning/time-entries/${timeEntryId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteProjectTimeEntry(timeEntryId, expectedVersion, token) { return (await request(`/api/resource-planning/time-entries/${timeEntryId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createProjectExpense(payload, token) { return (await request('/api/resource-planning/expenses', { body: payload, method: 'POST', token })).data; },
      async updateProjectExpense(expenseId, payload, token) { return (await request(`/api/resource-planning/expenses/${expenseId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteProjectExpense(expenseId, expectedVersion, token) { return (await request(`/api/resource-planning/expenses/${expenseId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createResourceRate(payload, token) { return (await request('/api/resource-planning/resource-rates', { body: payload, method: 'POST', token })).data; },
      async updateResourceRate(resourceRateId, payload, token) { return (await request(`/api/resource-planning/resource-rates/${resourceRateId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteResourceRate(resourceRateId, expectedVersion, token) { return (await request(`/api/resource-planning/resource-rates/${resourceRateId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createTimesheetPeriod(payload, token) { return (await request('/api/resource-planning/timesheet-periods', { body: payload, method: 'POST', token })).data; },
      async updateTimesheetPeriod(timesheetPeriodId, payload, token) { return (await request(`/api/resource-planning/timesheet-periods/${timesheetPeriodId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteTimesheetPeriod(timesheetPeriodId, expectedVersion, token) { return (await request(`/api/resource-planning/timesheet-periods/${timesheetPeriodId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createExpenseReceipt(payload, token) { return (await request('/api/resource-planning/expense-receipts', { body: payload, method: 'POST', token })).data; },
      async updateExpenseReceipt(expenseReceiptId, payload, token) { return (await request(`/api/resource-planning/expense-receipts/${expenseReceiptId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteExpenseReceipt(expenseReceiptId, expectedVersion, token) { return (await request(`/api/resource-planning/expense-receipts/${expenseReceiptId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async uploadExpenseReceipt(expenseId, payload, token) { return (await request(`/api/resource-planning/expenses/${expenseId}/receipt-content`, { body: payload, method: 'POST', token })).data; },
      async downloadExpenseReceipt(expenseReceiptId, token) { return binaryRequest(`/api/resource-planning/expense-receipts/${expenseReceiptId}/content`, { token }); },
      async createExchangeRate(payload, token) { return (await request('/api/resource-planning/exchange-rates', { body: payload, method: 'POST', token })).data; },
      async updateExchangeRate(exchangeRateId, payload, token) { return (await request(`/api/resource-planning/exchange-rates/${exchangeRateId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteExchangeRate(exchangeRateId, expectedVersion, token) { return (await request(`/api/resource-planning/exchange-rates/${exchangeRateId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async getWorkflowWorkspace(filters = {}, token) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value));
        const query = params.toString();
        return (await request(`/api/workflows${query ? `?${query}` : ''}`, { token })).data;
      },
      async getWorkflowDefinition(workflowId, token) { return (await request(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`, { token })).data; },
      async listWorkflowTemplates(filters = {}, token) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value));
        const query = params.toString();
        return (await request(`/api/workflows/templates${query ? `?${query}` : ''}`, { token })).data;
      },
      async createWorkflowDefinition(payload, token) { return (await request('/api/workflows/definitions', { body: payload, method: 'POST', token })).data; },
      async updateWorkflowDefinition(workflowId, payload, token) { return (await request(`/api/workflows/definitions/${workflowId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteWorkflowDefinition(workflowId, expectedVersion, token) { return (await request(`/api/workflows/definitions/${workflowId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createWorkflowBinding(payload, token) { return (await request('/api/workflows/bindings', { body: payload, method: 'POST', token })).data; },
      async updateWorkflowBinding(bindingId, payload, token) { return (await request(`/api/workflows/bindings/${bindingId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteWorkflowBinding(bindingId, expectedVersion, token) { return (await request(`/api/workflows/bindings/${bindingId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async requestWorkflowApproval(payload, token) { return (await request('/api/workflows/approvals', { body: payload, method: 'POST', token })).data; },
      async decideWorkflowApproval(approvalId, payload, token) { return (await request(`/api/workflows/approvals/${approvalId}/decision`, { body: payload, method: 'POST', token })).data; },
      async createProjectBaseline(payload, token) { return (await request('/api/workflows/baselines', { body: payload, method: 'POST', token })).data; },
      async createProjectTemplate(payload, token) { return (await request('/api/workflows/templates', { body: payload, method: 'POST', token })).data; },
      async updateProjectTemplate(templateId, payload, token) { return (await request(`/api/workflows/templates/${templateId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteProjectTemplate(templateId, expectedVersion, token) { return (await request(`/api/workflows/templates/${templateId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createCustomFieldDefinition(payload, token) { return (await request('/api/workflows/custom-fields', { body: payload, method: 'POST', token })).data; },
      async updateCustomFieldDefinition(fieldId, payload, token) { return (await request(`/api/workflows/custom-fields/${fieldId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteCustomFieldDefinition(fieldId, expectedVersion, token) { return (await request(`/api/workflows/custom-fields/${fieldId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async writeCustomFieldValue(payload, token) { return (await request('/api/workflows/custom-values', { body: payload, method: 'PUT', token })).data; },
      async deleteCustomFieldValue(valueId, expectedVersion, token) { return (await request(`/api/workflows/custom-values/${valueId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async getReportingWorkspace(filters = {}, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); const query = params.toString(); return (await request(`/api/reporting${query ? `?${query}` : ''}`, { token })).data; },
      async getStandardDashboards(projectId, token) { const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''; return (await request(`/api/reporting/dashboards${query}`, { token })).data; },
      async searchEnterprise(filters, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); return (await request(`/api/reporting/search?${params.toString()}`, { token })).data; },
      async refreshEnterpriseSearch(token) { return (await request('/api/reporting/search/refresh', { method: 'POST', token })).data; },
      async createSavedView(payload, token) { return (await request('/api/reporting/views', { body: payload, method: 'POST', token })).data; },
      async updateSavedView(viewId, payload, token) { return (await request(`/api/reporting/views/${viewId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteSavedView(viewId, expectedVersion, token) { return (await request(`/api/reporting/views/${viewId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createReportDefinition(payload, token) { return (await request('/api/reporting/reports', { body: payload, method: 'POST', token })).data; },
      async updateReportDefinition(reportId, payload, token) { return (await request(`/api/reporting/reports/${reportId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteReportDefinition(reportId, expectedVersion, token) { return (await request(`/api/reporting/reports/${reportId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async runReport(reportId, payload, token) { return (await request(`/api/reporting/reports/${reportId}/run`, { body: payload, method: 'POST', token })).data; },
      async createReportSubscription(payload, token) { return (await request('/api/reporting/subscriptions', { body: payload, method: 'POST', token })).data; },
      async updateReportSubscription(subscriptionId, payload, token) { return (await request(`/api/reporting/subscriptions/${subscriptionId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteReportSubscription(subscriptionId, expectedVersion, token) { return (await request(`/api/reporting/subscriptions/${subscriptionId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async getProjectInsights(projectId, filters = {}, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); const query = params.toString(); return (await request(`/api/projects/${pathSegment(projectId)}/insights${query ? `?${query}` : ''}`, { token })).data; },
      async saveProjectInsightsLayout(projectId, payload, token) { return (await request(`/api/projects/${pathSegment(projectId)}/insights/layout`, { body: payload, method: 'PUT', token })).data; },
      async resetProjectInsightsLayout(projectId, expectedVersion, token) { return (await request(`/api/projects/${pathSegment(projectId)}/insights/layout`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async getProjectInsightsReportCard(projectId, reportId, token) { return (await request(`/api/projects/${pathSegment(projectId)}/insights/reports/${pathSegment(reportId)}`, { token })).data; },
      async getBiFeed(dataset, filters = {}, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); const query = params.toString(); return (await request(`/api/reporting/bi/${encodeURIComponent(dataset)}${query ? `?${query}` : ''}`, { token })).data; },
      async getIdentityWorkspace(filters = {}, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); const query = params.toString(); return (await request(`/api/identity${query ? `?${query}` : ''}`, { token })).data; },
      async discoverEnterpriseSso(email) { return (await request(`/api/auth/sso/discover?email=${encodeURIComponent(email)}`, { skipAuthRedirect: true })).data; },
      async saveIdentityPolicy(payload, token) { return (await request('/api/identity/policy', { body: payload, method: 'PUT', token })).data; },
      async saveBreakGlassPolicy(payload, token) { return (await request('/api/identity/break-glass-policy', { body: payload, method: 'PUT', token })).data; },
      async createVerifiedDomain(payload, token) { return (await request('/api/identity/domains', { body: payload, method: 'POST', token })).data; },
      async verifyIdentityDomain(domainId, payload, token) { return (await request(`/api/identity/domains/${domainId}/verify`, { body: payload, method: 'POST', token })).data; },
      async deleteIdentityDomain(domainId, expectedVersion, token) { return (await request(`/api/identity/domains/${domainId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createCustomRole(payload, token) { return (await request('/api/identity/roles', { body: payload, method: 'POST', token })).data; },
      async updateCustomRole(roleId, payload, token) { return (await request(`/api/identity/roles/${roleId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteCustomRole(roleId, expectedVersion, token) { return (await request(`/api/identity/roles/${roleId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async createIdentityGroup(payload, token) { return (await request('/api/identity/groups', { body: payload, method: 'POST', token })).data; },
      async updateIdentityGroup(groupId, payload, token) { return (await request(`/api/identity/groups/${groupId}`, { body: payload, method: 'PATCH', token })).data; },
      async deleteIdentityGroup(groupId, expectedVersion, token) { return (await request(`/api/identity/groups/${groupId}`, { body: { expectedVersion }, method: 'DELETE', token })).data; },
      async addIdentityGroupMember(groupId, userId, token) { return (await request(`/api/identity/groups/${groupId}/members`, { body: { userId }, method: 'POST', token })).data; },
      async removeIdentityGroupMember(groupId, userId, token) { return (await request(`/api/identity/groups/${groupId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE', token })).data; },
      async createAccessReview(payload, token) { return (await request('/api/identity/access-reviews', { body: payload, method: 'POST', token })).data; },
      async createAccessReviewCampaign(payload, token) { return (await request('/api/identity/access-review-campaigns', { body: payload, method: 'POST', token })).data; },
      async updateAccessReviewCampaign(campaignId, payload, token) { return (await request(`/api/identity/access-review-campaigns/${campaignId}`, { body: payload, method: 'PATCH', token })).data; },
      async decideAccessReviewItem(itemId, payload, token) { return (await request(`/api/identity/access-review-items/${itemId}/decision`, { body: payload, method: 'POST', token })).data; },
      async createServiceAccount(payload, token) { return (await request('/api/identity/service-accounts', { body: payload, method: 'POST', token })).data; },
      async updateServiceAccount(accountId, payload, token) { return (await request(`/api/identity/service-accounts/${accountId}`, { body: payload, method: 'PATCH', token })).data; },
      async rotateServiceAccountCredential(accountId, payload, token) { return (await request(`/api/identity/service-accounts/${accountId}/rotate`, { body: payload, method: 'POST', token })).data; },
      async requestImpersonation(payload, token) { return (await request('/api/identity/impersonation-requests', { body: payload, method: 'POST', token })).data; },
      async decideImpersonation(grantId, payload, token) { return (await request(`/api/identity/impersonation-requests/${grantId}/decision`, { body: payload, method: 'POST', token })).data; },
      async activateImpersonation(grantId, token) { return (await request(`/api/identity/impersonation-requests/${grantId}/activate`, { body: {}, method: 'POST', token })).data; },
      async endImpersonation(grantId, expectedVersion, token) { return (await request(`/api/identity/impersonation-requests/${grantId}/end`, { body: { expectedVersion }, method: 'POST', token })).data; },
      async startBreakGlass(payload) { return (await request('/api/auth/break-glass/start', { body: payload, method: 'POST', skipAuthRedirect: true })).data; },
      async verifyBreakGlass(payload) { return (await request('/api/auth/break-glass/verify', { body: payload, method: 'POST', skipAuthRedirect: true })).data; },
      async getBugReporterConsent(input, token) { return (await request('/api/v1/bug-reporter/consent-info?' + new URLSearchParams(input), { token })).data; },
      async getMcpConsent(input, token) { return (await request('/api/mcp/oauth/consent?' + new URLSearchParams(input), { token })).data; },
      async authorizeMcp(input, token) { return (await request('/api/mcp/oauth/authorize', { method: 'POST', body: input, token })).data; },
      async revokeMcpClient(clientId, token) { return (await request(`/api/mcp/clients/${encodeURIComponent(clientId)}/revoke`, { method: 'POST', body: {}, token })).data; },
      async authorizeBugReporter(input, token) { return (await request('/api/v1/oauth/authorize', { method: 'POST', body: input, token })).data; },
      async getIntegrationWorkspace(filters = {}, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); const query = params.toString(); return (await request(`/api/integrations${query ? `?${query}` : ''}`, { token })).data; },
      async createOAuthApplication(payload, token) { return (await request('/api/integrations/oauth-applications', { body: payload, method: 'POST', token })).data; },
      async updateOAuthApplication(applicationId, payload, token) { return (await request(`/api/integrations/oauth-applications/${applicationId}`, { body: payload, method: 'PATCH', token })).data; },
      async rotateOAuthApplicationCredential(applicationId, expectedVersion, token) { return (await request(`/api/integrations/oauth-applications/${applicationId}/rotate`, { body: { expectedVersion }, method: 'POST', token })).data; },
      async createWebhookSubscription(payload, token) { return (await request('/api/integrations/webhooks', { body: payload, method: 'POST', token })).data; },
      async updateWebhookSubscription(subscriptionId, payload, token) { return (await request(`/api/integrations/webhooks/${subscriptionId}`, { body: payload, method: 'PATCH', token })).data; },
      async rotateWebhookSigningSecret(subscriptionId, expectedVersion, token) { return (await request(`/api/integrations/webhooks/${subscriptionId}/rotate`, { body: { expectedVersion }, method: 'POST', token })).data; },
      async replayWebhookDelivery(deliveryId, expectedVersion, token) { return (await request(`/api/integrations/webhook-deliveries/${deliveryId}/replay`, { body: { expectedVersion }, method: 'POST', token })).data; },
      async getConnectorWorkspace(filters = {}, token) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value)); const query = params.toString(); return (await request(`/api/connectors${query ? `?${query}` : ''}`, { token })).data; },
      async createConnectorConnection(payload, token) { return (await request('/api/connectors/connections', { body: payload, method: 'POST', token })).data; },
      async updateConnectorConnection(connectionId, payload, token) { return (await request(`/api/connectors/connections/${connectionId}`, { body: payload, method: 'PATCH', token })).data; },
      async createConnectorMapping(payload, token) { return (await request('/api/connectors/mappings', { body: payload, method: 'POST', token })).data; },
      async resolveConnectorConflict(conflictId, payload, token) { return (await request(`/api/connectors/conflicts/${conflictId}/resolve`, { body: payload, method: 'POST', token })).data; },
      async createConnectorSyncRun(connectionId, payload, token) { return (await request(`/api/connectors/connections/${connectionId}/sync-runs`, { body: payload, method: 'POST', token })).data; },
      async applyConnectorEvent(eventId, expectedVersion, token) { return (await request(`/api/connectors/events/${eventId}/apply`, { body: { expectedVersion }, method: 'POST', token })).data; },
      async createAgentGoalMonitor(goalId, payload, token) {
        const result = await request(`/api/agent-goals/${goalId}/monitors`, { body: payload, method: 'POST', token });
        return result.data;
      },
      async updateAgentGoalMonitor(monitorId, payload, token) {
        const result = await request(`/api/agent-goals/monitors/${monitorId}`, { body: payload, method: 'PATCH', token });
        return result.data;
      },
      async exportProject(projectId, token) {
        const result = await request(`/api/projects/${projectId}/export`, {
          token,
        });

        return result.data;
      },
      async inspectProjectImport(payload, token) {
        const result = await request('/api/projects/import/inspect', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async importProject(payload, token) {
        const result = await request('/api/projects/import', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getProjectValidUsers(projectId, token) {
        const result = await request(`/api/projects/${projectId}/valid-users`, {
          token,
        });

        return result.data;
      },
      async saveProjectPermissions(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/permissions`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async getProjectSprints(projectId, token) {
        const result = await request(`/api/projects/${projectId}/sprints`, {
          token,
        });

        return result.data;
      },
      async createProjectSprint(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/sprints`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async updateProjectSprint(projectId, sprintId, payload, token) {
        const result = await request(`/api/projects/${projectId}/sprints/${sprintId}`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async activateProjectSprint(projectId, sprintId, token) {
        const result = await request(`/api/projects/${projectId}/sprints/${sprintId}/activate`, {
          method: 'POST',
          token,
        });

        return result.data;
      },
      async completeProjectSprint(projectId, sprintId, token) {
        const result = await request(`/api/projects/${projectId}/sprints/${sprintId}/complete`, {
          method: 'POST',
          token,
        });

        return result.data;
      },
      async saveSprintStaffing(projectId, sprintId, payload, token) {
        const result = await request(`/api/projects/${projectId}/sprints/${sprintId}/staffing`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async assignSprintItems(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/sprints/assign-items`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async splitStory(projectId, storyId, payload, token) {
        const result = await request(`/api/projects/${projectId}/stories/${storyId}/split`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      // `scope` names the board: 'delivery' or 'pursuit'. Left out,
      // an engagement means its pursuit board and a delivery project its own.
      async getProjectKanbanConfig(projectId, token, { scope = '' } = {}) {
        const result = await request(`/api/projects/${projectId}/kanban/config${boardScopeQuery(scope)}`, {
          token,
        });

        return result.data;
      },
      async saveProjectKanbanConfig(projectId, payload, token, { scope = '' } = {}) {
        const result = await request(`/api/projects/${projectId}/kanban/config${boardScopeQuery(scope)}`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async reorderProjectKanbanItem(projectId, payload, token, { scope = '' } = {}) {
        const result = await request(`/api/projects/${projectId}/kanban/reorder${boardScopeQuery(scope)}`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getProjectKanban(projectId, filters, token, { scope = '' } = {}) {
        const search = new URLSearchParams();
        if (scope) search.set('scope', scope);

        for (const sprintId of filters?.selectedSprintIds ?? []) {
          search.append('selectedSprintIds', sprintId);
        }
        for (const issueType of filters?.issueTypes ?? []) {
          search.append('issueTypes', issueType);
        }
        for (const assigneeId of filters?.assigneeIds ?? []) {
          search.append('assigneeIds', assigneeId);
        }
        for (const statusValue of filters?.statusValues ?? []) {
          search.append('statusValues', statusValue);
        }

        if (filters?.search) {
          search.set('search', filters.search);
        }
        if (filters?.hideDone) {
          search.set('hideDone', 'true');
        }
        if (filters?.includeBacklog === false) {
          search.set('includeBacklog', 'false');
        }

        const suffix = search.toString() ? `?${search.toString()}` : '';
        const result = await request(`/api/projects/${projectId}/kanban${suffix}`, {
          token,
        });

        return result.data;
      },
      async getMentionables(projectId, query, token) {
        const search = new URLSearchParams();

        if (query) {
          search.set('query', query);
        }

        const result = await request(`/api/projects/${projectId}/mentionables?${search.toString()}`, {
          token,
        });

        return result.data;
      },
      async getComments(projectId, payload, token) {
        const search = new URLSearchParams({
          targetId: payload.targetId,
          targetType: payload.targetType,
        });
        const result = await request(`/api/projects/${projectId}/comments?${search.toString()}`, {
          token,
        });

        return result.data;
      },
      async addComment(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/comments`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async updateComment(projectId, commentId, payload, token) {
        const result = await request(`/api/projects/${projectId}/comments/${commentId}`, {
          body: payload,
          method: 'PUT',
          token,
        });

        return result.data;
      },
      async deleteComment(projectId, commentId, token) {
        const result = await request(`/api/projects/${projectId}/comments/${commentId}`, {
          method: 'DELETE',
          token,
        });

        return result.data;
      },
      async voteComment(projectId, commentId, payload, token) {
        const result = await request(`/api/projects/${projectId}/comments/${commentId}/vote`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getFiles(projectId, payload, token) {
        const search = new URLSearchParams({
          targetId: payload.targetId,
          targetType: payload.targetType,
        });
        const result = await request(`/api/projects/${projectId}/files?${search.toString()}`, {
          token,
        });

        return result.data;
      },
      async getFileContent(fileId, token, { download = false, version = null } = {}) {
        const search = new URLSearchParams();
        if (download) search.set('download', '1');
        if (version) search.set('version', String(version));
        const query = search.toString();
        return binaryRequest(`/api/files/${fileId}/content${query ? `?${query}` : ''}`, {
          token,
        });
      },
      async getFileVersions(projectId, fileId, token) {
        return (await request(`/api/projects/${projectId}/files/${fileId}/versions`, { token })).data;
      },
      async uploadFileVersion(projectId, fileId, payload, token) {
        return (await request(`/api/projects/${projectId}/files/${fileId}/versions`, { body: payload, method: 'POST', token })).data;
      },
      async restoreFileVersion(projectId, fileId, version, payload, token) {
        return (await request(`/api/projects/${projectId}/files/${fileId}/versions/${version}/restore`, { body: payload, method: 'POST', token })).data;
      },
      async linkFile(projectId, fileId, payload, token) {
        return (await request(`/api/projects/${projectId}/files/${fileId}/links`, { body: payload, method: 'POST', token })).data;
      },
      async unlinkFile(projectId, fileId, linkId, token) {
        return (await request(`/api/projects/${projectId}/files/${fileId}/links/${linkId}`, { method: 'DELETE', token })).data;
      },
      // Internal (the team only) or external (shared with the project's stakeholders).
      async setFileAudience(projectId, fileId, audience, token) {
        return (await request(`/api/projects/${projectId}/files/${pathSegment(fileId)}/audience`, { body: { audience }, method: 'PATCH', token })).data;
      },
      // Large files: uploads in parts, signed downloads, old versions.
      async startFileUpload(projectId, payload, token) {
        return (await request(`/api/projects/${projectId}/uploads`, { body: payload, method: 'POST', token })).data;
      },
      async getFileUpload(projectId, uploadId, token) {
        return (await request(`/api/projects/${projectId}/uploads/${pathSegment(uploadId)}`, { token })).data;
      },
      async signFileUploadParts(projectId, uploadId, partNumbers, token) {
        return (await request(`/api/projects/${projectId}/uploads/${pathSegment(uploadId)}/parts`, { body: { partNumbers }, method: 'POST', token })).data;
      },
      async completeFileUpload(projectId, uploadId, payload, token) {
        return (await request(`/api/projects/${projectId}/uploads/${pathSegment(uploadId)}/complete`, { body: payload ?? {}, method: 'POST', token })).data;
      },
      async cancelFileUpload(projectId, uploadId, token) {
        return (await request(`/api/projects/${projectId}/uploads/${pathSegment(uploadId)}`, { method: 'DELETE', token })).data;
      },
      async getFileDownloadUrl(projectId, fileId, { inline = false, version = null } = {}, token) {
        const search = new URLSearchParams();
        if (inline) search.set('disposition', 'inline');
        if (version) search.set('version', String(version));
        const query = search.toString();
        return (await request(`/api/projects/${projectId}/files/${pathSegment(fileId)}/download-url${query ? `?${query}` : ''}`, { token })).data;
      },
      // What the files panel's viewer shows for a version: { kind, url, reason }.
      async getFilePreviewUrl(projectId, fileId, { version = null } = {}, token) {
        const query = version ? `?version=${encodeURIComponent(String(version))}` : '';
        return (await request(`/api/projects/${projectId}/files/${pathSegment(fileId)}/preview-url${query}`, { token })).data;
      },
      async deleteFileVersion(projectId, fileId, version, token) {
        return (await request(`/api/projects/${projectId}/files/${pathSegment(fileId)}/versions/${pathSegment(version)}`, { method: 'DELETE', token })).data;
      },
      async getFileStorage(projectId, token) {
        return (await request(`/api/projects/${projectId}/file-storage`, { token })).data;
      },
      // Channels: conversations, unread markers, library folders,
      // file comments and the editing marker. Every project has them.
      async listChannels(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels`, { token })).data;
      },
      async createChannel(projectId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels`, { body: payload, method: 'POST', token })).data;
      },
      async updateChannel(projectId, channelId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}`, { body: payload, method: 'PATCH', token })).data;
      },
      async archiveChannel(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}`, { method: 'DELETE', token })).data;
      },
      async restoreChannel(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/restore`, { body: {}, method: 'POST', token })).data;
      },
      async getChannelNotificationLevel(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/notification-level`, { token })).data;
      },
      // `level` is 'all', 'mentions', 'off', or null for the default.
      async setChannelNotificationLevel(projectId, channelId, level, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/notification-level`, { body: { level }, method: 'PUT', token })).data;
      },
      // The signed-in person's notifications, stream, focus and device push (/api/me).
      async listNotifications(token) {
        return (await request('/api/me/notifications', { token })).data;
      },
      async markNotificationsRead(payload, token) {
        return (await request('/api/me/notifications/read', { body: payload, method: 'POST', token })).data;
      },
      async listNotificationLevels(token) {
        return (await request('/api/me/notification-levels', { token })).data;
      },
      // `leaving`: the page is unloading, so the request must outlive it.
      async sendNotificationFocus(focused, token, { leaving = false } = {}) {
        return (await request('/api/me/focus', { body: { clientId, focused }, ...(leaving ? { keepalive: true } : {}), method: 'POST', token })).data;
      },
      subscribeToMyEvents(token, { onClose, onError, onEvent } = {}) {
        return sharedPersonEvents.subscribe(token ?? '', { onClose, onError, onEvent });
      },
      async getPushConfig(token) {
        return (await request('/api/me/push', { token })).data;
      },
      async savePushSubscription(subscription, token) {
        return (await request('/api/me/push-subscriptions', { body: subscription, method: 'POST', token })).data;
      },
      async removePushSubscription(endpoint, token) {
        return (await request('/api/me/push-subscriptions', { body: { endpoint }, method: 'DELETE', token })).data;
      },
      async markChannelRead(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/read`, { body: {}, method: 'POST', token })).data;
      },
      async listChannelMentionables(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/mentionables`, { token })).data;
      },
      async listChannelPosts(projectId, channelId, { before = '', limit = 0 } = {}, token) {
        const search = new URLSearchParams();
        if (before) search.set('before', before);
        if (limit) search.set('limit', String(limit));
        const query = search.toString();
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/posts${query ? `?${query}` : ''}`, { token })).data;
      },
      async createChannelPost(projectId, channelId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/posts`, { body: payload, method: 'POST', token })).data;
      },
      // "Is typing" in a channel's box, or a thread's with parentId: { parentId?, typing }.
      async sendChannelTyping(projectId, channelId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/typing`, { body: payload, method: 'POST', token })).data;
      },
      // A channel post or a file comment.
      async updatePost(projectId, postId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}`, { body: payload, method: 'PATCH', token })).data;
      },
      async deletePost(projectId, postId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}`, { method: 'DELETE', token })).data;
      },
      // Adds (reacted: true) or takes back one emoji on a post or file comment.
      async setPostReaction(projectId, postId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}/reactions`, { body: payload, method: 'PUT', token })).data;
      },
      // Polls on posts: vote (again, to change it) and close.
      async votePoll(projectId, postId, answer, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}/poll/vote`, { body: { answer }, method: 'PUT', token })).data;
      },
      async closePoll(projectId, postId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}/poll/close`, { body: {}, method: 'POST', token })).data;
      },
      // Odin in channels: the confirm and undo buttons on Odin's replies (only the person who
      // tagged it can use them). Each channel's "Let Odin answer when tagged" saves with
      // updateChannel.
      async resolveOdinConfirmation(projectId, postId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}/odin/confirmation`, { body: payload, method: 'POST', token })).data;
      },
      async undoOdinChanges(projectId, postId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/posts/${pathSegment(postId)}/odin/undo`, { body: {}, method: 'POST', token })).data;
      },
      // The project's files as folders: the project at the top,
      // a folder per channel, and the folders people made in each channel.
      async getProjectFileTree(projectId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/file-tree`, { token })).data;
      },
      // Renames a file, moves it, or both. destination is { kind: 'project' } or { kind: 'channel',
      // channelId, folderId }. A move that shows the file to a channel's guests needs confirmGuests.
      async updateProjectFile(projectId, fileId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/files/${pathSegment(fileId)}`, { body: payload, method: 'PATCH', token })).data;
      },
      async listChannelFolders(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/folders`, { token })).data;
      },
      async createChannelFolder(projectId, channelId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/folders`, { body: payload, method: 'POST', token })).data;
      },
      async updateFolder(projectId, folderId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/folders/${pathSegment(folderId)}`, { body: payload, method: 'PATCH', token })).data;
      },
      async deleteFolder(projectId, folderId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/folders/${pathSegment(folderId)}`, { method: 'DELETE', token })).data;
      },
      async listFileComments(projectId, fileId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/files/${pathSegment(fileId)}/comments`, { token })).data;
      },
      async createFileComment(projectId, fileId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/files/${pathSegment(fileId)}/comments`, { body: payload, method: 'POST', token })).data;
      },
      async listFileMentionables(projectId, fileId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/files/${pathSegment(fileId)}/mentionables`, { token })).data;
      },
      async setFileEditing(projectId, fileId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/files/${pathSegment(fileId)}/editing`, { body: {}, method: 'PUT', token })).data;
      },
      async clearFileEditing(projectId, fileId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/files/${pathSegment(fileId)}/editing`, { method: 'DELETE', token })).data;
      },
      // A channel's guests. Inviting and removing need decision rights.
      async listChannelGuests(projectId, channelId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/guests`, { token })).data;
      },
      async inviteChannelGuest(projectId, channelId, payload, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/guests`, { body: payload, method: 'POST', token })).data;
      },
      async removeChannelGuest(projectId, channelId, stakeholderId, token) {
        return (await request(`/api/projects/${pathSegment(projectId)}/channels/${pathSegment(channelId)}/guests/${pathSegment(stakeholderId)}`, { method: 'DELETE', token })).data;
      },
      // Signature requests. Writes need decision rights.
      async listSigningRequests(projectId, { fileId = '', status = '' } = {}, token) {
        const search = new URLSearchParams();
        if (fileId) search.set('fileId', fileId);
        if (status) search.set('status', status);
        const query = search.toString();
        return (await request(`${signingPath(projectId)}${query ? `?${query}` : ''}`, { token })).data;
      },
      async getSigningRequest(projectId, requestId, token) {
        return (await request(signingPath(projectId, `/${pathSegment(requestId)}`), { token })).data;
      },
      async createSigningRequest(projectId, payload, token) {
        return (await request(signingPath(projectId), { body: payload, method: 'POST', token })).data;
      },
      async cancelSigningRequest(projectId, requestId, payload, token) {
        return (await request(signingPath(projectId, `/${pathSegment(requestId)}/cancel`), { body: payload ?? {}, method: 'POST', token })).data;
      },
      async removeSigningSigner(projectId, requestId, signerId, payload, token) {
        return (await request(signingPath(projectId, `/${pathSegment(requestId)}/signers/${pathSegment(signerId)}/remove`), { body: payload ?? {}, method: 'POST', token })).data;
      },
      async remindSigningSigners(projectId, requestId, payload, token) {
        return (await request(signingPath(projectId, `/${pathSegment(requestId)}/remind`), { body: payload ?? {}, method: 'POST', token })).data;
      },
      async getSigningCertificate(projectId, requestId, token) {
        return binaryRequest(signingPath(projectId, `/${pathSegment(requestId)}/certificate?download=1`), { token });
      },
      async getSigningDocument(projectId, requestId, position, token, { download = false } = {}) {
        return binaryRequest(signingPath(projectId, `/${pathSegment(requestId)}/documents/${pathSegment(position)}/content${download ? '?download=1' : ''}`), { token });
      },
      async uploadProjectFile(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/files`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async deleteFile(fileId, token) {
        const result = await request(`/api/files/${fileId}`, {
          method: 'DELETE',
          token,
        });

        return result.data;
      },
      async enhanceProjectDescription(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/ai/enhance-description`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async analyzeProject(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/ai/analyze`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async generateProjectStructure(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/ai/generate-structure`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async generateStories(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/ai/generate-stories`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async generateTasks(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/ai/generate-tasks`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async enhanceRichContent(projectId, payload, token) {
        const result = await request(`/api/projects/${projectId}/ai/enhance-content`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      // The assistant's chats (/api/assistant/chats). A message starts a turn that streams over
      // the chat's event channel.
      async listAssistantChats(token) {
        return (await request('/api/assistant/chats', { token })).data;
      },
      async createAssistantChat(payload, token) {
        return (await request('/api/assistant/chats', { body: payload, method: 'POST', token })).data;
      },
      async getAssistantChat(chatId, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}`, { token })).data;
      },
      async updateAssistantChat(chatId, payload, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}`, { body: payload, method: 'PATCH', token })).data;
      },
      async deleteAssistantChat(chatId, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}`, { method: 'DELETE', token })).data;
      },
      async sendAssistantMessage(chatId, payload, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}/messages`, { body: payload, method: 'POST', token })).data;
      },
      async cancelAssistantTurn(chatId, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}/cancel`, { method: 'POST', token })).data;
      },
      async confirmAssistantAction(chatId, payload, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}/confirmation`, { body: payload, method: 'POST', token })).data;
      },
      async undoAssistantChanges(chatId, messageId, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}/messages/${pathSegment(messageId)}/undo`, { method: 'POST', token })).data;
      },
      async resolveAssistantProposal(chatId, payload, token) {
        return (await request(`/api/assistant/chats/${pathSegment(chatId)}/proposals`, { body: payload, method: 'POST', token })).data;
      },
      subscribeToAssistantChatEvents(chatId, token, { onClose, onError, onEvent } = {}) {
        return subscribe(`/api/assistant/chats/${pathSegment(chatId)}/events`, { method: 'GET', onClose, onError, onEvent, token });
      },
      subscribeToAssistantChatsEvents(token, { onClose, onError, onEvent } = {}) {
        return subscribe('/api/assistant/chats/events', { method: 'GET', onClose, onError, onEvent, token });
      },
      async getProjectAssistantClarifications(projectId, token) {
        const result = await request(`/api/assistant/projects/${projectId}/clarifications`, {
          token,
        });

        return result.data;
      },
      async createProjectAssistantStakeholderContact(projectId, payload, token) {
        const result = await request(`/api/assistant/projects/${projectId}/stakeholder-contacts`, {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async updateProjectAssistantStakeholderContact(projectId, stakeholderId, payload, token) {
        const result = await request(`/api/assistant/projects/${projectId}/stakeholder-contacts/${pathSegment(stakeholderId)}`, {
          body: payload,
          method: 'PATCH',
          token,
        });

        return result.data;
      },
      // Shared: subscribers for the same project and session use one stream (see
      // lib/projects/shared-project-events.js). Each still gets its own onClose or onError.
      subscribeToProjectEvents(projectId, token, { onClose, onError, onEvent } = {}) {
        return sharedProjectEvents.subscribe(JSON.stringify([String(projectId ?? ''), token ?? '']), { onClose, onError, onEvent });
      },
      // Changes anywhere in the workspace, for screens that span projects. Shared like the above.
      subscribeToWorkspaceEvents(token, { onClose, onError, onEvent } = {}) {
        return sharedWorkspaceEvents.subscribe(token ?? '', { onClose, onError, onEvent });
      },
      // Requirements workspace (/api/projects/:projectId/requirements).
      async getRequirementsOverview(projectId, token) {
        return (await request(requirementsPath(projectId), { token })).data;
      },
      async getRequirementsMyItems(projectId, token) {
        return (await request(requirementsPath(projectId, '/my-items'), { token })).data;
      },
      // Per-project "waiting on you" counts and open reviews for the projects list.
      async getRequirementsProjectSignals(token) {
        return (await request('/api/requirements/project-signals', { token })).data;
      },
      async listRequirementsTopics(projectId, track, { include = '', q = '', view = 'all' } = {}, token) {
        const search = new URLSearchParams({ view });
        if (q) search.set('q', q);
        if (include) search.set('include', include);
        return (await request(requirementsPath(projectId, `/tracks/${pathSegment(track)}/topics?${search}`), { token })).data;
      },
      // One action over many topics: { action, topicIds, assign?, statement? }. Returns a result per topic.
      async bulkRequirementsTopics(projectId, payload, token) {
        return (await request(requirementsPath(projectId, '/topics/bulk'), { body: payload, method: 'POST', token })).data;
      },
      async createRequirementsTopic(projectId, track, payload, token) {
        return (await request(requirementsPath(projectId, `/tracks/${pathSegment(track)}/topics`), { body: payload, method: 'POST', token })).data;
      },
      async draftRequirementsQuestions(projectId, track, token) {
        return (await request(requirementsPath(projectId, `/tracks/${pathSegment(track)}/draft-questions`), { body: {}, method: 'POST', token })).data;
      },
      async getRequirementsTopic(projectId, topicId, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}`), { token })).data;
      },
      async updateRequirementsTopic(projectId, topicId, payload, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}`), { body: payload, method: 'PATCH', token })).data;
      },
      async moveRequirementsTopic(projectId, topicId, track, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/move`), { body: { track }, method: 'POST', token })).data;
      },
      async deleteRequirementsTopic(projectId, topicId, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}`), { method: 'DELETE', token })).data;
      },
      async listRequirementsTopicMentionables(projectId, topicId, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/mentionables`), { token })).data;
      },
      async commentRequirementsTopic(projectId, topicId, payload, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/comments`), { body: payload, method: 'POST', token })).data;
      },
      async updateRequirementsTopicComment(projectId, topicId, commentId, payload, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/comments/${pathSegment(commentId)}`), { body: payload, method: 'PATCH', token })).data;
      },
      async deleteRequirementsTopicComment(projectId, topicId, commentId, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/comments/${pathSegment(commentId)}`), { method: 'DELETE', token })).data;
      },
      async voteRequirementsTopicComment(projectId, topicId, commentId, payload, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/comments/${pathSegment(commentId)}/vote`), { body: payload, method: 'POST', token })).data;
      },
      async recordRequirementsDecision(projectId, payload, token) {
        return (await request(requirementsPath(projectId, '/decisions'), { body: payload, method: 'POST', token })).data;
      },
      async updateRequirementsDecision(projectId, decisionId, payload, token) {
        return (await request(requirementsPath(projectId, `/decisions/${pathSegment(decisionId)}`), { body: payload, method: 'PATCH', token })).data;
      },
      async listRequirementsDecisions(projectId, track, { kind = '' } = {}, token) {
        const query = kind ? `?${new URLSearchParams({ kind })}` : '';
        return (await request(requirementsPath(projectId, `/tracks/${pathSegment(track)}/decisions${query}`), { token })).data;
      },
      async listRequirementsPreferences(projectId, track, token) {
        return (await request(requirementsPath(projectId, `/tracks/${pathSegment(track)}/preferences`), { token })).data;
      },
      async acceptRequirementsPreference(projectId, payload, token) {
        return (await request(requirementsPath(projectId, '/preferences/accept'), { body: payload, method: 'POST', token })).data;
      },
      async listRequirementsLinks(projectId, token) {
        return (await request(requirementsPath(projectId, '/links'), { token })).data;
      },
      async createRequirementsLink(projectId, payload, token) {
        return (await request(requirementsPath(projectId, '/links'), { body: payload, method: 'POST', token })).data;
      },
      async revokeRequirementsLink(projectId, linkId, token) {
        return (await request(requirementsPath(projectId, `/links/${pathSegment(linkId)}/revoke`), { body: {}, method: 'POST', token })).data;
      },
      async extendRequirementsLink(projectId, linkId, payload, token) {
        return (await request(requirementsPath(projectId, `/links/${pathSegment(linkId)}/extend`), { body: payload, method: 'POST', token })).data;
      },
      async refreshRequirementsTopicSummary(projectId, topicId, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/summary/refresh`), { body: {}, method: 'POST', token })).data;
      },
      async getRequirementsTopicSummaryHistory(projectId, topicId, token) {
        return (await request(requirementsPath(projectId, `/topics/${pathSegment(topicId)}/summary/history`), { token })).data;
      },
      // Review packages (/requirements/packages). The upload sends the zip as the raw body.
      async listRequirementsPackages(projectId, track, token) {
        const query = track ? `?${new URLSearchParams({ track })}` : '';
        return (await request(requirementsPath(projectId, `/packages${query}`), { token })).data;
      },
      async getRequirementsPackage(projectId, packageId, token) {
        return (await request(requirementsPath(projectId, `/packages/${pathSegment(packageId)}`), { token })).data;
      },
      async getRequirementsPackageGrant(projectId, packageId, token) {
        return (await request(requirementsPath(projectId, `/packages/${pathSegment(packageId)}/grant`), { token })).data;
      },
      async withdrawRequirementsPackage(projectId, packageId, token) {
        return (await request(requirementsPath(projectId, `/packages/${pathSegment(packageId)}`), { method: 'DELETE', token })).data;
      },
      async getRequirementsAgentBrief(projectId, track, token) {
        return (await request(requirementsPath(projectId, `/tracks/${pathSegment(track)}/agent-brief`), { token })).data;
      },
      async getRequirementsPackageKit(projectId, token) {
        return binaryRequest(requirementsPath(projectId, '/packages/kit'), { token });
      },
      async createRequirementsPackageUploadUrl(projectId, track, token) {
        return (await request(requirementsPath(projectId, '/packages/upload-urls'), { body: { track }, method: 'POST', token })).data;
      },
      async uploadRequirementsPackage(projectId, track, file, token, { onProgress, signal } = {}) {
        const query = new URLSearchParams({ track });
        return (await uploadRequest(requirementsPath(projectId, `/packages/upload?${query}`), {
          body: file,
          contentType: 'application/zip',
          method: 'POST',
          onProgress,
          signal,
          token,
        })).data;
      },
      // The zip becomes the track's next draft version and the draft it replaces is withdrawn.
      async replaceRequirementsPackage(projectId, packageId, file, token, { onProgress, signal } = {}) {
        return (await uploadRequest(requirementsPath(projectId, `/packages/${pathSegment(packageId)}/replace`), {
          body: file,
          contentType: 'application/zip',
          method: 'POST',
          onProgress,
          signal,
          token,
        })).data;
      },
      // Review rounds for the team (/requirements/rounds): list, publish, read, results,
      // change, close, resend, and summary refresh.
      async listRequirementsRounds(projectId, track, token) {
        const query = track ? `?${new URLSearchParams({ track })}` : '';
        return (await request(requirementsPath(projectId, `/rounds${query}`), { token })).data;
      },
      async publishRequirementsRound(projectId, payload, token) {
        return (await request(requirementsPath(projectId, '/rounds'), { body: payload, method: 'POST', token })).data;
      },
      async getRequirementsRound(projectId, roundId, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}`), { token })).data;
      },
      async getRequirementsRoundResults(projectId, roundId, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}/results`), { token })).data;
      },
      async getRequirementsRoundAnnotations(projectId, roundId, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}/annotations`), { token })).data;
      },
      async getRequirementsRoundFeedback(projectId, roundId, { cursor = '', limit = 0 } = {}, token) {
        const search = new URLSearchParams();
        if (limit) search.set('limit', String(limit));
        if (cursor) search.set('cursor', cursor);
        const query = search.toString() ? `?${search}` : '';
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}/feedback${query}`), { token })).data;
      },
      async updateRequirementsRound(projectId, roundId, payload, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}`), { body: payload, method: 'PATCH', token })).data;
      },
      async closeRequirementsRound(projectId, roundId, payload, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}/close`), { body: payload, method: 'POST', token })).data;
      },
      async resendRequirementsRoundInvitation(projectId, roundId, reviewerId, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}/reviewers/${pathSegment(reviewerId)}/resend`), { body: {}, method: 'POST', token })).data;
      },
      async refreshRequirementsRoundSummary(projectId, roundId, { screenId = '' } = {}, token) {
        return (await request(requirementsPath(projectId, `/rounds/${pathSegment(roundId)}/summary/refresh`), { body: { screenId }, method: 'POST', token })).data;
      },
      // Track plans (/requirements/plans): list, read, draft, edit, approve, propose work.
      async listRequirementsPlans(projectId, track, token) {
        const query = track ? `?${new URLSearchParams({ track })}` : '';
        return (await request(requirementsPath(projectId, `/plans${query}`), { token })).data;
      },
      async getRequirementsPlan(projectId, planId, token) {
        return (await request(requirementsPath(projectId, `/plans/${pathSegment(planId)}`), { token })).data;
      },
      async draftRequirementsPlan(projectId, track, token) {
        return (await request(requirementsPath(projectId, `/plans/${pathSegment(track)}/draft`), { body: {}, method: 'POST', token })).data;
      },
      async updateRequirementsPlan(projectId, planId, payload, token) {
        return (await request(requirementsPath(projectId, `/plans/${pathSegment(planId)}`), { body: payload, method: 'PATCH', token })).data;
      },
      async approveRequirementsPlan(projectId, planId, payload, token) {
        return (await request(requirementsPath(projectId, `/plans/${pathSegment(planId)}/approve`), { body: payload ?? {}, method: 'POST', token })).data;
      },
      async proposeRequirementsPlanWork(projectId, planId, token) {
        return (await request(requirementsPath(projectId, `/plans/${pathSegment(planId)}/propose-work`), { body: {}, method: 'POST', token })).data;
      },
      // --- Client portal and guided review ------------------------------------------
      // Client portal (/api/public/requirements/:token). The link token is the only
      // credential; nothing here sends a session token.
      async getRequirementsPortal(portalToken) {
        return (await request(requirementsPortalPath(portalToken))).data;
      },
      async requestRequirementsPortalLink(portalToken) {
        return (await request(requirementsPortalPath(portalToken, '/link-request'), { body: {}, method: 'POST' })).data;
      },
      async listRequirementsPortalRounds(portalToken) {
        return (await request(requirementsPortalPath(portalToken, '/rounds'))).data;
      },
      async getRequirementsPortalTopic(portalToken, topicId) {
        return (await request(requirementsPortalPath(portalToken, `/topics/${pathSegment(topicId)}`))).data;
      },
      async listRequirementsPortalTopicMentionables(portalToken, topicId) {
        return (await request(requirementsPortalPath(portalToken, `/topics/${pathSegment(topicId)}/mentionables`))).data;
      },
      async commentRequirementsPortalTopic(portalToken, topicId, payload) {
        return (await request(requirementsPortalPath(portalToken, `/topics/${pathSegment(topicId)}/comments`), { body: payload, method: 'POST' })).data;
      },
      async updateRequirementsPortalComment(portalToken, topicId, commentId, payload) {
        return (await request(requirementsPortalPath(portalToken, `/topics/${pathSegment(topicId)}/comments/${pathSegment(commentId)}`), { body: payload, method: 'PATCH' })).data;
      },
      async deleteRequirementsPortalComment(portalToken, topicId, commentId) {
        return (await request(requirementsPortalPath(portalToken, `/topics/${pathSegment(topicId)}/comments/${pathSegment(commentId)}`), { method: 'DELETE' })).data;
      },
      async voteRequirementsPortalComment(portalToken, topicId, commentId, payload) {
        return (await request(requirementsPortalPath(portalToken, `/topics/${pathSegment(topicId)}/comments/${pathSegment(commentId)}/vote`), { body: payload, method: 'POST' })).data;
      },
      // Shared documents and signature requests in the portal.
      async getRequirementsPortalDocuments(portalToken) {
        return (await request(requirementsPortalPath(portalToken, '/documents'))).data;
      },
      async getRequirementsPortalDocumentContent(portalToken, fileId, { download = false } = {}) {
        return binaryRequest(requirementsPortalPath(portalToken, `/documents/${pathSegment(fileId)}/content${download ? '?download=1' : ''}`));
      },
      async getRequirementsPortalSigning(portalToken, requestId) {
        return (await request(requirementsPortalPath(portalToken, `/signing/${pathSegment(requestId)}`))).data;
      },
      async getRequirementsPortalSigningDocument(portalToken, requestId, position, { download = false } = {}) {
        return binaryRequest(requirementsPortalPath(portalToken, `/signing/${pathSegment(requestId)}/documents/${pathSegment(position)}/content${download ? '?download=1' : ''}`));
      },
      async getRequirementsPortalSigningCertificate(portalToken, requestId) {
        return binaryRequest(requirementsPortalPath(portalToken, `/signing/${pathSegment(requestId)}/certificate?download=1`));
      },
      async sendRequirementsPortalSigningCode(portalToken, requestId) {
        return (await request(requirementsPortalPath(portalToken, `/signing/${pathSegment(requestId)}/code`), { body: {}, method: 'POST' })).data;
      },
      async signRequirementsPortalRequest(portalToken, requestId, payload) {
        return (await request(requirementsPortalPath(portalToken, `/signing/${pathSegment(requestId)}/sign`), { body: payload, method: 'POST' })).data;
      },
      async declineRequirementsPortalRequest(portalToken, requestId, payload) {
        return (await request(requirementsPortalPath(portalToken, `/signing/${pathSegment(requestId)}/decline`), { body: payload ?? {}, method: 'POST' })).data;
      },
      subscribeToRequirementsPortalEvents(portalToken, { onClose, onError, onEvent } = {}) {
        return subscribe(requirementsPortalPath(portalToken, '/events'), { method: 'GET', onClose, onError, onEvent, skipAuthRedirect: true });
      },
      // Guided review, shared by team members and stakeholders. `scope` is
      // { projectId, roundId } for a signed-in member or { portalToken, roundId } for a link.
      async getRequirementsReview(scope, token) {
        return (await request(requirementsReviewPath(scope), { token: reviewToken(scope, token) })).data;
      },
      async saveRequirementsReviewPosition(scope, payload, token) {
        return (await request(requirementsReviewPath(scope, '/position'), { body: payload, method: 'PUT', token: reviewToken(scope, token) })).data;
      },
      async saveRequirementsReviewDirection(scope, directionId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/directions/${pathSegment(directionId)}`), { body: payload, method: 'PUT', token: reviewToken(scope, token) })).data;
      },
      async clearRequirementsReviewDirection(scope, directionId, token) {
        return (await request(requirementsReviewPath(scope, `/directions/${pathSegment(directionId)}`), { method: 'DELETE', token: reviewToken(scope, token) })).data;
      },
      async saveRequirementsReviewVerdict(scope, screenId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/screens/${pathSegment(screenId)}/verdict`), { body: payload, method: 'PUT', token: reviewToken(scope, token) })).data;
      },
      async clearRequirementsReviewVerdict(scope, screenId, token) {
        return (await request(requirementsReviewPath(scope, `/screens/${pathSegment(screenId)}/verdict`), { method: 'DELETE', token: reviewToken(scope, token) })).data;
      },
      async saveRequirementsReviewAnswer(scope, questionId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/questions/${pathSegment(questionId)}/answer`), { body: payload, method: 'PUT', token: reviewToken(scope, token) })).data;
      },
      async clearRequirementsReviewAnswer(scope, questionId, token) {
        return (await request(requirementsReviewPath(scope, `/questions/${pathSegment(questionId)}/answer`), { method: 'DELETE', token: reviewToken(scope, token) })).data;
      },
      async saveRequirementsReviewAnnotation(scope, annotationId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}`), { body: payload, method: 'PUT', token: reviewToken(scope, token) })).data;
      },
      async deleteRequirementsReviewAnnotation(scope, annotationId, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}`), { method: 'DELETE', token: reviewToken(scope, token) })).data;
      },
      async setRequirementsReviewAnnotationStatus(scope, annotationId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/status`), { body: payload, method: 'POST', token: reviewToken(scope, token) })).data;
      },
      async carryRequirementsReviewAnnotation(scope, annotationId, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/carry`), { body: {}, method: 'POST', token: reviewToken(scope, token) })).data;
      },
      async closeRequirementsReviewAnnotation(scope, annotationId, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/close`), { body: {}, method: 'POST', token: reviewToken(scope, token) })).data;
      },
      async listRequirementsReviewAnnotationMentionables(scope, annotationId, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/mentionables`), { token: reviewToken(scope, token) })).data;
      },
      async commentRequirementsReviewAnnotation(scope, annotationId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/comments`), { body: payload, method: 'POST', token: reviewToken(scope, token) })).data;
      },
      async updateRequirementsReviewAnnotationComment(scope, annotationId, commentId, payload, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/comments/${pathSegment(commentId)}`), { body: payload, method: 'PATCH', token: reviewToken(scope, token) })).data;
      },
      async deleteRequirementsReviewAnnotationComment(scope, annotationId, commentId, token) {
        return (await request(requirementsReviewPath(scope, `/annotations/${pathSegment(annotationId)}/comments/${pathSegment(commentId)}`), { method: 'DELETE', token: reviewToken(scope, token) })).data;
      },
      // The bridge's PNG goes up as the raw body, outside the 1 MB JSON limit.
      async uploadRequirementsReviewSnapshot(scope, blob, { screenId = '', stateKey = '' } = {}, token) {
        const search = new URLSearchParams();
        if (screenId) search.set('screenId', screenId);
        if (stateKey) search.set('stateKey', stateKey);
        const query = search.toString() ? `?${search}` : '';
        return (await uploadRequest(requirementsReviewPath(scope, `/snapshots${query}`), { body: blob, contentType: 'image/png', method: 'POST', token: reviewToken(scope, token) })).data;
      },
      // Snapshot URLs come from the review API; only those paths are fetched.
      async getRequirementsReviewSnapshot(path, token) {
        if (!isRequirementsSnapshotPath(path)) throw new ApiError('Not a snapshot address.', { status: 400 });
        return binaryRequest(path, { token: String(path).startsWith('/api/public/') ? undefined : token });
      },
      async submitRequirementsReview(scope, token) {
        return (await request(requirementsReviewPath(scope, '/submit'), { body: {}, method: 'POST', token: reviewToken(scope, token) })).data;
      },
      // --- end client portal and guided review -----------------------------------------
      async getNextRankingPair(token) {
        const result = await request('/api/ranking/next-pair', {
          token,
        });

        return result.data;
      },
      async submitRankingVote(payload, token) {
        const result = await request('/api/ranking/vote', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async skipRankingPair(payload, token) {
        const result = await request('/api/ranking/skip', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getRankingCompletionStatus(payload, token) {
        const search = new URLSearchParams();

        if (payload?.threshold != null) {
          search.set('threshold', String(payload.threshold));
        }

        const result = await request(`/api/ranking/completion-status?${search.toString()}`, {
          token,
        });

        return result.data;
      },
      async getRankingLeaderboard(token) {
        const result = await request('/api/ranking/leaderboard', {
          token,
        });

        return result.data;
      },
      async getRankingHeadToHead(projectId, token) {
        const result = await request(`/api/ranking/head-to-head/${projectId}`, {
          token,
        });

        return result.data;
      },
      async getContributorLeaderboard(payload, token) {
        const search = new URLSearchParams();

        if (payload?.days != null) {
          search.set('days', String(payload.days));
        }

        const result = await request(`/api/metrics/leaderboard?${search.toString()}`, {
          token,
        });

        return result.data;
      },
      // Home (backend/src/modules/home): one payload per view, the saved view, and staging a
      // recovery proposal into an AI Workspace session.
      async getHome(payload, token) {
        const lens = payload?.lens ? `?lens=${encodeURIComponent(payload.lens)}` : '';
        return (await request(`/api/home${lens}`, { token })).data;
      },
      async saveHomeLens(lens, token) {
        return (await request('/api/home/lens', { body: { lens }, method: 'PUT', token })).data;
      },
      async stageHomeRecoveryProposal(proposalId, token) {
        return (await request(`/api/home/recovery/${pathSegment(proposalId)}/stage`, { method: 'POST', token })).data;
      },
      async keepAlive() {
        const result = await request('/api/auth/refresh', {
          method: 'POST',
          skipAuthRedirect: true,
        });

        return result.data;
      },
      async refreshSession(_refreshToken, options = {}) {
        const result = await request('/api/auth/refresh', {
          ...options,
          method: 'POST',
        });

        return result.data;
      },
      async verifyTwoFactor(payload) {
        const result = await request('/api/auth/two-factor/verify', {
          body: payload,
          method: 'POST',
          skipAuthRedirect: true,
        });

        return result.data;
      },
      async logout(token) {
        const result = await request('/api/auth/logout', {
          method: 'POST',
          skipAuthRedirect: true,
          token,
        });

        return result.data;
      },
      async switchTenant(tenantId, token) {
        const result = await request('/api/auth/switch-tenant', {
          body: { tenantId },
          method: 'POST',
          token,
        });

        return result.data;
      },
      async initTwoFactor(token) {
        const result = await request('/api/auth/two-factor/init', {
          body: {},
          method: 'POST',
          token,
        });

        return result.data;
      },
      async enableTwoFactor(token, payload) {
        const result = await request('/api/auth/two-factor/enable', {
          body: payload,
          method: 'POST',
          token,
        });

        return result.data;
      },
      async getBackupCodes(token) {
        const result = await request('/api/auth/two-factor/backup-codes', {
          token,
        });

        return result.data;
      },
      async disableTwoFactor(token) {
        const result = await request('/api/auth/two-factor/disable', {
          body: {},
          method: 'POST',
          token,
        });

        return result.data;
      },
    };

    client.withSignal = (signal) => buildClient({ ...scope, signal });
    client.withWorking = (mode) => {
      const working = normalizeWorkingMode(mode);
      if (scope.signal) {
        return buildClient({ ...scope, working });
      }
      if (!scopedClients.has(working)) {
        scopedClients.set(working, buildClient({ working }));
      }
      return scopedClients.get(working);
    };
    Object.defineProperties(client, {
      blocking: { get: () => client.withWorking('blocking') },
      passive: { get: () => client.withWorking('passive') },
    });

    return client;
  }

  return buildClient({ working: null });
}
