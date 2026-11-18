// Reports, saved views and resource allocations can point at a project that was soft-deleted.
// They are kept so a restore brings them back, but reporting leaves them out meanwhile.

/** Ids of the tenant's soft-deleted projects. Repositories without deletion support have none. */
export async function loadDeletedProjectIds(projectRepository, tenantId) {
  if (typeof projectRepository?.listDeletedProjects !== 'function') return new Set();
  const deleted = await projectRepository.listDeletedProjects({ tenantId });
  return new Set(deleted.map((project) => project.id));
}

export function inDeletedProject(record, deletedProjectIds) {
  return Boolean(record?.projectId) && Boolean(deletedProjectIds?.has(record.projectId));
}
