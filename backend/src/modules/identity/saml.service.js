import { createHash, randomBytes } from 'node:crypto';

import { SAML } from '@node-saml/node-saml';

import { HttpError } from '../../lib/errors/http-error.js';
import { resolveTenantSecretReference } from '../../lib/secrets/tenant-secret-reference.js';
import { createEnterpriseSession } from '../auth/auth.service.js';

const BUILTIN_ROLES = new Set(['admin', 'manager', 'user']);
const TRANSACTION_TTL_MS = 10 * 60_000;

function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function redirectPath(value) { const path = String(value ?? '').trim(); return path.startsWith('/') && !path.startsWith('//') ? path : '/'; }
function emailDomain(email) { return String(email ?? '').trim().toLowerCase().split('@')[1] ?? ''; }
function firstString(value) { return Array.isArray(value) ? String(value[0] ?? '').trim() : String(value ?? '').trim(); }
function defaultSecretResolver(reference, { tenantId } = {}) { const secret = resolveTenantSecretReference(reference, { tenantId }); if (String(reference ?? '').trim() && !secret) throw new HttpError(503, 'SAML secret material is unavailable.'); return secret; }
function mappedRole(snapshot, policy, groups = []) { const groupSet = new Set(groups.map(String)); const groupRoles = snapshot.groups.filter((group) => group.externalId && groupSet.has(group.externalId)).flatMap((group) => group.roleKeys); return groupRoles.find((role) => BUILTIN_ROLES.has(role)) ?? (BUILTIN_ROLES.has(policy.defaultRoleKey) ? policy.defaultRoleKey : 'user'); }

