import { Router } from 'express';
import { z } from 'zod';

import { publishProjectChanged } from '../../lib/events/project-live-events.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { actorOf, originClientIdOf, publishChannelTyping, publishChannelWrite } from './channel-events.js';
import { pollInputSchema, pollVoteSchema } from './polls.schema.js';
import {
  MAX_POSTS_PAGE,
  POSTS_PAGE_SIZE,
  archiveChannelForUser,
  closePollForUser,
  clearFileEditingForUser,
  createChannelForUser,
  createFileCommentForUser,
  createFolderForUser,
  createPostForUser,
  deleteFolderForUser,
  deletePostForUser,
  getFileTreeForUser,
  getPollForUser,
  listChannelMentionablesForUser,
  listChannelsForUser,
  listFileCommentsForUser,
  listFileMentionablesForUser,
  listFoldersForUser,
  listPostsForUser,
  markChannelReadForUser,
  moveFileForUser,
  resolveOdinConfirmationForUser,
  restoreChannelForUser,
  setFileEditingForUser,
  signalTypingForUser,
  updateChannelForUser,
  updateFolderForUser,
  undoOdinChangesForUser,
  updatePostForUser,
  setPostReactionForUser,
  votePollForUser,
} from './channels.service.js';

// Channels, posts, file comments, folders and the editing marker, under /api/projects/:projectId.
// Members only: guests get their own routes. MCP credentials reach the file tree, folders and
// moving files, as mcp/access/files.js admits them, for the folder tools. Each write publishes
// channel.updated (channel-events.js).

const id = z.string().trim().min(1).max(64);
const body = z.string().max(20_000);
const channelCreateSchema = z.object({
  description: z.string().trim().max(1000).optional().default(''),
  name: z.string().trim().min(1).max(80),
}).strict();
const channelUpdateSchema = z.object({
  description: z.string().trim().max(1000).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  // "Let Odin answer when tagged": decision rights only (channels.service.js).
  odinEnabled: z.boolean().optional(),
}).strict();
const postsQuerySchema = z.object({
  // 1: the assistant's view, with guests' unscreened posts replaced by a note.
  agentView: z.enum(['0', '1']).optional().transform((value) => value === '1'),
  before: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_POSTS_PAGE).optional().default(POSTS_PAGE_SIZE),
});
const postCreateSchema = z.object({
  body: body.optional().default(''),
  fileIds: z.array(id).max(10).optional().default([]),
  parentId: id.nullable().optional(),
  // The reply this reply answers, in the same thread (post-reactions.js requireReplyTo).
  replyToId: id.nullable().optional(),
  // A poll on a new top-level post (polls.service.js).
  poll: pollInputSchema.optional(),
}).strict();
const postUpdateSchema = z.object({ body }).strict();
// Someone typing in the channel's box (parentId null) or a thread's reply box, or stopping.
const typingSchema = z.object({ parentId: id.nullable().optional(), typing: z.boolean() }).strict();
const commentCreateSchema = z.object({
  body,
  parentId: id.nullable().optional(),
  replyToId: id.nullable().optional(),
}).strict();
// One emoji, added (reacted: true) or taken back (false). post-reactions.js checks it is one.
const reactionSchema = z.object({ emoji: z.string().min(1).max(64), reacted: z.boolean() }).strict();
const odinConfirmationSchema = z.object({ callId: z.string().trim().min(1).max(200), decision: z.enum(['approve', 'decline']) }).strict();
const folderCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  parentId: id.nullable().optional(),
}).strict();
const folderUpdateSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  parentId: id.nullable().optional(),
}).strict();
// Rename, move, or both (channels.service.js moveFileForUser).
const fileMoveSchema = z.object({
  confirmGuests: z.boolean().optional(),
  destination: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project') }).strict(),
    z.object({ channelId: id, folderId: id.nullable().optional().default(null), kind: z.literal('channel') }).strict(),
  ]).optional(),
  fileName: z.string().trim().min(1).max(240).optional(),
}).strict().refine((input) => input.fileName !== undefined || input.destination !== undefined, { message: 'Give a new fileName, a destination, or both.' });

