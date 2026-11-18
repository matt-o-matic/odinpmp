import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryPlatformRepository } from '../src/modules/platform/platform.repository.js';
import { createInMemoryMcpOAuthRepository, createMysqlMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createMcpOAuthService } from '../src/mcp/oauth.service.js';

const RESOURCE = 'https://odin.example.test/mcp';
const REDIRECT = 'http://127.0.0.1:49215/callback';
const VERIFIER = 'v'.repeat(64);
const challenge = (value = VERIFIER) => createHash('sha256').update(value).digest('base64url');
const oauthError = (error, status) => (value) => value.details?.error === error && (!status || value.statusCode === status);

async function fixture(options = {}) {
  let clock = Date.parse('2026-10-01T12:00:00Z');
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, users: [
    { id: 'admin', email: 'admin@example.test', name: 'Admin', memberships: [{ tenantId: 'tenant-a', role: 'admin' }, { tenantId: 'tenant-b', role: 'viewer' }] },
    { id: 'reader', email: 'reader@example.test', name: 'Reader', memberships: [{ tenantId: 'tenant-a', role: 'viewer' }] },
  ] });
  const platformRepository = createInMemoryPlatformRepository();
  const repository = createInMemoryMcpOAuthRepository();
  let capabilities = [];
  const service = createMcpOAuthService({ repository, platformRepository, authRepository, identityRepository: { async resolveUserCapabilities() { return [...capabilities]; } }, resourceUrl: RESOURCE, now: () => clock, ...options });
  const admin = await authRepository.findUserById('admin');
  const reader = await authRepository.findUserById('reader');
  const client = await service.registerClient({ user: admin, input: { name: 'Disposable MCP client', redirectUris: [REDIRECT], scopes: ['projects.read', 'projects.write'], projectIds: ['project-a', 'project-b'] } });
  const params = (overrides = {}) => ({ client_id: client.client_id, response_type: 'code', redirect_uri: REDIRECT, scope: 'projects.read projects.write', resource: RESOURCE, state: 'opaque-client-state', code_challenge: challenge(), code_challenge_method: 'S256', ...overrides });
  async function code(user = admin, overrides = {}) {
    const authorized = await service.authorize({ user, input: { ...params(overrides), approved: true } });
    return new URL(authorized.redirectTo).searchParams.get('code');
  }
  const redeem = (codeValue, overrides = {}) => service.exchange({ grant_type: 'authorization_code', client_id: client.client_id, code: codeValue, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE, ...overrides });
  const refresh = (token, overrides = {}) => service.exchange({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, resource: RESOURCE, ...overrides });
  return { admin, reader, client, service, authRepository, platformRepository, repository, params, code, redeem, refresh, setTime(value) { clock = value; }, advance(ms) { clock += ms; }, setCapabilities(value) { capabilities = value; } };
}

test('public registration binds a platform application without exposing a usable client secret', async () => {
  const f = await fixture();
  assert.equal(f.client.token_endpoint_auth_method, 'none');
  assert.equal(f.client.tenantId, 'tenant-a');
  assert.equal('client_secret' in f.client, false);
  const app = await f.platformRepository.getOAuthApplicationByClientId({ clientId: f.client.client_id });
  assert.equal(app.id, f.client.applicationId);
  assert.deepEqual(app.projectIds, ['project-a', 'project-b']);
  await assert.rejects(f.service.registerClient({ user: f.reader, input: { name: 'Denied', redirectUris: [REDIRECT], scopes: ['projects.read'] } }), oauthError('access_denied', 403));
  f.setCapabilities(['integrations.manage']);
  const granted = await f.service.registerClient({ user: f.reader, input: { name: 'Capability admin', redirectUris: [REDIRECT], scopes: ['projects.read'] } });
  assert.deepEqual(granted.projectIds, []);
});

