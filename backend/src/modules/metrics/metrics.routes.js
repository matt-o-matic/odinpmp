import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { metricsLeaderboardQuerySchema } from './metrics.schema.js';
import { getContributorLeaderboardForUser } from './metrics.service.js';

// Metrics are written by the server when work is completed (work-completion-metrics.js),
// so this router is read-only.
export function createMetricsRouter({
  authRepository,
  metricsRepository,
  projectRepository = null,
  tokenService,
}) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });

  router.get('/leaderboard', requireAuth, async (request, response, next) => {
    try {
      const query = metricsLeaderboardQuerySchema.parse(request.query);
      const result = await getContributorLeaderboardForUser(request.auth.user, query, metricsRepository, authRepository, projectRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
