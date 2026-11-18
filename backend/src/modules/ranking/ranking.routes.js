import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  rankingCompletionQuerySchema,
  rankingSkipSchema,
  rankingVoteSchema,
} from './ranking.schema.js';
import {
  getNextRankPairForUser,
  getProjectHeadToHeadForUser,
  getRankingCompletionStatusForUser,
  getRankingLeaderboardForUser,
  getUserVoteHistoryForUser,
  skipRankPairForUser,
  submitRankVoteForUser,
} from './ranking.service.js';

export function createRankingRouter({
  authRepository,
  rankingRepository,
  tokenService,
}) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });

  router.get('/next-pair', requireAuth, async (request, response, next) => {
    try {
      const result = await getNextRankPairForUser(request.auth.user, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/vote', requireAuth, async (request, response, next) => {
    try {
      const payload = rankingVoteSchema.parse(request.body);
      const result = await submitRankVoteForUser(request.auth.user, payload, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/skip', requireAuth, async (request, response, next) => {
    try {
      const payload = rankingSkipSchema.parse(request.body);
      const result = await skipRankPairForUser(request.auth.user, payload, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/completion-status', requireAuth, async (request, response, next) => {
    try {
      const query = rankingCompletionQuerySchema.parse(request.query);
      const result = await getRankingCompletionStatusForUser(request.auth.user, query, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/leaderboard', requireAuth, async (request, response, next) => {
    try {
      const result = await getRankingLeaderboardForUser(request.auth.user, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/vote-history', requireAuth, async (request, response, next) => {
    try {
      const result = await getUserVoteHistoryForUser(request.auth.user, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/head-to-head/:projectId', requireAuth, async (request, response, next) => {
    try {
      const result = await getProjectHeadToHeadForUser(request.auth.user, request.params.projectId, rankingRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
