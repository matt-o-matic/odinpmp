import { HttpError } from '../../lib/errors/http-error.js';

export const LEADERBOARD_SIZE = 10;

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

function compareContributors(left, right) {
  return right.points - left.points
    || right.tasksCompleted - left.tasksCompleted
    || right.hoursLogged - left.hoursLogged
    || String(left.name ?? '').localeCompare(String(right.name ?? ''))
    || String(left.id).localeCompare(String(right.id));
}

/** Orders contributors and ranks them by points; tied points share a rank. */
export function rankContributors(rows = []) {
  const sorted = [...rows].sort(compareContributors);
  let rank = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row.points !== sorted[index - 1].points) rank = index + 1;
    return { ...row, rank };
  });
}

// Work in deleted projects stops counting; restoring a project brings it back. Engagements are
// not delivery work, so they count only once they convert.
async function excludedProjectIds(projectRepository, tenantId) {
  const [deleted, engagements] = await Promise.all([
    projectRepository?.listDeletedProjects ? projectRepository.listDeletedProjects({ tenantId }) : [],
    projectRepository?.listEngagementProjectIds ? projectRepository.listEngagementProjectIds({ tenantId }) : [],
  ]);
  return [...deleted.map((project) => project.id), ...engagements];
}

export async function getContributorLeaderboardForUser(user, input, repository, authRepository, projectRepository = null) {
  const tenantId = requireTenantContext(user);

  const ranked = rankContributors(await repository.listContributorTotals({
    days: input.days,
    excludedProjectIds: await excludedProjectIds(projectRepository, tenantId),
    tenantId,
    users: authRepository?.state?.users ?? [],
  })).map((row) => ({ ...row, isCurrentUser: row.id === user.id }));

  return {
    contributorCount: ranked.length,
    currentUser: ranked.find((row) => row.isCurrentUser) ?? null,
    days: input.days,
    leaderboard: ranked.slice(0, LEADERBOARD_SIZE),
    ok: true,
  };
}
