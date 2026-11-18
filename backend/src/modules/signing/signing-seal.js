import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Hashes and seals for signature records (docs/document-signing/plan.md). A record is written as
// canonical JSON (keys sorted at every level), hashed with SHA-256, and sealed with HMAC-SHA256
// under a server key. The key's id is stored with each seal, so a record sealed before a key
// rotation can still be checked with the key it was sealed with.

export const DEVELOPMENT_SIGNING_SEAL_KEY = 'odin-local-signing-seal-key-do-not-use-in-production';
export const DEVELOPMENT_SIGNING_SEAL_KEY_ID = 'dev-1';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

/** JSON with keys sorted at every level and undefined fields left out: the same value always gives the same text. */
export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Previous keys as `id:key,id:key`, for records sealed before a rotation. */
export function parsePreviousSealKeys(value) {
  const keys = new Map();
  for (const entry of String(value ?? '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const id = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();
    if (id && key) keys.set(id, key);
  }
  return keys;
}

/**
 * Seals and checks records. `configured` is false when only the development key is available
 * in production, and then new requests are refused (signing_not_configured).
 */
export function createSigningSealer({ key = '', keyId = '', previousKeys = '', production = false } = {}) {
  const currentKey = String(key ?? '').trim();
  const usable = currentKey.length >= 32 && currentKey !== DEVELOPMENT_SIGNING_SEAL_KEY;
  const activeKey = usable ? currentKey : DEVELOPMENT_SIGNING_SEAL_KEY;
  const activeKeyId = usable ? (String(keyId ?? '').trim() || 'seal-1') : DEVELOPMENT_SIGNING_SEAL_KEY_ID;
  // The development key is public, so production never accepts a seal made with it, under any id.
  const keys = new Map([...parsePreviousSealKeys(previousKeys)].filter(([, value]) => !production || value !== DEVELOPMENT_SIGNING_SEAL_KEY));
  if (!production) keys.set(DEVELOPMENT_SIGNING_SEAL_KEY_ID, DEVELOPMENT_SIGNING_SEAL_KEY);
  if (usable || !production) keys.set(activeKeyId, activeKey);

  const hmac = (secret, text) => createHmac('sha256', secret).update(text).digest('base64url');

  return {
    configured: usable || !production,
    keyId: activeKeyId,
    seal(text) {
      return { seal: hmac(activeKey, text), sealKeyId: activeKeyId };
    },
    /** True when `seal` is the seal of `text` under the key named by `sealKeyId`. */
    verify(text, seal, sealKeyId) {
      const secret = keys.get(String(sealKeyId ?? ''));
      if (!secret || typeof seal !== 'string') return false;
      const expected = Buffer.from(hmac(secret, text));
      const actual = Buffer.from(seal);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}
