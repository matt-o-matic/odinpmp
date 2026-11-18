import { Router } from 'express';

import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  analyzeProjectSchema,
  enhanceRichTextSchema,
  enhanceDescriptionSchema,
  generateStoriesSchema,
  generateStructureSchema,
  generateTasksSchema,
} from './projects-ai.schema.js';
import {
  analyzeProjectForUser,
  enhanceProjectDescriptionForUser,
  enhanceRichTextForUser,
  generateProjectStructureForUser,
  generateProjectStoriesForUser,
  generateProjectTasksForUser,
} from './projects-ai.service.js';
import {
  projectAssistantBriefWriteSchema,
  projectArchiveImportSchema,
  projectArchiveInspectSchema,
  projectPermissionsWriteSchema,
  projectItemCreateSchema,
  projectItemDeleteSchema,
  projectItemRestoreSchema,
  projectItemRevisionQuerySchema,
  ticketIntakeInvitationCreateSchema,
  ticketListQuerySchema,
  ticketReviewDecisionSchema,
  ticketReviewQueueQuerySchema,
  ticketsAwaitingReviewQuerySchema,
  workItemRelationCreateSchema,
  projectItemUpdateSchema,
  projectTreeSchema,
  projectUpdateSchema,
  projectCreateSchema,
  projectAssistantBriefPatchSchema,
} from './projects.schema.js';
import {
  kanbanBoardQuerySchema,
  kanbanConfigWriteSchema,
  kanbanReorderSchema,
  kanbanScopeQuerySchema,
  sprintAssignmentsWriteSchema,
  sprintStaffingWriteSchema,
  sprintWriteSchema,
  storySplitSchema,
} from './projects.schema.js';
import {
  activateProjectSprintForUser,
  assignSprintItemsForUser,
  completeProjectSprintForUser,
  createProjectSprintForUser,
  exportProjectArchiveForUser,
  getProjectKanbanBoardForUser,
  getProjectKanbanConfigForUser,
  createProjectForUser,
  createProjectItemForUser,
  deleteProjectItemForUser,
  getProjectForUser,
  importProjectArchiveForUser,
  inspectProjectArchiveForUser,
  listProjectSprintsForUser,
  createTicketIntakeInvitationForUser,
  createWorkItemRelationForUser,
  decideTicketReviewForUser,
  deleteWorkItemRelationForUser,
  listProjectItemRevisionsForUser,
  listProjectTicketsForUser,
  listTicketReviewQueueForUser,
  listTicketsAwaitingReviewForUser,
  listTicketIntakeInvitationsForUser,
  listTicketsForUser,
  revokeTicketIntakeInvitationForUser,
  listWorkItemRelationsForUser,
  listProjectWorkItemRelationsForUser,
  getProjectValidUsersForUser,
  reorderProjectKanbanItemForUser,
  saveProjectKanbanConfigForUser,
  listProjectsForUser,
  saveSprintStaffingForUser,
  saveProjectTreeForUser,
  saveProjectPermissionsForUser,
  splitProjectStoryForUser,
  restoreProjectItemForUser,
  updateProjectAssistantBriefForUser,
  updateProjectSprintForUser,
  updateProjectForUser,
  updateProjectItemForUser,
} from './projects.service.js';
import { createTicketReporterNotifier } from './ticket-intake-mail.js';
import { createTicketReviewClassifier } from './ticket-review-classifier.js';
import { deleteProjectForUser, listDeletedProjectsForUser, restoreProjectForUser } from './project-deletion.service.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { PURSUIT_READS } from '../../lib/projects/pursuit.js';
import { CHANNEL_TYPING_EVENT, isOwnTyping } from '../channels/channel-events.js';

function openEventStream(response) {
  response.status(200);
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.flushHeaders?.();
}

