import assert from 'node:assert/strict';
import test from 'node:test';

import { bulkAssignments } from '../src/modules/requirements/requirements-bulk.js';
import { createRequirementsTestApp, PROJECT_ID, ROLE_USERS, TENANT_ID } from './helpers/requirements-test-app.js';

// POST /topics/bulk: one action over many register topics, each through the single-topic
// checks, with a result per topic so a mixed selection says what was skipped and why.

async function summary(harness, topicId, proposedAnswer) {
  return harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: {
      output: {
        aligned: [{ sources: ['comment:1', 'comment:2'], statement: 'People agree.', supporters: [] }],
        divergent: [],
        insufficientInput: false,
        outstanding: [],
        proposedAnswer,
        proposedPreferences: [],
        underExplored: [],
      },
      scopeId: topicId,
      scopeType: 'topic',
      track: 'experience',
    },
    tenantId: TENANT_ID,
  });
}

const byTopic = (body) => Object.fromEntries(body.results.map((result) => [result.topicId, result.status === 'done' ? 'done' : `${result.status}:${result.code}`]));

test('bulk people changes: set an owner, add and remove people, and leave unchanged topics alone', () => {
  const sam = { actorId: 'sam', actorType: 'stakeholder' };
  const una = { actorId: 'una', actorType: 'user' };
  const current = [{ ...una, label: 'Una', role: 'primary' }, { ...sam, label: 'Sam', role: 'collaborator' }];
  assert.equal(bulkAssignments(current, { add: [sam] }), null, 'adding someone already involved changes nothing');
  assert.deepEqual(bulkAssignments(current, { owner: sam }), [{ ...sam, label: 'Sam', role: 'primary' }], 'the new owner is not also listed, and the old owner is dropped');
  assert.deepEqual(bulkAssignments(current, { remove: [una] }), [{ ...sam, label: 'Sam', role: 'collaborator' }]);
  assert.deepEqual(bulkAssignments(current, { owner: null }), [{ ...sam, label: 'Sam', role: 'collaborator' }]);
  assert.deepEqual(bulkAssignments([], { add: [una], owner: sam }), [{ ...sam, label: '', role: 'primary' }, { ...una, label: '', role: 'collaborator' }]);

  // A required person stays required through a bulk change; people added are asked for input.
  const ria = { actorId: 'ria', actorType: 'stakeholder' };
  const withRequired = [{ ...una, label: 'Una', role: 'primary' }, { ...sam, label: 'Sam', role: 'required' }];
  assert.deepEqual(bulkAssignments(withRequired, { add: [ria] }), [
    { ...una, label: 'Una', role: 'primary' },
    { ...sam, label: 'Sam', role: 'required' },
    { ...ria, label: '', role: 'collaborator' },
  ]);
  assert.equal(bulkAssignments(withRequired, { add: [sam] }), null, 'adding a required person again changes nothing');
});

test('bulk agree records each topic\'s own proposed answer and skips topics without one or with a decision', async () => {
  const harness = await createRequirementsTestApp();
  const ready = await harness.createTopic({ prompt: 'Show an estimate first?' });
  const empty = await harness.createTopic({ prompt: 'Which payment methods?' });
  const decided = await harness.createTopic({ prompt: 'Allow rescheduling?' });
  await summary(harness, ready.id, 'Show a price range on the home screen.');
  await summary(harness, decided.id, 'Up to a day before.');
  assert.equal((await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'One day.', topicId: decided.id })).status, 201);

  const refused = await harness.as('member').post('/topics/bulk', { action: 'agree', topicIds: [ready.id] });
  assert.equal(refused.status, 404, 'agreeing needs decision rights');

  const response = await harness.as('projectManager').post('/topics/bulk', { action: 'agree', topicIds: [ready.id, empty.id, decided.id] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(byTopic(response.body), { [decided.id]: 'skipped:has_decision', [empty.id]: 'skipped:no_proposed_answer', [ready.id]: 'done' });
  assert.deepEqual(response.body.counts, { done: 1, failed: 0, skipped: 2 });
  const after = (await harness.as('member').get(`/topics/${ready.id}`)).body.topic;
  assert.deepEqual([after.decision.outcome, after.decision.statement, after.state], ['agreed', 'Show a price range on the home screen.', 'decided']);
  assert.deepEqual(after.decisions[0].sources, ['comment:1', 'comment:2']);
});

