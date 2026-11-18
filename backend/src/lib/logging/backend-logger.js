function sanitizeLogValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array:${value.length}]`;
    }
    return value.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    if (depth >= 2) {
      return '[object]';
    }

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, entryValue]) => [key, sanitizeLogValue(entryValue, depth + 1)]),
    );
  }

  return String(value);
}

const STDERR_LEVELS = new Set(['warn', 'error', 'fatal']);

function emitLogEntry(entry) {
  const serialized = JSON.stringify(entry);
  const level = String(entry?.level ?? '').trim().toLowerCase();

  if (STDERR_LEVELS.has(level)) {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

function serializeError(error) {
  if (!error) {
    return {
      message: 'Unknown error',
      name: 'Error',
      stack: null,
    };
  }

  return {
    code: error.code ?? null,
    details: sanitizeLogValue(error.details ?? null),
    message: error.message ?? String(error),
    name: error.name ?? 'Error',
    stack: typeof error.stack === 'string' ? error.stack : null,
    statusCode: error.statusCode ?? error.status ?? null,
  };
}

// Public routes whose only credential is the URL segment right after their mount path
// (app.js): the client portal, single-use package upload URLs, clarification links,
// and ticket intake links. Request logs redact that segment by position, however it is spelled, and any
// parameter or query value equal to it. Working from the URL alone also covers requests
// that fail before any router runs, such as a malformed JSON body. The app's Apache vhost
// keeps the same URLs out of its access log.
const CREDENTIAL_MOUNTS = Object.freeze([
  ['api', 'public', 'requirements'],
  ['api', 'public', 'requirements-uploads'],
  ['api', 'public', 'clarifications'],
  ['api', 'public', 'ticket-intake'],
]);
const CREDENTIAL_PARAMS = new Set(['accessToken', 'intakeToken', 'token', 'uploadToken']);
const REDACTED = '[redacted]';

function decodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

/** `{ route, secrets }`: the URL with its credential segment redacted, and that credential decoded. */
export function redactCredentialUrl(url) {
  const text = String(url ?? '');
  const queryStart = text.indexOf('?');
  const segments = (queryStart === -1 ? text : text.slice(0, queryStart)).split('/');
  const query = queryStart === -1 ? null : text.slice(queryStart + 1);
  // Matched as the router matches: decoded and case-insensitive. Empty segments are skipped.
  const named = segments
    .map((segment, index) => ({ index, name: decodeComponent(segment).toLowerCase() }))
    .filter((entry) => entry.name);
  const secrets = new Set();
  for (const mount of CREDENTIAL_MOUNTS) {
    const credential = named[mount.length];
    if (!credential || !mount.every((name, position) => named[position].name === name)) continue;
    secrets.add(decodeComponent(segments[credential.index]));
    segments[credential.index] = REDACTED;
  }
  if (secrets.size === 0) return { route: text, secrets };
  const redactedQuery = query === null ? null : query.split('&').map((pair) => {
    const separator = pair.indexOf('=');
    if (separator === -1) return pair;
    return secrets.has(decodeComponent(pair.slice(separator + 1).replaceAll('+', ' '))) ? `${pair.slice(0, separator + 1)}${REDACTED}` : pair;
  });
  return { route: `${segments.join('/')}${redactedQuery === null ? '' : `?${redactedQuery.join('&')}`}`, secrets };
}

function redactValues(value, secrets) {
  if (typeof value === 'string') return secrets.has(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((item) => redactValues(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValues(entry, secrets)]));
  }
  return value;
}

export function buildRequestLogContext(request, extra = {}) {
  const { route, secrets } = redactCredentialUrl(request.originalUrl ?? request.url ?? '');
  for (const [key, value] of Object.entries(request.params ?? {})) {
    if (CREDENTIAL_PARAMS.has(key) && typeof value === 'string' && value) secrets.add(value);
  }
  return sanitizeLogValue({
    bodyKeys: Object.keys(request.body ?? {}),
    headersSent: request.res?.headersSent ?? false,
    method: request.method,
    params: redactValues(request.params ?? {}, secrets),
    query: redactValues(request.query ?? {}, secrets),
    requestId: request.requestId ?? request.id ?? null,
    route,
    routePattern: request.route?.path ?? null,
    tenantId: request.auth?.user?.memberships?.[0]?.tenantId ?? null,
    userId: request.auth?.user?.id ?? null,
    ...extra,
  });
}

export function buildOperationLogContext(operation, extra = {}) {
  return sanitizeLogValue({
    operation: String(operation ?? '').trim() || 'unknown',
    ...extra,
  });
}

export function buildJobLogContext(job, extra = {}) {
  return sanitizeLogValue({
    job: String(job ?? '').trim() || 'unknown',
    ...extra,
  });
}

export function logBackendError({
  context = {},
  error,
  level = 'error',
  message = 'Backend request failed.',
}) {
  const entry = {
    at: new Date().toISOString(),
    context: sanitizeLogValue(context),
    error: serializeError(error),
    level,
    message,
  };

  emitLogEntry(entry);
}

export function logBackendEvent({
  context = {},
  level = 'info',
  message = 'Backend event.',
}) {
  const entry = {
    at: new Date().toISOString(),
    context: sanitizeLogValue(context),
    level,
    message,
  };

  emitLogEntry(entry);
}
