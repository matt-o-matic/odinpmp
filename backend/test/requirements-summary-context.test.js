import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionWarnings } from '../src/mcp/requirements-topic-tools.js';
import { buildDraftQuestionsInput, draftedTopicRationale } from '../src/modules/requirements/ai/requirements-draft-questions.js';
import { readyRank, signalCounts, sortTopicRows } from '../src/modules/requirements/requirements-topics.js';
import {
  loadLinkedTopics,
  refreshRoundsLinkedToTopics,
  registerRoundSummaryScopes,
  topicAnswerChanged,
} from '../src/modules/requirements/rounds/round-summaries.js';
import { createRequirementsSummaryEngine } from '../src/modules/requirements/summary/summary-engine.js';
import { emptySummaryOutput, resolveProposedAnswerStatus } from '../src/modules/requirements/summary/summary-output.js';
import { buildSummaryModelInput, buildSummaryRefMaps, normalizeSummaryParticipants, normalizeSummarySources, participantStanding } from '../src/modules/requirements/summary/summary-prompt.js';
import { buildTopicSummaryInput, presentSummaryOutput, topicParticipants } from '../src/modules/requirements/summary/summary-topics.js';

// The summary's view of who owns a question, which decisions bear on it, and how rounds
// follow their linked topics; plus the register signals that read the result.

const TOPIC = {
  assignments: [
    { actorId: 's1', actorType: 'stakeholder', label: 'Dana W', role: 'primary' },
    { actorId: 'u1', actorType: 'user', label: 'Matt T', role: 'collaborator' },
  ],
  comments: [{ actorId: 's1', actorType: 'stakeholder', authorName: 'Dana W', body: 'Alert staff only for repeated failures.', children: [], createdAt: '2026-10-15T00:08:00.000Z', id: 'c1' }],
  id: 'topic-1',
  prompt: 'Which correction cases need staff, and how quickly?',
};

const DECISIONS = [
  { decidedAt: '2026-10-15T20:30:00.000Z', decidedByName: 'Matt T', id: 'd1', kind: 'topic', outcome: 'agreed', statement: '<p>Own <strong>decision</strong></p>', topicId: 'topic-1' },
  { decidedAt: '2026-10-15T21:00:00.000Z', id: 'd2', kind: 'topic', outcome: 'agreed', statement: '**State filing** is in V1.', topicId: 'topic-2', track: 'experience' },
  { decidedAt: '2026-10-14T21:00:00.000Z', id: 'd3', kind: 'topic', outcome: 'agreed', statement: 'Old call.', supersededById: 'd4', topicId: 'topic-3' },
  { decidedAt: '2026-10-14T21:00:00.000Z', id: 'd5', kind: 'preference', outcome: 'agreed', statement: 'Keep the sidebar.', topicId: null },
];

test('a topic summary gets its owner and assignees, its own decisions, and other topics\' active decisions in plain text', () => {
  const input = buildTopicSummaryInput({ clarification: TOPIC, decisions: DECISIONS, track: 'experience' });
  assert.deepEqual(input.participants, [
    { actorName: 'Dana W', actorRef: 'stakeholder:s1', topicRole: 'owner' },
    { actorName: 'Matt T', actorRef: 'user:u1', topicRole: 'assigned' },
  ]);
  assert.deepEqual(input.context.decisions.map((decision) => [decision.statement, decision.state]), [['Own decision', 'active']]);
  assert.deepEqual(input.context.relatedDecisions, [
    { decidedAt: '2026-10-15T21:00:00.000Z', decidedBy: 'A project manager', outcome: 'agreed', statement: 'State filing is in V1.', track: 'experience' },
  ]);

  // A primary assignment that is not in the list still counts; no related decisions, no key.
  const lone = buildTopicSummaryInput({
    clarification: { ...TOPIC, assignments: [], primaryAssignment: { actorId: 'u9', actorType: 'user', label: 'Pat' } },
    decisions: DECISIONS.slice(0, 1),
    track: 'experience',
  });
  assert.deepEqual(lone.participants, [{ actorName: 'Pat', actorRef: 'user:u9', topicRole: 'owner' }]);
  assert.equal('relatedDecisions' in lone.context, false);
});