test('bulk defer needs a reason; dismiss and reopen follow each topic\'s state; delete only removes untouched topics', async () => {
  const harness = await createRequirementsTestApp();
  const first = await harness.createTopic({ prompt: 'First?' });
  const second = await harness.createTopic({ prompt: 'Second?' });
  const discussed = await harness.createTopic({ prompt: 'Discussed?' });
  assert.equal((await harness.as('member').post(`/topics/${discussed.id}/comments`, { body: 'We talked about this.' })).status, 201);

  assert.equal((await harness.as('projectManager').post('/topics/bulk', { action: 'defer', topicIds: [first.id] })).status, 400);
  const deferred = await harness.as('projectManager').post('/topics/bulk', { action: 'defer', statement: 'After launch.\nRevisit in Q3.', topicIds: [first.id] });
  assert.deepEqual(byTopic(deferred.body), { [first.id]: 'done' });
  assert.equal((await harness.as('member').get(`/topics/${first.id}`)).body.topic.decision.statement, 'After launch.\nRevisit in Q3.');

  const dismissed = await harness.as('projectManager').post('/topics/bulk', { action: 'dismiss', topicIds: [second.id, discussed.id, first.id] });
  // A deferred topic stays open, so it can be dismissed too.
  assert.deepEqual(byTopic(dismissed.body), { [discussed.id]: 'done', [first.id]: 'done', [second.id]: 'done' });
  const ids = async (view) => (await harness.as('member').get(`/tracks/experience/topics?view=${view}`)).body.topics.map((topic) => topic.id).sort();
  assert.deepEqual(await ids('all'), [], 'the default list leaves dismissed topics out');
  assert.deepEqual(await ids('every'), [first.id, second.id, discussed.id].sort(), 'every includes them, for the register\'s Dismissed filter');
  const again = await harness.as('projectManager').post('/topics/bulk', { action: 'dismiss', topicIds: [second.id] });
  assert.deepEqual(byTopic(again.body), { [second.id]: 'skipped:already_dismissed' });
  const reopened = await harness.as('projectManager').post('/topics/bulk', { action: 'reopen', topicIds: [second.id, discussed.id] });
  assert.deepEqual(byTopic(reopened.body), { [discussed.id]: 'done', [second.id]: 'done' });

  const deleted = await harness.as('member').post('/topics/bulk', { action: 'delete', topicIds: [second.id, discussed.id, 'missing-topic'] });
  assert.deepEqual(byTopic(deleted.body), { [discussed.id]: 'skipped:topic_has_activity', 'missing-topic': 'failed:http_404', [second.id]: 'done' });
  assert.equal((await harness.as('member').get(`/topics/${second.id}`)).status, 404);
  assert.equal((await harness.as('viewer').post('/topics/bulk', { action: 'delete', topicIds: [discussed.id] })).status, 404, 'viewers cannot change topics');
});

test('bulk assign gives every selected topic the same people change, and a member may do it', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const owned = await harness.createTopic({ assignments: [{ actorId: ROLE_USERS.member.id, actorType: 'user', role: 'primary' }], prompt: 'Owned?' });
  const open = await harness.createTopic({ prompt: 'Open?' });
  const sam = { actorId: stakeholder.id, actorType: 'stakeholder' };

  const added = await harness.as('member').post('/topics/bulk', { action: 'assign', assign: { add: [sam] }, topicIds: [owned.id, open.id] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(byTopic(added.body), { [open.id]: 'done', [owned.id]: 'done' });
  const ownedAfter = (await harness.as('member').get(`/topics/${owned.id}`)).body.topic.assignments;
  assert.deepEqual(ownedAfter.map((assignment) => [assignment.actorId, assignment.role, assignment.label]), [[ROLE_USERS.member.id, 'primary', ROLE_USERS.member.name], [stakeholder.id, 'collaborator', 'Jamie Ortiz']]);

  const unchanged = await harness.as('member').post('/topics/bulk', { action: 'assign', assign: { add: [sam] }, topicIds: [open.id] });
  assert.deepEqual(byTopic(unchanged.body), { [open.id]: 'skipped:unchanged' });

  const removed = await harness.as('member').post('/topics/bulk', { action: 'assign', assign: { owner: null, remove: [sam] }, topicIds: [owned.id, open.id] });
  assert.deepEqual(byTopic(removed.body), { [open.id]: 'done', [owned.id]: 'done' });
  assert.deepEqual((await harness.as('member').get(`/topics/${owned.id}`)).body.topic.assignments, []);

  assert.equal((await harness.as('member').post('/topics/bulk', { action: 'assign', assign: {}, topicIds: [open.id] })).status, 400, 'an assign with no change is refused');
});
