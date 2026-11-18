import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPortalError,
  closedRounds,
  decisionLine,
  isLinkProblem,
  linkValidityText,
  openRounds,
  personLine,
  questionMeta,
  questionStateLabel,
  roundAsk,
  roundContents,
  roundProgress,
  summaryLine,
  waitingQuestions,
} from '../src/lib/requirements/portal-view.js';

const apiError = (status, data = {}) => Object.assign(new Error('Request failed.'), { data, status });

test('portal errors separate a missing, expired, revoked, and rate-limited link', () => {
  assert.deepEqual(classifyPortalError(apiError(404, { details: { code: 'link_not_found' }, error: 'This requirements link is not valid.' })), { kind: 'not-found' });
  assert.deepEqual(classifyPortalError(apiError(410, { details: { code: 'link_expired', expiredAt: '2026-09-30T00:00:00.000Z' }, error: 'link_expired' })), { expiredAt: '2026-09-30T00:00:00.000Z', kind: 'expired' });
  assert.deepEqual(classifyPortalError(apiError(410, { details: { code: 'link_revoked' }, error: 'link_revoked' })), { kind: 'revoked' });
  assert.deepEqual(classifyPortalError(apiError(429, { details: { code: 'rate_limited', retryAfterSeconds: 7 }, error: 'rate_limited' })), { kind: 'rate-limited', retryAfterSeconds: 7 });
  assert.deepEqual(classifyPortalError(apiError(500)), { kind: 'failed', status: 500 });
  assert.equal(isLinkProblem(apiError(410, { details: { code: 'link_expired' } })), true);
  assert.equal(isLinkProblem(apiError(404, { details: { code: 'link_not_found' } })), true);
  assert.equal(isLinkProblem(apiError(404, { error: 'Round not found.' })), false, 'a missing round is not a broken link');
});

test('link validity reads as a date, or as active while requests are open', () => {
  assert.equal(linkValidityText({ expiresAt: '2026-10-31T12:00:00.000Z', involvementActive: false }, { locale: 'en-US' }), 'Link valid until Oct 31');
  assert.equal(linkValidityText({ expiresAt: null, involvementActive: true }), 'Active while you have open requests');
  assert.equal(personLine({ name: 'Ravi Shah', roleTitle: 'Finance' }), 'Ravi Shah · Finance');
  assert.equal(personLine({ name: 'Ravi Shah', roleTitle: '' }), 'Ravi Shah');
});

test('each open round is one clear ask with who, what, and when', () => {
  const round = { dueAt: '2026-10-10T17:00:00.000Z', number: 2, progress: { directions: { done: 0, total: 2 }, done: 0, questions: { done: 0, total: 4 }, screens: { done: 0, total: 4 }, total: 10 }, publishedBy: { name: 'Morgan Lee' }, status: 'open', title: 'the booking flow' };
  const ask = roundAsk(round, { locale: 'en-US' });
  assert.equal(ask.headline, 'Morgan Lee asked you to review the booking flow by Saturday, Oct 10');
  assert.equal(roundAsk({ number: 3, title: '' }, { projectName: 'Fieldwork' }).headline, 'The Fieldwork team asked you to review round 3');
  assert.deepEqual(roundContents(round.progress).map((item) => `${item.count} ${item.label}`), ['2 directions to compare', '4 screens to mark up', '4 questions to answer']);
  assert.deepEqual(roundContents({ screens: { total: 1 } }).map((item) => item.label), ['screen to mark up']);
  assert.deepEqual(roundProgress(round), { action: 'Start review', closed: false, done: 0, percent: 0, submitted: false, text: '0 of 10 steps', total: 10 });
  assert.equal(roundProgress({ ...round, progress: { done: 3, total: 10 } }).action, 'Continue review');
  assert.equal(roundProgress({ ...round, submittedAt: '2026-10-07T10:00:00Z' }).action, 'Open your review');
  assert.equal(roundProgress({ ...round, status: 'closed' }).action, 'View your review');
  assert.deepEqual(openRounds([{ id: 'a', status: 'open' }, { id: 'b', status: 'closed' }]).map((entry) => entry.id), ['a']);
  assert.deepEqual(closedRounds([{ id: 'a', status: 'open' }, { id: 'b', status: 'closed' }]).map((entry) => entry.id), ['b']);
});

