import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MAX_REDIRECT_URIS, addRedirectUri, redirectUriError } from '../src/lib/integrations/redirect-uris.js';

const integrationSource = readFileSync(new URL('../src/views/IntegrationAdminView.vue', import.meta.url), 'utf8');

test('redirect URIs follow the backend rule: HTTPS or loopback HTTP, no credentials or fragments', () => {
  for (const valid of ['https://app.example.com/oauth/callback', 'http://localhost:8080/cb', 'http://127.0.0.1/cb', 'http://[::1]:3000/cb', '  https://app.example.com/cb?x=1  ']) {
    assert.equal(redirectUriError(valid), '', valid);
  }
  assert.match(redirectUriError(''), /Enter a redirect URI/);
  assert.match(redirectUriError('app.example.com/callback'), /full URL/);
  assert.match(redirectUriError('http://app.example.com/cb'), /HTTPS/);
  assert.match(redirectUriError('ftp://app.example.com/cb'), /HTTPS/);
  assert.match(redirectUriError('http://localhost.example.com/cb'), /HTTPS/);
  assert.match(redirectUriError('https://user:secret@app.example.com/cb'), /username or password/);
  assert.match(redirectUriError('https://app.example.com/cb#done'), /fragment/);
  assert.match(redirectUriError(`https://app.example.com/${'a'.repeat(2000)}`), /at most 2000/);
});

test('adding redirect URIs trims, rejects duplicates and caps the list', () => {
  assert.deepEqual(addRedirectUri([], ' https://a.example/cb '), { error: '', uris: ['https://a.example/cb'] });
  assert.match(addRedirectUri(['https://a.example/cb'], 'https://a.example/cb').error, /already listed/);
  const full = Array.from({ length: MAX_REDIRECT_URIS }, (_, index) => `https://a.example/${index}`);
  assert.match(addRedirectUri(full, 'https://a.example/extra').error, /at most 20/);
  assert.deepEqual(addRedirectUri(full, 'nope').uris, full);
});

test('the OAuth application create and edit dialogs send redirect URIs', () => {
  assert.match(integrationSource, /createOAuthApplication\(\{ name: value\.name, projectIds: value\.projectIds, redirectUris: value\.redirectUris,/);
  assert.match(integrationSource, /updateOAuthApplication\(value\.application\.id, \{ projectIds: value\.projectIds, redirectUris: value\.redirectUris, expectedVersion: value\.application\.version \}/);
  assert.equal((integrationSource.match(/<RedirectUriListInput ref="redirectInput" v-model="editor\.values\.redirectUris" \/>/g) ?? []).length, 2);
  assert.match(integrationSource, /<th>Redirect URIs<\/th>/);
  assert.match(integrationSource, /!redirectInput\.value\.commitPending\(\)/);
});
