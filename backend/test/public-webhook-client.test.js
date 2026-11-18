import assert from 'node:assert/strict';
import test from 'node:test';

import { postPublicWebhook } from '../src/lib/http/public-webhook-client.js';

test('public webhook client rejects credentials, non-HTTPS, private DNS, and non-standard ports before delivery', async () => {
  await assert.rejects(() => postPublicWebhook({ body: '{}', url: 'http://example.com/hook' }), /public HTTPS/i);
  await assert.rejects(() => postPublicWebhook({ body: '{}', url: 'https://user:pass@example.com/hook' }), /public HTTPS/i);
  await assert.rejects(() => postPublicWebhook({ body: '{}', url: 'https://example.com:8443/hook' }), /standard port/i);
  await assert.rejects(() => postPublicWebhook({ body: '{}', resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }], url: 'https://example.com/hook' }), /non-public address/i);
  await assert.rejects(() => postPublicWebhook({ body: '{}', resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }], url: 'https://example.com/hook' }), /non-public address/i);
});
