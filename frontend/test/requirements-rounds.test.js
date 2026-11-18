import assert from 'node:assert/strict';
import test from 'node:test';

import {
  askInNextRoundText,
  availableOutcomes,
  buildDirectionPreference,
  buildReviewerCandidates,
  buildVerdictGrid,
  closeFormError,
  closePayload,
  closedTopicsText,
  feedbackAnchor,
  feedbackTarget,
  groupRoundFeedback,
  roundFeedbackPeople,
  defaultCloseStatement,
  describePublishError,
  describeTally,
  fromDateTimeInputValue,
  mailStatus,
  nextRoundNumber,
  openRoundOf,
  proposalsForRound,
  publishFormErrors,
  publishPayload,
  publishResultLines,
  publishSummaryLine,
  questionRows,
  reviewerCounts,
  reviewerStatus,
  roundMetaLine,
  roundPatch,
  roundSourceChips,
  roundStatusChip,
  screenAgreement,
  sortRounds,
  submittedText,
  toDateTimeInputValue,
  markExcerpt,
  markPeople,
  markSurface,
} from '../src/lib/requirements/requirements-rounds.js';

const reviewers = [
  { actorRef: 'stakeholder:jamie', actorType: 'stakeholder', id: 'r1', name: 'Jamie Ortiz', required: true, submittedAt: '2026-10-06T10:00:00Z' },
  { actorRef: 'stakeholder:ravi', actorType: 'stakeholder', id: 'r2', name: 'Ravi Shah', required: true, submittedAt: null, progress: { done: 3, total: 9 } },
  { actorRef: 'user:alex', actorType: 'user', id: 'r3', name: 'Alex Kim', required: false, submittedAt: '2026-10-06T11:00:00Z' },
  { actorRef: 'user:sam', actorType: 'user', id: 'r4', name: 'Sam Patel', required: false, submittedAt: null },
  { actorRef: 'user:gone', actorType: 'user', id: 'r5', name: 'Gone Person', removedAt: '2026-10-05T00:00:00Z', required: true, submittedAt: null },
];

const results = {
  annotationCounts: { home: { total: 6 }, flow: { total: 1 } },
  directions: [
    {
      directionId: 'a', remixNotes: [{ actorRef: 'stakeholder:ravi', name: 'Ravi Shah', remix: "Keep B's calendar" }], stances: [
        { actorRef: 'stakeholder:jamie', name: 'Jamie Ortiz', stance: 'preferred' },
        { actorRef: 'stakeholder:ravi', name: 'Ravi Shah', remix: "Keep B's calendar", stance: 'acceptable' },
      ], tallies: { acceptable: 1, preferred: 1, rejected: 0 }, title: 'Action first',
    },
    {
      directionId: 'b', remixNotes: [], stances: [
        { actorRef: 'user:alex', name: 'Alex Kim', stance: 'preferred' },
        { actorRef: 'stakeholder:ravi', name: 'Ravi Shah', stance: 'rejected' },
      ], tallies: { acceptable: 0, preferred: 1, rejected: 1 }, title: 'Schedule first',
    },
  ],
  grid: [
    { actorRef: 'stakeholder:jamie', name: 'Jamie Ortiz', verdicts: { flow: { overall: 'keep' }, home: { overall: 'keep', stay: 'The action.' } } },
    { actorRef: 'stakeholder:ravi', name: 'Ravi Shah', verdicts: { home: { overall: 'keep-with-changes' } } },
    { actorRef: 'user:alex', name: 'Alex Kim', verdicts: { flow: { overall: 'undecided' }, home: { overall: 'keep' } } },
    { actorRef: 'user:sam', name: 'Sam Patel', verdicts: {} },
    { actorRef: 'user:gone', name: 'Gone Person', verdicts: { home: { overall: 'change' } } },
  ],
  questions: [
    { answers: [{ actorRef: 'stakeholder:jamie', name: 'Jamie Ortiz', text: 'After a time' }], kind: 'single', prompt: 'Where does the price go?', questionId: 'q1', topicId: 't1' },
  ],
  reviewers,
  screens: [{ kind: 'image', screenId: 'home', title: 'Booking home' }, { kind: 'prototype', screenId: 'flow', title: 'Booking flow' }],
};

