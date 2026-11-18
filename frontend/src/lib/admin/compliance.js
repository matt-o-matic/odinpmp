// Pure helpers for the tenant compliance admin screens. The API contract lives in
// backend/src/modules/compliance/compliance.schema.js; the limits below mirror it so the
// forms can explain a problem before the server rejects it.

export const COMPLIANCE_SECTIONS = [
  { icon: 'bi-sliders', key: 'policy', label: 'Policy' },
  { icon: 'bi-file-earmark-lock', key: 'exports', label: 'Audit exports' },
  { icon: 'bi-shield-lock', key: 'legal-holds', label: 'Legal holds' },
  { icon: 'bi-patch-check', key: 'attestations', label: 'Attestations' },
  { icon: 'bi-person-x', key: 'privacy', label: 'Privacy erasure' },
];

export const DATA_REGIONS = [
  { label: 'Australia', value: 'au' },
  { label: 'Canada', value: 'ca' },
  { label: 'European Union', value: 'eu' },
  { label: 'United Kingdom', value: 'uk' },
  { label: 'United States', value: 'us' },
];

export const POLICY_LIMITS = {
  auditRetentionDays: { max: 3650, min: 30 },
  privacyDeletionDays: { max: 365, min: 1 },
  wormRetentionDays: { max: 3650, min: 30 },
};

// `picker` names the list the hold dialog offers for a type; null means a typed record ID.
export const LEGAL_HOLD_RESOURCE_TYPES = [
  { label: 'Project', picker: 'project', value: 'project' },
  { label: 'Person (privacy subject)', picker: 'user', value: 'privacy_subject' },
  { label: 'Audit export', picker: 'export', value: 'audit_export' },
  { label: 'File', picker: null, value: 'file' },
  { label: 'Report', picker: null, value: 'report' },
  { label: 'Financial entry', picker: null, value: 'financial_entry' },
  { label: 'Connector object', picker: null, value: 'connector_object' },
];

// Control themes, offered as suggestions only.
export const CONTROL_KEY_SUGGESTIONS = [
  'logical_access',
  'change_accountability',
  'evidence_integrity',
  'data_retention',
  'legal_hold',
  'data_residency',
  'recoverability',
  'availability_monitoring',
  'privacy_rights',
  'security_monitoring',
];

export const CONTROL_KEY_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/;
export const HOLD_REASON_LIMITS = { max: 4000, min: 10 };
export const ERASURE_REASON_LIMITS = { max: 2000, min: 10 };
export const ATTESTATION_STATEMENT_LIMITS = { max: 8000, min: 20 };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function regionLabel(value) {
  return DATA_REGIONS.find((region) => region.value === value)?.label ?? String(value ?? '').toUpperCase();
}

export function resourceTypeLabel(value) {
  return LEGAL_HOLD_RESOURCE_TYPES.find((type) => type.value === value)?.label ?? String(value ?? '');
}

