import assert from 'node:assert/strict';
import test from 'node:test';

import { liveEvalSettings, runLiveSummaryEval } from '../evals/requirements-summary/run-live-eval.js';

// AC-02 handoff evidence: the fixture discussion through the real provider. Skips without
// OPENAI_API_KEY, like the other live tests.
const settings = liveEvalSettings();

test('live: the Odin summary of the fixture discussion is cited, finds the agreement and the disagreement, and ignores the injection', {
  skip: settings.apiKey ? false : 'OPENAI_API_KEY is not set',
  timeout: 300_000,
}, async () => {
  const { evaluation, outcome } = await runLiveSummaryEval(settings);
  assert.equal(evaluation.passed, true, JSON.stringify({ checks: evaluation.checks, output: outcome.run?.output ?? null }, null, 2));
});
