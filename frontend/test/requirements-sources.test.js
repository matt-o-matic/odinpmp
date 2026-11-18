import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockingOutstandingCount,
  collectSummarySources,
  commentSourceChip,
  decisionWarning,
  discussionStats,
  hasSummaryFindings,
  normalizeSummaryOutput,
  numberComments,
  outstandingOwnerText,
  proposedAnswerStatusChip,
  resolveActorRef,
  resolveActorRefs,
  resolveSourceRef,
  resolveSourceRefs,
  summaryCardDigest,
} from '../src/lib/requirements/requirements-sources.js';

function comment(id, createdAt, extra = {}) {
  return { actorId: `actor-${id}`, actorType: 'stakeholder', authorName: `Person ${id}`, body: id, children: [], createdAt, id, ...extra };
}

const thread = [
  comment('a', '2026-10-01T10:00:00Z'),
  comment('b', '2026-10-02T10:00:00Z', {
    children: [comment('c', '2026-10-04T10:00:00Z')],
  }),
  comment('odin', '2026-10-03T09:00:00Z', { actorType: 'assistant', authorName: 'Odin' }),
  comment('d', '2026-10-03T10:00:00Z'),
];

test('numberComments labels human comments C1, C2, ... in posting order and keeps thread order', () => {
  const numbering = numberComments(thread);
  assert.deepEqual(numbering.entries.map((entry) => [entry.comment.id, entry.depth, entry.label]), [
    ['a', 0, 'C1'],
    ['b', 0, 'C2'],
    ['c', 1, 'C4'],
    ['odin', 0, ''],
    ['d', 0, 'C3'],
  ]);
  assert.equal(numbering.labelById.get('c'), 'C4');
  assert.equal(numbering.idByLabel.get('C3'), 'd');
  assert.equal(numbering.labelById.has('odin'), false);
});

test('a later reply to an early comment does not renumber anything already posted', () => {
  const before = numberComments(thread);
  const withReply = structuredClone(thread);
  withReply[0].children.push(comment('e', '2026-10-05T10:00:00Z'));
  const after = numberComments(withReply);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(after.labelById.get(id), before.labelById.get(id));
  assert.equal(after.labelById.get('e'), 'C5');
});

test('removed comments keep their number', () => {
  const removed = structuredClone(thread);
  removed[1].deletedAt = '2026-10-06T00:00:00Z';
  assert.equal(numberComments(removed).labelById.get('b'), 'C2');
});

test('comments without timestamps fall back to thread order', () => {
  const numbering = numberComments([{ actorType: 'user', id: 'x' }, { actorType: 'user', id: 'y' }]);
  assert.deepEqual([...numbering.labelById.entries()], [['x', 'C1'], ['y', 'C2']]);
});

test('resolveSourceRef maps comment refs, bare ids, and C-labels to linkable comments', () => {
  const numbering = numberComments(thread);
  assert.deepEqual(resolveSourceRef('comment:d', numbering), { commentId: 'd', kind: 'comment', label: 'C3', linkable: true, ref: 'comment:d' });
  assert.equal(resolveSourceRef('b', numbering).label, 'C2');
  assert.deepEqual(resolveSourceRef('c4', numbering), { commentId: 'c', kind: 'comment', label: 'C4', linkable: true, ref: 'c4' });
});

test('resolveSourceRef labels sources outside the thread without linking them', () => {
  const numbering = numberComments(thread);
  assert.deepEqual(resolveSourceRef('comment:gone', numbering), { commentId: null, kind: 'comment', label: 'Earlier comment', linkable: false, ref: 'comment:gone' });
  assert.equal(resolveSourceRef('brief:requirements:1', numbering).label, 'Requirement 2');
  assert.equal(resolveSourceRef('annotation:a2', numbering).label, 'Annotation');
  assert.equal(resolveSourceRef('round-answer:q1', numbering).linkable, false);
  assert.equal(resolveSourceRef('', numbering), null);
  assert.equal(resolveSourceRef('comment:a').linkable, false);
});

