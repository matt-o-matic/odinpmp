import { getTenantMembership, PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';

const PROJECT_DELETE_ROLES = new Set(['admin', 'manager']);

function normalizedRole(value) {
  return String(value ?? '').trim().toLowerCase();
}

function requirePrimaryTenantId(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function requireTenantAdmin(user) {
  const tenantId = requirePrimaryTenantId(user);
  if (normalizedRole(getTenantMembership(user, tenantId)?.role) !== 'admin') {
    throw new HttpError(403, 'Tenant admin access is required.');
  }
  return tenantId;
}

// Tenant admins can delete any project; otherwise the caller needs an admin or manager
// role on the project itself. A tenant-level manager role alone is not enough.
export function canDeleteProject({ projectRole, tenantRole }) {
  return normalizedRole(tenantRole) === 'admin' || PROJECT_DELETE_ROLES.has(normalizedRole(projectRole));
}

// For token-based and background paths that skip requireProjectCapability. Repositories
// without deletion support (test doubles) treat every project as live.
export async function isProjectSoftDeleted(repository, { projectId, tenantId }) {
  if (!projectId || typeof repository?.getProjectDeletionState !== 'function') return false;
  return await repository.getProjectDeletionState({ projectId, tenantId }) === 'deleted';
}

export async function deleteProjectForUser(user, projectId, { complianceRepository = null, repository }) {
  const tenantId = requirePrimaryTenantId(user);
  const access = await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository, tenantId, user });

  if (!canDeleteProject({ projectRole: access.projectRole, tenantRole: getTenantMembership(user, tenantId)?.role })) {
    throw new HttpError(403, 'Only tenant admins and project admins or managers can delete a project.');
  }

  await assertRecordsNotHeld({ repository: complianceRepository, resources: [{ resourceId: projectId, resourceType: 'project' }], tenantId });

  const project = await repository.softDeleteProject({ projectId, tenantId, user });
  if (!project) throw new HttpError(404, 'Project not found.');

  return { ok: true, project };
}

export async function listDeletedProjectsForUser(user, repository) {
  const tenantId = requireTenantAdmin(user);
  return { ok: true, projects: await repository.listDeletedProjects({ tenantId }) };
}

export async function restoreProjectForUser(user, projectId, repository) {
  const tenantId = requireTenantAdmin(user);
  const project = await repository.restoreDeletedProject({ projectId, tenantId, user });
  if (!project) throw new HttpError(404, 'Deleted project not found.');
  return { ok: true, project };
}
