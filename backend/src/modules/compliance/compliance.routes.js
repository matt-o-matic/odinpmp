import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { complianceAuditExportSchema, complianceIdSchema, compliancePolicyUpdateSchema, controlAttestationCreateSchema, legalHoldCreateSchema, legalHoldReleaseSchema, privacyErasureExecuteSchema, privacyErasureRequestSchema } from './compliance.schema.js';
import { createComplianceAuditExportForUser, createControlAttestationForUser, createLegalHoldForUser, createPrivacyErasureRequestForUser, executePrivacyErasureForUser, getComplianceWorkspaceForUser, readComplianceAuditExportForUser, releaseLegalHoldForUser, updateCompliancePolicyForUser } from './compliance.service.js';

export function createComplianceRouter({ authRepository, complianceRepository, fileStorage, tokenService }) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));
  router.get('/', async (request, response, next) => {
    try { response.json(await getComplianceWorkspaceForUser({ repository: complianceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.put('/policy', async (request, response, next) => {
    try { response.json(await updateCompliancePolicyForUser({ input: compliancePolicyUpdateSchema.parse(request.body), repository: complianceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/audit-exports', async (request, response, next) => {
    try { response.status(201).json(await createComplianceAuditExportForUser({ input: complianceAuditExportSchema.parse(request.body), objectStorage: fileStorage, repository: complianceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/privacy-erasure-requests', async (request, response, next) => {
    try { response.status(201).json(await createPrivacyErasureRequestForUser({ input: privacyErasureRequestSchema.parse(request.body), repository: complianceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/legal-holds', async (request, response, next) => { try { response.status(201).json(await createLegalHoldForUser({ input: legalHoldCreateSchema.parse(request.body), repository: complianceRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/legal-holds/:holdId/release', async (request, response, next) => { try { const input = legalHoldReleaseSchema.parse(request.body); response.json(await releaseLegalHoldForUser({ expectedVersion: input.expectedVersion, holdId: complianceIdSchema.parse(request.params.holdId), reason: input.reason, repository: complianceRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/control-attestations', async (request, response, next) => { try { response.status(201).json(await createControlAttestationForUser({ input: controlAttestationCreateSchema.parse(request.body), repository: complianceRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/privacy-erasure-requests/:requestId/execute', async (request, response, next) => {
    try { const input = privacyErasureExecuteSchema.parse(request.body); response.json(await executePrivacyErasureForUser({ expectedVersion: input.expectedVersion, repository: complianceRepository, requestId: complianceIdSchema.parse(request.params.requestId), user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.get('/audit-exports/:exportId/content', async (request, response, next) => {
    try {
      const { asset, evidence } = await readComplianceAuditExportForUser({ exportId: complianceIdSchema.parse(request.params.exportId), objectStorage: fileStorage, repository: complianceRepository, user: request.auth.user });
      response.setHeader('Content-Type', 'application/json'); response.setHeader('Content-Length', String(asset.size));
      response.setHeader('Content-Disposition', `attachment; filename="audit-evidence-${evidence.id}.json"`); response.send(asset.bytes);
    } catch (error) { next(error); }
  });
  return router;
}