test('OpenAI metadata clients need no administrator registration and bind approval separately per tenant', async () => {
  const clientId = 'https://chatgpt.com/oauth/codex/client.json';
  const f = await fixture({ resolveClientMetadata: async id => {
    assert.equal(id, clientId);
    return { client_id: id, client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'] };
  } });
  const params = f.params({ client_id: clientId });
  const count = f.repository.state.clients.size;
  const preview = await f.service.consentInfo({ user: f.reader, input: params });
  assert.equal(preview.name, 'Codex'); assert.equal(preview.tenantId, 'tenant-a');
  assert.equal(f.repository.state.clients.size, count);
  await assert.rejects(f.service.authorize({ user: f.reader, input: { ...params, approved: false } }));
  assert.equal(f.repository.state.clients.size, count);
  const authorize = user => f.service.authorize({ user, input: { ...params, approved: true } });
  const issued = await Promise.all([authorize(f.reader), authorize(f.reader)]);
  assert.equal(f.repository.state.clients.size, count + 1);
  const code = new URL(issued[0].redirectTo).searchParams.get('code');
  await assert.rejects(f.redeem(code, { client_id: f.client.client_id }), oauthError('invalid_grant'));
  const tokens = await f.redeem(code, { client_id: clientId });
  const grant = await f.service.authenticateAccess(tokens.access_token);
  assert.equal(grant.user.id, 'reader'); assert.equal(grant.grant.tenantId, 'tenant-a');
  assert.equal(grant.user.memberships[0].role, 'viewer');
  assert.deepEqual(grant.grant.projectIds, []);
  const renewed = await f.refresh(tokens.refresh_token, { client_id: clientId });
  assert.ok(renewed.refresh_token);
  const otherTenant = { ...f.admin, memberships: [f.admin.memberships[1], f.admin.memberships[0]] };
  const other = await authorize(otherTenant);
  const otherTokens = await f.redeem(new URL(other.redirectTo).searchParams.get('code'), { client_id: clientId });
  const otherGrant = await f.service.authenticateAccess(otherTokens.access_token);
  assert.equal(otherGrant.grant.tenantId, 'tenant-b');
  assert.notEqual(otherGrant.grant.applicationId, grant.grant.applicationId);
  await f.service.revokeClient({ user: f.admin, clientId: grant.grant.clientId });
  await assert.rejects(f.service.authenticateAccess(renewed.access_token), oauthError('invalid_token', 401));
  assert.ok(await f.service.authenticateAccess(otherTokens.access_token));
  await f.service.revoke({ client_id: clientId, token: otherTokens.refresh_token });
  await assert.rejects(f.service.authenticateAccess(otherTokens.access_token), oauthError('invalid_token', 401));
});

test('ChatGPT authorization accepts its locale hint without changing grant checks', async () => {
  const clientId = 'https://chatgpt.com/oauth/SPWbzCdURQBT/client.json';
  const redirectUri = 'https://chatgpt.com/connector/oauth/SPWbzCdURQBT';
  const f = await fixture({ resolveClientMetadata: async () => ({ client_name: 'ChatGPT', redirect_uris: [redirectUri] }) });
  const input = f.params({ client_id: clientId, redirect_uri: redirectUri, ui_locales: 'en-US' });
  assert.equal((await f.service.consentInfo({ user: f.reader, input })).name, 'ChatGPT');
  assert.equal(f.repository.state.clients.size, 1);
  for (const overrides of [{ ui_locales: ['en-US'] }, { ui_locales: 'x'.repeat(257) }, { ui_locales: 'en-US\n' }, { unknown_parameter: 'value' }, { resource: 'https://other.example.test/mcp' }, { scope: 'projects.read admin' }, { redirect_uri: 'https://evil.example/callback' }]) {
    await assert.rejects(f.service.authorize({ user: f.reader, input: { ...input, ...overrides, approved: true } }));
  }
  assert.equal(f.repository.state.clients.size, 1);
  const authorized = await f.service.authorize({ user: f.reader, input: { ...input, approved: true } });
  const callback = new URL(authorized.redirectTo);
  assert.equal(callback.searchParams.get('state'), input.state);
  assert.equal(callback.searchParams.has('ui_locales'), false);
  const tokens = await f.redeem(callback.searchParams.get('code'), { client_id: clientId, redirect_uri: redirectUri });
  assert.equal((await f.service.authenticateAccess(tokens.access_token)).user.id, 'reader');
  assert.equal((await f.service.consentInfo({ user: f.reader, input: { ...input, ui_locales: 'en-US fr-CA' } })).name, 'ChatGPT');
});

test('Claude and Claude Code connect through their metadata documents without administrator registration', async () => {
  // The documents as claude.ai serves them (2026-10-21).
  const documents = {
    'https://claude.ai/oauth/mcp-oauth-client-metadata': { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
    'https://claude.ai/oauth/claude-code-client-metadata': { client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] },
  };
  const f = await fixture({ resolveClientMetadata: async id => ({ client_id: id, ...documents[id] }) });
  const connect = async (clientId, redirectUri) => {
    const input = f.params({ client_id: clientId, redirect_uri: redirectUri });
    const authorized = await f.service.authorize({ user: f.reader, input: { ...input, approved: true } });
    const tokens = await f.redeem(new URL(authorized.redirectTo).searchParams.get('code'), { client_id: clientId, redirect_uri: redirectUri });
    return f.service.authenticateAccess(tokens.access_token);
  };
  const hosted = await connect('https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/api/mcp/auth_callback');
  assert.equal(hosted.user.id, 'reader');
  // Claude Code listens on whichever loopback port is free, under either loopback name.
  for (const redirectUri of ['http://localhost:3118/callback', 'http://127.0.0.1:61022/callback']) {
    assert.equal((await connect('https://claude.ai/oauth/claude-code-client-metadata', redirectUri)).user.id, 'reader');
  }
  for (const [clientId, redirectUri] of [
    ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.com/api/mcp/auth_callback'],
    ['https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:3118/other'],
    ['https://claude.ai/oauth/claude-code-client-metadata', 'https://localhost:3118/callback'],
  ]) {
    await assert.rejects(f.service.authorize({ user: f.reader, input: { ...f.params({ client_id: clientId, redirect_uri: redirectUri }), approved: true } }));
  }
});

test('automatic clients reject unregistered destinations, scopes and users before creating bindings', async () => {
  const clientId = 'https://chatgpt.com/oauth/codex/client.json';
  const f = await fixture({ resolveClientMetadata: async () => ({ client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'] }) });
  const before = f.repository.state.clients.size;
  for (const overrides of [{ redirect_uri: 'http://127.0.0.1:49215/wrong' }, { redirect_uri: 'https://evil.example/callback' }, { scope: 'projects.read admin' }, { client_id: 'https://evil.example/client.json' }]) {
    await assert.rejects(f.service.authorize({ user: f.reader, input: { ...f.params({ client_id: clientId, ...overrides }), approved: true } }));
  }
  await assert.rejects(f.service.consentInfo({ user: { id: 'unknown', memberships: [{ tenantId: 'tenant-a' }] }, input: f.params({ client_id: clientId }) }));
  assert.equal(f.repository.state.clients.size, before);
});

test('consent and code exchange preserve user, active tenant, exact resource, scope and project restrictions', async () => {
  const f = await fixture();
  const consent = await f.service.consentInfo({ user: f.admin, input: f.params() });
  assert.equal(consent.resource, RESOURCE);
  const result = await f.redeem(await f.code(f.reader));
  assert.equal(result.token_type, 'Bearer'); assert.equal(result.expires_in, 3600);
  const authenticated = await f.service.authenticateAccess(result.access_token);
  assert.equal(authenticated.user.id, 'reader');
  assert.deepEqual(authenticated.user.memberships, [{ tenantId: 'tenant-a', role: 'viewer' }]);
  assert.equal('passwordHash' in authenticated.user, false);
  assert.deepEqual(authenticated.grant.projectIds, ['project-a', 'project-b']);
  assert.equal(authenticated.grant.resource, RESOURCE);
  assert.equal(authenticated.grant.grantType, 'authorization_code');
  const saved = JSON.stringify([...f.repository.state.codes.values(), ...f.repository.state.tokens.values(), ...f.repository.state.families.values()]);
  assert.equal(saved.includes(result.access_token), false); assert.equal(saved.includes(result.refresh_token), false);
});

test('strict registration rejects insecure or malformed redirect URIs and scopes', async () => {
  const f = await fixture();
  for (const redirect of ['http://odin.example.test/callback', 'https://name:secret@example.test/cb', 'https://example.test/cb#fragment', 'javascript:alert(1)', '/callback']) {
    await assert.rejects(f.service.registerClient({ user: f.admin, input: { name: 'Bad', redirectUris: [redirect], scopes: ['projects.read'] } }), oauthError('invalid_request'));
  }
  for (const scopes of [['admin'], ['projects.read', 'projects.read'], [], ['projects.write']]) await assert.rejects(f.service.registerClient({ user: f.admin, input: { name: 'Bad', redirectUris: [REDIRECT], scopes } }), oauthError('invalid_request'));
});

test('authorization requires exact preregistration, PKCE S256, resource, and selected tenant', async () => {
  const f = await fixture();
  for (const overrides of [{ client_id: 'unknown' }, { redirect_uri: `${REDIRECT}?other=1` }, { resource: 'https://other.example.test/mcp' }, { code_challenge_method: 'plain' }, { code_challenge: 'short' }, { response_type: 'token' }, { scope: 'projects.read admin' }, { client_secret: 'not-supported' }]) {
    await assert.rejects(f.service.consentInfo({ user: f.admin, input: f.params(overrides) }));
  }
  const otherTenant = { ...f.admin, memberships: [f.admin.memberships[1], f.admin.memberships[0]] };
  await assert.rejects(f.service.authorize({ user: otherTenant, input: { ...f.params(), approved: true } }), oauthError('access_denied', 403));
  await assert.rejects(f.service.authorize({ user: f.admin, input: { ...f.params(), approved: false } }), oauthError('invalid_request'));
});

test('code is bound to verifier, redirect, client and resource; bad exchanges do not consume it', async () => {
  const f = await fixture(), code = await f.code();
  for (const overrides of [{ code_verifier: 'x'.repeat(64) }, { redirect_uri: `${REDIRECT}?other=1` }, { resource: `${RESOURCE}/` }, { client_id: 'wrong' }, { code_verifier: 'short' }, { client_secret: 'forbidden' }]) await assert.rejects(f.redeem(code, overrides));
  const result = await f.redeem(code); assert.ok(result.access_token);
  await assert.rejects(f.redeem(code), oauthError('invalid_grant'));
});

test('concurrent code exchanges mint exactly one family and one token pair', async () => {
  const f = await fixture(), code = await f.code();
  const results = await Promise.allSettled([f.redeem(code), f.redeem(code)]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(f.repository.state.families.size, 1); assert.equal(f.repository.state.tokens.size, 2);
});

test('refresh rotates, narrows scope, and never extends the fixed family expiry', async () => {
  const f = await fixture(), initial = await f.redeem(await f.code());
  const expiry = [...f.repository.state.families.values()][0].expiresAt;
  f.advance(3600_000);
  await assert.rejects(f.service.authenticateAccess(initial.access_token), oauthError('invalid_token', 401));
  const next = await f.refresh(initial.refresh_token, { scope: 'projects.read' });
  assert.notEqual(next.refresh_token, initial.refresh_token); assert.equal(next.scope, 'projects.read');
  assert.equal([...f.repository.state.families.values()][0].expiresAt, expiry);
  await assert.rejects(f.refresh(next.refresh_token, { scope: 'projects.read projects.write' }), oauthError('invalid_scope'));
  await assert.rejects(f.refresh(next.refresh_token, { scope: 'projects.write' }), oauthError('invalid_scope'));
  assert.equal((await f.service.authenticateAccess(next.access_token)).grant.scopes.length, 1);
});

test('refresh replay revokes all access and refresh tokens in the family', async () => {
  const f = await fixture(), initial = await f.redeem(await f.code()), next = await f.refresh(initial.refresh_token);
  await assert.rejects(f.refresh(initial.refresh_token), oauthError('invalid_grant'));
  await assert.rejects(f.service.authenticateAccess(initial.access_token), oauthError('invalid_token', 401));
  await assert.rejects(f.service.authenticateAccess(next.access_token), oauthError('invalid_token', 401));
  await assert.rejects(f.refresh(next.refresh_token), oauthError('invalid_grant'));
});

test('concurrent refreshes permit one rotation and replay detection revokes the resulting family', async () => {
  const f = await fixture(), initial = await f.redeem(await f.code());
  const results = await Promise.allSettled([f.refresh(initial.refresh_token), f.refresh(initial.refresh_token)]);
  const success = results.filter((value) => value.status === 'fulfilled');
  assert.equal(success.length, 1);
  await assert.rejects(f.service.authenticateAccess(success[0].value.access_token), oauthError('invalid_token', 401));
});

test('revocation is idempotent and client-bound, and revokes the entire family', async () => {
  const f = await fixture(), tokens = await f.redeem(await f.code());
  await f.service.revoke({ client_id: 'other', token: tokens.refresh_token });
  assert.ok(await f.service.authenticateAccess(tokens.access_token));
  assert.deepEqual(await f.service.revoke({ client_id: f.client.client_id, token: tokens.access_token, token_type_hint: 'access_token' }), {});
  await assert.rejects(f.refresh(tokens.refresh_token), oauthError('invalid_grant'));
  await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
  assert.deepEqual(await f.service.revoke({ client_id: f.client.client_id, token: 'unknown' }), {});
});

test('codes expire in five minutes and refresh families expire in thirty days', async () => {
  const f = await fixture(), oldCode = await f.code();
  f.advance(300_000); await assert.rejects(f.redeem(oldCode), oauthError('invalid_grant'));
  const tokens = await f.redeem(await f.code());
  f.advance(30 * 86400_000); await assert.rejects(f.refresh(tokens.refresh_token), oauthError('invalid_grant'));
  await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
});

test('every authentication and refresh rechecks application status and tenant membership', async () => {
  const f = await fixture(), tokens = await f.redeem(await f.code());
  const application = f.platformRepository.state.applications.get(f.client.applicationId);
  application.enabled = false;
  await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
  await assert.rejects(f.refresh(tokens.refresh_token), oauthError('invalid_grant'));
  application.enabled = true;
  f.admin.memberships = [{ tenantId: 'tenant-b', role: 'admin' }];
  await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
  await assert.rejects(f.refresh(tokens.refresh_token), oauthError('invalid_grant'));
});

test('current roles and capabilities are resolved, and application scope/project reductions take effect', async () => {
  const f = await fixture(), tokens = await f.redeem(await f.code());
  f.admin.memberships[0].role = 'viewer'; f.setCapabilities(['projects.view']);
  const app = f.platformRepository.state.applications.get(f.client.applicationId);
  app.projectIds = ['project-b'];
  const auth = await f.service.authenticateAccess(tokens.access_token);
  assert.equal(auth.user.memberships[0].role, 'viewer'); assert.deepEqual(auth.user.capabilities, ['projects.view']);
  assert.deepEqual(auth.grant.projectIds, ['project-b']);
  app.scopes = ['projects.read'];
  await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
  const narrowed = await f.refresh(tokens.refresh_token, { scope: 'projects.read' });
  assert.equal(narrowed.scope, 'projects.read');
  app.projectIds = ['unrelated'];
  await assert.rejects(f.service.authenticateAccess(narrowed.access_token), oauthError('invalid_token', 401));
});

test('tokens cannot cross resources, clients, application bindings or credential types', async () => {
  const f = await fixture(), tokens = await f.redeem(await f.code());
  await assert.rejects(f.refresh(tokens.refresh_token, { resource: `${RESOURCE}/wrong` }), oauthError('invalid_request'));
  await assert.rejects(f.refresh(tokens.refresh_token, { client_id: 'other' }), oauthError('invalid_grant'));
  await assert.rejects(f.service.authenticateAccess(tokens.refresh_token), oauthError('invalid_token', 401));
  await assert.rejects(f.service.authenticateAccess('odin_oauth_legacy'), oauthError('invalid_token', 401));
  await assert.rejects(f.service.exchange({ grant_type: 'client_credentials', client_id: f.client.client_id }), oauthError('invalid_request'));
  f.platformRepository.state.applications.get(f.client.applicationId).tenantId = 'tenant-b';
  await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
});

test('schema failures return generic OAuth errors without reflecting supplied credentials', async () => {
  const f = await fixture();
  await assert.rejects(f.service.exchange({ grant_type: 'password', password: 'secret-do-not-echo' }), (error) => {
    assert.equal(error.details.error, 'invalid_request'); assert.equal(JSON.stringify(error.details).includes('secret-do-not-echo'), false); return true;
  });
});

test('admin revocation survives application re-enabling and does not revoke other applications', async () => {
  const f = await fixture(), original = await f.redeem(await f.code());
  const secondCode = await f.code(), second = await f.redeem(secondCode), outstandingCode = await f.code();
  const other = { id: 'other-family', applicationId: 'other-app', tenantId: 'tenant-a', expiresAt: '2030-01-01T00:00:00Z', revokedAt: null };
  f.repository.state.families.set(other.id, other);
  const app = f.platformRepository.state.applications.get(f.client.applicationId);
  app.enabled = false;
  assert.deepEqual(await f.service.revokeClient({ user: f.admin, clientId: f.client.client_id }), { ok: true });
  app.enabled = true;
  assert.equal(other.revokedAt, null);
  await assert.rejects(f.redeem(outstandingCode), oauthError('invalid_grant'));
  for (const tokens of [original, second]) {
    await assert.rejects(f.service.authenticateAccess(tokens.access_token), oauthError('invalid_token', 401));
    await assert.rejects(f.refresh(tokens.refresh_token), oauthError('invalid_grant'));
  }
  const newlyAuthorized = await f.redeem(await f.code());
  assert.ok(await f.service.authenticateAccess(newlyAuthorized.access_token));
  await f.repository.revokeApplication({ applicationId: f.client.applicationId, tenantId: 'tenant-b', now: Date.now() });
  assert.ok(await f.service.authenticateAccess(newlyAuthorized.access_token));
  assert.equal(other.revokedAt, null);
});

test('client revocation requires a current integration admin in the selected tenant', async () => {
  const f = await fixture();
  await assert.rejects(f.service.revokeClient({ user: f.reader, clientId: f.client.client_id }), oauthError('access_denied', 403));
  const wrongTenant = { ...f.admin, memberships: [{ tenantId: 'tenant-b', role: 'admin' }] };
  f.admin.memberships[1].role = 'admin';
  await assert.rejects(f.service.revokeClient({ user: wrongTenant, clientId: f.client.client_id }), (error) => error.statusCode === 404);
  await assert.rejects(f.service.revokeClient({ user: f.admin, clientId: 'unknown' }), (error) => error.statusCode === 404);
  f.admin.memberships[0].role = 'viewer';
  await assert.rejects(f.service.revokeClient({ user: f.admin, clientId: f.client.client_id }), oauthError('access_denied', 403));
  f.setCapabilities(['integrations.manage']);
  assert.deepEqual(await f.service.revokeClient({ user: f.admin, clientId: f.client.client_id }), { ok: true });
});

test('a code created after concurrent disable/revoke/re-enable cannot resurrect authorization', async () => {
  const f = await fixture();
  const originalCreateCode = f.repository.createCode.bind(f.repository);
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.repository.createCode = async (code) => { entered(); await waiting; await originalCreateCode(code); };
  const pending = f.service.authorize({ user: f.admin, input: { ...f.params(), approved: true } });
  await started;
  const application = f.platformRepository.state.applications.get(f.client.applicationId);
  application.enabled = false; application.version += 1;
  await f.repository.revokeApplication({ applicationId: application.id, tenantId: application.tenantId, now: Date.now() });
  application.enabled = true; application.version += 1;
  release();
  const result = await pending;
  const code = new URL(result.redirectTo).searchParams.get('code');
  await assert.rejects(f.redeem(code), oauthError('invalid_grant'));
  assert.equal(f.repository.state.families.size, 0);
});

test('application changes invalidate outstanding codes without invalidating existing families by version alone', async () => {
  const f = await fixture(), tokens = await f.redeem(await f.code()), pendingCode = await f.code();
  const app = f.platformRepository.state.applications.get(f.client.applicationId);
  app.name = 'Updated client name'; app.version += 1;
  await assert.rejects(f.redeem(pendingCode), oauthError('invalid_grant'));
  assert.ok(await f.service.authenticateAccess(tokens.access_token));
});

test('MySQL application revocation atomically invalidates codes and families by tenant', async () => {
  const calls = [];
  const connection = { async beginTransaction() { calls.push({ sql: 'begin' }); }, async commit() { calls.push({ sql: 'commit' }); }, async rollback() { calls.push({ sql: 'rollback' }); }, release() { calls.push({ sql: 'release' }); }, async execute(sql, params) { calls.push({ sql, params }); return [{}]; } };
  const repo = createMysqlMcpOAuthRepository({ async execute() { return [[]]; }, async getConnection() { return connection; } });
  const now = Date.now(); await repo.revokeApplication({ applicationId: 'application', tenantId: 'tenant-a', now });
  const updates = calls.filter((call) => call.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 2); assert.match(updates[0].sql, /mcp_oauth_codes/); assert.match(updates[1].sql, /mcp_oauth_families/); assert.match(updates[0].sql, /JSON_SET.*revokedAt/);
  assert.match(updates[0].sql, /applicationId/); assert.match(updates[0].sql, /tenantId/);
  assert.deepEqual(updates[0].params, [new Date(now).toISOString(), 'application', 'tenant-a']);
  assert.deepEqual(calls.slice(-2).map((call) => call.sql), ['commit', 'release']);
});

test('MySQL redemption locks the code and atomically commits family and token issuance', async () => {
  const calls = [], code = { codeHash: 'hash', clientId: 'client', expiresAt: '2030-01-01T00:00:00Z', consumedAt: null };
  const connection = {
    async beginTransaction() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); }, release() { calls.push('release'); },
    async execute(sql, params) { calls.push(sql); if (sql.startsWith('SELECT')) return [[{ payload: JSON.stringify(code) }]]; if (sql.startsWith('UPDATE')) Object.assign(code, JSON.parse(params[0])); return [{ affectedRows: 1 }]; },
  };
  const pool = { async execute(sql) { calls.push(sql); return [[]]; }, async getConnection() { return connection; } };
  const repo = createMysqlMcpOAuthRepository(pool);
  assert.equal(await repo.redeemCode({ codeHash: 'hash', expected: { clientId: 'client' }, family: { id: 'family' }, tokens: [{ tokenHash: 'access', familyId: 'family' }, { tokenHash: 'refresh', familyId: 'family' }], now: Date.now() }), true);
  assert.ok(calls.some((sql) => sql.endsWith('FOR UPDATE')));
  assert.equal(calls.filter((sql) => sql.startsWith('INSERT INTO mcp_oauth_tokens')).length, 2);
  assert.deepEqual(calls.slice(-2), ['commit', 'release']);
  assert.equal(await repo.redeemCode({ codeHash: 'hash', expected: { clientId: 'client' }, family: { id: 'family2' }, tokens: [], now: Date.now() }), false);
});

test('MySQL rolls back code consumption if token issuance fails', async () => {
  const calls = [], code = { clientId: 'client', expiresAt: '2030-01-01T00:00:00Z' };
  const connection = {
    async beginTransaction() {}, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); }, release() { calls.push('release'); },
    async execute(sql) { if (sql.startsWith('SELECT')) return [[{ payload: code }]]; if (sql.startsWith('INSERT INTO mcp_oauth_tokens')) throw new Error('fixture SQL failure'); return [{}]; },
  };
  const repo = createMysqlMcpOAuthRepository({ async execute() { return [[]]; }, async getConnection() { return connection; } });
  await assert.rejects(repo.redeemCode({ codeHash: 'hash', expected: { clientId: 'client' }, family: { id: 'family' }, tokens: [{ tokenHash: 'access', familyId: 'family' }], now: Date.now() }), /fixture SQL failure/);
  assert.deepEqual(calls, ['rollback', 'release']);
});

test('MySQL refresh locks the family before the token and commits replay revocation', async () => {
  const calls = [];
  const family = { id: 'family', clientId: 'client', resource: RESOURCE, expiresAt: '2030-01-01T00:00:00Z', revokedAt: null };
  const oldToken = { tokenHash: 'old', familyId: 'family', kind: 'refresh', expiresAt: family.expiresAt, consumedAt: null };
  const connection = {
    async beginTransaction() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); }, release() { calls.push('release'); },
    async execute(sql, params) {
      calls.push(sql);
      if (sql.startsWith('SELECT')) return [[{ payload: structuredClone(sql.includes('mcp_oauth_families') ? family : oldToken) }]];
      if (sql.startsWith('UPDATE')) Object.assign(sql.includes('mcp_oauth_families') ? family : oldToken, JSON.parse(params[0]));
      return [{}];
    },
  };
  const repo = createMysqlMcpOAuthRepository({ async execute() { return [[]]; }, async getConnection() { return connection; } });
  const request = { tokenHash: 'old', clientId: 'client', resource: RESOURCE, tokens: [{ tokenHash: 'new', familyId: 'family' }], now: Date.now() };
  assert.equal(await repo.rotateRefresh(request), true);
  const locks = calls.filter((sql) => sql.endsWith('FOR UPDATE'));
  assert.equal(locks.length, 2); assert.match(locks[0], /mcp_oauth_families/); assert.match(locks[1], /mcp_oauth_tokens/);
  assert.ok(oldToken.consumedAt);
  const insertCount = calls.filter((sql) => sql.startsWith('INSERT')).length;
  assert.equal(await repo.rotateRefresh(request), false);
  assert.ok(family.revokedAt);
  assert.equal(calls.filter((sql) => sql.startsWith('INSERT')).length, insertCount);
  assert.deepEqual(calls.slice(-2), ['commit', 'release']);
});

test('MySQL refresh rejects wrong clients and resources before consuming a token', async () => {
  const family = { id: 'family', clientId: 'client', resource: RESOURCE, expiresAt: '2030-01-01T00:00:00Z' };
  const token = { familyId: 'family', kind: 'refresh', expiresAt: family.expiresAt };
  const updates = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql) { if (sql.startsWith('SELECT')) return [[{ payload: sql.includes('mcp_oauth_families') ? family : token }]]; updates.push(sql); return [{}]; },
  };
  const repo = createMysqlMcpOAuthRepository({ async execute() { return [[]]; }, async getConnection() { return connection; } });
  for (const request of [{ clientId: 'other', resource: RESOURCE }, { clientId: 'client', resource: 'https://other.example.test/mcp' }]) assert.equal(await repo.rotateRefresh({ ...request, tokenHash: 'old', tokens: [], now: Date.now() }), false);
  assert.deepEqual(updates, []);
});
