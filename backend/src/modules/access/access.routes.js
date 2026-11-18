import { Router } from 'express';

import { getRequestIp } from '../../lib/http/request-meta.js';
import { createRequirementsPublicRateLimiter } from '../requirements/requirements-rate-limit.js';
import { hashAccessToken } from './access-links.js';
import {
  accessCommentSchema,
  accessTaskCreateSchema,
  accessTaskPatchSchema,
  accessTimeCreateSchema,
  accessTimeDeleteQuerySchema,
} from './access.schema.js';
import {
  accessServiceDeps,
  createTaskCommentForToken,
  createTaskForToken,
  deleteTimeEntryForToken,
  getAccessHubForToken,
  getTaskBoardForToken,
  listTaskCommentsForToken,
  listTaskTimeForToken,
  logTaskTimeForToken,
  openRequirementsForToken,
  updateTaskForToken,
} from './access.service.js';

function handle(run, status = 200) {
  return async (request, response, next) => {
    try {
      response.status(status).json(await run(request));
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Access link routes, mounted at /api/public/access. The token in the path is the only
 * credential; every request works out again what it opens. Rate limited per link and per IP as
 * the requirements portal is, with its own buckets.
 */
export function createPublicAccessRouter(deps) {
  const router = Router();
  const svc = accessServiceDeps(deps);
  const limiter = deps.accessRateLimiter ?? createRequirementsPublicRateLimiter();

  router.use('/:token', (request, response, next) => {
    const result = limiter.check({
      ipAddress: getRequestIp(request),
      linkKey: hashAccessToken(request.params.token),
      write: !['GET', 'HEAD', 'OPTIONS'].includes(request.method),
    });
    response.setHeader('Cache-Control', 'no-store');
    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      response.status(429).json({
        details: { code: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds, scope: result.scope },
        error: 'rate_limited',
        ok: false,
      });
      return;
    }
    next();
  });

  const token = (request) => request.params.token;
  const project = (request) => request.params.projectId;

  router.get('/:token', handle((request) => getAccessHubForToken(svc, { token: token(request) })));
  router.post('/:token/projects/:projectId/requirements', handle((request) => openRequirementsForToken(svc, {
    projectId: project(request), token: token(request),
  }), 201));
  router.get('/:token/projects/:projectId/tasks', handle((request) => getTaskBoardForToken(svc, {
    projectId: project(request), token: token(request),
  })));
  router.patch('/:token/projects/:projectId/tasks/:taskId', handle((request) => updateTaskForToken(svc, {
    input: accessTaskPatchSchema.parse(request.body ?? {}), projectId: project(request), taskId: request.params.taskId, token: token(request),
  })));
  router.post('/:token/projects/:projectId/stories/:storyId/tasks', handle((request) => createTaskForToken(svc, {
    input: accessTaskCreateSchema.parse(request.body ?? {}), projectId: project(request), storyId: request.params.storyId, token: token(request),
  }), 201));
  router.get('/:token/projects/:projectId/tasks/:taskId/comments', handle((request) => listTaskCommentsForToken(svc, {
    projectId: project(request), taskId: request.params.taskId, token: token(request),
  })));
  router.post('/:token/projects/:projectId/tasks/:taskId/comments', handle((request) => createTaskCommentForToken(svc, {
    input: accessCommentSchema.parse(request.body ?? {}), projectId: project(request), taskId: request.params.taskId, token: token(request),
  }), 201));
  router.get('/:token/projects/:projectId/tasks/:taskId/time', handle((request) => listTaskTimeForToken(svc, {
    projectId: project(request), taskId: request.params.taskId, token: token(request),
  })));
  router.post('/:token/projects/:projectId/tasks/:taskId/time', handle((request) => logTaskTimeForToken(svc, {
    input: accessTimeCreateSchema.parse(request.body ?? {}), projectId: project(request), taskId: request.params.taskId, token: token(request),
  }), 201));
  router.delete('/:token/projects/:projectId/time/:entryId', handle((request) => deleteTimeEntryForToken(svc, {
    entryId: request.params.entryId, expectedVersion: accessTimeDeleteQuerySchema.parse(request.query ?? {}).expectedVersion,
    projectId: project(request), token: token(request),
  })));

  return router;
}
