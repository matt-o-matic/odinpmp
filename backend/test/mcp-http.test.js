import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { validateMcpPublicUrl } from '../src/mcp/http.js';
import { createMcpTrafficLimiter } from '../src/mcp/mcp-traffic.js';
import { loadEnv } from '../src/config/env.js';

async function fixture(t, options = {}) {
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true,
    tenants: [{ id: 'tenant-fixture', name: 'Disposable workspace', domains: ['example.com'] }],
    users: ['admin', 'viewer'].map(id => ({ id, name: id, email: `${id}@example.com`, password: 'Fixture-password-123!', authMethod: 'basic', preferences: {}, memberships: [{ tenantId: 'tenant-fixture', role: id === 'admin' ? 'admin' : 'user' }] })) });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projects: ['allowed-project', 'other-project'].map(id => ({ id, name: id, tenantId: 'tenant-fixture', status: 'Planned', epics: [] })),
    projectMemberships: Object.fromEntries(['allowed-project', 'other-project'].map(id => [id, [{ id: 'admin', role: 'admin' }, { id: 'viewer', role: 'viewer' }]])),
  } });
  const repository = createInMemoryMcpOAuthRepository();
  const http = createServer();
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({ authRepository, projectRepository, mcpOAuthRepository: repository, mcpPublicUrl: resource,
    frontendAppUrl: 'https://frontend-fixture.example/app', tokenService: createTokenService({ issuer: 'mcp-http-fixture', secret: 'disposable-fixture-secret' }), ...options });
  http.on('request', app);
  t.after(async () => { await app.locals.beginDrain({ timeoutMs: 1000 }); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); assert.equal(http.listening, false); });
  async function request(path, body, token, headers = {}) {
    return fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  async function login(id) { const response = await request('/api/auth/login', { email: `${id}@example.com`, password: 'Fixture-password-123!' }, null, { 'X-Auth-Response': 'bearer' }); assert.equal(response.status, 200); return (await response.json()).session.token; }
  const admin = await login('admin');
  async function register(scopes = ['projects.read', 'projects.write'], projectIds = []) {
    const response = await request('/api/mcp/clients', { name: 'Disposable MCP client', redirectUris: ['http://127.0.0.1:54321/callback'], scopes, projectIds }, admin);
    assert.equal(response.status, 201); return response.json();
  }
  async function grant(client, userToken = admin) {
    const verifier = 'v'.repeat(64);
    const params = { client_id: client.client_id, response_type: 'code', redirect_uri: client.redirect_uris[0], scope: client.scope, state: 'fixture-state', resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    const response = await request('/api/mcp/oauth/authorize', { ...params, approved: true }, userToken);
    assert.equal(response.status, 200);
    const code = new URL((await response.json()).redirectTo).searchParams.get('code');
    const exchange = await request('/api/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: params.redirect_uri, resource });
    assert.equal(exchange.status, 200); return exchange.json();
  }
  async function connect(tokens) {
    const client = new Client({ name: 'fixture', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }, reconnectionOptions: { maxRetries: 0 } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 5000 });
    return { client, call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      return { result, data: JSON.parse(result.content[0].text) };
    } };
  }
  return { origin, resource, request, login, admin, register, grant, connect, repository, projectRepository, app };
}

test('hosted MCP configuration is opt-in and binds to a fixed HTTPS public origin', () => {
  assert.equal(loadEnv({ NODE_ENV: 'test' }).mcpPublicUrl, '');
  const env = loadEnv({ NODE_ENV: 'test', BACKEND_PUBLIC_URL: 'https://odin.example', MCP_PUBLIC_URL: 'https://odin.example/mcp', MCP_ALLOWED_ORIGINS: 'https://client.example' });
  assert.equal(env.mcpPublicUrl, 'https://odin.example/mcp');
  assert.ok(env.mcpAllowedOrigins.includes('https://client.example'));
  for (const url of ['http://remote.example/mcp', 'https://odin.example/other', 'https://user:pass@odin.example/mcp', 'https://odin.example/mcp?x=1']) assert.throws(() => validateMcpPublicUrl(url));
  assert.throws(() => loadEnv({ NODE_ENV: 'test', MCP_PUBLIC_URL: 'https://other.example/mcp' }));
});