export function shortHash(value, length = 12) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}…` : text || '—';
}

// Maps API failures to text an administrator can act on. Server messages are already written
// for people, so they are kept and given the context the status code implies.
export function complianceErrorMessage(error, fallback = 'The compliance request failed.') {
  const status = Number(error?.status ?? 0);
  const message = String(error?.message ?? '').trim();
  const code = error?.data?.details?.code;

  if (code === 'compliance_version_conflict') {
    return 'Someone else changed this record after you opened it. The latest version has been loaded; review it and try again.';
  }
  if (status === 423) {
    return `Blocked by a legal hold. ${message || 'Release the hold before making this change.'}`;
  }
  if (status === 503) {
    return 'Immutable evidence storage is not configured for this environment, so audit exports cannot be written or read. Ask the platform operator to enable S3 Object Lock storage.';
  }
  if (status === 413) {
    return message || 'The selected range has too many audit events. Choose a shorter date range.';
  }
  if (status === 400 && Array.isArray(error?.data?.details) && error.data.details.length) {
    return `Check the form: ${error.data.details.map((detail) => detail.message).join(' ')}`;
  }
  if (status === 404) {
    return 'That record no longer exists or is not visible to you. Refresh and try again.';
  }
  return message || fallback;
}

export function policyDraftFrom(policy = {}) {
  return {
    auditRetentionDays: Number(policy.auditRetentionDays ?? 365),
    dataRegion: policy.dataRegion ?? 'us',
    legalHold: Boolean(policy.legalHold),
    privacyDeletionDays: Number(policy.privacyDeletionDays ?? 30),
    wormRetentionDays: Number(policy.wormRetentionDays ?? 365),
  };
}

export function validatePolicyDraft(draft) {
  const errors = {};
  for (const [field, { max, min }] of Object.entries(POLICY_LIMITS)) {
    const value = Number(draft[field]);
    if (!Number.isInteger(value) || value < min || value > max) errors[field] = `Enter a whole number from ${min} to ${max}.`;
  }
  if (!DATA_REGIONS.some((region) => region.value === draft.dataRegion)) errors.dataRegion = 'Choose a data region.';
  return errors;
}

export function policyPayload(draft, expectedVersion) {
  return {
    auditRetentionDays: Number(draft.auditRetentionDays),
    dataRegion: draft.dataRegion,
    expectedVersion: Number(expectedVersion ?? 0),
    legalHold: Boolean(draft.legalHold),
    privacyDeletionDays: Number(draft.privacyDeletionDays),
    wormRetentionDays: Number(draft.wormRetentionDays),
  };
}

export function validateDateRange(start, end, { endLabel = 'End date', startLabel = 'Start date' } = {}) {
  const errors = {};
  if (!DATE_PATTERN.test(String(start ?? ''))) errors.start = `${startLabel} is required.`;
  if (!DATE_PATTERN.test(String(end ?? ''))) errors.end = `${endLabel} is required.`;
  if (!errors.start && !errors.end && end < start) errors.end = `${endLabel} must be on or after ${startLabel.toLowerCase()}.`;
  return errors;
}

export function textLengthError(value, { max, min }, label) {
  const length = String(value ?? '').trim().length;
  if (length < min) return `${label} needs at least ${min} characters.`;
  if (length > max) return `${label} must be ${max} characters or fewer.`;
  return '';
}

export function parseEvidenceRefs(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function validateAttestationDraft(draft) {
  const errors = {};
  if (!CONTROL_KEY_PATTERN.test(String(draft.controlKey ?? '').trim())) {
    errors.controlKey = 'Use 3 to 128 lowercase letters, digits, dots, dashes, or underscores, starting with a letter.';
  }
  const range = validateDateRange(draft.periodStart, draft.periodEnd, { endLabel: 'Period end', startLabel: 'Period start' });
  if (range.start) errors.periodStart = range.start;
  if (range.end) errors.periodEnd = range.end;
  const statementError = textLengthError(draft.statement, ATTESTATION_STATEMENT_LIMITS, 'The statement');
  if (statementError) errors.statement = statementError;
  const refs = parseEvidenceRefs(draft.evidenceText);
  if (refs.length < 1) errors.evidenceText = 'Add at least one evidence reference, one per line.';
  else if (refs.length > 100) errors.evidenceText = 'Add at most 100 evidence references.';
  else if (refs.some((ref) => ref.length > 500)) errors.evidenceText = 'Each evidence reference must be 500 characters or fewer.';
  return errors;
}

export function attestationPayload(draft) {
  return {
    controlKey: String(draft.controlKey).trim(),
    evidenceRefs: parseEvidenceRefs(draft.evidenceText),
    periodEnd: draft.periodEnd,
    periodStart: draft.periodStart,
    statement: String(draft.statement).trim(),
  };
}

// The API refuses execution by the requesting admin; the screen hides the action to match.
export function canExecuteErasure(request, currentUserId) {
  return request?.status === 'pending' && Boolean(currentUserId) && request.requestedBy !== currentUserId;
}

export function erasureResultSummary(result) {
  if (!result) return '';
  const parts = [];
  if (result.identityPseudonymized) parts.push('identity pseudonymized');
  if (result.sessionsRevoked === true) parts.push('sessions revoked');
  else if (Number.isFinite(result.sessionsRevoked)) parts.push(`${result.sessionsRevoked} sessions revoked`);
  if (Number.isFinite(result.projectMembershipsRemoved)) parts.push(`${result.projectMembershipsRemoved} project memberships removed`);
  if (Number.isFinite(result.memoriesDeleted)) parts.push(`${result.memoriesDeleted} memories deleted`);
  if (Number.isFinite(result.connectorErasuresQueued) && result.connectorErasuresQueued > 0) parts.push(`${result.connectorErasuresQueued} connector erasures queued`);
  return parts.join(', ');
}

export function matchesQuery(values, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(needle));
}

export function sortByTimestamp(items, field, direction = 'desc') {
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => sign * String(left?.[field] ?? '').localeCompare(String(right?.[field] ?? '')));
}

export function paginate(items, page, pageSize = 25) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pageCount);
  return { items: items.slice((current - 1) * pageSize, current * pageSize), page: current, pageCount };
}

export function isoDate(value) {
  return value ? String(value).slice(0, 10) : '';
}

// Audit exports store an exclusive end instant; show the inclusive last day the admin chose.
export function exportRangeLabel(item) {
  const start = isoDate(item?.startAt);
  const endExclusive = item?.endAt ? new Date(item.endAt) : null;
  if (!start || !endExclusive || Number.isNaN(endExclusive.valueOf())) return start || '—';
  endExclusive.setUTCDate(endExclusive.getUTCDate() - 1);
  const end = endExclusive.toISOString().slice(0, 10);
  return start === end ? start : `${start} to ${end}`;
}
