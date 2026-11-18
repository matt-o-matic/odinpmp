// Engagements list and page helpers (docs/engagements/plan.md). Pure functions, so they test
// without a browser.

export const ENGAGEMENT_STATUS_FILTERS = Object.freeze([
  { id: 'open', label: 'Open' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
  { id: 'all', label: 'All' },
]);

const STATUS_LABELS = { lost: 'Lost', open: 'Open', won: 'Won' };
const STATUS_ICONS = { lost: 'bi-x-circle', open: 'bi-circle', won: 'bi-check-circle-fill' };

// Open engagements need attention, so the list starts there.
export function normalizeEngagementStatusFilter(value) {
  const status = String(value ?? '').trim().toLowerCase();
  return ENGAGEMENT_STATUS_FILTERS.some((option) => option.id === status) ? status : 'open';
}

export function engagementStatusLabel(status) {
  return STATUS_LABELS[status] ?? 'Open';
}

export function engagementStatusIcon(status) {
  return STATUS_ICONS[status] ?? STATUS_ICONS.open;
}

/** The rows to show for a status filter and a text filter, newest activity first. */
export function filterEngagements(engagements = [], { query = '', status = 'open' } = {}) {
  const text = String(query ?? '').trim().toLowerCase();
  return engagements
    .filter((engagement) => status === 'all' || engagement.status === status)
    .filter((engagement) => !text || `${engagement.name} ${engagement.customer} ${engagement.ownerName ?? ''}`.toLowerCase().includes(text))
    .sort((left, right) => String(right.lastActivityAt ?? '').localeCompare(String(left.lastActivityAt ?? '')) || left.name.localeCompare(right.name));
}

export function engagementStatusCounts(engagements = []) {
  const counts = { all: engagements.length, lost: 0, open: 0, won: 0 };
  for (const engagement of engagements) if (engagement.status in counts) counts[engagement.status] += 1;
  return counts;
}

/** "Today", "Yesterday", "3 days ago", then the date. */
export function formatLastActivity(value, now = new Date()) {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.valueOf())) return '';
  const startOfDay = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// The sections an engagement page shows, Channels first: a new engagement opens on General.
// Board is the pursuit board and Insights the pursuit insights; an engagement has no plan,
// delivery board, sprints or requirements until it converts.
export const ENGAGEMENT_SECTIONS = Object.freeze([
  { id: 'channels', label: 'Channels' },
  { id: 'board', label: 'Board' },
  { id: 'insights', label: 'Insights' },
  { id: 'files', label: 'Files' },
  { id: 'people', label: 'People' },
  { id: 'settings', label: 'Settings' },
]);

// The section an engagement opens on, at its plain URL: its channels, on General.
export const DEFAULT_ENGAGEMENT_SECTION = 'channels';

export function normalizeEngagementSection(value) {
  const section = String(value ?? '').trim().toLowerCase();
  return ENGAGEMENT_SECTIONS.some((entry) => entry.id === section) ? section : DEFAULT_ENGAGEMENT_SECTION;
}

/** A readable message for an engagement API error. */
export function engagementErrorMessage(error, fallback) {
  const code = error?.data?.details?.code ?? error?.details?.code;
  if (code === 'module_disabled') return 'The Consulting module is switched off for this workspace.';
  if (code === 'engagement_closed') return 'This engagement is marked lost. Reopen it to make changes.';
  if (code === 'engagement_not_open') return 'Reopen the engagement first.';
  if (code === 'template_project_status_mismatch') return 'That template’s project workflow has no Planned state, so it cannot be used to convert.';
  return error?.message || fallback;
}
