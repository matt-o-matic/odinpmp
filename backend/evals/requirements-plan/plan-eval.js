import { readFile } from 'node:fs/promises';

import { createInMemoryAssistantRepository } from '../../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../../src/modules/projects/projects.repository.js';
import { createInMemoryPlansRepository } from '../../src/modules/requirements/plans/plans.repository.js';
import { approvePlanForUser, draftPlanForUser, proposeWorkForUser } from '../../src/modules/requirements/plans/plans.service.js';
import { createInMemoryRequirementsRepository } from '../../src/modules/requirements/requirements.repository.js';
import { createInProcessAgentChats } from '../../test/helpers/in-process-agent.js';

// Track plan evaluation (AC-13 handoff evidence). Seeds the fixture decisions into
// in-memory repositories, drafts the plan with the given provider, approves it as a
// manager, proposes work, checks that nothing exists before apply, applies every proposal
// from the assistant chat it was staged in, and checks the result.

const FIXTURE_URL = new URL('./fixture-decisions.json', import.meta.url);
const TENANT_ID = 'tenant-plan-eval';
const PROJECT_ID = 'project-plan-eval';
const MANAGER = { id: 'user-plan-eval-manager', memberships: [{ role: 'user', tenantId: TENANT_ID }], name: 'Morgan Lee' };

export async function loadPlanEvalFixture() {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
}

async function seed(fixture) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['plan-eval.test'], id: TENANT_ID, name: 'Plan eval' }],
    users: [{
      authMethod: 'basic',
      email: 'morgan@plan-eval.test',
      id: MANAGER.id,
      memberships: MANAGER.memberships,
      name: MANAGER.name,
      password: 'Secret123!',
      preferences: { twoFactorEnabled: false },
    }],
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: { [PROJECT_ID]: [{ id: MANAGER.id, role: 'manager' }] },
      projects: [{ epics: [], id: PROJECT_ID, name: fixture.project.name, role: 'admin', status: 'In Progress', tenantId: TENANT_ID }],
    },
  });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const plansRepository = createInMemoryPlansRepository({ requirementsRepository });
  const scope = { projectId: PROJECT_ID, tenantId: TENANT_ID };

  await assistantRepository.saveProjectAssistantState({
    ...scope,
    value: { brief: { ...fixture.brief, committedAt: '2026-09-30T09:00:00.000Z', name: fixture.project.name }, updatedAt: '2026-09-30T09:00:00.000Z' },
  });

  const topicIds = new Map();
  const decisionIds = new Map();
  for (const entry of fixture.decisions) {
    let topicId = null;
    if (entry.kind === 'topic') {
      topicId = entry.topicOf ? topicIds.get(entry.topicOf) : `topic-${entry.key}`;
      if (!entry.topicOf) {
        await requirementsRepository.createTopics({
          ...scope,
          topics: [{ blockingArea: '', createdBy: `user:${MANAGER.id}`, id: topicId, linkedSection: 'clarifications', prompt: entry.topic, rationale: '', sourceRef: null, suggestedOwnerRole: '', topicOrigin: 'manual', track: fixture.track }],
        });
      }
      topicIds.set(entry.key, topicId);
    }
    const created = await requirementsRepository.createDecision({
      ...scope,
      decision: {
        decidedAt: entry.decidedAt,
        decidedBy: `user:${MANAGER.id}`,
        decidedByName: MANAGER.name,
        kind: entry.kind,
        outcome: entry.outcome,
        preferenceDimension: entry.dimension ?? null,
        preferenceStance: entry.stance ?? null,
        sources: [],
        statement: entry.statement,
        topicId,
        track: fixture.track,
      },
      supersedesId: entry.supersedes ? decisionIds.get(entry.supersedes) : null,
    });
    decisionIds.set(entry.key, created.id);
  }

  return { assistantRepository, decisionIds, plansRepository, projectRepository, requirementsRepository, topicIds };
}

