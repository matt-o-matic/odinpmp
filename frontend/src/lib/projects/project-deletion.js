// Helpers for deleting a project (a soft delete) and for the tenant admin's restore list.

export function projectNameConfirmed(typedName, projectName) {
  const expected = String(projectName ?? '').trim();
  return expected.length > 0 && String(typedName ?? '').trim() === expected;
}

export function describeProjectDeleteError(error) {
  if (error?.status === 423) {
    return 'This project is under a legal hold, so it cannot be deleted. Ask a compliance admin to release the hold first.';
  }
  if (error?.status === 403) {
    return 'Only tenant admins and the project\'s admins or managers can delete it.';
  }
  if (error?.status === 404) {
    return 'This project no longer exists or you no longer have access to it.';
  }
  return error?.message || 'Unable to delete the project.';
}

export const DELETED_PROJECT_SORTS = Object.freeze({
  deletedAt: 'Most recently deleted',
  name: 'Name',
});

export function filterDeletedProjects(projects, { query = '', sort = 'deletedAt' } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const matches = (Array.isArray(projects) ? projects : []).filter((project) => {
    if (!needle) return true;
    return `${project.name ?? ''} ${project.deletedByName ?? ''}`.toLowerCase().includes(needle);
  });
  return [...matches].sort((left, right) => {
    if (sort === 'name') return String(left.name ?? '').localeCompare(String(right.name ?? ''));
    return String(right.deletedAt ?? '').localeCompare(String(left.deletedAt ?? ''))
      || String(left.name ?? '').localeCompare(String(right.name ?? ''));
  });
}

export function paginate(items, page, pageSize) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  return { items: items.slice((current - 1) * pageSize, current * pageSize), page: current, pageCount };
}

export function formatDeletedAt(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
