// Picker options for a ticket's environment and found-in / fixed-in release. The project
// ticket-config endpoint returns tenant-wide and project-scoped entries, including inactive
// ones so existing references still have a name. New choices are limited to active entries;
// a ticket that already points at an inactive entry keeps it as a labelled option so an
// unrelated edit does not silently clear it.

export function ticketConfigChoices(entries = [], currentId = '') {
  const active = entries.filter((entry) => entry.status !== 'inactive');
  const current = currentId ? entries.find((entry) => entry.id === currentId) : null;
  const options = active.map((entry) => ({ id: entry.id, label: entry.name }));
  if (current && current.status === 'inactive') options.push({ id: current.id, label: `${current.name} (inactive)` });
  if (currentId && !current) options.push({ id: currentId, label: 'Unavailable entry' });
  return options;
}

export function ticketConfigName(entries = [], id) {
  if (!id) return '—';
  const entry = entries.find((item) => item.id === id);
  if (!entry) return 'Unavailable entry';
  return entry.status === 'inactive' ? `${entry.name} (inactive)` : entry.name;
}

// Only fields the user changed go into the PATCH, so the server's reference check runs on
// new choices and an inactive value already on the ticket is left alone.
export function ticketReferencePatch(ticket, draft) {
  const patch = {};
  for (const field of ['environmentId', 'foundInReleaseId', 'fixedInReleaseId']) {
    const before = ticket?.[field] ?? null;
    const after = draft?.[field] || null;
    if (before !== after) patch[field] = after;
  }
  return patch;
}
