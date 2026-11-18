// In-memory token buckets, one per key. Each key starts full, spends `cost` per request and
// refills at `refillPerSecond` up to `capacity`. Buckets live in this process only; with several
// instances each one enforces its own limit. Idle keys are evicted once `maxKeys` is reached.
export function createTokenBucket({ capacity, maxKeys = 10_000, now = () => Date.now(), refillPerSecond }) {
  const buckets = new Map();

  function refill(bucket, nowMs) {
    const elapsedSeconds = Math.max(0, (nowMs - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedSeconds * refillPerSecond));
    bucket.updatedAt = nowMs;
  }

  function evictIdle(nowMs) {
    if (buckets.size < maxKeys) return;
    for (const [key, bucket] of buckets) {
      refill(bucket, nowMs);
      if (bucket.tokens >= capacity) buckets.delete(key);
    }
    while (buckets.size >= maxKeys) {
      buckets.delete(buckets.keys().next().value);
    }
  }

  return {
    take(key, cost = 1) {
      const nowMs = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        evictIdle(nowMs);
        bucket = { tokens: capacity, updatedAt: nowMs };
        buckets.set(key, bucket);
      } else {
        refill(bucket, nowMs);
      }

      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const missing = cost - bucket.tokens;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(missing / refillPerSecond)) };
    },
    reset() {
      buckets.clear();
    },
  };
}
