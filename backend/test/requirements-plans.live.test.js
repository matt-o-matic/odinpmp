import assert from 'node:assert/strict';
import test from 'node:test';

import { liveEvalSettings, runLivePlanEval } from '../evals/requirements-plan/run-live-eval.js';

// AC-13 handoff evidence: the fixture decisions through the real provider, from draft to
// applied work. Skips without OPENAI_API_KEY, like the other live tests.
const settings = liveEvalSettings();

test('live: the drafted plan cites active decisions, the proposed work covers every criterion, and the injection is ignored', {
  skip: settings.apiKey ? false : 'OPENAI_API_KEY is not set',
  timeout: 600_000,
}, async () => {
  const { evaluation, outcome } = await runLivePlanEval(settings);
  assert.equal(evaluation.passed, true, JSON.stringify({ checks: evaluation.checks, error: outcome.error ?? null, plan: outcome.draft?.plan ?? null }, null, 2));
});
