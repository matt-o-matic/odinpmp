import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiBaseUrl } from '../src/lib/api/base-url.js';

test('resolveApiBaseUrl prefers an explicit configured base URL', () => {
  assert.equal(
    resolveApiBaseUrl({
      browserOrigin: 'https://odinpmp.com',
      configuredBaseUrl: 'https://api.odinpmp.com',
      mode: 'production',
    }),
    'https://api.odinpmp.com',
  );
});

test('resolveApiBaseUrl uses localhost backend during development when no override is provided', () => {
  assert.equal(
    resolveApiBaseUrl({
      browserOrigin: 'http://localhost:5173',
      configuredBaseUrl: '',
      mode: 'development',
    }),
    'http://localhost:3001',
  );
});

test('resolveApiBaseUrl uses the browser origin in production when no override is provided', () => {
  assert.equal(
    resolveApiBaseUrl({
      browserOrigin: 'https://odinpmp.com',
      configuredBaseUrl: '',
      mode: 'production',
    }),
    'https://odinpmp.com',
  );
});
