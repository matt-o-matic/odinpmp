// Ticket board logic (D-020). Shared by the tenant board and the per-project view so both
// surfaces group, label, and filter identically.
//
// Columns come from the bound workflow definition rather than a hardcoded list, so a
// project that rebinds `ticket` to a custom workflow still renders (AC3.4, AC8.3).

export const TICKET_CATEGORIES = ['defect', 'support', 'question', 'change_request'];
export const TICKET_SEVERITIES = ['S1', 'S2', 'S3', 'S4'];
export const TICKET_REVIEW_STATES = ['not_external', 'pending', 'validated', 'rejected'];

const CATEGORY_LABELS = {
  change_request: 'Change request',
  defect: 'Defect',
  question: 'Question',
  support: 'Support',
};

const SEVERITY_LABELS = {
  S1: 'S1 · Critical',
  S2: 'S2 · Major',
  S3: 'S3 · Minor',
  S4: 'S4 · Trivial',
};

const REVIEW_STATE_LABELS = {
  not_external: 'Internal',
  pending: 'Awaiting review',
  rejected: 'Review rejected',
  validated: 'Reviewed',
};

// Fallback lifecycle matching the seeded default (D-022), used before the bound
// workflow has loaded so the board never renders an empty frame.
export const DEFAULT_TICKET_COLUMNS = [
  { key: 'new', label: 'New', statuses: ['new'] },
  { key: 'triage', label: 'Triage', statuses: ['triage'] },
  { key: 'open', label: 'Open', statuses: ['open'] },
  { key: 'in_progress', label: 'In Progress', statuses: ['in_progress'] },
  { key: 'resolved', label: 'Resolved', statuses: ['resolved'] },
  { key: 'closed', label: 'Closed', statuses: ['closed', 'rejected', 'deferred'] },
];

export function categoryLabel(value) {
  return CATEGORY_LABELS[value] ?? 'Defect';
}

export function severityLabel(value) {
  return SEVERITY_LABELS[value] ?? SEVERITY_LABELS.S3;
}

export function reviewStateLabel(value) {
  return REVIEW_STATE_LABELS[value] ?? REVIEW_STATE_LABELS.not_external;
}

export function isAwaitingReview(ticket) {
  return String(ticket?.externalReviewState ?? 'not_external') === 'pending';
}

// A hint from Odin's automated check of a ticket from outside the team. People still decide.
export function reviewCheckLabel(classification) {
  if (!classification) return 'Not checked';
  if (classification.safety === 'unsafe') return 'Looks unsafe';
  if (classification.recommendation === 'reject') return 'Looks like spam';
  if (classification.safety === 'caution') return 'Check carefully';
  return classification.recommendation === 'validate' ? 'Looks safe' : 'Unclear';
}

// Times a Bug Reporter reporter sent the ticket back after it was resolved or closed.
export function reopenCount(ticket) {
  const count = Number(ticket?.reopenCount ?? 0);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

export function reopenLabel(count) {
  return `Reopened ${count} ${count === 1 ? 'time' : 'times'}`;
}

/**
 * Builds board columns from a workflow definition. Terminal cancelled states are folded
 * into the done column so a board does not sprout a column per rejection reason.
 */
export function buildTicketColumns(workflow) {
  const states = workflow?.states ?? [];
  if (states.length === 0) {
    return DEFAULT_TICKET_COLUMNS.map((column) => ({ ...column, statuses: [...column.statuses] }));
  }

  const doneStates = states.filter((state) => state.category === 'done');
  const cancelledStates = states.filter((state) => state.category === 'cancelled');
  const columns = [];

  for (const state of states) {
    if (state.category === 'cancelled') continue;

    if (state.category === 'done') {
      // Fold cancelled states into the first done column rather than giving each its own.
      if (doneStates[0]?.key !== state.key) {
        columns.push({ key: state.key, label: state.label ?? state.key, statuses: [state.key] });
        continue;
      }
      columns.push({
        key: state.key,
        label: state.label ?? state.key,
        statuses: [state.key, ...cancelledStates.map((entry) => entry.key)],
      });
      continue;
    }

    columns.push({ key: state.key, label: state.label ?? state.key, statuses: [state.key] });
  }

  if (doneStates.length === 0 && cancelledStates.length > 0) {
    columns.push({
      key: cancelledStates[0].key,
      label: cancelledStates[0].label ?? cancelledStates[0].key,
      statuses: cancelledStates.map((entry) => entry.key),
    });
  }

  return columns;
}

/**
 * Distributes tickets into columns. A ticket whose status matches no column is placed in
 * an explicit "Unmapped" column rather than disappearing — silently dropping work is
 * worse than showing it in the wrong place.
 */
export function buildTicketBoard(tickets = [], columns = DEFAULT_TICKET_COLUMNS) {
  const board = columns.map((column) => ({ ...column, tickets: [] }));
  const unmapped = [];

  for (const ticket of tickets ?? []) {
    const column = board.find((entry) => entry.statuses.includes(ticket.status));
    if (column) {
      column.tickets.push(ticket);
      continue;
    }
    unmapped.push(ticket);
  }

  if (unmapped.length > 0) {
    board.push({ key: '__unmapped', label: 'Unmapped', statuses: [], tickets: unmapped });
  }

  return board;
}

export function summarizeTickets(tickets = []) {
  const counts = { awaitingReview: 0, bySeverity: { S1: 0, S2: 0, S3: 0, S4: 0 }, open: 0, total: 0 };

  for (const ticket of tickets ?? []) {
    counts.total += 1;
    if (isAwaitingReview(ticket)) counts.awaitingReview += 1;
    if (!['closed', 'rejected', 'deferred'].includes(ticket.status)) counts.open += 1;
    if (Object.hasOwn(counts.bySeverity, ticket.severity)) counts.bySeverity[ticket.severity] += 1;
  }

  return counts;
}

/**
 * Converts board filter state into the query the API expects, dropping empties so an
 * untouched filter never becomes a restriction (AC8.2).
 */
export function buildTicketFilterQuery(filters = {}) {
  const query = {};

  for (const key of ['assigneeIds', 'categories', 'environmentIds', 'externalReviewStates', 'projectIds', 'releaseIds', 'severities', 'statusValues']) {
    const value = filters[key];
    if (Array.isArray(value) && value.length > 0) query[key] = [...value];
  }

  if (String(filters.search ?? '').trim()) query.search = String(filters.search).trim();
  if (filters.reopened) query.reopened = true;
  if (filters.limit) query.limit = filters.limit;
  if (filters.cursor) query.cursor = filters.cursor;

  return query;
}

export function createTicketFilterState(overrides = {}) {
  return {
    assigneeIds: [],
    categories: [],
    cursor: '',
    environmentIds: [],
    externalReviewStates: [],
    limit: 50,
    projectIds: [],
    releaseIds: [],
    reopened: false,
    search: '',
    severities: [],
    statusValues: [],
    ...overrides,
  };
}
