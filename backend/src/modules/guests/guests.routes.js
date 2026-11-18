import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getAuthCookie, setCookie } from '../../lib/auth/auth-cookies.js';
import { guestCsrfFor, isGuestToken } from '../../lib/auth/guest-token.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { supportsLargeFiles } from '../../lib/files/file-storage.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { getRequestIp, getRequestUserAgent } from '../../lib/http/request-meta.js';
import { CHANNEL_TYPING_EVENT, CHANNEL_UPDATED_EVENT, isOwnTyping, originClientIdOf, publishChannelTyping, publishChannelWrite } from '../channels/channel-events.js';
import {
  MAX_POSTS_PAGE,
  POSTS_PAGE_SIZE,
  clearFileEditing,
  closePollIn,
  createFileComment,
  createPost,
  deletePost,
  getFileTree,
  getPoll,
  listChannelMentionables,
  listFileComments,
  listFileMentionables,
  listFolders,
  listPosts,
  markChannelRead,
  setFileEditing,
  setPostReaction,
  signalTyping,
  updatePost,
  votePollIn,
} from '../channels/channels.service.js';
import { pollInputSchema, pollVoteSchema } from '../channels/polls.schema.js';
import { subscribePrincipalNotifications } from '../notifications/notification-events.js';
import { createPrincipalNotificationsRouter } from '../notifications/notifications.routes.js';
import { DEFAULT_FILE_UPLOAD_MAX_BYTES } from '../vault/large-files.service.js';
import { guestPrincipal } from './guest-notifications.js';
import { largeFileDeps } from '../vault/vault.routes.js';
import { fileDownloadUrlQuerySchema, filePreviewUrlQuerySchema, fileUploadCompleteSchema, fileUploadPartsSchema, fileUploadStartSchema } from '../vault/vault.schema.js';
import { createGuestRateLimiter } from './guest-rate-limit.js';
import {
  GUEST_EVENTS,
  GUEST_SESSION_TTL_MS,
  cancelGuestUpload,
  completeGuestUpload,
  createPhantomCodes,
  describeGuest,
  getGuestChannel,
  getGuestDownloadUrl,
  getGuestPreviewUrl,
  getGuestUpload,
  guestMemberships,
  guestProjectContext,
  inviteChannelGuestForUser,
  listChannelGuestsForUser,
  listGuestChannelFiles,
  listGuestEngagements,
  listGuestFileVersions,
  listGuestTaskComments,
  listGuestTaskFiles,
  listGuestTasks,
  addGuestTaskComment,
  publishGuestWrite,
  removeChannelGuestForUser,
  requestSignInCode,
  requireGuestChannel,
  requireGuestFile,
  resolveGuestSession,
  signGuestUploadParts,
  signInWithCode,
  signOutGuest,
  startGuestUpload,
  updateGuestTask,
} from './guests.service.js';

// Guest routes, mounted at /api/guest, and the member routes that invite and remove
// guests, mounted at /api/projects/:projectId.
//
// A guest's session travels as a member's does: an HttpOnly cookie (path /api/guest only), or a
// bearer token. Writes made with the cookie carry X-CSRF-Token, the value of the readable
// odin_guest_csrf cookie. Every route but sign-in works out the guest's channels again
// (guests.service.js guestMemberships) and answers 404 for anything outside them.

export const GUEST_COOKIE = 'odin_guest';
export const GUEST_CSRF_COOKIE = 'odin_guest_csrf';
const GUEST_COOKIE_PATH = '/api/guest';
const HEARTBEAT_MS = 25_000;
const UNSAFE = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

