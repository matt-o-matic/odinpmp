import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { insightsLayoutResetSchema, insightsLayoutWriteSchema, insightsQuerySchema } from './insights.schema.js';
import {
  getProjectInsightsForUser,
  getProjectInsightsReportCardForUser,
  resetProjectInsightsLayoutForUser,
  saveProjectInsightsLayoutForUser,
} from './insights.service.js';

/** Mounted at /api/projects. */
export function createInsightsRouter(deps) {
  const router = Router();
  // MCP clients may read Insights (odin_get_insights, odin_get_timeline) but not change layouts or
  // run report cards (mcp/access/workspace.js).
  router.use('/:projectId/insights', createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }));

  router.get('/:projectId/insights', async (request, response, next) => {
    try {
      const { agentView, ...input } = insightsQuerySchema.parse(request.query);
      // Every MCP credential gets the agent view, whether or not it asked.
      response.json(await getProjectInsightsForUser({ agentView: agentView === '1' || request.auth.credentialSource === 'mcp', deps, input, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.put('/:projectId/insights/layout', async (request, response, next) => {
    try {
      response.json(await saveProjectInsightsLayoutForUser({ deps, input: insightsLayoutWriteSchema.parse(request.body), projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.delete('/:projectId/insights/layout', async (request, response, next) => {
    try {
      response.json(await resetProjectInsightsLayoutForUser({ deps, input: insightsLayoutResetSchema.parse(request.body ?? {}), projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.get('/:projectId/insights/reports/:reportId', async (request, response, next) => {
    try {
      response.json(await getProjectInsightsReportCardForUser({ deps, projectId: request.params.projectId, reportId: request.params.reportId, user: request.auth.user }));
    } catch (error) { next(error); }
  });

  return router;
}