test('questions waiting: assigned first, then open ones, without decided ones', () => {
  const topics = {
    assigned: [{ id: 'mine', state: 'open' }, { id: 'mine-decided', state: 'decided' }],
    decided: [{ id: 'other-decided', state: 'decided' }],
    open: [{ id: 'open-1', state: 'open' }],
  };
  assert.deepEqual(waitingQuestions(topics).map((topic) => topic.id), ['mine', 'open-1']);
  assert.deepEqual(questionMeta({ assignmentRole: 'primary', commentCount: 3, isAssignedToMe: true }), { comments: '3 comments', role: 'You own this' });
  assert.deepEqual(questionMeta({ assignmentRole: 'collaborator', commentCount: 1, isAssignedToMe: true }), { comments: '1 comment', role: 'Assigned to you' });
  assert.deepEqual(questionMeta({ commentCount: 0, isAssignedToMe: false }), { comments: 'No comments yet', role: 'Open question' });
  assert.equal(questionStateLabel({ state: 'decided' }), 'Decided');
  assert.equal(questionStateLabel({ state: 'open' }), 'Open');
});

test('the summary line is plain and names nobody by id', () => {
  assert.equal(summaryLine(null), 'Not enough input yet.');
  assert.equal(summaryLine({ output: { insufficientInput: true } }), 'Not enough input yet.');
  const line = summaryLine({
    output: {
      aligned: [{ sources: ['comment:c1'], statement: 'Estimates come from job type and duration.', supporterNames: ['Ravi Shah'] }],
      divergent: [{ issue: 'Who maintains the rate table.', positions: [] }],
      insufficientInput: false,
      outstanding: [],
      underExplored: [],
    },
  });
  assert.equal(line, 'Agreed: Estimates come from job type and duration. Still split: Who maintains the rate table.');
  assert.equal(summaryLine({ output: { aligned: [], divergent: [], insufficientInput: false, outstanding: [{ item: 'Finance confirms wording' }], underExplored: [] } }), 'Open: Finance confirms wording.');
});

test('summary lines say when a proposed answer still needs confirming', () => {
  const aligned = [{ sources: ['comment:c1'], statement: 'Estimates come from job type.', supporterNames: ['Ravi Shah'] }];
  assert.equal(
    summaryLine({ output: { aligned, outstanding: [], proposedAnswer: 'Use a rate table', proposedAnswerStatus: 'awaiting-confirmation' } }),
    'Awaiting confirmation: Use a rate table.',
  );
  assert.equal(
    summaryLine({ output: { aligned, outstanding: [], proposedAnswer: 'Use a rate table', proposedAnswerStatus: 'agreed' } }),
    'Agreed: Estimates come from job type.',
  );
  assert.equal(summaryLine({ output: { aligned: [], outstanding: [], proposedAnswer: 'Use a rate table' } }), 'Agreed: Use a rate table.');
  assert.equal(
    summaryLine({ output: { aligned: [], outstanding: [], proposedAnswer: 'Use a rate table', proposedAnswerStatus: 'owner-answered' } }),
    'Owner’s answer: Use a rate table.',
  );
  // The open item named is one that blocks the decision, when there is one.
  assert.equal(
    summaryLine({ output: { aligned: [], outstanding: [{ blocking: false, item: 'Nice to have' }, { blocking: true, item: 'Finance confirms wording' }] } }),
    'Open: Finance confirms wording.',
  );
});

test('decision lines name the decider and the day', () => {
  assert.equal(decisionLine({ decidedAt: '2026-10-04T12:00:00.000Z', decidedBy: { name: 'Morgan Lee' }, outcome: 'agreed' }, { locale: 'en-US' }), 'Agreed by Morgan Lee · Oct 4');
  assert.equal(decisionLine({ decidedAt: '2026-10-02T12:00:00.000Z', decidedBy: { name: 'Sam Patel' }, outcome: 'decided' }, { locale: 'en-US' }), 'Decided by Sam Patel · Oct 2');
});
