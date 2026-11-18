import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../lib/errors/http-error.js';
import { createClientMetadataResolver, isTrustedClientMetadataUrl, matchesMetadataRedirect } from './client-metadata.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = (kind) => `odin_mcp_${kind}_${randomBytes(48).toString('base64url')}`;
const scopesSchema = z.array(z.enum(['projects.read', 'projects.write'])).min(1).max(2).refine((scopes) => new Set(scopes).size === scopes.length);
const text = z.string().min(1).max(4096);
const redirectSchema = z.string().max(2048).refine((value) => {
  try { const uri = new URL(value); return !uri.username && !uri.password && !uri.hash && (uri.protocol === 'https:' || (uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname))); }
  catch { return false; }
});
// OAuth clients may supply language preferences; they do not affect authorization.
const localeHint = z.string().min(1).max(256).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?: [A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)*$/).refine(value => !/[\r\n]/.test(value));
const authorizationSchema = z.object({ client_id: text, response_type: z.literal('code'), redirect_uri: redirectSchema, scope: z.string().min(1).max(100), resource: text, state: z.string().min(1).max(1024), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), ui_locales: localeHint.optional() }).strict();
const codeSchema = z.object({ grant_type: z.literal('authorization_code'), client_id: text, code: text, redirect_uri: redirectSchema, code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), resource: text }).strict();
const refreshSchema = z.object({ grant_type: z.literal('refresh_token'), client_id: text, refresh_token: text, resource: text, scope: z.string().min(1).max(100).optional() }).strict();
const registerSchema = z.object({ name: z.string().trim().min(1).max(120), redirectUris: z.array(redirectSchema).min(1).max(10), scopes: scopesSchema.refine((scopes) => scopes.includes('projects.read')), projectIds: z.array(z.string().min(1).max(128)).max(500).default([]) }).strict();
function fail(error = 'invalid_request', status = 400) {
  const messages = { invalid_request: 'Invalid OAuth request.', invalid_client: 'Invalid OAuth client.', invalid_grant: 'Invalid or expired OAuth grant.', invalid_scope: 'Requested scope is not authorized.', invalid_token: 'Invalid or expired MCP access token.', access_denied: 'OAuth authorization denied.' };
  throw new HttpError(status, messages[error], { details: { error, error_description: messages[error] } });
}
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail(); return result.data; }
function parseScopes(value) { return parse(scopesSchema, value.split(/\s+/).filter(Boolean)); }
function isValid(record, now) { return record && !record.revokedAt && Date.parse(record.expiresAt) > now; }