test('the verdict grid marks a missing verdict Not reviewed and never counts it', () => {
  const grid = buildVerdictGrid(results);
  assert.deepEqual(grid.columns.map((column) => column.screenId), ['home', 'flow']);
  assert.deepEqual(grid.rows.map((row) => row.name), ['Jamie Ortiz', 'Ravi Shah', 'Alex Kim', 'Sam Patel', 'Gone Person']);

  const sam = grid.rows.find((row) => row.actorRef === 'user:sam');
  assert.deepEqual(sam.cells.map((cell) => [cell.value, cell.notReviewed, cell.label, cell.short]), [
    [null, true, 'Not reviewed', '—'],
    [null, true, 'Not reviewed', '—'],
  ]);
  const ravi = grid.rows.find((row) => row.actorRef === 'stakeholder:ravi');
  assert.equal(ravi.cells[0].short, 'KEEP+');
  assert.equal(ravi.cells[0].label, 'Keep with changes');
  assert.equal(ravi.required, true);
  assert.equal(grid.rows.find((row) => row.actorRef === 'user:gone').removed, true);

  const [home, flow] = grid.columns;
  assert.deepEqual(home.tally, { change: 1, keep: 2, 'keep-with-changes': 1, notReviewed: 1, reviewed: 4, undecided: 0 });
  assert.equal(home.marksText, '6 marks');
  assert.equal(flow.marksText, '1 mark');
  assert.deepEqual(flow.tally, { change: 0, keep: 1, 'keep-with-changes': 0, notReviewed: 3, reviewed: 2, undecided: 1 });
  assert.equal(describeTally(flow.tally), '1 keep · 1 undecided · 3 not reviewed');
  // Not reviewed blocks agreement even when every verdict given is the same.
  assert.equal(home.agreement, null);
  assert.equal(screenAgreement({ change: 0, keep: 2, 'keep-with-changes': 0, notReviewed: 1, reviewed: 2, undecided: 0 }), null);
  assert.equal(screenAgreement({ change: 0, keep: 3, 'keep-with-changes': 0, notReviewed: 0, reviewed: 3, undecided: 0 }), 'keep');
  assert.equal(screenAgreement({ change: 0, keep: 0, 'keep-with-changes': 0, notReviewed: 0, reviewed: 0, undecided: 0 }), null);
});

test('an unknown verdict value is Not reviewed, and a grid without rows falls back to active reviewers', () => {
  const grid = buildVerdictGrid({ ...results, grid: [{ actorRef: 'user:alex', name: 'Alex Kim', verdicts: { home: { overall: 'maybe' } } }] });
  assert.equal(grid.rows[0].cells[0].notReviewed, true);
  const fallback = buildVerdictGrid({ ...results, grid: [] });
  assert.deepEqual(fallback.rows.map((row) => row.actorRef), ['stakeholder:jamie', 'stakeholder:ravi', 'user:alex', 'user:sam']);
  assert.ok(fallback.rows.every((row) => row.cells.every((cell) => cell.notReviewed)));
  assert.deepEqual(buildVerdictGrid({}), { columns: [], rows: [] });
});

test('direction tallies count preferences, no preference, and not answered separately', () => {
  const preference = buildDirectionPreference(results);
  assert.equal(preference.total, 4, 'removed reviewers are left out');
  assert.equal(preference.answered, 3);
  assert.equal(preference.answeredText, '3 of 4 answered');
  assert.equal(preference.noPreference, 1, 'Ravi answered but preferred nothing');
  assert.equal(preference.notAnswered, 1, 'Sam gave no stance');
  assert.deepEqual(preference.segments.map((segment) => [segment.kind, segment.label, segment.count, segment.percent]), [
    ['direction', 'A · Action first · 1', 1, 25],
    ['direction', 'B · Schedule first · 1', 1, 25],
    ['none', 'No preference · 1', 1, 25],
    ['unanswered', 'Not answered · 1', 1, 25],
  ]);
  assert.deepEqual(preference.rows.map((row) => [row.letter, row.talliesText]), [
    ['A', '1 preferred · 1 acceptable · 0 rejected'],
    ['B', '1 preferred · 0 acceptable · 1 rejected'],
  ]);
  assert.deepEqual(preference.rows[0].remixNotes, [{ name: 'Ravi Shah', remix: "Keep B's calendar" }]);
  assert.deepEqual(buildDirectionPreference({}).segments, []);
});

