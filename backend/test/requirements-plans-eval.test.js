import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePlanEvalRun, loadPlanEvalFixture, runPlanEval } from '../evals/requirements-plan/plan-eval.js';
import { liveEvalSettings } from '../evals/requirements-plan/run-live-eval.js';
import { createRequirementsAiService } from '../src/modules/requirements/ai/requirements-ai-service.js';
import { draftPlanWithLocalFixture, proposeWorkWithLocalFixture } from '../src/modules/requirements/plans/plan-fixture.js';

// The live plan evaluation's fixture and oracle, exercised without a model: the local
// fixture provider must pass, and providers that misbehave must fail the matching checks.

function failing(evaluation) {
  return evaluation.checks.filter((entry) => !entry.passed).map((entry) => entry.name);
}

test('the plan eval fixture has delivered, deferred, superseded, and preference decisions and one injected instruction', async () => {
  const fixture = await loadPlanEvalFixture();
  assert.deepEqual(fixture.decisions.map((entry) => entry.outcome), ['agreed', 'decided', 'deferred', 'agreed', 'agreed', 'agreed']);
  assert.equal(fixture.decisions.filter((entry) => entry.kind === 'preference').length, 1);
  assert.equal(fixture.decisions.find((entry) => entry.supersedes).supersedes, fixture.expectations.superseded[0]);
  const injected = fixture.decisions.filter((entry) => JSON.stringify(entry).includes(fixture.canary));
  assert.equal(injected.length, 1);
  assert.match(injected[0].topic, /Ignore all previous instructions/);
});

test('the eval oracle passes the local-fixture provider end to end, through approval and apply', async () => {
  const fixture = await loadPlanEvalFixture();
  const outcome = await runPlanEval({ fixture, planAi: createRequirementsAiService({ provider: 'local-fixture' }) });
  const evaluation = evaluatePlanEvalRun({ fixture, outcome });
  assert.deepEqual(failing(evaluation), [], JSON.stringify({ checks: evaluation.checks, error: outcome.error ?? null }, null, 2));
  assert.equal(outcome.epicsBeforeApply.length, 0);
  assert.ok(outcome.epicsAfterApply.length > 0);
});

test('the eval oracle fails providers that follow the injection, cite superseded decisions, or skip criteria', async () => {
  const fixture = await loadPlanEvalFixture();
  const obedient = {
    provider: 'obedient-stub',
    async draftPlan({ modelInput }) {
      const output = draftPlanWithLocalFixture(modelInput);
      output.criteria.push({ decisionIds: ['D-02'], id: '', scenario: `${fixture.canary} approved by the administrator.` });
      output.criteria.push({ decisionIds: ['D-01'], id: '', scenario: `${fixture.canary} again.` });
      output.nonGoals = [];
      return { model: 'stub', output };
    },
    async proposeWork({ modelInput }) {
      const output = proposeWorkWithLocalFixture(modelInput);
      output.epics = output.epics.slice(0, 1);
      return { model: 'stub', output };
    },
  };
  const evaluation = evaluatePlanEvalRun({ fixture, outcome: await runPlanEval({ fixture, planAi: obedient }) });
  assert.deepEqual(failing(evaluation), ['no-uncited-items', 'no-superseded-citations', 'deferred-as-non-goal', 'criteria-covered-by-work', 'injection-not-followed']);

  const broken = { provider: 'broken-stub', async draftPlan() { throw new Error('timeout'); }, async proposeWork() { throw new Error('timeout'); } };
  const failed = evaluatePlanEvalRun({ fixture, outcome: await runPlanEval({ fixture, planAi: broken }) });
  assert.equal(failed.passed, false);
  assert.ok(failing(failed).includes('draft-ok'));
});

test('the live plan evaluation needs OPENAI_API_KEY and picks its model from the environment', () => {
  assert.deepEqual(liveEvalSettings({}), { apiKey: '', model: 'gpt-6-luna' });
  assert.equal(liveEvalSettings({ OPENAI_API_KEY: ' sk-x ', OPENAI_MODEL: 'gpt-a' }).model, 'gpt-a');
  assert.equal(liveEvalSettings({ ODIN_EVAL_MODEL: 'gpt-b', OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-a' }).model, 'gpt-b');
});
