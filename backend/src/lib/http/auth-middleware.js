import { HttpError } from '../errors/http-error.js';
import { buildRequestLogContext, logBackendError } from '../logging/backend-logger.js';
import { AUTH_COOKIE_NAMES, getAuthCookie, requireCsrfForCookieAuth } from '../auth/auth-cookies.js';
import { isGuestToken } from '../auth/guest-token.js';
import { requireMcpRouteAccess } from '../../mcp/route-access.js';
import { mcpChannel, runWithRequestChannel } from './request-channel.js';

function getBearerToken(request) {
  const authorization = request.headers.authorization ?? '';

  if (!authorization.startsWith('Bearer ')) {
    return '';
  }

  return authorization.slice('Bearer '.length).trim();
}

function isExpectedTokenError(error) {
  const name = String(error?.name ?? '').trim();
  return name === 'JsonWebTokenError' || name === 'TokenExpiredError' || name === 'NotBeforeError';
}

export function createAuthMiddleware({ authRepository, identityRepository = null, tokenService, allowMcp = false }) {
  return async function authMiddleware(request, _response, next) {
    try {
      const bearerToken = getBearerToken(request);
      const cookieToken = getAuthCookie(request, AUTH_COOKIE_NAMES.access);
      const token = bearerToken || cookieToken;

      if (!token) {
        throw new HttpError(401, 'Authentication required.');
      }

      // A channel guest's session works only under /api/guest (docs/engagements/plan.md, Guests).
      if (isGuestToken(token)) {
        throw new HttpError(403, 'Guests cannot use this part of Odin.', { details: { code: 'guest_not_allowed' } });
      }

      if (allowMcp && bearerToken.startsWith('odin_mcp_access_') && request.app.locals.mcpOAuthService) {
        // Only the hosted MCP dispatcher may reuse this credential inside Odin's REST routes.
        try { tokenService.verifyMcpInternalProof(request.headers['x-odin-mcp-internal'], { token: bearerToken, method: request.method, path: request.originalUrl }); }
        catch { throw new HttpError(401, 'Authentication required.'); }
        const { user, grant } = await request.app.locals.mcpOAuthService.authenticateAccess(bearerToken);
        requireMcpRouteAccess(request, grant);
        request.auth = { user, mcpGrant: grant, credentialSource: 'mcp', token: bearerToken,
          actor: null, breakGlass: null, impersonation: null, sessionId: '', tokenPayload: { tenantId: grant.tenantId } };
        runWithRequestChannel(mcpChannel(grant.clientName), next);
        return;
      }

      const decoded = tokenService.verifySessionToken(token);
      if (!['session', 'impersonation-session', 'break-glass-session'].includes(decoded?.type)) {
        throw new HttpError(401, 'Session is no longer valid.');
      }
      const sessionId = typeof decoded?.jti === 'string' ? decoded.jti : '';
      const sessionsRepository = request.app?.locals?.sessionsRepository;
      if (!sessionsRepository) {
        throw new HttpError(503, 'Session store is not configured.');
      }

      const tokenRecord = sessionId
        ? await sessionsRepository.validateSession({ sessionId, userId: decoded.sub })
        : await sessionsRepository.validateToken({ token });

      if (!tokenRecord.ok || !tokenRecord.session) {
        throw new HttpError(401, 'Session is no longer valid.');
      }

      if (tokenRecord.session.userId && tokenRecord.session.userId !== decoded.sub) {
        throw new HttpError(401, 'Session is no longer valid.');
      }
      const repositoryUser = await authRepository.findUserById(decoded.sub);

      // A stakeholder's file-owner account cannot sign in, so no session of its own is honoured.
      if (!repositoryUser || repositoryUser.loginDisabled) {
        throw new HttpError(401, 'Session is no longer valid.');
      }
      const user = {
        ...repositoryUser,
        memberships: [...(repositoryUser.memberships ?? [])],
      };
      const activeTenantId = typeof decoded?.tenantId === 'string' ? decoded.tenantId : '';
      if (activeTenantId) {
        const activeMembership = user.memberships?.find((membership) => membership.tenantId === activeTenantId);
        if (!activeMembership) {
          throw new HttpError(401, 'The selected tenant membership is no longer valid.');
        }
        user.memberships = [
          activeMembership,
          ...user.memberships.filter((membership) => membership.tenantId !== activeTenantId),
        ];
      }
      const capabilityRepository = identityRepository ?? request.app?.locals?.identityRepository;
      const effectiveTenantId = user.memberships?.[0]?.tenantId ?? '';
      user.capabilities = capabilityRepository?.resolveUserCapabilities && effectiveTenantId
        ? await capabilityRepository.resolveUserCapabilities({ tenantId: effectiveTenantId, userId: user.id })
        : [];

      let actor = null;
      let breakGlass = null;
      let impersonation = null;
      if (decoded.type === 'impersonation-session') {
        const grantId = String(decoded.impersonationGrantId ?? '').trim();
        const actorId = String(decoded.actorId ?? '').trim();
        const grant = await capabilityRepository?.getImpersonationGrant?.({ grantId, tenantId: effectiveTenantId });
        if (
          !grant
          || grant.status !== 'active'
          || grant.targetUserId !== user.id
          || grant.requesterUserId !== actorId
          || Date.parse(grant.expiresAt) <= Date.now()
        ) {
          throw new HttpError(401, 'Impersonation session is no longer valid.');
        }
        const repositoryActor = await authRepository.findUserById(actorId);
        const actorMembership = repositoryActor?.memberships?.find((membership) => membership.tenantId === effectiveTenantId);
        if (!repositoryActor || !actorMembership) {
          throw new HttpError(401, 'Impersonation session is no longer valid.');
        }
        actor = {
          ...repositoryActor,
          capabilities: capabilityRepository?.resolveUserCapabilities
            ? await capabilityRepository.resolveUserCapabilities({ tenantId: effectiveTenantId, userId: actorId })
            : [],
          memberships: [actorMembership, ...(repositoryActor.memberships ?? []).filter((membership) => membership.tenantId !== effectiveTenantId)],
        };
        impersonation = {
          actorId,
          expiresAt: grant.expiresAt,
          grantId,
          reason: grant.reason,
          targetUserId: user.id,
        };
      }
      if (decoded.type === 'break-glass-session') {
        const policy = await capabilityRepository?.getBreakGlassPolicy?.({ tenantId: effectiveTenantId });
        const membership = user.memberships?.find((item) => item.tenantId === effectiveTenantId);
        if (
          !policy?.enabled
          || policy.version !== decoded.policyVersion
          || !policy.userIds?.includes(user.id)
          || user.authMethod !== 'basic'
          || membership?.role !== 'admin'
          || !user.preferences?.twoFactorEnabled
        ) {
          throw new HttpError(401, 'Emergency access session is no longer valid.');
        }
        breakGlass = {
          expiresAt: typeof decoded.exp === 'number' ? new Date(decoded.exp * 1000).toISOString() : null,
          policyVersion: policy.version,
          reason: String(decoded.reason ?? ''),
        };
      }

      request.auth = {
        actor,
        breakGlass,
        credentialSource: bearerToken ? 'bearer' : 'cookie',
        impersonation,
        session: tokenRecord.session,
        sessionId,
        token,
        tokenPayload: decoded,
        user,
      };

      if (
        !bearerToken
        && !['GET', 'HEAD', 'OPTIONS'].includes(String(request.method ?? '').toUpperCase())
      ) {
        requireCsrfForCookieAuth(request, tokenService, {
          sessionId,
          userId: user.id,
        });
      }

      runWithRequestChannel(decoded.channel === 'assistant' ? 'assistant' : 'app', next);
    } catch (error) {
      if (error instanceof HttpError) {
        next(error);
        return;
      }

      if (!isExpectedTokenError(error)) {
        logBackendError({
          context: buildRequestLogContext(request),
          error,
          message: 'Authentication middleware failed.',
        });
      }

      next(new HttpError(401, 'Authentication required.'));
    }
  };
}
