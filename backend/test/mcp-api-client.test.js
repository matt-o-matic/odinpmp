import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createOdinApiClient, OdinApiError } from '../src/mcp/api-client.js';

const marker = 'fixture-session-secret-do-not-return';
const options = { baseUrl: 'https://odin.invalid', token: marker };

async function localHttp(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function errorMatches({ code, status, outcomeUnknown = false }) {
  return (error) => {
    assert.ok(error instanceof OdinApiError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.outcomeUnknown, outcomeUnknown);
    assert.equal(JSON.stringify(error).includes(marker), false);
    assert.equal(error.message.includes(marker), false);
    return true;
  };
}

test('client accepts HTTPS and loopback origins and rejects unsafe configuration without fetching', () => {
  for (const baseUrl of ['https://odin.invalid', 'http://localhost:12345', 'http://127.0.0.1:12345', 'http://[::1]:12345']) {
    assert.doesNotThrow(() => createOdinApiClient({ ...options, baseUrl }));
  }
  for (const baseUrl of ['invalid', 'http://odin.invalid', 'https://user:password@odin.invalid', 'https://odin.invalid/api', 'https://odin.invalid?token=secret', 'https://odin.invalid#fragment', 'file:///tmp/test']) {
    assert.throws(() => createOdinApiClient({ ...options, baseUrl }));
  }
  for (const token of ['', undefined, 'white space', '\nsecret']) {
    assert.throws(() => createOdinApiClient({ ...options, token }));
  }
  for (const timeoutMs of [0, -1, 1.5, 120001]) assert.throws(() => createOdinApiClient({ ...options, timeoutMs }));
  for (const maxResponseBytes of [0, -1, 1.5, NaN]) assert.throws(() => createOdinApiClient({ ...options, maxResponseBytes }));
});

test('local HTTP requests send the session bearer token and serialize JSON and board filter parameters', async (t) => {
  const received = [];
  const baseUrl = await localHttp(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, item: { id: 'fixture-task' } }));
  });
  const api = createOdinApiClient({ baseUrl, token: marker });
  assert.deepEqual(await api.request('PATCH', '/api/projects/fixture/items/fixture-task', { body: { expectedVersion: 3, patch: { priority: 7 } } }), { ok: true, item: { id: 'fixture-task' } });
  await api.request('GET', '/api/projects/fixture/kanban', { query: { issueTypes: ['story', 'task'], hideDone: true, search: 'a & b', unset: undefined } });
  assert.equal(received[0].headers.authorization, `Bearer ${marker}`);
  assert.equal(received[0].headers.accept, 'application/json');
  assert.equal(received[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(received[0].body), { expectedVersion: 3, patch: { priority: 7 } });
  const query = new URL(received[1].url, baseUrl).searchParams;
  assert.equal(query.get('issueTypes'), 'story,task');
  assert.equal(query.get('hideDone'), 'true');
  assert.equal(query.get('search'), 'a & b');
  assert.equal(query.has('unset'), false);
});

test('HTTP status errors redact upstream body and details while classifying auth, conflicts, and server failures', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 503]) {
    const api = createOdinApiClient({ ...options, fetchImpl: async () => new Response(JSON.stringify({ ok: false, message: marker, stack: marker, details: [{ path: marker, message: marker }] }), { status }) });
    await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code: `http_${status}`, status }));
    await assert.rejects(() => api.request('POST', '/api/projects', { body: { name: 'Fixture' } }), errorMatches({ code: `http_${status}`, status, outcomeUnknown: status >= 500 }));
  }
});

test('Odin ok:false envelopes are failures even when HTTP status is successful', async () => {
  const api = createOdinApiClient({ ...options, fetchImpl: async () => new Response(JSON.stringify({ ok: false, message: marker })) });
  await assert.rejects(() => api.request('POST', '/api/projects', { body: {} }), errorMatches({ code: 'http_400', status: 400 }));
});