test('reviewer counts leave removed reviewers out, and statuses read clearly', () => {
  const counts = reviewerCounts(reviewers);
  assert.equal(counts.total, 4);
  assert.equal(counts.submitted, 2);
  assert.equal(counts.required, 2);
  assert.equal(counts.requiredSubmitted, 1);
  assert.deepEqual(counts.notSubmitted.map((entry) => entry.name), ['Ravi Shah', 'Sam Patel']);
  assert.equal(submittedText(counts), '2 of 4 submitted');

  assert.equal(reviewerStatus(reviewers[0]).label, 'Submitted');
  assert.equal(reviewerStatus(reviewers[1]).label, 'In progress · 3 of 9');
  assert.equal(reviewerStatus(reviewers[3]).label, 'Not started');
  assert.equal(reviewerStatus({ lastSeenAt: '2026-10-06T00:00:00Z' }).label, 'Opened, nothing given yet');
  assert.equal(reviewerStatus(reviewers[4]).label, 'Removed');

  assert.deepEqual(mailStatus({ status: 'sent' }), { label: 'Invitation sent', problem: false, tone: 'ok' });
  assert.deepEqual(mailStatus({ status: 'queued' }), { label: 'Invitation queued', problem: false, tone: 'neutral' });
  assert.deepEqual(mailStatus({ reason: 'delivery-failed', status: 'failed' }), { label: 'Email failed: the email bounced', problem: true, tone: 'bad' });
  assert.deepEqual(mailStatus({ reason: 'no-email', status: 'not-sent' }), { label: 'Not sent: no email address on file', problem: true, tone: 'warn' });
  assert.equal(mailStatus(null).label, 'Not sent');
});

test('the publish summary line counts external reviewers and members', () => {
  assert.equal(publishSummaryLine({ externalCount: 3, memberCount: 2 }), 'Publishing emails 3 external reviewers and notifies 2 members.');
  assert.equal(publishSummaryLine({ externalCount: 1, memberCount: 1 }), 'Publishing emails 1 external reviewer and notifies 1 member.');
  assert.equal(publishSummaryLine({ externalCount: 0, memberCount: 2 }), 'Publishing notifies 2 members.');
  assert.equal(publishSummaryLine({ externalCount: 2, memberCount: 0 }), 'Publishing emails 2 external reviewers.');
  assert.equal(publishSummaryLine({}), 'Choose at least one reviewer.');
});

test('reviewer candidates: externals first, viewers left out, revoked links flagged', () => {
  const candidates = buildReviewerCandidates({
    links: [{ revokedAt: '2026-10-01T00:00:00Z', stakeholder: { id: 's2' }, status: 'revoked' }],
    stakeholders: [{ email: 'b@client.example', id: 's2', name: 'Bea Stone' }, { email: 'a@client.example', id: 's1', name: 'Ann Lake' }],
    users: [
      { id: 'u2', name: 'Zed Member', role: 'member' },
      { id: 'u1', name: 'Amy Admin', role: 'admin' },
      { id: 'u3', name: 'Vic Viewer', role: 'viewer' },
      { id: 'u1', name: 'Amy Admin', role: 'admin' },
    ],
  });
  assert.deepEqual(candidates.map((entry) => [entry.key, entry.kindLabel, entry.linkRevoked]), [
    ['stakeholder:s1', 'external · link', false],
    ['stakeholder:s2', 'external · link', true],
    ['user:u1', 'admin', false],
    ['user:u2', 'member', false],
  ]);
});

