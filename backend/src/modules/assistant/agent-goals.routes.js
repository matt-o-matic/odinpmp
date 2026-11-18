import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { createAgentGoalSchema, updateAgentGoalNotificationSchema, updateAgentGoalSchema } from './agent-execution.schema.js';
import { createAgentMonitorSchema, updateAgentMonitorSchema } from './agent-execution.schema.js';
import { createAgentMonitorForUser, listAgentMonitorsForUser, updateAgentMonitorForUser } from './agent-monitors.service.js';
import {
  createAgentGoalForUser,
  getAgentGoalForUser,
  listAgentGoalNotificationsForUser,
  listAgentGoalsForUser,
  runAgentGoalForUser,
  updateAgentGoalForUser,
  updateAgentGoalNotificationForUser,
} from './agent-goals.service.js';
import { createProjectEventsFromResponseMiddleware } from '../../lib/events/project-live-events.js';

export function createAgentGoalsRouter({ assistantRepository, authRepository, agentExecutionRepository, liveEventBus, projectRepository, tokenService }) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));
  // Goal and monitor paths do not carry the project id, so read it from the result.
  router.use(createProjectEventsFromResponseMiddleware({
    liveEventBus,
    resolveProjectIds: (body) => [body?.goal?.projectId, body?.monitor?.projectId, body?.notification?.projectId, body?.run?.projectId],
  }));
  router.get('/', async (request, response, next) => {
    try { response.json(await listAgentGoalsForUser({ executionRepository: agentExecutionRepository, projectId: String(request.query.projectId ?? '').trim() || null, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.post('/', async (request, response, next) => {
    try { response.status(201).json(await createAgentGoalForUser({ executionRepository: agentExecutionRepository, input: createAgentGoalSchema.parse(request.body), projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.get('/:goalId', async (request, response, next) => {
    try { response.json(await getAgentGoalForUser({ executionRepository: agentExecutionRepository, goalId: request.params.goalId, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.patch('/:goalId', async (request, response, next) => {
    try { response.json(await updateAgentGoalForUser({ executionRepository: agentExecutionRepository, goalId: request.params.goalId, input: updateAgentGoalSchema.parse(request.body), projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.post('/:goalId/runs', async (request, response, next) => {
    try { response.status(202).json(await runAgentGoalForUser({ assistantRepository, executionRepository: agentExecutionRepository, goalId: request.params.goalId, input: request.body ?? {}, liveEventBus, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.get('/:goalId/monitors', async (request, response, next) => {
    try { response.json(await listAgentMonitorsForUser({ executionRepository: agentExecutionRepository, goalId: request.params.goalId, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.get('/:goalId/notifications', async (request, response, next) => {
    try { response.json(await listAgentGoalNotificationsForUser({ executionRepository: agentExecutionRepository, goalId: request.params.goalId, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.patch('/notifications/:notificationId', async (request, response, next) => {
    try { response.json(await updateAgentGoalNotificationForUser({ executionRepository: agentExecutionRepository, input: updateAgentGoalNotificationSchema.parse(request.body), notificationId: request.params.notificationId, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.post('/:goalId/monitors', async (request, response, next) => {
    try { response.status(201).json(await createAgentMonitorForUser({ assistantRepository, executionRepository: agentExecutionRepository, goalId: request.params.goalId, input: createAgentMonitorSchema.parse(request.body), liveEventBus, projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  router.patch('/monitors/:monitorId', async (request, response, next) => {
    try { response.json(await updateAgentMonitorForUser({ executionRepository: agentExecutionRepository, monitorId: request.params.monitorId, input: updateAgentMonitorSchema.parse(request.body), projectRepository, user: request.auth.user })); } catch (error) { next(error); }
  });
  return router;
}
