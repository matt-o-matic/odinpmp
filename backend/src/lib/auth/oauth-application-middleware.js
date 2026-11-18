import { HttpError } from '../errors/http-error.js';
import { authenticateOAuthAccessTokenValue } from '../../modules/platform/platform.service.js';
import { apiChannel, runWithRequestChannel } from '../http/request-channel.js';

function bearer(request) { const value = String(request.headers.authorization ?? ''); return value.startsWith('Bearer ') ? value.slice(7).trim() : ''; }

export function createOAuthApplicationMiddleware({ authRepository = null, platformRepository, requiredScopes = [] }) {
  return async function oauthApplicationMiddleware(request, _response, next) {
    try {
      const authenticated = await authenticateOAuthAccessTokenValue({ repository: platformRepository, token: bearer(request) });
      if (!authenticated) throw new HttpError(401, 'OAuth application authentication required.');
      const scopes = new Set(authenticated.token.scopes ?? []);
      if (requiredScopes.some((scope) => !scopes.has(scope))) throw new HttpError(403, 'The OAuth application lacks the required scope.');
      request.oauthAuth = { ...authenticated, scopes };
      const delegatedUser = authenticated.token.userId ? await authRepository?.findUserById?.(authenticated.token.userId) : null;
      if (authenticated.token.userId && !delegatedUser?.memberships?.some((membership) => membership.tenantId === authenticated.application.tenantId)) throw new HttpError(401, 'OAuth user delegation is no longer valid.');
      request.auth = {
        credentialSource: delegatedUser ? 'oauth_user_delegation' : 'oauth_application',
        oauthApplication: authenticated.application,
        user: delegatedUser ?? {
          email: '', id: `oauth-application:${authenticated.application.id}`,
          memberships: [{ role: 'admin', tenantId: authenticated.application.tenantId }],
          name: authenticated.application.name, scopes: authenticated.token.scopes,
        },
      };
      await platformRepository.markOAuthAccessUsed({ applicationId: authenticated.application.id, tokenId: authenticated.token.id });
      runWithRequestChannel(apiChannel(authenticated.application.name), next);
    } catch (error) { next(error instanceof HttpError ? error : new HttpError(401, 'OAuth application authentication required.')); }
  };
}
