import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecaptchaVerifier, createUnavailableRecaptchaVerifier } from '../src/lib/auth/recaptcha.js';

function googleReplying(body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ body: Object.fromEntries(new URLSearchParams(init.body)), method: init.method, url });
    if (body instanceof Error) throw body;
    return { json: async () => body };
  };
  return { calls, fetchImpl };
}

test('without both keys there is no verifier', () => {
  assert.equal(createRecaptchaVerifier({ siteKey: 'site' }), null);
  assert.equal(createRecaptchaVerifier({ secretKey: 'secret' }), null);
});

const PERSON = { action: 'signup', hostname: 'odinpmp.com', score: 0.9, success: true };

test('a sign-up token Google scores as a person passes, and the secret, token and IP go to siteverify', async () => {
  const google = googleReplying(PERSON);
  const verifier = createRecaptchaVerifier({ fetchImpl: google.fetchImpl, secretKey: 'secret', siteKey: 'site' });
  assert.equal(verifier.siteKey, 'site');
  await verifier.verify({ remoteIp: '203.0.113.9', token: 'token-1' });
  assert.deepEqual(google.calls, [{
    body: { remoteip: '203.0.113.9', response: 'token-1', secret: 'secret' },
    method: 'POST',
    url: 'https://www.google.com/recaptcha/api/siteverify',
  }]);
});

test('missing, rejected and unverifiable tokens fail', async () => {
  const rejected = googleReplying({ 'error-codes': ['timeout-or-duplicate'], success: false });
  const verifier = createRecaptchaVerifier({ fetchImpl: rejected.fetchImpl, secretKey: 'secret', siteKey: 'site' });
  await assert.rejects(verifier.verify({ token: '' }), { statusCode: 400 });
  assert.equal(rejected.calls.length, 0);
  await assert.rejects(verifier.verify({ token: 'stale' }), { statusCode: 400 });

  for (const reply of [{ ...PERSON, score: 0.3 }, { ...PERSON, score: undefined }, { ...PERSON, action: 'login' }, { ...PERSON, action: undefined }]) {
    const google = googleReplying(reply);
    const strict = createRecaptchaVerifier({ fetchImpl: google.fetchImpl, secretKey: 'secret', siteKey: 'site' });
    await assert.rejects(strict.verify({ token: 'token' }), { statusCode: 400 }, JSON.stringify(reply));
  }
  const lenient = createRecaptchaVerifier({ fetchImpl: googleReplying({ ...PERSON, score: 0.3 }).fetchImpl, minScore: 0.2, secretKey: 'secret', siteKey: 'site' });
  await lenient.verify({ token: 'token' });

  const down = googleReplying(new Error('network down'));
  const offline = createRecaptchaVerifier({ fetchImpl: down.fetchImpl, secretKey: 'secret', siteKey: 'site' });
  await assert.rejects(offline.verify({ token: 'token' }), { statusCode: 503 });
});

test('production without keys refuses sign-ups', async () => {
  const verifier = createUnavailableRecaptchaVerifier();
  assert.equal(verifier.siteKey, '');
  await assert.rejects(verifier.verify({ token: 'anything' }), { statusCode: 503 });
});
