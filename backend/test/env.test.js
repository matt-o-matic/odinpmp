import assert from 'node:assert/strict';
import test from 'node:test';

import { loadEnv } from '../src/config/env.js';

test('loadEnv leaves the OpenAI model unset when OPENAI_MODEL is missing', () => {
  const env = loadEnv({ NODE_ENV: 'test' });

  assert.equal(env.openAiModel, '');
  assert.equal(env.port, 3001);
  assert.equal(env.backendPublicUrl, 'http://localhost:3001');
  assert.equal(env.frontendAppUrl, 'http://localhost:5173/app');
  assert.deepEqual(env.corsAllowedOrigins, ['http://localhost:5173']);
  assert.equal(env.jsonBodyLimitBytes, 1024 * 1024);
  assert.equal(env.mailReplyDomain, '');
  assert.equal(env.inboundMailWebhookSecret, '');
  assert.equal(env.assistantTurnTimeoutMs, 0);
  assert.equal(env.webhookSigningMasterSecret, 'odin-local-webhook-signing-master-secret');
  assert.equal(env.sloP95LatencyMs, 1000);
  assert.equal(env.sloErrorRatePercent, 1);
  assert.equal(env.objectStorageProvider, 'local');
});

test('loadEnv reads exact additional CORS origins and JSON body limits', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    CORS_ALLOWED_ORIGINS: 'https://admin.example.com, https://reports.example.com',
    FRONTEND_APP_URL: 'https://app.example.com/app',
    JSON_BODY_LIMIT_BYTES: '2048',
  });

  assert.deepEqual(env.corsAllowedOrigins, [
    'https://app.example.com',
    'https://admin.example.com',
    'https://reports.example.com',
  ]);
  assert.equal(env.jsonBodyLimitBytes, 2048);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', CORS_ALLOWED_ORIGINS: 'https://example.com/path' }), /exact http\(s\) origin/);
});

test('loadEnv validates the public backend origin used for OIDC callbacks', () => {
  assert.equal(loadEnv({ NODE_ENV: 'test', BACKEND_PUBLIC_URL: 'http://localhost:4100' }).backendPublicUrl, 'http://localhost:4100');
  assert.throws(() => loadEnv({ NODE_ENV: 'test', BACKEND_PUBLIC_URL: 'http://localhost:4100/api' }), /BACKEND_PUBLIC_URL.*exact/i);
  assert.throws(() => loadEnv({
    CONNECTOR_CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(32),
    BACKEND_PUBLIC_URL: 'http://api.example.com',
    CLAMAV_ENABLED: 'true',
    CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
    FRONTEND_APP_URL: 'https://app.example.com/app',
    JWT_SECRET: 'a'.repeat(32),
    NODE_ENV: 'production',
    OBJECT_STORAGE_BUCKET: 'odin-production',
    OBJECT_STORAGE_PROVIDER: 's3',
    OBJECT_STORAGE_REGION: 'us-east-1',
    WEBHOOK_SIGNING_MASTER_SECRET: 'b'.repeat(32),
  }), /BACKEND_PUBLIC_URL.*HTTPS/i);
});

test('loadEnv rejects unsafe production JWT, frontend, and scanner configuration', () => {
  assert.throws(() => loadEnv({ NODE_ENV: 'production' }), /JWT_SECRET.*non-default.*CLAMAV_ENABLED/s);
  assert.throws(() => loadEnv({
    CONNECTOR_CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(32),
    CLAMAV_ENABLED: 'true',
    CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
    FRONTEND_APP_URL: 'http://example.com/app',
    JWT_SECRET: 'a'.repeat(32),
    NODE_ENV: 'production',
    WEBHOOK_SIGNING_MASTER_SECRET: 'b'.repeat(32),
  }), /FRONTEND_APP_URL.*HTTPS/s);
  assert.throws(() => loadEnv({
    CLAMAV_ENABLED: 'true',
    CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
    FRONTEND_APP_URL: 'https://example.com/app',
    JWT_SECRET: 'a'.repeat(32),
    NODE_ENV: 'production',
    WEBHOOK_SIGNING_MASTER_SECRET: 'b'.repeat(32),
  }), /OBJECT_STORAGE_PROVIDER.*must be s3.*OBJECT_STORAGE_BUCKET.*required/s);

  const env = loadEnv({
    CONNECTOR_CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(32),
    CLAMAV_ENABLED: 'true',
    CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
    FRONTEND_APP_URL: 'https://example.com/app',
    JWT_SECRET: 'a'.repeat(32),
    NODE_ENV: 'production',
    OBJECT_STORAGE_BUCKET: 'odin-production',
    OBJECT_STORAGE_PROVIDER: 's3',
    OBJECT_STORAGE_REGION: 'us-east-1',
    WEBHOOK_SIGNING_MASTER_SECRET: 'b'.repeat(32),
  });
  assert.equal(env.clamavEnabled, true);
  assert.equal(env.objectStorageProvider, 's3');
  assert.equal(env.connectorCredentialEncryptionKey, 'c'.repeat(32));
  assert.equal(loadEnv({ NODE_ENV: 'test', CLAMAV_ENABLED: 'false' }).clamavEnabled, false);
});

