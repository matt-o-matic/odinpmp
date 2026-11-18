import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMyItemGroups,
  describeMyItemStages,
  filterMyItemGroups,
  myItemActionLabel,
  myItemAnswerChip,
  myItemMeta,
  myItemTarget,
  myItemTitle,
  myItemWhen,
  myItemsBadgeCount,
} from '../src/lib/requirements/requirements-my-items.js';

const now = new Date(2026, 9, 7, 12, 0, 0);
const decideTopic = { action: 'decide', id: 't1', kind: 'topic', meta: { evidence: { comments: 9, contributors: 4 }, readySince: new Date(2026, 9, 7, 9).toISOString() }, title: 'Price first?', track: 'experience' };
const decidePreference = { action: 'decide', createdAt: new Date(2026, 9, 6).toISOString(), id: 's1:0', kind: 'preference', meta: { dimension: 'hierarchy', sources: ['a', 'b'], stance: 'keep' }, title: 'One primary action', track: 'experience', updatedAt: new Date(2026, 9, 6).toISOString() };
const answer = { action: 'reply', id: 't2', kind: 'topic', meta: { commentCount: 3, lastActivityAt: new Date(2026, 9, 5).toISOString(), role: 'primary' }, title: 'Estimate service?', track: 'architecture' };
const review = { action: 'review', id: 'r2', kind: 'round', meta: { dueAt: new Date(2026, 9, 10, 17).toISOString(), number: 2, required: true }, title: 'Round 2', track: 'experience' };
const draft = { action: 'preview', id: 'p1', kind: 'package', meta: { source: 'mcp', version: 1 }, title: 'Scheduling options', track: 'architecture' };
const payload = {
  canDecide: true,
  counts: { answer: 1, decide: 2, drafts: 1, review: 1, total: 5 },
  groups: { answer: [answer], decide: [decideTopic, decidePreference], drafts: [draft], review: [review] },
};

test('groups appear in order, and only non-empty ones', () => {
  assert.deepEqual(buildMyItemGroups(payload, { canDecide: true }).map((group) => [group.key, group.items.length]), [
    ['decide', 2], ['answer', 1], ['review', 1], ['drafts', 1],
  ]);
  assert.deepEqual(buildMyItemGroups({ groups: { answer: [], decide: [], drafts: [], review: [review] } }, { canDecide: true }).map((group) => group.key), ['review']);
  assert.deepEqual(buildMyItemGroups(null), []);
});

test('topics to decide follow the register\'s ready order, then preferences', () => {
  const topic = (id, meta) => ({ action: 'decide', id, kind: 'topic', meta, title: id, track: 'experience' });
  const decide = [
    topic('blocked', { signals: { blocking: 1, outstanding: 1 } }),
    decidePreference,
    topic('plain', { signals: { blocking: 0, outstanding: 2 } }),
    topic('awaiting', { proposedAnswerStatus: 'awaiting-confirmation', signals: {} }),
    topic('agreed', { proposedAnswerStatus: 'agreed', signals: {} }),
  ];
  const [group] = buildMyItemGroups({ groups: { decide } }, { canDecide: true });
  assert.deepEqual(group.items.map((item) => item.id), ['agreed', 'plain', 'awaiting', 'blocked', 's1:0']);
  assert.equal(myItemAnswerChip(decide[3]).label, 'One person’s answer, awaiting confirmation');
  assert.equal(myItemAnswerChip(decide[0]), null, 'no chip without a status in the payload');
  assert.equal(myItemAnswerChip(decidePreference), null);
});

test('the decision group needs decision rights whatever the payload holds', () => {
  assert.deepEqual(buildMyItemGroups(payload, { canDecide: false }).map((group) => group.key), ['answer', 'review', 'drafts']);
  assert.equal(myItemsBadgeCount(payload), 5);
  assert.equal(myItemsBadgeCount({ ...payload, canDecide: false }), 3);
  assert.equal(myItemsBadgeCount(null), 0);
});

