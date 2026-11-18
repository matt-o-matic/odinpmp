export const CANONICAL_PROJECT_STATUSES = [
  'Planned',
  'In Progress',
  'At Risk',
  'Review',
  'Completed',
  'Archived',
];

export const PROJECT_STATUS_STORAGE_ALIASES = {
  'Archived': ['Archived', 'Abandoned', 'Rejected'],
  'At Risk': ['At Risk', 'Delayed'],
  'Completed': ['Completed', 'Done'],
  'In Progress': ['In Progress', 'Started', 'Active'],
  'Planned': ['Planned', 'Planning', 'Candidate'],
  'Review': ['Review', 'Under Review'],
};

export function normalizeProjectStatusKey(value = '') {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function uniqueProjectStatusCandidates(values = []) {
  const seen = new Set();
  const candidates = [];

  for (const value of values ?? []) {
    const candidate = String(value ?? '').trim();
    if (!candidate) {
      continue;
    }

    const key = normalizeProjectStatusKey(candidate);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push(candidate);
  }

  return candidates;
}

const PROJECT_STATUS_DISPLAY_BY_KEY = new Map(
  Object.entries(PROJECT_STATUS_STORAGE_ALIASES)
    .flatMap(([displayStatus, aliases]) => aliases.map((alias) => [normalizeProjectStatusKey(alias), displayStatus])),
);

const CANONICAL_PROJECT_STATUS_KEYS = new Set(
  CANONICAL_PROJECT_STATUSES.map((status) => normalizeProjectStatusKey(status)),
);

export function isCanonicalProjectStatus(statusValue = '') {
  return CANONICAL_PROJECT_STATUS_KEYS.has(normalizeProjectStatusKey(statusValue));
}

export function normalizeStoredProjectStatusForDisplay(statusValue = '') {
  const raw = String(statusValue ?? '').trim();
  if (!raw) {
    return 'Planned';
  }

  return PROJECT_STATUS_DISPLAY_BY_KEY.get(normalizeProjectStatusKey(raw)) ?? raw;
}

export function projectStatusLookupCandidates(statusValue = '') {
  const raw = String(statusValue ?? '').trim() || 'Planned';
  const canonicalStatus = normalizeStoredProjectStatusForDisplay(raw);

  return uniqueProjectStatusCandidates([
    raw,
    canonicalStatus,
    ...(PROJECT_STATUS_STORAGE_ALIASES[canonicalStatus] ?? []),
  ]);
}

export function resolveStoredProjectStatusRow(rows = [], statusValue = '') {
  const requested = String(statusValue ?? '').trim() || 'Planned';
  const exactIdMatch = rows.find((row) => String(row?.id ?? '').trim() === requested);
  if (exactIdMatch) {
    return exactIdMatch;
  }

  const rowsByKey = new Map(
    rows.map((row) => [normalizeProjectStatusKey(row?.projectStatusName ?? ''), row]),
  );

  for (const candidate of projectStatusLookupCandidates(requested)) {
    const matched = rowsByKey.get(normalizeProjectStatusKey(candidate));
    if (matched) {
      return matched;
    }
  }

  throw new Error(`Unknown project status: ${statusValue}`);
}
