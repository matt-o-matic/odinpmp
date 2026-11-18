import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { requirementsServiceDeps } from '../requirements/requirements.routes.js';
import { homeLensSchema, homeProposalParamsSchema, homeQuerySchema } from './home.schema.js';
import { getHomeForUser, saveHomeLensForUser, stageHomeRecoveryForUser } from './home.service.js';

/** Mounted at /api/home. */
export function createHomeRouter(deps) {
  const router = Router();
  const homeDeps = { ...deps, requirements: requirementsServiceDeps(deps) };
  // MCP clients may read home (odin_get_my_work) and nothing else here (mcp/access/workspace.js).
  router.use(createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }));

  router.get('/', async (request, response, next) => {
    try {
      const { agentView, lens } = homeQuerySchema.parse(request.query);
      // Every MCP credential gets the agent view, whether or not it asked.
      response.json(await getHomeForUser(homeDeps, { agentView: agentView === '1' || request.auth.credentialSource === 'mcp', lens: lens ?? null, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.put('/lens', async (request, response, next) => {
    try {
      const { lens } = homeLensSchema.parse(request.body ?? {});
      response.json(await saveHomeLensForUser(homeDeps, { lens, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.post('/recovery/:proposalId/stage', async (request, response, next) => {
    try {
      const { proposalId } = homeProposalParamsSchema.parse(request.params);
      response.json(await stageHomeRecoveryForUser(homeDeps, { proposalId, user: request.auth.user }));
    } catch (error) { next(error); }
  });

  return router;
}
