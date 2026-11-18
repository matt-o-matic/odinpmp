// Live replay of the owner-weighted summary cases against the real provider.
//
//   node backend/evals/requirements-summary/run-replay-eval.js
//
// Needs OPENAI_API_KEY. Model and reasoning effort as in run-live-eval.js. Without a key it
// prints that it skipped and exits 0. Each case runs runsPerCase times; ODIN_EVAL_CASES
// (comma-separated ids) runs only those cases.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateReplayCase, loadReplayCases, runReplayCase } from './replay-eval.js';
import { liveEvalSettings, liveSummaryAi } from './run-live-eval.js';

export async function runLiveReplayEval(settings, { caseIds = [] } = {}) {
  const suite = await loadReplayCases();
  const summaryAi = liveSummaryAi(settings);
  const results = [];
  for (const testCase of suite.cases.filter((entry) => caseIds.length === 0 || caseIds.includes(entry.id))) {
    const outcomes = await runReplayCase({ runs: suite.runsPerCase, summaryAi, testCase });
    results.push({ evaluation: evaluateReplayCase({ outcomes, testCase }), outcomes });
  }
  return { passed: results.every((result) => result.evaluation.passed), results, suite };
}

async function main() {
  const settings = liveEvalSettings();
  if (!settings.apiKey) {
    console.log('requirements summary replay evaluation: skipped (OPENAI_API_KEY is not set)');
    return 0;
  }
  const caseIds = String(process.env.ODIN_EVAL_CASES ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const { passed, results, suite } = await runLiveReplayEval(settings, { caseIds });
  console.log(JSON.stringify({
    cases: results.map(({ evaluation, outcomes }) => ({
      case: evaluation.caseId,
      failed: evaluation.checks.filter((entry) => !entry.passed),
      outputs: outcomes.map((outcome) => outcome.run?.output ?? null),
      passed: evaluation.passed,
    })),
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    passed,
    suite: suite.id,
  }, null, 2));
  return passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
