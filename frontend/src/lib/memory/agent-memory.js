export const MEMORY_PAGE_SIZE = 25;
export const PERSONAL_SCOPE = 'personal';

export const MEMORY_TYPES = Object.freeze([
  { label: 'Decision', value: 'decision' },
  { label: 'Preference', value: 'preference' },
  { label: 'Fact', value: 'fact' },
  { label: 'Risk', value: 'risk' },
  { label: 'Change', value: 'change' },
  { label: 'Meeting', value: 'meeting' },
  { label: 'Outcome', value: 'outcome' },
  { label: 'Episode', value: 'episode' },
]);

export const MEMORY_SENSITIVITIES = Object.freeze([
  { hint: 'Fine to share outside the workspace.', label: 'Public', value: 'public' },
  { hint: 'Anyone who can see the project.', label: 'Internal', value: 'internal' },
  { hint: 'Anyone who can see the project; handle with care.', label: 'Confidential', value: 'confidential' },
  { hint: 'Only you and workspace admins.', label: 'Restricted', value: 'restricted' },
]);

export const MEMORY_SORTS = Object.freeze([
  { label: 'Newest first', value: 'newest' },
  { label: 'Oldest first', value: 'oldest' },
  { label: 'Most confident', value: 'confidence' },
]);

const SOURCE_LABELS = Object.freeze({
  approved_assistant_run: 'Changes applied in the AI Workspace',
  person: 'Added by a person',
});

function single(value) {
  return String((Array.isArray(value) ? value[0] : value) ?? '').trim();
}

function oneOf(value, options, fallback = '') {
  return options.some((option) => option.value === value) ? value : fallback;
}

export function memoryTypeLabel(value) {
  return MEMORY_TYPES.find((option) => option.value === value)?.label ?? 'Memory';
}

export function sensitivityLabel(value) {
  return MEMORY_SENSITIVITIES.find((option) => option.value === value)?.label ?? 'Internal';
}

export function createMemoryFilterState(routeQuery = {}) {
  const page = Number.parseInt(single(routeQuery.page), 10);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    project: single(routeQuery.project),
    query: single(routeQuery.q),
    sensitivity: oneOf(single(routeQuery.sensitivity), MEMORY_SENSITIVITIES),
    sort: oneOf(single(routeQuery.sort), MEMORY_SORTS, 'newest'),
    type: oneOf(single(routeQuery.type), MEMORY_TYPES),
  };
}

export function memoryFiltersToRouteQuery(filters) {
  const query = {};
  if (filters.project) query.project = filters.project;
  if (filters.query.trim()) query.q = filters.query.trim();
  if (filters.type) query.type = filters.type;
  if (filters.sensitivity) query.sensitivity = filters.sensitivity;
  if (filters.sort !== 'newest') query.sort = filters.sort;
  if (filters.page > 1) query.page = String(filters.page);
  return query;
}

export function buildMemoryBrowseQuery(filters, pageSize = MEMORY_PAGE_SIZE) {
  return {
    limit: pageSize,
    offset: (Math.max(1, filters.page) - 1) * pageSize,
    project: filters.project,
    query: filters.query.trim(),
    sensitivities: filters.sensitivity ? [filters.sensitivity] : [],
    sort: filters.sort,
    types: filters.type ? [filters.type] : [],
  };
}

export function pageSummary({ count, offset, total }) {
  if (!total) return 'No memories';
  return `Showing ${offset + 1}–${offset + count} of ${total}`;
}

export function memorySourceLabel(memory) {
  const sourceType = String(memory?.provenance?.sourceType ?? '').trim();
  if (!sourceType) return 'Unknown source';
  if (SOURCE_LABELS[sourceType]) return SOURCE_LABELS[sourceType];
  const words = sourceType.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function safeSourceUrl(memory) {
  const value = String(memory?.provenance?.sourceUrl ?? '').trim();
  return /^https?:\/\//i.test(value) ? value : '';
}

export function confidenceLabel(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '—';
}

export function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function toDateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

// Why Forget or Correct is unavailable, shown next to the disabled control.
export function memoryChangeBlockedReason(memory) {
  if (memory?.legalHold) return 'On legal hold. It can’t be corrected or forgotten until an admin releases the hold.';
  if (!memory?.canForget) return 'Only the person who added it, project editors, and admins can change it.';
  return '';
}

// Confidence is stored from 0 to 1 and edited as a whole percentage.
function confidencePercent(value) {
  const number = Number(value ?? 1);
  return Number.isFinite(number) ? Math.round(number * 100) : 100;
}

export function createMemoryForm(memory = null, { project = '' } = {}) {
  return {
    confidence: confidencePercent(memory?.confidence),
    content: memory?.content ?? '',
    memoryType: memory?.memoryType ?? 'decision',
    project: memory ? memory.projectId ?? PERSONAL_SCOPE : project || PERSONAL_SCOPE,
    sensitivity: memory?.sensitivity ?? 'internal',
    title: memory?.title ?? '',
  };
}

export function validateMemoryForm(form) {
  const errors = {};
  if (!form.title.trim()) errors.title = 'Give the memory a short title.';
  else if (form.title.trim().length > 255) errors.title = 'Keep the title under 255 characters.';
  if (!form.content.trim()) errors.content = 'Say what the AI should remember.';
  else if (form.content.trim().length > 20_000) errors.content = 'Keep it under 20,000 characters.';
  const confidence = Number(form.confidence);
  if (form.confidence === '' || form.confidence == null || !Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    errors.confidence = 'Enter a whole number from 0 to 100.';
  }
  return errors;
}

export function buildNewMemoryPayload(form, now = new Date()) {
  return {
    confidence: 1,
    content: form.content.trim(),
    memoryType: form.memoryType,
    projectId: form.project && form.project !== PERSONAL_SCOPE ? form.project : null,
    provenance: { sourceType: 'person' },
    sensitivity: form.sensitivity,
    sourceAt: now.toISOString(),
    title: form.title.trim(),
  };
}

// Only fields the person changed are sent; null means there is nothing to save.
export function buildCorrectionPayload(memory, form) {
  const next = { content: form.content.trim(), memoryType: form.memoryType, sensitivity: form.sensitivity, title: form.title.trim() };
  const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== memory[key]));
  if (Number(form.confidence) !== confidencePercent(memory.confidence)) changes.confidence = Number(form.confidence) / 100;
  return Object.keys(changes).length ? { ...changes, expectedVersion: memory.version } : null;
}

export function createGovernanceForm(memory) {
  return {
    expiresOn: toDateInputValue(memory?.expiresAt),
    legalHold: Boolean(memory?.legalHold),
    retentionPolicyId: memory?.retentionPolicyId ?? '',
  };
}

export function buildGovernancePayload(memory, form) {
  return {
    expectedVersion: memory.version,
    // An expiry date means the memory lapses at the end of that day (UTC).
    expiresAt: form.expiresOn ? `${form.expiresOn}T23:59:59.999Z` : null,
    legalHold: Boolean(form.legalHold),
    retentionPolicyId: form.retentionPolicyId.trim() || null,
  };
}

export function memoryErrorMessage(error, fallback) {
  if (error?.status === 409) return 'This memory changed since the list loaded. The list has been refreshed; try again.';
  return error?.message || fallback;
}
