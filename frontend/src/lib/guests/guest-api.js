// The API a channel guest's browser talks to (docs/engagements/plan.md, Guests): /api/guest only.
// The session is an HttpOnly cookie the server sets at sign-in; writes send the readable
// odin_guest_csrf cookie back in X-CSRF-Token, as members' writes send theirs.
//
// The channel screens (components/channels, the files panel and the viewer) call the app's API
// client by method name. createGuestApi() offers the same names with the same arguments, so the
// guest view provides it in their place (lib/channels/channel-api.js). The project id and member
// token those methods take are ignored: the server finds the project from the channel or file,
// and checks the guest's channels on every request. Member-only methods are absent.
import { createSharedEventStreams } from '../projects/shared-project-events.js';
import { ApiError } from '../api/client.js';
import { resolveApiBaseUrl } from '../api/base-url.js';

export const GUEST_CSRF_COOKIE = 'odin_guest_csrf';
// A non-empty token for screens that wait for one: guests have a cookie instead.
export const GUEST_SESSION_MARKER = 'guest-session';

const seg = (value) => encodeURIComponent(String(value ?? ''));

function readCookie(name) {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  const part = String(document.cookie ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!part) return '';
  try {
    return decodeURIComponent(part.slice(prefix.length));
  } catch {
    return '';
  }
}

/** Splits a text/event-stream body into { type, data } events; returns what is left over. */
export function parseSseChunk(buffer, onEvent) {
  let rest = buffer;
  let index;
  while ((index = rest.search(/\r?\n\r?\n/)) >= 0) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + (rest[index] === '\r' ? 4 : 2));
    let type = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    let parsed = null;
    try {
      parsed = data.length ? JSON.parse(data.join('\n')) : null;
    } catch {
      parsed = null;
    }
    onEvent({ data: parsed, type });
  }
  return rest;
}

