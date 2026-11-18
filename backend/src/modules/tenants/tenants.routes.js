import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  auditLogQuerySchema,
  inviteUserSchema,
  fetchOpenAiModelsSchema,
  revokeInviteSchema,
  removeUserFromTenantSchema,
  restoreTenantSchema,
  saveOpenAiConfigRequestSchema,
  ticketConfigListKindSchema,
  updateStatusDefinitionsSchema,
  updateTaskTypeDefinitionsSchema,
  updateTenantSchema,
  updateTicketConfigListSchema,
  updateUsersRequestSchema,
} from './tenants.schema.js';
import {
  backupTenantForUser,
  getAuditLogsForUser,
  deleteOpenAiConfigForUser,
  fetchOpenAiModelsForUser,
  getOpenAiConfigForUser,
  getTenantSettingsForUser,
  inviteUserForUser,
  listExistingUsersForUser,
  listInvitesForUser,
  listStatusDefinitionsForUser,
  listTaskTypeDefinitionsForUser,
  listTicketConfigListForUser,
  saveTicketConfigListForUser,
  removeUserFromTenantForUser,
  restoreTenantForUser,
  resetStatusDefinitionsForUser,
  resetTaskTypeDefinitionsForUser,
  revokeInviteForUser,
  resendInviteForUser,
  saveOpenAiConfigForUser,
  saveStatusDefinitionsForUser,
  saveTaskTypeDefinitionsForUser,
  updateTenantForUser,
  updateUsersForUser,
} from './tenants.service.js';

export function createTenantsRouter({
  authRepository,
  frontendAppUrl,
  mailRepository,
  defaultOpenAiModel = 'gpt-6-luna',
  tenantsRepository,
  tokenService,
}) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });

  router.use(requireAuth);

  router.get('/settings', async (request, response, next) => {
    try {
      const result = await getTenantSettingsForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/ticket-config/:kind', async (request, response, next) => {
    try {
      const kind = ticketConfigListKindSchema.parse(request.params.kind);
      response.status(200).json(await listTicketConfigListForUser(request.auth.user, kind, tenantsRepository));
    } catch (error) {
      next(error);
    }
  });

  router.put('/ticket-config/:kind', async (request, response, next) => {
    try {
      const kind = ticketConfigListKindSchema.parse(request.params.kind);
      const payload = updateTicketConfigListSchema.parse(request.body);
      response.status(200).json(await saveTicketConfigListForUser(request.auth.user, kind, payload, tenantsRepository));
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings', async (request, response, next) => {
    try {
      const payload = updateTenantSchema.parse(request.body);
      const result = await updateTenantForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/openai-config', async (request, response, next) => {
    try {
      const result = await getOpenAiConfigForUser(request.auth.user, tenantsRepository, {
        defaultModel: defaultOpenAiModel,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/openai-config/fetch-models', async (request, response, next) => {
    try {
      const payload = fetchOpenAiModelsSchema.parse(request.body);
      const result = await fetchOpenAiModelsForUser(request.auth.user, payload, {
        defaultModel: defaultOpenAiModel,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/openai-config', async (request, response, next) => {
    try {
      const payload = saveOpenAiConfigRequestSchema.parse(request.body);
      const result = await saveOpenAiConfigForUser(request.auth.user, payload, tenantsRepository, {
        defaultModel: defaultOpenAiModel,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/openai-config', async (request, response, next) => {
    try {
      const result = await deleteOpenAiConfigForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/users', async (request, response, next) => {
    try {
      const payload = updateUsersRequestSchema.parse(request.body);
      const result = await updateUsersForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/invites', async (request, response, next) => {
    try {
      const result = await listInvitesForUser(request.auth.user, tenantsRepository, { mailRepository });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/invites', async (request, response, next) => {
    try {
      const payload = inviteUserSchema.parse(request.body);
      const result = await inviteUserForUser(request.auth.user, payload, tenantsRepository, { mailRepository, frontendAppUrl });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/invites/resend', async (request, response, next) => {
    try {
      const payload = revokeInviteSchema.parse(request.body);
      response.json(await resendInviteForUser(request.auth.user, payload, tenantsRepository, { mailRepository, frontendAppUrl }));
    } catch (error) { next(error); }
  });

  router.post('/invites/revoke', async (request, response, next) => {
    try {
      const payload = revokeInviteSchema.parse(request.body);
      const result = await revokeInviteForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/existing-users', async (request, response, next) => {
    try {
      const result = await listExistingUsersForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/existing-users/remove', async (request, response, next) => {
    try {
      const payload = removeUserFromTenantSchema.parse(request.body);
      const result = await removeUserFromTenantForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/status-definitions', async (request, response, next) => {
    try {
      const result = await listStatusDefinitionsForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/status-definitions', async (request, response, next) => {
    try {
      const payload = updateStatusDefinitionsSchema.parse(request.body);
      const result = await saveStatusDefinitionsForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/status-definitions/reset', async (request, response, next) => {
    try {
      const result = await resetStatusDefinitionsForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/task-type-definitions', async (request, response, next) => {
    try {
      const result = await listTaskTypeDefinitionsForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/task-type-definitions', async (request, response, next) => {
    try {
      const payload = updateTaskTypeDefinitionsSchema.parse(request.body);
      const result = await saveTaskTypeDefinitionsForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/task-type-definitions/reset', async (request, response, next) => {
    try {
      const result = await resetTaskTypeDefinitionsForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/audit-logs', async (request, response, next) => {
    try {
      const payload = auditLogQuerySchema.parse(request.body ?? {});
      const result = await getAuditLogsForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/backup', async (request, response, next) => {
    try {
      const result = await backupTenantForUser(request.auth.user, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/restore', async (request, response, next) => {
    try {
      const payload = restoreTenantSchema.parse(request.body ?? {});
      const result = await restoreTenantForUser(request.auth.user, payload, tenantsRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
