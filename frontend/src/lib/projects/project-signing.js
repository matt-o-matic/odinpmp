// What the vault and the client portal show about signature requests (docs/document-signing).
// The API holds every rule; these helpers only word and order what it returns.

export const SIGNING_KIND_LABELS = Object.freeze({ acceptance: 'Acceptance', signoff: 'Sign-off' });

// The statements the server uses when none is given (backend signing.service.js).
export const DEFAULT_SIGNING_STATEMENTS = Object.freeze({
  acceptance: 'I have reviewed the documents listed here and accept them on behalf of my organization.',
  signoff: 'I confirm that the work described here is complete and accepted, and I sign it off on behalf of my organization.',
});

const REQUEST_STATUS = Object.freeze({
  cancelled: { icon: 'bi-x-circle', label: 'Withdrawn', tone: 'muted' },
  completed: { icon: 'bi-patch-check', label: 'Signed by everyone', tone: 'ok' },
  declined: { icon: 'bi-x-octagon', label: 'Declined', tone: 'bad' },
  pending: { icon: 'bi-hourglass-split', label: 'Waiting for signatures', tone: 'wait' },
});

const SIGNER_STATUS = Object.freeze({
  declined: { icon: 'bi-x-octagon', label: 'Declined' },
  pending: { icon: 'bi-hourglass-split', label: 'Not signed yet' },
  removed: { icon: 'bi-dash-circle', label: 'Removed' },
  signed: { icon: 'bi-check2-circle', label: 'Signed' },
});

const EVENT_LABELS = Object.freeze({
  code_failed: 'entered a wrong code',
  code_sent: 'asked for a signing code',
  cancelled: 'withdrew the request',
  completed: 'Everyone has signed',
  declined: 'declined',
  reminded: 'sent a reminder',
  requested: 'asked for signatures',
  signed: 'signed',
  signer_removed: 'removed a signer',
});

const MAIL_REASONS = Object.freeze({
  'link-revoked': 'their portal link is turned off',
  'mail-not-configured': 'email is not set up on this server',
  'queue-failed': 'the email could not be queued',
});

export function signingStatus(status) {
  return REQUEST_STATUS[status] ?? { icon: 'bi-question-circle', label: String(status ?? ''), tone: 'muted' };
}

export function signerStatus(status) {
  return SIGNER_STATUS[status] ?? { icon: 'bi-question-circle', label: String(status ?? '') };
}

export function signingKindLabel(kind) {
  return SIGNING_KIND_LABELS[kind] ?? 'Signature';
}

/** "1 of 2 signed", from the API's progress. */
export function signingProgressLabel(progress) {
  const signed = Number(progress?.signed ?? 0);
  const total = Number(progress?.total ?? 0);
  return `${signed} of ${total} signed`;
}

/** One line for an audit event: who did what. */
export function signingEventLine(event) {
  const what = EVENT_LABELS[event?.action] ?? String(event?.action ?? '').replace(/_/g, ' ');
  if (event?.action === 'completed') return what;
  const who = event?.actor?.name || (String(event?.actor?.id ?? '').startsWith('stakeholder:') ? 'A stakeholder' : 'Someone');
  return `${who} ${what}`;
}

/** Why a signer's email did not go, or '' when it went. */
export function signerMailProblem(signer) {
  if (!signer?.mail || signer.mail.status !== 'not-sent') return '';
  return `Email not sent: ${MAIL_REASONS[signer.mail.reason] ?? 'it could not be sent'}.`;
}

/** The requests a file is in, newest first. */
export function requestsForFile(requests = [], fileId) {
  return requests
    .filter((request) => (request.documents ?? []).some((document) => document.fileId === fileId) || (request.subject?.type === 'file' && request.subject?.id === fileId))
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
}

/** Whether a file is in a request that keeps it shared (pending or completed). */
export function fileUnderSignature(requests = [], fileId) {
  return requestsForFile(requests, fileId).some((request) => request.status === 'pending' || request.status === 'completed');
}

/** The message a person can act on for a signing error. */
export function signingErrorMessage(error, fallback) {
  const details = error?.data?.details;
  // A body the API refused names each field's problem.
  if (Array.isArray(details) && details[0]?.message) return details[0].message;
  const code = details?.code;
  if (code === 'signing_not_configured') return 'Signing is not set up on this server yet. Ask an administrator to add the seal key.';
  if (code === 'file_under_signature') return 'This file is in a signature request, so it stays shared and cannot be deleted.';
  if (code === 'stakeholder_link_revoked') return error.message;
  // Odin answers people without decision rights as if the project were not there.
  if (error?.status === 404 && !code) return 'Only project admins and managers can do this.';
  return error?.message || fallback;
}

/** The browser details a signature keeps as supporting evidence. */
export function browserEvidence(host = globalThis) {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    timeZone = '';
  }
  return {
    language: String(host.navigator?.language ?? '').slice(0, 100),
    platform: String(host.navigator?.platform ?? '').slice(0, 200),
    timeZone: String(timeZone).slice(0, 200),
  };
}

/** A date and time for signature history. */
export function signingTimeLabel(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', year: 'numeric' });
}
