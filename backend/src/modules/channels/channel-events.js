// Live updates for channels. Each write to a channel, post, file, version, folder or comment
// publishes `channel.updated` on the project stream with the channel id, the area that changed
// (posts, files or members), the actor and the origin client id. Events carry no message text;
// screens refetch, and every refetch checks permission.
import { CLIENT_ID_HEADER, publishWorkspaceChanged } from '../../lib/events/project-live-events.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { channelArchivedError } from './channel-library.js';

export const CHANNEL_UPDATED_EVENT = 'channel.updated';
export const CHANNEL_AREAS = Object.freeze(['posts', 'files', 'members']);

const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

export function originClientIdOf(request) {
  return String(request.get?.(CLIENT_ID_HEADER) ?? '').trim().slice(0, 120) || null;
}

export function actorOf(request) {
  const user = request.auth?.user;
  return user?.id ? { id: user.id, name: user.name ?? '' } : null;
}

export function publishChannelUpdated(liveEventBus, { actor = null, area, channelId, fileId = null, originClientId = null, projectId }) {
  if (!liveEventBus || !projectId || !channelId || !CHANNEL_AREAS.includes(area)) return;
  liveEventBus.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    actor,
    area,
    channelId,
    ...(fileId ? { fileId } : {}),
    originClientId,
    projectId,
    type: CHANNEL_UPDATED_EVENT,
  });
}

// "Ana is typing…": `channel.typing` on the same project stream, with the channel, the thread
// (`parentId`, null for the channel's own box), the person and whether they still type. Nothing is
// stored. Each instance holds no typing state either: browsers resend while keys are pressed, and
// drop a person a few seconds after their last signal.
export const CHANNEL_TYPING_EVENT = 'channel.typing';
// How long another backend process may still relay a typing signal (shared-live-event-bus.js).
export const TYPING_RELAY_TTL_MS = 6000;

export function publishChannelTyping(liveEventBus, { actor, channelId, originClientId = null, parentId = null, projectId, typing }) {
  if (!liveEventBus || !projectId || !channelId || !actor?.id) return;
  liveEventBus.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    actor: { id: actor.id, name: actor.name ?? '', type: actor.type },
    channelId,
    originClientId,
    parentId: parentId ?? null,
    projectId,
    type: CHANNEL_TYPING_EVENT,
    typing: Boolean(typing),
  }, { ttlMs: TYPING_RELAY_TTL_MS });
}

/** Whether a typing event is the viewer's own, from any of their tabs: never shown to them. */
export function isOwnTyping(event, principal) {
  return Boolean(principal?.id) && event?.actor?.id === principal.id && event?.actor?.type === principal.type;
}

/** Publishes for a request that changed a channel, and tells workspace screens (unread counts). */
export function publishChannelWrite(liveEventBus, request, { area, channelId, fileId = null, projectId, workspace = false }) {
  const originClientId = originClientIdOf(request);
  publishChannelUpdated(liveEventBus, { actor: actorOf(request), area, channelId, fileId, originClientId, projectId });
  if (workspace) publishWorkspaceChanged(liveEventBus, request.auth?.user?.memberships?.[0]?.tenantId ?? null, { area: 'projects', originClientId });
}

// The file routes a request changes, by path under /api/projects/:projectId.
const FILE_PATH = /^\/files\/([^/]+)(?:\/|$)/;
const COMPLETE_PATH = /^\/uploads\/([^/]+)\/complete\/?$/;
const START_PATH = /^\/uploads\/?$/;
const BASE64_PATH = /^\/files\/?$/;

/**
 * For the vault's routes, mounted on /api/projects/:projectId and /api/files/:fileId ahead of
 * them: a write to a file in a channel, or to a channel's library, is refused while the channel
 * is archived, and once it succeeds publishes `channel.updated` (area files). The file is looked
 * up before the write, so a delete still knows its channel. Rights are checked by the routes.
 */
export function createChannelFileEventsMiddleware({ liveEventBus, projectRepository, requireAuth }) {
  async function channelOfTarget({ projectId, targetId, targetType, tenantId }) {
    if (targetType !== 'channel' || !targetId) return null;
    return projectRepository.getChannel?.({ channelId: targetId, projectId, tenantId }) ?? null;
  }

  async function channelOfFile(fileId, tenantId) {
    const file = await projectRepository.getFileRecord?.({ fileId, tenantId });
    if (file?.targetType !== 'channel') return { channel: null, file };
    return { channel: await projectRepository.getChannel?.({ channelId: file.targetId, projectId: file.projectId, tenantId }), file };
  }

  // The channel a write touches, if any, and the file.
  async function resolve(request, { projectId, subPath, tenantId }) {
    if (request.params?.fileId && !projectId) return channelOfFile(request.params.fileId, tenantId);
    const fileMatch = FILE_PATH.exec(subPath);
    if (fileMatch) return channelOfFile(decodeURIComponent(fileMatch[1]), tenantId);
    const body = request.body ?? {};
    if (START_PATH.test(subPath)) {
      if (body.fileId) return channelOfFile(String(body.fileId), tenantId);
      return { channel: await channelOfTarget({ projectId, targetId: body.targetId, targetType: body.targetType, tenantId }), file: null };
    }
    if (BASE64_PATH.test(subPath)) return { channel: await channelOfTarget({ projectId, targetId: body.targetId, targetType: body.targetType, tenantId }), file: null };
    const complete = COMPLETE_PATH.exec(subPath);
    if (complete) {
      const upload = await projectRepository.getFileUpload?.({ tenantId, uploadId: decodeURIComponent(complete[1]) });
      return { channel: upload ? await channelOfTarget({ projectId, targetId: upload.targetId, targetType: upload.targetType, tenantId }) : null, file: null };
    }
    return { channel: null, file: null };
  }

  return async (request, response, next) => {
    if (!MUTATING_METHODS.has(request.method)) return next();
    const subPath = request.path ?? '';
    const onFile = Boolean(request.params?.fileId && !request.params?.projectId);
    // Only the vault's file and upload writes; the channel routes publish their own.
    if (!onFile && !(FILE_PATH.test(subPath) || START_PATH.test(subPath) || BASE64_PATH.test(subPath) || COMPLETE_PATH.test(subPath))) return next();
    if (/^\/files\/[^/]+\/(?:comments|editing|mentionables)\/?$/.test(subPath)) return next();
    try {
      // Bodies are parsed by now; the session may not be read yet.
      if (!request.auth?.user) {
        await new Promise((resolve, reject) => requireAuth(request, response, (error) => (error ? reject(error) : resolve())));
      }
      const tenantId = request.auth?.user?.memberships?.[0]?.tenantId;
      if (!tenantId) return next();
      const projectId = request.params?.projectId ?? null;
      const { channel, file } = await resolve(request, { projectId, subPath, tenantId });
      if (!channel) return next();
      if (channel.archivedAt) throw channelArchivedError();
      // Starting or signing parts of an upload changes no file; completing one does.
      if (!START_PATH.test(subPath)) {
        response.on('finish', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) return;
          publishChannelWrite(liveEventBus, request, { area: 'files', channelId: channel.id, fileId: file?.id ?? null, projectId: channel.projectId });
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
