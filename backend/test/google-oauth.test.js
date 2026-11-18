import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoogleOAuthClient } from '../src/lib/auth/google-oauth.js';

test('Google profile adapter carries the verified-email result from Google', async () => {
  const originalFetch = globalThis.fetch;
  const client = createGoogleOAuthClient({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/api/auth/google/callback',
  });
  try {
    globalThis.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'test-access' }), { status: 200 });
      }
      assert.equal(url, 'https://www.googleapis.com/oauth2/v2/userinfo');
      return new Response(JSON.stringify({
        email: 'verified@example.com',
        name: 'Verified User',
        verified_email: true,
      }), { status: 200 });
    };
    assert.deepEqual(await client.getUserInfoFromCode('test-code'), {
      email: 'verified@example.com',
      emailVerified: true,
      name: 'Verified User',
      picture: '',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
