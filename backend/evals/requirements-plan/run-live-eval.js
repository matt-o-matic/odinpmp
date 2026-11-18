// Live track plan evaluation against the real provider.
//
//   node backend/evals/requirements-plan/run-live-eval.js
//
// Needs OPENAI_API_KEY. Uses ODIN_EVAL_MODEL, then OPENAI_MODEL, then the default model.
// Without a key it prints that it skipped and exits 0.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_AI_MODEL } from '../../src/lib/ai/ai-capability-config.js';
import { createRequirementsAiService } from '../../src/modules/requirements/ai/requirements-ai-service.js';
import { evaluatePlanEvalRun, loadPlanEvalFixture, runPlanEval } from './plan-eval.js';

export function liveEvalSettings(env = process.env) {
  const apiKey = String(env.OPENAI_API_KEY ?? '').trim();
  const model = String(env.ODIN_EVAL_MODEL ?? '').trim() || String(env.OPENAI_MODEL ?? '').trim() || DEFAULT_AI_MODEL;
  return { apiKey, model };
}

export async function runLivePlanEval({ apiKey, model }) {
  const fixture = await loadPlanEvalFixture();
  const planAi = createRequirementsAiService({ defaultApiKey: apiKey, defaultModel: model, provider: 'openai' });
  const outcome = await runPlanEval({ fixture, planAi });
  return { evaluation: evaluatePlanEvalRun({ fixture, outcome }), fixture, outcome };
}

async function main() {
  const settings = liveEvalSettings();
  if (!settings.apiKey) {
    console.log('requirements plan live evaluation: skipped (OPENAI_API_KEY is not set)');
    return 0;
  }
  const { evaluation, fixture, outcome } = await runLivePlanEval(settings);
  console.log(JSON.stringify({
    checks: evaluation.checks,
    error: outcome.error ?? null,
    fixture: fixture.id,
    latencyMs: outcome.latencyMs,
    model: settings.model,
    passed: evaluation.passed,
    plan: outcome.draft?.plan ?? null,
    proposals: outcome.proposed?.proposals ?? null,
  }, null, 2));
  return evaluation.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
