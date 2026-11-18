import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeTopicDecision,
  assignmentKeys,
  assignmentsFromKeys,
  avatarColor,
  buildAssignmentsPayload,
  buildDecisionLog,
  decisionChip,
  draftQuestionsSummary,
  evidenceLine,
  isRoundPreference,
  filterRegisterRows,
  mergeTopicUpdate,
  readyRank,
  registerFilterCounts,
  resolveProposedAnswerStatus,
  rowProposedAnswerStatus,
  rowSignals,
  signalBadges,
  signalsAriaLabel,
  sameAssignmentKeys,
  sortRegisterRows,
  topicPeople,
  topicSettled,
  topicStateChip,
} from '../src/lib/requirements/requirements-topics.js';

const rows = [
  { createdAt: '2026-10-03', id: 'decided', prompt: 'Is booking first?', state: 'decided' },
  { createdAt: '2026-10-02', id: 'open-1', prompt: 'Do technicians see notes?', rationale: 'Visit prep', settles: 'technician app', sourceRef: 'brief:requirements:0', state: 'open' },
  { createdAt: '2026-10-04', id: 'ready-2', prompt: 'Reminders by email or text?', state: 'ready' },
  { createdAt: '2026-10-01', id: 'ready-1', prompt: 'Show a price first?', sourceRef: 'brief:requirements:1', state: 'ready' },
  { createdAt: '2026-10-01', id: 'gone', prompt: 'Old idea', state: 'dismissed' },
];

test('the register sorts ready topics first, then open, decided, dismissed', () => {
  assert.deepEqual(sortRegisterRows(rows).map((row) => row.id), ['ready-1', 'ready-2', 'open-1', 'decided', 'gone']);
});

test('register filters mirror the API views', () => {
  assert.deepEqual(filterRegisterRows(rows, { view: 'all' }).map((row) => row.id), ['ready-1', 'ready-2', 'open-1', 'decided']);
  assert.deepEqual(filterRegisterRows(rows, { view: 'open' }).map((row) => row.id), ['ready-1', 'ready-2', 'open-1']);
  assert.deepEqual(filterRegisterRows(rows, { view: 'decided' }).map((row) => row.id), ['decided']);
  assert.deepEqual(filterRegisterRows(rows, { view: 'needs-decision' }).map((row) => row.id), ['ready-1', 'ready-2']);
  assert.deepEqual(filterRegisterRows(rows, { view: 'dismissed' }).map((row) => row.id), ['gone']);
});

test('register search covers prompt, rationale, and settles; a brief line narrows further', () => {
  assert.deepEqual(filterRegisterRows(rows, { q: 'TECHNICIAN' }).map((row) => row.id), ['open-1']);
  assert.deepEqual(filterRegisterRows(rows, { q: 'visit prep' }).map((row) => row.id), ['open-1']);
  assert.deepEqual(filterRegisterRows(rows, { sourceRef: 'brief:requirements:1' }).map((row) => row.id), ['ready-1']);
  assert.deepEqual(registerFilterCounts(rows), { all: 4, decided: 1, dismissed: 1, open: 3 });
});

test('state chips: ready reads as needing a decision; decided shows the outcome', () => {
  assert.deepEqual(topicStateChip({ state: 'ready' }), { label: 'Ready', tone: 'warn' });
  assert.deepEqual(topicStateChip({ state: 'ready' }, { long: true }), { label: 'Open · ready for a decision', tone: 'warn' });
  assert.deepEqual(topicStateChip({ decision: { outcome: 'agreed' }, state: 'decided' }), { label: 'Agreed', tone: 'ok' });
  assert.deepEqual(topicStateChip({ state: 'decided' }), { label: 'Decided', tone: 'ok' });
  assert.deepEqual(topicStateChip({ state: 'dismissed' }), { label: 'Dismissed', tone: 'outline' });
  assert.deepEqual(topicStateChip({ origin: 'brief-draft', state: 'open' }), { label: 'Open', tone: 'neutral' });
});

test('signals list non-zero counts with accessible labels', () => {
  const signals = { aligned: 2, divergent: 1, outstanding: 1, underExplored: 0 };
  assert.deepEqual(signalBadges(signals).map((badge) => `${badge.count}${badge.symbol}`), ['2✓', '1⇄', '1!']);
  assert.equal(signalsAriaLabel(signals), '2 aligned, 1 diverging, 1 outstanding');
  assert.equal(signalsAriaLabel({}), 'No summary signals yet');
});

