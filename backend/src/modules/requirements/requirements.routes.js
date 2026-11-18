import { Router } from 'express';

import { createRequireDecisionRights } from '../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { getRequestIp } from '../../lib/http/request-meta.js';
import { createPackagesRouter } from './packages/packages.routes.js';
import { getAgentBriefForUser } from './requirements-agent-brief.js';
import { bulkTopicActionForUser } from './requirements-bulk.js';
import { createPlansRouter } from './plans/plans.routes.js';
import { hashAccessToken } from './requirements-access-links.js';
import {
  createPortalCommentForToken,
  listPortalTopicMentionablesForToken,
  deletePortalCommentForToken,
  getPortalForToken,
  getPortalTopicForToken,
  requestNewLinkForToken,
  resolvePortalAccess,
  updatePortalCommentForToken,
  votePortalCommentForToken,
} from './requirements-portal.service.js';
import { createRequirementsPublicRateLimiter } from './requirements-rate-limit.js';
import { createPortalRoundsRouter } from './rounds/rounds.routes.js';
import { createPortalSigningRouter } from '../signing/signing.routes.js';
import {
  accessLinkCreateSchema,
  accessLinkExtendSchema,
  decisionCreateSchema,
  decisionListQuerySchema,
  decisionPatchSchema,
  preferenceAcceptSchema,
  topicCommentSchema,
  topicCommentUpdateSchema,
  topicCommentVoteSchema,
  topicCreateSchema,
  topicBulkSchema,
  topicListQuerySchema,
  topicMoveSchema,
  topicPatchSchema,
  trackSchema,
} from './requirements.schema.js';
import {
  acceptPreferenceForUser,
  createAccessLinkForUser,
  createTopicCommentForUser,
  listTopicMentionablesForUser,
  createTrackTopicForUser,
  deleteTopicCommentForUser,
  deleteTopicForUser,
  moveTopicForUser,
  draftQuestionsFromBriefForUser,
  extendAccessLinkForUser,
  getMyItemsForUser,
  getRequirementsOverviewForUser,
  getTopicForUser,
  listAccessLinksForUser,
  listProjectSignalsForUser,
  listTrackDecisionsForUser,
  listTrackPreferencesForUser,
  listTopicSummaryHistoryForUser,
  listTrackTopicsForUser,
  recordDecisionForUser,
  refreshTopicSummaryForUser,
  revokeAccessLinkForUser,
  updateDecisionForUser,
  updateTopicCommentForUser,
  updateTopicForUser,
  voteTopicCommentForUser,
} from './requirements.service.js';

// Round routes in the portal (a guided review saves often) get larger buckets than topics.
const REVIEW_RATE_LIMITS = Object.freeze({
  ip: { capacity: 600, refillPerSecond: 10 },
  link: { capacity: 300, refillPerSecond: 5 },
  writeCost: 2,
});

