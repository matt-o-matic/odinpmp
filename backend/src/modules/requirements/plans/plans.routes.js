import { Router } from 'express';

import { createRequireDecisionRights } from '../../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { trackSchema } from '../requirements.schema.js';
import { planApproveSchema, planListQuerySchema, planPatchSchema } from './plans.schema.js';
import {
  approvePlanForUser,
  draftPlanForUser,
  getPlanForUser,
  listPlansForUser,
  proposeWorkForUser,
  updatePlanForUser,
} from './plans.service.js';

export function planServiceDeps(deps) {
  return {
    assistantRepository: deps.assistantRepository,
    agentChatService: deps.agentChatService,
    agentChatsRepository: deps.agentChatsRepository,
    clock: deps.requirementsClock,
    liveEventBus: deps.liveEventBus,
    plansRepository: deps.plansRepository,
    projectRepository: deps.projectRepository,
    requirementsAiService: deps.requirementsAiService ?? null,
    requirementsRepository: deps.requirementsRepository,
  };
}

function handle(run, status = 200) {
  return async (request, response, next) => {
    try {
      response.status(status).json(await run(request, response));
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Track plans, mounted at /api/projects/:projectId/requirements/plans after the
 * requirements router's auth middleware. Capability checks run before body validation so
 * callers without the capability get the same 404 on every write.
 */
export function createPlansRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = planServiceDeps(deps);
  const user = (request) => request.auth.user;
  const projectId = (request) => request.params.projectId;

  const requireCapability = (capability) => async (request, _response, next) => {
    try {
      await requireProjectCapability({
        capability,
        projectId: projectId(request),
        repository: deps.projectRepository,
        tenantId: request.auth.user?.memberships?.[0]?.tenantId ?? null,
        user: request.auth.user,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
  const canRead = requireCapability(PROJECT_CAPABILITIES.READ);
  const canEditPlan = requireCapability(PROJECT_CAPABILITIES.PLAN_EDIT);
  const canDecide = createRequireDecisionRights({ projectRepository: deps.projectRepository });

  router.get('/', canRead, handle((request) => listPlansForUser(svc, {
    projectId: projectId(request),
    track: planListQuerySchema.parse(request.query ?? {}).track ?? '',
    user: user(request),
  })));
  router.post('/:track/draft', canEditPlan, handle((request) => {
    const parsed = trackSchema.safeParse(request.params.track);
    if (!parsed.success) throw new HttpError(404, 'Track not found.');
    return draftPlanForUser(svc, { projectId: projectId(request), track: parsed.data, user: user(request) });
  }, 201));
  router.get('/:planId', canRead, handle((request) => getPlanForUser(svc, {
    planId: request.params.planId,
    projectId: projectId(request),
    user: user(request),
  })));
  router.patch('/:planId', canEditPlan, handle((request) => updatePlanForUser(svc, {
    input: planPatchSchema.parse(request.body ?? {}),
    planId: request.params.planId,
    projectId: projectId(request),
    user: user(request),
  })));
  router.post('/:planId/approve', canDecide, handle((request) => approvePlanForUser(svc, {
    input: planApproveSchema.parse(request.body ?? {}),
    planId: request.params.planId,
    projectId: projectId(request),
    user: user(request),
  })));
  router.post('/:planId/propose-work', canEditPlan, handle((request) => proposeWorkForUser(svc, {
    planId: request.params.planId,
    projectId: projectId(request),
    user: user(request),
  }), 201));

  return router;
}
