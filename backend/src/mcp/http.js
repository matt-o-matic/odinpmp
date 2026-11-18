import { Router, urlencoded } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAuthMiddleware } from '../lib/http/auth-middleware.js';
import { HttpError } from '../lib/errors/http-error.js';
import { logBackendEvent } from '../lib/logging/backend-logger.js';
import { createOdinApiClient, OdinApiError } from './api-client.js';
import { createMcpTrafficLimiter, describeMcpRequest, sendMcpRefusal } from './mcp-traffic.js';
import { createOdinMcpServer } from './server.js';

export function validateMcpPublicUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('MCP_PUBLIC_URL must be the HTTPS /mcp endpoint, or HTTP loopback for tests.');
  }
  return url;
}

export function createMcpHttpRouter({ oauth, resourceUrl, frontendAppUrl, allowedOrigins = [], authRepository, tokenService, projectRepository, trafficLimiter = createMcpTrafficLimiter() }) {
  const router = Router();
  const resource = validateMcpPublicUrl(resourceUrl);
  const issuer = resource.origin;
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  const origins = new Set([resource.origin, new URL(frontendAppUrl).origin, ...allowedOrigins]);
  for (const origin of origins) if (new URL(origin).origin !== origin) throw new Error('MCP allowed origins must be exact origins.');
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="projects.read projects.write"`;
  router.use((req, res, next) => {
    if (req.path !== '/mcp' && !req.path.startsWith('/api/mcp/') && !['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'].includes(req.path)) return next('router');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin && !origins.has(req.headers.origin)) return res.status(403).json({ error: 'invalid_origin' });
    // The public origin is configured, never derived from an untrusted Host or forwarded header.
    const localHosts = [`127.0.0.1:${req.socket.localPort}`, `[::1]:${req.socket.localPort}`];
    if (req.headers.host !== resource.host && !localHosts.includes(req.headers.host)) return res.status(403).json({ error: 'invalid_host' });
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, X-CSRF-Token');
      return res.sendStatus(204);
    }
    next();
  });
  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({
    resource: resource.href, authorization_servers: [issuer], scopes_supported: ['projects.read', 'projects.write'], bearer_methods_supported: ['header'],
  }));
  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
    issuer, authorization_endpoint: `${issuer}/api/mcp/oauth/authorize`, token_endpoint: `${issuer}/api/mcp/oauth/token`,
    revocation_endpoint: `${issuer}/api/mcp/oauth/revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: ['projects.read', 'projects.write'],
    client_id_metadata_document_supported: true,
  }));
  const wrap = handler => async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  };
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });
  const requireRegular = (req, _res, next) => {
    if (req.auth?.impersonation || req.auth?.breakGlass) return next(new HttpError(403, 'Sign in with your own regular account.'));
    next();
  };
  router.post('/api/mcp/clients', requireAuth, requireRegular, wrap(async (req, res) => {
    const user = req.auth.user;
    if (user.memberships?.[0]?.role !== 'admin' && !user.capabilities?.includes('integrations.manage')) throw new HttpError(403, 'Integration administration is required.');
    if (Array.isArray(req.body?.projectIds) && req.body.projectIds.length) {
      const visible = new Set((await projectRepository.listProjectsForTenant({ tenantId: user.memberships[0].tenantId, user })).map(p => p.id));
      if (req.body.projectIds.some(id => !visible.has(id))) throw new HttpError(400, 'Invalid project selection.');
    }
    res.status(201).json(await oauth.registerClient({ user, input: req.body }));
  }));
  router.post('/api/mcp/clients/:clientId/revoke', requireAuth, requireRegular, wrap(async (req, res) => {
    res.json(await oauth.revokeClient({ user: req.auth.user, clientId: req.params.clientId }));
  }));
  router.get('/api/mcp/oauth/authorize', wrap(async (req, res) => {
    // The existing frontend router preserves this request through password, MFA and SSO login.
    const target = new URL(frontendAppUrl.endsWith('/') ? frontendAppUrl : `${frontendAppUrl}/`);
    target.pathname += 'mcp/authorize';
    target.search = new URLSearchParams(req.query).toString();
    res.redirect(302, target.href);
  }));
  router.get('/api/mcp/oauth/consent', requireAuth, requireRegular, wrap(async (req, res) => {
    const info = await oauth.consentInfo({ user: req.auth.user, input: req.query });
    const projects = await projectRepository.listProjectsForTenant({ tenantId: info.tenantId, user: req.auth.user });
    res.json({ ...info, projects: projects.filter(p => !info.projectIds.length || info.projectIds.includes(p.id)).map(p => ({ id: p.id, name: p.name })) });
  }));
  router.post('/api/mcp/oauth/authorize', requireAuth, requireRegular, wrap(async (req, res) => res.json(await oauth.authorize({ user: req.auth.user, input: req.body }))));
  router.post('/api/mcp/oauth/token', urlencoded({ extended: false, limit: '16kb' }), wrap(async (req, res) => res.json(await oauth.exchange(req.body))));
  router.post('/api/mcp/oauth/revoke', urlencoded({ extended: false, limit: '16kb' }), wrap(async (req, res) => res.json(await oauth.revoke(req.body))));
  router.all('/mcp', wrap(async (req, res) => {
    const header = req.headers.authorization ?? '';
    let auth;
    try { auth = await oauth.authenticateAccess(header.startsWith('Bearer ') ? header.slice(7) : ''); }
    catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 401) return res.status(503).json({ error: 'server_error' });
      res.setHeader('WWW-Authenticate', challenge); return res.status(401).json({ error: 'invalid_token' });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.sendStatus(405); }
    // One line per request: what it asked for (methods, tool names, the client an initialize
    // names; never arguments), how it ended and how long it took, for reading the traffic later.
    const started = Date.now();
    let outcome = 'handled';
    let queuedMs = 0;
    res.on('finish', () => logBackendEvent({
      context: {
        ...describeMcpRequest(req.body), grant: String(auth.grant.familyId ?? '').slice(0, 8), ms: Date.now() - started, outcome, queuedMs,
        status: res.statusCode, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 80),
      },
      message: 'MCP request.',
    }));
    const allowance = trafficLimiter.take(auth.grant.familyId);
    if (!allowance.allowed) {
      outcome = 'rate_limited';
      return sendMcpRefusal(res, { message: `Too many requests on this connection. Retry after ${allowance.retryAfterSeconds} seconds.`, retryAfterSeconds: allowance.retryAfterSeconds, status: 429 });
    }
    const release = await trafficLimiter.acquire();
    queuedMs = Date.now() - started;
    if (!release) {
      outcome = 'busy';
      return sendMcpRefusal(res, { message: 'Odin is handling too many MCP requests. Retry in a few seconds.', retryAfterSeconds: 5, status: 503 });
    }
    const address = req.socket.localAddress;
    const internalOrigin = `http://${address.includes(':') && !address.startsWith('::ffff:') ? '[::1]' : '127.0.0.1'}:${req.socket.localPort}`;
    const api = createOdinApiClient({ baseUrl: internalOrigin, token: header.slice(7), internalProof: tokenService.signMcpInternalProof });
    const server = createOdinMcpServer({ api, oauth: true, authorizeTool: ({ write }) => {
      if (!auth.grant.scopes.includes('projects.read') || (write && !auth.grant.scopes.includes('projects.write'))) {
        throw new OdinApiError(403, 'insufficient_scope', 'The MCP grant lacks the required scope.');
      }
    } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
      release();
    }
  }));
  router.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status = error instanceof HttpError ? error.statusCode : 500;
    res.status(status).json({ error: error.details?.error ?? (status === 500 ? 'server_error' : 'invalid_request'),
      error_description: error.details?.error_description ?? (status === 500 ? 'Odin could not complete the request.' : 'Odin rejected the request.') });
  });
  return router;
}
