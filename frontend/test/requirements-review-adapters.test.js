import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiClient, isRequirementsSnapshotPath, requirementsReviewPath } from '../src/lib/api/client.js';
import { createPortalFeed, createReviewAdapter, createTeamReviewFeed, reviewScope } from '../src/lib/requirements/review-adapters.js';
import { REVIEW_EVENT_TYPES, batchTouchesInbox, batchTouchesQuestion, batchTouchesRound, createReviewLiveFeed, mergeReviewEvent } from '../src/lib/requirements/review-live.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    clear(id) { pending.delete(id); },
    flush() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pending,
    set(callback) { const id = nextId++; pending.set(id, callback); return id; },
  };
}

async function capture(run) {
  const previousFetch = globalThis.fetch;
  const previousXhr = globalThis.XMLHttpRequest;
  const calls = [];
  globalThis.XMLHttpRequest = undefined;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    calls.push({
      auth: options.headers?.Authorization ?? '',
      body: typeof body === 'string' ? JSON.parse(body) : body instanceof Blob ? `blob:${body.type}` : undefined,
      contentType: options.headers?.['Content-Type'] ?? '',
      method: options.method ?? 'GET',
      url: String(url).replace('http://localhost:3001', ''),
    });
    return {
      blob: async () => new Blob(['png'], { type: 'image/png' }),
      headers: { get: () => 'image/png' },
      json: async () => ({ ok: true }),
      ok: true,
      status: 200,
    };
  };
  try {
    await run(createApiClient({ baseUrl: 'http://localhost:3001' }));
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.XMLHttpRequest = previousXhr;
  }
  return calls;
}

async function exercise(adapter) {
  await adapter.load();
  await adapter.savePosition({ step: 'screens', screenId: 'home' });
  await adapter.saveDirection('action-first', { remix: '', stance: 'preferred' });
  await adapter.clearDirection('action-first');
  await adapter.saveVerdict('home', { dimensions: {}, overall: 'keep' });
  await adapter.clearVerdict('home');
  await adapter.saveAnswer('price', 'home');
  await adapter.clearAnswer('price');
  await adapter.saveAnnotation('a1', { screenId: 'home', shapes: [] });
  await adapter.deleteAnnotation('a1');
  await adapter.setAnnotationStatus('a1', 'resolved');
  await adapter.carryAnnotation('a1');
  await adapter.closeAnnotation('a1');
  await adapter.addComment('a1', { body: 'Hi' });
  await adapter.editComment('a1', 'c1', { body: 'Edit' });
  await adapter.deleteComment('a1', 'c1');
  await adapter.uploadSnapshot(new Blob(['png'], { type: 'image/png' }), { screenId: 'flow', stateKey: 'pick-time' });
  await adapter.submit();
}

test('the team adapter uses the round review API with the session token', async () => {
  const calls = await capture((client) => exercise(createReviewAdapter({ apiClient: client, getToken: () => 'session', scope: reviewScope({ projectId: 'p1', roundId: 'r1' }) })));
  const base = '/api/projects/p1/requirements/rounds/r1/review';
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    `GET ${base}`,
    `PUT ${base}/position`,
    `PUT ${base}/directions/action-first`,
    `DELETE ${base}/directions/action-first`,
    `PUT ${base}/screens/home/verdict`,
    `DELETE ${base}/screens/home/verdict`,
    `PUT ${base}/questions/price/answer`,
    `DELETE ${base}/questions/price/answer`,
    `PUT ${base}/annotations/a1`,
    `DELETE ${base}/annotations/a1`,
    `POST ${base}/annotations/a1/status`,
    `POST ${base}/annotations/a1/carry`,
    `POST ${base}/annotations/a1/close`,
    `POST ${base}/annotations/a1/comments`,
    `PATCH ${base}/annotations/a1/comments/c1`,
    `DELETE ${base}/annotations/a1/comments/c1`,
    `POST ${base}/snapshots?screenId=flow&stateKey=pick-time`,
    `POST ${base}/submit`,
  ]);
  assert.ok(calls.every((call) => call.auth === 'Bearer session'));
  assert.deepEqual(calls[6].body, { value: 'home' });
  assert.deepEqual(calls[10].body, { status: 'resolved' });
  assert.deepEqual(calls[13].body, { body: 'Hi', parentCommentId: '' });
  assert.equal(calls[16].contentType, 'image/png');
  assert.equal(calls[16].body, 'blob:image/png');
});