export function createEnterpriseSamlService({
  authRepository,
  callbackBaseUrl,
  identityRepository,
  samlFactory = (options) => new SAML(options),
  secretResolver = defaultSecretResolver,
  sessionsRepository,
  tenantsRepository,
  tokenService,
}) {
  const callbackUrl = new URL('/api/auth/sso/saml/callback', callbackBaseUrl).toString();
  const metadataUrl = (tenantId) => new URL(`/api/auth/sso/saml/metadata/${encodeURIComponent(tenantId)}`, callbackBaseUrl).toString();

  async function policyForTenant(tenantId) {
    const [policy, snapshot] = await Promise.all([
      identityRepository.getPolicy({ tenantId }),
      identityRepository.listSnapshot({ tenantId }),
    ]);
    if (!policy || policy.ssoMode !== 'saml' || !snapshot.domains.some((domain) => domain.status === 'verified')) {
      throw new HttpError(404, 'Enterprise SSO is not configured.');
    }
    const provider = policy.provider ?? {};
    if (!provider.entryPoint || !provider.issuer || !provider.idpCertificate) {
      throw new HttpError(503, 'SAML entry point, issuer, and signing certificate are required.');
    }
    return { policy, provider, snapshot };
  }

  function cacheProvider({ stateHash = '' } = {}) {
    return {
      async saveAsync(key, value) {
        if (!stateHash) throw new Error('SAML request state is unavailable.');
        const attached = await identityRepository.attachSamlRequest({ cacheValue: String(value), requestId: key, stateHash });
        if (!attached) throw new Error('SAML request state could not be persisted.');
        return { createdAt: Date.now(), value: String(value) };
      },
      getAsync: (key) => identityRepository.getSamlRequest({ requestId: key }),
      removeAsync: (key) => identityRepository.consumeSamlRequest({ requestId: key }),
    };
  }

  async function samlForTenant(tenantId, { stateHash = '' } = {}) {
    const { policy, provider, snapshot } = await policyForTenant(tenantId);
    const [privateKey, publicCert, decryptionPvk] = await Promise.all([
      secretResolver(provider.spSigningKeyReference, { tenantId }),
      secretResolver(provider.spSigningCertReference, { tenantId }),
      secretResolver(provider.decryptionKeyReference, { tenantId }),
    ]);
    if (privateKey && !publicCert) throw new HttpError(503, 'SAML request signing requires a public certificate reference.');
    const issuer = provider.audience || metadataUrl(tenantId);
    const saml = samlFactory({
      acceptedClockSkewMs: 120_000,
      audience: issuer,
      cacheProvider: cacheProvider({ stateHash }),
      callbackUrl,
      decryptionPvk: decryptionPvk || undefined,
      digestAlgorithm: 'sha256',
      disableRequestedAuthnContext: false,
      entryPoint: provider.entryPoint,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      idpCert: provider.idpCertificate,
      idpIssuer: provider.issuer,
      issuer,
      maxAssertionAgeMs: 5 * 60_000,
      privateKey: privateKey || undefined,
      publicCert: publicCert || undefined,
      requestIdExpirationPeriodMs: TRANSACTION_TTL_MS,
      signatureAlgorithm: 'sha256',
      validateInResponseTo: 'always',
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
    });
    return { decryptionCert: publicCert || null, policy, provider, publicCert: publicCert || null, saml, snapshot };
  }

  return {
    async begin({ redirect = '/', tenantId }) {
      const relayState = randomBytes(32).toString('base64url');
      const stateHash = hash(relayState);
      await identityRepository.createSamlTransaction({
        expiresAt: new Date(Date.now() + TRANSACTION_TTL_MS).toISOString(),
        redirectPath: redirectPath(redirect),
        stateHash,
        tenantId,
      });
      const { saml } = await samlForTenant(tenantId, { stateHash });
      return saml.getAuthorizeUrlAsync(relayState, undefined, {});
    },

    async callback({ body, ipAddr = '', locationName = '', userAgent = '' }) {
      const relayState = String(body?.RelayState ?? '').trim();
      const samlResponse = String(body?.SAMLResponse ?? '').trim();
      if (!relayState || !samlResponse) throw new HttpError(400, 'SAML response and RelayState are required.');
      const transaction = await identityRepository.consumeSamlState({ stateHash: hash(relayState) });
      if (!transaction?.requestId) throw new HttpError(400, 'SAML RelayState is invalid or expired.');
      const { policy, provider, saml, snapshot } = await samlForTenant(transaction.tenantId);
      const validated = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
      const profile = validated?.profile;
      if (!profile || validated.loggedOut) throw new HttpError(401, 'SAML response did not contain an authenticated profile.');
      if (String(profile.issuer ?? '').trim() !== String(provider.issuer).trim()) throw new HttpError(401, 'SAML issuer did not match the configured identity provider.');
      const email = firstString(profile[provider.emailAttribute || 'email'] ?? profile.email ?? profile.mail ?? profile['urn:oid:0.9.2342.19200300.100.1.3'] ?? profile.nameID).toLowerCase();
      if (!email || !email.includes('@')) throw new HttpError(401, 'SAML identity provider did not return an email address.');
      if (!snapshot.domains.some((domain) => domain.status === 'verified' && domain.domain === emailDomain(email))) throw new HttpError(403, 'SAML email domain is not verified for this tenant.');
      const rawGroups = profile[provider.groupsAttribute || 'groups'];
      const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : String(rawGroups ?? '').split(/[;,]/).map((item) => item.trim()).filter(Boolean);
      let user = await authRepository.findUserByEmail(email);
      const membership = user?.memberships?.find((item) => item.tenantId === transaction.tenantId);
      if (!membership && !policy.jitEnabled) throw new HttpError(403, 'Just-in-time provisioning is disabled for this tenant.');
      if (!membership || policy.jitEnabled) {
        const provisioned = await tenantsRepository.provisionUser({
          email,
          name: firstString(profile.displayName ?? profile.name ?? email),
          role: mappedRole(snapshot, policy, groups),
          tenantId: transaction.tenantId,
        });
        user = await authRepository.findUserById(provisioned.id);
      }
      const session = await createEnterpriseSession({ activeTenantId: transaction.tenantId, ipAddr, locationName, repository: authRepository, sessionsRepository, tokenService, userAgent, userId: user.id });
      return { redirect: transaction.redirectPath, session, tenantId: transaction.tenantId, userId: user.id };
    },

    async metadata({ tenantId }) {
      const { decryptionCert, publicCert, saml } = await samlForTenant(tenantId);
      return saml.generateServiceProviderMetadata(decryptionCert, publicCert);
    },
  };
}