test('blocking items get their own badge beside the outstanding total', () => {
  const badges = signalBadges({ blocking: 1, outstanding: 3 });
  assert.deepEqual(badges.map((badge) => [badge.key, badge.count]), [['outstanding', 3], ['blocking', 1]]);
  assert.equal(badges[1].icon, 'bi-exclamation-octagon-fill');
  assert.equal(signalsAriaLabel({ blocking: 1, outstanding: 3 }), '3 outstanding, 1 blocking');
  assert.equal(signalsAriaLabel({ blocking: 0, outstanding: 2 }), '2 outstanding');
});

test('decided and dismissed rows show no outstanding or blocking signals', () => {
  const signals = { aligned: 2, blocking: 1, outstanding: 2 };
  assert.deepEqual(rowSignals({ signals, state: 'ready' }), signals);
  assert.deepEqual(rowSignals({ signals, state: 'decided' }), { aligned: 2, blocking: 0, outstanding: 0 });
  assert.deepEqual(rowSignals({ signals, state: 'dismissed' }), { aligned: 2, blocking: 0, outstanding: 0 });
  // Only the state settles a topic, as the API reads it: a deferred decision keeps it open.
  assert.equal(rowSignals({ decision: { outcome: 'deferred' }, signals, state: 'open' }).blocking, 1);
  assert.deepEqual(rowSignals({}), {});
  assert.equal(topicSettled({ state: 'ready' }), false);
  assert.equal(topicSettled({ decision: { id: 'd1', outcome: 'deferred' }, state: 'open' }), false, 'a deferral keeps the topic open');
  assert.equal(topicSettled({ state: 'dismissed' }), true);
  assert.equal(topicSettled(null), false);
});

test('proposed-answer status reads old summaries without one as agreed', () => {
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: '', status: 'agreed' }), 'none');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Show a range.' }), 'agreed');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Show a range.', status: 'awaiting-confirmation' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Show a range.', status: 'agreed' }), 'agreed');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Show a range.', status: 'none' }), 'awaiting-confirmation');
  assert.equal(rowProposedAnswerStatus({ summary: { proposedAnswer: 'x', proposedAnswerStatus: 'awaiting-confirmation' } }), 'awaiting-confirmation');
  assert.equal(rowProposedAnswerStatus({ summary: { output: { proposedAnswer: 'x' } } }), 'agreed');
  assert.equal(rowProposedAnswerStatus({}), 'none');
});

test('ready topics sort agreed and unblocked first, then awaiting confirmation, then blocked, as the API does', () => {
  const ready = (id, createdAt, { blocking = 0, status = 'agreed' } = {}) => ({
    createdAt,
    id,
    signals: { blocking, outstanding: blocking },
    state: 'ready',
    summary: { proposedAnswer: 'An answer', proposedAnswerStatus: status },
  });
  const register = [
    ready('blocked', '2026-10-01', { blocking: 1 }),
    { createdAt: '2026-09-01', id: 'open', state: 'open' },
    ready('awaiting', '2026-10-02', { status: 'awaiting-confirmation' }),
    ready('agreed-late', '2026-10-05'),
    ready('awaiting-blocked', '2026-09-30', { blocking: 2, status: 'awaiting-confirmation' }),
    ready('agreed-early', '2026-10-03'),
  ];
  assert.deepEqual(sortRegisterRows(register).map((row) => row.id), ['agreed-early', 'agreed-late', 'awaiting', 'awaiting-blocked', 'blocked', 'open']);
  assert.equal(readyRank(register[0]), 2);
  assert.equal(readyRank(register[2]), 1);
  assert.equal(readyRank(register[3]), 0);
  assert.equal(readyRank({ state: 'open', signals: { blocking: 3 } }), 0);
  // The owner's own unchallenged answer is as ready to record as an agreed one.
  assert.equal(readyRank(ready('owner', '2026-10-04', { status: 'owner-answered' })), 0);
  assert.equal(rowProposedAnswerStatus({ summary: { proposedAnswer: 'An answer', proposedAnswerStatus: 'owner-answered' } }), 'owner-answered');
});