test('the portal adapter uses the link\'s round paths and never sends a session token', async () => {
  const calls = await capture((client) => exercise(createReviewAdapter({ apiClient: client, getToken: () => 'session', scope: reviewScope({ portalToken: 'tok/en', roundId: 'r1' }) })));
  const base = '/api/public/requirements/tok%2Fen/rounds/r1';
  assert.equal(calls[0].url, base);
  assert.equal(calls[4].url, `${base}/screens/home/verdict`);
  assert.equal(calls[16].url, `${base}/snapshots?screenId=flow&stateKey=pick-time`);
  assert.equal(calls.at(-1).url, `${base}/submit`);
  assert.ok(calls.every((call) => call.auth === ''));
});

test('snapshot images load only from review API snapshot paths', async () => {
  assert.equal(isRequirementsSnapshotPath('/api/public/requirements/tok/rounds/r1/snapshots/s1'), true);
  assert.equal(isRequirementsSnapshotPath('/api/projects/p1/requirements/rounds/r1/snapshots/s1'), true);
  assert.equal(isRequirementsSnapshotPath('/api/projects/p1/files/f1/content'), false);
  assert.equal(isRequirementsSnapshotPath('https://evil.example/api/public/requirements/t/rounds/r/snapshots/s'), false);
  assert.equal(requirementsReviewPath({ projectId: 'p', roundId: 'r' }, '/x'), '/api/projects/p/requirements/rounds/r/review/x');
  const calls = await capture(async (client) => {
    const adapter = createReviewAdapter({ apiClient: client, getToken: () => 'session', scope: reviewScope({ projectId: 'p1', roundId: 'r1' }) });
    const blob = await adapter.loadSnapshot('/api/projects/p1/requirements/rounds/r1/snapshots/s1');
    assert.equal(blob.type, 'image/png');
    await assert.rejects(adapter.loadSnapshot('/api/files/1/content'), /Not a snapshot address/);
  });
  assert.deepEqual(calls.map((call) => call.url), ['/api/projects/p1/requirements/rounds/r1/snapshots/s1']);
});

test('the portal link API covers the inbox, questions, link requests, and events', async () => {
  const calls = await capture(async (client) => {
    await client.getRequirementsPortal('tok');
    await client.requestRequirementsPortalLink('tok');
    await client.listRequirementsPortalRounds('tok');
    await client.getRequirementsPortalTopic('tok', 't1');
    await client.commentRequirementsPortalTopic('tok', 't1', { body: 'Hi', parentCommentId: '' });
    await client.updateRequirementsPortalComment('tok', 't1', 'c1', { body: 'Edit' });
    await client.deleteRequirementsPortalComment('tok', 't1', 'c1');
    await client.voteRequirementsPortalComment('tok', 't1', 'c1', { vote: 'up' });
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/public/requirements/tok',
    'POST /api/public/requirements/tok/link-request',
    'GET /api/public/requirements/tok/rounds',
    'GET /api/public/requirements/tok/topics/t1',
    'POST /api/public/requirements/tok/topics/t1/comments',
    'PATCH /api/public/requirements/tok/topics/t1/comments/c1',
    'DELETE /api/public/requirements/tok/topics/t1/comments/c1',
    'POST /api/public/requirements/tok/topics/t1/comments/c1/vote',
  ]);
  assert.ok(calls.every((call) => call.auth === ''));
});

