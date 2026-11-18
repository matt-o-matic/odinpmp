import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import request from 'supertest';
import { authenticator } from 'otplib';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryIdentityRepository } from '../src/modules/identity/identity.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';

const activeTestServers = new Set();

async function listenForTest(app) {
  const server = http.createServer(app);
  server.locals = app.locals;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  activeTestServers.add(server);
  return server;
}

test.afterEach(async () => {
  const servers = [...activeTestServers]; activeTestServers.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(resolve); server.closeAllConnections?.();
  })));
});

async function fixture() {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const breakGlassSecret = 'JBSWY3DPEHPK3PXP';
  const users = [
    { authMethod: 'basic', email: 'admin1@example.com', id: 'admin-1', memberships: [{ role: 'admin', tenantId }], name: 'Admin One', password: 'Secret123!', preferences: { twoFactorEnabled: true }, twoFactorSecret: breakGlassSecret },
    { authMethod: 'basic', email: 'admin2@example.com', id: 'admin-2', memberships: [{ role: 'admin', tenantId }], name: 'Admin Two', password: 'Secret123!' },
    { authMethod: 'basic', email: 'member@example.com', id: 'member', memberships: [{ role: 'user', tenantId }], name: 'Member', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: tenantId, name: 'Tenant' }], users });
  const sessionsRepository = createInMemorySessionsRepository(); const tokenService = createTokenService({ issuer: 'identity-test', secret: 'identity-test-secret-is-long-enough' }); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken({ ...user, tenantId }); const payload = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(payload.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const identityRepository = createInMemoryIdentityRepository();
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [{ epics: [], id: 'project-1', name: 'Authorized project', status: 'In Progress', tenantId }, { epics: [], id: 'project-2', name: 'Peer project', status: 'At Risk', tenantId }] } });
  let oidcSequence = 0;
  const oidcClient = { async calculatePKCECodeChallenge(value) { return `challenge-${value}`; }, async discovery() { return { discovered: true }; }, buildAuthorizationUrl(_config, parameters) { const url = new URL('https://id.example.com/authorize'); for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value); return url; }, randomNonce() { return `nonce-${oidcSequence}`; }, randomPKCECodeVerifier() { oidcSequence += 1; return `verifier-${oidcSequence}`; }, randomState() { return `state-${oidcSequence}`; }, async authorizationCodeGrant(_config, callbackUrl, checks) { assert.equal(checks.pkceCodeVerifier, `verifier-${oidcSequence}`); assert.equal(checks.expectedState, `state-${oidcSequence}`); assert.equal(checks.expectedNonce, `nonce-${oidcSequence}`); const email = callbackUrl.searchParams.get('code') === 'wrong-domain' ? 'user@outside.example.net' : 'jit.user@example.com'; return { claims() { return { email, email_verified: true, groups: ['idp-managers'], name: 'JIT User', sub: 'oidc-subject' }; } }; } };
  const auditEvents = [];
  const samlOptions = [];
  const samlFactory = (options) => { samlOptions.push(options); return {
    async getAuthorizeUrlAsync(relayState) { await options.cacheProvider.saveAsync('_saml-request-1', String(Date.now())); return `https://id.example.com/saml/login?RelayState=${encodeURIComponent(relayState)}`; },
    async validatePostResponseAsync() { assert.ok(await options.cacheProvider.getAsync('_saml-request-1')); await options.cacheProvider.removeAsync('_saml-request-1'); return { loggedOut: false, profile: { displayName: 'SAML User', email: 'saml.user@example.com', groups: ['idp-managers'], issuer: 'https://id.example.com/saml' } }; },
    generateServiceProviderMetadata() { return '<EntityDescriptor entityID="odin-synthetic" />'; },
  }; };
  const app = await listenForTest(createApp({ auditWriter: { async append(event) { auditEvents.push(event); } }, authRepository, backendPublicUrl: 'http://localhost:3001', frontendAppUrl: 'http://localhost:4173/app', identityRepository, oidcClient, oidcSecretResolver: () => 'oidc-client-secret', projectRepository, samlFactory, samlSecretResolver: () => '', sessionsRepository, tenantsRepository, tokenService }));
  return { app, auditEvents, authRepository, authorization: (id) => `Bearer ${tokens.get(id)}`, breakGlassSecret, identityRepository, samlOptions, tenantId, tokenService };
}

