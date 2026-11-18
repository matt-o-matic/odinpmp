import { Router } from 'express';
import { z } from 'zod';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { listWorkspaceModulesForUser, updateWorkspaceModuleForUser } from './workspace-modules.service.js';

const moduleUpdateSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(0),
  key: z.string().trim().min(1).max(64),
}).strict();

/** Mounted at /api/workspace/modules. Every member reads; workspace admins switch. */
export function createWorkspaceModulesRouter({ authRepository, projectRepository, tokenService, workspaceModulesRepository }) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));

  router.get('/', async (request, response, next) => {
    try {
      response.json(await listWorkspaceModulesForUser({ projectRepository, repository: workspaceModulesRepository, user: request.auth.user }));
    } catch (error) {
      next(error);
    }
  });

  router.put('/', async (request, response, next) => {
    try {
      const input = moduleUpdateSchema.parse(request.body);
      const { after, before, module } = await updateWorkspaceModuleForUser({ input, projectRepository, repository: workspaceModulesRepository, user: request.auth.user });
      // The audit trail records who switched the module, from what to what.
      response.locals.audit = { after, before, dataClassification: 'internal' };
      response.json({ module, ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
