import { createHash, randomBytes } from 'node:crypto';

// Stakeholder links for the client portal.
//
// A link is shown once when it is created and stored only as a SHA-256 hash. Its lifetime
// is computed from data each time it is used, so no scheduled job is needed:
//   - revoked links are never valid;
//   - while the stakeholder has an active involvement (an assigned open topic or an
//     invitation to an open round, or a signature they have not given yet) the link is valid;
//   - otherwise it stays valid for 14 days after the last involvement ended, counting the
//     moment the link was issued as an involvement so a new link is not dead on arrival;
//   - an admin or manager can extend it to a later date.

export const INVOLVEMENT_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_TOPIC_STATUSES = new Set(['open', 'answered']);

export function generateAccessToken() {
  return randomBytes(32).toString('base64url');
}

export function hashAccessToken(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.valueOf() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** Returns the end of one topic involvement, or null while it is still active. */
function topicInvolvementEnd(topic) {
  const deactivatedAt = toMs(topic.deactivatedAt);
  const closedAt = OPEN_TOPIC_STATUSES.has(String(topic.status ?? 'open')) ? null : (toMs(topic.topicUpdatedAt) ?? toMs(topic.invitedAt));
  const ends = [deactivatedAt, closedAt].filter((value) => value !== null);
  return ends.length > 0 ? Math.min(...ends) : null;
}

function roundInvolvementEnd(round) {
  if (round.status === 'draft') return undefined;
  const removedAt = toMs(round.removedAt);
  const closedAt = round.status === 'open' ? null : (toMs(round.closedAt) ?? toMs(round.invitedAt));
  const ends = [removedAt, closedAt].filter((value) => value !== null);
  return ends.length > 0 ? Math.min(...ends) : null;
}

export function computeLinkStatus({ involvement = { rounds: [], topics: [] }, link, now = new Date() }) {
  const nowMs = toMs(now) ?? Date.now();
  const extendedUntilMs = toMs(link.extendedUntil);

  const ends = [toMs(link.issuedAt) ?? nowMs];
  let involvementActive = false;
  for (const topic of involvement.topics ?? []) {
    const end = topicInvolvementEnd(topic);
    if (end === null) involvementActive = true;
    else ends.push(end);
  }
  for (const round of involvement.rounds ?? []) {
    const end = roundInvolvementEnd(round);
    if (end === undefined) continue;
    if (end === null) involvementActive = true;
    else ends.push(end);
  }
  // A signer is involved while asked to sign: until they sign, decline or are removed, or the
  // request ends.
  for (const signing of involvement.signings ?? []) {
    const end = toMs(signing.endedAt);
    if (end === null) involvementActive = true;
    else ends.push(end);
  }

  const lastInvolvementEndedMs = involvementActive ? null : Math.max(...ends);
  const graceEndsMs = lastInvolvementEndedMs === null ? null : lastInvolvementEndedMs + (INVOLVEMENT_GRACE_DAYS * DAY_MS);
  const expiresMs = involvementActive
    ? null
    : Math.max(graceEndsMs, extendedUntilMs ?? Number.NEGATIVE_INFINITY);

  let status = 'active';
  if (link.revokedAt) status = 'revoked';
  else if (!involvementActive && nowMs >= expiresMs) status = 'expired';

  return {
    // null while an involvement is active: the link has no fixed end yet.
    expiresAt: involvementActive ? null : toIso(expiresMs),
    extendedUntil: toIso(extendedUntilMs),
    involvementActive,
    lastInvolvementEndedAt: toIso(lastInvolvementEndedMs),
    status,
    valid: status === 'active',
  };
}

// "Request a new link". A request is stored as a token row with this purpose: its hash is
// of a random value nobody holds and it is revoked from the start, so it never opens the
// portal, and its created_at is the request time.
export const LINK_REQUEST_PURPOSE = 'link-request';
export const LINK_REQUEST_INTERVAL_MS = DAY_MS;

/** The newest request on a link, or null. */
export function latestLinkRequest(link) {
  const requests = (link?.tokens ?? []).filter((token) => token.purpose === LINK_REQUEST_PURPOSE);
  const latest = requests.sort((left, right) => (toMs(right.createdAt) ?? 0) - (toMs(left.createdAt) ?? 0))[0] ?? null;
  return latest ? { requestedAt: latest.createdAt } : null;
}

/**
 * The request an admin or manager has not acted on yet. Issuing a token, extending, or
 * revoking the link all touch the link row, so any of them settles the request.
 */
export function pendingLinkRequest(link) {
  const latest = latestLinkRequest(link);
  if (!latest) return null;
  return (toMs(latest.requestedAt) ?? 0) > (toMs(link.updatedAt) ?? 0) ? latest : null;
}

export function buildRequirementsPortalUrl({ frontendAppUrl = '', token }) {
  const base = String(frontendAppUrl ?? '').trim().replace(/\/+$/, '');
  return `${base}/requirements/${token}`;
}