test('preferences from a review round stay out of Decide, proposed or accepted', () => {
  assert.equal(isRoundPreference({ scopeType: 'round' }), true);
  assert.equal(isRoundPreference({ scopeType: 'screen' }), true);
  assert.equal(isRoundPreference({ scopeType: 'topic' }), false);
  assert.equal(isRoundPreference({ kind: 'preference', preference: { origin: 'round' } }), true);
  assert.equal(isRoundPreference({ kind: 'preference', preference: { origin: 'topic' } }), false);
  assert.equal(isRoundPreference({ kind: 'preference', preference: {} }), false, 'older responses without an origin stay listed');
  assert.equal(isRoundPreference({ kind: 'topic' }), false);
});

test('evidence lines count comments, people, and round answers', () => {
  assert.equal(evidenceLine({ comments: 9, contributors: 4 }), '9 comments · 4 people');
  assert.equal(evidenceLine({ comments: 1, contributors: 1, roundAnswers: 2 }), '1 comment · 1 person · 2 round answers');
  assert.equal(evidenceLine({ comments: 0 }), '');
});

test('topic people separate the owner from everyone else involved', () => {
  const people = topicPeople({
    assignments: [
      { actorId: 's1', actorType: 'stakeholder', label: 'Jamie Ortiz', role: 'primary' },
      { actorId: 'u2', actorType: 'user', label: 'Alex Kim', role: 'collaborator' },
    ],
    owner: { actorId: 's1', actorType: 'stakeholder', label: 'Jamie Ortiz' },
  });
  assert.equal(people.owner.name, 'Jamie Ortiz');
  assert.equal(people.owner.initials, 'JO');
  assert.deepEqual(people.others.map((person) => person.name), ['Alex Kim']);
  assert.equal(topicPeople({ assignments: [] }).owner, null);
  assert.equal(avatarColor('stakeholder:s1'), avatarColor('stakeholder:s1'));
});

test('assignment payload keeps one primary owner and no duplicates', () => {
  assert.deepEqual(buildAssignmentsPayload({
    collaborators: [
      { actorId: 'u1', actorType: 'user', label: 'Owner again' },
      { actorId: 's2', actorType: 'stakeholder', label: 'Noor' },
      { actorId: 's2', actorType: 'stakeholder', label: 'Noor' },
    ],
    owner: { actorId: 'u1', actorType: 'user', label: 'Sam' },
  }), [
    { actorId: 'u1', actorType: 'user', label: 'Sam', role: 'primary' },
    { actorId: 's2', actorType: 'stakeholder', label: 'Noor', role: 'collaborator' },
  ]);
  assert.deepEqual(buildAssignmentsPayload({}), []);
});

test('required people round-trip through the picker keys and outrank plain involvement', () => {
  const current = [
    { actorId: 'u1', actorType: 'user', label: 'Rosa', role: 'primary' },
    { actorId: 's1', actorType: 'stakeholder', label: 'Dana', role: 'required' },
    { actorId: 's2', actorType: 'stakeholder', label: 'Lena', role: 'collaborator' },
  ];
  const keys = assignmentKeys(current);
  assert.deepEqual(keys, { involved: ['stakeholder:s1', 'stakeholder:s2'], owner: 'user:u1', required: ['stakeholder:s1'] });
  assert.equal(sameAssignmentKeys(keys, { ...keys, required: [] }), false, 'changing who is required is a change');
  assert.deepEqual(assignmentsFromKeys({ current, ...keys }).map(({ actorId, role }) => [actorId, role]), [['u1', 'primary'], ['s1', 'required'], ['s2', 'collaborator']]);
  // Required only counts for people who are involved.
  assert.deepEqual(assignmentsFromKeys({ current, involved: ['stakeholder:s2'], owner: 'user:u1', required: ['stakeholder:s1'] }).map(({ actorId, role }) => [actorId, role]), [['u1', 'primary'], ['s2', 'collaborator']]);
  assert.deepEqual(buildAssignmentsPayload({
    collaborators: [{ actorId: 's1', actorType: 'stakeholder', label: 'Dana' }],
    required: [{ actorId: 's1', actorType: 'stakeholder', label: 'Dana' }],
  }), [{ actorId: 's1', actorType: 'stakeholder', label: 'Dana', role: 'required' }]);
  assert.equal(readyRank({ signals: { blocking: 0 }, state: 'ready', summary: { proposedAnswerStatus: 'authority-answered' } }), 0);
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'x', status: 'authority-answered' }), 'authority-answered');
});