function writeSseEvent(response, type, data = {}) {
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createProjectsRouter({
  agentModelResolver = null,
  assistantAgent = {},
  authRepository,
  assistantRepository,
  complianceRepository,
  frontendAppUrl = '',
  liveEventBus,
  mailReplyDomain = '',
  mailRepository = null,
  metricsRepository = null,
  projectAiService,
  projectRepository,
  ticketReviewClassifier = null,
  ticketReviewSettleMs = undefined,
  tokenService,
  workflowRepository = null,
  workspaceModulesRepository = null,
}) {
  const router = Router();
  // The workspace's own OpenAI key, with the assistant's Decisions settings.
  const reviewClassifier = ticketReviewClassifier ?? createTicketReviewClassifier({
    enabled: assistantAgent?.decisionsEnabled,
    model: assistantAgent?.decisionsModel,
    modelResolver: agentModelResolver,
    timeoutMs: assistantAgent?.decisionsTimeoutMs,
  });
  const requireAuth = createAuthMiddleware({ authRepository, tokenService, allowMcp: true });
  const intakeLinks = { frontendAppUrl, mailRepository };
  const notifyTicketStatusChange = createTicketReporterNotifier({ frontendAppUrl, mailReplyDomain, mailRepository, projectRepository });

  router.use(requireAuth);

  router.get('/', async (request, response, next) => {
    try {
      // ?include=engagements adds engagements, when the workspace has the Consulting module on.
      const includeEngagements = request.query.include === 'engagements'
        && await isModuleEnabled(workspaceModulesRepository, request.auth.user.memberships?.[0]?.tenantId, CONSULTING_MODULE);
      const result = await listProjectsForUser(request.auth.user, projectRepository, { includeEngagements });
      if (request.auth.mcpGrant?.projectIds.length) result.projects = result.projects.filter(project => request.auth.mcpGrant.projectIds.includes(project.id));
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    try {
      const payload = projectCreateSchema.parse(request.body);
      const result = await createProjectForUser(request.auth.user, payload, projectRepository, workflowRepository);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/import/inspect', async (request, response, next) => {
    try {
      const payload = projectArchiveInspectSchema.parse(request.body);
      const result = await inspectProjectArchiveForUser(request.auth.user, payload, projectRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/import', async (request, response, next) => {
    try {
      const payload = projectArchiveImportSchema.parse(request.body);
      const result = await importProjectArchiveForUser(
        request.auth.user,
        payload,
        projectRepository,
        assistantRepository,
        complianceRepository,
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  // Registered before '/:projectId' so literal paths are not captured as project ids.
  router.get('/tickets', async (request, response, next) => {
    try {
      const query = ticketListQuerySchema.parse(request.query);
      response.status(200).json(await listTicketsForUser(request.auth.user, query, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.get('/ticket-review-queue', async (request, response, next) => {
    try {
      const query = ticketReviewQueueQuerySchema.parse(request.query);
      response.status(200).json(await listTicketReviewQueueForUser(request.auth.user, query, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.get('/deleted', async (request, response, next) => {
    try {
      if (request.auth.mcpGrant) throw new HttpError(404, 'Project not found.');
      response.status(200).json(await listDeletedProjectsForUser(request.auth.user, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId', async (request, response, next) => {
    try {
      // ?pursuit=auto|include also shows pursuit work (PURSUIT_READS); screens send neither.
      const pursuit = PURSUIT_READS.includes(request.query.pursuit) ? request.query.pursuit : 'none';
      const result = await getProjectForUser(request.auth.user, request.params.projectId, projectRepository, assistantRepository, { pursuit });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/export', async (request, response, next) => {
    try {
      const result = await exportProjectArchiveForUser(
        request.auth.user,
        request.params.projectId,
        projectRepository,
        assistantRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/events', async (request, response, next) => {
    try {
      await getProjectForUser(request.auth.user, request.params.projectId, projectRepository);

      openEventStream(response);
      writeSseEvent(response, 'connected', {
        projectId: request.params.projectId,
      });

      // Members read every channel of a project they read (channels.service.js), so channel
      // events, typing among them, go to everyone here. A person never hears their own typing.
      const viewer = { id: request.auth.user.id, type: 'user' };
      const unsubscribe = liveEventBus?.subscribe(
        LIVE_EVENT_CHANNELS.project(request.params.projectId),
        (event) => {
          if (event?.type === CHANNEL_TYPING_EVENT && isOwnTyping(event, viewer)) return;
          writeSseEvent(response, event.type ?? 'project.assets.invalidated', event);
        },
      ) ?? (() => {});
      const heartbeat = setInterval(() => {
        writeSseEvent(response, 'heartbeat', { projectId: request.params.projectId });
      }, 25000);

      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/tree', async (request, response, next) => {
    try {
      const payload = projectTreeSchema.parse(request.body);
      const result = await saveProjectTreeForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        workflowRepository,
        metricsRepository,
      );
      response.locals.audit = {
        after: { projectVersion: result.project.updatedAt },
        before: { projectVersion: payload.expectedUpdatedAt },
        dataClassification: 'confidential-project-metadata',
      };
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/items', async (request, response, next) => {
    try {
      const payload = projectItemCreateSchema.parse(request.body);
      const result = await createProjectItemForUser(request.auth.user, request.params.projectId, payload, projectRepository, workflowRepository);
      response.locals.audit = { after: { itemVersion: result.item.version, projectVersion: result.project.updatedAt }, dataClassification: 'confidential-project-metadata' };
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.patch('/:projectId/items/:itemId', async (request, response, next) => {
    try {
      const payload = projectItemUpdateSchema.parse(request.body);
      const result = await updateProjectItemForUser(request.auth.user, request.params.projectId, request.params.itemId, payload, projectRepository, workflowRepository, notifyTicketStatusChange, metricsRepository);
      response.locals.audit = { after: { itemVersion: result.item.version, projectVersion: result.project.updatedAt }, before: { itemVersion: payload.expectedVersion }, dataClassification: 'confidential-project-metadata' };
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.delete('/:projectId/items/:itemId', async (request, response, next) => {
    try {
      const payload = projectItemDeleteSchema.parse(request.body);
      const result = await deleteProjectItemForUser(request.auth.user, request.params.projectId, request.params.itemId, payload, projectRepository, workflowRepository, complianceRepository);
      response.locals.audit = { after: { itemVersion: result.revision.versionAfter, projectVersion: result.project.updatedAt }, before: { itemVersion: payload.expectedVersion }, dataClassification: 'confidential-project-metadata' };
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.get('/:projectId/tickets', async (request, response, next) => {
    try {
      const query = ticketListQuerySchema.parse(request.query);
      response.status(200).json(await listProjectTicketsForUser(request.auth.user, request.params.projectId, query, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  // Pending external tickets for agents' triage: metadata and an automated check, no content.
  router.get('/:projectId/tickets/awaiting-review', async (request, response, next) => {
    try {
      const query = ticketsAwaitingReviewQuerySchema.parse(request.query);
      response.status(200).json(await listTicketsAwaitingReviewForUser(request.auth.user, request.params.projectId, query, projectRepository, reviewClassifier));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/relations', async (request, response, next) => {
    try {
      response.status(200).json(await listProjectWorkItemRelationsForUser(request.auth.user, request.params.projectId, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/items/:itemId/relations', async (request, response, next) => {
    try {
      response.status(200).json(await listWorkItemRelationsForUser(request.auth.user, request.params.projectId, request.params.itemId, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/items/:itemId/relations', async (request, response, next) => {
    try {
      const payload = workItemRelationCreateSchema.parse(request.body);
      const result = await createWorkItemRelationForUser(request.auth.user, request.params.projectId, request.params.itemId, payload, projectRepository);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:projectId/relations/:relationId', async (request, response, next) => {
    try {
      response.status(200).json(await deleteWorkItemRelationForUser(request.auth.user, request.params.projectId, request.params.relationId, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/ticket-intake-invitations', async (request, response, next) => {
    try {
      response.status(200).json(await listTicketIntakeInvitationsForUser(request.auth.user, request.params.projectId, projectRepository, intakeLinks));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ticket-intake-invitations', async (request, response, next) => {
    try {
      const payload = ticketIntakeInvitationCreateSchema.parse(request.body);
      const result = await createTicketIntakeInvitationForUser(request.auth.user, request.params.projectId, payload, projectRepository, intakeLinks);
      response.locals.audit = { after: { invitationId: result.invitation.id }, dataClassification: 'confidential-project-metadata' };
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:projectId/ticket-intake-invitations/:invitationId', async (request, response, next) => {
    try {
      response.status(200).json(await revokeTicketIntakeInvitationForUser(request.auth.user, request.params.projectId, request.params.invitationId, projectRepository));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/items/:itemId/review', async (request, response, next) => {
    try {
      const { agentCheck, ...payload } = ticketReviewDecisionSchema.parse(request.body);
      // An MCP credential is always an agent, whatever its body says.
      const review = { agentCheck: agentCheck === true || request.auth.credentialSource === 'mcp', classifier: reviewClassifier, ...(ticketReviewSettleMs === undefined ? {} : { settleMs: ticketReviewSettleMs }) };
      const result = await decideTicketReviewForUser(request.auth.user, request.params.projectId, request.params.itemId, payload, projectRepository, workflowRepository, review);
      response.locals.audit = { after: { externalReviewState: payload.state, itemVersion: result.item.version }, dataClassification: 'confidential-project-metadata' };
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/items/:itemId/revisions', async (request, response, next) => {
    try {
      const query = projectItemRevisionQuerySchema.parse(request.query);
      response.status(200).json(await listProjectItemRevisionsForUser(request.auth.user, request.params.projectId, request.params.itemId, query, projectRepository));
    } catch (error) { next(error); }
  });

  router.post('/:projectId/items/:itemId/restore', async (request, response, next) => {
    try {
      const payload = projectItemRestoreSchema.parse(request.body);
      const result = await restoreProjectItemForUser(request.auth.user, request.params.projectId, request.params.itemId, payload, projectRepository, workflowRepository, notifyTicketStatusChange, metricsRepository);
      response.locals.audit = { after: { itemVersion: result.item.version, projectVersion: result.project.updatedAt }, before: { itemVersion: payload.expectedVersion }, dataClassification: 'confidential-project-metadata' };
      response.status(200).json(result);
    } catch (error) { next(error); }
  });

  router.delete('/:projectId', async (request, response, next) => {
    try {
      const result = await deleteProjectForUser(request.auth.user, request.params.projectId, { complianceRepository, repository: projectRepository });
      response.locals.audit = {
        after: { deleted: true, deletedAt: result.project.deletedAt, projectName: result.project.name },
        before: { deleted: false },
        dataClassification: 'confidential-project-metadata',
      };
      response.locals.projectEventReason = 'project-deleted';
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/restore', async (request, response, next) => {
    try {
      const result = await restoreProjectForUser(request.auth.user, request.params.projectId, projectRepository);
      response.locals.audit = {
        after: { deleted: false, projectName: result.project.name },
        before: { deleted: true },
        dataClassification: 'confidential-project-metadata',
      };
      response.locals.projectEventReason = 'project-restored';
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId', async (request, response, next) => {
    try {
      const payload = projectUpdateSchema.parse(request.body);
      const result = await updateProjectForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        workflowRepository,
      );
      response.locals.audit = {
        after: { projectVersion: result.project.updatedAt },
        before: { projectVersion: payload.expectedUpdatedAt },
        dataClassification: 'confidential-project-metadata',
      };
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:projectId/assistant-brief', async (request, response, next) => {
    try {
      const payload = projectAssistantBriefPatchSchema.parse(request.body);
      const result = await updateProjectAssistantBriefForUser(
        request.auth.user, request.params.projectId, payload, projectRepository, assistantRepository,
      );
      response.locals.audit = {
        after: { briefVersion: result.project.assistantState.updatedAt },
        before: { briefVersion: payload.expectedUpdatedAt },
        dataClassification: 'confidential-project-brief',
      };
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/assistant-brief', async (request, response, next) => {
    try {
      const payload = projectAssistantBriefWriteSchema.parse(request.body);
      const result = await updateProjectAssistantBriefForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        assistantRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/valid-users', async (request, response, next) => {
    try {
      const result = await getProjectValidUsersForUser(
        request.auth.user,
        request.params.projectId,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/sprints', async (request, response, next) => {
    try {
      const result = await listProjectSprintsForUser(
        request.auth.user,
        request.params.projectId,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/sprints', async (request, response, next) => {
    try {
      const payload = sprintWriteSchema.parse(request.body);
      const result = await createProjectSprintForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/sprints/:sprintId', async (request, response, next) => {
    try {
      const payload = sprintWriteSchema.parse(request.body);
      const result = await updateProjectSprintForUser(
        request.auth.user,
        request.params.projectId,
        request.params.sprintId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/sprints/:sprintId/activate', async (request, response, next) => {
    try {
      const result = await activateProjectSprintForUser(
        request.auth.user,
        request.params.projectId,
        request.params.sprintId,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/sprints/:sprintId/complete', async (request, response, next) => {
    try {
      const result = await completeProjectSprintForUser(
        request.auth.user,
        request.params.projectId,
        request.params.sprintId,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/sprints/:sprintId/staffing', async (request, response, next) => {
    try {
      const payload = sprintStaffingWriteSchema.parse(request.body);
      const result = await saveSprintStaffingForUser(
        request.auth.user,
        request.params.projectId,
        request.params.sprintId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/sprints/assign-items', async (request, response, next) => {
    try {
      const payload = sprintAssignmentsWriteSchema.parse(request.body);
      const result = await assignSprintItemsForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/stories/:storyId/split', async (request, response, next) => {
    try {
      const payload = storySplitSchema.parse(request.body);
      const result = await splitProjectStoryForUser(
        request.auth.user,
        request.params.projectId,
        request.params.storyId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/kanban/config', async (request, response, next) => {
    try {
      const result = await getProjectKanbanConfigForUser(
        request.auth.user,
        request.params.projectId,
        projectRepository,
        kanbanScopeQuerySchema.parse(request.query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/kanban/config', async (request, response, next) => {
    try {
      const payload = kanbanConfigWriteSchema.parse(request.body);
      const result = await saveProjectKanbanConfigForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        kanbanScopeQuerySchema.parse(request.query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/kanban/reorder', async (request, response, next) => {
    try {
      const payload = kanbanReorderSchema.parse(request.body);
      const result = await reorderProjectKanbanItemForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        kanbanScopeQuerySchema.parse(request.query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:projectId/kanban', async (request, response, next) => {
    try {
      const query = kanbanBoardQuerySchema.parse(request.query);
      const result = await getProjectKanbanBoardForUser(
        request.auth.user,
        request.params.projectId,
        query,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:projectId/permissions', async (request, response, next) => {
    try {
      const payload = projectPermissionsWriteSchema.parse(request.body);
      const result = await saveProjectPermissionsForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ai/enhance-description', async (request, response, next) => {
    try {
      const payload = enhanceDescriptionSchema.parse(request.body);
      const result = await enhanceProjectDescriptionForUser({
        input: payload,
        projectAiService,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ai/analyze', async (request, response, next) => {
    try {
      const payload = analyzeProjectSchema.parse(request.body);
      const result = await analyzeProjectForUser({
        input: payload,
        projectAiService,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ai/generate-structure', async (request, response, next) => {
    try {
      const payload = generateStructureSchema.parse(request.body);
      const result = await generateProjectStructureForUser({
        input: payload,
        projectAiService,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ai/generate-stories', async (request, response, next) => {
    try {
      const payload = generateStoriesSchema.parse(request.body);
      const result = await generateProjectStoriesForUser({
        input: payload,
        projectAiService,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ai/generate-tasks', async (request, response, next) => {
    try {
      const payload = generateTasksSchema.parse(request.body);
      const result = await generateProjectTasksForUser({
        input: payload,
        projectAiService,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:projectId/ai/enhance-content', async (request, response, next) => {
    try {
      const payload = enhanceRichTextSchema.parse(request.body);
      const result = await enhanceRichTextForUser({
        input: payload,
        projectAiService,
        projectId: request.params.projectId,
        projectRepository,
        user: request.auth.user,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
