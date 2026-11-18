import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { redactCredentialUrl } from '../src/lib/logging/backend-logger.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { createRequirementsTestApp } from './helpers/requirements-test-app.js';

// Public routes whose only credential is a token in the URL: the token never reaches the
// logs, and the per-IP limit uses an address the caller cannot choose.

function captureLogs(t) {
  const lines = [];
  for (const method of ['error', 'log', 'warn']) {
    t.mock.method(console, method, (...args) => { lines.push(args.map(String).join(' ')); });
  }
  return lines;
}

test('portal and upload tokens are redacted from request logs on 400, 404, 409, and 500', async (t) => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const topic = await harness.createTopic({ prompt: 'Which reminder channels?' });
  const uploadToken = 'u'.repeat(43);
  const logs = captureLogs(t);

  const cases = [
    ['404 missing topic', await harness.portal(token).get('/topics/nonexistent'), 404],
    ['400 invalid comment', await harness.portal(token).post(`/topics/${topic.id}/comments`, {}), 400],
    ['409 link still active', await harness.portal(token).post('/link-request', {}), 409],
    ['404 with the token in the query too', await harness.portal(token).get(`/topics/nonexistent?ref=${token}`), 404],
    ['404 unknown upload URL', await request(harness.app).put(`/api/public/requirements-uploads/${uploadToken}`).set('Content-Type', 'application/zip').send(Buffer.from('zip')), 404],
  ];
  const listInvolvement = harness.requirementsRepository.listStakeholderInvolvement;
  harness.requirementsRepository.listStakeholderInvolvement = async () => { throw new Error('database unavailable'); };
  cases.push(['500 repository failure', await harness.portal(token).get(), 500]);
  harness.requirementsRepository.listStakeholderInvolvement = listInvolvement;

  for (const [label, response, status] of cases) assert.equal(response.status, status, label);
  const output = logs.join('\n');
  assert.ok(logs.length >= cases.length, `each failure was logged: ${logs.length}`);
  for (const secret of [token, uploadToken]) assert.equal(output.includes(secret), false, 'no token appears in the logs');
  assert.match(output, /\/api\/public\/requirements\/\[redacted\]\/topics\/nonexistent\?ref=\[redacted\]/);
  assert.match(output, /\/api\/public\/requirements-uploads\/\[redacted\]/);
  assert.equal((await harness.portal(token).get()).status, 200, 'the link itself still works');
});

test('other spellings of a token, and requests that fail before routing, are redacted too', async (t) => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const topic = await harness.createTopic({ prompt: 'Which reminder channels?' });
  // The same credential with its first character percent-encoded: the router decodes it.
  const encoded = `%${token.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}${token.slice(1)}`;
  assert.equal((await request(harness.app).get(`/api/public/requirements/${encoded}`)).status, 200, 'the encoded spelling opens the portal');
  const logs = captureLogs(t);

  const cases = [
    ['encoded token', await request(harness.app).get(`/api/public/requirements/${encoded}/topics/missing`), 404],
    ['different case in the mount path', await request(harness.app).get(`/API/Public/Requirements/${token}/topics/missing`), 404],
    ['malformed JSON, rejected before any router runs', await request(harness.app).post(`/api/public/requirements/${token}/topics/${topic.id}/comments`).set('Content-Type', 'application/json').send('{'), 400],
    ['encoded token in the query', await harness.portal(token).get(`/topics/missing?ref=${encoded}`), 404],
  ];
  for (const [label, response, status] of cases) assert.equal(response.status, status, label);
  assert.equal(cases[2][1].body.error, 'Invalid request body.');
  const output = logs.join('\n');
  assert.ok(logs.length >= cases.length, `each failure was logged: ${logs.length}`);
  for (const spelling of [token, encoded, token.slice(1)]) assert.equal(output.includes(spelling), false, `no spelling of the token is logged: ${spelling.slice(0, 4)}`);
});

test('redactCredentialUrl redacts the segment after a credential mount by position, and only there', () => {
  const cases = [
    ['/api/public/requirements/abc/topics/t1?x=1', '/api/public/requirements/[redacted]/topics/t1?x=1'],
    ['/api/public/requirements//abc', '/api/public/requirements//[redacted]'],
    ['//api/public/requirement%73/a%62c/rounds?ref=abc&ref2=a%62c&q=other', '//api/public/requirement%73/[redacted]/rounds?ref=[redacted]&ref2=[redacted]&q=other'],
    ['/api/public/requirements-uploads/tok', '/api/public/requirements-uploads/[redacted]'],
    ['/api/public/clarifications/tok/files/f1/content', '/api/public/clarifications/[redacted]/files/f1/content'],
    ['/api/public/requirements', '/api/public/requirements'],
    ['/api/projects/p1/requirements/topics/t1', '/api/projects/p1/requirements/topics/t1'],
    ['/api/public/ticket-intake/tok', '/api/public/ticket-intake/[redacted]'],
    ['/api/public/ticket-mail/inbound', '/api/public/ticket-mail/inbound'],
    ['/api/public/requirements/%E0%A4%A', '/api/public/requirements/[redacted]'],
  ];
  for (const [url, expected] of cases) assert.equal(redactCredentialUrl(url).route, expected, url);
  assert.deepEqual([...redactCredentialUrl('/api/public/requirements/a%62c').secrets], ['abc']);
});

test('the per-IP limit uses the address the trusted proxy saw, so a caller cannot pick its own', async () => {
  const limiter = () => createRequirementsPublicRateLimiter({ ip: { capacity: 2, refillPerSecond: 0.001 }, link: { capacity: 100, refillPerSecond: 1 } });
  const statuses = async (app, headers) => {
    const result = [];
    for (const [index, value] of headers.entries()) {
      result.push((await request(app).get(`/api/public/requirements/unknown-${index}`).set('X-Forwarded-For', value)).status);
    }
    return result;
  };

  // Behind Apache on the same host (loopback, trusted by default) the header ends with the
  // address Apache saw. Whatever the caller put before it does not choose the bucket.
  const proxied = await createRequirementsTestApp({ rateLimiter: limiter() });
  assert.deepEqual(await statuses(proxied.app, ['198.51.100.1, 203.0.113.9', '198.51.100.2, 203.0.113.9', '198.51.100.3, 203.0.113.9']), [404, 404, 429]);
  assert.deepEqual(await statuses(proxied.app, ['203.0.113.10']), [404], 'another client has its own bucket');

  // TRUST_PROXY=false ignores the header: all of these come from the socket's address.
  const direct = await createRequirementsTestApp({ rateLimiter: limiter(), trustProxy: false });
  assert.deepEqual(await statuses(direct.app, ['198.51.100.1', '198.51.100.2', '198.51.100.3']), [404, 404, 429]);
});
