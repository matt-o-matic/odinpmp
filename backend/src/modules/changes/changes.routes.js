import { Router } from 'express';
import { z } from 'zod';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { createTicketReporterNotifier } from '../projects/ticket-intake-mail.js';
import { getProjectChangesForUser } from './changes.service.js';
import { itemChangesSchema } from './changes.schema.js';
import { applyItemChangesForUser } from './item-changes.service.js';
import { getItemDetailsForUser, MAX_DETAIL_ITEMS } from './item-details.service.js';

// Tools for agents that keep a project in step with the world outside Odin
// (docs/mcp-change-feed/plan.md): what changed since a cursor, details for chosen items, and a
// batch of checked changes.
const changesQuerySchema = z.object({
  cursor: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
}).strict();

const list = (max, length) => z.string().trim().max(max).optional()
  .transform((value) => (value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : []))
  .refine((values) => values.length <= MAX_DETAIL_ITEMS && values.every((entry) => entry.length <= length), `At most ${MAX_DETAIL_ITEMS} values.`);
const itemDetailsQuerySchema = z.object({
  commentLimit: z.coerce.number().int().min(1).max(100).optional(),
  continue: list(MAX_DETAIL_ITEMS * 640, 620),
  historyLimit: z.coerce.number().int().min(1).max(100).optional(),
  ids: list(MAX_DETAIL_ITEMS * 130, 120),
}).strict();

export function createChangesRouter(deps) {
  const router = Router();
  const serviceDeps = {
    ...deps,
    notifyTicketStatusChange: createTicketReporterNotifier({ frontendAppUrl: deps.frontendAppUrl ?? '', mailReplyDomain: deps.mailReplyDomain ?? '', mailRepository: deps.mailRepository ?? null, projectRepository: deps.projectRepository }),
  };
  const auth = createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService });
  router.use(['/:projectId/changes', '/:projectId/item-details', '/:projectId/item-changes'], auth);
  router.get('/:projectId/changes', async (request, response, next) => {
    try {
      response.json(await getProjectChangesForUser(serviceDeps, { input: changesQuerySchema.parse(request.query), projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.get('/:projectId/item-details', async (request, response, next) => {
    try {
      const { continue: tokens, ids, ...limits } = itemDetailsQuerySchema.parse(request.query);
      response.json(await getItemDetailsForUser(serviceDeps, { input: { ...limits, continue: tokens, itemIds: ids }, projectId: request.params.projectId, user: request.auth.user }));
    } catch (error) { next(error); }
  });
  router.post('/:projectId/item-changes', async (request, response, next) => {
    try {
      const result = await applyItemChangesForUser(serviceDeps, { input: itemChangesSchema.parse(request.body ?? {}), projectId: request.params.projectId, user: request.auth.user });
      response.locals.audit = { after: { applied: result.applied, results: result.results.map(({ idempotencyKey, itemId, status }) => ({ idempotencyKey, itemId, status })) }, dataClassification: 'confidential-project-metadata' };
      response.json(result);
    } catch (error) { next(error); }
  });
  return router;
}
