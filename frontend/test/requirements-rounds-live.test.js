import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiClient } from '../src/lib/api/client.js';
import {
  REQUIREMENTS_EVENT_TYPES,
  batchTouchesPackages,
  batchTouchesRound,
  batchTouchesRounds,
  batchTouchesTopic,
  batchTouchesTopicList,
  createRequirementsLiveUpdates,
  isTopicEventType,
  mergeRequirementsEvent,
} from '../src/lib/requirements/requirements-live-updates.js';
import { myItemSecondaryAction, myItemTarget } from '../src/lib/requirements/requirements-my-items.js';
import { requirementsAbilities } from '../src/lib/requirements/requirements-permissions.js';

const { review, rounds, summary, topics, decisions, packages, links } = REQUIREMENTS_EVENT_TYPES;

test('round and review events never refetch topic pages or the register', () => {
  assert.equal(rounds, 'requirements.rounds.invalidated');
  assert.equal(review, 'requirements.review.updated');
  assert.equal(isTopicEventType(review), false);
  assert.equal(isTopicEventType(rounds), false);
  assert.equal(isTopicEventType(links), false);
  assert.equal(isTopicEventType(packages), false);
  assert.equal(isTopicEventType(topics), true);
  assert.equal(isTopicEventType(decisions), true);

  // A burst of annotation saves.
  let batch = null;
  for (let index = 0; index < 5; index += 1) {
    batch = mergeRequirementsEvent(batch, { data: { annotationId: `a${index}`, reason: 'annotation-saved', roundId: 'round-2', screenId: 'home', track: 'experience' }, type: review });
  }
  assert.deepEqual(batch.types, [review]);
  assert.deepEqual(batch.roundIds, ['round-2']);
  assert.equal(batchTouchesTopic(batch, 'topic-price'), false);
  assert.equal(batchTouchesTopicList(batch, 'experience'), false);
  assert.equal(batchTouchesRound(batch, 'round-2'), true);
  assert.equal(batchTouchesRound(batch, 'round-1'), false);
  assert.equal(batchTouchesRounds(batch, 'experience'), false, 'feedback does not change the rounds list');

  const lifecycle = mergeRequirementsEvent(null, { data: { reason: 'round-published', roundId: 'round-3', track: 'experience' }, type: rounds });
  assert.equal(batchTouchesTopic(lifecycle, 'topic-price'), false);
  assert.equal(batchTouchesRounds(lifecycle, 'experience'), true);
  assert.equal(batchTouchesRounds(lifecycle, 'architecture'), false);
  assert.equal(batchTouchesRound(lifecycle, 'round-3'), true);
  assert.equal(batchTouchesPackages(lifecycle, 'experience'), false);
});

test('Odin summaries of rounds and screens refresh the round, not topic pages', () => {
  const screen = mergeRequirementsEvent(null, { data: { scopeId: 'round-2:home', scopeType: 'screen', status: 'ok', track: 'experience' }, type: summary });
  assert.deepEqual(screen.roundIds, ['round-2']);
  assert.equal(batchTouchesTopic(screen, 'topic-price'), false);
  assert.equal(batchTouchesTopicList(screen, 'experience'), false);
  assert.equal(batchTouchesRound(screen, 'round-2'), true);
  assert.equal(batchTouchesRound(screen, 'round-1'), false);

  const roundScope = mergeRequirementsEvent(null, { data: { scopeId: 'round-2', scopeType: 'round', track: 'experience' }, type: summary });
  assert.equal(batchTouchesRound(roundScope, 'round-2'), true);
  assert.equal(batchTouchesTopic(roundScope, 'topic-price'), false);

  // A topic summary in the same batch still refreshes that topic, and only that topic.
  const mixed = mergeRequirementsEvent(roundScope, { data: { scopeId: 'topic-price', scopeType: 'topic' }, type: summary });
  assert.equal(batchTouchesTopic(mixed, 'topic-price'), true);
  assert.equal(batchTouchesTopic(mixed, 'topic-other'), false);

  const topicOnly = mergeRequirementsEvent(null, { data: { scopeId: 'topic-price', scopeType: 'topic' }, type: summary });
  assert.equal(batchTouchesRound(topicOnly, 'round-2'), false);
});

test('decisions and reconnects refetch a round page; older batches without round ids still work', () => {
  const accepted = mergeRequirementsEvent(null, { data: { reason: 'preference-accepted', track: 'experience' }, type: decisions });
  assert.equal(batchTouchesRound(accepted, 'round-2'), true);
  assert.equal(batchTouchesRound({ reconnected: true, topicIds: [], tracks: [], types: [] }, 'round-2'), true);
  assert.equal(batchTouchesRound({ reconnected: false, topicIds: [], tracks: [], types: [rounds] }, 'round-2'), true);
  assert.equal(batchTouchesTopic({ reconnected: false, topicIds: [], tracks: [], types: [summary] }, 't1'), true, 'an unscoped summary may be a topic');
  assert.equal(batchTouchesRound(null, 'round-2'), false);
  assert.equal(batchTouchesRounds(null, 'experience'), false);
});

