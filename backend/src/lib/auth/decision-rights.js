import { HttpError } from '../errors/http-error.js';
import { recordAuditPolicyDecision } from '../audit/audit-context.js';
import { getTenantMembership } from './project-capabilities.js';

// Decision rights (Q-04): recording decisions, accepting preferences, closing rounds,
// approving plans, and managing stakeholder links belong to project admins and managers
// plus tenant admins and managers. Every other caller sees the same 404 as a missing
// project, so the routes do not reveal what exists.

export const DECISION_RIGHTS_CAPABILITY = 'requirements.decide';

const DECISION_ROLES = new Set(['admin', 'manager']);

function normalizedRole(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function hasDecisionRights({ projectRole = null, tenantRole = null } = {}) {
  return DECISION_ROLES.has(normalizedRole(projectRole)) || DECISION_ROLES.has(normalizedRole(tenantRole));
}

/**
 * Resolves decision rights without throwing. The project must exist in the tenant and the
 * user must belong to the tenant; tenant admins and managers need no project membership,
 * matching requireProjectCapability.
 */
export async function resolveDecisionRights({ projectId, repository, tenantId, user }) {
  const membership = getTenantMembership(user, tenantId);
  if (!membership || !user?.id || !projectId || !repository?.getProjectAccess) {
    return { allowed: false, projectRole: null, tenantRole: membership?.role ?? null };
  }

  const access = await repository.getProjectAccess({ projectId, tenantId, userId: user.id });
  const allowed = Boolean(access?.exists) && hasDecisionRights({
    projectRole: access?.projectRole ?? null,
    tenantRole: membership.role,
  });

  return {
    allowed,
    projectRole: access?.projectRole ?? null,
    tenantRole: membership.role ?? null,
  };
}

export async function requireDecisionRights({ projectId, repository, tenantId, user }) {
  const decision = await resolveDecisionRights({ projectId, repository, tenantId, user });
  recordAuditPolicyDecision({
    allowed: decision.allowed,
    capability: DECISION_RIGHTS_CAPABILITY,
    projectId,
    projectRole: decision.projectRole,
    tenantRole: decision.tenantRole,
  });

  if (!decision.allowed) {
    throw new HttpError(404, 'Project not found.');
  }

  return decision;
}

/**
 * Express middleware for routes mounted with a `:projectId` parameter after the auth
 * middleware. The active tenant is the user's first membership, as elsewhere.
 */
export function createRequireDecisionRights({ projectRepository }) {
  return async function requireDecisionRightsMiddleware(request, _response, next) {
    try {
      const user = request.auth?.user ?? null;
      await requireDecisionRights({
        projectId: request.params?.projectId,
        repository: projectRepository,
        tenantId: user?.memberships?.[0]?.tenantId ?? null,
        user,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
