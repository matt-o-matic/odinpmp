import express, { Router } from 'express';
import { createBugReporterRouter } from '../bug-reporter/bug-reporter.routes.js';
import { createHash } from 'node:crypto';

import { createOAuthApplicationMiddleware } from '../../lib/auth/oauth-application-middleware.js';
import { createServiceAccountMiddleware } from '../../lib/auth/service-account-middleware.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { biFeedQuerySchema } from '../reporting/reporting.schema.js';
import { getBiFeedForServiceAccount } from '../reporting/reporting.service.js';
import { governanceItemCreateSchema } from '../governance/governance.schema.js';
import { complianceSiemFeedSchema } from '../compliance/compliance.schema.js';
import { getComplianceSiemFeed } from '../compliance/compliance.service.js';
import { mutateGovernanceForUser } from '../governance/governance.service.js';
import { createBillingV1Router } from '../billing/billing.routes.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import {
  oauthApplicationCreateSchema, oauthApplicationUpdateSchema, oauthAuthorizationConsentSchema, oauthCredentialRotateSchema,
  oauthTokenSchema, platformIdempotencyKeySchema, platformIdSchema, platformProjectsQuerySchema, platformWorkspaceQuerySchema, webhookReplaySchema,
  webhookSubscriptionCreateSchema, webhookSubscriptionUpdateSchema,
} from './platform.schema.js';
import {
  authorizeOAuthApplicationForUser, createOAuthApplicationForUser, createWebhookSubscriptionForUser, exchangeOAuthAuthorizationCode, exchangeOAuthClientCredentials,
  getPlatformWorkspaceForUser, replayWebhookDeliveryForUser, rotateOAuthCredentialForUser,
  rotateWebhookSecretForUser, updateOAuthApplicationForUser, updateWebhookSubscriptionForUser,
} from './platform.service.js';

function basicCredentials(request) {
  const value = String(request.headers.authorization ?? '');
  if (!value.startsWith('Basic ')) return {};
  try {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return {};
    // RFC 6749 2.3.1: clients form-urlencode the id and secret before Basic encoding them.
    const formDecode = (part) => decodeURIComponent(part.replace(/\+/g, ' '));
    return { client_id: formDecode(decoded.slice(0, separator)), client_secret: formDecode(decoded.slice(separator + 1)) };
  } catch {
    return {};
  }
}

