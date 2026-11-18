import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../../lib/errors/http-error.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { getRequestIp } from '../../lib/http/request-meta.js';
import {
  cancelJoinRequest,
  confirmJoinRequestEmail,
  createJoinRequest,
  createJoinRequestLimiters,
  decideJoinRequest,
  listJoinRequestsForAdmin,
  listOwnJoinRequests,
  resendJoinRequestConfirmation,
} from './join-requests.service.js';

const requestIdSchema = z.string().trim().min(1).max(64);
const createJoinRequestSchema = z.object({ workspaceName: z.string().trim().min(1).max(120) }).strict();
const confirmJoinRequestSchema = z.object({ token: z.string().trim().min(16).max(200) }).strict();
const approveJoinRequestSchema = z.object({ role: z.enum(['user', 'manager', 'admin']).default('user') }).strict();

function handle(run, status = 200) {
  return async (request, response, next) => {
    try {
      response.status(status).json(await run(request));
    } catch (error) {
      next(error);
    }
  };
}

// Someone acting as another person, or in an emergency session, can't ask to join for them.
function ownSessionUser(request) {
  if (request.auth.impersonation || request.auth.breakGlass) {
    throw new HttpError(403, 'Requests to join a workspace can only be made from your own session.');
  }
  return request.auth.user;
}

function serviceDeps(deps, limiters) {
  return {
    auditWriter: deps.auditWriter ?? null,
    authRepository: deps.authRepository,
    clock: deps.joinRequestsClock,
    frontendAppUrl: deps.frontendAppUrl,
    joinRequestsRepository: deps.joinRequestsRepository,
    limiters,
    mailRepository: deps.mailRepository,
  };
}

/** Mounted at /api/workspace-access: a signed-in person's own requests, and the emailed confirmation. */
export function createWorkspaceAccessRouter(deps) {
  const router = Router();
  const svc = serviceDeps(deps, deps.joinRequestLimiters ?? createJoinRequestLimiters());
  const requireAuth = createAuthMiddleware({ authRepository: deps.authRepository, tokenService: deps.tokenService });

  // The token is the credential, so this needs no session; it comes in the body, never the URL.
  router.post('/confirm', handle((request) => confirmJoinRequestEmail(svc, {
    ipAddress: getRequestIp(request),
    token: confirmJoinRequestSchema.parse(request.body ?? {}).token,
  })));

  router.use(requireAuth);
  router.get('/requests', handle((request) => listOwnJoinRequests(svc, { user: request.auth.user })));
  router.post('/requests', handle((request) => createJoinRequest(svc, {
    user: ownSessionUser(request),
    workspaceName: createJoinRequestSchema.parse(request.body ?? {}).workspaceName,
  }), 202));
  router.post('/requests/:requestId/resend-confirmation', handle((request) => resendJoinRequestConfirmation(svc, {
    requestId: requestIdSchema.parse(request.params.requestId),
    user: ownSessionUser(request),
  })));
  router.post('/requests/:requestId/cancel', handle((request) => cancelJoinRequest(svc, {
    requestId: requestIdSchema.parse(request.params.requestId),
    user: ownSessionUser(request),
  })));
  return router;
}

/** Mounted at /api/tenants/user-requests: the active workspace's admins review confirmed requests. */
export function createJoinRequestAdminRouter(deps) {
  const router = Router();
  const svc = serviceDeps(deps, null);
  router.use(createAuthMiddleware({ authRepository: deps.authRepository, tokenService: deps.tokenService }));
  router.get('/', handle((request) => listJoinRequestsForAdmin(svc, { user: request.auth.user })));
  router.post('/:requestId/approve', handle((request) => decideJoinRequest(svc, {
    actor: request.auth.actor,
    decision: 'approved',
    ipAddress: getRequestIp(request),
    requestId: requestIdSchema.parse(request.params.requestId),
    role: approveJoinRequestSchema.parse(request.body ?? {}).role,
    user: request.auth.user,
  })));
  router.post('/:requestId/decline', handle((request) => decideJoinRequest(svc, {
    actor: request.auth.actor,
    decision: 'declined',
    ipAddress: getRequestIp(request),
    requestId: requestIdSchema.parse(request.params.requestId),
    user: request.auth.user,
  })));
  return router;
}