test('enterprise identity API governs domains, SSO policy, roles, groups, reviews, service credentials, and impersonation', async () => {
  const { app, auditEvents, authRepository, authorization, breakGlassSecret, identityRepository, samlOptions, tenantId, tokenService } = await fixture(); const admin1 = authorization('admin-1'); const admin2 = authorization('admin-2'); const member = authorization('member');
  assert.equal((await request(app).get('/api/identity').set('Authorization', member)).status, 404);

  const domain = await request(app).post('/api/identity/domains').set('Authorization', admin1).send({ domain: 'example.com', verificationMethod: 'manual' });
  assert.equal(domain.status, 201); assert.match(domain.body.verification.token, /^odin-domain-/); assert.equal(domain.body.value.tokenHash, undefined);
  const blockedPolicy = await request(app).put('/api/identity/policy').set('Authorization', admin1).send({ defaultRoleKey: 'user', expectedVersion: 0, jitEnabled: true, loginEnforcement: 'required', provider: { clientId: 'client', issuer: 'https://id.example.com', secretReference: 'env:ODIN_TENANT_11111111111141118111111111111111_OIDC_CLIENT_SECRET' }, ssoMode: 'oidc' });
  assert.equal(blockedPolicy.status, 409);
  assert.equal((await request(app).post(`/api/identity/domains/${domain.body.value.id}/verify`).set('Authorization', admin1).send({ expectedVersion: 1, proof: 'wrong' })).status, 409);
  const verified = await request(app).post(`/api/identity/domains/${domain.body.value.id}/verify`).set('Authorization', admin1).send({ expectedVersion: 1, proof: domain.body.verification.token });
  assert.equal(verified.status, 200); assert.equal(verified.body.value.status, 'verified');
  const incompleteSaml = await request(app).put('/api/identity/policy').set('Authorization', admin1).send({ defaultRoleKey: 'user', expectedVersion: 0, jitEnabled: true, loginEnforcement: 'required', provider: { issuer: 'https://id.example.com/saml' }, ssoMode: 'saml' });
  assert.equal(incompleteSaml.status, 400);
  const policy = await request(app).put('/api/identity/policy').set('Authorization', admin1).send({ defaultRoleKey: 'user', expectedVersion: 0, jitEnabled: true, loginEnforcement: 'required', provider: { clientId: 'client', issuer: 'https://id.example.com', secretReference: 'env:ODIN_TENANT_11111111111141118111111111111111_OIDC_CLIENT_SECRET' }, ssoMode: 'oidc' });
  assert.equal(policy.status, 200); assert.equal(policy.body.value.version, 1);

  const role = await request(app).post('/api/identity/roles').set('Authorization', admin1).send({ capabilities: ['identity.manage', 'projects.read', 'reports.run'], description: 'Read, report, and manage identity.', key: 'analyst', name: 'Analyst' });
  assert.equal(role.status, 201);
  const group = await request(app).post('/api/identity/groups').set('Authorization', admin1).send({ description: 'Delivery analysts.', externalId: 'scim-group-1', name: 'Analysts', roleKeys: ['analyst'] });
  assert.equal(group.status, 201);
  assert.equal((await request(app).post(`/api/identity/groups/${group.body.value.id}/members`).set('Authorization', admin1).send({ userId: 'member' })).status, 201);
  const delegatedMe = await request(app).get('/api/auth/me').set('Authorization', member);
  assert.deepEqual(delegatedMe.body.user.capabilities, ['identity.manage', 'projects.read', 'reports.run']);
  assert.equal((await request(app).get('/api/identity').set('Authorization', member)).status, 200);
  const oidcManagers = await request(app).post('/api/identity/groups').set('Authorization', admin1).send({ description: 'Mapped OIDC managers.', externalId: 'idp-managers', name: 'OIDC managers', roleKeys: ['manager'] });
  assert.equal(oidcManagers.status, 201);

  assert.equal((await request(app).post('/api/auth/login').send({ email: 'member@example.com', password: 'Secret123!' })).status, 403);
  const discovery = await request(app).get('/api/auth/sso/discover?email=member%40example.com'); assert.equal(discovery.status, 200); assert.equal(discovery.body.configured, true); assert.equal(discovery.body.enforced, true);
  const oidcStart = await request(app).get(`/api/auth/sso/oidc/start?tenantId=${tenantId}&redirect=%2Fprojects`); assert.equal(oidcStart.status, 302); const authorizationUrl = new URL(oidcStart.headers.location); const state = authorizationUrl.searchParams.get('state'); assert.equal(state, 'state-1'); assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://localhost:3001/api/auth/sso/oidc/callback');
  const oidcBrowser = request.agent(app); const oidcCallback = await oidcBrowser.get(`/api/auth/sso/oidc/callback?code=valid&state=${state}`); assert.equal(oidcCallback.status, 302); assert.match(oidcCallback.headers.location, /oauth\/callback\?redirect=%2Fprojects/);
  const oidcMe = await oidcBrowser.get('/api/auth/me'); assert.equal(oidcMe.status, 200); assert.equal(oidcMe.body.user.email, 'jit.user@example.com'); assert.equal(oidcMe.body.user.role, 'manager'); assert.equal(oidcMe.body.user.tenantId, tenantId);
  const replayedCallback = await request(app).get(`/api/auth/sso/oidc/callback?code=valid&state=${state}`); assert.equal(replayedCallback.status, 302); assert.match(replayedCallback.headers.location, /login\?ssoError=/);
  const wrongDomainStart = await request(app).get(`/api/auth/sso/oidc/start?tenantId=${tenantId}`); const wrongState = new URL(wrongDomainStart.headers.location).searchParams.get('state'); const wrongDomain = await request(app).get(`/api/auth/sso/oidc/callback?code=wrong-domain&state=${wrongState}`); assert.equal(wrongDomain.status, 302); assert.match(wrongDomain.headers.location, /login\?ssoError=/); assert.equal(await authRepository.findUserByEmail('user@outside.example.net'), null);

  const samlPolicy = await request(app).put('/api/identity/policy').set('Authorization', admin1).send({ defaultRoleKey: 'user', expectedVersion: 1, jitEnabled: true, loginEnforcement: 'required', provider: { audience: 'https://odin.example.com/saml/metadata', emailAttribute: 'email', entryPoint: 'https://id.example.com/saml/login', groupsAttribute: 'groups', idpCertificate: '-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----', issuer: 'https://id.example.com/saml' }, ssoMode: 'saml' });
  assert.equal(samlPolicy.status, 200); assert.equal(samlPolicy.body.value.version, 2);
  const samlDiscovery = await request(app).get('/api/auth/sso/discover?email=member%40example.com'); assert.equal(samlDiscovery.body.mode, 'saml'); assert.equal(samlDiscovery.body.enforced, true);
  const samlMetadata = await request(app).get(`/api/auth/sso/saml/metadata/${tenantId}`); assert.equal(samlMetadata.status, 200); assert.match(samlMetadata.headers['content-type'], /samlmetadata\+xml/);
  const samlStart = await request(app).get(`/api/auth/sso/saml/start?tenantId=${tenantId}&redirect=%2Fprojects`); assert.equal(samlStart.status, 302); const samlRelayState = new URL(samlStart.headers.location).searchParams.get('RelayState'); assert.ok(samlRelayState);
  const samlBrowser = request.agent(app); const samlCallback = await samlBrowser.post('/api/auth/sso/saml/callback').type('form').send({ RelayState: samlRelayState, SAMLResponse: 'synthetic-signed-response' }); assert.equal(samlCallback.status, 302); assert.match(samlCallback.headers.location, /oauth\/callback\?redirect=%2Fprojects/);
  const samlMe = await samlBrowser.get('/api/auth/me'); assert.equal(samlMe.status, 200); assert.equal(samlMe.body.user.email, 'saml.user@example.com'); assert.equal(samlMe.body.user.role, 'manager');
  const replayedSaml = await request(app).post('/api/auth/sso/saml/callback').type('form').send({ RelayState: samlRelayState, SAMLResponse: 'synthetic-signed-response' }); assert.equal(replayedSaml.status, 302); assert.match(replayedSaml.headers.location, /login\?ssoError=/);
  const strictSaml = samlOptions.find((options) => options.entryPoint === 'https://id.example.com/saml/login' && options.validateInResponseTo === 'always'); assert.ok(strictSaml); assert.equal(strictSaml.wantAssertionsSigned, true); assert.equal(strictSaml.wantAuthnResponseSigned, true); assert.equal(strictSaml.audience, 'https://odin.example.com/saml/metadata'); assert.equal(strictSaml.maxAssertionAgeMs, 5 * 60_000); assert.equal(strictSaml.signatureAlgorithm, 'sha256');

  const account = await request(app).post('/api/identity/service-accounts').set('Authorization', admin1).send({ description: 'Read reporting feeds.', expiresAt: '2030-01-01T00:00:00.000Z', name: 'BI Reader', projectIds: ['project-1'], scopes: ['reporting.read'] });
  assert.equal(account.status, 201); assert.match(account.body.secret, /^odin_sa_/); assert.equal(account.body.credential.secretHash, undefined);
  const feed = await request(app).get('/api/v1/bi/project').set('Authorization', `Bearer ${account.body.secret}`);
  assert.equal(feed.status, 200); assert.deepEqual(feed.body.rows.map((row) => row.projectName), ['Authorized project']); assert.equal(feed.body.freshness.rowLevelSecurity, 'service-account-project-set');
  assert.equal((await request(app).get('/api/v1/bi/resource').set('Authorization', `Bearer ${account.body.secret}`)).status, 403);
  const wrongScope = await request(app).post('/api/identity/service-accounts').set('Authorization', admin1).send({ description: '', expiresAt: null, name: 'Wrong scope', projectIds: ['project-1'], scopes: ['projects.read'] });
  assert.equal(wrongScope.status, 201); assert.equal((await request(app).get('/api/v1/bi/project').set('Authorization', `Bearer ${wrongScope.body.secret}`)).status, 403);
  const rotated = await request(app).post(`/api/identity/service-accounts/${account.body.value.id}/rotate`).set('Authorization', admin1).send({ expectedVersion: 1, expiresAt: '2030-02-01T00:00:00.000Z' });
  assert.equal(rotated.status, 200); assert.notEqual(rotated.body.secret, account.body.secret);
  assert.equal((await request(app).get('/api/v1/bi/project').set('Authorization', `Bearer ${account.body.secret}`)).status, 401);
  assert.equal((await request(app).get('/api/v1/bi/project').set('Authorization', `Bearer ${rotated.body.secret}`)).status, 200);

  const review = await request(app).post('/api/identity/access-reviews').set('Authorization', admin1).send({ dueAt: '2030-03-01T00:00:00.000Z', name: 'Quarterly certification', reviewerUserId: 'admin-2', scope: 'tenant' });
  assert.equal(review.status, 201);
  const snapshot = await request(app).get('/api/identity').set('Authorization', admin2);
  assert.equal(snapshot.status, 200); assert.doesNotMatch(JSON.stringify(snapshot.body), /secretHash|tokenHash|odin_sa_[a-f0-9]+_/);
  const reviewItems = snapshot.body.accessReviewItems.filter((item) => item.reviewId === review.body.value.id);
  const reviewItem = reviewItems[0];
  const decision = await request(app).post(`/api/identity/access-review-items/${reviewItem.id}/decision`).set('Authorization', admin2).send({ decision: 'approve', expectedVersion: reviewItem.version, note: 'Still required.' });
  assert.equal(decision.status, 200); assert.equal(decision.body.value.decidedBy, 'admin-2');
  for (const item of reviewItems.slice(1)) {
    const remainingDecision = await request(app).post(`/api/identity/access-review-items/${item.id}/decision`).set('Authorization', admin2).send({ decision: 'approve', expectedVersion: item.version, note: 'Still required.' });
    assert.equal(remainingDecision.status, 200);
  }
  const completedReview = await request(app).get('/api/identity').set('Authorization', admin2);
  assert.equal(completedReview.body.accessReviews.find((item) => item.id === review.body.value.id).status, 'completed');
  assert.ok(completedReview.body.accessReviews.find((item) => item.id === review.body.value.id).completedAt);

  assert.equal((await request(app).post('/api/identity/access-review-campaigns').set('Authorization', admin1).send({ durationDays: 10, enabled: true, intervalDays: 30, name: 'Monthly privileged access', nextRunAt: '2030-03-15T00:00:00.000Z', reviewerUserId: 'member', scope: 'groups' })).status, 409);
  const campaign = await request(app).post('/api/identity/access-review-campaigns').set('Authorization', admin1).send({ durationDays: 10, enabled: true, intervalDays: 30, name: 'Monthly privileged access', nextRunAt: '2030-03-15T00:00:00.000Z', reviewerUserId: 'admin-2', scope: 'tenant' });
  assert.equal(campaign.status, 201); assert.equal(campaign.body.value.runCount, 0);
  const materialized = await Promise.all([
    app.locals.materializeDueAccessReviewCampaigns({ now: new Date('2030-03-15T00:00:00.000Z') }),
    app.locals.materializeDueAccessReviewCampaigns({ now: new Date('2030-03-15T00:00:00.000Z') }),
  ]);
  assert.equal(materialized.reduce((sum, value) => sum + value.created, 0), 1);
  const campaignSnapshot = await request(app).get('/api/identity').set('Authorization', admin2);
  const scheduledCampaign = campaignSnapshot.body.accessReviewCampaigns.find((item) => item.id === campaign.body.value.id);
  assert.equal(scheduledCampaign.runCount, 1); assert.equal(scheduledCampaign.version, 2); assert.equal(scheduledCampaign.nextRunAt, '2030-04-14T00:00:00.000Z');
  assert.equal(campaignSnapshot.body.accessReviewCampaignRuns.filter((item) => item.campaignId === campaign.body.value.id).length, 1);
  const scheduledReview = campaignSnapshot.body.accessReviews.find((item) => item.name === 'Monthly privileged access · 2030-03-15');
  assert.equal(scheduledReview.dueAt, '2030-03-25T00:00:00.000Z'); assert.equal(scheduledReview.reviewerUserId, 'admin-2');
  const disabledCampaign = await request(app).patch(`/api/identity/access-review-campaigns/${campaign.body.value.id}`).set('Authorization', admin1).send({ enabled: false, expectedVersion: 2 });
  assert.equal(disabledCampaign.status, 200); assert.equal(disabledCampaign.body.value.enabled, false);

  const scimAccount = await request(app).post('/api/identity/service-accounts').set('Authorization', admin1).send({ description: 'Enterprise lifecycle provisioning.', expiresAt: null, name: 'SCIM Provisioner', projectIds: [], scopes: ['scim.read', 'scim.write'] });
  assert.equal(scimAccount.status, 201); const scimAuth = `Bearer ${scimAccount.body.secret}`;
  const providerConfig = await request(app).get('/api/scim/v2/ServiceProviderConfig').set('Authorization', scimAuth); assert.equal(providerConfig.status, 200); assert.equal(providerConfig.type, 'application/scim+json'); assert.equal(providerConfig.body.patch.supported, true);
  const provisioned = await request(app).post('/api/scim/v2/Users').set('Authorization', scimAuth).send({ active: true, displayName: 'Provisioned User', roles: [{ value: 'user' }], schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'provisioned@example.com' });
  assert.equal(provisioned.status, 201); assert.equal(provisioned.body.userName, 'provisioned@example.com');
  const filteredUsers = await request(app).get('/api/scim/v2/Users').query({ filter: 'userName eq "provisioned@example.com"' }).set('Authorization', scimAuth); assert.equal(filteredUsers.status, 200); assert.equal(filteredUsers.body.totalResults, 1);
  const renamed = await request(app).patch(`/api/scim/v2/Users/${provisioned.body.id}`).set('Authorization', scimAuth).send({ Operations: [{ op: 'Replace', path: 'displayName', value: 'Provisioned Analyst' }], schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'] });
  assert.equal(renamed.status, 200); assert.equal(renamed.body.displayName, 'Provisioned Analyst');
  const scimGroup = await request(app).post('/api/scim/v2/Groups').set('Authorization', scimAuth).send({ displayName: 'Provisioned group', externalId: 'idp-group-1', members: [{ value: provisioned.body.id }], schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'] });
  assert.equal(scimGroup.status, 201); assert.deepEqual(scimGroup.body.members.map((item) => item.value), [provisioned.body.id]); assert.match(scimGroup.headers.etag, /^W\//);
  const removedMember = await request(app).patch(`/api/scim/v2/Groups/${scimGroup.body.id}`).set('Authorization', scimAuth).set('If-Match', scimGroup.headers.etag).send({ Operations: [{ op: 'Remove', path: `members[value eq "${provisioned.body.id}"]` }], schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'] });
  assert.equal(removedMember.status, 200); assert.deepEqual(removedMember.body.members, []);
  const staleGroupWrite = await request(app).patch(`/api/scim/v2/Groups/${scimGroup.body.id}`).set('Authorization', scimAuth).set('If-Match', scimGroup.headers.etag).send({ Operations: [{ op: 'Add', path: 'members', value: [{ value: provisioned.body.id }] }], schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'] });
  assert.equal(staleGroupWrite.status, 409); assert.deepEqual((await request(app).get(`/api/scim/v2/Groups/${scimGroup.body.id}`).set('Authorization', scimAuth)).body.members, []);
  assert.equal((await request(app).get('/api/scim/v2/Users').set('Authorization', `Bearer ${wrongScope.body.secret}`)).status, 403);
  assert.equal((await request(app).delete(`/api/scim/v2/Users/${provisioned.body.id}`).set('Authorization', scimAuth)).status, 204);
  const missingScimUser = await request(app).get(`/api/scim/v2/Users/${provisioned.body.id}`).set('Authorization', scimAuth); assert.equal(missingScimUser.status, 404); assert.deepEqual(missingScimUser.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);

  const impersonation = await request(app).post('/api/identity/impersonation-requests').set('Authorization', admin1).send({ expiresAt: '2030-04-01T00:00:00.000Z', reason: 'Investigate an authorized support incident.', targetUserId: 'member' });
  assert.equal(impersonation.status, 201);
  assert.equal((await request(app).post(`/api/identity/impersonation-requests/${impersonation.body.value.id}/decision`).set('Authorization', admin1).send({ decision: 'approved', expectedVersion: 1, note: 'Self approval must be denied.' })).status, 403);
  const approved = await request(app).post(`/api/identity/impersonation-requests/${impersonation.body.value.id}/decision`).set('Authorization', admin2).send({ decision: 'approved', expectedVersion: 1, note: 'Approved for the incident window.' });
  assert.equal(approved.status, 200); assert.equal(approved.body.value.approvedBy, 'admin-2');
  const activated = await request(app).post(`/api/identity/impersonation-requests/${impersonation.body.value.id}/activate`).set('Authorization', admin1).send({});
  assert.equal(activated.status, 200); assert.equal(activated.headers['cache-control'], 'no-store'); assert.equal(activated.body.grant.status, 'active'); assert.equal(activated.body.session.refreshToken, undefined);
  const impersonatedToken = activated.body.session.token; const impersonatedPayload = tokenService.verifySessionToken(impersonatedToken);
  assert.equal(impersonatedPayload.actorId, 'admin-1'); assert.equal(impersonatedPayload.sub, 'member'); assert.equal(impersonatedPayload.impersonationGrantId, impersonation.body.value.id); assert.equal(impersonatedPayload.type, 'impersonation-session'); assert.ok(impersonatedPayload.exp - impersonatedPayload.iat <= 15 * 60);
  const impersonatedMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${impersonatedToken}`);
  assert.equal(impersonatedMe.status, 200); assert.equal(impersonatedMe.body.user.id, 'member'); assert.equal(impersonatedMe.body.impersonation.actorId, 'admin-1'); assert.equal(impersonatedMe.body.impersonation.grantId, impersonation.body.value.id);
  assert.equal((await request(app).post(`/api/identity/impersonation-requests/${impersonation.body.value.id}/activate`).set('Authorization', `Bearer ${impersonatedToken}`).send({})).status, 409);
  const ended = await request(app).post(`/api/identity/impersonation-requests/${impersonation.body.value.id}/end`).set('Authorization', `Bearer ${impersonatedToken}`).send({ expectedVersion: activated.body.grant.version });
  assert.equal(ended.status, 200); assert.equal(ended.body.value.status, 'ended'); assert.ok(ended.body.value.endedAt);
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${impersonatedToken}`)).status, 401);

  const breakGlassPolicy = await request(app).put('/api/identity/break-glass-policy').set('Authorization', admin2).send({ enabled: true, expectedVersion: 0, maxSessionMinutes: 15, userIds: ['admin-1'] });
  assert.equal(breakGlassPolicy.status, 200); assert.equal(breakGlassPolicy.body.value.enabled, true);
  const emergencyStart = await request(app).post('/api/auth/break-glass/start').send({ email: 'admin1@example.com', password: 'Secret123!', reason: 'Identity provider outage during a customer-impacting incident.' });
  assert.equal(emergencyStart.status, 202); assert.equal(emergencyStart.headers['cache-control'], 'no-store'); assert.equal(emergencyStart.body.requiresTwoFactor, true);
  const emergencyVerify = await request(app).post('/api/auth/break-glass/verify').send({ challengeToken: emergencyStart.body.challengeToken, code: authenticator.generate(breakGlassSecret) });
  assert.equal(emergencyVerify.status, 200); assert.equal(emergencyVerify.headers['cache-control'], 'no-store'); assert.equal(emergencyVerify.body.session.refreshToken, undefined);
  const emergencyToken = emergencyVerify.body.session.token; const emergencyPayload = tokenService.verifySessionToken(emergencyToken);
  assert.equal(emergencyPayload.type, 'break-glass-session'); assert.equal(emergencyPayload.sub, 'admin-1'); assert.ok(emergencyPayload.exp - emergencyPayload.iat <= 15 * 60);
  const emergencyMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${emergencyToken}`);
  assert.equal(emergencyMe.status, 200); assert.match(emergencyMe.body.breakGlass.reason, /Identity provider outage/);
  await new Promise((resolve) => setImmediate(resolve)); assert.ok(auditEvents.some((event) => event.action === 'auth.break_glass.activated' && event.userId === 'admin-1'));
  const disabledBreakGlass = await request(app).put('/api/identity/break-glass-policy').set('Authorization', admin2).send({ enabled: false, expectedVersion: 1, maxSessionMinutes: 15, userIds: ['admin-1'] });
  assert.equal(disabledBreakGlass.status, 200); assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${emergencyToken}`)).status, 401);

  assert.equal((await request(app).delete('/api/scim/v2/Users/admin-1').set('Authorization', scimAuth)).status, 204);
  const finalAdmin = await request(app).delete('/api/scim/v2/Users/admin-2').set('Authorization', scimAuth); assert.equal(finalAdmin.status, 409); assert.match(finalAdmin.body.detail, /final tenant administrator/i);

  const stored = await identityRepository.listSnapshot({ tenantId });
  assert.equal(stored.credentials.length, 4); assert.equal(stored.credentials.filter((credential) => credential.revokedAt).length, 1); assert.ok(stored.credentials.every((credential) => /^[a-f0-9]{64}$/.test(credential.secretHash))); assert.ok(stored.domains.every((record) => /^[a-f0-9]{64}$/.test(record.tokenHash)));
});
