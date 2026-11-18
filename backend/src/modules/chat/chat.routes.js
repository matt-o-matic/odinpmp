import { Router } from 'express';
import { z } from 'zod';

import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { publishWorkspaceChanged } from '../../lib/events/project-live-events.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { actorOf, originClientIdOf } from '../channels/channel-events.js';
import { MAX_POSTS_PAGE, POSTS_PAGE_SIZE } from '../channels/channels.service.js';
import { pollInputSchema, pollVoteSchema } from '../channels/polls.schema.js';
import { largeFileDeps } from '../vault/vault.routes.js';
import { fileDownloadUrlQuerySchema, filePreviewUrlQuerySchema, fileUploadPartsSchema, fileUploadStartSchema } from '../vault/vault.schema.js';
import { MAX_DIRECT_MEMBERS } from './chat.repository.js';
import { getChatSidebarForUser, getChatUnreadForUser, listMentionsForUser, listThreadsForUser } from './chat.service.js';
import {
  cancelDirectUpload,
  closeDirectPoll,
  completeDirectUpload,
  createDirectPost,
  deleteDirectPost,
  directFileStorage,
  getDirectConversationForUser,
  getDirectDownloadUrl,
  getDirectPoll,
  getDirectPreviewUrl,
  getDirectUpload,
  listDirectConversations,
  listDirectFiles,
  listDirectMentionables,
  listDirectMessagePeople,
  listDirectPosts,
  markDirectConversationRead,
  requireConversation,
  setDirectPostReaction,
  signDirectUploadParts,
  startDirectConversation,
  startDirectUpload,
  tenantIdOf,
  updateDirectPost,
  voteDirectPoll,
} from './direct-messages.service.js';

// Odin Chat's routes, mounted at /api/chat (docs/odin-chat/plan.md, Odin Chat): the sidebar and
// the Chat badge's totals, Mentions, Threads, and direct messages with their posts, files and live
// stream. Members only: a guest's session is refused by the auth middleware, and MCP credentials
// are not allowed here.
//
// Each direct message write publishes `direct-message.updated` on the conversation's own stream
// (its members only, checked when the stream opens) and `workspace.changed` with area chat, so
// open sidebars refetch their counts. Neither carries message text.

export const DIRECT_MESSAGE_UPDATED_EVENT = 'direct-message.updated';

const id = z.string().trim().min(1).max(64);
const mentionsQuerySchema = z.object({ before: z.string().trim().max(400).optional() });
const postsQuerySchema = z.object({
  before: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_POSTS_PAGE).optional().default(POSTS_PAGE_SIZE),
});
const conversationCreateSchema = z.object({ memberIds: z.array(id).min(1).max(MAX_DIRECT_MEMBERS - 1) }).strict();
const postCreateSchema = z.object({
  body: z.string().max(20_000).optional().default(''),
  fileIds: z.array(id).max(10).optional().default([]),
  parentId: id.nullable().optional(),
  // A poll on a new top-level message (channels/polls.service.js).
  poll: pollInputSchema.optional(),
  replyToId: id.nullable().optional(),
}).strict();
const postUpdateSchema = z.object({ body: z.string().max(20_000) }).strict();
const reactionSchema = z.object({ emoji: z.string().min(1).max(64), reacted: z.boolean() }).strict();

function openEventStream(response) {
  response.status(200);
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.flushHeaders?.();
}

