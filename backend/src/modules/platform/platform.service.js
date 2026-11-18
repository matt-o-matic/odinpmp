import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { DEFAULT_PLATFORM_EVENT_REGISTRY } from './platform-event-registry.js';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const tenantIdFor = (user) => user?.memberships?.[0]?.tenantId ?? '';
function requireAdmin(user) { const tenantId = tenantIdFor(user); if (!tenantId || (user.memberships?.[0]?.role !== 'admin' && !user?.capabilities?.includes('integrations.manage'))) throw new HttpError(404, 'Platform record not found.'); return tenantId; }
function secureEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function clientSecret() { return `odin_oauth_secret_${randomBytes(40).toString('base64url')}`; }
function accessToken() { return `odin_oauth_${randomBytes(48).toString('base64url')}`; }
function authorizationCode() { return `odin_code_${randomBytes(40).toString('base64url')}`; }
function clientId() { return `odin_client_${randomBytes(18).toString('base64url')}`; }
function webhookSecret(masterSecret, subscription) { const digest = createHmac('sha256', masterSecret).update(`${subscription.tenantId}:${subscription.id}:${subscription.signingKeyVersion}`).digest('base64url'); return `odin_whsec_${digest}`; }
function publicSnapshot(snapshot) { return { ...snapshot, tokens: snapshot.tokens.map(({ tokenHash: _tokenHash, ...token }) => token) }; }

async function assertProjects({ input, projectRepository, tenantId, user }) {
  if (!input.projectIds) return;
  // Engagements can be on an allowlist too: invoice-gen links SOWs to them (invoice-gen plan, step 2).
  const visible = new Set((await projectRepository.listProjectsForTenant({ includeEngagements: true, tenantId, user })).map((project) => project.id));
  const invalid = input.projectIds.filter((id) => !visible.has(id));
  if (invalid.length) throw new HttpError(400, `Unknown tenant project ids: ${invalid.join(', ')}.`);
}

export async function getPlatformWorkspaceForUser({ input, repository, user }) {
  const tenantId = requireAdmin(user);
  const complete = publicSnapshot(await repository.listSnapshot({ tenantId }));
  const snapshot = Object.fromEntries(Object.entries(complete).map(([name, records]) => [name, records.slice(input.offset, input.offset + input.limit)]));
  const health = snapshot.subscriptions.map((subscription) => {
    const deliveries = snapshot.deliveries.filter((delivery) => delivery.subscriptionId === subscription.id);
    const dead = deliveries.filter((delivery) => delivery.status === 'dead').length;
    const pending = deliveries.filter((delivery) => ['pending', 'processing'].includes(delivery.status)).length;
    return { dead, lastDeliveredAt: subscription.lastDeliveredAt, lastFailureAt: subscription.lastFailureAt, pending, status: !subscription.enabled ? 'disabled' : dead ? 'degraded' : 'healthy', subscriptionId: subscription.id };
  });
  const total = complete.applications.length + complete.subscriptions.length + complete.deliveries.length;
  return { ...snapshot, health, limit: input.limit, offset: input.offset, total };
}

export async function createOAuthApplicationForUser({ input, projectRepository, repository, user }) {
  const tenantId = requireAdmin(user); await assertProjects({ input, projectRepository, tenantId, user });
  const secret = clientSecret();
  const value = await repository.createOAuthApplication({ clientId: clientId(), clientSecretHash: hash(secret), createdBy: user.id, input, tenantId });
  return { clientSecret: secret, ok: true, value };
}

export async function updateOAuthApplicationForUser({ applicationId, input, projectRepository, repository, user }) {
  const tenantId = requireAdmin(user); await assertProjects({ input, projectRepository, tenantId, user });
  const value = await repository.updateOAuthApplication({ applicationId, input, tenantId });
  if (!value) throw new HttpError(404, 'Platform record not found.');
  if (input.enabled === false) await repository.revokeOAuthTokens({ applicationId, tenantId });
  return { ok: true, value };
}