test('draft-questions results summarize what was added and skipped', () => {
  assert.equal(draftQuestionsSummary({ created: [{}, {}], skipped: [{ reason: 'duplicate' }] }), 'Added 2 questions from the brief. Skipped 1 that repeats an existing topic.');
  assert.equal(draftQuestionsSummary({ created: [{}], skipped: [{ reason: 'duplicate' }, { reason: 'duplicate' }, { reason: 'limit' }] }), 'Added 1 question from the brief. Skipped 2 that repeat existing topics. Skipped 1 other question.');
  assert.equal(draftQuestionsSummary({ created: [], skipped: [] }), 'No new questions were added.');
});

const decisions = [
  { decidedAt: '2026-10-01T00:00:00Z', id: 'd-old', kind: 'topic', outcome: 'decided', status: 'superseded', supersededById: 'd-new' },
  { decidedAt: '2026-10-05T00:00:00Z', id: 'd-new', kind: 'topic', outcome: 'agreed', sources: ['comment:a', 'comment:b'], status: 'active', supersedesId: 'd-old' },
  { decidedAt: '2026-10-03T00:00:00Z', id: 'd-pref', kind: 'preference', outcome: 'agreed', preference: { dimension: 'type', stance: 'keep' }, status: 'active' },
  { decidedAt: '2026-10-04T00:00:00Z', id: 'd-later', kind: 'topic', outcome: 'deferred', status: 'active' },
];

test('the decision log is newest first with stable chronological labels and the supersedes chain', () => {
  const log = buildDecisionLog(decisions);
  assert.deepEqual(log.map((entry) => [entry.id, entry.label]), [['d-new', 'D-04'], ['d-later', 'D-03'], ['d-pref', 'D-02'], ['d-old', 'D-01']]);
  assert.equal(log[0].supersedesLabel, 'D-01');
  assert.equal(log[0].sourceCount, 2);
  assert.equal(log[3].supersededByLabel, 'D-04');
  assert.deepEqual(log[3].chip, { label: 'Superseded', tone: 'outline' });
  assert.deepEqual(log[2].chip, { label: 'Preference · keep', tone: 'ok' });
  assert.deepEqual(log[1].chip, { label: 'Deferred', tone: 'neutral' });
  assert.deepEqual(decisionChip({ kind: 'preference', preference: { stance: 'change' } }), { label: 'Preference · change', tone: 'warn' });
});

test('the active topic decision is the newest one nothing superseded', () => {
  assert.equal(activeTopicDecision(decisions.filter((decision) => decision.kind === 'topic')).id, 'd-new');
  assert.equal(activeTopicDecision([]), null);
});

test('write responses merge into the loaded topic without losing the full summary or history', () => {
  const current = {
    comments: [{ id: 'c1' }],
    decisions: [{ id: 'd1' }],
    id: 't1',
    prompt: 'Old',
    summary: { id: 's1', output: { aligned: [] } },
  };
  const patched = mergeTopicUpdate(current, { id: 't1', prompt: 'New', summary: { id: 's1', insufficientInput: false, proposedAnswer: '' } });
  assert.equal(patched.stale, false);
  assert.equal(patched.topic.prompt, 'New');
  assert.deepEqual(patched.topic.comments, [{ id: 'c1' }]);
  assert.deepEqual(patched.topic.decisions, [{ id: 'd1' }]);
  assert.deepEqual(patched.topic.summary, { id: 's1', output: { aligned: [] } });

  const commented = mergeTopicUpdate(current, { comments: [{ id: 'c1' }, { id: 'c2' }], id: 't1', summary: { id: 's2' } });
  assert.equal(commented.stale, true);
  assert.equal(commented.topic.comments.length, 2);
  assert.equal(mergeTopicUpdate(null, { id: 't1' }).stale, true);
  assert.equal(mergeTopicUpdate(current, null).topic, current);
});
