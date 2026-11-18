import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';

import { createPublicClarificationMailRouter } from '../assistant/assistant.routes.js';
import { createPublicTicketMailRouter } from '../projects/ticket-intake.routes.js';
import { ingestBugReporterReply } from '../bug-reporter/bug-reporter.replies.js';
import { HttpError } from '../../lib/errors/http-error.js';

// A reply carries at most 10 MiB of attachments, which base64 grows by a third.
export const INBOUND_MAIL_BODY_LIMIT = 16 * 1024 * 1024;
const digest = value => createHash('sha256').update(String(value ?? '')).digest();
const text = max => z.string().max(max).nullish().transform(value => value ?? '');

const bugReporterReplySchema = z.object({
  attachments: z.array(z.object({
    contentBase64: z.string().max(INBOUND_MAIL_BODY_LIMIT),
    contentType: text(255),
    fileName: text(255),
  })).max(200).optional().default([]),
  autoReplyHeaders: z.object({ autoSubmitted: text(255), precedence: text(255), xAutoreply: text(255) }).partial().optional().default({}),
  fromEmail: z.string().trim().email().max(255),
  htmlBody: text(200_000),
  messageId: z.string().trim().min(1).max(255),
  textBody: text(200_000),
  toEmail: z.string().trim().email().max(255),
  verdicts: z.object({ spam: text(40), virus: text(40), spf: text(40), dkim: text(40), dmarc: text(40) }).partial().optional().default({}),
});

/**
 * Checks the shared secret before reading the body, so only the mail relay can send the
 * larger payload this route allows. Mount it ahead of the global JSON parser.
 */
export function createInboundMailBodyParser({ inboundMailWebhookSecret = '' } = {}) {
  const parse = express.json({ limit: INBOUND_MAIL_BODY_LIMIT });
  return (request, response, next) => {
    const expected = String(inboundMailWebhookSecret ?? '').trim();
    const supplied = String(request.get('x-inbound-mail-secret') ?? '').trim();
    if (!expected || !timingSafeEqual(digest(expected), digest(supplied))) return next(new HttpError(401, 'Invalid inbound mail secret.'));
    return parse(request, response, next);
  };
}

/**
 * The single webhook for reply.odinpmp.com. The address prefix picks the handler:
 * clarification+ and ticket+ go to their existing routes unchanged, bugreport+ to Bug Reporter.
 */
export function createInboundMailRouter(deps) {
  const router = Router();
  const clarification = createPublicClarificationMailRouter(deps);
  const ticket = createPublicTicketMailRouter({ inboundMailWebhookSecret: deps.inboundMailWebhookSecret, liveEventBus: deps.liveEventBus ?? null, mailReplyDomain: deps.mailReplyDomain, projectRepository: deps.projectRepository });
  const logger = deps.logger ?? console;

  router.post('/', async (request, response, next) => {
    try {
      const local = String(request.body?.toEmail ?? '').trim().toLowerCase().split('@')[0];
      if (local.startsWith('clarification+') || local.startsWith('ticket+')) {
        request.url = '/inbound';
        return (local.startsWith('ticket+') ? ticket : clarification)(request, response, next);
      }
      if (local.startsWith('bugreport+')) {
        const input = bugReporterReplySchema.parse(request.body ?? {});
        return response.status(202).json(await ingestBugReporterReply({
          input,
          assistantRepository: deps.assistantRepository,
          authRepository: deps.authRepository,
          emailReplies: deps.bugReporterEmailReplies === true,
          logger,
          mailReplyDomain: deps.mailReplyDomain,
          mailRepository: deps.mailRepository,
        }));
      }
      logger.warn?.('Inbound email dropped: the address has no known prefix.');
      return response.status(202).json({ ok: true, matched: false });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
