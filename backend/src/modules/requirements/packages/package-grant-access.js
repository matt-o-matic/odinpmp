import { hasProjectCapability, PROJECT_CAPABILITIES } from '../../../lib/auth/project-capabilities.js';
import { ensureLinkTokenActive } from '../requirements-portal.service.js';
import { parseActorRef } from '../requirements-topics.js';

// Package grants are checked when they are issued, and again by the review origin while
// they are used. Without the second check, revoking a stakeholder's link, removing a
// reviewer from a round, or removing a member from the project would leave package files
// reachable through an earlier grant until it expired. The answer is cached briefly per
// viewer and package, because a prototype loads many files at once; a change takes effect
// within that window.

export const GRANT_RECHECK_MS = 15_000;
const MAX_CACHED = 5_000;

/** A stakeholder may view a package while their portal token works and a round of it lists them. */
async function stakeholderMayView(deps, { grant, pkg, stakeholderId }) {
  if (!grant.linkId || !grant.tokenId) return false;
  const link = await deps.requirementsRepository.getAccessLink({ linkId: grant.linkId, projectId: pkg.projectId, tenantId: pkg.tenantId });
  const token = link?.tokens?.find((item) => item.id === grant.tokenId) ?? null;
  if (!link || !token || link.stakeholderId !== stakeholderId) return false;
  try {
    await ensureLinkTokenActive(deps, { link, token });
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) return false;
    throw error;
  }
  const rounds = await deps.roundsRepository.listRounds({ projectId: pkg.projectId, tenantId: pkg.tenantId, track: pkg.track });
  return rounds.some((round) => round.packageId === pkg.id
    && round.status !== 'draft'
    && round.reviewers.some((reviewer) => reviewer.actorType === 'stakeholder' && reviewer.actorId === stakeholderId && !reviewer.removedAt));
}

/** A member may view a package while they can read its project (the grant route's rule). */
async function userMayView(deps, { pkg, userId }) {
  const valid = await deps.projectRepository.getValidUsers({ projectId: pkg.projectId, tenantId: pkg.tenantId });
  const tenantUser = (valid?.tenant_users ?? []).find((entry) => entry.id === userId) ?? null;
  if (!tenantUser) return false;
  const access = await deps.projectRepository.getProjectAccess({ projectId: pkg.projectId, tenantId: pkg.tenantId, userId });
  return Boolean(access?.exists) && hasProjectCapability({
    capability: PROJECT_CAPABILITIES.READ,
    projectRole: access.projectRole ?? null,
    tenantRole: tenantUser.role ?? null,
  });
}

/**
 * Returns `mayView({ grant, pkg })` for the review origin. `grant` is what verifyPackageGrant
 * returned. deps: requirementsRepository, roundsRepository, projectRepository,
 * assistantRepository, and optionally clock (as the portal uses it).
 */
export function createGrantAccessCheck(deps, { cacheMs = GRANT_RECHECK_MS, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function decide({ grant, pkg }) {
    const { actorId, actorType } = parseActorRef(grant.viewerRef);
    if (!actorId) return false;
    if (actorType === 'stakeholder') return stakeholderMayView(deps, { grant, pkg, stakeholderId: actorId });
    if (actorType === 'user') return userMayView(deps, { pkg, userId: actorId });
    return false;
  }

  return async function mayView({ grant, pkg }) {
    const key = [pkg.id, grant.viewerRef, grant.linkId ?? '', grant.tokenId ?? ''].join('|');
    const nowMs = now();
    const cached = cache.get(key);
    if (cached && cached.until > nowMs) return cached.allowed;
    const allowed = await decide({ grant, pkg });
    cache.delete(key);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(key, { allowed, until: nowMs + cacheMs });
    return allowed;
  };
}
