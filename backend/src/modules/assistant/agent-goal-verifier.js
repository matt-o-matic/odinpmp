import { verifyProjectHealth } from '../governance/project-health-verifier.js';
import { verifyIntegrationDelivery } from '../platform/integration-verifier.js';
import { verifyCommunicationDelivery } from '../mail/communication-verifier.js';
import { verifyResourceFinance } from '../resource-finance/resource-finance-verifier.js';
import { verifyWorkflow } from '../workflows/workflow-verifier.js';

const VERIFIER_TYPES = new Set(['communication.v1', 'integration.v1', 'project_health.v1', 'resource_finance.v1', 'workflow.v1']);
const MAX_PLAN_DEPTH = 8;
const MAX_PLAN_PREDICATES = 64;

function selectRequiredChecks(verification, configuredCheckIds = []) {
  if (!Array.isArray(verification?.checks)) return { ...verification, configured: true, failedCheckIds: [...new Set(configuredCheckIds)], requiredCheckIds: [...new Set(configuredCheckIds)], unknownCheckIds: [...new Set(configuredCheckIds)] };
  const requiredCheckIds = configuredCheckIds.length ? [...new Set(configuredCheckIds)] : verification.checks.map((entry) => entry.id);
  const byId = new Map(verification.checks.map((entry) => [entry.id, entry]));
  const unknownCheckIds = requiredCheckIds.filter((id) => !byId.has(id));
  const failedCheckIds = requiredCheckIds.filter((id) => !byId.get(id)?.passed);
  return { ...verification, configured: true, failedCheckIds, passed: unknownCheckIds.length === 0 && failedCheckIds.length === 0, requiredCheckIds, unknownCheckIds };
}

async function runVerifier({ configuration, executionRepository, goal, governanceRepository, mailRepository, now, platformRepository, projectRepository, resourceFinanceRepository, workflowRepository }) {
  if (!VERIFIER_TYPES.has(configuration.type)) return { configured: true, error: `Unsupported goal verifier: ${configuration.type}.`, passed: false };
  if (configuration.type === 'communication.v1') {
    if (!executionRepository?.listNotifications || !mailRepository?.listEmailsByTargetIds) return { configured: true, error: 'Communication verification requires goal notification and delivery storage.', passed: false };
    const allNotifications = await executionRepository.listNotifications({ goalId: goal.id, tenantId: goal.tenantId });
    const requestedIds = new Set(configuration.criteria?.notificationIds ?? []);
    const notifications = requestedIds.size ? allNotifications.filter((item) => requestedIds.has(item.id)) : allNotifications;
    const deliveries = await mailRepository.listEmailsByTargetIds({ targetIds: notifications.map((item) => item.id) });
    return verifyCommunicationDelivery({ criteria: { ...configuration.criteria, requireNotification: configuration.criteria?.requireNotification === true || requestedIds.size > 0 }, deliveries, notifications });
  }
  if (configuration.type === 'integration.v1') {
    if (!platformRepository?.listSnapshot) return { configured: true, error: 'Integration verification requires platform delivery storage.', passed: false };
    const hasExplicitScope = configuration.criteria?.eventIds?.length || configuration.criteria?.eventTypes?.length || configuration.criteria?.subscriptionIds?.length;
    if (!goal.projectId && !hasExplicitScope) return { configured: true, error: 'Integration verification requires a project or explicit delivery scope.', passed: false };
    return verifyIntegrationDelivery({ criteria: configuration.criteria, projectId: goal.projectId, snapshot: await platformRepository.listSnapshot({ tenantId: goal.tenantId }) });
  }
  if (configuration.type === 'workflow.v1') {
    if (!goal.projectId || !projectRepository?.getProjectDetail || !workflowRepository?.listSnapshot) return { configured: true, error: 'Workflow verification requires a project and workflow storage.', passed: false };
    const [project, snapshot] = await Promise.all([projectRepository.getProjectDetail({ projectId: goal.projectId, tenantId: goal.tenantId }), workflowRepository.listSnapshot({ tenantId: goal.tenantId })]);
    if (!project) return { configured: true, error: 'The goal project no longer exists.', passed: false };
    return verifyWorkflow({ now, project, snapshot });
  }
  if (configuration.type === 'resource_finance.v1') {
    if (!goal.projectId || !resourceFinanceRepository?.listSnapshot) return { configured: true, error: 'Resource and finance verification requires a project and resource-finance storage.', passed: false };
    return verifyResourceFinance({ now, projectId: goal.projectId, snapshot: await resourceFinanceRepository.listSnapshot({ tenantId: goal.tenantId }) });
  }
  if (!goal.projectId || !projectRepository?.getProjectDetail || !governanceRepository?.listSnapshot) return { configured: true, error: 'Project health verification requires a project and governance storage.', passed: false };
  const [project, snapshot] = await Promise.all([projectRepository.getProjectDetail({ projectId: goal.projectId, tenantId: goal.tenantId }), governanceRepository.listSnapshot({ projectId: goal.projectId, tenantId: goal.tenantId })]);
  if (!project) return { configured: true, error: 'The goal project no longer exists.', passed: false };
  return verifyProjectHealth({ now, project, snapshot });
}