/** What the guest services read from the app's dependencies. */
export function guestServiceDeps(deps) {
  return {
    accessRepository: deps.accessRepository,
    assistantRepository: deps.assistantRepository,
    auditWriter: deps.auditWriter ?? null,
    authRepository: deps.authRepository ?? null,
    frontendAppUrl: deps.frontendAppUrl ?? '',
    guestClock: deps.guestClock ?? null,
    guestSessionsRepository: deps.guestSessionsRepository,
    guestTaskSource: deps.guestTaskSource ?? null,
    liveEventBus: deps.liveEventBus ?? null,
    mailRepository: deps.mailRepository ?? null,
    // Mentions and replies by a guest notify, as members' do (modules/notifications).
    notifications: deps.notifications ?? null,
    // A guest's post that tags @odin gets an answer, read-only (odin-channel.service.js).
    odinChannelService: deps.odinChannelService ?? null,
    phantomCodes: deps.guestPhantomCodes ?? createPhantomCodes(),
    projectRepository: deps.projectRepository,
    workspaceModulesRepository: deps.workspaceModulesRepository ?? null,
  };
}

function issueGuestCookies(response, token, expiresAt, now = new Date()) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - now.valueOf()) / 1000)) || Math.floor(GUEST_SESSION_TTL_MS / 1000);
  setCookie(response, GUEST_COOKIE, token, { maxAge, path: GUEST_COOKIE_PATH });
  setCookie(response, GUEST_CSRF_COOKIE, guestCsrfFor(token), { httpOnly: false, maxAge, path: '/', sameSite: 'Strict' });
}

function clearGuestCookies(response) {
  setCookie(response, GUEST_COOKIE, '', { maxAge: 0, path: GUEST_COOKIE_PATH });
  setCookie(response, GUEST_CSRF_COOKIE, '', { httpOnly: false, maxAge: 0, path: '/', sameSite: 'Strict' });
}

