// Live Odin summary evaluation against the real provider (AC-02 handoff evidence).
//
//   node backend/evals/requirements-summary/run-live-eval.js
//
// Needs OPENAI_API_KEY. Uses ODIN_EVAL_MODEL, then REQUIREMENTS_SUMMARY_MODEL, then the
// production default (gpt-6-luna), at ODIN_EVAL_REASONING_EFFORT, then
// REQUIREMENTS_SUMMARY_REASONING_EFFORT, then high. Without a key it prints that it skipped
// and exits 0.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRequirementsAiService } from '../../src/modules/requirements/ai/requirements-ai-service.js';
import { evaluateSummaryEvalRun, loadSummaryEvalFixture, runSummaryEval } from './summary-eval.js';

export function liveEvalSettings(env = process.env) {
  const apiKey = String(env.OPENAI_API_KEY ?? '').trim();
  const model = String(env.ODIN_EVAL_MODEL ?? '').trim() || String(env.REQUIREMENTS_SUMMARY_MODEL ?? '').trim() || 'gpt-6-luna';
  const reasoningEffort = String(env.ODIN_EVAL_REASONING_EFFORT ?? '').trim()
    || String(env.REQUIREMENTS_SUMMARY_REASONING_EFFORT ?? '').trim() || 'high';
  return { apiKey, model, reasoningEffort };
}

/** The summary service a live eval runs, configured as production configures it. */
export function liveSummaryAi({ apiKey, model, reasoningEffort }) {
  return createRequirementsAiService({
    capabilityDefaults: { requirementsSummary: { model, reasoningEffort } },
    defaultApiKey: apiKey,
    defaultModel: model,
    provider: 'openai',
  });
}

export async function runLiveSummaryEval(settings) {
  const fixture = await loadSummaryEvalFixture();
  const summaryAi = liveSummaryAi(settings);
  const outcome = await runSummaryEval({ fixture, summaryAi });
  return { evaluation: evaluateSummaryEvalRun({ fixture, outcome }), fixture, outcome };
}

async function main() {
  const settings = liveEvalSettings();
  if (!settings.apiKey) {
    console.log('requirements summary live evaluation: skipped (OPENAI_API_KEY is not set)');
    return 0;
  }
  const { evaluation, fixture, outcome } = await runLiveSummaryEval(settings);
  console.log(JSON.stringify({
    checks: evaluation.checks,
    fixture: fixture.id,
    latencyMs: outcome.latencyMs,
    model: outcome.run?.model ?? null,
    output: outcome.run?.output ?? null,
    passed: evaluation.passed,
    status: outcome.run?.status ?? outcome.result?.status ?? null,
  }, null, 2));
  return evaluation.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
