import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { wrapProjectRepositoryForAssistant } from './assistant-ticket-visibility.js';
import { isTicketReplyAddress } from '../projects/ticket-intake-mail.js';
import { forwardTicketMailReply } from '../projects/ticket-intake.routes.js';
import {
  inboundClarificationMailSchema,
  assistantStakeholderContactSchema,
  assistantStakeholderContactUpdateSchema,
} from './assistant.schema.js';
import {
  createProjectStakeholderContactForUser,
  updateProjectStakeholderContactForUser,
  ingestClarificationMailReply,
  listProjectClarificationsForUser,
} from './assistant.service.js';
import { registerAgentChatRoutes } from './agent-chat.routes.js';

export function createAssistantRouter({
  agentChatService,
  assistantRepository,
  authRepository,
  clarificationDigestQuietMinutes,
  liveEventBus,
  projectRepository: rawProjectRepository,
  tokenService,
}) {
  // D-027: every assistant-side project read has gated external tickets stripped.
  // This is the single enforcement point; see assistant-ticket-visibility.js.
  const projectRepository = wrapProjectRepositoryForAssistant(rawProjectRepository);
  const router = Router();
  // MCP credentials pass through to backend/src/mcp/route-access.js, which admits only the
  // project stakeholder read and contact add that the MCP tools use.
  const requireAuth = createAuthMiddleware({ allowMcp: true, authRepository, tokenService });

  router.use(requireAuth);

  registerAgentChatRoutes(router, { agentChatService });

  router.get('/projects/:projectId/clarifications', async (request, response, next) => {
    try {
      const result = await listProjectClarificationsForUser({
        assistantRepository,
        digestQuietMinutes: clarificationDigestQuietMinutes,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:projectId/stakeholder-contacts', async (request, response, next) => {
    try {
      const payload = assistantStakeholderContactSchema.parse(request.body ?? {});
      const result = await createProjectStakeholderContactForUser({
        assistantRepository,
        input: payload,
        liveEventBus,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/projects/:projectId/stakeholder-contacts/:stakeholderId', async (request, response, next) => {
    try {
      response.status(200).json(await updateProjectStakeholderContactForUser({
        assistantRepository,
        input: assistantStakeholderContactUpdateSchema.parse(request.body ?? {}),
        liveEventBus,
        projectId: request.params.projectId,
        projectRepository,
        stakeholderId: request.params.stakeholderId,
        user: request.auth.user,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createPublicClarificationMailRouter({
  assistantAiService,
  assistantRepository,
  inboundMailWebhookSecret,
  liveEventBus,
  mailReplyDomain,
  mentionsRepository = null,
  projectRepository,
}) {
  const router = Router();

  router.post('/inbound', async (request, response, next) => {
    try {
      const payload = inboundClarificationMailSchema.parse(request.body ?? {});
      // The SES Lambda posts every inbound message here, including replies to ticket
      // acknowledgements and status emails (ticket+<token>@MAIL_REPLY_DOMAIN).
      if (isTicketReplyAddress({ mailReplyDomain, toEmail: payload.toEmail })) {
        response.status(201).json(await forwardTicketMailReply({
          inboundMailWebhookSecret,
          input: payload,
          liveEventBus,
          mailReplyDomain,
          projectRepository,
          requestSecret: request.get('x-inbound-mail-secret') ?? '',
        }));
        return;
      }
      const result = await ingestClarificationMailReply({
        assistantAiService,
        assistantRepository,
        inboundMailWebhookSecret,
        input: payload,
        liveEventBus,
        mailReplyDomain,
        mentionsRepository,
        projectRepository,
        requestSecret: request.get('x-inbound-mail-secret') ?? '',
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
