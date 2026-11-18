const GOVERNANCE_KIND_ORDER = ['risk', 'issue', 'assumption', 'decision', 'change_request'];

function normalizedText(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function flattenProjectWorkItems(project = {}) {
  const items = [];
  for (const epic of project?.epics ?? []) {
    items.push({ id: epic.id, label: epic.name, type: 'Epic' });
    for (const story of epic.stories ?? []) {
      items.push({ id: story.id, label: `${epic.name} / ${story.name}`, type: 'Story' });
      for (const task of story.tasks ?? []) {
        items.push({ id: task.id, label: `${epic.name} / ${story.name} / ${task.name}`, type: 'Task' });
      }
    }
  }
  return items.filter((item) => item.id && item.label);
}

export function governanceKindLabel(kind = '') {
  const labels = {
    assumption: 'Assumption',
    change_request: 'Change request',
    decision: 'Decision',
    issue: 'Issue',
    risk: 'Risk',
  };
  return labels[kind] ?? 'Record';
}

export function governanceItemCounts(items = []) {
  return Object.fromEntries(GOVERNANCE_KIND_ORDER.map((kind) => [
    kind,
    items.filter((item) => item.kind === kind).length,
  ]));
}

export function selectGovernanceItems(items = [], {
  kind = 'all',
  page = 1,
  pageSize = 10,
  query = '',
  sort = 'updated_desc',
  status = 'all',
} = {}) {
  const normalizedQuery = normalizedText(query);
  const filtered = items.filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (!normalizedQuery) return true;
    return [item.title, item.description, item.responsePlan, item.ownerId]
      .some((value) => normalizedText(value).includes(normalizedQuery));
  });
  const sorted = [...filtered].sort((left, right) => {
    if (sort === 'title_asc') return String(left.title ?? '').localeCompare(String(right.title ?? ''));
    if (sort === 'due_asc') return String(left.dueDate ?? '9999-12-31').localeCompare(String(right.dueDate ?? '9999-12-31'));
    if (sort === 'impact_desc') {
      const rank = { critical: 4, high: 3, medium: 2, low: 1 };
      return (rank[right.impact] ?? 0) - (rank[left.impact] ?? 0);
    }
    return String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? ''));
  });
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const pageCount = Math.max(1, Math.ceil(sorted.length / safePageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const start = (currentPage - 1) * safePageSize;
  return {
    items: sorted.slice(start, start + safePageSize),
    page: currentPage,
    pageCount,
    total: sorted.length,
  };
}

// A goal's runs change nothing unless its owner set constraints.autoApply. Monitors the assistant
// sets up (constraints.readOnly) never make changes. The backend enforces both; this only mirrors
// them so the screen offers the choice to the owner alone. A new goal belongs to whoever creates it.
export function goalChangeAccess(goal, currentUserId = '') {
  const readOnly = goal?.constraints?.readOnly === true;
  return {
    makesChanges: !readOnly && goal?.constraints?.autoApply === true,
    owner: Boolean(currentUserId) && (!goal || goal.ownerUserId === currentUserId),
    readOnly,
  };
}

export function goalChangesLabel(goal) {
  return goalChangeAccess(goal).makesChanges ? 'Makes changes on its own' : 'Watches only';
}

export function goalOwnerName(goal, users = []) {
  const owner = users.find((user) => user.id === goal?.ownerUserId);
  return owner?.name || owner?.email || "the goal's owner";
}

// The screen saves constraints whole. Only the owner's choice to allow changes is sent; anyone
// else's save turns it off, which is what the backend does with their edit anyway.
export function goalConstraintsFromDraft(draft, access) {
  return {
    allowWebResearch: draft.allowWebResearch,
    autoApply: access.owner && !access.readOnly && draft.autoApply === true,
    escalation: {
      afterRuns: Number(draft.escalationAfterRuns),
      channels: ['in_app', ...(draft.escalationEmail ? ['email'] : []), ...(draft.escalationWebhook ? ['webhook'] : [])],
    },
    maxAttempts: Number(draft.maxAttempts),
  };
}
