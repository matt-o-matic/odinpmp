import assert from 'node:assert/strict';
import test from 'node:test';

import { liveEvalSettings } from '../evals/requirements-summary/run-live-eval.js';
import { runLiveReplayEval } from '../evals/requirements-summary/run-replay-eval.js';

// The owner-weighted summary rules on the replay cases through the real provider, three
// runs per case. Skips without OPENAI_API_KEY, like the other live tests.
const settings = liveEvalSettings();

test('live: the owner-weighted summary rules hold on every replay case', {
  skip: settings.apiKey ? false : 'OPENAI_API_KEY is not set',
  timeout: 1_800_000,
}, async () => {
  const { passed, results } = await runLiveReplayEval(settings);
  assert.equal(passed, true, JSON.stringify(results.map(({ evaluation }) => ({ case: evaluation.caseId, failed: evaluation.checks.filter((entry) => !entry.passed) })), null, 2));
});
