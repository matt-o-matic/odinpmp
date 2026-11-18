import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  connectorConflictResolveSchema,
  connectorConnectionCreateSchema,
  connectorConnectionApproveSchema,
  connectorConnectionUpdateSchema,
  connectorIdSchema,
  connectorInboundEventSchema,
  connectorEventApplySchema,
  connectorErpPostingSchema,
  connectorMappingCreateSchema,
  connectorProviderPolicyCreateSchema,
  connectorProviderPolicyUpdateSchema,
  connectorSyncRunSchema,
  connectorWorkspaceQuerySchema,
} from './connector.schema.js';
import {
  createConnectorConnectionForUser,
  approveConnectorConnectionForUser,
  createConnectorMappingForUser,
  createConnectorProviderPolicyForUser,
  createConnectorSyncRunForUser,
  createConnectorErpPostingForUser,
  beginConnectorOAuthForUser,
  completeConnectorOAuthForUser,
  applyConnectorInboundEventForUser,
  getConnectorWorkspaceForUser,
  receiveConnectorInboundEvent,
  resolveConnectorConflictForUser,
  updateConnectorConnectionForUser,
  updateConnectorProviderPolicyForUser,
} from './connector.service.js';

export function createConnectorAdminRouter({
  authRepository,
  connectorRepository,
  projectRepository,
  resourceFinanceRepository,
  connectorOAuthService,
  tokenService,
}) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));
  router.get('/', async (request, response, next) => {
    try {
      response.json(
        await getConnectorWorkspaceForUser({
          input: connectorWorkspaceQuerySchema.parse(request.query),
          repository: connectorRepository,
          user: request.auth.user,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/connections', async (request, response, next) => {
    try {
      response.status(201).json(
        await createConnectorConnectionForUser({
          input: connectorConnectionCreateSchema.parse(request.body),
          projectRepository,
          repository: connectorRepository,
          user: request.auth.user,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/connections/:id/oauth/start', async (request, response, next) => { try { response.json(await beginConnectorOAuthForUser({ connectionId: connectorIdSchema.parse(request.params.id), oauthService: connectorOAuthService, user: request.auth.user })); } catch (error) { next(error); } });
  router.get('/oauth/callback', async (request, response, next) => { try { const result = await completeConnectorOAuthForUser({ code: String(request.query.code ?? ''), oauthService: connectorOAuthService, state: String(request.query.state ?? ''), user: request.auth.user }); response.redirect(303, result.redirect); } catch (error) { next(error); } });
  router.post('/connections/:id/approve', async (request, response, next) => {
    try { response.json(await approveConnectorConnectionForUser({ connectionId: connectorIdSchema.parse(request.params.id), expectedVersion: connectorConnectionApproveSchema.parse(request.body).expectedVersion, repository: connectorRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/provider-policies', async (request, response, next) => {
    try { response.status(201).json(await createConnectorProviderPolicyForUser({ input: connectorProviderPolicyCreateSchema.parse(request.body), repository: connectorRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.patch('/provider-policies/:id', async (request, response, next) => {
    try { response.json(await updateConnectorProviderPolicyForUser({ input: connectorProviderPolicyUpdateSchema.parse(request.body), policyId: connectorIdSchema.parse(request.params.id), repository: connectorRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.patch('/connections/:id', async (request, response, next) => {
    try {
      response.json(
        await updateConnectorConnectionForUser({
          connectionId: connectorIdSchema.parse(request.params.id),
          input: connectorConnectionUpdateSchema.parse(request.body),
          projectRepository,
          repository: connectorRepository,
          user: request.auth.user,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/mappings', async (request, response, next) => {
    try {
      response.status(201).json(
        await createConnectorMappingForUser({
          input: connectorMappingCreateSchema.parse(request.body),
          projectRepository,
          repository: connectorRepository,
          user: request.auth.user,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/conflicts/:id/resolve', async (request, response, next) => {
    try {
      response.json(
        await resolveConnectorConflictForUser({
          conflictId: connectorIdSchema.parse(request.params.id),
          input: connectorConflictResolveSchema.parse(request.body),
          repository: connectorRepository,
          user: request.auth.user,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/connections/:id/sync-runs', async (request, response, next) => {
    try {
      response.status(202).json(
        await createConnectorSyncRunForUser({
          connectionId: connectorIdSchema.parse(request.params.id),
          input: connectorSyncRunSchema.parse(request.body),
          repository: connectorRepository,
          user: request.auth.user,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/connections/:id/erp-postings', async (request, response, next) => {
    try { response.status(202).json(await createConnectorErpPostingForUser({ connectionId: connectorIdSchema.parse(request.params.id), input: connectorErpPostingSchema.parse(request.body), repository: connectorRepository, resourceFinanceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/events/:id/apply', async (request, response, next) => {
    try { response.json(await applyConnectorInboundEventForUser({ eventId: connectorIdSchema.parse(request.params.id), expectedVersion: connectorEventApplySchema.parse(request.body).expectedVersion, projectRepository, repository: connectorRepository, resourceFinanceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  return router;
}

export function createConnectorPublicRouter({ connectorRepository }) {
  const router = Router();
  router.post('/:connectionId/events', async (request, response, next) => {
    try {
      const result = await receiveConnectorInboundEvent({
        connectionId: connectorIdSchema.parse(request.params.connectionId),
        input: connectorInboundEventSchema.parse(request.body),
        repository: connectorRepository,
        secret: request.headers['x-odin-connector-secret'],
      });
      response.status(result.duplicate ? 200 : 202).json(result);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