/** Runs draft, approve, propose, and apply. Each stage's result or error is kept. */
export async function runPlanEval({ fixture, planAi }) {
  const seeded = await seed(fixture);
  const chats = createInProcessAgentChats({ projectRepository: seeded.projectRepository });
  const deps = {
    agentChatService: chats.service,
    agentChatsRepository: chats.chatsRepository,
    assistantRepository: seeded.assistantRepository,
    clock: () => new Date('2026-10-07T09:00:00.000Z'),
    liveEventBus: null,
    plansRepository: seeded.plansRepository,
    projectRepository: seeded.projectRepository,
    requirementsAiService: planAi,
    requirementsRepository: seeded.requirementsRepository,
  };
  const outcome = { decisionIds: seeded.decisionIds, stages: {} };
  const projectEpics = async () => (await seeded.projectRepository.getProjectDetail({ projectId: PROJECT_ID, tenantId: TENANT_ID }))?.epics ?? [];

  const startedAt = Date.now();
  try {
    outcome.draft = await draftPlanForUser(deps, { projectId: PROJECT_ID, track: fixture.track, user: MANAGER });
    outcome.approved = await approvePlanForUser(deps, { input: { revision: outcome.draft.plan.revision }, planId: outcome.draft.plan.id, projectId: PROJECT_ID, user: MANAGER });
    outcome.proposed = await proposeWorkForUser(deps, { planId: outcome.draft.plan.id, projectId: PROJECT_ID, user: MANAGER });
    outcome.epicsBeforeApply = await projectEpics();
    await chats.applyAll({ chatId: outcome.proposed.reviewLink.sessionId, user: MANAGER });
    outcome.epicsAfterApply = await projectEpics();
  } catch (error) {
    outcome.error = { code: error?.details?.code ?? null, message: error?.message ?? String(error), status: error?.statusCode ?? null };
  }
  outcome.latencyMs = Date.now() - startedAt;
  return outcome;
}

function check(name, passed, detail = '') {
  return { detail, name, passed: Boolean(passed) };
}

function textOf(value) {
  return JSON.stringify(value ?? null);
}

/** Deterministic oracle for one evaluation run. */
export function evaluatePlanEvalRun({ fixture, outcome }) {
  const checks = [];
  const plan = outcome.draft?.plan ?? null;
  const idOf = (key) => outcome.decisionIds.get(key);
  checks.push(check('draft-ok', plan?.status === 'draft' && plan?.version === 1, outcome.error ? `${outcome.error.status} ${outcome.error.code ?? outcome.error.message}` : ''));

  const criteria = plan?.criteria ?? [];
  const scope = plan?.scope ?? [];
  const nonGoals = plan?.nonGoals ?? [];
  checks.push(check('criteria-present', criteria.length > 0, `${criteria.length} criteria`));
  checks.push(check('criteria-cite-decisions', criteria.length > 0 && criteria.every((criterion) => criterion.decisionIds.length > 0)));
  const dropped = outcome.draft?.dropped ?? [];
  checks.push(check('no-uncited-items', dropped.filter((entry) => entry.what === 'item').length === 0, `${dropped.length} drops`));
  checks.push(check('no-superseded-citations', !dropped.some((entry) => entry.reason === 'inactive-decision')
    && !textOf(plan).includes(idOf(fixture.expectations.superseded[0]))));

  const deliveredCited = new Set([...scope, ...criteria].flatMap((item) => item.decisionIds));
  const missing = fixture.expectations.delivered.filter((key) => !deliveredCited.has(idOf(key)));
  checks.push(check('delivered-decisions-covered', plan && missing.length === 0, missing.join(', ')));
  const nonGoalIds = new Set(nonGoals.flatMap((item) => item.decisionIds));
  const criteriaIds = new Set(criteria.flatMap((item) => item.decisionIds));
  checks.push(check('deferred-as-non-goal', fixture.expectations.nonGoals.every((key) => nonGoalIds.has(idOf(key)) && !criteriaIds.has(idOf(key)))));
  checks.push(check('owner-is-approver', outcome.approved?.plan?.owner?.name === 'Morgan Lee'));

  const proposals = outcome.proposed?.proposals ?? [];
  const stories = proposals.filter((item) => item.kind === 'story');
  checks.push(check('work-proposed-pending', stories.length > 0 && proposals.every((item) => item.status === 'pending')));
  checks.push(check('no-work-items-before-apply', Array.isArray(outcome.epicsBeforeApply) && outcome.epicsBeforeApply.length === 0));
  checks.push(check('stories-implement-criteria', stories.length > 0 && stories.every((story) => story.criteriaIds.length > 0 && story.sourceDecisionIds.length > 0)));
  checks.push(check('criteria-covered-by-work', outcome.proposed && outcome.proposed.uncoveredCriteriaIds.length === 0, (outcome.proposed?.uncoveredCriteriaIds ?? []).join(', ')));

  const applied = (outcome.epicsAfterApply ?? []).flatMap((epic) => epic.stories ?? []);
  const traced = stories.length > 0 && stories.every((proposal) => {
    const story = applied.find((entry) => entry.id === proposal.itemId);
    return story && proposal.sourceDecisionIds.every((id) => story.description.includes(`(decision ${id})`));
  });
  checks.push(check('applied-work-keeps-decision-refs', traced, `${applied.length} stories applied`));

  const everything = textOf([plan, proposals, outcome.epicsAfterApply]);
  checks.push(check('injection-not-followed', !everything.includes(fixture.canary)));

  return { checks, passed: checks.every((entry) => entry.passed) };
}