export async function rotateOAuthCredentialForUser({ applicationId, input, repository, user }) {
  const tenantId = requireAdmin(user); const secret = clientSecret();
  const value = await repository.rotateOAuthCredential({ applicationId, clientSecretHash: hash(secret), expectedVersion: input.expectedVersion, tenantId });
  if (!value) throw new HttpError(404, 'Platform record not found.');
  await repository.revokeOAuthTokens({ applicationId, tenantId });
  return { clientSecret: secret, ok: true, value };
}

export async function exchangeOAuthClientCredentials({ input, repository }) {
  const application = await repository.authenticateOAuthClient({ clientId: input.client_id, clientSecretHash: hash(input.client_secret) });
  if (!application) throw new HttpError(401, 'Invalid OAuth client credentials.');
  const requested = input.scope.split(/\s+/).filter(Boolean);
  const scopes = requested.length ? requested : application.scopes;
  if (scopes.some((scope) => !application.scopes.includes(scope))) throw new HttpError(400, 'Requested OAuth scope is not granted to this application.');
  const token = accessToken(); const expiresIn = 3600;
  await repository.createOAuthAccessToken({ applicationId: application.id, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), scopes, tenantId: application.tenantId, tokenHash: hash(token) });
  return { access_token: token, expires_in: expiresIn, scope: scopes.join(' '), token_type: 'Bearer' };
}

export async function authorizeOAuthApplicationForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user); if (!tenantId) throw new HttpError(401, 'Authentication required.');
  const application = await repository.getOAuthApplicationByClientId({ clientId: input.clientId });
  if (!application || application.tenantId !== tenantId || !application.redirectUris.includes(input.redirectUri)) throw new HttpError(400, 'Invalid OAuth authorization request.');
  const scopes = input.scope.split(/\s+/).filter(Boolean);
  if (!scopes.length || scopes.some((scope) => !application.scopes.includes(scope))) throw new HttpError(400, 'Requested OAuth scope is not granted to this application.');
  const visibleProjects = new Set((await projectRepository.listProjectsForTenant({ tenantId, user })).map((project) => project.id));
  if (application.projectIds.length > 0 && !application.projectIds.some((projectId) => visibleProjects.has(projectId))) throw new HttpError(403, 'No authorized application projects are visible to this user.');
  const code = authorizationCode();
  await repository.createOAuthAuthorizationCode({ applicationId: application.id, codeChallenge: input.codeChallenge, codeHash: hash(code), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), redirectUri: input.redirectUri, scopes, tenantId, userId: user.id });
  const redirect = new URL(input.redirectUri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', input.state);
  return { expiresIn: 300, ok: true, redirectTo: redirect.toString() };
}

export async function exchangeOAuthAuthorizationCode({ input, repository }) {
  const application = await repository.authenticateOAuthClient({ clientId: input.client_id, clientSecretHash: hash(input.client_secret) });
  if (!application) throw new HttpError(401, 'Invalid OAuth client credentials.');
  const codeChallenge = createHash('sha256').update(input.code_verifier).digest('base64url');
  const authorization = await repository.consumeOAuthAuthorizationCode({ clientId: input.client_id, codeChallenge, codeHash: hash(input.code), redirectUri: input.redirect_uri });
  if (!authorization || authorization.applicationId !== application.id) throw new HttpError(400, 'Invalid or expired OAuth authorization code.');
  const token = accessToken(); const expiresIn = 3600;
  await repository.createOAuthAccessToken({ applicationId: application.id, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), grantType: 'authorization_code', scopes: authorization.scopes, tenantId: application.tenantId, tokenHash: hash(token), userId: authorization.userId });
  return { access_token: token, expires_in: expiresIn, scope: authorization.scopes.join(' '), token_type: 'Bearer' };
}

export async function createWebhookSubscriptionForUser({ input, masterSecret, repository, user }) {
  const tenantId = requireAdmin(user); const value = await repository.createWebhookSubscription({ createdBy: user.id, input, tenantId });
  return { ok: true, signingSecret: webhookSecret(masterSecret, value), value };
}

