import { Router } from 'express';

import { inboundTicketMailSchema, publicTicketSubmissionSchema } from './projects.schema.js';
import {
  createIntakeRateLimiter,
  getPublicTicketIntakeContext,
  ingestTicketMailReply,
  submitPublicTicket,
} from './ticket-intake.service.js';
import { publishProjectChanged } from '../../lib/events/project-live-events.js';

/**
 * Inbound reply webhook. Mounted outside auth and guarded by the same
 * shared secret the clarification inbound path uses. The inbound-mail webhook routes ticket+
 * recipients here, and the older clarification webhook forwards them (forwardTicketMailReply).
 */
export function createPublicTicketMailRouter({ inboundMailWebhookSecret = '', liveEventBus = null, mailReplyDomain = '', projectRepository }) {
  const router = Router();

  router.post('/inbound', async (request, response, next) => {
    try {
      const payload = inboundTicketMailSchema.parse(request.body ?? {});
      response.status(201).json(await forwardTicketMailReply({
        inboundMailWebhookSecret,
        input: payload,
        liveEventBus,
        mailReplyDomain,
        projectRepository,
        requestSecret: request.get('x-inbound-mail-secret') ?? '',
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function forwardTicketMailReply({ inboundMailWebhookSecret, input, liveEventBus = null, mailReplyDomain, projectRepository, requestSecret }) {
  return ingestTicketMailReply({
    inboundMailWebhookSecret,
    input,
    mailReplyDomain,
    onProjectChanged: (projectId, details) => publishProjectChanged(liveEventBus, projectId, details),
    projectRepository,
    requestSecret,
  });
}

/**
 * Unauthenticated ticket intake. Mounted outside the auth middleware; the
 * project-scoped invite token is the only credential, and it is never echoed back.
 */
export function createPublicTicketIntakeRouter({
  frontendAppUrl = '',
  liveEventBus = null,
  mailReplyDomain = '',
  mailRepository = null,
  projectRepository,
  rateLimiter = null,
  ticketConfigRepository = null,
}) {
  const router = Router();
  const limiter = rateLimiter ?? createIntakeRateLimiter();

  router.get('/:intakeToken', async (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(await getPublicTicketIntakeContext({
        intakeToken: request.params.intakeToken,
        projectRepository,
        ticketConfigRepository,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:intakeToken', async (request, response, next) => {
    try {
      const payload = publicTicketSubmissionSchema.parse(request.body);
      response.status(201).json(await submitPublicTicket({
        frontendAppUrl,
        input: payload,
        intakeToken: request.params.intakeToken,
        mailReplyDomain,
        mailRepository,
        onProjectChanged: (projectId, details) => publishProjectChanged(liveEventBus, projectId, details),
        projectRepository,
        rateLimiter: limiter,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
