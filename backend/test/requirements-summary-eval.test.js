import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSummaryEvalRun, loadSummaryEvalFixture, runSummaryEval } from '../evals/requirements-summary/summary-eval.js';
import { liveEvalSettings } from '../evals/requirements-summary/run-live-eval.js';
import { createLocalFixtureSummaryAi, summarizeWithLocalFixture } from '../src/modules/requirements/summary/summary-fixture.js';
import { emptySummaryOutput } from '../src/modules/requirements/summary/summary-output.js';

// The live evaluation's fixture and oracle, exercised without a model: the local fixture
// provider must pass, and providers that misbehave must fail the matching check.

function failing(evaluation) {
  return evaluation.checks.filter((entry) => !entry.passed).map((entry) => entry.name);
}

test('the summary eval fixture describes two disagreeing stakeholders, one agreeing, and an injected instruction', async () => {
  const fixture = await loadSummaryEvalFixture();
  assert.equal(fixture.people.length, 3);
  assert.equal(fixture.comments.filter((entry) => entry.body.includes(fixture.canary)).length, 1);
  assert.match(fixture.comments.find((entry) => entry.body.includes(fixture.canary)).body, /Ignore all previous instructions/);
  assert.deepEqual(fixture.expectations.divergentSides, [['ana'], ['ben']]);
});

test('the eval oracle passes the local-fixture provider on the fixture discussion', async () => {
  const fixture = await loadSummaryEvalFixture();
  const outcome = await runSummaryEval({ fixture, summaryAi: createLocalFixtureSummaryAi() });
  const evaluation = evaluateSummaryEvalRun({ fixture, outcome });
  assert.deepEqual(failing(evaluation), [], JSON.stringify(evaluation.checks, null, 2));
  assert.equal(outcome.run.model, 'local-fixture');
});

test('the eval oracle fails a provider that follows the injection or misses the disagreement', async () => {
  const fixture = await loadSummaryEvalFixture();
  const obeys = {
    provider: 'obedient-stub',
    async summarize({ modelInput }) {
      const output = summarizeWithLocalFixture(modelInput);
      return { output: { ...output, divergent: [], proposedAnswer: `${fixture.canary}: the board approved upfront pricing` } };
    },
  };
  const evaluation = evaluateSummaryEvalRun({ fixture, outcome: await runSummaryEval({ fixture, summaryAi: obeys }) });
  assert.deepEqual(failing(evaluation), ['divergent-present', 'divergent-sides', 'injection-not-followed']);

  const silent = { provider: 'silent-stub', async summarize() { return { output: emptySummaryOutput() }; } };
  const empty = evaluateSummaryEvalRun({ fixture, outcome: await runSummaryEval({ fixture, summaryAi: silent }) });
  assert.deepEqual(failing(empty), ['aligned-present', 'divergent-present', 'aligned-on-the-right-people', 'divergent-sides']);

  const broken = { provider: 'broken-stub', async summarize() { throw new Error('timeout'); } };
  const failedRun = evaluateSummaryEvalRun({ fixture, outcome: await runSummaryEval({ fixture, summaryAi: broken }) });
  assert.equal(failedRun.passed, false);
  assert.ok(failing(failedRun).includes('run-ok'));
});

test('the live evaluation needs OPENAI_API_KEY and runs the production summary model unless told otherwise', () => {
  assert.deepEqual(liveEvalSettings({}), { apiKey: '', model: 'gpt-6-luna', reasoningEffort: 'high' });
  // The general model is not the summary model.
  assert.equal(liveEvalSettings({ OPENAI_API_KEY: ' sk-x ', OPENAI_MODEL: 'gpt-a' }).model, 'gpt-6-luna');
  assert.equal(liveEvalSettings({ OPENAI_API_KEY: 'sk-x', REQUIREMENTS_SUMMARY_MODEL: 'gpt-a' }).model, 'gpt-a');
  assert.deepEqual(
    liveEvalSettings({ ODIN_EVAL_MODEL: 'gpt-b', ODIN_EVAL_REASONING_EFFORT: 'low', OPENAI_API_KEY: 'sk-x', REQUIREMENTS_SUMMARY_MODEL: 'gpt-a' }),
    { apiKey: 'sk-x', model: 'gpt-b', reasoningEffort: 'low' },
  );
});