test('internal REST proofs bind the credential, method, path and audience', () => {
  const service = createTokenService({ issuer: 'proof-fixture', secret: 'proof-fixture-secret' });
  const request = { token: 'fixture-access', method: 'GET', path: '/api/projects' };
  const proof = service.signMcpInternalProof(request);
  assert.doesNotThrow(() => service.verifyMcpInternalProof(proof, request));
  for (const change of [{ token: 'other' }, { method: 'POST' }, { path: '/api/projects/other' }]) assert.throws(() => service.verifyMcpInternalProof(proof, { ...request, ...change }));
  assert.throws(() => service.verifySessionToken(proof));
  assert.throws(() => service.verifyMcpInternalProof(service.signSessionToken({ id: 'fixture-user' }), request));
});

test('hosted endpoint discovers OAuth, initializes and calls real Odin routes with revocable, scoped grants', { timeout: 30000 }, async t => {
  const env = await fixture(t);
  const unauthenticated = await env.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(unauthenticated.status, 401);
  const authenticate = env.app.locals.mcpOAuthService.authenticateAccess;
  env.app.locals.mcpOAuthService.authenticateAccess = () => { throw new Error('fixture-private-credential-marker'); };
  const unavailable = await env.request('/mcp', {});
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'server_error' });
  assert.equal(unavailable.headers.has('www-authenticate'), false);
  env.app.locals.mcpOAuthService.authenticateAccess = authenticate;
  assert.match(unauthenticated.headers.get('www-authenticate'), /resource_metadata=.*oauth-protected-resource\/mcp/);
  const metadata = await (await env.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, env.resource);
  const authorizationServer = await (await env.request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(authorizationServer.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(authorizationServer.client_id_metadata_document_supported, true);
  assert.ok(authorizationServer.grant_types_supported.includes('refresh_token'));
  assert.equal((await env.request('/mcp', {}, null, { Origin: 'https://evil.invalid' })).status, 403);
  const preflight = await fetch(`${env.origin}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://frontend-fixture.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,mcp-protocol-version' }, signal: AbortSignal.timeout(5000) });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /MCP-Protocol-Version/);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://frontend-fixture.example');
  const credentialedResponse = await env.request('/api/mcp/oauth/consent', undefined, env.admin, { Origin: 'https://frontend-fixture.example' });
  assert.equal(credentialedResponse.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(credentialedResponse.headers.get('access-control-allow-origin'), 'https://frontend-fixture.example');
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${env.origin}/mcp`, { headers: { Host: 'evil.invalid' }, timeout: 5000 }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Fixture timed out.'))); request.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await env.request('/api/mcp/clients', { name: 'Denied' }, await env.login('viewer'))).status, 403);
  const registration = await env.register();
  const tokens = await env.grant(registration);
  const sdk = await env.connect(tokens);
  assert.equal(sdk.client.getServerVersion().name, 'odin-v2');
  assert.equal((await sdk.client.listTools({}, { timeout: 5000 })).tools.length, 151);
  assert.equal((await sdk.call('odin_list_projects')).data.total, 2);
  const created = await sdk.call('odin_create_project', { input: { name: 'OAuth-created fixture', status: 'Planned' } });
  assert.equal(created.result.isError, undefined);
  const projectId = 'allowed-project';
  const initial = (await sdk.call('odin_get_project', { projectId })).data.project;
  const briefInput = { expectedUpdatedAt: initial.briefUpdatedAt, patch: { constraints: ['OAuth constraint'], implementationEffort: 'OAuth effort' } };
  const briefSaved = await sdk.call('odin_update_project_brief', { projectId, input: briefInput });
  assert.equal(briefSaved.result.isError, undefined);
  assert.deepEqual((await sdk.call('odin_get_project_brief', { projectId })).data.brief.constraints, ['OAuth constraint']);
  assert.equal((await sdk.call('odin_update_project_brief', { projectId, input: briefInput })).data.error.status, 409);
  const projectInput = { name: 'Maintained OAuth fixture', status: 'Planned', expectedUpdatedAt: initial.updatedAt };
  assert.equal((await sdk.call('odin_update_project', { projectId, input: projectInput })).result.isError, undefined);
  assert.equal((await sdk.call('odin_update_project', { projectId, input: projectInput })).data.error.status, 409);
  const epic = (await sdk.call('odin_create_item', { projectId, input: { itemType: 'epic', item: { name: 'OAuth epic' } } })).data.item;
  const story = (await sdk.call('odin_create_item', { projectId, input: { itemType: 'story', parentId: epic.id, item: { name: 'OAuth story' } } })).data.item;
  let task = (await sdk.call('odin_create_item', { projectId, input: { itemType: 'task', parentId: story.id, item: { name: 'OAuth task' } } })).data.item;
  task = (await sdk.call('odin_update_item', { projectId, itemId: task.id, input: { expectedVersion: task.version, patch: { description: 'Updated through HTTP OAuth', priority: 2 } } })).data.item;
  assert.equal((await sdk.call('odin_get_item', { projectId, itemId: task.id })).data.item.priority, 2);
  assert.equal((await sdk.call('odin_list_items', { projectId, limit: 1 })).data.total, 3);
  const commentTarget = { projectId, targetType: 'task', targetId: task.id };
  const comment = (await sdk.call('odin_add_comment', { projectId, input: { targetType: 'task', targetId: task.id, comment: 'HTTP fixture comment' } })).data.comment;
  assert.equal((await sdk.call('odin_update_comment', { ...commentTarget, commentId: comment.id, comment: 'Edited HTTP fixture' })).result.isError, undefined);
  assert.equal((await sdk.call('odin_list_comments', commentTarget)).data.total, 1);
  assert.equal((await sdk.call('odin_delete_comment', { ...commentTarget, commentId: comment.id })).result.isError, undefined);
  const config = (await sdk.call('odin_get_board_config', { projectId })).data.config;
  assert.equal((await sdk.call('odin_update_board_config', { projectId, config })).result.isError, undefined);
  assert.equal((await sdk.call('odin_get_board', { projectId })).result.isError, undefined);
  const sprint = (await sdk.call('odin_create_sprint', { projectId, input: { name: 'HTTP sprint' } })).data.sprint;
  assert.equal((await sdk.call('odin_update_sprint', { projectId, sprintId: sprint.id, input: { name: 'Updated HTTP sprint' } })).result.isError, undefined);
  assert.equal((await sdk.call('odin_activate_sprint', { projectId, sprintId: sprint.id })).data.sprint.status, 'active');
  assert.equal((await sdk.call('odin_complete_sprint', { projectId, sprintId: sprint.id })).data.sprint.status, 'completed');
  assert.equal((await sdk.call('odin_list_sprints', { projectId })).data.total, 1);
  assert.equal((await sdk.call('odin_get_workflows', { projectId })).result.isError, undefined);
  assert.equal((await sdk.call('odin_delete_item', { projectId, itemId: task.id, expectedVersion: task.version })).result.isError, undefined);
  const before = env.projectRepository.state.projects.length;
  const dry = await sdk.call('odin_create_project', { dryRun: true, input: { name: 'Preview', status: 'Planned' } });
  assert.equal(dry.data.validation, 'schema_only');
  assert.equal(env.projectRepository.state.projects.length, before);
  const scoped = await env.connect(await env.grant(await env.register(['projects.read'], ['allowed-project'])));
  assert.equal((await scoped.call('odin_get_project_brief', { projectId })).result.isError, undefined);
  assert.equal((await scoped.call('odin_get_project_brief', { projectId: 'other-project' })).data.error.status, 404);
  for (const dryRun of [false, true]) assert.equal((await scoped.call('odin_update_project_brief', { projectId, input: briefInput, dryRun })).data.error.status, 403);
  const scopedWrite = await env.connect(await env.grant(await env.register(['projects.read', 'projects.write'], ['allowed-project'])));
  assert.equal((await scopedWrite.call('odin_update_project_brief', { projectId: 'other-project', input: briefInput })).data.error.status, 404);
  assert.deepEqual((await scoped.call('odin_list_projects')).data.items.map(p => p.id), ['allowed-project']);
  assert.equal((await scoped.call('odin_get_project', { projectId: 'other-project' })).data.error.status, 404);
  assert.equal((await scoped.call('odin_create_project', { dryRun: true, input: { name: 'Denied preview', status: 'Planned' } })).data.error.status, 403);
  const viewer = await env.connect(await env.grant(registration, await env.login('viewer')));
  assert.equal((await viewer.call('odin_update_project_brief', { projectId, input: briefInput })).data.error.status, 404);
  assert.equal((await viewer.call('odin_update_board_config', { projectId: 'allowed-project', config: { columns: [] } })).data.error.status, 404);
  assert.equal((await env.request('/api/identity', undefined, tokens.access_token)).status, 401);
  assert.equal((await env.request('/api/projects/allowed-project/export', undefined, tokens.access_token)).status, 401);
  assert.equal((await env.request('/api/projects/allowed-project/comments?targetType=ticket&targetId=fixture-ticket', undefined, tokens.access_token)).status, 401);
  const refresh = await env.request('/api/mcp/oauth/token', { grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: tokens.refresh_token, resource: env.resource });
  assert.equal(refresh.status, 200);
  const renewed = await refresh.json();
  assert.notEqual(renewed.refresh_token, tokens.refresh_token);
  assert.equal((await env.request('/api/mcp/oauth/revoke', { client_id: registration.client_id, token: renewed.refresh_token })).status, 200);
  assert.equal((await env.request('/mcp', {}, renewed.access_token)).status, 401);
  assert.equal((await env.request('/mcp', {}, tokens.access_token)).status, 401);
});

test('SDK discovers OpenAI metadata registration and completes login and refresh without a supplied client ID', { timeout: 30000 }, async t => {
  const env = await fixture(t);
  const metadataUrl = 'https://chatgpt.com/oauth/codex/client.json';
  const { createClientMetadataResolver } = await import('../src/mcp/client-metadata.js');
  const resolve = createClientMetadataResolver();
  const metadata = await resolve(metadataUrl);
  assert.ok(metadata.redirect_uris.includes('http://127.0.0.1/callback'));
  let tokens, verifier, authorizationUrl, clientInformation;
  const provider = {
    redirectUrl: 'http://127.0.0.1:54321/callback', clientMetadataUrl: metadataUrl,
    clientMetadata: { client_name: 'Codex', redirect_uris: ['http://127.0.0.1:54321/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    clientInformation: () => clientInformation, saveClientInformation: value => { clientInformation = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
    redirectToAuthorization: value => { authorizationUrl = value; }, state: () => 'automatic-client-state',
  };
  const initial = new StreamableHTTPClientTransport(new URL(env.resource), { authProvider: provider });
  const client = new Client({ name: 'automatic-client-fixture', version: '1' });
  await assert.rejects(client.connect(initial, { timeout: 5000 }));
  assert.equal(clientInformation.client_id, metadataUrl);
  assert.equal(authorizationUrl.searchParams.get('scope'), 'projects.read projects.write');
  authorizationUrl.searchParams.set('ui_locales', 'en-US');
  const params = Object.fromEntries(authorizationUrl.searchParams);
  const consent = await env.request(`/api/mcp/oauth/consent?${authorizationUrl.searchParams}`, undefined, env.admin);
  assert.equal(consent.status, 200);
  assert.equal(env.repository.state.clients.size, 0);
  const approved = await env.request('/api/mcp/oauth/authorize', { ...params, approved: true }, env.admin);
  assert.equal(approved.status, 200);
  const callback = new URL((await approved.json()).redirectTo);
  assert.equal(callback.searchParams.get('state'), 'automatic-client-state');
  await initial.finishAuth(callback.searchParams.get('code'));
  await initial.close();
  const transport = new StreamableHTTPClientTransport(new URL(env.resource), { authProvider: provider });
  const connected = new Client({ name: 'automatic-client-fixture', version: '1' });
  t.after(() => connected.close());
  await connected.connect(transport, { timeout: 5000 });
  const catalog = (await connected.listTools({}, { timeout: 5000 })).tools;
  assert.equal(catalog.length, 151);
  const read = catalog.find(tool => tool.name === 'odin_list_projects');
  assert.deepEqual(read._meta.securitySchemes, [{ type: 'oauth2', scopes: ['projects.read'] }]);
  const write = catalog.find(tool => tool.name === 'odin_create_project');
  assert.deepEqual(write._meta.securitySchemes, [{ type: 'oauth2', scopes: ['projects.read', 'projects.write'] }]);
  // The SDK drops extension fields outside _meta; verify the ChatGPT field on the wire as well.
  const discovery = await env.request('/mcp', { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }, tokens.access_token, { Accept: 'application/json, text/event-stream' });
  assert.equal(discovery.status, 200);
  const wireCatalog = (await discovery.json()).result.tools;
  const wireWrite = wireCatalog.find(tool => tool.name === 'odin_create_project');
  assert.deepEqual(wireWrite.securitySchemes, write._meta.securitySchemes);
  // The change tools go out on the wire with the scopes they need.
  assert.deepEqual(['odin_get_project_changes', 'odin_get_item_details', 'odin_apply_item_changes'].map(name => wireCatalog.find(tool => tool.name === name)?.securitySchemes[0].scopes),
    [['projects.read'], ['projects.read'], ['projects.read', 'projects.write']]);
  assert.equal((await connected.callTool({ name: 'odin_list_projects', arguments: {} }, undefined, { timeout: 5000 })).isError, undefined);
  const oldRefresh = tokens.refresh_token;
  env.repository.state.tokens.get(createHash('sha256').update(tokens.access_token).digest('hex')).expiresAt = new Date(0).toISOString();
  assert.equal((await connected.callTool({ name: 'odin_create_project', arguments: { input: { name: 'Automatic OAuth fixture', status: 'Planned' } } }, undefined, { timeout: 5000 })).isError, undefined);
  assert.notEqual(tokens.refresh_token, oldRefresh);
  assert.equal((await env.request('/api/mcp/oauth/revoke', { client_id: metadataUrl, token: tokens.refresh_token })).status, 200);
  assert.equal((await env.request('/mcp', {}, tokens.access_token)).status, 401);
});

test('application disable and re-enable never resurrect delegated MCP credentials', { timeout: 30000 }, async t => {
  const env = await fixture(t);
  const registered = await env.register();
  const tokens = await env.grant(registered);
  const app = await env.app.locals.platformRepository.getOAuthApplicationByClientId({ clientId: registered.client_id });
  const patch = async input => fetch(`${env.origin}/api/integrations/oauth-applications/${app.id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${env.admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
  });
  const disabled = await patch({ enabled: false, expectedVersion: app.version });
  assert.equal(disabled.status, 200);
  const reenabled = await patch({ enabled: true, expectedVersion: (await disabled.json()).value.version });
  assert.equal(reenabled.status, 200);
  assert.equal((await env.request('/mcp', {}, tokens.access_token)).status, 401);
  const refreshed = await env.request('/api/mcp/oauth/token', { grant_type: 'refresh_token', client_id: registered.client_id, refresh_token: tokens.refresh_token, resource: env.resource });
  assert.equal(refreshed.status, 400);
  const fresh = await env.grant(registered);
  assert.equal((await env.request(`/api/mcp/clients/${registered.client_id}/revoke`, {}, await env.login('viewer'))).status, 403);
  assert.equal((await env.request(`/api/mcp/clients/${registered.client_id}/revoke`, {}, env.admin)).status, 200);
  assert.equal((await env.request('/mcp', {}, fresh.access_token)).status, 401);
});

test('SDK OAuth discovery, PKCE completion and automatic refresh work without copied access tokens', { timeout: 30000 }, async t => {
  const env = await fixture(t);
  const registered = await env.register();
  let tokens, verifier, authorizationUrl;
  const provider = {
    redirectUrl: registered.redirect_uris[0],
    clientMetadata: { client_name: 'SDK fixture', redirect_uris: registered.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: registered.scope },
    clientInformation: () => ({ client_id: registered.client_id, issuer: env.origin }),
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: value => { authorizationUrl = value; },
    state: () => 'sdk-fixture-state',
  };
  const first = new StreamableHTTPClientTransport(new URL(env.resource), { authProvider: provider });
  const client = new Client({ name: 'oauth-sdk-fixture', version: '1' });
  await assert.rejects(() => client.connect(first, { timeout: 5000 }));
  assert.equal(authorizationUrl.pathname, '/api/mcp/oauth/authorize');
  assert.equal(authorizationUrl.searchParams.get('resource'), env.resource);
  // Request write consent explicitly; the initial challenge requires only reads.
  assert.equal(await auth(provider, { serverUrl: env.resource, scope: registered.scope }), 'REDIRECT');
  assert.equal(authorizationUrl.searchParams.get('scope'), registered.scope);
  const params = Object.fromEntries(authorizationUrl.searchParams);
  const consent = await env.request('/api/mcp/oauth/authorize', { ...params, approved: true }, env.admin);
  assert.equal(consent.status, 200);
  const code = new URL((await consent.json()).redirectTo).searchParams.get('code');
  await first.finishAuth(code);
  assert.ok(tokens.refresh_token);
  assert.ok(tokens.scope.includes('projects.write'));
  await first.close();
  const transport = new StreamableHTTPClientTransport(new URL(env.resource), { authProvider: provider });
  const connected = new Client({ name: 'oauth-sdk-fixture', version: '1' });
  t.after(() => connected.close());
  await connected.connect(transport, { timeout: 5000 });
  assert.equal((await connected.listTools({}, { timeout: 5000 })).tools.length, 151);
  const previousRefresh = tokens.refresh_token;
  const tokenHash = createHash('sha256').update(tokens.access_token).digest('hex');
  env.repository.state.tokens.get(tokenHash).expiresAt = new Date(0).toISOString();
  const result = await connected.callTool({ name: 'odin_list_projects', arguments: {} }, undefined, { timeout: 5000 });
  assert.equal(result.isError, undefined);
  assert.notEqual(tokens.refresh_token, previousRefresh);
  const write = await connected.callTool({ name: 'odin_create_project', arguments: { input: { name: 'SDK renewed write fixture', status: 'Planned' } } }, undefined, { timeout: 5000 });
  assert.equal(write.isError, undefined);
  assert.equal(authorizationUrl.searchParams.get('state'), 'sdk-fixture-state');
});

test('a grant past its burst is told when to come back, and each request logs its methods and tools, not arguments', { timeout: 30000 }, async t => {
  const env = await fixture(t, { mcpTrafficLimiter: createMcpTrafficLimiter({ grant: { capacity: 4, refillPerSecond: 0.01 } }) });
  const logged = [];
  const log = console.log;
  console.log = (line, ...rest) => { if (typeof line === 'string' && line.includes('"MCP request."')) logged.push(JSON.parse(line).context); else log(line, ...rest); };
  t.after(() => { console.log = log; });
  const tokens = await env.grant(await env.register());
  const sdk = await env.connect(tokens);
  assert.equal((await sdk.call('odin_list_projects', { search: 'private-argument-marker' })).data.total, 0);
  await sdk.client.listTools({}, { timeout: 5000 });
  const refused = await env.request('/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/list' }, tokens.access_token, { Accept: 'application/json, text/event-stream' });
  assert.equal(refused.status, 429);
  assert.match(refused.headers.get('retry-after'), /^\d+$/);
  assert.deepEqual((await refused.json()).error.code, -32000);
  // Another connection has its own allowance.
  const other = await env.connect(await env.grant(await env.register()));
  assert.equal((await other.client.listTools({}, { timeout: 5000 })).tools.length, 151);

  await new Promise(resolve => setImmediate(resolve));
  const first = logged.filter(entry => entry.grant === logged[0].grant);
  assert.deepEqual(first.map(entry => [entry.methods.join(','), entry.tools?.join(',') ?? '', entry.outcome, entry.status]), [
    ['initialize', '', 'handled', 200], ['notifications/initialized', '', 'handled', 202], ['tools/call', 'odin_list_projects', 'handled', 200],
    ['tools/list', '', 'handled', 200], ['tools/list', '', 'rate_limited', 429],
  ]);
  assert.equal(first[0].client.name, 'fixture');
  assert.ok(!JSON.stringify(logged).includes('private-argument-marker'));
});

test('tools built once for every request still run each call with its own grant, however calls interleave', { timeout: 30000 }, async t => {
  const env = await fixture(t);
  const full = await env.connect(await env.grant(await env.register()));
  const limited = await env.connect(await env.grant(await env.register(['projects.read'], ['allowed-project'])));
  const calls = Array.from({ length: 40 }, (_, index) => (index % 2 ? full : limited).call('odin_list_projects').then(result => [index % 2 ? 'full' : 'limited', result.data.total]));
  const totals = await Promise.all(calls);
  assert.deepEqual([...new Set(totals.filter(([who]) => who === 'full').map(([, total]) => total))], [2]);
  assert.deepEqual([...new Set(totals.filter(([who]) => who === 'limited').map(([, total]) => total))], [1]);
  // A read-only grant still can't write, even while a full grant writes alongside it.
  const [written, refused] = await Promise.all([
    full.call('odin_create_project', { input: { name: 'Interleaved write', status: 'Planned' } }),
    limited.call('odin_create_project', { input: { name: 'Not allowed', status: 'Planned' } }),
  ]);
  assert.equal(written.result.isError, undefined);
  assert.equal(refused.result.isError, true);
});
