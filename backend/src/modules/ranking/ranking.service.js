import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';

function primaryMembership(user) {
  return user?.memberships?.[0] ?? null;
}

function requireTenantContext(user) {
  const membership = primaryMembership(user);

  if (!membership?.tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  return membership.tenantId;
}

function requireRankingRole(user) {
  const role = primaryMembership(user)?.role ?? 'user';

  if (role !== 'admin' && role !== 'manager') {
    throw new HttpError(403, 'Forbidden');
  }

  return role;
}

function logRankingRepositoryFailure({ error, operation, user, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      tenantId: primaryMembership(user)?.tenantId ?? null,
      userId: user?.id ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Ranking repository operation failed.',
  });
}

export async function getNextRankPairForUser(user, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);
  const pair = await repository.getNextRankPair({
    tenantId,
    userId: user.id,
  });

  return {
    ok: true,
    pair,
  };
}

export async function submitRankVoteForUser(user, input, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);

  try {
    await repository.submitVote({
      loserId: input.loserId,
      tenantId,
      userId: user.id,
      winnerId: input.winnerId,
    });
  } catch (error) {
    logRankingRepositoryFailure({
      error,
      extra: {
        loserId: input.loserId,
        winnerId: input.winnerId,
      },
      operation: 'ranking.submitVote',
      user,
    });
    throw error;
  }

  return {
    ok: true,
  };
}

export async function skipRankPairForUser(user, input, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);

  try {
    await repository.skipPair({
      projectAId: input.projectAId,
      projectBId: input.projectBId,
      tenantId,
      userId: user.id,
    });
  } catch (error) {
    logRankingRepositoryFailure({
      error,
      extra: {
        projectAId: input.projectAId,
        projectBId: input.projectBId,
      },
      operation: 'ranking.skipPair',
      user,
    });
    throw error;
  }

  return {
    ok: true,
  };
}

export async function getRankingCompletionStatusForUser(user, input, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);

  const status = await repository.getCompletionStatus({
    tenantId,
    threshold: input.threshold,
    userId: user.id,
  });

  return {
    ok: true,
    status,
  };
}

export async function getRankingLeaderboardForUser(user, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);

  const leaderboard = await repository.getLeaderboard({
    tenantId,
  });

  return {
    leaderboard,
    ok: true,
  };
}

export async function getUserVoteHistoryForUser(user, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);

  const payload = await repository.getUserVoteHistory({
    tenantId,
    userId: user.id,
  });

  return {
    ok: true,
    ...payload,
  };
}

export async function getProjectHeadToHeadForUser(user, projectId, repository) {
  requireRankingRole(user);
  const tenantId = requireTenantContext(user);

  const payload = await repository.getProjectHeadToHead({
    projectId,
    tenantId,
  });

  if (!payload) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    ...payload,
  };
}
