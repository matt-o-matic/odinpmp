import { createHash } from 'node:crypto';

import * as defaultOidcClient from 'openid-client';

import { HttpError } from '../../lib/errors/http-error.js';
import { resolveTenantSecretReference } from '../../lib/secrets/tenant-secret-reference.js';
import { createEnterpriseSession } from '../auth/auth.service.js';

const BUILTIN_ROLES = new Set(['admin', 'manager', 'user']);
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function redirectPath(value) { const path = String(value ?? '').trim(); return path.startsWith('/') && !path.startsWith('//') ? path : '/'; }
function emailDomain(email) { return String(email ?? '').trim().toLowerCase().split('@')[1] ?? ''; }
function defaultSecretResolver(reference, { tenantId } = {}) { const secret = resolveTenantSecretReference(reference, { tenantId }); if (String(reference ?? '').trim() && !secret) throw new HttpError(503, 'OIDC client secret is unavailable.'); return secret; }
function mappedRole(snapshot, policy, claims) { const claimGroups = new Set(Array.isArray(claims.groups) ? claims.groups.map(String) : typeof claims.groups === 'string' ? claims.groups.split(/[ ,]+/).filter(Boolean) : []); const groupRoles = snapshot.groups.filter((group) => group.externalId && claimGroups.has(group.externalId)).flatMap((group) => group.roleKeys); return groupRoles.find((role) => BUILTIN_ROLES.has(role)) ?? (BUILTIN_ROLES.has(policy.defaultRoleKey) ? policy.defaultRoleKey : 'user'); }

export function createEnterpriseOidcService({
  authRepository,
  callbackBaseUrl,
  identityRepository,
  oidcClient = defaultOidcClient,
  secretResolver = defaultSecretResolver,
  sessionsRepository,
  tenantsRepository,
  tokenService,
}) {
  const cache = new Map();
  const callbackUrl = new URL('/api/auth/sso/oidc/callback', callbackBaseUrl).toString();
  async function policyForTenant(tenantId) { const [policy, snapshot] = await Promise.all([identityRepository.getPolicy({ tenantId }), identityRepository.listSnapshot({ tenantId })]); if (!policy || policy.ssoMode !== 'oidc' || !snapshot.domains.some((domain) => domain.status === 'verified')) throw new HttpError(404, 'Enterprise SSO is not configured.'); return { policy, snapshot }; }
  async function configuration(tenantId, policy) { const key = `${tenantId}:${policy.version}`; if (!cache.has(key)) { if (!policy.provider.issuer || !policy.provider.clientId) throw new HttpError(503, 'OIDC issuer and client id are required.'); const secret = await secretResolver(policy.provider.secretReference, { tenantId }); const pending = oidcClient.discovery(new URL(policy.provider.issuer), policy.provider.clientId, secret || undefined).catch((error) => { cache.delete(key); throw error; }); cache.set(key, pending); } return cache.get(key); }
  return {
    async discover({ email }) { const domain = await identityRepository.findVerifiedDomain({ domain: emailDomain(email) }); if (!domain) return { configured: false, mode: 'none' }; const policy = await identityRepository.getPolicy({ tenantId: domain.tenantId }); return ['oidc', 'saml'].includes(policy?.ssoMode) ? { configured: true, enforced: policy.loginEnforcement === 'required', mode: policy.ssoMode, tenantId: domain.tenantId } : { configured: false, mode: 'none' }; },
    async assertPasswordLoginAllowed({ email }) { const domain = await identityRepository.findVerifiedDomain({ domain: emailDomain(email) }); if (!domain) return; const policy = await identityRepository.getPolicy({ tenantId: domain.tenantId }); if (policy?.loginEnforcement === 'required' && policy.ssoMode !== 'none') throw new HttpError(403, 'This tenant requires enterprise SSO.'); },
    async begin({ redirect = '/', tenantId }) { const { policy } = await policyForTenant(tenantId); const config = await configuration(tenantId, policy); const codeVerifier = oidcClient.randomPKCECodeVerifier(); const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier); const nonce = oidcClient.randomNonce(); const state = oidcClient.randomState(); await identityRepository.createOidcTransaction({ codeVerifier, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), nonce, redirectPath: redirectPath(redirect), stateHash: hash(state), tenantId }); return oidcClient.buildAuthorizationUrl(config, { code_challenge: codeChallenge, code_challenge_method: 'S256', nonce, redirect_uri: callbackUrl, response_type: 'code', scope: 'openid email profile', state }).toString(); },
    async callback({ callbackRequestUrl, ipAddr = '', locationName = '', userAgent = '' }) { const state = String(new URL(callbackRequestUrl).searchParams.get('state') ?? ''); if (!state) throw new HttpError(400, 'OIDC callback state is missing.'); const transaction = await identityRepository.consumeOidcTransaction({ stateHash: hash(state) }); if (!transaction) throw new HttpError(400, 'OIDC callback state is invalid or expired.'); const { policy, snapshot } = await policyForTenant(transaction.tenantId); const config = await configuration(transaction.tenantId, policy); const tokens = await oidcClient.authorizationCodeGrant(config, new URL(callbackRequestUrl), { expectedNonce: transaction.nonce, expectedState: state, idTokenExpected: true, pkceCodeVerifier: transaction.codeVerifier }); const claims = tokens.claims?.(); const email = String(claims?.email ?? '').trim().toLowerCase(); if (!email || claims?.email_verified === false) throw new HttpError(401, 'OIDC provider did not return a verified email address.'); if (!snapshot.domains.some((domain) => domain.status === 'verified' && domain.domain === emailDomain(email))) throw new HttpError(403, 'OIDC email domain is not verified for this tenant.'); let user = await authRepository.findUserByEmail(email); const membership = user?.memberships?.find((item) => item.tenantId === transaction.tenantId); if (!membership && !policy.jitEnabled) throw new HttpError(403, 'Just-in-time provisioning is disabled for this tenant.'); if (!membership || policy.jitEnabled) { const provisioned = await tenantsRepository.provisionUser({ email, name: String(claims?.name ?? email).trim(), role: mappedRole(snapshot, policy, claims ?? {}), tenantId: transaction.tenantId }); user = await authRepository.findUserById(provisioned.id); } const session = await createEnterpriseSession({ activeTenantId: transaction.tenantId, ipAddr, locationName, repository: authRepository, sessionsRepository, tokenService, userAgent, userId: user.id }); return { redirect: transaction.redirectPath, session, tenantId: transaction.tenantId, userId: user.id }; },
  };
}
