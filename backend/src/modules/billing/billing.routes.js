import { createHash } from 'node:crypto';

import { Router } from 'express';
import { ZodError } from 'zod';

import { createOAuthApplicationMiddleware } from '../../lib/auth/oauth-application-middleware.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { platformIdempotencyKeySchema } from '../platform/platform.schema.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { createRequireModule } from '../workspace-modules/workspace-modules.service.js';
import {
  billableTimeQuerySchema, billingLinkSchema, externalInvoiceIdSchema, invoiceClaimSchema, invoiceSummarySchema, storyMilestonesUpdateSchema,
} from './billing.schema.js';
import {
  claimEntriesForApplication, deleteBillingLinkForApplication, deleteInvoiceForApplication, getBillableTimeForApplication, getProjectBillingForUser,
  getStoryMilestonesForUser, putBillingLinkForApplication, putInvoiceForApplication, releaseClaimsForApplication, requireApplicationProject,
  setStoryMilestonesForUser,
} from './billing.service.js';

// Errors on the invoice-gen routes take the contract's shape: { error, code, ...details }, and
// 403 { error: "module_disabled", code: "module_disabled" } with the Consulting module off.
function billingV1ErrorHandler(error, _request, response, next) {
  if (error instanceof ZodError) {
    response.status(400).json({ code: 'invalid_request', details: error.issues.map((issue) => ({ message: issue.message, path: issue.path.join('.') })), error: 'Invalid request payload.' });
    return;
  }
  if (!(error instanceof HttpError)) return next(error);
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {};
  if (details.code === 'module_disabled') {
    response.status(403).json({ ...details, code: 'module_disabled', error: 'module_disabled', message: error.message });
    return;
  }
  const code = details.code ?? ({ 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' }[error.statusCode] ?? 'error');
  response.status(error.statusCode).json({ ...details, code, error: error.message });
}

/**
 * The invoice-gen routes under /api/v1 (docs/invoice-gen-connection/api-contract.md). Each checks
 * the application's scope, its project allowlist and the Consulting module. Writes accept an
 * Idempotency-Key: a replay returns the first response with Idempotency-Replayed: true.
 */
export function createBillingV1Router({ authRepository, billingRepository, platformRepository, projectRepository, workspaceModulesRepository }) {
  const router = Router();
  const app = (scope) => createOAuthApplicationMiddleware({ authRepository, platformRepository, requiredScopes: [scope] });
  const project = async (request) => requireApplicationProject({ application: request.oauthAuth.application, projectId: request.params.projectId, projectRepository, workspaceModulesRepository });

  async function idempotent(request, response, input, run) {
    const application = request.oauthAuth.application;
    const header = request.headers['idempotency-key'];
    if (header == null || header === '') {
      const { body, status } = await run(null);
      return response.status(status).json(body);
    }
    const idempotencyKey = platformIdempotencyKeySchema.parse(header);
    const route = `${request.method} /v1/projects/${request.params.projectId}${request.route.path.replace('/projects/:projectId', '')}`.slice(0, 500);
    const requestHash = createHash('sha256').update(JSON.stringify({ input, params: request.params })).digest('hex');
    const reservation = await platformRepository.beginApiIdempotency({ applicationId: application.id, idempotencyKey, requestHash, route, tenantId: application.tenantId });
    if (!reservation.created) {
      if (reservation.record.status !== 'completed') return response.status(409).json({ code: 'idempotency_in_progress', error: 'The idempotent request is still processing.' });
      response.setHeader('Idempotency-Replayed', 'true');
      return response.status(reservation.record.responseStatus).json(reservation.record.responseBody);
    }
    try {
      const { body, status } = await run(idempotencyKey);
      await platformRepository.completeApiIdempotency({ applicationId: application.id, idempotencyKey, responseBody: body, responseStatus: status });
      return response.status(status).json(body);
    } catch (error) {
      await platformRepository.releaseApiIdempotency?.({ applicationId: application.id, idempotencyKey }).catch(() => {});
      throw error;
    }
  }

  // Every write: the scope, then the project, then the body, then the idempotent run.
  function write(method, path, schema, handler) {
    router[method](path, app('billing.write'), async (request, response, next) => {
      try {
        const { projectId, tenantId } = await project(request);
        const input = schema ? schema.parse(request.body ?? {}) : null;
        const context = { actorId: request.auth.user.id, applicationId: request.oauthAuth.application.id, billingRepository, input, projectId, projectRepository, tenantId };
        await idempotent(request, response, input, async (idempotencyKey) => {
          const result = await handler({ ...context, idempotencyKey, params: request.params });
          return result.status ? result : { body: result, status: 200 };
        });
      } catch (error) { next(error); }
    });
  }

  router.get('/projects/:projectId/billable-time', app('billing.read'), async (request, response, next) => {
    try {
      const { projectId, tenantId } = await project(request);
      response.json(await getBillableTimeForApplication({ billingRepository, input: billableTimeQuerySchema.parse(request.query), projectId, projectRepository, tenantId }));
    } catch (error) { next(error); }
  });
  write('put', '/projects/:projectId/billing-link', billingLinkSchema, (context) => putBillingLinkForApplication(context));
  write('delete', '/projects/:projectId/billing-link', null, (context) => deleteBillingLinkForApplication(context));
  write('post', '/projects/:projectId/invoice-claims', invoiceClaimSchema, (context) => claimEntriesForApplication(context));
  write('delete', '/projects/:projectId/invoice-claims/:externalInvoiceId', null, (context) => releaseClaimsForApplication({ ...context, externalInvoiceId: externalInvoiceIdSchema.parse(context.params.externalInvoiceId) }));
  write('put', '/projects/:projectId/invoices/:externalInvoiceId', invoiceSummarySchema, (context) => putInvoiceForApplication({ ...context, externalInvoiceId: externalInvoiceIdSchema.parse(context.params.externalInvoiceId) }));
  write('delete', '/projects/:projectId/invoices/:externalInvoiceId', null, (context) => deleteInvoiceForApplication({ ...context, externalInvoiceId: externalInvoiceIdSchema.parse(context.params.externalInvoiceId) }));
  router.use(billingV1ErrorHandler);
  return router;
}

/**
 * The project's billing for its members (mounted at /api/projects/:projectId/billing): the
 * panel's summary and the story-to-milestone mapping. Finance-visible people only (E-08);
 * the Consulting module must be on.
 */
export function createProjectBillingRouter({ authRepository, billingRepository, invoiceGenBaseUrl = '', projectRepository, tokenService, workspaceModulesRepository }) {
  const router = Router({ mergeParams: true });
  // MCP credentials reach only the routes mcp/route-access.js allows (access/billing.js).
  router.use(createAuthMiddleware({ allowMcp: true, authRepository, tokenService }));
  router.use(createRequireModule({ moduleKey: CONSULTING_MODULE, workspaceModulesRepository }));
  const deps = (request) => ({ billingRepository, invoiceGenBaseUrl, projectId: request.params.projectId, projectRepository, user: request.auth.user });
  router.get('/', async (request, response, next) => {
    try { response.json(await getProjectBillingForUser(deps(request))); } catch (error) { next(error); }
  });
  router.get('/milestones', async (request, response, next) => {
    try { response.json(await getStoryMilestonesForUser(deps(request))); } catch (error) { next(error); }
  });
  router.put('/milestones', async (request, response, next) => {
    try { response.json(await setStoryMilestonesForUser({ ...deps(request), input: storyMilestonesUpdateSchema.parse(request.body ?? {}) })); } catch (error) { next(error); }
  });
  return router;
}