test('publish form checks and payload', () => {
  const now = new Date(2026, 9, 7, 12, 0);
  assert.deepEqual(publishFormErrors({ due: '2026-10-14T17:00', now, reminder: '2', selected: [{}] }), {});
  assert.deepEqual(Object.keys(publishFormErrors({ due: '', now, reminder: '2', selected: [] })), ['reviewers', 'reminder']);
  assert.equal(publishFormErrors({ due: '2026-10-01T09:00', now, selected: [{}] }).due, 'Choose a due date in the future.');
  assert.equal(publishFormErrors({ due: 'soon', now, selected: [{}] }).due, 'Enter a due date and time.');

  const payload = publishPayload({
    due: '2026-10-14T17:00', note: '  Focus on price.  ', packageId: 'p3', reminder: '2',
    selected: [{ actorId: 's1', actorType: 'stakeholder', key: 'stakeholder:s1', required: true }, { actorId: 'u1', actorType: 'user', key: 'user:u1' }],
  });
  assert.equal(payload.dueAt, new Date(2026, 9, 14, 17, 0).toISOString());
  assert.deepEqual(payload.reminder, { daysBefore: 2 });
  assert.equal(payload.note, 'Focus on price.');
  assert.deepEqual(payload.reviewers, [{ actorId: 's1', actorType: 'stakeholder', required: true }, { actorId: 'u1', actorType: 'user', required: false }]);
  assert.equal('closePrevious' in payload, false);
  const noDue = publishPayload({ due: '', packageId: 'p3', reminder: '2', selected: [] });
  assert.equal(noDue.dueAt, null);
  assert.equal(noDue.reminder, null, 'a reminder never goes without a due date');
  assert.deepEqual(publishPayload({ closePrevious: { outcome: 'abandoned' }, packageId: 'p3' }).closePrevious, { outcome: 'abandoned' });

  assert.equal(toDateTimeInputValue(new Date(2026, 0, 2, 3, 4)), '2026-01-02T03:04');
  assert.equal(fromDateTimeInputValue('2026-01-02T03:04'), new Date(2026, 0, 2, 3, 4).toISOString());
  assert.equal(fromDateTimeInputValue('not a date'), '');
});

function apiError(status, data) {
  return Object.assign(new Error(data.error), { data, status });
}

test('publish errors: round open, missing question topic, invalid reviewer, not a draft', () => {
  const open = apiError(409, { details: { code: 'round_open', openRoundId: 'round-2', openRoundNumber: 2 }, error: 'A round is already open.' });
  const forDecider = describePublishError(open, { canDecide: true });
  assert.equal(forDecider.code, 'round_open');
  assert.deepEqual(forDecider.openRound, { id: 'round-2', number: 2 });
  assert.match(forDecider.message, /^Round 2 is still open for this track\. Close it first/);
  assert.match(describePublishError(open, { canDecide: false }).message, /An admin or manager has to close it/);

  const missing = describePublishError(apiError(409, { details: { code: 'question_topic_missing', questionIds: ['q1', 'q2'] }, error: 'x' }));
  assert.match(missing.message, /^Some questions in this package link to a topic that was deleted or belongs to the other track \(q1, q2\)/);

  const invalid = describePublishError(
    apiError(400, { details: { actorId: 's1', code: 'reviewer_invalid' }, error: 'x' }),
    { candidates: [{ actorId: 's1', external: true, name: 'Ann Lake' }] },
  );
  assert.match(invalid.message, /^Ann Lake can’t review this round: they are no longer a stakeholder/);
  assert.match(describePublishError(apiError(400, { details: { code: 'reviewer_invalid' }, error: 'x' })).message, /Reload the page/);

  assert.match(describePublishError(apiError(409, { details: { code: 'package_not_draft' }, error: 'x' })).message, /already published or withdrawn/);
  assert.equal(describePublishError(apiError(500, { error: 'Boom' })), null);
});

