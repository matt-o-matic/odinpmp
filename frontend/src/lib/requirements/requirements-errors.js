// Turns Requirements API errors into a code, a message people can act on, and whether a
// retry makes sense. The API answers `{ ok: false, error, details }`; some routes put a
// code in `error` and the human text in `details.message`, others the reverse.

/** Shown wherever a review question or portal question link points at a deleted or dismissed topic. */
export const QUESTION_REMOVED_MESSAGE = 'This question has been removed and no longer needs an answer.';

const KNOWN_ERRORS = Object.freeze({
  ai_not_configured: {
    message: 'Odin can’t draft questions because no AI provider is set up for this workspace. A workspace admin can add one in the AI settings.',
    retryable: false,
  },
  ai_output_invalid: {
    message: 'Odin returned questions in an unexpected shape, so nothing was added. Try again.',
    retryable: true,
  },
  ai_request_failed: {
    message: 'Odin couldn’t reach the AI provider, so nothing was added. Try again.',
    retryable: true,
  },
  brief_empty: {
    message: 'The project brief is empty. Add requirements, constraints, or an objective to the brief first.',
    retryable: false,
  },
  comments_closed: {
    message: 'Comments are closed for this topic.',
    retryable: false,
  },
  decision_exists: {
    message: 'This topic already has a decision. The latest one is shown now; replace it if it needs to change.',
    retryable: false,
  },
  decision_version_conflict: {
    message: 'This decision changed since you opened it. The latest version is shown now.',
    retryable: false,
  },
  link_revoked: {
    message: 'This link was revoked. Create a new link instead.',
    retryable: false,
  },
  question_removed: {
    message: QUESTION_REMOVED_MESSAGE,
    retryable: false,
  },
  topic_has_activity: {
    // Round answers can exist without a comment in the thread, so they get their own reason.
    message: (details) => (Number(details.activity?.answers) > 0
      ? 'Reviewers already answered this topic’s question in a review round, so it can’t be deleted. A project admin or manager can dismiss it instead.'
      : 'This topic already has comments, decisions, stakeholders, or files, so it can’t be deleted. A project admin or manager can dismiss it instead.'),
    retryable: false,
  },
});

const CODE_PATTERN = /^[a-z]+(?:_[a-z]+)+$/;

export function requirementsErrorCode(error) {
  const data = error?.data ?? {};
  const details = data.details && !Array.isArray(data.details) ? data.details : {};
  if (typeof details.code === 'string' && details.code) return details.code;
  if (typeof data.error === 'string' && CODE_PATTERN.test(data.error)) return data.error;
  return '';
}

export function describeRequirementsError(error, fallback = 'Something went wrong. Try again.') {
  const data = error?.data ?? {};
  const status = Number(error?.status) || 0;
  const details = data.details && !Array.isArray(data.details) ? data.details : {};
  const code = requirementsErrorCode(error);
  const known = KNOWN_ERRORS[code];
  const retryable = typeof details.retryable === 'boolean' ? details.retryable : known?.retryable ?? false;

  if (known) return { code, message: typeof known.message === 'function' ? known.message(details) : known.message, retryable, status };

  if (Array.isArray(data.details) && data.details.length > 0) {
    const first = data.details[0] ?? {};
    const field = String(first.path ?? '').trim();
    const message = String(first.message ?? '').trim();
    return { code: 'invalid_request', message: field ? `Check ${field}: ${message}` : (message || fallback), retryable: false, status };
  }

  if (typeof details.message === 'string' && details.message.trim()) {
    return { code, message: details.message.trim(), retryable, status };
  }

  if (status === 404) {
    return { code: code || 'not_found', message: 'That item no longer exists, or you don’t have access to it.', retryable: false, status };
  }

  const serverMessage = typeof data.error === 'string' && !CODE_PATTERN.test(data.error) ? data.error.trim() : '';
  if (serverMessage && serverMessage !== 'Request failed.') return { code, message: serverMessage, retryable, status };
  if (status >= 500 || status === 408) return { code, message: fallback, retryable: true, status };
  return { code, message: fallback, retryable, status };
}
