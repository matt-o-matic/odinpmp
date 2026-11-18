import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { loadEnv } from '../src/config/env.js';
import { createPackageGrant, DEVELOPMENT_GRANT_SECRET, verifyPackageGrant } from '../src/modules/requirements/packages/package-grants.js';

const SECRET = 'grant-secret-for-tests-0123456789abcdef';
const NOW = new Date('2026-10-07T12:00:00Z');
const LATER = new Date(NOW.valueOf() + 2 * 60 * 60 * 1000);

function grantFor(overrides = {}) {
  return createPackageGrant({ expiresAt: LATER, packageId: 'pkg-1', screenId: 'home', secret: SECRET, viewerRef: 'user:u-1', ...overrides });
}

test('a valid grant verifies for its package and names the viewer and expiry', () => {
  const grant = grantFor();
  assert.match(grant, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/, 'base64url payload and HMAC-SHA256, safe in a path segment');
  assert.deepEqual(verifyPackageGrant({ grant, now: NOW, packageId: 'pkg-1', secret: SECRET }), {
    expiresAt: LATER.toISOString(),
    linkId: null,
    packageId: 'pkg-1',
    screenId: 'home',
    tokenId: null,
    viewerRef: 'user:u-1',
  });
  assert.throws(() => createPackageGrant({ expiresAt: LATER, packageId: 'pkg-1', secret: SECRET, viewerRef: 'user:u-1' }), /needs a screen/);
  // A stakeholder's grant names the portal link and token it was issued through.
  const stakeholder = grantFor({ linkId: 'link-9', tokenId: 'token-9', viewerRef: 'stakeholder:s-9' });
  const verified = verifyPackageGrant({ grant: stakeholder, now: NOW, packageId: 'pkg-1', secret: SECRET });
  assert.deepEqual([verified.viewerRef, verified.linkId, verified.tokenId], ['stakeholder:s-9', 'link-9', 'token-9']);
  const signedPayload = (claims) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
  };
  const exp = Math.floor(LATER / 1000);
  assert.equal(verifyPackageGrant({ grant: signedPayload({ e: exp, l: 7, p: 'pkg-1', s: 'home', v: 'stakeholder:s-9' }), now: NOW, packageId: 'pkg-1', secret: SECRET }), null, 'a link id must be a string');
  assert.equal(verifyPackageGrant({ grant: signedPayload({ e: exp, p: 'pkg-1', v: 'user:u-1' }), now: NOW, packageId: 'pkg-1', secret: SECRET }), null, 'a grant must name its screen');
});

test('tampered, expired, foreign-package, wrong-secret, and malformed grants are rejected', () => {
  const grant = grantFor();
  const [payload, signature] = grant.split('.');

  const otherPayload = Buffer.from(JSON.stringify({ e: Math.floor(LATER / 1000), p: 'pkg-2', v: 'user:u-1' })).toString('base64url');
  assert.equal(verifyPackageGrant({ grant: `${otherPayload}.${signature}`, now: NOW, packageId: 'pkg-2', secret: SECRET }), null, 'payload swapped');
  const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(verifyPackageGrant({ grant: `${payload}.${flipped}`, now: NOW, packageId: 'pkg-1', secret: SECRET }), null, 'signature changed');
  assert.equal(verifyPackageGrant({ grant: `${payload}.${signature}x`, now: NOW, packageId: 'pkg-1', secret: SECRET }), null, 'signature length');

  assert.equal(verifyPackageGrant({ grant, now: LATER, packageId: 'pkg-1', secret: SECRET }), null, 'expired at exp');
  assert.equal(verifyPackageGrant({ grant, now: new Date(LATER.valueOf() + 1000), packageId: 'pkg-1', secret: SECRET }), null, 'expired after exp');
  assert.equal(verifyPackageGrant({ grant, now: NOW, packageId: 'pkg-2', secret: SECRET }), null, 'another package');
  assert.equal(verifyPackageGrant({ grant, now: NOW, packageId: 'pkg-1', secret: `${SECRET}x` }), null, 'another secret');
  assert.equal(verifyPackageGrant({ grant, now: NOW, packageId: 'pkg-1', secret: '' }), null, 'no secret');

  for (const malformed of ['', 'abc', 'a.b.c', `${payload}.`, `.${signature}`, `${payload}.${signature}=`, 'x'.repeat(3000), null, 42]) {
    assert.equal(verifyPackageGrant({ grant: malformed, now: NOW, packageId: 'pkg-1', secret: SECRET }), null, String(malformed).slice(0, 20));
  }
  const notJson = Buffer.from('not json').toString('base64url');
  const signedNotJson = `${notJson}.${createHmac('sha256', SECRET).update(notJson).digest('base64url')}`;
  assert.equal(verifyPackageGrant({ grant: signedNotJson, now: NOW, packageId: 'pkg-1', secret: SECRET }), null, 'signed but not a grant payload');
});

