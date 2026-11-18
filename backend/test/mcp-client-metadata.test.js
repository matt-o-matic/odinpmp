import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientMetadataResolver, isTrustedClientMetadataUrl, matchesMetadataRedirect } from '../src/mcp/client-metadata.js';

const CLIENT = 'https://chatgpt.com/oauth/codex/client.json';
const metadata = { client_id: CLIENT, client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('metadata fetching accepts only exact OpenAI document URLs and never fetches callback or private hosts', async () => {
  for (const uri of [CLIENT, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/oauth/connection-id/client.json', 'https://chatgpt.com/oauth/codex/connection_id/client.json']) assert.equal(isTrustedClientMetadataUrl(uri), true);
  let fetches = 0;
  const resolve = createClientMetadataResolver({ fetchImpl: async () => { fetches++; return response(metadata); } });
  for (const uri of ['http://chatgpt.com/oauth/client.json', 'https://127.0.0.1/oauth/client.json', 'https://chatgpt.com.evil.example/oauth/client.json', 'https://user:password@chatgpt.com/oauth/client.json', `${CLIENT}?x=1`, `${CLIENT}#x`, 'https://chatgpt.com:444/oauth/client.json', 'https://chatgpt.com/oauth/%2e%2e/client.json', 'https://chatgpt.com/other/client.json']) await assert.rejects(resolve(uri), error => error.details.error === 'invalid_client');
  assert.equal(fetches, 0);
});

test('Claude\'s two metadata documents are trusted, and nothing else on claude.ai is', async () => {
  const hosted = 'https://claude.ai/oauth/mcp-oauth-client-metadata', code = 'https://claude.ai/oauth/claude-code-client-metadata';
  for (const uri of [hosted, code]) assert.equal(isTrustedClientMetadataUrl(uri), true);
  for (const uri of ['https://claude.ai/oauth/other-client-metadata', 'https://claude.ai/api/mcp/auth_callback', `${hosted}?x=1`, `${hosted}/`, 'http://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://claude.com/oauth/mcp-oauth-client-metadata', 'https://claude.ai.evil.example/oauth/mcp-oauth-client-metadata', 'https://chatgpt.com/oauth/mcp-oauth-client-metadata', 'https://claude.ai/oauth/client.json']) {
    assert.equal(isTrustedClientMetadataUrl(uri), false, uri);
  }
  // Claude's hosted document also lists a JWT bearer grant; the authorization-code grant is what Odin needs.
  const documents = {
    [hosted]: { client_id: hosted, client_name: 'Claude', client_uri: 'https://claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    [code]: { client_id: code, client_name: 'Claude Code', client_uri: 'https://claude.ai', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  };
  const resolve = createClientMetadataResolver({ fetchImpl: async url => response(documents[url]) });
  assert.equal((await resolve(hosted)).client_name, 'Claude');
  assert.deepEqual((await resolve(code)).redirect_uris, documents[code].redirect_uris);
  assert.equal(matchesMetadataRedirect('http://localhost/callback', 'http://localhost:3118/callback'), true);
});

test('metadata is bounded, validated and cached, without retaining a mutable caller reference', async () => {
  let requests = 0, clock = 0;
  const resolve = createClientMetadataResolver({ now: () => clock, fetchImpl: async (url, options) => {
    requests++; assert.equal(url, CLIENT); assert.equal(options.redirect, 'error'); assert.ok(options.signal); return response(metadata);
  } });
  const first = await resolve(CLIENT); first.redirect_uris.push('https://evil.example/cb');
  assert.deepEqual((await resolve(CLIENT)).redirect_uris, metadata.redirect_uris); assert.equal(requests, 1);
  clock += 300_001; await resolve(CLIENT); assert.equal(requests, 2);
  for (const value of [{ ...metadata, client_id: 'other' }, { ...metadata, token_endpoint_auth_method: 'client_secret_basic' }, { ...metadata, redirect_uris: ['http://remote.example/cb'] }, { ...metadata, redirect_uris: ['https://user:secret@example.test/cb'] }, { ...metadata, grant_types: ['client_credentials'] }, { ...metadata, client_name: 'x'.repeat(17000) }]) {
    await assert.rejects(createClientMetadataResolver({ fetchImpl: async () => response(value) })(CLIENT));
  }
  const chatgpt = { ...metadata, client_id: 'https://chatgpt.com/oauth/client.json', token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] };
  assert.ok(await createClientMetadataResolver({ fetchImpl: async () => response(chatgpt) })(chatgpt.client_id));
  for (const fetchImpl of [async () => new Response('redirect', { status: 302 }), async () => new Response('html'), async () => { throw new Error('private marker'); }]) {
    await assert.rejects(createClientMetadataResolver({ fetchImpl })(CLIENT), error => error.details.error === 'invalid_client' && !JSON.stringify(error).includes('private marker'));
  }
});

test('native callback matching varies only the loopback port', () => {
  assert.equal(matchesMetadataRedirect('http://127.0.0.1/callback', 'http://127.0.0.1:54321/callback'), true);
  for (const uri of ['http://127.0.0.1:54321/other', 'http://localhost:54321/callback', 'http://evil.example/callback', 'http://127.0.0.1:54321/callback?x=1', 'https://127.0.0.1/callback']) assert.equal(matchesMetadataRedirect('http://127.0.0.1/callback', uri), false);
  assert.equal(matchesMetadataRedirect('https://chatgpt.com/connector/oauth/id', 'https://chatgpt.com:444/connector/oauth/id'), false);
});
