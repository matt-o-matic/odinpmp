import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  addCommentForUser,
  deleteCommentForUser,
  listCommentsForUser,
  listMentionablesForUser,
  updateCommentForUser,
  voteCommentForUser,
} from './comments.service.js';
import {
  commentCreateSchema,
  commentQuerySchema,
  commentUpdateSchema,
  commentVoteSchema,
} from './comments.schema.js';

export function createCommentsRouter({
  authRepository,
  projectRepository,
  tokenService,
}) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository, tokenService, allowMcp: true });

  router.get('/api/projects/:projectId/mentionables', requireAuth, async (request, response, next) => {
    try {
      const query = typeof request.query.query === 'string' ? request.query.query : '';
      const result = await listMentionablesForUser(
        request.auth.user,
        request.params.projectId,
        query,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/projects/:projectId/comments', requireAuth, async (request, response, next) => {
    try {
      const payload = commentQuerySchema.parse(request.query);
      const result = await listCommentsForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/projects/:projectId/comments', requireAuth, async (request, response, next) => {
    try {
      const payload = commentCreateSchema.parse(request.body);
      const result = await addCommentForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/api/projects/:projectId/comments/:commentId', requireAuth, async (request, response, next) => {
    try {
      const payload = commentUpdateSchema.parse(request.body);
      const result = await updateCommentForUser(
        request.auth.user,
        request.params.projectId,
        request.params.commentId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/api/projects/:projectId/comments/:commentId', requireAuth, async (request, response, next) => {
    try {
      const result = await deleteCommentForUser(
        request.auth.user,
        request.params.projectId,
        request.params.commentId,
        projectRepository,
        {
          expectedTextHash: typeof request.body?.expectedTextHash === 'string' ? request.body.expectedTextHash : undefined,
          withoutReplies: request.body?.withoutReplies === true,
        },
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/projects/:projectId/comments/:commentId/vote', requireAuth, async (request, response, next) => {
    try {
      const payload = commentVoteSchema.parse(request.body);
      const result = await voteCommentForUser(
        request.auth.user,
        request.params.projectId,
        request.params.commentId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
