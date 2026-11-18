import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  biFeedQuerySchema,
  executeReportSchema,
  globalSearchQuerySchema,
  reportDefinitionCreateSchema,
  reportDefinitionUpdateSchema,
  reportingAnalyticsQuerySchema,
  reportSubscriptionCreateSchema,
  reportSubscriptionUpdateSchema,
  reportWorkspaceQuerySchema,
  savedViewCreateSchema,
  savedViewUpdateSchema,
  versionedReportingDeleteSchema,
} from './reporting.schema.js';
import {
  createReportingRecordForUser,
  createSubscriptionForUser,
  deleteReportingRecordForUser,
  executeReportForUser,
  getBiFeedForUser,
  getReportingAnalyticsForUser,
  getStandardDashboardsForUser,
  getReportingWorkspaceForUser,
  refreshSearchIndexForUser,
  searchForUser,
  updateReportingRecordForUser,
  updateSubscriptionForUser,
} from './reporting.service.js';

export function createReportingRouter({ authRepository, reportingRepository, tokenService, ...dependencies }) {
  // MCP clients may search (odin_search) and nothing else here (mcp/access/workspace.js).
  const router = Router(); router.use(createAuthMiddleware({ allowMcp: true, authRepository, tokenService }));
  router.get('/', async (request, response, next) => { try { response.json(await getReportingWorkspaceForUser({ dependencies, input: reportWorkspaceQuerySchema.parse(request.query), repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  // A grant limited to some projects searches one of them (route-access.js checks which) and gets
  // none of the workspace-wide records, such as portfolio items.
  router.get('/search', async (request, response, next) => { try { response.json(await searchForUser({ dependencies, input: globalSearchQuerySchema.parse(request.query), projectOnly: Boolean(request.auth.mcpGrant?.projectIds?.length), repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.get('/dashboards', async (request, response, next) => { try { const projectId = typeof request.query.projectId === 'string' && request.query.projectId.trim() ? request.query.projectId.trim() : null; response.json(await getStandardDashboardsForUser({ dependencies, projectId, user: request.auth.user })); } catch (error) { next(error); } });
  router.get('/analytics/change-trends', async (request, response, next) => { try { response.json(await getReportingAnalyticsForUser({ dependencies, input: reportingAnalyticsQuerySchema.parse(request.query), repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/search/refresh', async (request, response, next) => { try { response.json(await refreshSearchIndexForUser({ dependencies, repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.get('/bi/:dataset', async (request, response, next) => { try { response.json(await getBiFeedForUser({ dataset: request.params.dataset, dependencies, input: biFeedQuerySchema.parse(request.query), user: request.auth.user })); } catch (error) { next(error); } });

  function registerDefinitionCrud({ createSchema, kind, path, updateSchema }) {
    router.post(path, async (request, response, next) => { try { response.status(201).json(await createReportingRecordForUser({ dependencies, input: createSchema.parse(request.body), kind, repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
    router.patch(`${path}/:id`, async (request, response, next) => { try { response.json(await updateReportingRecordForUser({ dependencies, id: request.params.id, input: updateSchema.parse(request.body), kind, repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
    router.delete(`${path}/:id`, async (request, response, next) => { try { const { expectedVersion } = versionedReportingDeleteSchema.parse(request.body); response.json(await deleteReportingRecordForUser({ complianceRepository: dependencies.complianceRepository, expectedVersion, id: request.params.id, kind, repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  }
  registerDefinitionCrud({ createSchema: savedViewCreateSchema, kind: 'view', path: '/views', updateSchema: savedViewUpdateSchema });
  registerDefinitionCrud({ createSchema: reportDefinitionCreateSchema, kind: 'report', path: '/reports', updateSchema: reportDefinitionUpdateSchema });
  router.post('/reports/:reportId/run', async (request, response, next) => { try { response.json(await executeReportForUser({ dependencies, input: executeReportSchema.parse(request.body), reportId: request.params.reportId, repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/reports/:reportId/download', async (request, response, next) => { try { const result = await executeReportForUser({ dependencies, input: executeReportSchema.parse(request.body), reportId: request.params.reportId, repository: reportingRepository, user: request.auth.user }); const body = Buffer.from(result.content, result.contentEncoding); response.setHeader('Content-Type', result.contentType); response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`); response.status(200).send(body); } catch (error) { next(error); } });
  router.post('/subscriptions', async (request, response, next) => { try { response.status(201).json(await createSubscriptionForUser({ dependencies, input: reportSubscriptionCreateSchema.parse(request.body), repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.patch('/subscriptions/:subscriptionId', async (request, response, next) => { try { response.json(await updateSubscriptionForUser({ dependencies, input: reportSubscriptionUpdateSchema.parse(request.body), repository: reportingRepository, subscriptionId: request.params.subscriptionId, user: request.auth.user })); } catch (error) { next(error); } });
  router.delete('/subscriptions/:subscriptionId', async (request, response, next) => { try { const { expectedVersion } = versionedReportingDeleteSchema.parse(request.body); response.json(await deleteReportingRecordForUser({ expectedVersion, id: request.params.subscriptionId, kind: 'subscription', repository: reportingRepository, user: request.auth.user })); } catch (error) { next(error); } });
  return router;
}
