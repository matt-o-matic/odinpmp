import { Router } from 'express';
import { z } from 'zod';

import { publishWorkspaceChanged } from '../../lib/events/project-live-events.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { ENGAGEMENT_STATUSES } from '../../lib/projects/project-kind.js';
import {
  closeEngagementForUser,
  convertEngagementForUser,
  createEngagementForUser,
  listEngagementsForUser,
  reopenEngagementForUser,
  updateEngagementForUser,
} from './engagements.service.js';

const engagementListQuerySchema = z.object({ status: z.enum(ENGAGEMENT_STATUSES).optional() });
const engagementCreateSchema = z.object({
  customer: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(160),
}).strict();
const engagementUpdateSchema = z.object({
  customer: z.string().trim().min(1).max(255).optional(),
  ownerId: z.string().trim().min(1).max(36).optional(),
}).strict();
const engagementConvertSchema = z.object({
  // "Move open pursuit tasks to the project board", off by default (Q-07).
  moveOpenPursuitTasks: z.boolean().optional().default(false),
  templateId: z.string().trim().min(1).max(128).nullable().optional().default(null),
}).strict();

/** Mounted at /api/engagements. */
export function createEngagementsRouter({ authRepository, liveEventBus = null, projectRepository, tokenService, workspaceModulesRepository }) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));
  const deps = { projectRepository, workspaceModulesRepository };

  router.get('/', async (request, response, next) => {
    try {
      response.json(await listEngagementsForUser({ ...deps, input: engagementListQuerySchema.parse(request.query), user: request.auth.user }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    try {
      const result = await createEngagementForUser({ ...deps, input: engagementCreateSchema.parse(request.body), user: request.auth.user });
      publishWorkspaceChanged(liveEventBus, result.project.tenantId, { area: 'projects', originClientId: request.get('x-odin-client-id') ?? null });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Convert, close (mark lost) and reopen, mounted at /api/projects beside the project routes.
 * The project write middleware publishes their live events.
 */
export function createEngagementActionsRouter({ assistantRepository = null, authRepository, projectRepository, tokenService, workflowRepository = null, workspaceModulesRepository }) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });
  const deps = { projectRepository, workspaceModulesRepository };

  router.post('/:projectId/convert', requireAuth, async (request, response, next) => {
    try {
      const input = engagementConvertSchema.parse(request.body ?? {});
      response.json(await convertEngagementForUser({ ...deps, assistantRepository, input, projectId: request.params.projectId, user: request.auth.user, workflowRepository }));
    } catch (error) {
      next(error);
    }
  });
  // The engagement's customer and owner (E-09); the name is the project's own.
  router.patch('/:projectId/engagement', requireAuth, async (request, response, next) => {
    try {
      response.json(await updateEngagementForUser({ ...deps, input: engagementUpdateSchema.parse(request.body ?? {}), projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) {
      next(error);
    }
  });
  router.post('/:projectId/close', requireAuth, async (request, response, next) => {
    try {
      response.json(await closeEngagementForUser({ ...deps, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) {
      next(error);
    }
  });
  router.post('/:projectId/reopen', requireAuth, async (request, response, next) => {
    try {
      response.json(await reopenEngagementForUser({ ...deps, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
