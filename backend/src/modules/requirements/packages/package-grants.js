import { createHmac, timingSafeEqual } from 'node:crypto';

// Package grants (plan.md, "Hosting and isolation"). A grant is the capability in a review
// origin URL: /p/<packageId>/<grant>/<path>. It names the package, one of its screens, and
// the viewer, expires, and is signed with HMAC-SHA256 under REVIEW_GRANT_SECRET:
//
//   grant = base64url(JSON { p: packageId, s: screenId, v: viewerRef, e: expiresAtSeconds, l?: linkId, t?: tokenId }) "." base64url(hmac)
//
// The review origin serves a grant only the files its screen may load (package-scope.js). A
// stakeholder's grant also names the portal link and token it was issued through, so the
// review origin can stop serving it when that token or link is revoked (package-grant-access.js).
// The HMAC covers the encoded payload exactly as it appears in the URL.

export const DEFAULT_GRANT_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEVELOPMENT_GRANT_SECRET = 'odin-local-review-grant-secret-do-not-use-in-production';

function sign(secret, payload) {
  return createHmac('sha256', String(secret)).update(payload).digest('base64url');
}

export function createPackageGrant({ expiresAt, linkId = null, packageId, screenId, secret, tokenId = null, viewerRef }) {
  if (!secret) throw new Error('A review grant secret is required.');
  if (!screenId) throw new Error('A grant needs a screen.');
  const exp = Math.floor(new Date(expiresAt).valueOf() / 1000);
  if (!Number.isFinite(exp)) throw new Error('A grant needs a valid expiry.');
  const claims = { e: exp, p: String(packageId), s: String(screenId), v: String(viewerRef) };
  if (linkId) claims.l = String(linkId);
  if (tokenId) claims.t = String(tokenId);
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Returns `{ packageId, screenId, viewerRef, expiresAt, linkId, tokenId }` for a valid grant
 * for this package, or null for anything else: malformed, tampered, expired, issued for
 * another package, or naming no screen. linkId and tokenId are null for grants that do not
 * name them.
 */
export function verifyPackageGrant({ grant, now = new Date(), packageId, secret }) {
  if (!secret || typeof grant !== 'string' || grant.length > 2048) return null;
  const parts = grant.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const expected = Buffer.from(sign(secret, parts[0]), 'utf8');
  const provided = Buffer.from(parts[1], 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_error) {
    return null;
  }
  if (!payload || typeof payload.p !== 'string' || typeof payload.s !== 'string' || typeof payload.v !== 'string' || !Number.isInteger(payload.e)) return null;
  if ((payload.l !== undefined && typeof payload.l !== 'string') || (payload.t !== undefined && typeof payload.t !== 'string')) return null;
  if (payload.p !== String(packageId)) return null;
  if (payload.e * 1000 <= new Date(now).valueOf()) return null;
  return {
    expiresAt: new Date(payload.e * 1000).toISOString(),
    linkId: payload.l ?? null,
    packageId: payload.p,
    screenId: payload.s,
    tokenId: payload.t ?? null,
    viewerRef: payload.v,
  };
}
