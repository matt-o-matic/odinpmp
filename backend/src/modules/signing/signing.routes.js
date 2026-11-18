import { pipeline } from 'node:stream/promises';

import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { getRequestIp, getRequestUserAgent } from '../../lib/http/request-meta.js';
import { fileContentDisposition } from '../vault/vault.service.js';
import {
  signingListQuerySchema,
  signingPositionSchema,
  signingReasonSchema,
  signingRemindSchema,
  signingRequestCreateSchema,
  signingSignSchema,
} from './signing.schema.js';
import {
  cancelSigningRequestForUser,
  createSigningRequestForUser,
  declineRequest,
  getCertificateForUser,
  getPortalCertificate,
  getPortalDocumentContent,
  getPortalRequestDocument,
  getPortalSigningRequest,
  getRequestDocumentForUser,
  getSigningRequestForUser,
  listPortalDocuments,
  listSigningRequestsForUser,
  remindSignersForUser,
  removeSignerForUser,
  sendSigningCode,
  signRequest,
  signingDeps,
} from './signing.service.js';

// Signature request routes (docs/document-signing/plan.md, API). Members reach them under the
// project; stakeholders through their portal link, mounted inside the public requirements router
// so the link's rate limits apply.

function handle(run, status = 200) {
  return async (request, response, next) => {
    try {
      response.status(status).json(await run(request));
    } catch (error) {
      next(error);
    }
  };
}

// Sends bytes, or a stream of them with its size.
function sendBytes(run) {
  return async (request, response, next) => {
    try {
      const { bytes, contentType, fileName, size, stream } = await run(request);
      const download = request.query.download === '1';
      response.setHeader('Content-Type', contentType || 'application/octet-stream');
      response.setHeader('Content-Length', String(stream ? size : bytes.length));
      response.setHeader('Content-Disposition', fileContentDisposition(fileName, { contentType, download }));
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'private, no-store');
      if (!stream) {
        response.status(200).send(bytes);
        return;
      }
      response.status(200);
      await pipeline(stream, response);
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else next(error);
    }
  };
}

/** Mounted at /api/projects/:projectId/signing-requests. */
export function createSigningRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = signingDeps(deps);
  // MCP credentials reach only the routes backend/src/mcp/access/signing.js admits.
  router.use(createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }));
  const base = (request) => ({ projectId: request.params.projectId, user: request.auth.user });

  router.get('/', handle((request) => listSigningRequestsForUser(svc, { ...base(request), ...signingListQuerySchema.parse(request.query) })));
  router.post('/', handle((request) => createSigningRequestForUser(svc, { ...base(request), input: signingRequestCreateSchema.parse(request.body ?? {}) }), 201));
  router.get('/:requestId', handle((request) => getSigningRequestForUser(svc, { ...base(request), requestId: request.params.requestId })));
  router.post('/:requestId/cancel', handle((request) => cancelSigningRequestForUser(svc, { ...base(request), input: signingReasonSchema.parse(request.body ?? {}), requestId: request.params.requestId })));
  router.post('/:requestId/signers/:signerId/remove', handle((request) => removeSignerForUser(svc, {
    ...base(request), input: signingReasonSchema.parse(request.body ?? {}), requestId: request.params.requestId, signerId: request.params.signerId,
  })));
  router.post('/:requestId/remind', handle((request) => remindSignersForUser(svc, { ...base(request), input: signingRemindSchema.parse(request.body ?? {}), requestId: request.params.requestId })));
  router.get('/:requestId/certificate', sendBytes((request) => getCertificateForUser(svc, { ...base(request), requestId: request.params.requestId })));
  router.get('/:requestId/documents/:position/content', sendBytes((request) => getRequestDocumentForUser(svc, {
    ...base(request), position: signingPositionSchema.parse(request.params).position, requestId: request.params.requestId,
  })));
  return router;
}

/** Mounted at /api/public/requirements/:token, after the portal's rate limiter. The token is the only credential. */
export function createPortalSigningRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = signingDeps(deps);
  const token = (request) => request.params.token;

  router.get('/documents', handle((request) => listPortalDocuments(svc, { token: token(request) })));
  router.get('/documents/:fileId/content', sendBytes((request) => getPortalDocumentContent(svc, { fileId: request.params.fileId, token: token(request) })));
  router.get('/signing/:requestId', handle((request) => getPortalSigningRequest(svc, { requestId: request.params.requestId, token: token(request) })));
  router.get('/signing/:requestId/certificate', sendBytes((request) => getPortalCertificate(svc, { requestId: request.params.requestId, token: token(request) })));
  router.get('/signing/:requestId/documents/:position/content', sendBytes((request) => getPortalRequestDocument(svc, {
    position: signingPositionSchema.parse(request.params).position, requestId: request.params.requestId, token: token(request),
  })));
  router.post('/signing/:requestId/code', handle((request) => sendSigningCode(svc, { requestId: request.params.requestId, token: token(request) })));
  router.post('/signing/:requestId/sign', handle((request) => signRequest(svc, {
    input: signingSignSchema.parse(request.body ?? {}),
    ipAddress: getRequestIp(request),
    requestId: request.params.requestId,
    token: token(request),
    userAgent: getRequestUserAgent(request),
  })));
  router.post('/signing/:requestId/decline', handle((request) => declineRequest(svc, { input: signingReasonSchema.parse(request.body ?? {}), requestId: request.params.requestId, token: token(request) })));
  return router;
}