test('publish result lines: invitations, mail problems, carry-forward, and created topics', () => {
  const lines = publishResultLines({
    carryForward: { carried: 2, outdated: 5, superseded: 1 },
    createdTopicIds: ['t1', 't2'],
    round: { reviewers: [
      { actorType: 'stakeholder', mail: { status: 'queued' }, name: 'Ann Lake' },
      { actorType: 'stakeholder', mail: { reason: 'no-email', status: 'not-sent' }, name: 'Bea Stone' },
      { actorType: 'user', mail: { status: 'queued' }, name: 'Amy Admin' },
    ] },
  });
  assert.deepEqual(lines, [
    'Invited 2 external reviewers and 1 member.',
    'Not emailed: Bea Stone (no email address on file). Resend from the round once it’s fixed.',
    'From the previous round: 2 annotations carried forward, 5 outdated, 1 superseded.',
    '2 new topics created for package questions.',
  ]);
  assert.deepEqual(publishResultLines({ carryForward: { carried: 0, outdated: 0, superseded: 0 } }), ['No annotations from a previous round to carry forward.']);
});

test('closing a round: outcomes, validation, payload, and the default statement', () => {
  assert.deepEqual(availableOutcomes([]).map((entry) => entry.key), ['screens-accepted', 'changes-requested', 'abandoned']);
  assert.equal(availableOutcomes([{ directionId: 'a' }]).length, 4);
  assert.equal(closeFormError({ outcome: '' }), 'Choose how the round ends.');
  assert.equal(closeFormError({ outcome: 'direction-chosen' }), 'Choose the direction that goes forward.');
  assert.equal(closeFormError({ directionId: 'a', outcome: 'direction-chosen' }), '');
  assert.deepEqual(closePayload({ directionId: 'a', outcome: 'screens-accepted', statement: ' ' }), { directionId: '', outcome: 'screens-accepted', statement: '' });
  assert.deepEqual(closePayload({ directionId: 'a', outcome: 'direction-chosen', statement: 'Go with A.' }), { directionId: 'a', outcome: 'direction-chosen', statement: 'Go with A.' });
  // What closing did to the round's questions.
  assert.equal(closedTopicsText({ decided: 3, deferred: 1 }), ' 3 questions decided from Odin’s answers, 1 deferred.');
  assert.equal(closedTopicsText({ decided: 1 }), ' 1 question decided from Odin’s answers.');
  assert.equal(closedTopicsText({ deferred: 2 }), ' 2 questions deferred.');
  assert.equal(closedTopicsText({}), '');
  assert.equal(closedTopicsText(undefined), '');
  assert.equal(defaultCloseStatement({ directionTitle: 'Action first', number: 2, outcome: 'direction-chosen' }), 'Round 2: Direction chosen: Action first.');
  assert.equal(defaultCloseStatement({ number: 3, outcome: 'abandoned' }), 'Round 3: Round abandoned.');
});

test('round list order, numbers, status chips, and meta lines', () => {
  const now = new Date(2026, 9, 7, 12, 0);
  const rounds = [
    { id: 'r1', number: 1, status: 'closed' },
    { id: 'r3', number: 3, status: 'closed' },
    { id: 'r2', number: 2, status: 'open' },
  ];
  assert.deepEqual(sortRounds(rounds).map((round) => round.id), ['r2', 'r3', 'r1']);
  assert.equal(nextRoundNumber(rounds), 4);
  assert.equal(nextRoundNumber([]), 1);
  assert.equal(openRoundOf(rounds).id, 'r2');

  assert.deepEqual(roundStatusChip({ dueAt: new Date(2026, 9, 10, 17).toISOString(), status: 'open' }, { locale: 'en-US', now }), { label: 'Open · closes Sat, Oct 10', tone: 'solid' });
  assert.deepEqual(roundStatusChip({ dueAt: new Date(2026, 9, 1).toISOString(), status: 'open' }, { locale: 'en-US', now }), { label: 'Open · was due Thu, Oct 1', tone: 'warn' });
  assert.deepEqual(roundStatusChip({ status: 'open' }), { label: 'Open · no due date', tone: 'solid' });
  assert.deepEqual(roundStatusChip({ outcome: 'screens-accepted', status: 'closed' }), { label: 'Closed · Screens accepted', tone: 'neutral' });

  assert.equal(
    roundMetaLine({ counts: { reviewers: 5, submitted: 3 }, dueAt: new Date(2026, 9, 10, 17).toISOString(), packageVersion: 2, status: 'open' }, { locale: 'en-US' }),
    'package v2 · 3 of 5 submitted · due Sat, Oct 10',
  );
});

