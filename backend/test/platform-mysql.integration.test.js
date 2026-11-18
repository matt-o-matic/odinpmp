import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { createMysqlPlatformRepository, ensureMysqlPlatformDelegationSchema, ensureMysqlPlatformIdempotencySchema, purgeMysqlExpiredOAuthTokens } from '../src/modules/platform/platform.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('MySQL platform repository persists OAuth credentials and leased webhook delivery lifecycle', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl); const repository = createMysqlPlatformRepository({ pool }); const tenantId = '11111111-1111-4111-8111-111111111111';
  try {
    await applyMysqlMigrations(pool, ['0019_platform_integrations', '0037_platform_oauth_delegation']);
    const application = await repository.createOAuthApplication({ clientId: 'odin_client_mysql_test', clientSecretHash: hash('secret-value-that-is-long-enough'), createdBy: 'admin', input: { name: 'MySQL client', projectIds: ['project-1'], scopes: ['projects.read'] }, tenantId });
    assert.equal(application.clientSecretHash, undefined);
    assert.equal((await repository.authenticateOAuthClient({ clientId: application.clientId, clientSecretHash: hash('secret-value-that-is-long-enough') })).id, application.id);
    const token = await repository.createOAuthAccessToken({ applicationId: application.id, expiresAt: '2030-01-01T00:00:00.000Z', scopes: ['projects.read'], tenantId, tokenHash: hash('odin_oauth_mysql_token') });
    assert.equal((await repository.authenticateOAuthAccessToken({ tokenHash: hash('odin_oauth_mysql_token') })).token.id, token.id);
    await repository.rotateOAuthCredential({ applicationId: application.id, clientSecretHash: hash('rotated-secret-value-that-is-long-enough'), expectedVersion: 1, tenantId });
    assert.equal(await repository.authenticateOAuthAccessToken({ tokenHash: hash('odin_oauth_mysql_token') }), null);

    await ensureMysqlPlatformIdempotencySchema(pool);
    const reserved = await repository.beginApiIdempotency({ applicationId: application.id, idempotencyKey: 'mysql-risk-create-001', requestHash: hash('request-one'), route: '/v1/projects/project-1/governance-items', tenantId });
    assert.equal(reserved.created, true);
    assert.equal(await repository.completeApiIdempotency({ applicationId: application.id, idempotencyKey: 'mysql-risk-create-001', responseBody: { data: { id: 'risk-1' } }, responseStatus: 201 }), true);
    const replay = await repository.beginApiIdempotency({ applicationId: application.id, idempotencyKey: 'mysql-risk-create-001', requestHash: hash('request-one'), route: '/v1/projects/project-1/governance-items', tenantId });
    assert.equal(replay.created, false); assert.equal(replay.record.responseStatus, 201); assert.equal(replay.record.responseBody.data.id, 'risk-1');
    await assert.rejects(repository.beginApiIdempotency({ applicationId: application.id, idempotencyKey: 'mysql-risk-create-001', requestHash: hash('different-request'), route: '/v1/projects/project-1/governance-items', tenantId }), (error) => error.statusCode === 409);
    await ensureMysqlPlatformDelegationSchema(pool);
    await repository.createOAuthAuthorizationCode({ applicationId: application.id, codeChallenge: 'challenge-value', codeHash: hash('authorization-code'), expiresAt: '2030-01-01T00:00:00.000Z', redirectUri: 'https://client.example.com/callback', scopes: ['projects.read'], tenantId, userId: 'admin' });
    const delegated = await repository.consumeOAuthAuthorizationCode({ clientId: application.clientId, codeChallenge: 'challenge-value', codeHash: hash('authorization-code'), redirectUri: 'https://client.example.com/callback' });
    assert.equal(delegated.userId, 'admin'); assert.equal(await repository.consumeOAuthAuthorizationCode({ clientId: application.clientId, codeChallenge: 'challenge-value', codeHash: hash('authorization-code'), redirectUri: 'https://client.example.com/callback' }), null);

    const subscription = await repository.createWebhookSubscription({ createdBy: 'admin', input: { description: '', eventTypes: ['governance.changed'], name: 'Receiver', url: 'https://hooks.example.com/odin' }, tenantId });
    const event = { eventType: 'governance.changed', id: '22222222-2222-4222-8222-222222222222', payload: { action: 'created', entityType: 'governance_item' }, tenantId };
    assert.equal((await repository.materializeWebhookDeliveries({ event })).length, 1);
    assert.equal((await repository.materializeWebhookDeliveries({ event })).length, 0);
    const [claimed] = await repository.claimWebhookDeliveries({ now: new Date('2030-01-01T12:00:00.000Z') });
    assert.equal(claimed.subscription.id, subscription.id); assert.equal(claimed.delivery.attempts, 1);
    await repository.failWebhookDelivery({ availableAt: new Date('2030-01-01T12:01:00.000Z'), deliveryId: claimed.delivery.id, error: 'HTTP 503', leaseToken: claimed.delivery.leaseToken, maxAttempts: 1, now: new Date('2030-01-01T12:00:00.000Z'), responseCode: 503 });
    let snapshot = await repository.listSnapshot({ tenantId }); assert.equal(snapshot.deliveries[0].status, 'dead');
    const replayed = await repository.replayWebhookDelivery({ deliveryId: snapshot.deliveries[0].id, expectedVersion: snapshot.deliveries[0].version, tenantId }); assert.equal(replayed.status, 'pending');
    const [retried] = await repository.claimWebhookDeliveries({ now: new Date('2030-01-01T12:02:00.000Z') });
    await repository.completeWebhookDelivery({ deliveryId: retried.delivery.id, leaseToken: retried.delivery.leaseToken, now: new Date('2030-01-01T12:02:00.000Z'), responseCode: 204 });
    snapshot = await repository.listSnapshot({ tenantId }); assert.equal(snapshot.deliveries[0].status, 'delivered'); assert.equal(snapshot.subscriptions[0].lastDeliveredAt, '2030-01-01T12:02:00.000Z');
  } finally { await pool.end(); }
});

