import express, { Router } from 'express';

import { createRequireDecisionRights } from '../../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { createAuthMiddleware } from '../../../lib/http/auth-middleware.js';
import {
  carryAnnotation,
  closeOutdatedAnnotation,
  createAnnotationComment,
  listAnnotationMentionables,
  deleteAnnotation,
  deleteAnnotationComment,
  deleteAnswer,
  deleteDirection,
  deleteVerdict,
  getReviewState,
  listPortalRounds,
  loadReviewContext,
  portalReviewActor,
  putAnswer,
  putDirection,
  putVerdict,
  readSnapshot,
  readSnapshotForReview,
  setAnnotationStatus,
  setPosition,
  submitReview,
  teamReviewActor,
  updateAnnotationComment,
  uploadSnapshot,
  upsertAnnotation,
} from './review.service.js';
import { MAX_SNAPSHOT_BYTES } from './round-snapshots.js';
import {
  annotationCommentSchema,
  annotationCommentUpdateSchema,
  annotationStatusSchema,
  annotationUpsertSchema,
  answerSchema,
  closeRoundSchema,
  directionStanceSchema,
  feedbackQuerySchema,
  patchRoundSchema,
  positionSchema,
  publishRoundSchema,
  roundListQuerySchema,
  screenVerdictSchema,
  snapshotQuerySchema,
  summaryRefreshSchema,
  uuidSchema,
} from './rounds.schema.js';
import {
  closeRoundForUser,
  getRoundAnnotationsForUser,
  getRoundFeedbackForUser,
  getRoundForUser,
  getRoundResultsForUser,
  listRoundsForUser,
  publishRoundForUser,
  refreshRoundSummaryForUser,
  requireRoundCapability,
  resendInvitationForUser,
  updateRoundForUser,
} from './rounds.service.js';

