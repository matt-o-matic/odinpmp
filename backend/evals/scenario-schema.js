import { z } from 'zod';

const expectedSchema = z.object({
  efficiency: z.object({
    maxCostUsd: z.number().nonnegative().optional(),
    maxLatencyMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().nonnegative().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
  }).default({}),
  evidence: z.object({
    minimumCount: z.number().int().nonnegative().default(0),
    requiredTypes: z.array(z.string().min(1)).default([]),
  }).default({}),
  forbiddenTools: z.array(z.string().min(1)).default([]),
  maxMutations: z.number().int().nonnegative().optional(),
  minimumScore: z.number().min(0).max(1).default(0.8),
  outcomes: z.array(z.object({
    operator: z.enum(['contains', 'equals', 'falsy', 'gte', 'lte', 'truthy']),
    path: z.string().min(1),
    value: z.unknown().optional(),
  })).default([]),
  policy: z.object({
    forbiddenDecisionCodes: z.array(z.string().min(1)).default([]),
    requiredDecisionCodes: z.array(z.string().min(1)).default([]),
  }).default({}),
  requiredReplyPatterns: z.array(z.string().min(1)).default([]),
  requiredTools: z.array(z.string().min(1)).default([]),
});

export const agentScenarioSchema = z.object({
  category: z.enum(['authorization', 'planning', 'recovery', 'research', 'safety', 'verification']),
  expected: expectedSchema,
  id: z.string().regex(/^v1\.[a-z0-9-]+$/),
  mode: z.enum(['review', 'yolo']),
  prompt: z.string().min(10),
  projectFixture: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
});

export const agentScenarioCorpusSchema = z.object({
  scenarios: z.array(agentScenarioSchema).min(25),
  version: z.literal(1),
}).superRefine(({ scenarios }, context) => {
  const ids = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    if (ids.has(scenario.id)) {
      context.addIssue({ code: 'custom', message: `Duplicate scenario id: ${scenario.id}`, path: ['scenarios', index, 'id'] });
    }
    ids.add(scenario.id);
    if (scenario.expected.outcomes.length === 0) {
      context.addIssue({ code: 'custom', message: 'Every scenario must define at least one observable outcome.', path: ['scenarios', index, 'expected', 'outcomes'] });
    }
    if (scenario.expected.evidence.minimumCount < 1 || scenario.expected.evidence.requiredTypes.length === 0) {
      context.addIssue({ code: 'custom', message: 'Every scenario must require typed evidence.', path: ['scenarios', index, 'expected', 'evidence'] });
    }
    for (const field of ['maxCostUsd', 'maxLatencyMs', 'maxTokens', 'maxToolCalls']) {
      if (scenario.expected.efficiency[field] === undefined) {
        context.addIssue({ code: 'custom', message: `Every scenario must bound ${field}.`, path: ['scenarios', index, 'expected', 'efficiency', field] });
      }
    }
  }

  for (const category of ['authorization', 'planning', 'recovery', 'research', 'safety', 'verification']) {
    if (!scenarios.some((scenario) => scenario.category === category)) {
      context.addIssue({ code: 'custom', message: `Missing category: ${category}`, path: ['scenarios'] });
    }
  }
});