test('live batches name rounds and questions so each page refetches only what changed', () => {
  let batch = mergeReviewEvent(null, { data: { annotationId: 'a1', roundId: 'r1', screenId: 'home' }, type: REVIEW_EVENT_TYPES.review });
  assert.equal(batchTouchesRound(batch, 'r1'), true);
  assert.equal(batchTouchesRound(batch, 'r2'), false);
  assert.equal(batchTouchesInbox(batch), false, 'a mark does not change the inbox');
  batch = mergeReviewEvent(batch, { data: { topicIds: ['t1'] }, type: REVIEW_EVENT_TYPES.topics });
  assert.equal(batchTouchesQuestion(batch, 't1'), true);
  assert.equal(batchTouchesQuestion(batch, 't2'), false);
  assert.equal(batchTouchesInbox(batch), true);
  const summary = mergeReviewEvent(null, { data: { scopeId: 't2', scopeType: 'topic' }, type: REVIEW_EVENT_TYPES.summary });
  assert.equal(batchTouchesQuestion(summary, 't2'), true);
  assert.equal(batchTouchesRound({ reconnected: true, roundIds: [], types: [] }, 'r9'), true);
});

test('the live feed debounces events for every listener and reconnects with a refetch flag', () => {
  const timers = fakeTimers();
  const streams = [];
  const feed = createReviewLiveFeed({
    open: (handlers) => { const stream = { handlers, stopped: false }; streams.push(stream); return () => { stream.stopped = true; }; },
    timers,
  });
  const first = [];
  const second = [];
  feed.listen((batch) => first.push(batch));
  const off = feed.listen((batch) => second.push(batch));
  const { onClose, onEvent } = streams[0].handlers;
  onEvent({ data: {}, type: 'connected' });
  assert.equal(feed.connected, true);
  onEvent({ data: { roundId: 'r1' }, type: REVIEW_EVENT_TYPES.review });
  onEvent({ data: { roundId: 'r1' }, type: 'heartbeat' });
  onEvent({ data: { roundId: 'r1' }, type: REVIEW_EVENT_TYPES.rounds });
  timers.flush();
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].types, [REVIEW_EVENT_TYPES.review, REVIEW_EVENT_TYPES.rounds]);
  assert.equal(second.length, 1);
  off();

  onClose();
  timers.flush();
  assert.equal(streams.length, 2, 'reconnected');
  streams[1].handlers.onEvent({ data: {}, type: 'connected' });
  timers.flush();
  assert.equal(first.at(-1).reconnected, true);
  assert.equal(second.length, 1);
  feed.stop();
  assert.equal(streams[1].stopped, true);
});

test('team and portal feeds open the right streams', () => {
  const opened = [];
  const client = {
    subscribeToProjectEvents(projectId, token) { opened.push(`project:${projectId}:${token}`); return () => {}; },
    subscribeToRequirementsPortalEvents(token) { opened.push(`portal:${token}`); return () => {}; },
  };
  const timers = fakeTimers();
  const team = createTeamReviewFeed({ apiClient: client, getToken: () => 'session', projectId: 'p1', timers });
  const portal = createPortalFeed({ apiClient: client, portalToken: 'tok', timers });
  assert.deepEqual(opened, ['project:p1:session', 'portal:tok']);
  team.stop();
  portal.stop();
});

test('the review feed refetches after the shared stream opens again for a tab that was hidden', () => {
  const timers = fakeTimers();
  const streams = [];
  const feed = createReviewLiveFeed({
    open: (handlers) => { const stream = { handlers, stopped: false }; streams.push(stream); return () => { stream.stopped = true; }; },
    timers,
  });
  const batches = [];
  feed.listen((batch) => batches.push(batch));
  streams[0].handlers.onEvent({ data: {}, type: 'connected' });
  timers.flush();
  assert.equal(batches.length, 0);
  streams[0].handlers.onEvent({ data: {}, resumed: true, type: 'connected' });
  timers.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].reconnected, true);
  assert.equal(streams.length, 1);
  feed.stop();
});