test('resolveSourceRefs drops blanks and duplicates', () => {
  const numbering = numberComments(thread);
  assert.deepEqual(resolveSourceRefs(['comment:a', '', 'comment:a', 'comment:b'], numbering).map((source) => source.label), ['C1', 'C2']);
});

const output = {
  aligned: [
    { sources: ['comment:b', 'comment:c'], statement: 'Never surprise clients.', supporters: ['stakeholder:actor-a'] },
    { sources: [], statement: '' },
  ],
  divergent: [{ issue: 'When price appears.', positions: [{ sources: ['comment:a'] }, { sources: ['comment:b', 'annotation:a2'] }] }],
  insufficientInput: false,
  outstanding: [{ blocking: true, item: 'Finance wording.' }, { blocking: false, item: 'Noor has not answered.' }, { item: '' }],
  proposedAnswer: '  Show a range.  ',
  underExplored: [{ area: 'Range calculation', suggestedQuestion: 'How?' }],
};

test('normalizeSummaryOutput drops empty entries and trims the proposed answer', () => {
  const normalized = normalizeSummaryOutput(output);
  assert.equal(normalized.aligned.length, 1);
  assert.equal(normalized.outstanding.length, 2);
  assert.equal(normalized.proposedAnswer, 'Show a range.');
  assert.equal(hasSummaryFindings(normalized), true);
  assert.equal(hasSummaryFindings(normalizeSummaryOutput(null)), false);
  assert.equal(normalizeSummaryOutput({ insufficientInput: true }).insufficientInput, true);
});

test('normalizeSummaryOutput fills outstanding sources, who they wait on, and the answer status for older summaries', () => {
  const normalized = normalizeSummaryOutput(output);
  assert.deepEqual(normalized.outstanding[0], {
    blocking: true,
    item: 'Finance wording.',
    sources: [],
    suggestedOwnerRole: '',
    waitingOn: [],
    waitingOnNames: [],
  });
  assert.equal(normalized.outstanding[1].blocking, false);
  // Stored before the status existed, with an answer: agreed.
  assert.equal(normalized.proposedAnswerStatus, 'agreed');
  assert.equal(normalizeSummaryOutput(null).proposedAnswerStatus, 'none');
  assert.equal(normalizeSummaryOutput({ proposedAnswer: 'x', proposedAnswerStatus: 'awaiting-confirmation' }).proposedAnswerStatus, 'awaiting-confirmation');
  assert.equal(normalizeSummaryOutput({ proposedAnswer: ' ', proposedAnswerStatus: 'agreed' }).proposedAnswerStatus, 'none');

  const current = normalizeSummaryOutput({
    outstanding: [{
      blocking: true,
      item: 'Finance confirms the deposit wording.',
      sources: ['comment:a'],
      suggestedOwnerRole: 'Finance',
      waitingOn: ['stakeholder:actor-b'],
      waitingOnNames: ['Ravi Shah'],
    }],
  });
  assert.deepEqual(current.outstanding[0].sources, ['comment:a']);
  assert.deepEqual(current.outstanding[0].waitingOnNames, ['Ravi Shah']);
});

test('proposed-answer status chips: agreed is ready to record only while nothing blocks', () => {
  assert.deepEqual(proposedAnswerStatusChip('agreed'), { label: 'Agreed, ready to record', status: 'agreed', tone: 'ok' });
  assert.deepEqual(proposedAnswerStatusChip('agreed', { blocking: 2 }), { label: 'Agreed', status: 'agreed', tone: 'ok' });
  assert.deepEqual(proposedAnswerStatusChip('owner-answered'), { label: 'Owner’s answer, ready to record', status: 'owner-answered', tone: 'ok' });
  assert.deepEqual(proposedAnswerStatusChip('owner-answered', { blocking: 1 }), { label: 'Owner’s answer', status: 'owner-answered', tone: 'ok' });
  assert.deepEqual(proposedAnswerStatusChip('authority-answered'), { label: 'Required answer, ready to record', status: 'authority-answered', tone: 'ok' });
  assert.deepEqual(proposedAnswerStatusChip('authority-answered', { blocking: 1 }), { label: 'Required answer', status: 'authority-answered', tone: 'ok' });
  assert.deepEqual(proposedAnswerStatusChip('awaiting-confirmation', { blocking: 1 }), {
    label: 'One person’s answer, awaiting confirmation',
    status: 'awaiting-confirmation',
    tone: 'warn',
  });
  assert.equal(proposedAnswerStatusChip('none'), null);
  assert.equal(proposedAnswerStatusChip(undefined), null);
});