export function createChannelsRouter(deps) {
  const { authRepository, liveEventBus = null, tokenService } = deps;
  const router = Router({ mergeParams: true });
  // Members sign in to every route here. The folder tools' routes (the file tree, folders, and
  // moving a file) also take MCP credentials, for the calls mcp/access/files.js admits.
  const memberAuth = createAuthMiddleware({ authRepository, tokenService });
  const folderToolAuth = createAuthMiddleware({ allowMcp: true, authRepository, tokenService });
  const FOLDER_TOOL_ROUTE = /^\/(?:file-tree|folders\/[^/]+|channels\/[^/]+\/folders)\/?$/;
  const MEMBER_ROUTE = /^\/(?:channels|posts|folders)(?:\/|$)|^\/files\/[^/]+\/(?:comments|mentionables|editing)\/?$/;
  router.use((request, response, next) => {
    // Under /api/projects/:projectId; the vault's file routes after this router sign in their own way.
    const path = request.path;
    if (FOLDER_TOOL_ROUTE.test(path) || (request.method === 'PATCH' && /^\/files\/[^/]+\/?$/.test(path))) return folderToolAuth(request, response, next);
    if (MEMBER_ROUTE.test(path)) return memberAuth(request, response, next);
    return next();
  });

  // Runs a handler and sends its result; `publish(result, request)` then tells open screens.
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
  const projectIdOf = (request) => request.params.projectId;
  const channelWrite = (area, { workspace = false } = {}) => (result, request) => {
    publishChannelWrite(liveEventBus, request, { area, channelId: result.channel?.id ?? request.params.channelId, projectId: projectIdOf(request), workspace });
  };
  // A post or comment: its channel's posts, or the files area for a comment. A comment on a file
  // outside any channel refreshes the project screens instead.
  const postWrite = (result, request) => {
    const isComment = result.post?.targetType === 'file' || Boolean(result.comment);
    const channelId = result.channelId ?? (isComment ? null : result.post?.targetId);
    if (channelId) {
      publishChannelWrite(liveEventBus, request, { area: isComment ? 'files' : 'posts', channelId, fileId: result.fileId ?? result.comment?.targetId ?? null, projectId: projectIdOf(request), workspace: !isComment });
    } else {
      publishProjectChanged(liveEventBus, projectIdOf(request), { actor: actorOf(request), originClientId: originClientIdOf(request), reason: `${request.method.toLowerCase()} ${request.path}` });
    }
  };
  const fileWrite = (result, request) => {
    if (result.channelId) publishChannelWrite(liveEventBus, request, { area: 'files', channelId: result.channelId, fileId: result.fileId ?? null, projectId: projectIdOf(request) });
  };

  router.get('/channels', send(200, (request) => listChannelsForUser(deps, user(request), projectIdOf(request))));
  router.post('/channels', send(201, (request) => createChannelForUser(deps, user(request), projectIdOf(request), channelCreateSchema.parse(request.body ?? {})), channelWrite('members')));
  router.patch('/channels/:channelId', send(200, (request) => updateChannelForUser(deps, user(request), projectIdOf(request), request.params.channelId, channelUpdateSchema.parse(request.body ?? {})), channelWrite('members')));
  // Archiving is the only removal: a channel goes for good only with its project.
  router.delete('/channels/:channelId', send(200, (request) => archiveChannelForUser(deps, user(request), projectIdOf(request), request.params.channelId), channelWrite('members')));
  router.post('/channels/:channelId/restore', send(200, (request) => restoreChannelForUser(deps, user(request), projectIdOf(request), request.params.channelId), channelWrite('members')));
  router.post('/channels/:channelId/read', send(200, (request) => markChannelReadForUser(deps, user(request), projectIdOf(request), request.params.channelId)));
  router.get('/channels/:channelId/mentionables', send(200, (request) => listChannelMentionablesForUser(deps, user(request), projectIdOf(request), request.params.channelId)));

  router.get('/channels/:channelId/posts', send(200, (request) => listPostsForUser(deps, user(request), projectIdOf(request), request.params.channelId, postsQuerySchema.parse(request.query))));
  router.post('/channels/:channelId/posts', send(201, (request) => createPostForUser(deps, user(request), projectIdOf(request), request.params.channelId, postCreateSchema.parse(request.body ?? {})), (result, request) => {
    publishChannelWrite(liveEventBus, request, { area: 'posts', channelId: request.params.channelId, projectId: projectIdOf(request), workspace: true });
  }));
  // Typing signals change nothing, so they are not audit events (http-audit-middleware.js) and
  // reload no project screen (project-live-events.js).
  router.post('/channels/:channelId/typing', async (request, response, next) => {
    response.locals.skipAudit = true;
    try {
      const result = await signalTypingForUser(deps, user(request), projectIdOf(request), request.params.channelId, typingSchema.parse(request.body ?? {}));
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json({ ok: true });
      publishChannelTyping(liveEventBus, { ...result.signal, originClientId: originClientIdOf(request) });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/posts/:postId', send(200, (request) => updatePostForUser(deps, user(request), projectIdOf(request), request.params.postId, postUpdateSchema.parse(request.body ?? {})), postWrite));
  router.delete('/posts/:postId', send(200, (request) => deletePostForUser(deps, user(request), projectIdOf(request), request.params.postId), postWrite));
  // Reactions: the post's channel, or for a file comment its file, hears of it.
  router.put('/posts/:postId/reactions', send(200, (request) => setPostReactionForUser(deps, user(request), projectIdOf(request), request.params.postId, reactionSchema.parse(request.body ?? {})), (result, request) => {
    if (result.channelId) publishChannelWrite(liveEventBus, request, { area: result.fileId ? 'files' : 'posts', channelId: result.channelId, fileId: result.fileId, projectId: projectIdOf(request), workspace: false });
    else publishProjectChanged(liveEventBus, projectIdOf(request), { actor: actorOf(request), originClientId: originClientIdOf(request), reason: `${request.method.toLowerCase()} ${request.path}` });
  }));

  // Odin in channels: the buttons on Odin's replies that only the person who tagged it can use.
  // Each channel's "Let Odin answer when tagged" is saved with the channel (PATCH above). Odin's
  // own posts publish channel.updated as they arrive (odin-channel.service.js).
  router.post('/posts/:postId/odin/confirmation', send(202, (request) => resolveOdinConfirmationForUser(deps, user(request), projectIdOf(request), request.params.postId, odinConfirmationSchema.parse(request.body ?? {}))));
  // Polls (polls.service.js): read one, vote (again, to change it), and close it early. A vote
  // refreshes the channel's posts on every open screen.
  const pollWrite = (result, request) => publishChannelWrite(liveEventBus, request, { area: 'posts', channelId: result.channelId, projectId: projectIdOf(request) });
  router.get('/posts/:postId/poll', send(200, (request) => getPollForUser(deps, user(request), projectIdOf(request), request.params.postId)));
  router.put('/posts/:postId/poll/vote', send(200, (request) => votePollForUser(deps, user(request), projectIdOf(request), request.params.postId, pollVoteSchema.parse(request.body ?? {})), pollWrite));
  router.post('/posts/:postId/poll/close', send(200, (request) => closePollForUser(deps, user(request), projectIdOf(request), request.params.postId), pollWrite));
  router.post('/posts/:postId/odin/undo', send(200, (request) => undoOdinChangesForUser(deps, user(request), projectIdOf(request), request.params.postId)));

  router.get('/channels/:channelId/folders', send(200, (request) => listFoldersForUser(deps, user(request), projectIdOf(request), request.params.channelId)));
  router.post('/channels/:channelId/folders', send(201, (request) => createFolderForUser(deps, user(request), projectIdOf(request), request.params.channelId, folderCreateSchema.parse(request.body ?? {})), channelWrite('files')));
  const folderWrite = (result, request) => publishChannelWrite(liveEventBus, request, { area: 'files', channelId: result.folder.channelId, projectId: projectIdOf(request) });
  router.patch('/folders/:folderId', send(200, (request) => updateFolderForUser(deps, user(request), projectIdOf(request), request.params.folderId, folderUpdateSchema.parse(request.body ?? {})), folderWrite));
  router.delete('/folders/:folderId', send(200, (request) => deleteFolderForUser(deps, user(request), projectIdOf(request), request.params.folderId), folderWrite));

  // The project's files as one tree, and renaming or moving a file in it. The vault's guard
  // (channel-events.js) refreshes the library the file left; this refreshes the one it went to.
  router.get('/file-tree', send(200, (request) => getFileTreeForUser(deps, user(request), projectIdOf(request))));
  router.patch('/files/:fileId', send(200, (request) => moveFileForUser(deps, user(request), projectIdOf(request), request.params.fileId, fileMoveSchema.parse(request.body ?? {})), (result, request) => {
    if (result.changed && result.channelId && result.channelId !== result.fromChannelId) {
      publishChannelWrite(liveEventBus, request, { area: 'files', channelId: result.channelId, fileId: result.file.id, projectId: projectIdOf(request) });
    }
  }));

  router.get('/files/:fileId/comments', send(200, (request) => listFileCommentsForUser(deps, user(request), projectIdOf(request), request.params.fileId)));
  router.post('/files/:fileId/comments', send(201, (request) => createFileCommentForUser(deps, user(request), projectIdOf(request), request.params.fileId, commentCreateSchema.parse(request.body ?? {})), postWrite));
  router.get('/files/:fileId/mentionables', send(200, (request) => listFileMentionablesForUser(deps, user(request), projectIdOf(request), request.params.fileId)));
  router.put('/files/:fileId/editing', send(200, (request) => setFileEditingForUser(deps, user(request), projectIdOf(request), request.params.fileId), fileWrite));
  router.delete('/files/:fileId/editing', send(200, (request) => clearFileEditingForUser(deps, user(request), projectIdOf(request), request.params.fileId), fileWrite));

  return router;
}