test('MySQL cleanup deletes OAuth tokens and codes a week after they expire, in batches', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl); const repository = createMysqlPlatformRepository({ pool }); const tenantId = randomUUID();
  try {
    await applyMysqlMigrations(pool, ['0019_platform_integrations', '0037_platform_oauth_delegation']);
    const application = await repository.createOAuthApplication({ clientId: 'odin_client_purge_' + tenantId, clientSecretHash: hash('purge-secret-' + tenantId), createdBy: 'admin', input: { name: 'Purge client', projectIds: ['project-1'], scopes: ['projects.read'] }, tenantId });
    const day = 86400000, at = (offset) => new Date(Date.now() + offset).toISOString();
    for (const [label, offset] of [['old-1', -8 * day], ['old-2', -9 * day], ['old-3', -30 * day], ['recent', -6 * day], ['live', day]]) {
      await repository.createOAuthAccessToken({ applicationId: application.id, expiresAt: at(offset), grantType: 'bug_reporter_access', scopes: ['projects.read'], tenantId, tokenHash: hash(tenantId + label), userId: 'person' });
      await repository.createOAuthAuthorizationCode({ applicationId: application.id, codeChallenge: 'challenge', codeHash: hash(tenantId + 'code' + label), expiresAt: at(offset), redirectUri: 'https://client.example.com/callback', scopes: ['projects.read'], tenantId, userId: 'person' });
    }
    assert.ok(await purgeMysqlExpiredOAuthTokens(pool, { batch: 2 }) >= 6);
    const [tokens] = await pool.execute('SELECT token_hash FROM platform_oauth_tokens WHERE tenant_id = ? ORDER BY expires_at', [tenantId]);
    assert.deepEqual(tokens.map((row) => row.token_hash), [hash(tenantId + 'recent'), hash(tenantId + 'live')]);
    const [codes] = await pool.execute('SELECT code_hash FROM platform_oauth_authorization_codes WHERE tenant_id = ? ORDER BY expires_at', [tenantId]);
    assert.deepEqual(codes.map((row) => row.code_hash), [hash(tenantId + 'coderecent'), hash(tenantId + 'codelive')]);
  } finally { await pool.end(); }
});