export function createGuestApi({
  baseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const clientId = globalThis.crypto?.randomUUID?.() ?? `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const url = (path) => new URL(path.replace(/^\//, ''), root).toString();

  async function request(path, { body, keepalive = false, method = 'GET', signal } = {}) {
    const unsafe = !['GET', 'HEAD'].includes(method);
    const csrf = unsafe ? readCookie(GUEST_CSRF_COOKIE) : '';
    const response = await fetchImpl(url(path), {
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Odin-Client-Id': clientId,
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      ...(keepalive ? { keepalive: true } : {}),
      method,
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error ?? 'Request failed.', { data, status: response.status });
    return data;
  }
  const g = (path) => `/api/guest${path}`;
  // Closes while the tab is hidden, as the members' streams do (shared-project-events.js).
  const sharedEvents = createSharedEventStreams({ document: globalThis.document ?? null, open: (key, handlers) => openStream(key, handlers) });
  const unsupported = () => {
    throw new ApiError('Guests upload in parts only.', { data: { details: { code: 'large_uploads_unavailable' } }, status: 503 });
  };

  const api = {
    baseUrl: root.replace(/\/$/, ''),
    clientId,
    isGuest: true,
    resolveTransferUrl(value) {
      return /^https?:\/\//i.test(value) ? value : new URL(String(value).replace(/^\//, ''), root).toString();
    },

    // Signing in and out.
    requestSignInCode: (email, workspace = '') => request(g('/sign-in/code'), { body: { email, workspace }, method: 'POST' }),
    signIn: (email, code, workspace = '') => request(g('/sign-in'), { body: { code, email, workspace }, method: 'POST' }),
    signOut: () => request(g('/sign-out'), { body: {}, method: 'POST' }),
    getSession: () => request(g('/session')),
    listEngagements: () => request(g('/engagements')),
    getChannel: (channelId) => request(g(`/channels/${seg(channelId)}`)),
    listTasks: (projectId) => request(g(`/projects/${seg(projectId)}/tasks`)),
    // A pursuit task of the guest: status, comments and attachments (guest-tasks.js on the server).
    updateTask: (projectId, taskId, payload) => request(g(`/projects/${seg(projectId)}/tasks/${seg(taskId)}`), { body: payload, method: 'PATCH' }),
    listTaskComments: (projectId, taskId) => request(g(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`)),
    addTaskComment: (projectId, taskId, text) => request(g(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`), { body: { text }, method: 'POST' }),
    listTaskFiles: (projectId, taskId) => request(g(`/projects/${seg(projectId)}/tasks/${seg(taskId)}/files`)),

    // The channel screens' methods, by the app client's names.
    markChannelRead: (_projectId, channelId) => request(g(`/channels/${seg(channelId)}/read`), { body: {}, method: 'POST' }),
    listChannelMentionables: (_projectId, channelId) => request(g(`/channels/${seg(channelId)}/mentionables`)),
    listChannelPosts(_projectId, channelId, { before = '', limit = 0 } = {}) {
      const search = new URLSearchParams();
      if (before) search.set('before', before);
      if (limit) search.set('limit', String(limit));
      const query = search.toString();
      return request(g(`/channels/${seg(channelId)}/posts${query ? `?${query}` : ''}`));
    },
    createChannelPost: (_projectId, channelId, payload) => request(g(`/channels/${seg(channelId)}/posts`), { body: payload, method: 'POST' }),
    sendChannelTyping: (_projectId, channelId, payload) => request(g(`/channels/${seg(channelId)}/typing`), { body: payload, method: 'POST' }),
    updatePost: (_projectId, postId, payload) => request(g(`/posts/${seg(postId)}`), { body: payload, method: 'PATCH' }),
    deletePost: (_projectId, postId) => request(g(`/posts/${seg(postId)}`), { method: 'DELETE' }),
    setPostReaction: (_projectId, postId, payload) => request(g(`/posts/${seg(postId)}/reactions`), { body: payload, method: 'PUT' }),
    votePoll: (_projectId, postId, answer) => request(g(`/posts/${seg(postId)}/poll/vote`), { body: { answer }, method: 'PUT' }),
    closePoll: (_projectId, postId) => request(g(`/posts/${seg(postId)}/poll/close`), { body: {}, method: 'POST' }),
    listChannelFolders: (_projectId, channelId) => request(g(`/channels/${seg(channelId)}/folders`)),
    listFileComments: (_projectId, fileId) => request(g(`/files/${seg(fileId)}/comments`)),
    createFileComment: (_projectId, fileId, payload) => request(g(`/files/${seg(fileId)}/comments`), { body: payload, method: 'POST' }),
    listFileMentionables: (_projectId, fileId) => request(g(`/files/${seg(fileId)}/mentionables`)),
    setFileEditing: (_projectId, fileId) => request(g(`/files/${seg(fileId)}/editing`), { body: {}, method: 'PUT' }),
    clearFileEditing: (_projectId, fileId) => request(g(`/files/${seg(fileId)}/editing`), { method: 'DELETE' }),
    // Only channel libraries: a guest has no other files.
    getFiles: (_projectId, target) => request(g(`/channels/${seg(target?.targetId)}/files`)),
    getFileStorage: () => request(g('/file-storage')),
    getFileVersions: (_projectId, fileId) => request(g(`/files/${seg(fileId)}/versions`)),
    getFileDownloadUrl(_projectId, fileId, { inline = false, version = null } = {}) {
      const search = new URLSearchParams();
      if (inline) search.set('disposition', 'inline');
      if (version) search.set('version', String(version));
      const query = search.toString();
      return request(g(`/files/${seg(fileId)}/download-url${query ? `?${query}` : ''}`));
    },
    getFilePreviewUrl: (_projectId, fileId, { version = null } = {}) => request(g(`/files/${seg(fileId)}/preview-url${version ? `?version=${seg(version)}` : ''}`)),
    startFileUpload: (_projectId, payload) => request(g('/uploads'), { body: payload, method: 'POST' }),
    getFileUpload: (_projectId, uploadId) => request(g(`/uploads/${seg(uploadId)}`)),
    signFileUploadParts: (_projectId, uploadId, partNumbers) => request(g(`/uploads/${seg(uploadId)}/parts`), { body: { partNumbers }, method: 'POST' }),
    completeFileUpload: (_projectId, uploadId, payload) => request(g(`/uploads/${seg(uploadId)}/complete`), { body: payload ?? {}, method: 'POST' }),
    cancelFileUpload: (_projectId, uploadId) => request(g(`/uploads/${seg(uploadId)}`), { method: 'DELETE' }),
    uploadProjectFile: unsupported,
    uploadFileVersion: unsupported,
    getFileContent: unsupported,

    /**
     * The guest's live stream: channel.updated for their channels, guest.changed when what they
     * reach changes, and notification.created and notification.read for their bell. One stream
     * per tab, shared by every screen that listens. Returns a stop function. A refused stream
     * (signed out, removed) calls onError with the error, whose status says why.
     */
    subscribeToEvents(handlers = {}) {
      return sharedEvents.subscribe('guest', handlers);
    },

    // The guest's bell (components/notifications/NotificationBell.vue), by the app client's
    // names: /api/guest/me mounts the members' notification routes for the guest's principal.
    listNotifications: () => request(g('/me/notifications')),
    markNotificationsRead: (payload) => request(g('/me/notifications/read'), { body: payload, method: 'POST' }),
    // `leaving`: the page is unloading, so the request must outlive it.
    sendNotificationFocus: (focused, _token, { leaving = false } = {}) => request(g('/me/focus'), { body: { clientId, focused }, ...(leaving ? { keepalive: true } : {}), method: 'POST' }),
    getPushConfig: () => request(g('/me/push')),
    savePushSubscription: (subscription) => request(g('/me/push-subscriptions'), { body: subscription, method: 'POST' }),
    removePushSubscription: (endpoint) => request(g('/me/push-subscriptions'), { body: { endpoint }, method: 'DELETE' }),
    subscribeToMyEvents: (_token, handlers = {}) => sharedEvents.subscribe('guest', handlers),
  };

  function openStream(_key, { onClose, onError, onEvent } = {}) {
    const controller = new AbortController();
    let ended = false;
    const end = (handler, value) => {
      if (ended) return;
      ended = true;
      handler?.(value);
    };
    (async () => {
      try {
        const response = await fetchImpl(url(g('/events')), { credentials: 'include', headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          end(onError, new ApiError(data.error ?? 'The live stream was refused.', { data, status: response.status }));
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = parseSseChunk(buffer + decoder.decode(value, { stream: true }), (event) => onEvent?.(event));
        }
        end(onClose);
      } catch (error) {
        if (error?.name === 'AbortError') {
          ended = true;
          return;
        }
        end(onError, error);
      }
    })();
    return () => {
      ended = true;
      controller.abort();
    };
  }
  // The screens ask for quiet calls with `.passive`; for guests every call is the same.
  api.passive = api;
  return api;
}