test('required people and admins rank below the owner and above everyone else', () => {
  const clarification = {
    assignments: [
      { actorId: 'u-rosa', actorType: 'user', label: 'Rosa O', role: 'primary' },
      { actorId: 's-dana', actorType: 'stakeholder', label: 'Dana W', role: 'required' },
      { actorId: 's-lena', actorType: 'stakeholder', label: 'Lena E', role: 'collaborator' },
    ],
  };
  const participants = topicParticipants(clarification, new Map(), { admins: ['user:u-rosa', 'user:u-matt'] });
  assert.deepEqual(participants, [
    { actorName: 'Rosa O', actorRef: 'user:u-rosa', admin: true, topicRole: 'owner' },
    { actorName: 'Dana W', actorRef: 'stakeholder:s-dana', topicRole: 'required' },
    { actorName: 'Lena E', actorRef: 'stakeholder:s-lena', topicRole: 'assigned' },
    { actorName: '', actorRef: 'user:u-matt', admin: true, topicRole: null },
  ]);
  const roles = normalizeSummaryParticipants(participants);
  assert.deepEqual(roles.map((role) => [role.actorRef, participantStanding(role)]), [
    ['user:u-rosa', 'owner'],
    ['stakeholder:s-dana', 'required'],
    ['stakeholder:s-lena', 'input'],
    ['user:u-matt', 'required'],
  ]);

  // An admin with no role on the topic is listed for the model only once they take part,
  // and comments newer than the previous summary are marked.
  const sources = normalizeSummarySources([
    { actorRef: 'stakeholder:s-dana', actorName: 'Dana W', createdAt: '2026-10-15T00:21:00.000Z', ref: 'C1', text: 'Business approval comes after our own testing.' },
    { actorRef: 'user:u-rosa', actorName: 'Rosa O', createdAt: '2026-10-19T20:13:06.000Z', ref: 'C2', text: 'All blockers are resolved.' },
  ]);
  const maps = buildSummaryRefMaps(sources, roles);
  const input = buildSummaryModelInput({ maps, previous: { createdAt: '2026-10-15T00:22:00.000Z', output: emptySummaryOutput() }, scopeType: 'topic', sources });
  assert.deepEqual(input.untrustedContent.people.map((person) => [person.name, person.standing, person.projectRole ?? null]), [
    ['Dana W', 'required', null],
    ['Rosa O', 'owner', 'admin'],
    ['Lena E', 'input', null],
  ]);
  assert.deepEqual(input.untrustedContent.sources.map((source) => [source.ref, source.newSincePreviousSummary ?? false]), [['C1', false], ['C2', true]]);
});