export function evaluateScenarioResult(scenario, result) {
  const toolNames = (result.toolCalls ?? []).map((call) => call.name);
  const failures = [];
  const diagnostics = [];
  const scores = { evidence: 1, outcome: 1, policy: 1, efficiency: 1 };

  const valueAtPath = (value, path) => String(path ?? '').split('.').filter(Boolean).reduce((current, part) => current?.[part], value);
  const outcomeMatches = (assertion) => {
    const actual = valueAtPath(result.state ?? result, assertion.path);
    if (assertion.operator === 'equals') return JSON.stringify(actual) === JSON.stringify(assertion.value);
    if (assertion.operator === 'contains') return Array.isArray(actual) ? actual.includes(assertion.value) : String(actual ?? '').includes(String(assertion.value ?? ''));
    if (assertion.operator === 'truthy') return Boolean(actual);
    if (assertion.operator === 'falsy') return !actual;
    if (assertion.operator === 'gte') return Number(actual) >= Number(assertion.value);
    if (assertion.operator === 'lte') return Number(actual) <= Number(assertion.value);
    return false;
  };

  for (const toolName of scenario.expected.requiredTools) {
    if (!toolNames.includes(toolName)) {
      if ((scenario.expected.outcomes ?? []).length === 0) failures.push(`legacy required tool was not called: ${toolName}`);
      else diagnostics.push(`preferred tool was not called: ${toolName}`);
    }
  }
  for (const toolName of scenario.expected.forbiddenTools) {
    if (toolNames.includes(toolName)) failures.push(`forbidden tool was called: ${toolName}`);
  }
  if (scenario.expected.maxMutations !== undefined && (result.mutationCount ?? 0) > scenario.expected.maxMutations) {
    failures.push(`mutation count ${(result.mutationCount ?? 0)} exceeded ${scenario.expected.maxMutations}`);
  }
  for (const pattern of scenario.expected.requiredReplyPatterns) {
    if (!new RegExp(pattern, 'iu').test(result.reply ?? '')) failures.push(`reply did not match: ${pattern}`);
  }

  const outcomes = scenario.expected.outcomes ?? [];
  const passedOutcomes = outcomes.filter(outcomeMatches).length;
  if (outcomes.length) {
    scores.outcome = passedOutcomes / outcomes.length;
    for (const assertion of outcomes.filter((item) => !outcomeMatches(item))) failures.push(`outcome assertion failed: ${assertion.path} ${assertion.operator}`);
  }

  const policyCodes = new Set((result.policyDecisions ?? []).map((decision) => decision.code));
  const requiredPolicy = scenario.expected.policy?.requiredDecisionCodes ?? [];
  const forbiddenPolicy = scenario.expected.policy?.forbiddenDecisionCodes ?? [];
  const missingPolicy = requiredPolicy.filter((code) => !policyCodes.has(code));
  const prohibitedPolicy = forbiddenPolicy.filter((code) => policyCodes.has(code));
  if (missingPolicy.length || prohibitedPolicy.length) scores.policy = 0;
  for (const code of missingPolicy) failures.push(`required policy decision missing: ${code}`);
  for (const code of prohibitedPolicy) failures.push(`forbidden policy decision observed: ${code}`);

  const evidence = result.evidence ?? [];
  const evidenceTypes = new Set(evidence.map((item) => item.type));
  const missingEvidence = (scenario.expected.evidence?.requiredTypes ?? []).filter((type) => !evidenceTypes.has(type));
  if (evidence.length < Number(scenario.expected.evidence?.minimumCount ?? 0) || missingEvidence.length) scores.evidence = 0;
  if (evidence.length < Number(scenario.expected.evidence?.minimumCount ?? 0)) failures.push(`evidence count ${evidence.length} was below ${scenario.expected.evidence.minimumCount}`);
  for (const type of missingEvidence) failures.push(`required evidence type missing: ${type}`);

  const efficiency = scenario.expected.efficiency ?? {};
  const totalTokens = Number(result.usage?.inputTokens ?? 0) + Number(result.usage?.outputTokens ?? 0);
  const efficiencyBreaches = [
    efficiency.maxToolCalls !== undefined && toolNames.length > efficiency.maxToolCalls ? `tool calls ${toolNames.length} exceeded ${efficiency.maxToolCalls}` : '',
    efficiency.maxTokens !== undefined && totalTokens > efficiency.maxTokens ? `tokens ${totalTokens} exceeded ${efficiency.maxTokens}` : '',
    efficiency.maxCostUsd !== undefined && Number(result.usage?.costUsd ?? 0) > efficiency.maxCostUsd ? `cost ${result.usage?.costUsd ?? 0} exceeded ${efficiency.maxCostUsd}` : '',
    efficiency.maxLatencyMs !== undefined && Number(result.latencyMs ?? 0) > efficiency.maxLatencyMs ? `latency ${result.latencyMs ?? 0} exceeded ${efficiency.maxLatencyMs}` : '',
  ].filter(Boolean);
  if (efficiencyBreaches.length) scores.efficiency = 0;
  failures.push(...efficiencyBreaches);

  const score = Object.values(scores).reduce((sum, value) => sum + value, 0) / Object.keys(scores).length;
  if (score < Number(scenario.expected.minimumScore ?? 0.8)) failures.push(`composite score ${score.toFixed(3)} was below ${scenario.expected.minimumScore ?? 0.8}`);

  return { diagnostics, failures, passed: failures.length === 0, scenarioId: scenario.id, score, scores };
}