test('production requires a real REVIEW_GRANT_SECRET once REVIEW_PUBLIC_URL is set', () => {
  const production = {
    BACKEND_PUBLIC_URL: 'https://app.example.com',
    CLAMAV_ENABLED: 'true',
    CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
    CONNECTOR_CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(32),
    FRONTEND_APP_URL: 'https://app.example.com/app',
    JWT_SECRET: 'a'.repeat(32),
    NODE_ENV: 'production',
    OBJECT_STORAGE_BUCKET: 'odin-production',
    OBJECT_STORAGE_PROVIDER: 's3',
    OBJECT_STORAGE_REGION: 'us-east-1',
    WEBHOOK_SIGNING_MASTER_SECRET: 'b'.repeat(32),
  };
  // Review origin off: no secret needed.
  assert.equal(loadEnv(production).reviewPublicUrl, '');

  const withReview = { ...production, REVIEW_PUBLIC_URL: 'https://review.example.com' };
  assert.throws(() => loadEnv(withReview), /REVIEW_GRANT_SECRET.*at least 32 characters/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', ...withReview, REVIEW_GRANT_SECRET: 'short' }), /REVIEW_GRANT_SECRET/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', ...withReview, REVIEW_GRANT_SECRET: DEVELOPMENT_GRANT_SECRET }), /REVIEW_GRANT_SECRET/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', ...withReview, REVIEW_GRANT_SECRET: 'r'.repeat(32), REVIEW_PUBLIC_URL: 'http://review.example.com' }), /REVIEW_PUBLIC_URL must use HTTPS/);

  const env = loadEnv({ NODE_ENV: 'test', ...withReview, REVIEW_GRANT_SECRET: 'r'.repeat(32), REVIEW_PACKAGE_MAX_BYTES: String(20 * 1024 * 1024), REVIEW_PORT: '4002' });
  assert.equal(env.reviewPublicUrl, 'https://review.example.com');
  assert.equal(env.reviewGrantSecret, 'r'.repeat(32));
  assert.equal(env.reviewPort, 4002);
  assert.equal(env.reviewPackageMaxBytes, 20 * 1024 * 1024);
});

test('the review origin must be its own origin and port; development gets defaults', () => {
  const env = loadEnv({ NODE_ENV: 'test', REVIEW_PUBLIC_URL: 'http://127.0.0.1:3002/' });
  assert.equal(env.reviewPublicUrl, 'http://127.0.0.1:3002');
  assert.equal(env.reviewPort, 3002);
  assert.equal(env.reviewGrantSecret, DEVELOPMENT_GRANT_SECRET);
  assert.equal(env.reviewPackageMaxBytes, 50 * 1024 * 1024);
  assert.equal(loadEnv({ NODE_ENV: 'test' }).reviewPublicUrl, '', 'off unless configured');

  assert.throws(() => loadEnv({ NODE_ENV: 'test', REVIEW_PUBLIC_URL: 'http://localhost:5173' }), /different origin/, 'same as the app');
  assert.throws(() => loadEnv({ NODE_ENV: 'test', REVIEW_PUBLIC_URL: 'http://localhost:3001' }), /different origin/, 'same as the API');
  assert.throws(() => loadEnv({ NODE_ENV: 'test', REVIEW_PUBLIC_URL: 'http://127.0.0.1:3002/p/' }), /exact http\(s\) origin/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', REVIEW_PUBLIC_URL: 'javascript:alert(1)' }), /REVIEW_PUBLIC_URL/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', PORT: '3002', REVIEW_PUBLIC_URL: 'http://127.0.0.1:3002' }), /REVIEW_PORT must differ/);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', REVIEW_PACKAGE_MAX_BYTES: String(300 * 1024 * 1024) }), /REVIEW_PACKAGE_MAX_BYTES/);
});