test('the proposed answer status stays consistent with the answer and the number of people', () => {
  // A required person's or admin's answer is theirs to give, alone or not.
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, loneAuthority: true, proposedAnswer: 'x', status: 'authority-answered' }), 'authority-answered');
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, loneAuthority: true, proposedAnswer: 'x', status: 'awaiting-confirmation' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ contributors: 3, hasAuthority: true, proposedAnswer: 'x', status: 'authority-answered' }), 'authority-answered');
  assert.equal(resolveProposedAnswerStatus({ contributors: 3, hasAuthority: false, proposedAnswer: 'x', status: 'authority-answered' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: '', status: 'agreed' }), 'none');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Yes.', status: 'agreed' }), 'agreed');
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, proposedAnswer: 'Yes.', status: 'agreed' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, proposedAnswer: 'Yes.', status: 'owner-answered' }), 'awaiting-confirmation');
  // A lone owner nobody has challenged answers the question, unless the model held the answer back.
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, loneOwner: true, proposedAnswer: 'Yes.', status: 'agreed' }), 'owner-answered');
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, loneOwner: true, proposedAnswer: 'Yes.', status: 'owner-answered' }), 'owner-answered');
  assert.equal(resolveProposedAnswerStatus({ contributors: 1, loneOwner: true, proposedAnswer: 'Yes, once finance confirms.', status: 'awaiting-confirmation' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ contributors: 3, proposedAnswer: 'Yes.', status: 'owner-answered' }), 'owner-answered');
  assert.equal(resolveProposedAnswerStatus({ contributors: 3, hasOwner: false, proposedAnswer: 'Yes.', status: 'owner-answered' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Yes.', status: 'none' }), 'awaiting-confirmation');
  assert.equal(resolveProposedAnswerStatus({ proposedAnswer: 'Yes.' }), 'agreed', 'runs stored before the status existed read as agreed');
});

test('presented outstanding items carry their sources and who they wait on; the portal sees names only', () => {
  const output = {
    ...emptySummaryOutput(),
    outstanding: [{ blocking: true, item: 'Confirm the fee change', sources: ['comment:c1'], suggestedOwnerRole: 'Delivery team', waitingOn: ['user:u1'] }],
    proposedAnswer: 'No per-EIN fee.',
    proposedAnswerStatus: 'awaiting-confirmation',
  };
  const names = new Map([['user:u1', 'Matt T']]);
  const team = presentSummaryOutput(output, { audience: 'team', names });
  assert.deepEqual(team.outstanding, [{ blocking: true, item: 'Confirm the fee change', sources: ['comment:c1'], suggestedOwnerRole: 'Delivery team', waitingOn: ['user:u1'], waitingOnNames: ['Matt T'] }]);
  assert.equal(team.proposedAnswerStatus, 'awaiting-confirmation');
  const portal = presentSummaryOutput(output, { audience: 'portal', names });
  assert.deepEqual(portal.outstanding[0].waitingOnNames, ['Matt T']);
  assert.equal('waitingOn' in portal.outstanding[0], false);

  // Runs stored before these fields existed.
  const legacy = presentSummaryOutput({ ...emptySummaryOutput(), outstanding: [{ blocking: false, item: 'Old', suggestedOwnerRole: '' }], proposedAnswer: 'Yes.', proposedAnswerStatus: undefined });
  assert.deepEqual(legacy.outstanding[0].sources, []);
  assert.deepEqual(legacy.outstanding[0].waitingOnNames, []);
  assert.equal(legacy.proposedAnswerStatus, 'agreed');
});

// --- rounds follow their linked topics -------------------------------------------------

function roundDeps({ clarifications = {}, decisions = [], rounds = [], summaries = [] } = {}) {
  const published = [];
  return {
    liveEventBus: { publish(channel, event) { published.push({ channel, event }); } },
    published,
    requirementsRepository: {
      async listAccessLinks() { return []; },
      async listDecisions() { return decisions; },
      async listLatestSummaries() { return summaries; },
      async listTopicStatuses({ topicIds }) { return topicIds.map((id) => clarifications[id]).filter(Boolean); },
    },
    roundsRepository: { async listRounds() { return rounds; } },
  };
}

const QUESTIONS = [
  { id: 'q-decided', prompt: 'What does the UI say about out-of-scope features?', type: 'text' },
  { id: 'q-answered', prompt: 'Which steps pause for approval?', type: 'text' },
  { id: 'q-gone', prompt: 'Where should Price Now appear?', type: 'text' },
  { id: 'q-open', prompt: 'Who uses the phone page?', type: 'text' },
];
const MANIFEST = { sections: [{ items: QUESTIONS, type: 'questions' }] };

test('a round summary reads each linked topic\'s state, proposed answer, and decision', async () => {
  const deps = roundDeps({
    clarifications: {
      't-answered': { id: 't-answered', status: 'open' },
      't-decided': { id: 't-decided', status: 'resolved' },
      't-dismissed': { id: 't-dismissed', status: 'dismissed' },
      't-open': { id: 't-open', status: 'open' },
    },
    decisions: [{ id: 'd1', kind: 'topic', outcome: 'agreed', statement: '<p>Show a short note.</p>', topicId: 't-decided' }],
    summaries: [
      { output: { ...emptySummaryOutput(), proposedAnswer: 'Pause at four approval points.', proposedAnswerStatus: 'awaiting-confirmation' }, scopeId: 't-answered', status: 'ok' },
      { output: emptySummaryOutput({ insufficientInput: true }), scopeId: 't-open', status: 'ok' },
    ],
  });
  const round = { questionTopics: { 'q-answered': 't-answered', 'q-decided': 't-decided', 'q-dismissed': 't-dismissed', 'q-gone': 't-gone', 'q-open': 't-open' } };
  const manifest = { sections: [{ items: [...QUESTIONS, { id: 'q-dismissed', prompt: 'Dismissed question?', type: 'text' }], type: 'questions' }] };
  const linked = await loadLinkedTopics(deps, { manifest, projectId: 'p', round, tenantId: 't' });
  assert.deepEqual(linked, [
    { decision: { outcome: 'agreed', statement: 'Show a short note.' }, question: QUESTIONS[0].prompt, questionId: 'q-decided', state: 'decided' },
    { proposedAnswer: 'Pause at four approval points.', proposedAnswerStatus: 'awaiting-confirmation', question: QUESTIONS[1].prompt, questionId: 'q-answered', state: 'ready' },
    { question: QUESTIONS[2].prompt, questionId: 'q-gone', state: 'removed' },
    { question: QUESTIONS[3].prompt, questionId: 'q-open', state: 'open' },
    { question: 'Dismissed question?', questionId: 'q-dismissed', state: 'removed' },
  ]);
});

test('rounds refresh when a linked topic is decided, removed, or its proposed answer changes', async () => {
  const requested = [];
  const engine = {
    listeners: [],
    registerScope() {},
    requestRefresh(job) { requested.push(`${job.scopeType}:${job.scopeId}`); },
    subscribe(listener) { this.listeners.push(listener); },
  };
  const deps = roundDeps({ rounds: [
    { id: 'r1', questionTopics: { a: 't1', b: 't2' }, status: 'open', track: 'experience' },
    { id: 'r2', questionTopics: { a: 't3' }, status: 'closed', track: 'experience' },
    { id: 'r3', questionTopics: { a: 't3' }, status: 'open', track: 'experience' },
  ] });
  registerRoundSummaryScopes(engine, deps);
  const [listener] = engine.listeners;

  await listener.onTopicActivity({ projectId: 'p', reason: 'decision-recorded', tenantId: 't', topicIds: ['t2'] });
  assert.deepEqual(requested, ['round:r1']);
  assert.deepEqual(deps.published, [], 'a decision does not change what a review asks');
  await listener.onTopicActivity({ projectId: 'p', reason: 'topic-commented', tenantId: 't', topicIds: ['t3'] });
  assert.deepEqual(requested, ['round:r1'], 'a comment refreshes the topic, not the round');
  await listener.onTopicActivity({ projectId: 'p', reason: 'topic-deleted', tenantId: 't', topicIds: ['t3'] });
  assert.deepEqual(requested, ['round:r1', 'round:r2', 'round:r3']);
  // Open reviews of the removed question refetch; a closed round takes no answers anyway.
  assert.deepEqual(deps.published.map(({ channel, event }) => [channel, event.type, event.reason, event.roundId]), [
    ['project:p', 'requirements.rounds.invalidated', 'question-changed', 'r3'],
  ]);
  requested.length = 0;

  const before = { ...emptySummaryOutput(), proposedAnswer: '' };
  const after = { ...emptySummaryOutput(), proposedAnswer: 'Pause at four points.', proposedAnswerStatus: 'agreed' };
  await listener.onSummaryStored({ job: { projectId: 'p', scopeId: 't1', scopeType: 'topic', tenantId: 't' }, previous: { output: before }, summary: { output: after } });
  assert.deepEqual(requested, ['round:r1']);
  await listener.onSummaryStored({ job: { projectId: 'p', scopeId: 't1', scopeType: 'topic', tenantId: 't' }, previous: { output: after }, summary: { output: { ...after, aligned: [{ sources: ['x'], statement: 'y', supporters: [] }] } } });
  assert.equal(requested.length, 1, 'a run that leaves the answer alone does not refresh rounds');

  assert.equal(topicAnswerChanged({ ...after, proposedAnswerStatus: undefined }, after), false, 'a stored run without a status reads as agreed');
  assert.deepEqual(await refreshRoundsLinkedToTopics({ ...deps, requirementsSummaries: engine }, { projectId: 'p', tenantId: 't', topicIds: [] }), []);
  assert.equal(requested.length, 1);
});

test('a recorded decision schedules the topic\'s refresh and reaches engine listeners', async () => {
  const engine = createRequirementsSummaryEngine({
    assistantRepository: {},
    requirementsRepository: {},
    timers: { clear() {}, set() { return 1; } },
  });
  const activity = [];
  engine.subscribe({ onTopicActivity: (payload) => activity.push(payload.reason) });
  engine.noteTopicActivity({ projectId: 'p', reason: 'decision-recorded', tenantId: 't', topicIds: ['t1'] });
  engine.noteTopicActivity({ projectId: 'p', reason: 'topic-created', tenantId: 't', topicIds: ['t3'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.isPending({ projectId: 'p', scopeId: 't1', scopeType: 'topic', tenantId: 't' }), true);
  assert.equal(engine.isPending({ projectId: 'p', scopeId: 't3', scopeType: 'topic', tenantId: 't' }), false);
  assert.deepEqual(activity, ['decision-recorded', 'topic-created']);
  engine.stop();
});

// --- register signals -------------------------------------------------------------------

test('decided and dismissed rows show no outstanding or blocking counts; ready rows sort agreed and unblocked first', () => {
  const summary = { output: { ...emptySummaryOutput(), outstanding: [{ blocking: true, item: 'a' }, { blocking: false, item: 'b' }] } };
  assert.deepEqual(signalCounts(summary, { state: 'ready' }), { aligned: 0, blocking: 1, divergent: 0, outstanding: 2, underExplored: 0 });
  assert.deepEqual(signalCounts(summary, { state: 'decided' }), { aligned: 0, blocking: 0, divergent: 0, outstanding: 0, underExplored: 0 });

  const row = (id, { blocking = 0, state = 'ready', status = 'agreed' } = {}) => ({
    createdAt: `2026-10-1${id}T00:00:00.000Z`,
    id: String(id),
    signals: { blocking },
    state,
    summary: { proposedAnswerStatus: status },
  });
  const rows = [
    row(1, { blocking: 2 }),
    row(2, { status: 'awaiting-confirmation' }),
    row(3, { state: 'open' }),
    row(4),
    row(5, { state: 'decided' }),
  ];
  assert.deepEqual(rows.map(readyRank), [2, 1, 0, 0, 0]);
  assert.deepEqual(sortTopicRows(rows).map((entry) => entry.id), ['4', '2', '1', '3', '5']);
});

test('the MCP decision warnings leave out blocking items once a topic is decided', () => {
  const output = { ...emptySummaryOutput(), outstanding: [{ blocking: true, item: 'a' }] };
  assert.deepEqual(decisionWarnings({ state: 'ready', summary: { output } }), ['1 blocking item still open in the Odin summary.']);
  assert.deepEqual(decisionWarnings({ decision: { id: 'd1', outcome: 'agreed' }, state: 'decided', summary: { output } }), []);
  assert.equal(decisionWarnings({ decision: { id: 'd1', outcome: 'deferred' }, state: 'open', summary: { output } }).length, 1, 'a deferral keeps blockers in view');
});

// --- drafted questions --------------------------------------------------------------------

test('drafted questions carry a recommended default and see recorded decisions', () => {
  assert.equal(draftedTopicRationale({ rationale: 'It sets the checkout copy.', recommendation: 'Show the final price before authorizing.' }),
    'Recommended: Show the final price before authorizing. It sets the checkout copy.');
  assert.equal(draftedTopicRationale({ rationale: 'Why.', recommendation: '' }), 'Why.');
  assert.equal(draftedTopicRationale({ recommendation: 'Default.' }), 'Recommended: Default.');

  const input = JSON.parse(buildDraftQuestionsInput({
    briefLines: [{ label: 'Requirement 1', ref: 'brief:requirements:0', section: 'requirements', text: 'Clients pay online.' }],
    decisions: [{ statement: 'Prior-year filing is in V1.' }],
    track: 'experience',
  }));
  assert.deepEqual(input.untrustedContent.decisions, [{ statement: 'Prior-year filing is in V1.' }]);
});