/** The deps object every requirements service function takes, built from the app's deps. */
export function requirementsServiceDeps(deps) {
  return {
    assistantRepository: deps.assistantRepository,
    authRepository: deps.authRepository,
    clock: deps.requirementsClock,
    frontendAppUrl: deps.frontendAppUrl,
    liveEventBus: deps.liveEventBus,
    mailReplyDomain: deps.mailReplyDomain,
    mailRepository: deps.mailRepository,
    mentionsRepository: deps.mentionsRepository ?? null,
    projectRepository: deps.projectRepository,
    requirementsAiService: deps.requirementsAiService ?? null,
    requirementsRepository: deps.requirementsRepository,
    requirementsSummaries: deps.requirementsSummaries ?? null,
    // Topic delete checks for review answers.
    roundsRepository: deps.roundsRepository ?? null,
    workspaceModulesRepository: deps.workspaceModulesRepository ?? null,
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

function trackParam(request) {
  const parsed = trackSchema.safeParse(request.params.track);
  if (!parsed.success) throw new HttpError(404, 'Track not found.');
  return parsed.data;
}

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

/**
 * Cross-project reads for the projects list, mounted at /api/requirements. Signed-in users
 * only; MCP grants do not reach these routes.
 */
export function createRequirementsSignalsRouter(deps) {
  const router = Router();
  const svc = requirementsServiceDeps(deps);
  router.use(createAuthMiddleware({ authRepository: deps.authRepository, tokenService: deps.tokenService }));
  router.get('/project-signals', handle((request) => listProjectSignalsForUser(svc, { user: request.auth.user })));
  return router;
}

/**
 * Team routes, mounted at /api/projects/:projectId/requirements. Capability checks run
 * before body validation so viewers get the same 404 on every write.
 */
export function createRequirementsRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = requirementsServiceDeps(deps);
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
  const canCollaborate = requireCapability(PROJECT_CAPABILITIES.COLLABORATE);
  const canDecide = createRequireDecisionRights({ projectRepository: deps.projectRepository });

  // MCP credentials pass through to backend/src/mcp/route-access.js, which admits only the
  // reads, upload-URL request, topic administration, topic decisions and emailed stakeholder
  // links the MCP tools use.
  router.use(createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }));
  router.use('/packages', createPackagesRouter(deps));
  if (deps.plansRepository) router.use('/plans', createPlansRouter(deps));

  router.get('/', canRead, handle((request) => getRequirementsOverviewForUser(svc, { projectId: projectId(request), user: user(request) })));
  router.get('/my-items', canRead, handle((request) => getMyItemsForUser(svc, { projectId: projectId(request), user: user(request) })));

  router.get('/tracks/:track/topics', canRead, handle((request) => listTrackTopicsForUser(svc, {
    projectId: projectId(request),
    query: topicListQuerySchema.parse(request.query ?? {}),
    track: trackParam(request),
    user: user(request),
  })));
  router.post('/tracks/:track/topics', canCollaborate, handle((request) => createTrackTopicForUser(svc, {
    input: topicCreateSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    track: trackParam(request),
    user: user(request),
  }), 201));
  router.post('/tracks/:track/draft-questions', canCollaborate, handle((request) => draftQuestionsFromBriefForUser(svc, {
    projectId: projectId(request),
    track: trackParam(request),
    user: user(request),
  }), 201));
  router.get('/review/agent-brief', canRead, handle((request) => getAgentBriefForUser(
    { ...svc, packagesRepository: deps.packagesRepository, roundsRepository: deps.roundsRepository },
    { projectId: projectId(request), user: user(request) },
  )));
  // Older Review stage links named a track; the brief is project-wide either way.
  router.get('/tracks/:track/agent-brief', canRead, handle((request) => getAgentBriefForUser(
    { ...svc, packagesRepository: deps.packagesRepository, roundsRepository: deps.roundsRepository },
    { projectId: projectId(request), track: trackParam(request), user: user(request) },
  )));
  router.get('/tracks/:track/decisions', canRead, handle((request) => listTrackDecisionsForUser(svc, {
    kind: decisionListQuerySchema.parse(request.query ?? {}).kind ?? '',
    projectId: projectId(request),
    track: trackParam(request),
    user: user(request),
  })));
  router.get('/tracks/:track/preferences', canRead, handle((request) => listTrackPreferencesForUser(svc, {
    projectId: projectId(request),
    track: trackParam(request),
    user: user(request),
  })));

  router.post('/topics/bulk', canCollaborate, handle((request) => bulkTopicActionForUser(svc, {
    input: topicBulkSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    user: user(request),
  })));
  router.get('/topics/:topicId', canRead, handle((request) => getTopicForUser(svc, {
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.patch('/topics/:topicId', canCollaborate, handle((request) => updateTopicForUser(svc, {
    input: topicPatchSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.delete('/topics/:topicId', canCollaborate, handle((request) => deleteTopicForUser(svc, {
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.post('/topics/:topicId/move', canCollaborate, handle((request) => moveTopicForUser(svc, {
    projectId: projectId(request),
    topicId: request.params.topicId,
    track: topicMoveSchema.parse(request.body ?? {}).track,
    user: user(request),
  })));
  router.get('/topics/:topicId/mentionables', canCollaborate, handle((request) => listTopicMentionablesForUser(svc, {
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.post('/topics/:topicId/comments', canCollaborate, handle((request) => createTopicCommentForUser(svc, {
    input: topicCommentSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  }), 201));
  router.patch('/topics/:topicId/comments/:commentId', canCollaborate, handle((request) => updateTopicCommentForUser(svc, {
    commentId: request.params.commentId,
    input: topicCommentUpdateSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.delete('/topics/:topicId/comments/:commentId', canCollaborate, handle((request) => deleteTopicCommentForUser(svc, {
    commentId: request.params.commentId,
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.post('/topics/:topicId/comments/:commentId/vote', canCollaborate, handle((request) => voteTopicCommentForUser(svc, {
    commentId: request.params.commentId,
    input: topicCommentVoteSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.post('/topics/:topicId/summary/refresh', canCollaborate, handle((request) => refreshTopicSummaryForUser(svc, {
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));
  router.get('/topics/:topicId/summary/history', canRead, handle((request) => listTopicSummaryHistoryForUser(svc, {
    limit: Math.max(1, Math.min(200, Number.parseInt(String(request.query?.limit ?? '50'), 10) || 50)),
    projectId: projectId(request),
    topicId: request.params.topicId,
    user: user(request),
  })));

  router.post('/decisions', canDecide, handle((request) => recordDecisionForUser(svc, {
    input: decisionCreateSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    user: user(request),
  }), 201));
  router.patch('/decisions/:decisionId', canDecide, handle((request) => updateDecisionForUser(svc, {
    decisionId: request.params.decisionId,
    input: decisionPatchSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    user: user(request),
  })));
  router.post('/preferences/accept', canDecide, handle((request) => acceptPreferenceForUser(svc, {
    input: preferenceAcceptSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    user: user(request),
  }), 201));

  router.get('/links', canDecide, handle((request) => listAccessLinksForUser(svc, { projectId: projectId(request), user: user(request) })));
  router.post('/links', canDecide, handle((request, response) => {
    // The response carries the only copy of the link token.
    response.setHeader('Cache-Control', 'no-store');
    return createAccessLinkForUser(svc, {
      input: accessLinkCreateSchema.parse(request.body ?? {}),
      projectId: projectId(request),
      user: user(request),
    });
  }, 201));
  router.post('/links/:linkId/revoke', canDecide, handle((request) => revokeAccessLinkForUser(svc, {
    linkId: request.params.linkId,
    projectId: projectId(request),
    user: user(request),
  })));
  router.post('/links/:linkId/extend', canDecide, handle((request) => extendAccessLinkForUser(svc, {
    input: accessLinkExtendSchema.parse(request.body ?? {}),
    linkId: request.params.linkId,
    projectId: projectId(request),
    user: user(request),
  })));

  return router;
}

/**
 * Client portal routes, mounted at /api/public/requirements. The link token in the
 * path is the only credential. There is deliberately no route that changes a topic's
 * status or records a decision.
 */
export function createPublicRequirementsRouter(deps) {
  const router = Router();
  const svc = requirementsServiceDeps(deps);
  const limiter = deps.requirementsRateLimiter ?? createRequirementsPublicRateLimiter();
  // A guided review saves often (verdict toggles, coalesced annotation edits), so round
  // routes get their own, larger buckets per link and per IP.
  const reviewLimiter = deps.requirementsReviewRateLimiter ?? createRequirementsPublicRateLimiter(REVIEW_RATE_LIMITS);

  router.use('/:token', (request, response, next) => {
    const active = /^\/rounds(?:\/|$)/.test(request.path) ? reviewLimiter : limiter;
    const result = active.check({
      ipAddress: getRequestIp(request),
      linkKey: hashAccessToken(request.params.token),
      write: !['GET', 'HEAD', 'OPTIONS'].includes(request.method),
    });
    response.setHeader('Cache-Control', 'no-store');
    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      response.status(429).json({
        details: { code: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds, scope: result.scope },
        error: 'rate_limited',
        ok: false,
      });
      return;
    }
    next();
  });

  const token = (request) => request.params.token;

  router.get('/:token', handle((request) => getPortalForToken(svc, { token: token(request) })));

  // "Request a new link" for an expired link. Rate-limited above, per link and per IP.
  router.post('/:token/link-request', async (request, response, next) => {
    try {
      const result = await requestNewLinkForToken(svc, { token: token(request) });
      response.status(result.alreadyRequested ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:token/events', async (request, response, next) => {
    try {
      const access = await resolvePortalAccess(svc, { token: token(request) });
      openEventStream(response);
      writeSseEvent(response, 'connected', { linkId: access.link.id });

      const unsubscribe = deps.liveEventBus?.subscribe(
        LIVE_EVENT_CHANNELS.publicRequirements(access.link.id),
        (event) => writeSseEvent(response, event.type ?? 'requirements.topics.invalidated', event),
      ) ?? (() => {});
      const heartbeat = setInterval(() => {
        writeSseEvent(response, 'heartbeat', { linkId: access.link.id });
      }, 25000);
      heartbeat.unref?.();

      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:token/topics/:topicId', handle((request) => getPortalTopicForToken(svc, {
    token: token(request),
    topicId: request.params.topicId,
  })));
  router.get('/:token/topics/:topicId/mentionables', handle((request) => listPortalTopicMentionablesForToken(svc, {
    token: token(request),
    topicId: request.params.topicId,
  })));
  router.post('/:token/topics/:topicId/comments', handle((request) => createPortalCommentForToken(svc, {
    input: topicCommentSchema.parse(request.body ?? {}),
    token: token(request),
    topicId: request.params.topicId,
  }), 201));
  router.patch('/:token/topics/:topicId/comments/:commentId', handle((request) => updatePortalCommentForToken(svc, {
    commentId: request.params.commentId,
    input: topicCommentUpdateSchema.parse(request.body ?? {}),
    token: token(request),
    topicId: request.params.topicId,
  })));
  router.delete('/:token/topics/:topicId/comments/:commentId', handle((request) => deletePortalCommentForToken(svc, {
    commentId: request.params.commentId,
    token: token(request),
    topicId: request.params.topicId,
  })));
  router.post('/:token/topics/:topicId/comments/:commentId/vote', handle((request) => votePortalCommentForToken(svc, {
    commentId: request.params.commentId,
    input: topicCommentVoteSchema.parse(request.body ?? {}),
    token: token(request),
    topicId: request.params.topicId,
  })));

  if (deps.roundsRepository) router.use('/:token/rounds', createPortalRoundsRouter(deps));
  // Shared documents and signature requests.
  if (deps.signingRepository) router.use('/:token', createPortalSigningRouter(deps));

  return router;
}