test('outstanding items say whose move it is: the people waited on, else the role', () => {
  assert.equal(outstandingOwnerText({ names: ['Ravi Shah'], role: 'Finance' }), 'Waiting on Ravi Shah');
  assert.equal(outstandingOwnerText({ names: ['Ravi Shah', 'Noor Ali', 'Ravi Shah'] }), 'Waiting on Ravi Shah and Noor Ali');
  assert.equal(outstandingOwnerText({ names: ['A', 'B', 'C'] }), 'Waiting on A, B, and C');
  assert.equal(outstandingOwnerText({ names: [' '], role: 'Finance' }), 'for Finance');
  assert.equal(outstandingOwnerText({}), '');
});

test('collectSummarySources gathers aligned and diverging citations in first-cited order', () => {
  assert.deepEqual(collectSummarySources(output), ['comment:b', 'comment:c', 'comment:a', 'annotation:a2']);
  assert.deepEqual(collectSummarySources(null), []);
});

test('a decision from the owner\'s lone answer attaches the comment the answer rests on', () => {
  const ownerAnswer = {
    aligned: [],
    divergent: [],
    outstanding: [],
    proposedAnswer: 'Put the code field on the payment step.',
    proposedAnswerSources: ['comment:o1'],
    proposedAnswerStatus: 'owner-answered',
  };
  assert.deepEqual(collectSummarySources(ownerAnswer), ['comment:o1']);
  assert.equal(normalizeSummaryOutput(ownerAnswer).proposedAnswerStatus, 'owner-answered');
  // Sources without an answer are ignored.
  assert.deepEqual(collectSummarySources({ ...ownerAnswer, proposedAnswer: '' }), []);
});

test('blocking items drive the decision warning', () => {
  assert.equal(blockingOutstandingCount(output), 1);
  assert.equal(decisionWarning(output), '1 blocking item still open');
  assert.equal(decisionWarning({ outstanding: [{ blocking: true, item: 'x' }, { blocking: true, item: 'y' }] }), '2 blocking items still open');
  assert.equal(decisionWarning({ outstanding: [] }), '');
  // A topic that already has a decision is not held up by them.
  assert.equal(decisionWarning(output, { decided: true }), '');
});

test('decisions attach aligned and diverging sources only, not outstanding ones', () => {
  const withOutstanding = { ...output, outstanding: [{ blocking: true, item: 'Finance wording.', sources: ['comment:d'] }] };
  assert.deepEqual(collectSummarySources(withOutstanding), ['comment:b', 'comment:c', 'comment:a', 'annotation:a2']);
});

test('resolveActorRef prefers members, then stakeholders, then comment authors', () => {
  const context = {
    comments: thread,
    stakeholders: [{ id: 'actor-b', name: 'Ravi Shah' }],
    users: [{ id: 'u1', name: 'Alex Kim' }],
  };
  assert.equal(resolveActorRef('user:u1', context).name, 'Alex Kim');
  assert.equal(resolveActorRef('user:u1', context).initials, 'AK');
  assert.equal(resolveActorRef('stakeholder:actor-b', context).name, 'Ravi Shah');
  assert.equal(resolveActorRef('stakeholder:actor-c', context).name, 'Person c');
  assert.equal(resolveActorRef('stakeholder:unknown', context).name, 'Stakeholder');
  assert.equal(resolveActorRef('', context), null);
  assert.deepEqual(resolveActorRefs(['user:u1', 'user:u1', 'stakeholder:actor-b'], context).map((person) => person.name), ['Alex Kim', 'Ravi Shah']);
});