export function createPlatformV1Router({ authRepository, complianceRepository, governanceRepository, identityRepository, platformRepository, projectRepository, tokenService, ...dependencies }) {
  const router = Router();
  router.use('/bug-reporter', createBugReporterRouter({ authRepository, platformRepository, projectRepository, tokenService, ...dependencies }));
  router.post('/oauth/authorize', createAuthMiddleware({ authRepository, tokenService }), async (request, response, next) => { try { response.setHeader('Cache-Control', 'no-store'); response.json(await authorizeOAuthApplicationForUser({ input: oauthAuthorizationConsentSchema.parse(request.body), projectRepository, repository: platformRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), async (request, response, next) => { try { const input = oauthTokenSchema.parse({ ...request.body, ...basicCredentials(request) }); response.setHeader('Cache-Control', 'no-store'); response.json(input.grant_type === 'authorization_code' ? await exchangeOAuthAuthorizationCode({ input, repository: platformRepository }) : await exchangeOAuthClientCredentials({ input, repository: platformRepository })); } catch (error) { next(error); } });
  router.get('/platform/me', createOAuthApplicationMiddleware({ authRepository, platformRepository }), (request, response) => { response.json({ application: request.oauthAuth.application, delegatedUserId: request.oauthAuth.token.userId ?? null, scopes: [...request.oauthAuth.scopes].sort() }); });
  router.get('/audit-events', createOAuthApplicationMiddleware({ authRepository, platformRepository, requiredScopes: ['audit.read'] }), async (request, response, next) => { try { response.json(await getComplianceSiemFeed({ application: request.oauthAuth.application, input: complianceSiemFeedSchema.parse(request.query), repository: complianceRepository })); } catch (error) { next(error); } });
  // The allowlisted projects. Engagements are listed only while the Consulting module is on; kind
  // narrows the list. appUrl is the project's page in the Odin app, for links back to it.
  router.get('/projects', createOAuthApplicationMiddleware({ authRepository, platformRepository, requiredScopes: ['projects.read'] }), async (request, response, next) => {
    try {
      const input = platformProjectsQuerySchema.parse(request.query); const application = request.oauthAuth.application; const allowed = new Set(application.projectIds);
      const includeEngagements = input.kind !== 'delivery' && await isModuleEnabled(dependencies.workspaceModulesRepository, application.tenantId, CONSULTING_MODULE);
      const listed = (await projectRepository.listProjectsForTenant({ includeEngagements, tenantId: application.tenantId, user: request.auth.user }))
        .filter((project) => allowed.has(project.id) && (input.kind === 'all' || project.kind === input.kind));
      const appBase = String(dependencies.frontendAppUrl ?? 'http://localhost:5173/app').replace(/\/+$/, '');
      const projects = await Promise.all(listed.map(async (project) => {
        const kind = projectRepository.getProjectKind ? await projectRepository.getProjectKind({ projectId: project.id }) : null;
        return { ...project, appUrl: `${appBase}/projects/${encodeURIComponent(project.id)}`, engagementStatus: kind?.engagementStatus ?? null, kind: project.kind ?? 'delivery' };
      }));
      response.json({ data: projects.slice(input.offset, input.offset + input.limit), limit: input.limit, offset: input.offset, total: projects.length });
    } catch (error) { next(error); }
  });
  router.use(createBillingV1Router({ authRepository, platformRepository, projectRepository, ...dependencies }));
  router.post('/projects/:projectId/governance-items', createOAuthApplicationMiddleware({ authRepository, platformRepository, requiredScopes: ['projects.write'] }), async (request, response, next) => {
    const application = request.oauthAuth.application; let idempotencyKey = ''; let reservationCreated = false;
    try {
      idempotencyKey = platformIdempotencyKeySchema.parse(request.headers['idempotency-key']);
      if (!application.projectIds.includes(request.params.projectId)) throw new HttpError(404, 'Project not found.');
      const input = governanceItemCreateSchema.parse(request.body); const route = `/v1/projects/${request.params.projectId}/governance-items`;
      const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const reservation = await platformRepository.beginApiIdempotency({ applicationId: application.id, idempotencyKey, requestHash, route, tenantId: application.tenantId });
      reservationCreated = reservation.created;
      if (!reservation.created) {
        if (reservation.record.status !== 'completed') return response.status(409).json({ error: 'The idempotent request is still processing.' });
        response.setHeader('Idempotency-Replayed', 'true'); return response.status(reservation.record.responseStatus).json(reservation.record.responseBody);
      }
      const result = await mutateGovernanceForUser({ domainEvent: { eventType: 'governance.changed', idempotencyKey: `api:${application.id}:${idempotencyKey}`, payload: { action: 'created', entityType: 'governance_item' } }, domainEventOutboxRepository: dependencies.domainEventOutboxRepository, governanceRepository, operation: (repository, args) => repository.createItem(args), payload: { input }, projectId: request.params.projectId, projectRepository, user: request.auth.user });
      const body = { data: result.value }; await platformRepository.completeApiIdempotency({ applicationId: application.id, idempotencyKey, responseBody: body, responseStatus: 201 });
      response.status(201).json(body);
    } catch (error) { if (reservationCreated) await platformRepository.releaseApiIdempotency?.({ applicationId: application.id, idempotencyKey }).catch(() => {}); next(error); }
  });
  router.get('/bi/:dataset', createServiceAccountMiddleware({ identityRepository, requiredScopes: ['reporting.read'] }), async (request, response, next) => { try { response.json(await getBiFeedForServiceAccount({ account: request.serviceAuth.account, dataset: request.params.dataset, dependencies: { ...dependencies, projectRepository }, input: biFeedQuerySchema.parse(request.query) })); } catch (error) { next(error); } });
  return router;
}

export function createPlatformAdminRouter({ authRepository, platformRepository, projectRepository, tokenService, webhookSigningMasterSecret }) {
  const router = Router(); router.use(createAuthMiddleware({ authRepository, tokenService }));
  router.get('/', async (request, response, next) => { try { response.json(await getPlatformWorkspaceForUser({ input: platformWorkspaceQuerySchema.parse(request.query), repository: platformRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/oauth-applications', async (request, response, next) => { try { response.status(201).json(await createOAuthApplicationForUser({ input: oauthApplicationCreateSchema.parse(request.body), projectRepository, repository: platformRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.patch('/oauth-applications/:id', async (request, response, next) => {
    try {
      const input = oauthApplicationUpdateSchema.parse(request.body);
      const result = await updateOAuthApplicationForUser({ applicationId: platformIdSchema.parse(request.params.id), input, projectRepository, repository: platformRepository, user: request.auth.user });
      if (input.enabled === false && result.value.clientId.startsWith('odin_mcp_client_')) {
        await request.app.locals.mcpOAuthRepository.revokeApplication({ applicationId: result.value.id, tenantId: result.value.tenantId, now: Date.now() });
      }
      response.json(result);
    } catch (error) { next(error); }
  });
  router.post('/oauth-applications/:id/rotate', async (request, response, next) => {
    try {
      const result = await rotateOAuthCredentialForUser({ applicationId: platformIdSchema.parse(request.params.id), input: oauthCredentialRotateSchema.parse(request.body), repository: platformRepository, user: request.auth.user });
      if (result.value.clientId.startsWith('odin_mcp_client_')) {
        await request.app.locals.mcpOAuthRepository.revokeApplication({ applicationId: result.value.id, tenantId: result.value.tenantId, now: Date.now() });
      }
      response.json(result);
    } catch (error) { next(error); }
  });
  router.post('/webhooks', async (request, response, next) => { try { response.status(201).json(await createWebhookSubscriptionForUser({ input: webhookSubscriptionCreateSchema.parse(request.body), masterSecret: webhookSigningMasterSecret, repository: platformRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.patch('/webhooks/:id', async (request, response, next) => { try { response.json(await updateWebhookSubscriptionForUser({ input: webhookSubscriptionUpdateSchema.parse(request.body), repository: platformRepository, subscriptionId: platformIdSchema.parse(request.params.id), user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/webhooks/:id/rotate', async (request, response, next) => { try { response.json(await rotateWebhookSecretForUser({ input: oauthCredentialRotateSchema.parse(request.body), masterSecret: webhookSigningMasterSecret, repository: platformRepository, subscriptionId: platformIdSchema.parse(request.params.id), user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/webhook-deliveries/:id/replay', async (request, response, next) => { try { response.json(await replayWebhookDeliveryForUser({ deliveryId: platformIdSchema.parse(request.params.id), input: webhookReplaySchema.parse(request.body), repository: platformRepository, user: request.auth.user })); } catch (error) { next(error); } });
  return router;
}
