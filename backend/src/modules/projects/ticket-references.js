import { HttpError } from '../../lib/errors/http-error.js';

// A ticket's environment and found-in/fixed-in releases must be entries of this
// tenant's lists that are tenant-wide or scoped to the ticket's project, and active. Only fields
// present on the write are checked, so deactivating an entry never breaks tickets that already
// reference it. Both projects repositories use this so they refuse the same writes.
const TICKET_REFERENCES = Object.freeze([
  { field: 'environmentId', kind: 'environments', label: 'environment', table: 'tenant_environments' },
  { field: 'foundInReleaseId', kind: 'releases', label: 'found-in release', table: 'tenant_releases' },
  { field: 'fixedInReleaseId', kind: 'releases', label: 'fixed-in release', table: 'tenant_releases' },
]);

export function inTicketProjectScope(entry, projectId) {
  return !entry.projectId || entry.projectId === projectId;
}

/**
 * `findEntry(reference, id)` returns the in-scope list entry (`{ status }`) or nothing; `reference`
 * names the list both as a config `kind` and a MySQL `table`.
 */
export async function assertTicketReferences(item, findEntry) {
  for (const reference of TICKET_REFERENCES) {
    const value = item?.[reference.field];
    if (value === undefined || value === null || value === '') continue;

    const entry = await findEntry(reference, value);
    if (!entry) throw new HttpError(400, `Unknown ${reference.label} for this tenant.`);
    if (String(entry.status) !== 'active') throw new HttpError(400, `The selected ${reference.label} is inactive.`);
  }
}
