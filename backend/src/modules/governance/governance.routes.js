import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import {
  dependencyCreateSchema, dependencyUpdateSchema, governanceAgentViewQuerySchema, governanceItemCreateSchema, governanceItemUpdateSchema,
  milestoneCreateSchema, milestoneUpdateSchema, versionedDeleteSchema,
  scheduleBaselineCreateSchema, workingCalendarWriteSchema,
} from './governance.schema.js';
import { analyzeScheduleForUser, createScheduleBaselineForUser, getGovernanceForUser, mutateGovernanceForUser } from './governance.service.js';

export function createGovernanceRouter({ authRepository, governanceRepository, insightsRepository = null, projectRepository, tokenService }) {
  const router = Router();
  // This router also precedes comments. MCP clients reach only the governance routes listed in
  // mcp/access/workspace.js.
  router.use(createAuthMiddleware({ authRepository, tokenService, allowMcp: true }));
  // Agents get governance without the tickets they may not see: on agentView=1, and on every
  // MCP credential whether or not it asked. That covers what writes answer with, too.
  const agentViewOf = (request) => governanceAgentViewQuerySchema.parse(request.query).agentView === '1' || request.auth.credentialSource === 'mcp';
  const mutate = (operation, payload, request, domainEvent) => mutateGovernanceForUser({
    agentView: agentViewOf(request),
    domainEvent,
    domainEventOutboxRepository: request.app.locals.domainEventOutboxRepository,
    governanceRepository,
    insightsRepository,
    operation,
    payload,
    projectId: request.params.projectId,
    projectRepository,
    user: request.auth.user,
  });
  const mutateAndTrigger = async (operation, payload, request, { action, entityType }) => {
    const tenantId = request.auth.user?.memberships?.[0]?.tenantId ?? null;
    const domainEvent = tenantId ? {
      eventType: 'governance.changed',
      idempotencyKey: `governance:${request.id}`,
      payload: {
        action,
        entityId: request.params.itemId ?? request.params.dependencyId ?? request.params.milestoneId ?? null,
        entityType,
      },
    } : null;
    const result = await mutate(operation, payload, request, domainEvent);
    // Schedule dependencies join the project change log.
    if (entityType === 'dependency' && tenantId && projectRepository?.recordProjectChanges) {
      const record = result?.value ?? null;
      try {
        await projectRepository.recordProjectChanges([{
          action: { created: 'create', deleted: 'delete', updated: 'update' }[action] ?? action,
          actorId: request.auth.user.id,
          detail: record ? { dependencyType: record.dependencyType, lagDays: record.lagDays, predecessorId: record.predecessorId, successorId: record.successorId } : null,
          entityId: record?.id ?? request.params.dependencyId,
          entityType: 'dependency',
          itemId: record?.successorId ?? null,
          projectId: request.params.projectId,
          relatedItemId: record?.predecessorId ?? null,
          tenantId,
        }]);
      } catch (error) {
        logBackendError(error, { context: buildOperationLogContext('governance.recordProjectChange', { action, projectId: request.params.projectId, tenantId }) });
      }
    }
    if (tenantId && request.app.locals.dispatchDomainEvents) {
      try {
        await request.app.locals.dispatchDomainEvents();
      } catch (error) {
        logBackendError(error, { context: buildOperationLogContext('governance.dispatchDomainEvent', { action, entityType, projectId: request.params.projectId, tenantId }) });
      }
    }
    return result;
  };

  router.get('/:projectId/governance', async (request, response, next) => {
    try { response.json(await getGovernanceForUser({ agentView: agentViewOf(request), governanceRepository, insightsRepository, projectId: request.params.projectId, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.get('/:projectId/governance/schedule-analysis', async (request, response, next) => {
    try { response.json(await analyzeScheduleForUser({ agentView: agentViewOf(request), governanceRepository, insightsRepository, projectId: request.params.projectId, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.put('/:projectId/governance/working-calendar', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.putWorkingCalendar(args), { input: workingCalendarWriteSchema.parse(request.body) }, request, { action: 'updated', entityType: 'working_calendar' })); } catch (error) { next(error); }
  });
  router.post('/:projectId/governance/schedule-baselines', async (request, response, next) => {
    try {
      const tenantId = request.auth.user?.memberships?.[0]?.tenantId ?? null;
      const result = await createScheduleBaselineForUser({
        agentView: agentViewOf(request),
        domainEvent: tenantId ? {
          eventType: 'governance.changed',
          idempotencyKey: `schedule-baseline:${request.id}`,
          payload: { action: 'created', entityType: 'schedule_baseline' },
        } : null,
        domainEventOutboxRepository: request.app.locals.domainEventOutboxRepository,
        governanceRepository,
        input: scheduleBaselineCreateSchema.parse(request.body),
        insightsRepository,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      if (tenantId && request.app.locals.dispatchDomainEvents) {
        try {
          await request.app.locals.dispatchDomainEvents();
        } catch (error) {
          logBackendError(error, { context: buildOperationLogContext('governance.dispatchDomainEvent', { action: 'created', entityType: 'schedule_baseline', projectId: request.params.projectId, tenantId }) });
        }
      }
      response.status(201).json(result);
    } catch (error) { next(error); }
  });
  router.post('/:projectId/governance/items', async (request, response, next) => {
    try { response.status(201).json(await mutateAndTrigger((repo, args) => repo.createItem(args), { input: governanceItemCreateSchema.parse(request.body) }, request, { action: 'created', entityType: 'governance_item' })); } catch (error) { next(error); }
  });
  router.patch('/:projectId/governance/items/:itemId', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.updateItem(args), { input: governanceItemUpdateSchema.parse(request.body), itemId: request.params.itemId }, request, { action: 'updated', entityType: 'governance_item' })); } catch (error) { next(error); }
  });
  router.delete('/:projectId/governance/items/:itemId', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.deleteItem(args), { ...versionedDeleteSchema.parse(request.body), itemId: request.params.itemId }, request, { action: 'deleted', entityType: 'governance_item' })); } catch (error) { next(error); }
  });
  router.post('/:projectId/governance/dependencies', async (request, response, next) => {
    try { response.status(201).json(await mutateAndTrigger((repo, args) => repo.createDependency(args), { input: dependencyCreateSchema.parse(request.body) }, request, { action: 'created', entityType: 'dependency' })); } catch (error) { next(error); }
  });
  router.patch('/:projectId/governance/dependencies/:dependencyId', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.updateDependency(args), { dependencyId: request.params.dependencyId, input: dependencyUpdateSchema.parse(request.body) }, request, { action: 'updated', entityType: 'dependency' })); } catch (error) { next(error); }
  });
  router.delete('/:projectId/governance/dependencies/:dependencyId', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.deleteDependency(args), { ...versionedDeleteSchema.parse(request.body), dependencyId: request.params.dependencyId }, request, { action: 'deleted', entityType: 'dependency' })); } catch (error) { next(error); }
  });
  router.post('/:projectId/governance/milestones', async (request, response, next) => {
    try { response.status(201).json(await mutateAndTrigger((repo, args) => repo.createMilestone(args), { input: milestoneCreateSchema.parse(request.body) }, request, { action: 'created', entityType: 'milestone' })); } catch (error) { next(error); }
  });
  router.patch('/:projectId/governance/milestones/:milestoneId', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.updateMilestone(args), { input: milestoneUpdateSchema.parse(request.body), milestoneId: request.params.milestoneId }, request, { action: 'updated', entityType: 'milestone' })); } catch (error) { next(error); }
  });
  router.delete('/:projectId/governance/milestones/:milestoneId', async (request, response, next) => {
    try { response.json(await mutateAndTrigger((repo, args) => repo.deleteMilestone(args), { ...versionedDeleteSchema.parse(request.body), milestoneId: request.params.milestoneId }, request, { action: 'deleted', entityType: 'milestone' })); } catch (error) { next(error); }
  });
  return router;
}