test('summary source chips name annotations, comments, and the people behind verdicts', () => {
  const lookup = [
    { available: true, kind: 'annotation', label: '#3', ref: 'annotation:a3', screenId: 'home' },
    { available: true, kind: 'comment', label: 'C2', ref: 'comment:c2', screenId: 'home' },
    { actorRef: 'stakeholder:jamie', available: true, kind: 'verdict', label: 'V1', ref: 'verdict:v1', screenId: 'home' },
    { actorRef: 'user:alex', available: true, kind: 'direction', label: 'D1', ref: 'verdict:d1' },
    { actorRef: 'stakeholder:ravi', available: true, kind: 'answer', label: 'Q1', ref: 'answer:q1' },
    { available: false, kind: 'annotation', label: null, ref: 'annotation:gone' },
  ];
  const people = new Map([['stakeholder:jamie', 'Jamie Ortiz'], ['user:alex', 'Alex Kim'], ['stakeholder:ravi', 'Ravi Shah']]);
  const chips = roundSourceChips(
    ['annotation:a3', 'comment:c2', 'verdict:v1', 'verdict:d1', 'answer:q1', 'annotation:gone', 'annotation:a3', 'unknown:x'],
    { lookup, people, screenTitles: { home: 'Booking home' } },
  );
  assert.deepEqual(chips.map((chip) => [chip.label, chip.ariaLabel]), [
    ['#3', 'Annotation 3 on Booking home'],
    ['C2', 'Annotation comment C2 on Booking home'],
    ['V-JO', 'Verdict by Jamie Ortiz on Booking home'],
    ['D-AK', 'Direction choice by Alex Kim'],
    ['Q-RS', 'Answer by Ravi Shah'],
    ['Removed', 'Source no longer available'],
    ['Removed', 'Source no longer available'],
  ]);
  assert.equal(roundSourceChips(['annotation:a3'], { lookup, people, screenTitles: { home: 'Booking home' }, showScreen: true })[0].label, 'Booking home #3');
});

test('questions list answers and the reviewers who have not answered', () => {
  const [row] = questionRows(results);
  assert.equal(row.answersText, '1 of 4 answered');
  assert.deepEqual(row.missing, ['Ravi Shah', 'Alex Kim', 'Sam Patel']);
  assert.equal(row.topicId, 't1');
});

test('proposed preferences for one round, and the Ask in next round text', () => {
  const proposed = [
    { key: 's1:0', scopeId: 'round-2', scopeType: 'round', statement: 'A' },
    { key: 's2:0', scopeId: 'round-2:home', scopeType: 'screen', statement: 'B' },
    { key: 's3:0', scopeId: 'round-20', scopeType: 'round', statement: 'C' },
    { key: 's4:0', scopeId: 'round-20:home', scopeType: 'screen', statement: 'D' },
    { key: 's5:0', scopeId: 'topic-1', scopeType: 'topic', statement: 'E' },
  ];
  const mine = proposalsForRound(proposed, 'round-2', { screenTitles: { home: 'Booking home' } });
  assert.deepEqual(mine.map((item) => [item.key, item.origin, item.screenId]), [
    ['s1:0', 'from the round summary', null],
    ['s2:0', 'from Booking home', 'home'],
  ]);
  assert.deepEqual(proposalsForRound(proposed, ''), []);

  assert.equal(
    askInNextRoundText({ item: { dimension: 'behavior', statement: 'Unavailable slots: hidden or labeled "fully booked"' }, nextNumber: 3, round: { number: 2, track: 'experience' } }),
    'Ask in round 3 (Experience): Unavailable slots: hidden or labeled "fully booked"?\nContext: dimension: behavior; round 2 summary left it undecided.',
  );
});