export function roundsServiceDeps(deps) {
  return {
    assistantRepository: deps.assistantRepository,
    backendPublicUrl: deps.backendPublicUrl ?? '',
    clock: deps.requirementsClock,
    frontendAppUrl: deps.frontendAppUrl,
    liveEventBus: deps.liveEventBus,
    mailRepository: deps.mailRepository,
    mentionsRepository: deps.mentionsRepository ?? null,
    packageStorage: deps.packageStorage,
    packagesRepository: deps.packagesRepository,
    projectRepository: deps.projectRepository,
    requirementsRepository: deps.requirementsRepository,
    requirementsSummaries: deps.requirementsSummaries ?? null,
    reviewGrantSecret: deps.reviewGrantSecret,
    reviewPublicUrl: deps.reviewPublicUrl,
    roundsRepository: deps.roundsRepository,
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

function annotationIdParam(request) {
  const parsed = uuidSchema.safeParse(request.params.annotationId);
  if (!parsed.success) throw new HttpError(400, 'Annotation ids are client-generated UUIDs.', { details: { code: 'annotation_id_invalid' } });
  return parsed.data.toLowerCase();
}

/** Raw PNG bodies with their own 10 MB limit; anything bigger is a 413 with a code. */
function rawPngBody() {
  const parse = express.raw({ limit: MAX_SNAPSHOT_BYTES, type: 'image/png' });
  return (request, response, next) => {
    if (!request.is('image/png')) {
      next(new HttpError(415, 'Send the snapshot as a raw image/png body.', { details: { code: 'snapshot_type' } }));
      return;
    }
    parse(request, response, (error) => {
      if (error?.type === 'entity.too.large' || error?.statusCode === 413) {
        // Answered here: the shared error handler turns every 413 into a generic message.
        response.status(413).json({
          details: { code: 'snapshot_too_large', limitBytes: MAX_SNAPSHOT_BYTES },
          error: 'Snapshots can be at most 10 MB.',
          ok: false,
        });
        return;
      }
      next(error);
    });
  };
}

function sendPng(response, { bytes, snapshot }) {
  response.status(200);
  response.setHeader('Content-Type', 'image/png');
  response.setHeader('Content-Length', String(bytes.length));
  response.setHeader('Content-Disposition', `inline; filename="snapshot-${snapshot.id}.png"`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (!response.getHeader('Cache-Control')) response.setHeader('Cache-Control', 'private, max-age=300');
  response.end(bytes);
}

/**
 * The review API routes, shared by the team (`review` sub-path) and the portal. `context`
 * resolves the actor and round for a request.
 */
function mountReviewRoutes(router, { context, svc }) {
  router.get('/', handle(async (request) => getReviewState(svc, await context(request))));
  router.put('/position', handle(async (request) => setPosition(svc, await context(request), positionSchema.parse(request.body ?? {}))));
  router.put('/directions/:directionId', handle(async (request) => putDirection(svc, await context(request), {
    directionId: request.params.directionId,
    input: directionStanceSchema.parse(request.body ?? {}),
  })));
  router.delete('/directions/:directionId', handle(async (request) => deleteDirection(svc, await context(request), { directionId: request.params.directionId })));
  router.put('/screens/:screenId/verdict', handle(async (request) => putVerdict(svc, await context(request), {
    input: screenVerdictSchema.parse(request.body ?? {}),
    screenId: request.params.screenId,
  })));
  router.delete('/screens/:screenId/verdict', handle(async (request) => deleteVerdict(svc, await context(request), { screenId: request.params.screenId })));
  router.put('/questions/:questionId/answer', handle(async (request) => putAnswer(svc, await context(request), {
    input: answerSchema.parse(request.body ?? {}),
    questionId: request.params.questionId,
  })));
  router.delete('/questions/:questionId/answer', handle(async (request) => deleteAnswer(svc, await context(request), { questionId: request.params.questionId })));

  router.put('/annotations/:annotationId', async (request, response, next) => {
    try {
      const annotationId = annotationIdParam(request);
      const result = await upsertAnnotation(svc, await context(request), { annotationId, input: annotationUpsertSchema.parse(request.body ?? {}) });
      response.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.delete('/annotations/:annotationId', handle(async (request) => deleteAnnotation(svc, await context(request), { annotationId: annotationIdParam(request) })));
  router.post('/annotations/:annotationId/status', handle(async (request) => setAnnotationStatus(svc, await context(request), {
    annotationId: annotationIdParam(request),
    input: annotationStatusSchema.parse(request.body ?? {}),
  })));
  router.post('/annotations/:annotationId/carry', handle(async (request) => carryAnnotation(svc, await context(request), { annotationId: annotationIdParam(request) })));
  router.post('/annotations/:annotationId/close', handle(async (request) => closeOutdatedAnnotation(svc, await context(request), { annotationId: annotationIdParam(request) })));
  router.get('/annotations/:annotationId/mentionables', handle(async (request) => listAnnotationMentionables(svc, await context(request), {
    annotationId: annotationIdParam(request),
  })));
  router.post('/annotations/:annotationId/comments', handle(async (request) => createAnnotationComment(svc, await context(request), {
    annotationId: annotationIdParam(request),
    input: annotationCommentSchema.parse(request.body ?? {}),
  }), 201));
  router.patch('/annotations/:annotationId/comments/:commentId', handle(async (request) => updateAnnotationComment(svc, await context(request), {
    annotationId: annotationIdParam(request),
    commentId: request.params.commentId,
    input: annotationCommentUpdateSchema.parse(request.body ?? {}),
  })));
  router.delete('/annotations/:annotationId/comments/:commentId', handle(async (request) => deleteAnnotationComment(svc, await context(request), {
    annotationId: annotationIdParam(request),
    commentId: request.params.commentId,
  })));

  // The round must be reachable before a 10 MB body is read.
  router.post('/snapshots', async (request, _response, next) => {
    try {
      request.reviewContext = await context(request);
      next();
    } catch (error) {
      next(error);
    }
  }, rawPngBody(), handle((request) => uploadSnapshot(svc, request.reviewContext, {
    bytes: request.body,
    query: snapshotQuerySchema.parse(request.query ?? {}),
  }), 201));

  router.post('/submit', handle(async (request) => submitReview(svc, await context(request))));
}

/**
 * Team routes, mounted at /api/projects/:projectId/requirements/rounds. app.js mounts this
 * router before the generic project mutation events, so frequent annotation saves publish
 * only requirements.review.updated rather than refreshing every project screen.
 */
export function createRoundsRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = roundsServiceDeps(deps);
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

  // MCP credentials reach only the round reads, publish and reviewer changes allowed in
  // backend/src/mcp/route-access.js.
  router.use(createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }));

  router.get('/', canRead, handle((request) => listRoundsForUser(svc, {
    projectId: projectId(request),
    track: roundListQuerySchema.parse(request.query ?? {}).track ?? '',
    user: user(request),
  })));
  router.post('/', canCollaborate, handle((request) => publishRoundForUser(svc, {
    input: publishRoundSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    user: user(request),
  }), 201));
  router.get('/:roundId', canRead, handle((request) => getRoundForUser(svc, { projectId: projectId(request), roundId: request.params.roundId, user: user(request) })));
  router.patch('/:roundId', canCollaborate, handle((request) => updateRoundForUser(svc, {
    input: patchRoundSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    roundId: request.params.roundId,
    user: user(request),
  })));
  router.post('/:roundId/close', canDecide, handle((request) => closeRoundForUser(svc, {
    input: closeRoundSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    roundId: request.params.roundId,
    user: user(request),
  })));
  router.post('/:roundId/reviewers/:reviewerId/resend', canCollaborate, handle((request) => resendInvitationForUser(svc, {
    projectId: projectId(request),
    reviewerId: request.params.reviewerId,
    roundId: request.params.roundId,
    user: user(request),
  })));
  router.get('/:roundId/results', canRead, handle((request) => getRoundResultsForUser(svc, { projectId: projectId(request), roundId: request.params.roundId, user: user(request) })));
  router.get('/:roundId/annotations', canRead, handle((request) => getRoundAnnotationsForUser(svc, { projectId: projectId(request), roundId: request.params.roundId, user: user(request) })));
  router.get('/:roundId/feedback', canRead, handle((request) => getRoundFeedbackForUser(svc, {
    projectId: projectId(request),
    query: feedbackQuerySchema.parse(request.query ?? {}),
    roundId: request.params.roundId,
    user: user(request),
  })));
  router.post('/:roundId/summary/refresh', canCollaborate, handle((request) => refreshRoundSummaryForUser(svc, {
    input: summaryRefreshSchema.parse(request.body ?? {}),
    projectId: projectId(request),
    roundId: request.params.roundId,
    user: user(request),
  })));
  router.get('/:roundId/snapshots/:snapshotId', canRead, async (request, response, next) => {
    try {
      const tenantId = await requireRoundCapability(svc, { capability: PROJECT_CAPABILITIES.READ, projectId: projectId(request), user: user(request) });
      const round = await deps.roundsRepository.getRound({ projectId: projectId(request), roundId: request.params.roundId, tenantId });
      if (!round) throw new HttpError(404, 'Round not found.');
      sendPng(response, await readSnapshot(svc, { projectId: projectId(request), roundId: round.id, snapshotId: request.params.snapshotId, tenantId }));
    } catch (error) {
      next(error);
    }
  });

  const review = Router({ mergeParams: true });
  mountReviewRoutes(review, {
    context: async (request) => loadReviewContext(svc, await teamReviewActor(svc, { projectId: projectId(request), user: user(request) }), request.params.roundId),
    svc,
  });
  router.use('/:roundId/review', canCollaborate, review);
  return router;
}

/**
 * Portal routes, mounted from createPublicRequirementsRouter at
 * /api/public/requirements/:token/rounds after its rate limiter. A stakeholder sees only the
 * rounds they are invited to.
 */
export function createPortalRoundsRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = roundsServiceDeps(deps);
  const token = (request) => request.params.token;

  router.get('/', handle(async (request) => listPortalRounds(svc, await portalReviewActor(svc, { token: token(request) }))));
  router.get('/:roundId/snapshots/:snapshotId', async (request, response, next) => {
    try {
      const ctx = await loadReviewContext(svc, await portalReviewActor(svc, { token: token(request) }), request.params.roundId);
      sendPng(response, await readSnapshotForReview(svc, ctx, { snapshotId: request.params.snapshotId }));
    } catch (error) {
      next(error);
    }
  });

  const review = Router({ mergeParams: true });
  mountReviewRoutes(review, {
    context: async (request) => loadReviewContext(svc, await portalReviewActor(svc, { token: token(request) }), request.params.roundId),
    svc,
  });
  router.use('/:roundId', review);
  return router;
}