function writeSseEvent(response, type, data = {}) {
  if (response.writableEnded) return;
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createChatRouter(deps) {
  const { authRepository, heartbeatMs = 25_000, liveEventBus = null, tokenService } = deps;
  const large = largeFileDeps(deps);
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));

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
  const user = (request) => request.auth.user;
  const conversationIdOf = (request) => request.params.conversationId;
  const published = (area) => (_result, request) => {
    const conversationId = conversationIdOf(request);
    const originClientId = originClientIdOf(request);
    liveEventBus?.publish(LIVE_EVENT_CHANNELS.directConversation(conversationId), { actor: actorOf(request), area, conversationId, originClientId, type: DIRECT_MESSAGE_UPDATED_EVENT });
    publishWorkspaceChanged(liveEventBus, tenantIdOf(user(request)), { area: 'chat', originClientId });
  };

  router.get('/sidebar', send(200, (request) => getChatSidebarForUser(deps, user(request))));
  router.get('/unread', send(200, (request) => getChatUnreadForUser(deps, user(request))));
  router.get('/mentions', send(200, (request) => listMentionsForUser(deps, user(request), mentionsQuerySchema.parse(request.query))));
  router.get('/threads', send(200, (request) => listThreadsForUser(deps, user(request))));
  router.get('/people', send(200, (request) => listDirectMessagePeople(deps, user(request))));

  router.get('/conversations', send(200, async (request) => ({ conversations: await listDirectConversations(deps, user(request)), ok: true })));
  router.post('/conversations', send(201, (request) => startDirectMessage(request)));
  async function startDirectMessage(request) {
    const result = await startDirectConversation(deps, user(request), conversationCreateSchema.parse(request.body ?? {}));
    if (result.created) publishWorkspaceChanged(liveEventBus, tenantIdOf(user(request)), { area: 'chat', originClientId: originClientIdOf(request) });
    return result;
  }
  router.get('/conversations/:conversationId', send(200, (request) => getDirectConversationForUser(deps, user(request), conversationIdOf(request))));
  router.post('/conversations/:conversationId/read', send(200, (request) => markDirectConversationRead(deps, user(request), conversationIdOf(request))));
  router.get('/conversations/:conversationId/mentionables', send(200, (request) => listDirectMentionables(deps, user(request), conversationIdOf(request))));
  router.get('/conversations/:conversationId/posts', send(200, (request) => listDirectPosts(deps, user(request), conversationIdOf(request), postsQuerySchema.parse(request.query))));
  router.post('/conversations/:conversationId/posts', send(201, (request) => createDirectPost(deps, user(request), conversationIdOf(request), postCreateSchema.parse(request.body ?? {})), published('posts')));
  router.patch('/conversations/:conversationId/posts/:postId', send(200, (request) => updateDirectPost(deps, user(request), conversationIdOf(request), request.params.postId, postUpdateSchema.parse(request.body ?? {})), published('posts')));
  router.delete('/conversations/:conversationId/posts/:postId', send(200, (request) => deleteDirectPost(deps, user(request), conversationIdOf(request), request.params.postId), published('posts')));
  router.get('/conversations/:conversationId/posts/:postId/poll', send(200, (request) => getDirectPoll(deps, user(request), conversationIdOf(request), request.params.postId)));
  router.put('/conversations/:conversationId/posts/:postId/poll/vote', send(200, (request) => voteDirectPoll(deps, user(request), conversationIdOf(request), request.params.postId, pollVoteSchema.parse(request.body ?? {})), published('posts')));
  router.post('/conversations/:conversationId/posts/:postId/poll/close', send(200, (request) => closeDirectPoll(deps, user(request), conversationIdOf(request), request.params.postId), published('posts')));
  router.put('/conversations/:conversationId/posts/:postId/reactions', send(200, (request) => setDirectPostReaction(deps, user(request), conversationIdOf(request), request.params.postId, reactionSchema.parse(request.body ?? {})), published('posts')));

  // Files, in parts, into the workspace's file storage under the conversation.
  router.get('/conversations/:conversationId/file-storage', send(200, async (request) => {
    await requireConversation(deps, user(request), conversationIdOf(request));
    return directFileStorage(large);
  }));
  router.get('/conversations/:conversationId/files', send(200, (request) => listDirectFiles(deps, user(request), conversationIdOf(request))));
  router.get('/conversations/:conversationId/files/:fileId/download-url', send(200, (request) => {
    const query = fileDownloadUrlQuerySchema.parse(request.query);
    return getDirectDownloadUrl(deps, large, user(request), conversationIdOf(request), request.params.fileId, { inline: query.disposition === 'inline', version: query.version ?? null });
  }));
  router.get('/conversations/:conversationId/files/:fileId/preview-url', send(200, (request) => {
    const query = filePreviewUrlQuerySchema.parse(request.query);
    return getDirectPreviewUrl(deps, large, user(request), conversationIdOf(request), request.params.fileId, { version: query.version ?? null });
  }));
  router.post('/conversations/:conversationId/uploads', send(201, (request) => startDirectUpload(deps, large, user(request), conversationIdOf(request), fileUploadStartSchema.parse(request.body ?? {}))));
  router.get('/conversations/:conversationId/uploads/:uploadId', send(200, (request) => getDirectUpload(deps, large, user(request), conversationIdOf(request), request.params.uploadId)));
  router.post('/conversations/:conversationId/uploads/:uploadId/parts', send(200, (request) => signDirectUploadParts(deps, large, user(request), conversationIdOf(request), request.params.uploadId, fileUploadPartsSchema.parse(request.body ?? {}))));
  router.post('/conversations/:conversationId/uploads/:uploadId/complete', send(201, (request) => completeDirectUpload(deps, large, user(request), conversationIdOf(request), request.params.uploadId), published('files')));
  router.delete('/conversations/:conversationId/uploads/:uploadId', send(200, (request) => cancelDirectUpload(deps, large, user(request), conversationIdOf(request), request.params.uploadId)));

  // The conversation's live stream. Members are fixed, so the check when it opens holds.
  router.get('/conversations/:conversationId/events', async (request, response, next) => {
    let conversationId;
    try {
      conversationId = (await requireConversation(deps, user(request), conversationIdOf(request))).conversation.id;
    } catch (error) {
      next(error);
      return;
    }
    openEventStream(response);
    writeSseEvent(response, 'connected', {});
    const unsubscribe = liveEventBus
      ? liveEventBus.subscribe(LIVE_EVENT_CHANNELS.directConversation(conversationId), (event) => {
        writeSseEvent(response, DIRECT_MESSAGE_UPDATED_EVENT, { actor: event.actor ?? null, area: event.area, conversationId, originClientId: event.originClientId ?? null });
      })
      : () => {};
    const heartbeat = setInterval(() => writeSseEvent(response, 'heartbeat', {}), heartbeatMs);
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
