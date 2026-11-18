import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { agentScenarioCorpusSchema, evaluateScenarioResult } from '../evals/scenario-schema.js';

const corpusUrl = new URL('../evals/scenarios/v1.json', import.meta.url);

test('versioned agent eval corpus is unique and covers every required category', async () => {
  const corpus = agentScenarioCorpusSchema.parse(JSON.parse(await readFile(corpusUrl, 'utf8')));
  assert.equal(corpus.scenarios.length, 25);
  assert.equal(corpus.scenarios.every((scenario) => scenario.expected.outcomes.length > 0), true);
  assert.equal(corpus.scenarios.every((scenario) => scenario.expected.evidence.minimumCount > 0), true);
  assert.equal(corpus.scenarios.every((scenario) => Object.keys(scenario.expected.efficiency).length === 4), true);
});

test('deterministic scenario oracle enforces tools, mutations, and reply patterns', () => {
  const scenario = {
    expected: {
      forbiddenTools: ['commit_project'],
      maxMutations: 0,
      requiredReplyPatterns: ['permission'],
      requiredTools: [],
    },
    id: 'v1.authorization-check',
  };

  assert.equal(evaluateScenarioResult(scenario, {
    mutationCount: 1,
    reply: 'Done',
    toolCalls: [{ name: 'commit_project' }],
  }).passed, false);
  assert.equal(evaluateScenarioResult(scenario, {
    mutationCount: 0,
    reply: 'You do not have permission.',
    toolCalls: [],
  }).passed, true);
});

test('scenario oracle accepts efficient policy-safe outcomes without prescribing an exact tool path', () => {
  const scenario = {
    expected: {
      efficiency: { maxCostUsd: 0.1, maxLatencyMs: 1000, maxTokens: 1000, maxToolCalls: 3 },
      evidence: { minimumCount: 1, requiredTypes: ['verifier'] },
      forbiddenTools: ['commit_project'], maxMutations: 1, minimumScore: 1,
      outcomes: [{ operator: 'equals', path: 'goal.status', value: 'completed' }],
      policy: { forbiddenDecisionCodes: ['emergency_deny'], requiredDecisionCodes: ['allowed'] },
      requiredReplyPatterns: [], requiredTools: ['legacy_exact_tool'],
    },
    id: 'v1.outcome-check',
  };
  const evaluation = evaluateScenarioResult(scenario, {
    evidence: [{ id: 'verification-1', type: 'verifier' }], latencyMs: 200, mutationCount: 1,
    policyDecisions: [{ code: 'allowed' }], state: { goal: { status: 'completed' } },
    toolCalls: [{ name: 'verify_project_health' }], usage: { costUsd: 0.01, inputTokens: 200, outputTokens: 100 },
  });
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.score, 1);
  assert.match(evaluation.diagnostics[0], /preferred tool/);
});
