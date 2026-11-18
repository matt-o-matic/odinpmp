import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';

// The tenant admin list endpoint is admin-only. Ticket pickers need the same lists for
// any project reader, limited to tenant-wide entries and entries scoped to this project.
// Inactive entries are included with their status so tickets that already reference them
// still render a name; pickers offer only the active ones.
export function scopeTicketConfigEntries(entries = [], projectId) {
  return entries
    .filter((entry) => !entry.projectId || entry.projectId === projectId)
    .sort((left, right) => Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || String(left.name).localeCompare(String(right.name)))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      projectId: entry.projectId ?? null,
      sortOrder: Number(entry.sortOrder ?? 0),
      status: entry.status === 'inactive' ? 'inactive' : 'active',
    }));
}

export async function listProjectTicketConfigForUser(user, projectId, { projectRepository, tenantsRepository }) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });

  if (!tenantsRepository?.listTicketConfigList) {
    return { environments: [], ok: true, releases: [] };
  }

  const [environments, releases] = await Promise.all([
    tenantsRepository.listTicketConfigList({ kind: 'environments', tenantId }),
    tenantsRepository.listTicketConfigList({ kind: 'releases', tenantId }),
  ]);

  return {
    environments: scopeTicketConfigEntries(environments, projectId),
    ok: true,
    releases: scopeTicketConfigEntries(releases, projectId),
  };
}
