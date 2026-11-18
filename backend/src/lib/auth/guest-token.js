import { createHash, randomBytes } from 'node:crypto';

// Guest session tokens (docs/engagements/plan.md, Guests; qna.md Q-03). A guest is a principal of
// its own: their token travels as members' tokens do (an HttpOnly cookie, or a bearer token), but
// it is an opaque random value with its own prefix, never a member JWT. Member routes refuse it
// by the prefix (lib/http/auth-middleware.js); only /api/guest accepts it.

export const GUEST_TOKEN_PREFIX = 'odin_guest_';

export function generateGuestToken() {
  return `${GUEST_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function isGuestToken(token) {
  return String(token ?? '').startsWith(GUEST_TOKEN_PREFIX);
}

/** What the database keeps of a token: its SHA-256. */
export function hashGuestToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

/**
 * The CSRF value for a cookie session, derived from its token, so it needs no stored secret and
 * no one without the token can make it. The browser reads it from a cookie and sends it back in
 * X-CSRF-Token on writes.
 */
export function guestCsrfFor(token) {
  return createHash('sha256').update(`csrf:${String(token ?? '')}`).digest('base64url');
}
