// Rate limits for guest sign-in: code requests per email and per IP address, and sign-in
// attempts per IP address. Keys are the normalized email or the address, so an unknown email is
// limited exactly as a guest's is. In this process only, as the other public limits are
// (lib/http/token-bucket.js).
import { createTokenBucket } from '../../lib/http/token-bucket.js';

const HOUR_SECONDS = 60 * 60;

export const DEFAULT_GUEST_RATE_LIMITS = Object.freeze({
  codesPerEmail: { capacity: 5, refillPerSecond: 5 / HOUR_SECONDS },
  codesPerIp: { capacity: 20, refillPerSecond: 20 / HOUR_SECONDS },
  signInsPerIp: { capacity: 30, refillPerSecond: 30 / (15 * 60) },
});

export function createGuestRateLimiter({ limits = DEFAULT_GUEST_RATE_LIMITS, now = () => Date.now() } = {}) {
  const codesPerEmail = createTokenBucket({ ...limits.codesPerEmail, now });
  const codesPerIp = createTokenBucket({ ...limits.codesPerIp, now });
  const signInsPerIp = createTokenBucket({ ...limits.signInsPerIp, now });
  const verdict = (result, scope) => (result.allowed ? null : { retryAfterSeconds: result.retryAfterSeconds, scope });
  return {
    checkCodeRequest({ email, ipAddress }) {
      return verdict(codesPerIp.take(`ip:${ipAddress || 'unknown'}`), 'ip') ?? verdict(codesPerEmail.take(`email:${email}`), 'email');
    },
    checkSignIn({ ipAddress }) {
      return verdict(signInsPerIp.take(`ip:${ipAddress || 'unknown'}`), 'ip');
    },
    reset() {
      codesPerEmail.reset();
      codesPerIp.reset();
      signInsPerIp.reset();
    },
  };
}