test('the live stream batches round events with the rest', () => {
  const handlers = {};
  const timers = [];
  const changes = [];
  const apiClient = {
    subscribeToProjectEvents(_projectId, _token, callbacks) {
      Object.assign(handlers, callbacks);
      return () => {};
    },
  };
  createRequirementsLiveUpdates({
    apiClient,
    getToken: () => 'token',
    onChange: (batch) => changes.push(batch),
    projectId: 'p1',
    timers: { clear: () => {}, set: (callback) => { timers.push(callback); return timers.length; } },
  });
  handlers.onEvent({ data: {}, type: 'connected' });
  handlers.onEvent({ data: { roundId: 'round-2', screenId: 'home', track: 'experience' }, type: review });
  handlers.onEvent({ data: { roundId: 'round-2', track: 'experience' }, type: rounds });
  timers.at(-1)();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].types, [review, rounds]);
  assert.deepEqual(changes[0].roundIds, ['round-2']);
});

async function capture(run) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : undefined, method: options.method, url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  try {
    await run(createApiClient({ baseUrl: 'http://localhost:3001' }));
  } finally {
    globalThis.fetch = previousFetch;
  }
  return calls.map((call) => ({ ...call, url: call.url.replace('http://localhost:3001', '') }));
}

test('rounds API methods follow the rounds routes', async () => {
  const calls = await capture(async (client) => {
    await client.listRequirementsRounds('p1', 'experience', 'token');
    await client.listRequirementsRounds('p1', '', 'token');
    await client.publishRequirementsRound('p1', { packageId: 'pkg3' }, 'token');
    await client.getRequirementsRound('p1', 'r/2', 'token');
    await client.getRequirementsRoundResults('p1', 'r2', 'token');
    await client.getRequirementsRoundFeedback('p1', 'r2', { cursor: 'abc', limit: 500 }, 'token');
    await client.getRequirementsRoundFeedback('p1', 'r2', {}, 'token');
    await client.updateRequirementsRound('p1', 'r2', { note: 'x' }, 'token');
    await client.closeRequirementsRound('p1', 'r2', { outcome: 'abandoned' }, 'token');
    await client.resendRequirementsRoundInvitation('p1', 'r2', 'rev1', 'token');
    await client.refreshRequirementsRoundSummary('p1', 'r2', { screenId: 'home' }, 'token');
    await client.refreshRequirementsRoundSummary('p1', 'r2', {}, 'token');
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/projects/p1/requirements/rounds?track=experience',
    'GET /api/projects/p1/requirements/rounds',
    'POST /api/projects/p1/requirements/rounds',
    'GET /api/projects/p1/requirements/rounds/r%2F2',
    'GET /api/projects/p1/requirements/rounds/r2/results',
    'GET /api/projects/p1/requirements/rounds/r2/feedback?limit=500&cursor=abc',
    'GET /api/projects/p1/requirements/rounds/r2/feedback',
    'PATCH /api/projects/p1/requirements/rounds/r2',
    'POST /api/projects/p1/requirements/rounds/r2/close',
    'POST /api/projects/p1/requirements/rounds/r2/reviewers/rev1/resend',
    'POST /api/projects/p1/requirements/rounds/r2/summary/refresh',
    'POST /api/projects/p1/requirements/rounds/r2/summary/refresh',
  ]);
  assert.deepEqual(calls[2].body, { packageId: 'pkg3' });
  assert.deepEqual(calls[10].body, { screenId: 'home' });
  assert.deepEqual(calls[11].body, { screenId: '' });
});

test('My open items: reviews open the guided review, drafts offer Publish', () => {
  const round = { action: 'review', id: 'round-2', kind: 'round', meta: {}, title: 'Round 2', track: 'experience' };
  assert.deepEqual(myItemTarget(round, 'p1'), { name: 'project-requirements-round-review', params: { projectId: 'p1', roundId: 'round-2' } });
  assert.deepEqual(myItemTarget(round, 'p1', { roundReview: false }), { name: 'project-requirements-round', params: { projectId: 'p1', roundId: 'round-2' } });

  const draft = { action: 'preview', id: 'pkg-3', kind: 'package', meta: { version: 3 }, title: 'Booking', track: 'experience' };
  assert.deepEqual(myItemSecondaryAction(draft, 'p1', { canPublish: true }), {
    label: 'Publish',
    target: { name: 'project-requirements-round-publish', params: { packageId: 'pkg-3', projectId: 'p1' } },
  });
  assert.equal(myItemSecondaryAction(draft, 'p1', { canPublish: false }), null);
  assert.equal(myItemSecondaryAction(round, 'p1', { canPublish: true }), null);
});

test('round abilities: members publish and manage rounds, only deciders close them', () => {
  const member = requirementsAbilities({ canDecide: false, projectRole: 'member' });
  assert.deepEqual([member.publishRounds, member.manageRounds, member.closeRounds], [true, true, false]);
  const manager = requirementsAbilities({ canDecide: true, projectRole: 'manager' });
  assert.deepEqual([manager.publishRounds, manager.manageRounds, manager.closeRounds], [true, true, true]);
  const viewer = requirementsAbilities({ canDecide: false, projectRole: 'viewer' });
  assert.deepEqual([viewer.publishRounds, viewer.manageRounds, viewer.closeRounds], [false, false, false]);
});