test('comment source chips and discussion stats', () => {
  assert.equal(commentSourceChip('email-reply').label, 'Email reply');
  assert.equal(commentSourceChip('round-answer').label, 'Round answer');
  assert.equal(commentSourceChip('comment'), null);
  assert.deepEqual(discussionStats(thread), { contributions: 4, people: 4 });
});

test('register cards show the proposed answer and the first entries of each summary group', () => {
  const summary = {
    id: 's1',
    output: {
      aligned: [{ statement: 'Show the fee first' }, { statement: 'Use one screen' }, { statement: 'Keep the logo' }],
      divergent: [{ issue: 'Who signs', positions: [] }, { issue: '', positions: [{ summary: 'x' }] }],
      insufficientInput: false,
      outstanding: [{ blocking: true, item: 'Legal wording' }],
      proposedAnswer: 'A fee summary, then authorize.',
      underExplored: [{ area: 'Refunds' }],
    },
  };
  assert.deepEqual(summaryCardDigest(summary), {
    groups: [
      { items: [{ text: 'Show the fee first' }, { text: 'Use one screen' }], key: 'aligned', label: 'Aligned', more: 1 },
      { items: [{ text: 'Who signs' }, { text: 'Positions differ' }], key: 'divergent', label: 'Diverging', more: 0 },
      { items: [{ blocking: true, text: 'Legal wording' }], key: 'outstanding', label: 'Outstanding', more: 0 },
    ],
    kind: 'summary',
    proposedAnswer: 'A fee summary, then authorize.',
    proposedAnswerStatus: 'agreed',
  });
  assert.deepEqual(summaryCardDigest(null), { kind: 'none' });
  assert.deepEqual(summaryCardDigest({ id: 's2', insufficientInput: true, proposedAnswer: '' }), { kind: 'thin' });
  assert.deepEqual(summaryCardDigest({ id: 's3', output: { aligned: [], proposedAnswer: '' } }), { kind: 'empty' });
  // A list row without include=summaries still shows its short proposed answer and status.
  assert.deepEqual(
    summaryCardDigest({ id: 's4', insufficientInput: false, proposedAnswer: 'Short form', proposedAnswerStatus: 'awaiting-confirmation' }),
    { groups: [], kind: 'summary', proposedAnswer: 'Short form', proposedAnswerStatus: 'awaiting-confirmation' },
  );
});

test('a settled topic card drops its outstanding items and answer status', () => {
  const summary = {
    id: 's1',
    output: {
      aligned: [{ statement: 'Show the fee first' }],
      outstanding: [{ blocking: true, item: 'Legal wording' }],
      proposedAnswer: 'A fee summary.',
      proposedAnswerStatus: 'agreed',
    },
  };
  assert.deepEqual(summaryCardDigest(summary, { settled: true }), {
    groups: [{ items: [{ text: 'Show the fee first' }], key: 'aligned', label: 'Aligned', more: 0 }],
    kind: 'summary',
    proposedAnswer: 'A fee summary.',
    proposedAnswerStatus: 'none',
  });
});

test('feedback themes count as findings and keep their sources', () => {
  const normalized = normalizeSummaryOutput({ feedbackThemes: [{ detail: ' Too bright. ', sources: ['annotation:a1'], theme: ' Color ' }, { theme: ' ' }] });
  assert.deepEqual(normalized.feedbackThemes, [{ detail: 'Too bright.', sources: ['annotation:a1'], theme: 'Color' }]);
  assert.equal(hasSummaryFindings(normalized), true);
  assert.deepEqual(normalizeSummaryOutput(null).feedbackThemes, []);
});