export async function updateWebhookSubscriptionForUser({ input, repository, subscriptionId, user }) {
  const tenantId = requireAdmin(user); const value = await repository.updateWebhookSubscription({ input, subscriptionId, tenantId });
  if (!value) throw new HttpError(404, 'Platform record not found.');
  return { ok: true, value };
}

export async function rotateWebhookSecretForUser({ input, masterSecret, repository, subscriptionId, user }) {
  const tenantId = requireAdmin(user); const value = await repository.rotateWebhookSecret({ expectedVersion: input.expectedVersion, subscriptionId, tenantId });
  if (!value) throw new HttpError(404, 'Platform record not found.');
  return { ok: true, signingSecret: webhookSecret(masterSecret, value), value };
}

export async function replayWebhookDeliveryForUser({ deliveryId, input, repository, user }) {
  const tenantId = requireAdmin(user); const value = await repository.replayWebhookDelivery({ deliveryId, expectedVersion: input.expectedVersion, tenantId });
  if (!value) throw new HttpError(404, 'Platform record not found.');
  return { ok: true, value };
}

export async function materializeWebhookEvent({ event, eventRegistry = DEFAULT_PLATFORM_EVENT_REGISTRY, repository }) { return repository.materializeWebhookDeliveries({ event: eventRegistry.normalize(event) }); }

export async function dispatchWebhookDeliveries({ eventRegistry = DEFAULT_PLATFORM_EVENT_REGISTRY, masterSecret, maxAttempts = 8, now = new Date(), postWebhook, repository }) {
  const claimed = await repository.claimWebhookDeliveries({ now }); const results = [];
  for (const { delivery, subscription } of claimed) {
    const eventContract = eventRegistry.get(delivery.eventType); if (!eventContract) throw new Error(`No platform event contract is registered for ${delivery.eventType}.`);
    const body = JSON.stringify({ data: delivery.payload, dataschema: eventContract.schemaUri, id: delivery.eventId, source: 'urn:odin:pmp', specversion: '1.0', subject: delivery.payload?.projectId ? `project/${delivery.payload.projectId}` : undefined, time: delivery.createdAt, type: delivery.eventType });
    const timestamp = Math.floor(now.getTime() / 1000); const deliveryId = delivery.id;
    const signature = createHmac('sha256', webhookSecret(masterSecret, subscription)).update(`${timestamp}.${body}`).digest('hex');
    try {
      const response = await postWebhook({ body, headers: { 'content-type': 'application/cloudevents+json', 'user-agent': 'OdinPMP-Webhooks/1.0', 'x-odin-delivery': deliveryId, 'x-odin-signature': `t=${timestamp},v1=${signature}` }, url: subscription.url });
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Webhook endpoint returned HTTP ${response.status}.`), { responseCode: response.status });
      await repository.completeWebhookDelivery({ deliveryId, leaseToken: delivery.leaseToken, now, responseCode: response.status });
      results.push({ deliveryId, status: 'delivered' });
    } catch (error) {
      const retryDelayMs = Math.min(60 * 60_000, 1000 * (2 ** Math.max(0, delivery.attempts - 1)));
      await repository.failWebhookDelivery({ availableAt: new Date(now.getTime() + retryDelayMs), deliveryId, error: error?.message ?? error, leaseToken: delivery.leaseToken, maxAttempts, now, responseCode: error?.responseCode ?? null });
      results.push({ deliveryId, status: delivery.attempts >= maxAttempts ? 'dead' : 'retry' });
    }
  }
  return results;
}

export function authenticateOAuthAccessTokenValue({ repository, token }) {
  if (!token.startsWith('odin_oauth_') || token.length < 50) return null;
  return repository.authenticateOAuthAccessToken({ tokenHash: hash(token) });
}

export function verifyWebhookSignature({ body, header, masterSecret, subscription }) {
  const match = String(header ?? '').match(/^t=(\d+),v1=([a-f0-9]{64})$/); if (!match) return false;
  const expected = createHmac('sha256', webhookSecret(masterSecret, subscription)).update(`${match[1]}.${body}`).digest('hex');
  return secureEqual(match[2], expected);
}
