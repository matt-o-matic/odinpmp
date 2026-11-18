import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';

test('Express app applies security headers and least-privilege CORS', async () => {
  const app = createApp({
    assistantStaleRunSweepIntervalMs: 0,
    corsAllowedOrigins: ['https://app.example.com'],
  });

  const allowed = await request(app).get('/health').set('Origin', 'https://app.example.com');
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.example.com');
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
  assert.equal(allowed.headers['x-frame-options'], 'DENY');
  assert.match(allowed.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(allowed.headers['x-powered-by'], undefined);

  const denied = await request(app).get('/health').set('Origin', 'https://attacker.example');
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('Express app rejects JSON bodies over the configured limit', async () => {
  const app = createApp({
    assistantStaleRunSweepIntervalMs: 0,
    jsonBodyLimitBytes: 1024,
  });

  const response = await request(app)
    .post('/api/public/waitlist')
    .set('Content-Type', 'application/json')
    .send({ email: 'person@example.com', padding: 'x'.repeat(2048) });

  assert.equal(response.status, 413);

  const importResponse = await request(app)
    .post('/api/projects/import')
    .set('Content-Type', 'application/json')
    .send({ base64OdinProject: 'x'.repeat(2048) });
  assert.equal(importResponse.status, 401);
});
