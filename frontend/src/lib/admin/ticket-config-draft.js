// Edit-mode model for the tenant ticket environment and release lists. The API replaces the
// whole list on save (entries omitted from a save become inactive), so the screen edits a local
// draft of every entry and sends it back in one request with the revision it was loaded at.

export const TICKET_CONFIG_KINDS = [
  { key: 'environments', label: 'Environments', singular: 'environment' },
  { key: 'releases', label: 'Releases', singular: 'release' },
];

export const TICKET_CONFIG_NAME_MAX = 160;
export const TICKET_CONFIG_ENTRY_MAX = 500;

let draftKeySequence = 0;

function nextDraftKey() {
  draftKeySequence += 1;
  return `new-${draftKeySequence}`;
}

export function sortTicketConfigEntries(entries = []) {
  return [...entries].sort((left, right) => Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || String(left.name).localeCompare(String(right.name)));
}

export function createTicketConfigDraft(entries = []) {
  return sortTicketConfigEntries(entries).map((entry) => ({
    id: entry.id,
    isNew: false,
    key: entry.id,
    name: entry.name,
    originalName: entry.name,
    projectId: entry.projectId ?? '',
    status: entry.status === 'inactive' ? 'inactive' : 'active',
  }));
}

export function addTicketConfigDraftRow(rows, { projectId = '' } = {}) {
  return [...rows, { id: '', isNew: true, key: nextDraftKey(), name: '', originalName: '', projectId, status: 'active' }];
}

export function removeNewTicketConfigDraftRow(rows, key) {
  return rows.filter((row) => !(row.key === key && row.isNew));
}

export function moveTicketConfigDraftRow(rows, key, delta) {
  const index = rows.findIndex((row) => row.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function setTicketConfigDraftStatus(rows, key, status) {
  return rows.map((row) => (row.key === key ? { ...row, status } : row));
}

// Names must be unique within a scope (tenant-wide or one project), matching the table's
// unique key, which MySQL does not enforce for tenant-wide rows because project_id is NULL.
export function validateTicketConfigDraft(rows) {
  const errors = {};
  const seen = new Map();
  for (const row of rows) {
    const name = String(row.name ?? '').trim();
    if (!name) {
      errors[row.key] = 'Enter a name.';
      continue;
    }
    if (name.length > TICKET_CONFIG_NAME_MAX) {
      errors[row.key] = `Use ${TICKET_CONFIG_NAME_MAX} characters or fewer.`;
      continue;
    }
    const scopeKey = `${row.projectId || ''}\u0000${name.toLowerCase()}`;
    if (seen.has(scopeKey)) {
      errors[row.key] = 'Another entry in the same scope already uses this name.';
      errors[seen.get(scopeKey)] ??= 'Another entry in the same scope already uses this name.';
      continue;
    }
    seen.set(scopeKey, row.key);
  }
  if (rows.length > TICKET_CONFIG_ENTRY_MAX) errors.list = `A list can hold at most ${TICKET_CONFIG_ENTRY_MAX} entries.`;
  return errors;
}

export function buildTicketConfigPayload(rows, revision) {
  return {
    entries: rows.map((row, index) => ({
      ...(row.id ? { id: row.id } : {}),
      name: String(row.name).trim(),
      projectId: row.projectId || null,
      sortOrder: index,
      status: row.status === 'inactive' ? 'inactive' : 'active',
    })),
    ...(revision ? { expectedRevision: revision } : {}),
  };
}

export function ticketConfigDraftChanged(rows, entries) {
  const original = createTicketConfigDraft(entries);
  if (rows.length !== original.length) return true;
  return rows.some((row, index) => {
    const before = original[index];
    return row.id !== before.id || String(row.name).trim() !== before.name || (row.projectId || '') !== before.projectId || row.status !== before.status;
  });
}

// scope: 'all' | 'tenant' | a project id.
export function filterTicketConfigEntries(entries, { query = '', scope = 'all', status = 'active' } = {}) {
  const needle = query.trim().toLowerCase();
  return sortTicketConfigEntries(entries).filter((entry) => {
    if (status !== 'all' && (entry.status ?? 'active') !== status) return false;
    if (scope === 'tenant' && entry.projectId) return false;
    if (scope !== 'all' && scope !== 'tenant' && entry.projectId !== scope) return false;
    return !needle || String(entry.name).toLowerCase().includes(needle);
  });
}