function expressionKind(expression) {
  if (expression?.id && expression?.type && expression?.checkId) return 'predicate';
  if (Array.isArray(expression?.all)) return 'all';
  if (Array.isArray(expression?.any)) return 'any';
  if (expression?.not) return 'not';
  return 'invalid';
}

function validatePlanShape(expression, depth = 0, counter = { value: 0 }) {
  if (depth > MAX_PLAN_DEPTH) throw new TypeError(`Verifier plan exceeds maximum depth ${MAX_PLAN_DEPTH}.`);
  const kind = expressionKind(expression);
  if (kind === 'invalid') throw new TypeError('Verifier plan contains an invalid expression.');
  if (kind === 'predicate') {
    counter.value += 1;
    if (counter.value > MAX_PLAN_PREDICATES) throw new TypeError(`Verifier plan exceeds maximum ${MAX_PLAN_PREDICATES} predicates.`);
    return counter.value;
  }
  const children = kind === 'not' ? [expression.not] : expression[kind];
  if (children.length === 0) throw new TypeError(`Verifier ${kind} expressions require at least one child.`);
  for (const child of children) validatePlanShape(child, depth + 1, counter);
  return counter.value;
}

async function evaluatePlanExpression(expression, context, cache, results, depth = 0) {
  if (depth > MAX_PLAN_DEPTH) throw new TypeError(`Verifier plan exceeds maximum depth ${MAX_PLAN_DEPTH}.`);
  const kind = expressionKind(expression);
  if (kind === 'predicate') {
    const cacheKey = `${expression.type}:${JSON.stringify(expression.criteria ?? {})}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, runVerifier({ ...context, configuration: { criteria: expression.criteria ?? {}, type: expression.type } }));
    const verification = await cache.get(cacheKey);
    const check = verification.checks?.find((entry) => entry.id === expression.checkId) ?? null;
    const result = { check, checkId: expression.checkId, error: verification.error ?? (check ? null : `Unknown verifier check: ${expression.checkId}.`), id: expression.id, passed: Boolean(check?.passed), type: expression.type };
    results.push(result);
    return { id: expression.id, kind, passed: result.passed };
  }
  if (kind === 'not') {
    const child = await evaluatePlanExpression(expression.not, context, cache, results, depth + 1);
    return { child, kind, passed: !child.passed };
  }
  const children = [];
  for (const childExpression of expression[kind]) children.push(await evaluatePlanExpression(childExpression, context, cache, results, depth + 1));
  return { children, kind, passed: kind === 'all' ? children.every((child) => child.passed) : children.some((child) => child.passed) };
}

export async function verifyAgentGoalSuccess({ executionRepository, goal, governanceRepository, mailRepository, now = new Date(), platformRepository, projectRepository, resourceFinanceRepository, workflowRepository } = {}) {
  const plan = goal?.success?.plan;
  const configuration = goal?.success?.verifier;
  if (!plan && !configuration) return { configured: false, passed: false };
  const context = { executionRepository, goal, governanceRepository, mailRepository, now, platformRepository, projectRepository, resourceFinanceRepository, workflowRepository };
  if (!plan) return selectRequiredChecks(await runVerifier({ ...context, configuration }), configuration.requiredCheckIds);
  if (plan.version !== 'verifier-plan.v1' || !plan.root) return { configured: true, error: 'Unsupported or invalid verifier plan.', passed: false };
  try {
    validatePlanShape(plan.root);
    const predicateResults = [];
    const evaluation = await evaluatePlanExpression(plan.root, context, new Map(), predicateResults);
    return {
      checks: predicateResults.map((result) => result.check).filter(Boolean),
      configured: true,
      evaluatedAt: now.toISOString(),
      evaluation,
      failedCheckIds: predicateResults.filter((result) => !result.passed).map((result) => result.checkId),
      passed: evaluation.passed,
      planVersion: plan.version,
      predicateResults,
      unknownCheckIds: predicateResults.filter((result) => !result.check).map((result) => result.checkId),
    };
  } catch (error) {
    return { configured: true, error: error.message, passed: false, planVersion: plan.version };
  }
}
