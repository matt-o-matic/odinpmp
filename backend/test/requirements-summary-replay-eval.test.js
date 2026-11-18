import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReplayCase, loadReplayCases, runReplayCase, runReplayCaseOnce } from '../evals/requirements-summary/replay-eval.js';
import { emptySummaryOutput } from '../src/modules/requirements/summary/summary-output.js';

// The replay evaluation's cases and oracle, exercised without a model. A real provider is
// needed for the semantic checks (requirements-summary-replay.live.test.js); here stubs
// show the harness seeds owners, assignees, and related decisions, and that the oracle
// passes good output and fails each kind of bad output.

function failing(evaluation) {
  return evaluation.checks.filter((entry) => !entry.passed).map((entry) => entry.name);
}

function recordingAi(build) {
  const calls = [];
  return {
    calls,
    provider: 'stub',
    async summarize({ modelInput }) {
      calls.push(modelInput);
      return { model: 'stub', output: build(modelInput) };
    },
  };
}

test('the replay cases cover each pattern from the interactions review and name only people they define', async () => {
  const suite = await loadReplayCases();
  assert.equal(suite.runsPerCase, 3);
  assert.deepEqual(suite.cases.map((entry) => entry.id), [
    'owner-answer-settles',
    'revised-recommendation-is-history',
    'lone-owner-answer',
    'genuinely-open-question',
    'settled-by-another-decision',
    'engineering-is-not-a-requirement',
    'resolution-statement-closes-blockers',
    'resolution-claims-no-completion',
    'required-revision-supersedes-proposal',
    'required-answers-are-not-asked-again',
    'agreed-shared-workflow-control',
    'input-standing-cannot-close',
  ]);
  for (const entry of suite.cases) {
    const keys = new Set(entry.people.map((person) => person.key));
    const commentKeys = new Set(entry.comments.map((comment) => comment.key));
    assert.ok(!entry.owner || keys.has(entry.owner), entry.id);
    for (const key of entry.assigned ?? []) assert.ok(keys.has(key), `${entry.id} assigned ${key}`);
    for (const key of entry.required ?? []) assert.ok(keys.has(key), `${entry.id} required ${key}`);
    for (const key of entry.admins ?? []) assert.ok(entry.people.find((person) => person.key === key)?.kind === 'user', `${entry.id} admin ${key} is a user`);
    for (const comment of entry.comments) {
      assert.ok(keys.has(comment.author), `${entry.id} ${comment.key}`);
      assert.ok(!comment.replyTo || commentKeys.has(comment.replyTo), `${entry.id} ${comment.key} reply`);
      for (const voters of Object.values(comment.votes ?? {})) for (const voter of voters) assert.ok(keys.has(voter));
    }
    for (const key of entry.expect.blockingCites ?? []) assert.ok(commentKeys.has(key), `${entry.id} cites ${key}`);
  }
});

test('the replay harness gives the model the owner, the assignees, and related decisions', async () => {
  const suite = await loadReplayCases();
  const testCase = suite.cases.find((entry) => entry.id === 'settled-by-another-decision');
  const ai = recordingAi(() => emptySummaryOutput());
  await runReplayCaseOnce({ summaryAi: ai, testCase });
  const [input] = ai.calls;
  const people = input.untrustedContent.people;
  assert.deepEqual(people.map((person) => [person.name, person.topicRole ?? null]), [['Tom Reyes', 'assigned'], ['Olivia Grant', 'owner']]);
  assert.deepEqual(input.untrustedContent.context.relatedDecisions.map((decision) => decision.statement), [testCase.relatedDecisions[0].statement]);

  // Required people and admins reach the model with their standing.
  const revised = suite.cases.find((entry) => entry.id === 'required-revision-supersedes-proposal');
  const revisedAi = recordingAi(() => emptySummaryOutput());
  await runReplayCaseOnce({ summaryAi: revisedAi, testCase: revised });
  assert.deepEqual(
    revisedAi.calls[0].untrustedContent.people.map((person) => [person.name, person.standing, person.topicRole ?? null, person.projectRole ?? null]),
    [
      ['Priya Shah', 'owner', 'owner', 'admin'],
      ['Sam Hale', 'required', 'assigned', 'admin'],
      ['Helen Ortiz', 'required', 'required', null],
      ['Ben Ward', 'input', 'assigned', null],
    ],
  );

  // The lone owner case reaches the model even with one contributor.
  const lone = suite.cases.find((entry) => entry.id === 'lone-owner-answer');
  const loneAi = recordingAi(() => emptySummaryOutput());
  const outcome = await runReplayCaseOnce({ summaryAi: loneAi, testCase: lone });
  assert.equal(loneAi.calls.length, 1);
  assert.equal(outcome.run.status, 'ok');
});

test('the replay oracle passes output that follows the rules and fails each broken rule', async () => {
  const suite = await loadReplayCases();
  const open = suite.cases.find((entry) => entry.id === 'genuinely-open-question');
  const good = recordingAi((input) => ({
    ...emptySummaryOutput(),
    outstanding: [{ blocking: true, item: 'Say whether the insurer rules gate acceptance testing.', sources: [input.citableSourceRefs[1]], suggestedOwnerRole: 'Delivery team', waitingOn: [] }],
  }));
  assert.deepEqual(failing(evaluateReplayCase({ outcomes: await runReplayCase({ runs: 2, summaryAi: good, testCase: open }), testCase: open })), []);

  const uncited = recordingAi(() => ({
    ...emptySummaryOutput(),
    outstanding: [{ blocking: true, item: 'Something.', sources: [], suggestedOwnerRole: '', waitingOn: [] }],
  }));
  const uncitedRun = evaluateReplayCase({ outcomes: await runReplayCase({ runs: 1, summaryAi: uncited, testCase: open }), testCase: open });
  assert.deepEqual(failing(uncitedRun), ['run1:min-blocking', 'run1:blocking-cites'], 'an uncited blocker is kept as non-blocking');

  const engineering = suite.cases.find((entry) => entry.id === 'engineering-is-not-a-requirement');
  let call = 0;
  const noisy = recordingAi(() => {
    call += 1;
    return {
      ...emptySummaryOutput(),
      outstanding: call === 1 ? [] : [{ blocking: false, item: 'Decide whether to reuse the booking tables.', sources: [], suggestedOwnerRole: '', waitingOn: [] }],
      proposedAnswer: call === 1 ? 'Show a Rebook button.' : '',
    };
  });
  const noisyRun = evaluateReplayCase({ outcomes: await runReplayCase({ runs: 2, summaryAi: noisy, testCase: engineering }), testCase: engineering });
  assert.deepEqual(failing(noisyRun), ['run2:proposed-answer', 'run2:not-raised-again']);

  const unstable = recordingAi(() => {
    call += 1;
    return { ...emptySummaryOutput(), outstanding: call % 2 ? [] : [{ blocking: true, item: 'x', sources: ['C2'], suggestedOwnerRole: '', waitingOn: [] }] };
  });
  const unstableRun = evaluateReplayCase({ outcomes: await runReplayCase({ runs: 2, summaryAi: unstable, testCase: open }), testCase: open });
  assert.ok(failing(unstableRun).includes('stable-blocking'));
});