test('one action per row, each going to its place', () => {
  assert.equal(myItemActionLabel(decideTopic), 'Decide');
  assert.equal(myItemActionLabel(answer), 'Reply');
  assert.equal(myItemActionLabel(review), 'Start review');
  assert.equal(myItemActionLabel(draft), 'Preview');
  assert.deepEqual(myItemTarget(decideTopic, 'p1'), { name: 'project-requirements-topic', params: { projectId: 'p1', topicId: 't1' }, query: { focus: 'decision' } });
  assert.deepEqual(myItemTarget(answer, 'p1').query, { focus: 'reply' });
  assert.deepEqual(myItemTarget(decidePreference, 'p1'), { name: 'project-requirements-track', params: { projectId: 'p1', stage: 'decide', track: 'experience' }, query: { preference: 's1:0' } });
  assert.deepEqual(myItemTarget(review, 'p1'), { name: 'project-requirements-round-review', params: { projectId: 'p1', roundId: 'r2' } });
  assert.deepEqual(myItemTarget(draft, 'p1'), { name: 'project-requirements-package', params: { packageId: 'p1', projectId: 'p1' } });
});

test('titles and meta lines', () => {
  assert.equal(myItemTitle(decidePreference), 'Preference: One primary action');
  assert.equal(myItemMeta(decideTopic), '9 contributions from 4 people');
  assert.equal(myItemMeta(decidePreference), 'Proposed keep · hierarchy · 2 sources');
  assert.equal(myItemMeta(answer), 'You own this topic · 3 comments');
  assert.equal(myItemMeta({ ...answer, meta: { commentCount: 0, role: 'collaborator' } }), 'You were asked to weigh in · no replies yet');
  assert.equal(myItemMeta(review), 'You are a required reviewer');
  assert.equal(myItemMeta(draft), 'Package v1 · uploaded through MCP');
});

test('timing text and due dates', () => {
  assert.deepEqual(myItemWhen(decideTopic, { locale: 'en-US', now }), { due: false, text: 'ready since today' });
  assert.deepEqual(myItemWhen(answer, { locale: 'en-US', now }), { due: false, text: '2 days ago' });
  assert.deepEqual(myItemWhen(review, { locale: 'en-US', now }), { due: true, text: 'due Sat, Oct 10' });
  assert.deepEqual(myItemWhen({ ...review, meta: { dueAt: new Date(2026, 9, 1).toISOString() } }, { locale: 'en-US', now }), { due: true, text: 'was due Thu, Oct 1' });
  assert.deepEqual(myItemWhen(draft, { now }), { due: false, text: 'not published' });
  assert.deepEqual(myItemWhen(decidePreference, { locale: 'en-US', now }), { due: false, text: 'yesterday' });
});

test('stage cards count only the caller\'s items, in pipeline order', () => {
  const groups = buildMyItemGroups(payload, { canDecide: true });
  assert.deepEqual(describeMyItemStages(groups, { now }).map((card) => [card.id, card.count, card.status, card.tone]), [
    ['brief', 0, 'Nothing for you', 'idle'],
    ['discuss', 1, '1 to answer', 'active'],
    ['review', 2, '1 round to review · 1 draft', 'active'],
    ['decide', 2, '2 to decide', 'attention'],
    ['plan', 0, 'Nothing for you', 'idle'],
  ]);
  const late = buildMyItemGroups({ groups: { review: [{ ...review, meta: { dueAt: new Date(2026, 9, 1).toISOString() } }] } });
  assert.deepEqual(describeMyItemStages(late, { now }).find((card) => card.id === 'review'), {
    count: 1, id: 'review', label: 'Review', number: '03', status: '1 round to review', tone: 'attention',
  });
  assert.ok(describeMyItemStages([], { now }).every((card) => card.tone === 'idle'));
});

test('picking a stage keeps only the groups whose work belongs to it', () => {
  const groups = buildMyItemGroups(payload, { canDecide: true });
  assert.deepEqual(filterMyItemGroups(groups, 'review').map((group) => group.key), ['review', 'drafts']);
  assert.deepEqual(filterMyItemGroups(groups, 'discuss').map((group) => group.key), ['answer']);
  assert.deepEqual(filterMyItemGroups(groups, 'brief'), []);
  assert.equal(filterMyItemGroups(groups, ''), groups);
});
