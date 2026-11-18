import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { listProjectTicketConfigForUser } from './project-ticket-config.service.js';

export function createProjectTicketConfigRouter({ authRepository, projectRepository, tenantsRepository, tokenService }) {
  const router = Router();
  router.get('/:projectId/ticket-config', createAuthMiddleware({ authRepository, tokenService, allowMcp: true }), async (request, response, next) => {
    try {
      response.status(200).json(await listProjectTicketConfigForUser(request.auth.user, request.params.projectId, { projectRepository, tenantsRepository }));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
