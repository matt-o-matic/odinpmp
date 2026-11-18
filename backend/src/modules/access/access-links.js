import { generateAccessToken, hashAccessToken, INVOLVEMENT_GRACE_DAYS } from '../requirements/requirements-access-links.js';

// Access links. One link per workspace and email address opens what
// that address has been given there: tasks on projects where its resource without a login has
// task access, and requirements on projects where it belongs to a stakeholder whose requirements
// link is valid. The link holds no permissions; every request works them out again.
//
// Tokens are 32 random bytes, shown once and stored only as SHA-256 hashes, as requirements
// link tokens are. The lifetime follows the requirements link rule:
//   - a revoked link never works;
//   - while any grant is active, the link is valid;
//   - otherwise it stays valid for 14 days after the latest of the link being issued and the
//     last grant ending, or until its extension date when that is later.

export { generateAccessToken, hashAccessToken };

export const ACCESS_LINK_GRACE_DAYS = INVOLVEMENT_GRACE_DAYS;
export const ACCESS_TOKEN_PURPOSES = Object.freeze(['email', 'manual']);
export const TASK_ACCESS_SCOPES = Object.freeze(['own', 'all']);
// Requirements tokens an access link mints carry this purpose and `access-link:<linkId>` as
// their creator, so revoking the access link can find and revoke them.
export const REQUIREMENTS_TOKEN_PURPOSE = 'access';

const DAY_MS = 24 * 60 * 60 * 1000;

export function accessLinkCreatedBy(linkId) {
  return `access-link:${linkId}`;
}

export function normalizeAccessEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function buildAccessLinkUrl({ frontendAppUrl = '', token }) {
  const base = String(frontendAppUrl ?? '').trim().replace(/\/+$/, '');
  return `${base}/access/${token}`;
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.valueOf() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/**
 * The link's status from its grants, each `{ active, endedAt }`: `endedAt` is when an inactive
 * grant ended, or null when that is not known (it then does not count).
 */
export function computeAccessLinkStatus({ grants = [], link, now = new Date() }) {
  const nowMs = toMs(now) ?? Date.now();
  const grantActive = grants.some((grant) => grant.active);
  const ends = [toMs(link.issuedAt) ?? nowMs];
  for (const grant of grants) {
    const endedMs = grant.active ? null : toMs(grant.endedAt);
    if (endedMs !== null) ends.push(endedMs);
  }
  const extendedUntilMs = toMs(link.extendedUntil);
  const lastGrantEndedMs = grantActive ? null : Math.max(...ends);
  const expiresMs = grantActive ? null : Math.max(lastGrantEndedMs + ACCESS_LINK_GRACE_DAYS * DAY_MS, extendedUntilMs ?? Number.NEGATIVE_INFINITY);

  let status = 'active';
  if (link.revokedAt) status = 'revoked';
  else if (!grantActive && nowMs >= expiresMs) status = 'expired';

  return {
    // null while a grant is active: the link has no fixed end yet.
    expiresAt: toIso(expiresMs),
    extendedUntil: toIso(extendedUntilMs),
    grantActive,
    lastGrantEndedAt: toIso(lastGrantEndedMs),
    status,
    valid: status === 'active',
  };
}