function bearerOf(request) {
  const header = String(request.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function sameText(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accepts a guest session and nothing else: a member's token is no guest's. Sets request.guest
 * to { accessLinkId, email, tenantId, sessionId, session, memberships }. A session with no
 * channel left ends here.
 */
export function createGuestAuthMiddleware(deps) {
  return async function guestAuth(request, response, next) {
    try {
      const bearer = bearerOf(request);
      const cookie = getAuthCookie(request, GUEST_COOKIE);
      const token = bearer || cookie;
      if (!token || !isGuestToken(token)) throw new HttpError(401, 'Sign in to continue.', { details: { code: 'guest_sign_in_required' } });
      const guest = await resolveGuestSession(deps, token);
      if (!guest) {
        if (!bearer) clearGuestCookies(response);
        throw new HttpError(401, 'Your session has ended. Sign in again.', { details: { code: 'guest_session_ended' } });
      }
      if (!bearer && UNSAFE.has(request.method) && !sameText(request.headers['x-csrf-token'], guestCsrfFor(token))) {
        throw new HttpError(403, 'CSRF validation failed.');
      }
      // Removing a guest from their last channel revokes their sessions (guests.service.js); a
      // session that reaches no channel for another reason, such as the Consulting module being
      // off, is refused but kept, so it works again when the channel comes back.
      const memberships = await guestMemberships(deps, guest);
      if (!memberships.length) throw new HttpError(401, 'You are not a guest in any channel here now.', { details: { code: 'guest_access_ended' } });
      request.guest = { ...guest, memberships, token };
      // The cookie lives as long as the session does, so it moves on with each use too.
      if (!bearer) issueGuestCookies(response, token, guest.session.expiresAt, deps.guestClock ? deps.guestClock() : new Date());
      next();
    } catch (error) {
      next(error);
    }
  };
}

const id = z.string().trim().min(1).max(64);
const body = z.string().max(20_000);
const emailBody = z.object({ email: z.string().trim().min(3).max(255), workspace: z.string().trim().max(64).optional().default('') }).strict();
const signInBody = emailBody.extend({ code: z.string().trim().min(1).max(12) }).strict();
const typingSchema = z.object({ parentId: z.string().trim().min(1).max(64).nullable().optional(), typing: z.boolean() }).strict();
const postsQuerySchema = z.object({
  before: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_POSTS_PAGE).optional().default(POSTS_PAGE_SIZE),
});
const postCreateSchema = z.object({ body: body.optional().default(''), fileIds: z.array(id).max(10).optional().default([]), parentId: id.nullable().optional(), poll: pollInputSchema.optional(), replyToId: id.nullable().optional() }).strict();
const postUpdateSchema = z.object({ body }).strict();
const commentCreateSchema = z.object({ body, parentId: id.nullable().optional(), replyToId: id.nullable().optional() }).strict();
const reactionSchema = z.object({ emoji: z.string().min(1).max(64), reacted: z.boolean() }).strict();
const taskUpdateSchema = z.object({ status: z.string().trim().min(1).max(64) }).strict();
const taskCommentSchema = z.object({ text: z.string().trim().min(1).max(10_000) }).strict();
const inviteSchema = z.object({ email: z.string().trim().min(3).max(255), name: z.string().trim().max(120).optional().default(''), organization: z.string().trim().max(120).optional().default('') }).strict();

function rateLimited(response, verdict) {
  response.setHeader('Retry-After', String(verdict.retryAfterSeconds));
  response.status(429).json({ details: { code: 'rate_limited', retryAfterSeconds: verdict.retryAfterSeconds, scope: verdict.scope }, error: 'Too many tries. Wait a little, then try again.', ok: false });
}

function openEventStream(response) {
  response.status(200);
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.flushHeaders?.();
}

function writeSseEvent(response, type, data = {}) {
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createGuestRouter(appDeps) {
  const deps = guestServiceDeps(appDeps);
  const large = largeFileDeps(appDeps);
  const limiter = appDeps.guestRateLimiter ?? createGuestRateLimiter();
  const router = Router();
  const guestAuth = createGuestAuthMiddleware(deps);
  const ip = (request) => getRequestIp(request);

  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Sends a result without the context some carry for `publish`, which is the server's alone.
  const send = (status, run, publish = null) => async (request, response, next) => {
    try {
      const result = await run(request, response);
      const { ctx: _ctx, ...sent } = result ?? {};
      response.status(status).json(sent);
      if (publish) publish(result, request);
    } catch (error) {
      next(error);
    }
  };
  const origin = (request) => originClientIdOf(request);

  // --- sign-in ---
  router.post('/sign-in/code', async (request, response, next) => {
    try {
      const input = emailBody.parse(request.body ?? {});
      const verdict = limiter.checkCodeRequest({ email: input.email.toLowerCase(), ipAddress: ip(request) });
      if (verdict) return rateLimited(response, verdict);
      response.status(200).json(await requestSignInCode(deps, { email: input.email, ipAddress: ip(request), workspace: input.workspace }));
    } catch (error) {
      next(error);
    }
  });
  router.post('/sign-in', async (request, response, next) => {
    try {
      const input = signInBody.parse(request.body ?? {});
      const verdict = limiter.checkSignIn({ ipAddress: ip(request) });
      if (verdict) return rateLimited(response, verdict);
      const result = await signInWithCode(deps, { code: input.code, email: input.email, ipAddress: ip(request), userAgent: getRequestUserAgent(request), workspace: input.workspace });
      issueGuestCookies(response, result.token, result.expiresAt, deps.guestClock ? deps.guestClock() : new Date());
      // The token goes back for clients that use a bearer token; the browser keeps the cookie.
      response.status(200).json({ expiresAt: result.expiresAt, guest: result.guest, ok: true, token: result.token });
    } catch (error) {
      next(error);
    }
  });
  router.post('/sign-out', async (request, response, next) => {
    try {
      const token = bearerOf(request) || getAuthCookie(request, GUEST_COOKIE);
      const guest = isGuestToken(token) ? await resolveGuestSession(deps, token, { touch: false }) : null;
      if (guest && (bearerOf(request) || sameText(request.headers['x-csrf-token'], guestCsrfFor(token)))) await signOutGuest(deps, guest);
      clearGuestCookies(response);
      response.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.use(guestAuth);
  const guest = (request) => request.guest;

  // The guest's bell: the same notification routes members have at /api/me, for the guest's
  // principal (their workspace access link, guest-notifications.js). Their stream is /events below.
  if (appDeps.notifications) {
    router.use('/me', createPrincipalNotificationsRouter({
      authenticate: (_request, _response, next) => next(),
      liveEventBus: appDeps.liveEventBus,
      notifications: appDeps.notifications,
      notificationsRepository: appDeps.notificationsRepository,
      principalOf: (request) => guestPrincipal(request.guest),
      pushSender: appDeps.pushSender ?? null,
    }));
  }

  router.get('/session', send(200, (request) => describeGuest(deps, guest(request))));
  router.get('/engagements', send(200, (request) => listGuestEngagements(deps, guest(request))));

  // --- channels and posts ---
  const inChannel = (request, options = {}) => requireGuestChannel(deps, guest(request), request.params.channelId, { memberships: guest(request).memberships, ...options });
  router.get('/channels/:channelId', send(200, (request) => getGuestChannel(deps, guest(request), request.params.channelId)));
  router.get('/channels/:channelId/posts', send(200, async (request) => listPosts(deps, (await inChannel(request)).ctx, request.params.channelId, postsQuerySchema.parse(request.query))));
  router.post('/channels/:channelId/posts', send(201, async (request) => {
    const { ctx } = await inChannel(request);
    return { ...await createPost(deps, ctx, request.params.channelId, postCreateSchema.parse(request.body ?? {})), ctx };
  }, (result, request) => publishGuestWrite(deps, result.ctx, { area: 'posts', channelId: request.params.channelId, originClientId: origin(request), workspace: true })));
  // "Is typing" in the guest's channel or one of its threads: the members' checks, nothing stored.
  router.post('/channels/:channelId/typing', async (request, response, next) => {
    try {
      const input = typingSchema.parse(request.body ?? {});
      const { ctx } = await inChannel(request);
      const { signal } = await signalTyping(deps, ctx, request.params.channelId, input);
      response.status(200).json({ ok: true });
      publishChannelTyping(deps.liveEventBus, { ...signal, originClientId: origin(request) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/channels/:channelId/read', send(200, async (request) => markChannelRead(deps, (await inChannel(request)).ctx, request.params.channelId)));
  router.get('/channels/:channelId/mentionables', send(200, async (request) => listChannelMentionables(deps, (await inChannel(request)).ctx, request.params.channelId)));
  router.get('/channels/:channelId/folders', send(200, async (request) => listFolders(deps, (await inChannel(request)).ctx, request.params.channelId)));
  router.get('/channels/:channelId/files', send(200, (request) => listGuestChannelFiles(deps, guest(request), request.params.channelId)));

  // A post or a file comment: found through the channel, or the file, it is in.
  async function postPlace(request) {
    const post = await deps.projectRepository.getPost({ postId: request.params.postId, tenantId: guest(request).tenantId });
    if (!post) throw new HttpError(404, 'Message not found.');
    const options = { memberships: guest(request).memberships };
    if (post.targetType === 'channel') return { ...await requireGuestChannel(deps, guest(request), post.targetId, options), post };
    if (post.targetType === 'file') return { ...await requireGuestFile(deps, guest(request), post.targetId, options), post };
    throw new HttpError(404, 'Message not found.');
  }
  const postWrite = (result, request) => {
    const isComment = result.post?.targetType === 'file';
    if (result.channelId) publishGuestWrite(deps, result.ctx, { area: isComment ? 'files' : 'posts', channelId: result.channelId, fileId: isComment ? result.post.targetId : null, originClientId: origin(request), workspace: !isComment });
  };
  router.patch('/posts/:postId', send(200, async (request) => {
    const { ctx } = await postPlace(request);
    return { ...await updatePost(deps, ctx, request.params.postId, postUpdateSchema.parse(request.body ?? {})), ctx };
  }, postWrite));
  router.delete('/posts/:postId', send(200, async (request) => {
    const { ctx } = await postPlace(request);
    return { ...await deletePost(deps, ctx, request.params.postId), ctx };
  }, postWrite));
  router.put('/posts/:postId/reactions', send(200, async (request) => {
    const { ctx } = await postPlace(request);
    return { ...await setPostReaction(deps, ctx, request.params.postId, reactionSchema.parse(request.body ?? {})), ctx };
  }, (result, request) => {
    if (result.channelId) publishGuestWrite(deps, result.ctx, { area: result.fileId ? 'files' : 'posts', channelId: result.channelId, fileId: result.fileId, originClientId: origin(request), workspace: false });
  }));

  // Polls (polls.service.js): guests vote in their channels' polls and close their own.
  const pollWrite = (result, request) => publishGuestWrite(deps, result.ctx, { area: 'posts', channelId: result.channelId, originClientId: origin(request), workspace: false });
  router.get('/posts/:postId/poll', send(200, async (request) => {
    const { ctx } = await postPlace(request);
    return getPoll(deps, ctx, request.params.postId);
  }));
  router.put('/posts/:postId/poll/vote', send(200, async (request) => {
    const { ctx } = await postPlace(request);
    return { ...await votePollIn(deps, ctx, request.params.postId, pollVoteSchema.parse(request.body ?? {})), ctx };
  }, pollWrite));
  router.post('/posts/:postId/poll/close', send(200, async (request) => {
    const { ctx } = await postPlace(request);
    return { ...await closePollIn(deps, ctx, request.params.postId), ctx };
  }, pollWrite));

  // --- files ---
  const onFile = (request, options = {}) => requireGuestFile(deps, guest(request), request.params.fileId, { memberships: guest(request).memberships, ...options });
  router.get('/file-storage', send(200, () => ({
    canDeleteVersions: false,
    maxUploadBytes: Number(large.fileUploadMaxBytes ?? DEFAULT_FILE_UPLOAD_MAX_BYTES),
    ok: true,
    storage: null,
    uploadsByParts: supportsLargeFiles(large.fileStorage),
  })));
  router.get('/files/:fileId/versions', send(200, (request) => listGuestFileVersions(deps, guest(request), request.params.fileId)));
  router.get('/files/:fileId/download-url', send(200, (request) => {
    const query = fileDownloadUrlQuerySchema.parse(request.query);
    return getGuestDownloadUrl(deps, large, guest(request), request.params.fileId, { inline: query.disposition === 'inline', version: query.version ?? null }, { ipAddress: ip(request) });
  }));
  router.get('/files/:fileId/preview-url', send(200, (request) => {
    const query = filePreviewUrlQuerySchema.parse(request.query);
    return getGuestPreviewUrl(deps, large, guest(request), request.params.fileId, { version: query.version ?? null }, { ipAddress: ip(request) });
  }));
  router.get('/files/:fileId/comments', send(200, async (request) => listFileComments(deps, (await onFile(request)).ctx, request.params.fileId)));
  router.post('/files/:fileId/comments', send(201, async (request) => {
    const { ctx } = await onFile(request);
    return { ...await createFileComment(deps, ctx, request.params.fileId, commentCreateSchema.parse(request.body ?? {})), ctx };
  }, (result, request) => {
    if (result.channelId) publishGuestWrite(deps, result.ctx, { area: 'files', channelId: result.channelId, fileId: request.params.fileId, originClientId: origin(request) });
  }));
  router.get('/files/:fileId/mentionables', send(200, async (request) => listFileMentionables(deps, (await onFile(request)).ctx, request.params.fileId)));
  const editingWrite = (result, request) => publishGuestWrite(deps, result.ctx, { area: 'files', channelId: result.channelId, fileId: request.params.fileId, originClientId: origin(request) });
  router.put('/files/:fileId/editing', send(200, async (request) => {
    const { ctx } = await onFile(request, { needsFiles: true });
    return { ...await setFileEditing(deps, ctx, request.params.fileId), ctx };
  }, editingWrite));
  router.delete('/files/:fileId/editing', send(200, async (request) => {
    const { ctx } = await onFile(request, { needsFiles: true });
    return { ...await clearFileEditing(deps, ctx, request.params.fileId), ctx };
  }, editingWrite));

  // --- uploads, in parts, as members' ---
  router.post('/uploads', send(201, (request) => startGuestUpload(deps, large, guest(request), fileUploadStartSchema.parse(request.body ?? {}))));
  router.get('/uploads/:uploadId', send(200, (request) => getGuestUpload(deps, large, guest(request), request.params.uploadId)));
  router.post('/uploads/:uploadId/parts', send(200, (request) => signGuestUploadParts(deps, large, guest(request), request.params.uploadId, fileUploadPartsSchema.parse(request.body ?? {}))));
  router.post('/uploads/:uploadId/complete', send(201, async (request) => completeGuestUpload(deps, large, guest(request), request.params.uploadId, fileUploadCompleteSchema.parse(request.body ?? {}), { ipAddress: ip(request) }), (result, request) => {
    // A pursuit task attachment was published to the members' board by the service.
    if (result.channelId) publishGuestWrite(deps, result.ctx, { area: 'files', channelId: result.channelId, fileId: result.file?.id ?? null, originClientId: origin(request) });
  }));
  router.delete('/uploads/:uploadId', send(200, (request) => cancelGuestUpload(deps, large, guest(request), request.params.uploadId)));

  // --- tasks (guest-tasks.js) ---
  // The project's file tree as a guest sees it: their channels and folders, no project files.
  router.get('/projects/:projectId/file-tree', send(200, async (request) => getFileTree(deps, await guestProjectContext(deps, guest(request), request.params.projectId))));
  router.get('/projects/:projectId/tasks', send(200, (request) => listGuestTasks(deps, guest(request), request.params.projectId)));
  router.patch('/projects/:projectId/tasks/:taskId', send(200, (request) => updateGuestTask(deps, guest(request), request.params.projectId, request.params.taskId, taskUpdateSchema.parse(request.body ?? {}))));
  router.get('/projects/:projectId/tasks/:taskId/comments', send(200, (request) => listGuestTaskComments(deps, guest(request), request.params.projectId, request.params.taskId)));
  router.post('/projects/:projectId/tasks/:taskId/comments', send(201, (request) => addGuestTaskComment(deps, guest(request), request.params.projectId, request.params.taskId, taskCommentSchema.parse(request.body ?? {}))));
  router.get('/projects/:projectId/tasks/:taskId/files', send(200, (request) => listGuestTaskFiles(deps, guest(request), request.params.projectId, request.params.taskId)));

  // --- the guest's live stream ---
  router.get('/events', (request, response) => {
    const current = guest(request);
    let closed = false;
    let queue = Promise.resolve();
    const projectSubscriptions = new Map();
    let stopGuestChannel = () => {};
    let heartbeat = null;

    let stopNotifications = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      stopGuestChannel();
      stopNotifications();
      for (const stop of projectSubscriptions.values()) stop();
      projectSubscriptions.clear();
      response.end();
    };
    // Still signed in, and still a guest somewhere here? Checked again before anything goes out.
    const stillValid = async () => {
      const session = await resolveGuestSession(deps, current.token, { touch: false });
      if (!session) return null;
      const memberships = await guestMemberships(deps, session);
      return memberships.length ? { ...session, memberships } : null;
    };
    const syncProjects = (memberships) => {
      const wanted = new Set(memberships.map((membership) => membership.projectId));
      for (const [projectId, stop] of projectSubscriptions) {
        if (!wanted.has(projectId)) {
          stop();
          projectSubscriptions.delete(projectId);
        }
      }
      for (const projectId of wanted) {
        if (!projectSubscriptions.has(projectId)) projectSubscriptions.set(projectId, deps.liveEventBus?.subscribe(LIVE_EVENT_CHANNELS.project(projectId), onProjectEvent) ?? (() => {}));
      }
    };
    const run = (task) => {
      queue = queue.then(async () => {
        if (!closed) await task();
      }).catch(() => close());
    };
    function onProjectEvent(event) {
      const typing = event?.type === CHANNEL_TYPING_EVENT;
      if ((!typing && event?.type !== CHANNEL_UPDATED_EVENT) || !event.channelId) return;
      run(async () => {
        const valid = await stillValid();
        if (!valid) return close();
        if (!valid.memberships.some((membership) => membership.channelId === event.channelId)) return;
        // The guest writes as a stakeholder record per project; never show them their own typing.
        if (typing && valid.memberships.some((membership) => isOwnTyping(event, { id: membership.stakeholder?.id, type: 'stakeholder' }))) return;
        // Typing names the person, as the posts in the channel do; channel.updated names nobody.
        if (typing) writeSseEvent(response, CHANNEL_TYPING_EVENT, { actor: event.actor, channelId: event.channelId, originClientId: event.originClientId ?? null, parentId: event.parentId ?? null, projectId: event.projectId, type: CHANNEL_TYPING_EVENT, typing: event.typing });
        else writeSseEvent(response, CHANNEL_UPDATED_EVENT, { area: event.area, channelId: event.channelId, ...(event.fileId ? { fileId: event.fileId } : {}), originClientId: event.originClientId ?? null, projectId: event.projectId, type: CHANNEL_UPDATED_EVENT });
      });
    }

    openEventStream(response);
    writeSseEvent(response, 'connected', { ok: true });
    syncProjects(current.memberships);
    // notification.created and notification.read for the guest, beside channel.updated; ids only.
    const principal = guestPrincipal(current);
    if (principal) stopNotifications = subscribePrincipalNotifications(deps.liveEventBus, principal, (type, data) => { if (!closed) writeSseEvent(response, type, data); });
    stopGuestChannel = deps.liveEventBus?.subscribe(LIVE_EVENT_CHANNELS.guest(current.accessLinkId), (event) => {
      run(async () => {
        const valid = event?.type === GUEST_EVENTS.ended ? null : await stillValid();
        if (!valid) return close();
        syncProjects(valid.memberships);
        writeSseEvent(response, GUEST_EVENTS.changed, { type: GUEST_EVENTS.changed });
      });
    }) ?? (() => {});
    heartbeat = setInterval(() => run(async () => {
      if (!await stillValid()) return close();
      writeSseEvent(response, 'heartbeat', {});
    }), appDeps.guestHeartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref?.();
    request.on('close', close);
  });

  return router;
}

/** The member routes for a channel's guests, under /api/projects/:projectId. */
export function createChannelGuestsRouter(appDeps) {
  const deps = guestServiceDeps(appDeps);
  const router = Router({ mergeParams: true });
  router.use('/channels/:channelId/guests', createAuthMiddleware({ authRepository: appDeps.authRepository, tokenService: appDeps.tokenService }));
  const send = (status, run, publish = null) => async (request, response, next) => {
    try {
      const result = await run(request);
      response.setHeader('Cache-Control', 'no-store');
      response.status(status).json(result);
      if (publish) publish(result, request);
    } catch (error) {
      next(error);
    }
  };
  const members = (result, request) => publishChannelWrite(appDeps.liveEventBus, request, { area: 'members', channelId: request.params.channelId, projectId: request.params.projectId });
  router.get('/channels/:channelId/guests', send(200, (request) => listChannelGuestsForUser(deps, request.auth.user, request.params.projectId, request.params.channelId)));
  router.post('/channels/:channelId/guests', send(201, (request) => inviteChannelGuestForUser(deps, request.auth.user, request.params.projectId, request.params.channelId, inviteSchema.parse(request.body ?? {}), { ipAddress: getRequestIp(request) }), members));
  router.delete('/channels/:channelId/guests/:stakeholderId', send(200, (request) => removeChannelGuestForUser(deps, request.auth.user, request.params.projectId, request.params.channelId, request.params.stakeholderId, { ipAddress: getRequestIp(request) }), members));
  return router;
}
