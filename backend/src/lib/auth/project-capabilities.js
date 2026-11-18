import { HttpError } from '../errors/http-error.js';
import { recordAuditPolicyDecision } from '../audit/audit-context.js';

export const PROJECT_CAPABILITIES = Object.freeze({
  ADMIN: 'project.admin',
  COLLABORATE: 'project.collaborate',
  FILE_READ: 'project.files.read',
  FILE_WRITE: 'project.files.write',
  PLAN_EDIT: 'project.plan.edit',
  READ: 'project.read',
});

const TENANT_ROLE_CAPABILITIES = Object.freeze({
  admin: new Set(Object.values(PROJECT_CAPABILITIES)),
  manager: new Set([
    PROJECT_CAPABILITIES.COLLABORATE,
    PROJECT_CAPABILITIES.FILE_READ,
    PROJECT_CAPABILITIES.FILE_WRITE,
    PROJECT_CAPABILITIES.PLAN_EDIT,
    PROJECT_CAPABILITIES.READ,
  ]),
});

const PROJECT_ROLE_CAPABILITIES = Object.freeze({
  admin: new Set(Object.values(PROJECT_CAPABILITIES)),
  contributor: new Set([
    PROJECT_CAPABILITIES.COLLABORATE,
    PROJECT_CAPABILITIES.FILE_READ,
    PROJECT_CAPABILITIES.FILE_WRITE,
    PROJECT_CAPABILITIES.PLAN_EDIT,
    PROJECT_CAPABILITIES.READ,
  ]),
  editor: new Set([
    PROJECT_CAPABILITIES.COLLABORATE,
    PROJECT_CAPABILITIES.FILE_READ,
    PROJECT_CAPABILITIES.FILE_WRITE,
    PROJECT_CAPABILITIES.PLAN_EDIT,
    PROJECT_CAPABILITIES.READ,
  ]),
  manager: new Set([
    PROJECT_CAPABILITIES.COLLABORATE,
    PROJECT_CAPABILITIES.FILE_READ,
    PROJECT_CAPABILITIES.FILE_WRITE,
    PROJECT_CAPABILITIES.PLAN_EDIT,
    PROJECT_CAPABILITIES.READ,
  ]),
  member: new Set([
    PROJECT_CAPABILITIES.COLLABORATE,
    PROJECT_CAPABILITIES.FILE_READ,
    PROJECT_CAPABILITIES.FILE_WRITE,
    PROJECT_CAPABILITIES.READ,
  ]),
  user: new Set([
    PROJECT_CAPABILITIES.COLLABORATE,
    PROJECT_CAPABILITIES.FILE_READ,
    PROJECT_CAPABILITIES.FILE_WRITE,
    PROJECT_CAPABILITIES.READ,
  ]),
  viewer: new Set([PROJECT_CAPABILITIES.FILE_READ, PROJECT_CAPABILITIES.READ]),
});

function normalizedRole(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function getTenantMembership(user, tenantId) {
  return user?.memberships?.find((membership) => membership.tenantId === tenantId) ?? null;
}

export function hasProjectCapability({ capability, projectRole, tenantRole, userCapabilities = [] }) {
  return TENANT_ROLE_CAPABILITIES[normalizedRole(tenantRole)]?.has(capability)
    || PROJECT_ROLE_CAPABILITIES[normalizedRole(projectRole)]?.has(capability)
    || new Set(userCapabilities).has(capability)
    || false;
}

export async function requireProjectCapability({
  capability,
  projectId,
  repository,
  tenantId,
  user,
}) {
  const membership = getTenantMembership(user, tenantId);
  if (!membership || !user?.id) {
    recordAuditPolicyDecision({ allowed: false, capability, projectId, projectRole: null, tenantRole: null });
    throw new HttpError(404, 'Project not found.');
  }

  const access = await repository.getProjectAccess({
    projectId,
    tenantId,
    userId: user.id,
  });

  const allowed = Boolean(access?.exists && hasProjectCapability({
    capability,
    projectRole: access.projectRole,
    tenantRole: membership.role,
    userCapabilities: user.capabilities,
  }));
  recordAuditPolicyDecision({
    allowed,
    capability,
    projectId,
    projectRole: access?.projectRole ?? null,
    tenantRole: membership.role,
  });

  if (!allowed) {
    throw new HttpError(404, 'Project not found.');
  }

  return access;
}