test('manual redirect handling never sends credentials to the redirected server', async (t) => {
  let destinationCalls = 0;
  const destination = await localHttp(t, (request, response) => { destinationCalls += 1; response.end('{}'); });
  let originCalls = 0;
  const baseUrl = await localHttp(t, (request, response) => {
    originCalls += 1;
    response.writeHead(302, { location: `${destination}/api/projects?secret=${marker}` });
    response.end(marker);
  });
  const api = createOdinApiClient({ baseUrl, token: marker });
  await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code: 'redirect_rejected', status: 302 }));
  await assert.rejects(() => api.request('POST', '/api/projects', { body: { name: 'Fixture' } }), errorMatches({ code: 'redirect_rejected', status: 302, outcomeUnknown: true }));
  assert.equal(originCalls, 2);
  assert.equal(destinationCalls, 0);
});

test('network and timeout failures expose no exception text and classify write outcome as unknown', async () => {
  for (const [name, code] of [['Error', 'network_error'], ['AbortError', 'timeout'], ['TimeoutError', 'timeout']]) {
    const api = createOdinApiClient({ ...options, fetchImpl: async () => { const error = new Error(marker); error.name = name; throw error; } });
    await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code, status: null }));
    await assert.rejects(() => api.request('DELETE', '/api/projects/fixture/items/fixture-task', { body: { expectedVersion: 1 } }), errorMatches({ code, status: null, outcomeUnknown: true }));
  }
});

test('request timeout bounds an HTTP response that never sends headers', async (t) => {
  const baseUrl = await localHttp(t, () => {});
  const api = createOdinApiClient({ baseUrl, token: marker, timeoutMs: 100 });
  await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code: 'timeout', status: null }));
});

test('request timeout remains active while consuming a stalled HTTP response body', async (t) => {
  const baseUrl = await localHttp(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"ok":');
  });
  const api = createOdinApiClient({ baseUrl, token: marker, timeoutMs: 100 });
  await assert.rejects(() => api.request('POST', '/api/projects', { body: { name: 'Fixture' } }), errorMatches({ code: 'timeout', status: null, outcomeUnknown: true }));
});

test('successful invalid JSON replies are redacted and write outcomes remain unknown', async () => {
  const api = createOdinApiClient({ ...options, fetchImpl: async () => new Response(`<html>${marker}</html>`) });
  await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code: 'invalid_response', status: 200 }));
  await assert.rejects(() => api.request('POST', '/api/projects', { body: {} }), errorMatches({ code: 'invalid_response', status: 200, outcomeUnknown: true }));
});

test('invalid JSON in failed HTTP replies keeps the safe HTTP error classification', async () => {
  const api = createOdinApiClient({ ...options, fetchImpl: async () => new Response(`<html>${marker}</html>`, { status: 403 }) });
  await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code: 'http_403', status: 403 }));
});

test('successful JSON replies must contain an object envelope', async () => {
  for (const body of ['null', '[]', 'true', '42', '"text"']) {
    const api = createOdinApiClient({ ...options, fetchImpl: async () => new Response(body) });
    await assert.rejects(() => api.request('POST', '/api/projects', { body: {} }), errorMatches({ code: 'invalid_response', status: 200, outcomeUnknown: true }));
  }
});

test('response byte limits apply before JSON parsing and retain uncertain write outcomes', async () => {
  const api = createOdinApiClient({ ...options, maxResponseBytes: 16, fetchImpl: async () => new Response(JSON.stringify({ ok: true, content: marker })) });
  await assert.rejects(() => api.request('GET', '/api/projects'), errorMatches({ code: 'response_too_large', status: 413 }));
  await assert.rejects(() => api.request('POST', '/api/projects', { body: {} }), errorMatches({ code: 'response_too_large', status: 413, outcomeUnknown: true }));
});

test('oversized requests fail before transport or any uncertain write outcome', async () => {
  let calls = 0;
  const api = createOdinApiClient({ ...options, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  await assert.rejects(() => api.request('POST', '/api/projects', { body: { description: 'x'.repeat(1024 * 1024) } }), errorMatches({ code: 'request_too_large', status: 413 }));
  assert.equal(calls, 0);
});

test('API helper rejects arbitrary, query-bearing, and fragment-bearing routes before transport', async () => {
  let calls = 0;
  const api = createOdinApiClient({ ...options, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  for (const path of ['https://other.invalid/api/projects', '//other.invalid/api/projects', '/other', '/api/projects?secret=1', '/api/projects#fragment', '/api/../projects', '/api/projects/./fixture', '/api/\\other']) {
    await assert.rejects(() => api.request('GET', path), /Invalid Odin API route/);
  }
  assert.equal(calls, 0);
});