test('loadEnv gives the assistant a pooled tool budget, max reasoning, and Decisions checks, all configurable', () => {
  assert.deepEqual(loadEnv({ NODE_ENV: 'test' }).assistantAgent, {
    compactAtTokens: 120000,
    decisionsEnabled: true,
    decisionsModel: 'gpt-6-luna',
    decisionsTimeoutMs: 4000,
    maxOutputTokens: 32000,
    maxToolCalls: 420,
    reasoningComplex: 'max',
    reasoningSimple: 'max',
    toolCallsPerTask: 40,
    writeCheckThreshold: 0.3,
    writeCheckThresholdOnChange: 0.1,
  });
  const tuned = loadEnv({
    NODE_ENV: 'test',
    ASSISTANT_DECISIONS_ENABLED: 'false',
    ASSISTANT_MAX_TOOL_CALLS: '600',
    ASSISTANT_REASONING_COMPLEX: 'xhigh',
    ASSISTANT_REASONING_SIMPLE: 'medium',
    ASSISTANT_TOOL_CALLS_PER_TASK: '25',
    ASSISTANT_WRITE_CHECK_THRESHOLD: '0.5',
    ASSISTANT_COMPACT_AT_TOKENS: '200000',
  }).assistantAgent;
  assert.equal(tuned.compactAtTokens, 200000);
  assert.equal(tuned.decisionsEnabled, false);
  assert.equal(tuned.maxToolCalls, 600);
  assert.equal(tuned.reasoningComplex, 'xhigh');
  assert.equal(tuned.reasoningSimple, 'medium');
  assert.equal(tuned.toolCallsPerTask, 25);
  assert.equal(tuned.writeCheckThreshold, 0.5);
  assert.throws(() => loadEnv({ NODE_ENV: 'test', ASSISTANT_REASONING_COMPLEX: 'extreme' }));
});

test('loadEnv reads the assistant turn timeout, with 0 or blank meaning none', () => {
  assert.equal(loadEnv({ NODE_ENV: 'test' }).assistantTurnTimeoutMs, 0);
  assert.equal(loadEnv({ NODE_ENV: 'test', ASSISTANT_TURN_TIMEOUT_MS: '' }).assistantTurnTimeoutMs, 0);
  assert.equal(loadEnv({ NODE_ENV: 'test', ASSISTANT_TURN_TIMEOUT_MS: '0' }).assistantTurnTimeoutMs, 0);
  assert.equal(loadEnv({ NODE_ENV: 'test', ASSISTANT_TURN_TIMEOUT_MS: '45000' }).assistantTurnTimeoutMs, 45_000);
  // Settings of the removed project summary queue are still accepted and ignored.
  assert.equal(loadEnv({ NODE_ENV: 'test', OPENAI_SUMMARY_MODEL: 'gpt-6-luna', SUMMARY_QUEUE_BATCH_SIZE: '8' }).openAiSummaryModel, undefined);
});

test('the built-in JWT secret works only where NODE_ENV says development or test', () => {
  // The source is public, so an install that forgets both settings must not run on it.
  assert.throws(() => loadEnv({}), /JWT_SECRET: set it to at least 32 random characters, or set NODE_ENV=development/);
  assert.throws(() => loadEnv({ JWT_SECRET: 'short-secret' }), /JWT_SECRET/);
  assert.equal(loadEnv({ NODE_ENV: 'development' }).jwtSecret, 'odinpmp-dev-secret');
  assert.equal(loadEnv({ NODE_ENV: 'test' }).jwtSecret, 'odinpmp-dev-secret');
  assert.equal(loadEnv({ JWT_SECRET: 'x'.repeat(32) }).jwtSecret, 'x'.repeat(32));
});

test('the demo login is seeded only when asked for, and never in production', () => {
  assert.equal(loadEnv({ NODE_ENV: 'development' }).seedDemoUser, false);
  assert.equal(loadEnv({ NODE_ENV: 'development', SEED_DEMO_USER: 'true' }).seedDemoUser, true);
  assert.equal(loadEnv({ JWT_SECRET: 'x'.repeat(32), SEED_DEMO_USER: '1' }).seedDemoUser, true);
});
