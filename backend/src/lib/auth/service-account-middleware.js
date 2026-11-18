import { createHash } from 'node:crypto';

import { HttpError } from '../errors/http-error.js';

function bearer(request) { const value = String(request.headers.authorization ?? ''); return value.startsWith('Bearer ') ? value.slice(7).trim() : ''; }

export function createServiceAccountMiddleware({ identityRepository, requiredScopes = [] }) {
  return async function serviceAccountMiddleware(request, _response, next) {
    try {
      const secret = bearer(request);
      if (!secret.startsWith('odin_sa_') || secret.length < 40) throw new HttpError(401, 'Service account authentication required.');
      const authenticated = await identityRepository.authenticateCredential({ secretHash: createHash('sha256').update(secret).digest('hex') });
      if (!authenticated) throw new HttpError(401, 'Service account authentication required.');
      const scopes = new Set(authenticated.account.scopes ?? []);
      request.serviceAuth = { account: authenticated.account, credentialId: authenticated.credential.id, scopes };
      request.auth = {
        credentialSource: 'service_account',
        serviceAccount: authenticated.account,
        user: {
          email: '',
          id: `service-account:${authenticated.account.id}`,
          memberships: [{ role: 'service_account', tenantId: authenticated.account.tenantId }],
          name: authenticated.account.name,
          scopes: authenticated.account.scopes,
        },
      };
      if (requiredScopes.some((scope) => !scopes.has(scope))) throw new HttpError(403, 'The service account lacks the required scope.');
      await identityRepository.markCredentialUsed({ credentialId: authenticated.credential.id, tenantId: authenticated.account.tenantId });
      next();
    } catch (error) { next(error instanceof HttpError ? error : new HttpError(401, 'Service account authentication required.')); }
  };
}