test('the round edit form sends only what changed', () => {
  const now = new Date(2026, 9, 7, 12, 0);
  const original = {
    dueAt: new Date(2026, 9, 10, 17, 0).toISOString(),
    note: 'Note',
    reminder: { daysBefore: 2 },
    reviewers: [{ id: 'a', required: true }, { id: 'b', required: false }, { id: 'c', removedAt: '2026-10-01', required: false }],
  };
  const unchanged = {
    added: [], due: toDateTimeInputValue(original.dueAt), note: 'Note', reminder: '2',
    reviewers: [{ id: 'a', remove: false, required: true }, { id: 'b', remove: false, required: false }],
  };
  assert.deepEqual(roundPatch({ form: unchanged, now, original }), { errors: {}, payload: null });

  const changed = roundPatch({
    form: {
      ...unchanged,
      added: [{ actorId: 's9', actorType: 'stakeholder', key: 'stakeholder:s9', required: true }],
      due: '2026-10-12T09:30',
      reminder: '',
      reviewers: [{ id: 'a', remove: false, required: false }, { id: 'b', remove: true, required: false }],
    },
    now,
    original,
  });
  assert.deepEqual(changed.errors, {});
  assert.deepEqual(changed.payload, {
    addReviewers: [{ actorId: 's9', actorType: 'stakeholder', required: true }],
    dueAt: new Date(2026, 9, 12, 9, 30).toISOString(),
    reminder: null,
    removeReviewerIds: ['b'],
    updateReviewers: [{ id: 'a', required: false }],
  });

  const problems = roundPatch({
    form: { ...unchanged, due: '', reminder: '2', reviewers: [{ id: 'a', remove: true }, { id: 'b', remove: true }] },
    now,
    original,
  });
  assert.equal(problems.errors.reminder, 'A reminder needs a due date.');
  assert.equal(problems.errors.reviewers, 'Keep at least one reviewer on the round.');
  assert.equal(roundPatch({ form: { ...unchanged, due: '2026-10-01T09:00' }, now, original }).errors.due, 'Choose a due date in the future.');
});

test('marks and comments group by screen and filter by screen, reviewer, text, and status', () => {
  const data = {
    annotations: [
      { authorName: 'Ravi', authorRef: 'user:ravi', categoryLabel: 'Color', id: 'a1', labels: ['Too bright'], screenId: 'home', status: 'open', thread: [{ authorName: 'Jamie', authorRef: 'stakeholder:jamie', body: 'Agree, tone it down.', id: 'c1' }] },
      { authorName: 'Jamie', authorRef: 'stakeholder:jamie', id: 'a2', labels: [], screenId: 'booking', status: 'resolved', thread: [] },
      { authorName: 'Ravi', authorRef: 'user:ravi', id: 'a3', labels: [], note: 'Spacing is tight', screenId: 'booking', status: 'open', thread: [] },
    ],
    notes: [{ actorRef: 'stakeholder:casey', change: 'Bigger buttons.', name: 'Casey', screenId: 'home' }],
    screens: [{ screenId: 'home', title: 'Home' }, { screenId: 'booking', title: 'Booking' }, { screenId: 'empty', title: 'Empty' }],
  };
  const all = groupRoundFeedback(data);
  assert.deepEqual(all.groups.map((group) => [group.title, group.annotations.map((entry) => entry.id), group.notes.length]), [['Home', ['a1'], 1], ['Booking', ['a3'], 0]]);
  assert.deepEqual(all.counts, { comments: 1, marks: 2, notes: 1 });
  assert.deepEqual(groupRoundFeedback(data, { showResolved: true }).groups[1].annotations.map((entry) => entry.id), ['a2', 'a3']);
  assert.deepEqual(groupRoundFeedback(data, { screenId: 'booking' }).groups.map((group) => group.screenId), ['booking']);
  // A reviewer's marks, the marks they commented on, and their notes.
  assert.deepEqual(groupRoundFeedback(data, { reviewer: 'stakeholder:jamie' }).groups.flatMap((group) => group.annotations.map((entry) => entry.id)), ['a1']);
  assert.deepEqual(groupRoundFeedback(data, { reviewer: 'stakeholder:casey' }).counts, { comments: 0, marks: 0, notes: 1 });
  // Text matches labels, notes, comments, and written notes.
  assert.deepEqual(groupRoundFeedback(data, { query: 'tone it' }).counts.marks, 1);
  assert.deepEqual(groupRoundFeedback(data, { query: 'spacing' }).groups[0].annotations[0].id, 'a3');
  assert.deepEqual(groupRoundFeedback(data, { query: 'bigger' }).counts, { comments: 0, marks: 0, notes: 1 });
  assert.deepEqual(groupRoundFeedback(data, { query: 'nothing like this' }).groups, []);
  assert.deepEqual(groupRoundFeedback({}).groups, []);

  assert.deepEqual(roundFeedbackPeople(data).map((person) => person.name), ['Casey', 'Jamie', 'Ravi']);
  assert.equal(feedbackAnchor('annotation:a1'), '#mark-a1');
  assert.equal(feedbackAnchor('comment:c1'), '#comment-c1');
  assert.equal(feedbackAnchor('verdict:v1'), '');
});

