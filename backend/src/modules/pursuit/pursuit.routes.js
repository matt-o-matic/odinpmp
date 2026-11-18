import { Router } from 'express';
import { z } from 'zod';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  getProjectSettingsForUser,
  getPursuitForUser,
  getPursuitInsightsForUser,
  movePursuitTasksForUser,
  saveProjectSettingsForUser,
} from './pursuit.service.js';

const itemId = z.string().trim().min(1).max(120);
// "Let Odin answer when tagged" is not a project setting: each channel has its own, saved with the
// channel (channels.routes.js).
const settingsWriteSchema = z.object({
  expectedVersion: z.number().int().min(0),
  guestsSeeBoard: z.boolean(),
}).strict();
const moveSchema = z.object({
  expectedVersions: z.record(itemId, z.number().int().positive()).optional(),
  storyId: itemId,
  taskIds: z.array(itemId).min(1).max(200),
}).strict();

/**
 * Mounted at /api/projects, after the project mutation events middleware, which publishes the
 * live events for the writes here. The engagement guard lets an engagement's pursuit Insights
 * through while it keeps delivery Insights at 404.
 */
export function createPursuitRouter(deps) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository: deps.authRepository, tokenService: deps.tokenService });

  router.get('/:projectId/pursuit', requireAuth, async (request, response, next) => {
    try {
      response.json(await getPursuitForUser({ deps, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.post('/:projectId/pursuit/move', requireAuth, async (request, response, next) => {
    try {
      response.json(await movePursuitTasksForUser({ deps, input: moveSchema.parse(request.body ?? {}), projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.get('/:projectId/insights/pursuit', requireAuth, async (request, response, next) => {
    try {
      response.json(await getPursuitInsightsForUser({ deps, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.get('/:projectId/settings', requireAuth, async (request, response, next) => {
    try {
      response.json(await getProjectSettingsForUser({ deps, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.put('/:projectId/settings', requireAuth, async (request, response, next) => {
    try {
      response.json(await saveProjectSettingsForUser({ deps, input: settingsWriteSchema.parse(request.body ?? {}), projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });

  return router;
}
