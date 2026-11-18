import assert from 'node:assert/strict';

import request from 'supertest';

// Starts a password sign-up and returns the token from the confirmation email it queued.
export async function startPasswordSignup(app, mailRepository, payload) {
  const started = await request(app).post('/api/auth/register').send(payload);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const mail = mailRepository.state.queue.findLast((row) => row.templateId === 'signup-verification-v1' && row.recipientEmail === payload.email.toLowerCase());
  const token = mail?.body.match(/verify-email#([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, 'the confirmation email carries a verification link');
  return token;
}