test('a Marks and comments address picks a mark, or a comment and the mark it is on', () => {
  const data = { annotations: [{ id: 'a1', thread: [{ id: 'c1' }, { id: 'c2' }] }, { id: 'a2', thread: [] }] };
  assert.deepEqual(feedbackTarget(data, '#mark-a2'), { commentId: '', markId: 'a2' });
  assert.deepEqual(feedbackTarget(data, '#comment-c2'), { commentId: 'c2', markId: 'a1' });
  assert.deepEqual(feedbackTarget(data, '#mark-gone'), { commentId: '', markId: '' });
  assert.deepEqual(feedbackTarget(data, '#comment-gone'), { commentId: '', markId: '' });
  assert.deepEqual(feedbackTarget(data, ''), { commentId: '', markId: '' });
});

test('the marks list sums up each mark: its first words and everyone involved', () => {
  const mark = {
    labels: ['Too bright'],
    note: '',
    participants: [
      { name: 'Dana Whitlock', ref: 'stakeholder:dana', roles: ['posted', 'commented'] },
      { name: 'Matt Bradford', ref: 'user:matt', roles: ['commented'] },
      { name: 'Ana Ruiz', ref: 'user:ana', roles: ['tagged'] },
    ],
    thread: [
      { body: 'Reply first in time', id: 'r', parentCommentId: 'c' },
      { body: '**Warnings** should sit above the table, @[Ana Ruiz](user:ana).', id: 'c', parentCommentId: null },
    ],
  };
  assert.equal(markExcerpt(mark), 'Warnings should sit above the table, @Ana Ruiz.');
  assert.equal(markExcerpt(mark, 12), 'Warnings sh…');
  assert.equal(markExcerpt({ labels: ['Typo'], note: 'Check the date', thread: [] }), '“Typo” · Check the date');
  assert.equal(markExcerpt({}), '');

  const people = markPeople(mark);
  assert.equal(people.posted.name, 'Dana Whitlock');
  assert.equal(people.posted.initials, 'DW');
  assert.ok(people.posted.color);
  assert.deepEqual(people.commented.map((person) => person.name), ['Dana Whitlock', 'Matt Bradford']);
  assert.deepEqual(people.tagged.map((person) => person.name), ['Ana Ruiz']);
  assert.deepEqual(people.people.map((person) => person.ref), ['stakeholder:dana', 'user:matt', 'user:ana']);
  assert.deepEqual(markPeople({}), { commented: [], people: [], posted: null, tagged: [] });
});

test('a mark is shown on its snapshot, its image screen, or a blank frame of the screen', () => {
  const prototype = { kind: 'prototype', screenId: 'flow', viewport: { height: 900, width: 1440 } };
  const image = { height: 640, imageUrl: 'https://review.example/p/1/g/home.png', kind: 'image', screenId: 'home', width: 960 };
  assert.deepEqual(markSurface({ snapshotUrl: '/api/x/snapshots/s1' }, prototype), { kind: 'snapshot', path: '/api/x/snapshots/s1' });
  assert.deepEqual(markSurface({}, image), { height: 640, kind: 'image', url: image.imageUrl, width: 960 });
  assert.deepEqual(markSurface({ snapshotUnavailable: true }, prototype), { height: 900, kind: 'blank', width: 1440 });
  assert.deepEqual(markSurface({}, { ...image, imageUrl: null }), { height: 640, kind: 'blank', width: 960 });
  assert.deepEqual(markSurface({}, null), { height: 800, kind: 'blank', width: 1280 });
});
