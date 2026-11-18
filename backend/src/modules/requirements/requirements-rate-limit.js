// In-memory token buckets for the public requirements routes. One bucket per client IP
// and one per link (keyed by token hash, so unknown tokens are limited too). Writes cost
// more than reads. Buckets live in this process only; with several instances each one
// enforces its own limit.

import { createTokenBucket } from '../../lib/http/token-bucket.js';

export const DEFAULT_REQUIREMENTS_RATE_LIMITS = Object.freeze({
  ip: { capacity: 120, refillPerSecond: 2 },
  link: { capacity: 60, refillPerSecond: 1 },
  writeCost: 5,
});

export function createRequirementsPublicRateLimiter({
  ip = DEFAULT_REQUIREMENTS_RATE_LIMITS.ip,
  link = DEFAULT_REQUIREMENTS_RATE_LIMITS.link,
  now = () => Date.now(),
  writeCost = DEFAULT_REQUIREMENTS_RATE_LIMITS.writeCost,
} = {}) {
  const ipBuckets = createTokenBucket({ ...ip, now });
  const linkBuckets = createTokenBucket({ ...link, now });

  return {
    check({ ipAddress = '', linkKey = '', write = false }) {
      const cost = write ? writeCost : 1;
      const byIp = ipBuckets.take(`ip:${ipAddress || 'unknown'}`, cost);
      if (!byIp.allowed) return { ...byIp, scope: 'ip' };
      const byLink = linkBuckets.take(`link:${linkKey}`, cost);
      if (!byLink.allowed) return { ...byLink, scope: 'link' };
      return { allowed: true, retryAfterSeconds: 0, scope: null };
    },
    reset() {
      ipBuckets.reset();
      linkBuckets.reset();
    },
  };
}
