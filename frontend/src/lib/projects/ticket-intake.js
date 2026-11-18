// External ticket intake (D-011, D-021): helpers shared by the reporter's public page
// (/report/:token) and the project's Intake links tab.

export const DEFAULT_ATTACHMENT_LIMITS = Object.freeze({
  allowedTypes: ['application/pdf', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/csv', 'text/plain'],
  maxBytes: 10 * 1024 * 1024,
  maxCount: 5,
  maxTotalBytes: 20 * 1024 * 1024,
});

const TYPE_LABELS = {
  'application/pdf': 'PDF',
  'image/gif': 'GIF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'text/csv': 'CSV',
  'text/plain': 'plain text',
};

// Ticket states a reporter reads as finished. Anything else, including custom states, is open.
const CLOSED_STATUSES = new Set(['closed', 'deferred', 'rejected', 'resolved']);

export function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function attachmentTypesText(limits = DEFAULT_ATTACHMENT_LIMITS) {
  const labels = [...new Set((limits.allowedTypes ?? []).map((type) => TYPE_LABELS[type] ?? type))];
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

export function attachmentLimitsText(limits = DEFAULT_ATTACHMENT_LIMITS) {
  return `Up to ${limits.maxCount} files, ${formatFileSize(limits.maxBytes)} each and ${formatFileSize(limits.maxTotalBytes)} in total. ${attachmentTypesText(limits)}.`;
}

/**
 * Checks chosen files against the server's limits before anything is read or sent.
 * `files` are File-like objects ({ name, size, type }). Returns one message per problem.
 */
export function validateAttachments(files, limits = DEFAULT_ATTACHMENT_LIMITS) {
  const problems = [];
  const list = Array.from(files ?? []);
  if (list.length > limits.maxCount) problems.push(`Attach at most ${limits.maxCount} files.`);
  for (const file of list) {
    if (!limits.allowedTypes.includes(file.type)) problems.push(`${file.name} isn’t a supported file type. Use ${attachmentTypesText(limits)}.`);
    else if (!file.size) problems.push(`${file.name} is empty.`);
    else if (file.size > limits.maxBytes) problems.push(`${file.name} is larger than ${formatFileSize(limits.maxBytes)}.`);
  }
  const total = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  if (total > limits.maxTotalBytes) problems.push(`Together the files are larger than ${formatFileSize(limits.maxTotalBytes)}.`);
  return problems;
}

/** Reads a File as base64 without its data-URL prefix. */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn’t read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * Field messages from a 400 validation response (`details: [{ path, message }]`), keyed by
 * the form field they belong to; anything unmatched comes back under `form`.
 */
export function submissionFieldErrors(error) {
  const details = Array.isArray(error?.data?.details) ? error.data.details : [];
  const errors = {};
  for (const detail of details) {
    const field = String(detail?.path ?? '').split('.')[0] || 'form';
    errors[field] ??= field === 'name' ? 'Enter a summary of up to 200 characters.' : 'Check this field.';
  }
  return errors;
}

export function isClosedTicketStatus(status) {
  return CLOSED_STATUSES.has(String(status ?? ''));
}

/**
 * Narrows and pages a reporter's tickets. `filter` is 'all', 'open', or 'closed'; tickets
 * arrive newest first and keep that order.
 */
export function filterReporterTickets(tickets, { filter = 'all', limit = Infinity } = {}) {
  const matching = (tickets ?? []).filter((ticket) => filter === 'all' || (filter === 'closed') === isClosedTicketStatus(ticket.status));
  return { total: matching.length, visible: matching.slice(0, limit) };
}

/** 'active', 'expired', or 'revoked' for an intake invitation. */
export function intakeLinkState(invitation, now = Date.now()) {
  if (invitation?.revokedAt) return 'revoked';
  if (invitation?.expiresAt && Date.parse(invitation.expiresAt) <= now) return 'expired';
  return 'active';
}

export const INTAKE_LINK_STATE_LABELS = Object.freeze({ active: 'Active', expired: 'Expired', revoked: 'Revoked' });

/** Intake links for the team's tab, newest first, narrowed by state and reporter text. */
export function filterIntakeLinks(invitations, { query = '', state = 'active' } = {}, now = Date.now()) {
  const needle = String(query ?? '').trim().toLowerCase();
  return [...(invitations ?? [])]
    .filter((invitation) => state === 'all' || intakeLinkState(invitation, now) === state)
    .filter((invitation) => !needle || `${invitation.reporterName ?? ''} ${invitation.reporterEmail ?? ''}`.toLowerCase().includes(needle))
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
}