export function createMcpOAuthService({ repository, platformRepository, authRepository, identityRepository, resourceUrl, now = Date.now, resolveClientMetadata = createClientMetadataResolver({ now }) }) {
  const resource = new URL(resourceUrl);
  if (resource.username || resource.password || resource.hash || resource.search || (resource.protocol !== 'https:' && !(resource.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(resource.hostname)))) throw new Error('MCP resource must use HTTPS or loopback HTTP.');
  async function clientFor(clientId, error = 'invalid_client') {
    const client = await repository.getClient(clientId);
    const application = client && await platformRepository.getOAuthApplicationByClientId({ clientId });
    if (!client || !application?.enabled || application.id !== client.applicationId || application.tenantId !== client.tenantId) fail(error, error === 'invalid_token' ? 401 : 400);
    return { client, application };
  }
  async function userFor(userId, tenantId, error = 'invalid_grant') {
    const current = await authRepository.findUserById(userId);
    const membership = current?.memberships?.find((entry) => entry.tenantId === tenantId);
    if (!membership) fail(error, error === 'invalid_token' ? 401 : 400);
    const capabilities = identityRepository?.resolveUserCapabilities ? await identityRepository.resolveUserCapabilities({ tenantId, userId }) : [];
    const { passwordHash: _passwordHash, twoFactorSecret: _twoFactorSecret, pendingTwoFactorSecret: _pendingTwoFactorSecret, backupCodes: _backupCodes, ...user } = current;
    return { ...user, memberships: [membership], capabilities };
  }
  async function validateGrant(family, scopes, error = 'invalid_grant') {
    if (!isValid(family, now()) || family.resource !== resourceUrl) fail(error, error === 'invalid_token' ? 401 : 400);
    const { application } = await clientFor(family.clientId, error);
    if (application.id !== family.applicationId || application.tenantId !== family.tenantId || scopes.some((scope) => !application.scopes.includes(scope))) fail(error, error === 'invalid_token' ? 401 : 400);
    const user = await userFor(family.userId, family.tenantId, error);
    let projectIds;
    if (family.projectIds.length === 0) projectIds = [...application.projectIds];
    else projectIds = application.projectIds.length === 0 ? [...family.projectIds] : family.projectIds.filter((id) => application.projectIds.includes(id));
    if (family.projectIds.length && !projectIds.length) fail(error, error === 'invalid_token' ? 401 : 400);
    return { user, grant: { applicationId: family.applicationId, clientId: family.clientId, clientName: application.name ?? '', familyId: family.id, grantType: 'authorization_code', projectIds, resource: resourceUrl, scopes: [...scopes], tenantId: family.tenantId } };
  }
  function tokenPair(family, scopes) {
    const at = now(), access = secret('access'), refresh = secret('refresh');
    const accessExpiry = Math.min(at + 3600_000, Date.parse(family.expiresAt));
    return {
      tokens: [
        { tokenHash: hash(access), familyId: family.id, kind: 'access', scopes, expiresAt: new Date(accessExpiry).toISOString() },
        { tokenHash: hash(refresh), familyId: family.id, kind: 'refresh', scopes, expiresAt: family.expiresAt, consumedAt: null },
      ],
      response: { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: Math.floor((accessExpiry - at) / 1000), scope: scopes.join(' ') },
    };
  }
  const automaticBindings = new Map();
  async function automaticClient(user, request, persist) {
    const tenantId = user?.memberships?.[0]?.tenantId;
    if (!tenantId) fail('access_denied', 403);
    await userFor(user.id, tenantId);
    const metadata = await resolveClientMetadata(request.client_id);
    if (!metadata.redirect_uris.some(uri => matchesMetadataRedirect(uri, request.redirect_uri))) fail();
    const clientId = `odin_mcp_client_auto_${hash(JSON.stringify([request.client_id, tenantId])).slice(0, 48)}`;
    const existing = await repository.getClient(clientId);
    if (existing) {
      const binding = await clientFor(clientId);
      return { ...binding, metadata };
    }
    const input = { name: metadata.client_name, redirectUris: metadata.redirect_uris, scopes: ['projects.read', 'projects.write'], projectIds: [] };
    if (!persist) return { metadata, client: { clientId, tenantId, ...input }, application: { ...input, enabled: true } };
    if (!automaticBindings.has(clientId)) {
      const pending = (async () => {
        let application = await platformRepository.getOAuthApplicationByClientId({ clientId });
        if (!application) {
          try { application = await platformRepository.createOAuthApplication({ clientId, clientSecretHash: hash(secret('unused')), createdBy: user.id, input, tenantId }); }
          catch (error) {
            if (error.code !== 'ER_DUP_ENTRY') throw error;
            application = await platformRepository.getOAuthApplicationByClientId({ clientId });
            if (!application) throw error;
          }
        }
        const client = { applicationId: application.id, clientId, tenantId, redirectUris: input.redirectUris, scopes: input.scopes, metadataClientId: request.client_id };
        try { await repository.createClient(client); }
        catch (error) { if (error.code !== 'ER_DUP_ENTRY') throw error; }
        return clientFor(clientId);
      })();
      automaticBindings.set(clientId, pending);
      try { return { ...await pending, metadata }; } finally { automaticBindings.delete(clientId); }
    }
    return { ...await automaticBindings.get(clientId), metadata };
  }
  async function authorization(user, input, persist = false) {
    const request = parse(authorizationSchema, input);
    if (request.resource !== resourceUrl) fail();
    const automatic = isTrustedClientMetadataUrl(request.client_id);
    const { client, application, metadata } = automatic ? await automaticClient(user, request, persist) : await clientFor(request.client_id);
    if (user?.memberships?.[0]?.tenantId !== client.tenantId) fail('access_denied', 403);
    await userFor(user.id, client.tenantId);
    const accepts = uris => uris.some(uri => automatic ? matchesMetadataRedirect(uri, request.redirect_uri) : uri === request.redirect_uri);
    if (!accepts(client.redirectUris) || !accepts(application.redirectUris)) fail();
    const scopes = parseScopes(request.scope);
    if (!scopes.includes('projects.read') || scopes.some((scope) => !client.scopes.includes(scope) || !application.scopes.includes(scope))) fail('invalid_scope');
    return { request, client, application, scopes, metadata };
  }
  return {
    async revokeClient({ user, clientId }) {
      const tenantId = user?.memberships?.[0]?.tenantId;
      if (!tenantId) fail('access_denied', 403);
      const current = await userFor(user.id, tenantId);
      if (current.memberships[0].role !== 'admin' && !current.capabilities.includes('integrations.manage')) fail('access_denied', 403);
      const client = await repository.getClient(clientId);
      if (!client || client.tenantId !== tenantId) throw new HttpError(404, 'MCP client not found.');
      const snapshot = await platformRepository.listSnapshot({ tenantId });
      if (!snapshot.applications.some((application) => application.id === client.applicationId && application.clientId === clientId)) throw new HttpError(404, 'MCP client not found.');
      await repository.revokeApplication({ applicationId: client.applicationId, tenantId, now: now() });
      return { ok: true };
    },
    async registerClient({ user, input }) {
      const value = parse(registerSchema, input), tenantId = user?.memberships?.[0]?.tenantId;
      if (!tenantId) fail('access_denied', 403);
      const current = await userFor(user.id, tenantId);
      if (current.memberships[0].role !== 'admin' && !current.capabilities.includes('integrations.manage')) fail('access_denied', 403);
      const clientId = `odin_mcp_client_${randomBytes(18).toString('base64url')}`;
      const application = await platformRepository.createOAuthApplication({ clientId, clientSecretHash: hash(secret('unused')), createdBy: user.id, input: value, tenantId });
      await repository.createClient({ applicationId: application.id, clientId, tenantId, redirectUris: value.redirectUris, scopes: value.scopes });
      return { applicationId: application.id, client_id: clientId, client_name: value.name, redirect_uris: value.redirectUris, scope: value.scopes.join(' '), projectIds: value.projectIds, tenantId, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
    },
    async consentInfo({ user, input }) {
      const { request, client, application, scopes } = await authorization(user, input);
      return { clientId: client.clientId, applicationId: application.id, name: application.name, tenantId: client.tenantId, projectIds: application.projectIds, scopes, redirectUri: request.redirect_uri, resource: resourceUrl };
    },
    async authorize({ user, input }) {
      const approved = parse(authorizationSchema.extend({ approved: z.literal(true) }), input);
      const { approved: _approved, ...params } = approved;
      // Application bindings are created only after this user explicitly approves access.
      await authorization(user, params);
      const { request, client, application, scopes } = await authorization(user, params, true);
      const code = secret('code');
      await repository.createCode({ codeHash: hash(code), applicationId: application.id, applicationVersion: application.version, clientId: client.clientId, oauthClientId: request.client_id, tenantId: client.tenantId, userId: user.id, resource: resourceUrl, redirectUri: request.redirect_uri, codeChallenge: request.code_challenge, scopes, projectIds: [...application.projectIds], expiresAt: new Date(now() + 300_000).toISOString(), consumedAt: null });
      const redirect = new URL(request.redirect_uri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', request.state);
      return { redirectTo: redirect.toString(), expiresIn: 300 };
    },
    async exchange(input) {
      if (input?.grant_type === 'authorization_code') {
        const request = parse(codeSchema, input); if (request.resource !== resourceUrl) fail();
        const code = await repository.getCode(hash(request.code));
        if (!code || (code.oauthClientId ?? code.clientId) !== request.client_id) fail('invalid_grant');
        const { application } = await clientFor(code.clientId);
        const expected = { clientId: code.clientId, redirectUri: request.redirect_uri, resource: resourceUrl, codeChallenge: createHash('sha256').update(request.code_verifier).digest('base64url') };
        if (!isValid(code, now()) || code.consumedAt || code.applicationVersion !== application.version || Object.entries(expected).some(([key, value]) => code[key] !== value)) fail('invalid_grant');
        const family = { id: randomUUID(), clientId: code.clientId, oauthClientId: code.oauthClientId ?? code.clientId, applicationId: code.applicationId, tenantId: code.tenantId, userId: code.userId, scopes: code.scopes, projectIds: code.projectIds, resource: resourceUrl, expiresAt: new Date(now() + 30 * 86400_000).toISOString(), revokedAt: null };
        await validateGrant(family, code.scopes);
        const pair = tokenPair(family, code.scopes);
        if (!await repository.redeemCode({ codeHash: hash(request.code), expected, family, tokens: pair.tokens, now: now() })) fail('invalid_grant');
        return pair.response;
      }
      if (input?.grant_type === 'refresh_token') {
        const request = parse(refreshSchema, input); if (request.resource !== resourceUrl) fail();
        const record = await repository.getToken(hash(request.refresh_token));
        if (!record || record.token.kind !== 'refresh' || (record.family?.oauthClientId ?? record.family?.clientId) !== request.client_id) fail('invalid_grant');
        const scopes = request.scope === undefined ? record.token.scopes : parseScopes(request.scope);
        if (!scopes.includes('projects.read') || scopes.some((scope) => !record.token.scopes.includes(scope))) fail('invalid_scope');
        await validateGrant(record.family, scopes);
        const pair = tokenPair(record.family, scopes);
        if (!await repository.rotateRefresh({ tokenHash: hash(request.refresh_token), clientId: record.family.clientId, resource: resourceUrl, tokens: pair.tokens, now: now() })) fail('invalid_grant');
        return pair.response;
      }
      fail();
    },
    async authenticateAccess(token) {
      if (typeof token !== 'string' || !/^odin_mcp_access_[A-Za-z0-9_-]{64}$/.test(token)) fail('invalid_token', 401);
      const record = await repository.getToken(hash(token));
      if (!record || record.token.kind !== 'access' || !isValid(record.token, now())) fail('invalid_token', 401);
      return validateGrant(record.family, record.token.scopes, 'invalid_token');
    },
    async revoke(input) {
      const request = parse(z.object({ token: text, client_id: text, token_type_hint: z.enum(['access_token', 'refresh_token']).optional() }).strict(), input);
      const record = await repository.getToken(hash(request.token));
      if ((record?.family?.oauthClientId ?? record?.family?.clientId) === request.client_id) await repository.revokeFamily({ familyId: record.family.id, clientId: record.family.clientId, now: now() });
      return {};
    },
  };
}
