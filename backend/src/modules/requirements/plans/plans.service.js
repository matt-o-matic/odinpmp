import { randomUUID } from 'node:crypto';

import { requireDecisionRights } from '../../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { pendingProposalItemIds } from '../../assistant/agent-chat.service.js';
import { aiNotConfiguredError } from '../ai/requirements-ai-service.js';
import { extractBriefLines, parseActorRef, userActorRef } from '../requirements-topics.js';
import {
  applyPlanEdit,
  buildDecisionCatalog,
  citedDecisionIds,
  epicCriteriaIds,
  epicDecisionIds,
  isActiveDecision,
  planDraftOutputSchema,
  planTitle,
  renderEpicDescription,
  renderPlanMarkdown,
  renderStoryDescription,
  validatePlanDraftOutput,
  validateWorkBreakdown,
  workBreakdownOutputSchema,
} from './plan-content.js';
import { buildPlanDraftModelInput, buildWorkBreakdownModelInput } from './plan-prompt.js';
import { planConflict, revisionConflict, staleCitations, staleCitationsConflict } from './plans.repository.js';

// Track plans. Members with project.plan.edit draft a plan from the
// track's active decisions, edit it, and propose work from it; only admins and managers
// approve it, and the approver owns it. Proposed work goes into the proposer's AI
// Workspace review as pending assistant proposals. Nothing becomes a work item until a
// person applies it there.

// Published on project:{id} with { track, planId, version, reason }. Plans are team-only,
// so client portal channels never get it.
export const REQUIREMENTS_PLAN_EVENT = 'requirements.plans.invalidated';

function clock(deps) {
  return typeof deps?.clock === 'function' ? deps.clock() : new Date();
}

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(404, 'Project not found.');
  return tenantId;
}

async function requireCapability(deps, { capability, projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability, projectId, repository: deps.projectRepository, tenantId, user });
  return tenantId;
}

async function requireRights(deps, { projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  return tenantId;
}

function publishPlanChange(deps, { plan, projectId, reason, user }) {
  deps.liveEventBus?.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    actor: user?.id ? { id: user.id, name: user.name ?? '' } : null,
    planId: plan.id,
    projectId,
    reason,
    track: plan.track,
    type: REQUIREMENTS_PLAN_EVENT,
    version: plan.version,
  });
}

async function loadCatalog(deps, { projectId, tenantId, track }) {
  const decisions = await deps.requirementsRepository.listDecisions({ projectId, tenantId, track });
  return { catalog: buildDecisionCatalog(decisions), decisions };
}

async function requirePlan(deps, { planId, projectId, tenantId }) {
  const plan = await deps.plansRepository.getPlan({ planId, projectId, tenantId });
  if (!plan) throw new HttpError(404, 'Plan not found.');
  return plan;
}

function retryableAiError(status, code, message) {
  return new HttpError(status, code, { details: { code, message, retryable: true } });
}

/** Runs one requirementsPlan call and maps every failure to a retryable error. */
async function callPlanAi(deps, { fn, logName, modelInput, projectId, tenantId, track }) {
  try {
    return await deps.requirementsAiService[fn]({ modelInput, projectId, tenantId, track });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 503) throw aiNotConfiguredError();
    logBackendError({
      context: buildOperationLogContext(logName, { projectId, tenantId, track }),
      error,
      level: 'warn',
      message: 'Requirements plan AI call failed.',
    });
    if (error?.name === 'AiStructuredOutputValidationError') {
      throw retryableAiError(502, 'ai_output_invalid', 'Odin returned the plan in an unexpected shape. Nothing changed. Try again.');
    }
    throw retryableAiError(502, 'ai_request_failed', 'Odin could not finish this request. Nothing changed. Try again.');
  }
}

// ---------------------------------------------------------------------------
// Presentation. No AI-drafted flag, provider, model, or audit record leaves this module;
// the approver is the owner.
// ---------------------------------------------------------------------------

function presentDecisionRefs(ids, catalog) {
  return ids.map((id) => {
    const decision = catalog.byId.get(id) ?? null;
    return {
      id,
      kind: decision?.kind ?? null,
      label: catalog.labelById.get(id) ?? null,
      outcome: decision?.outcome ?? null,
      statement: decision?.statement ?? '',
      status: !decision ? 'missing' : isActiveDecision(decision) ? 'active' : 'superseded',
      topicId: decision?.topicId ?? null,
    };
  });
}

export function presentPlan(plan, { basedOn = null, catalog, proposedWork = undefined } = {}) {
  const cited = citedDecisionIds(plan);
  const approver = plan.approvedBy ? parseActorRef(plan.approvedBy) : null;
  return {
    approvedAt: plan.approvedAt,
    basedOn: basedOn ? { id: basedOn.id, version: basedOn.version } : null,
    body: plan.body,
    createdAt: plan.createdAt,
    criteria: plan.criteria,
    decisions: presentDecisionRefs(cited, catalog),
    id: plan.id,
    nonGoals: plan.content.nonGoals,
    objective: plan.content.objective,
    owner: approver ? { id: approver.actorId, name: plan.approvedByName } : null,
    revision: plan.revision,
    scope: plan.content.scope,
    staleDecisionIds: cited.filter((id) => !isActiveDecision(catalog.byId.get(id))),
    status: plan.status,
    supersededAt: plan.supersededAt,
    title: planTitle(plan.track, plan.version),
    track: plan.track,
    updatedAt: plan.updatedAt,
    version: plan.version,
    ...(proposedWork !== undefined ? { proposedWork } : {}),
  };
}

/**
 * Whether a proposed item exists in the project. Repositories that keep the proposed ids
 * match by id. The MySQL tree writer gives inserted items fresh ids, so an item also
 * matches by kind, title, and the trace its description carries: the plan it came from
 * and, for stories, each acceptance criterion it implements.
 */
function appliedMatcher(project, plan) {
  const marker = `From the ${planTitle(plan.track, plan.version)}.`;
  const epics = project?.epics ?? [];
  const stories = epics.flatMap((epic) => epic.stories ?? []);
  const ids = new Set([...epics, ...stories].map((node) => node.id));
  const sameTitle = (node, item) => String(node.name ?? '').trim() === String(item.title ?? '').trim();
  const traced = (node) => String(node.description ?? '').includes(marker);
  return (item) => {
    if (ids.has(item.itemId)) return true;
    if (item.kind === 'epic') return epics.some((node) => sameTitle(node, item) && traced(node));
    return stories.some((node) => sameTitle(node, item) && traced(node)
      && item.criteriaIds.every((id) => String(node.description ?? '').includes(`- ${id}: `)));
  };
}

function reviewLinkFor({ actionIds, projectId, sessionId }) {
  return {
    actionIds: [...new Set(actionIds)],
    projectId,
    query: { assistant: '1', assistantSessionId: sessionId },
    sessionId,
    surface: 'ai-workspace',
  };
}

/**
 * Proposed work for one plan, per person who proposed it, with each item's live state:
 * applied (the work item exists), pending (still awaiting review in the proposer's AI
 * Workspace session), or dismissed (rejected there, or left out of a commit).
 */
async function loadProposedWork(deps, { plan, projectId, tenantId, user }) {
  const records = await deps.plansRepository.listProposals({ planId: plan.id, projectId, tenantId });
  if (records.length === 0) return [];
  const isApplied = appliedMatcher(await deps.projectRepository.getProjectDetail({ projectId, tenantId }), plan);
  const mine = userActorRef(user.id);

  return Promise.all(records.map(async (record) => {
    const owner = parseActorRef(record.proposedBy);
    const session = await deps.agentChatsRepository?.get({ chatId: record.sessionId, tenantId, userId: owner.actorId }) ?? null;
    const pending = pendingProposalItemIds(session);
    const items = record.items.map((item) => ({
      ...item,
      status: isApplied(item) ? 'applied' : pending.has(item.actionId) ? 'pending' : 'dismissed',
    }));
    const counts = { applied: 0, dismissed: 0, pending: 0 };
    for (const item of items) counts[item.status] += 1;
    const isMine = record.proposedBy === mine;
    return {
      counts,
      items,
      mine: isMine,
      proposedAt: record.updatedAt,
      proposedBy: { id: owner.actorId, name: record.proposedByName },
      reviewLink: isMine && session
        ? reviewLinkFor({ actionIds: items.filter((item) => item.status === 'pending').map((item) => item.actionId), projectId, sessionId: record.sessionId })
        : null,
    };
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPlansForUser(deps, { projectId, track = '', user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const [plans, decisions] = await Promise.all([
    deps.plansRepository.listTrackPlans({ projectId, tenantId, track }),
    deps.requirementsRepository.listDecisions({ projectId, tenantId, track }),
  ]);
  const catalogs = new Map();
  const catalogFor = (planTrack) => {
    if (!catalogs.has(planTrack)) catalogs.set(planTrack, buildDecisionCatalog(decisions.filter((decision) => decision.track === planTrack)));
    return catalogs.get(planTrack);
  };
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  return {
    ok: true,
    plans: plans.map((plan) => presentPlan(plan, { basedOn: byId.get(plan.basedOnId) ?? null, catalog: catalogFor(plan.track) })),
    track: track || null,
  };
}

export async function getPlanForUser(deps, { planId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const plan = await requirePlan(deps, { planId, projectId, tenantId });
  const [{ catalog }, basedOn, proposedWork] = await Promise.all([
    loadCatalog(deps, { projectId, tenantId, track: plan.track }),
    plan.basedOnId ? deps.plansRepository.getPlan({ planId: plan.basedOnId, projectId, tenantId }) : null,
    loadProposedWork(deps, { plan, projectId, tenantId, user }),
  ]);
  return { ok: true, plan: presentPlan(plan, { basedOn, catalog, proposedWork }) };
}

// ---------------------------------------------------------------------------
// Draft plan
// ---------------------------------------------------------------------------

/**
 * Drafts version N+1 of the track's plan from its active decisions, the brief, and the
 * previous version. A failed or uncited draft stores nothing, so the previous version stays
 * current, and the error is retryable.
 */
export async function draftPlanForUser(deps, { projectId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, user });
  if (typeof deps.requirementsAiService?.draftPlan !== 'function') throw aiNotConfiguredError();

  const [{ catalog, decisions }, plans, assistantState, project, clarifications] = await Promise.all([
    loadCatalog(deps, { projectId, tenantId, track }),
    deps.plansRepository.listTrackPlans({ projectId, tenantId, track }),
    deps.assistantRepository.getProjectAssistantState({ projectId, tenantId }),
    deps.projectRepository.getProjectDetail({ projectId, tenantId }),
    deps.assistantRepository.listProjectClarifications({ projectId, tenantId }),
  ]);
  const inputDecisions = decisions
    .filter((decision) => catalog.inputIds.has(decision.id))
    .sort((left, right) => String(catalog.labelById.get(left.id)).localeCompare(String(catalog.labelById.get(right.id)), 'en', { numeric: true }));
  if (inputDecisions.length === 0) {
    throw new HttpError(409, 'no_decisions', {
      details: { code: 'no_decisions', message: 'Record decisions or accept preferences in this track before drafting its plan.' },
    });
  }

  const previous = plans[0] ?? null;
  const modelInput = buildPlanDraftModelInput({
    briefLines: extractBriefLines(assistantState?.brief ?? {}),
    decisions: inputDecisions,
    labelById: catalog.labelById,
    previousPlan: previous,
    projectName: project?.name ?? '',
    topicsById: new Map((clarifications ?? []).map((clarification) => [clarification.id, clarification])),
    track,
  });
  const raw = await callPlanAi(deps, { fn: 'draftPlan', logName: 'requirements.plan.draft', modelInput, projectId, tenantId, track });
  const parsed = planDraftOutputSchema.safeParse(raw?.output);
  if (!parsed.success) {
    throw retryableAiError(502, 'ai_output_invalid', 'Odin returned the plan in an unexpected shape. Nothing changed. Try again.');
  }

  const validated = validatePlanDraftOutput(parsed.data, { catalog, track });
  if (validated.criteria.length === 0) {
    throw new HttpError(502, 'plan_output_uncited', {
      details: {
        code: 'plan_output_uncited',
        dropped: validated.dropped.length,
        message: 'The drafted plan had no acceptance criteria that cite a recorded decision. Nothing changed. Try again.',
        retryable: true,
      },
    });
  }

  const version = (previous?.version ?? 0) + 1;
  const plan = await deps.plansRepository.insertPlanVersion({
    expectedLatestVersion: previous?.version ?? 0,
    plan: {
      audit: {
        dropped: validated.dropped,
        inputDecisionIds: inputDecisions.map((decision) => decision.id),
        model: raw?.model ?? null,
        promptInjectionSignals: modelInput.untrustedContent.promptInjectionSignals,
        provider: deps.requirementsAiService.provider ?? 'custom',
      },
      body: renderPlanMarkdown({ content: validated.content, criteria: validated.criteria, labelById: catalog.labelById, track, version }),
      content: validated.content,
      createdAt: clock(deps),
      createdBy: userActorRef(user.id),
      criteria: validated.criteria,
      track,
    },
    projectId,
    tenantId,
  });

  publishPlanChange(deps, { plan, projectId, reason: 'plan-drafted', user });
  return { dropped: validated.dropped, ok: true, plan: presentPlan(plan, { catalog, proposedWork: [] }) };
}

// ---------------------------------------------------------------------------
// Edit and approve
// ---------------------------------------------------------------------------

/**
 * People edit a draft in place. Editing the approved version creates a new draft version
 * from it instead, so the approved plan never changes underneath its owner.
 */
export async function updatePlanForUser(deps, { input, planId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, user });
  const plan = await requirePlan(deps, { planId, projectId, tenantId });
  if (plan.status === 'superseded') {
    throw planConflict('plan_superseded', 'This plan version was superseded by a newer approved version.');
  }
  if (plan.revision !== input.revision) {
    throw planConflict('plan_revision_conflict', 'This plan changed since you loaded it. Reload and try again.', { currentRevision: plan.revision });
  }

  const { catalog } = await loadCatalog(deps, { projectId, tenantId, track: plan.track });
  const edited = applyPlanEdit(input, { base: plan, catalog, track: plan.track });
  const now = clock(deps);

  if (plan.status === 'draft') {
    const updated = await deps.plansRepository.updateDraft({
      expectedRevision: input.revision,
      now,
      patch: {
        body: renderPlanMarkdown({ ...edited, labelById: catalog.labelById, track: plan.track, version: plan.version }),
        content: edited.content,
        criteria: edited.criteria,
      },
      planId,
      projectId,
      tenantId,
      updatedBy: userActorRef(user.id),
    });
    if (!updated) throw new HttpError(404, 'Plan not found.');
    publishPlanChange(deps, { plan: updated, projectId, reason: 'plan-edited', user });
    const basedOn = updated.basedOnId ? await deps.plansRepository.getPlan({ planId: updated.basedOnId, projectId, tenantId }) : null;
    return { createdVersion: false, ok: true, plan: presentPlan(updated, { basedOn, catalog }) };
  }

  const created = await deps.plansRepository.insertPlanVersion({
    expectedLatestVersion: plan.version,
    plan: {
      audit: { basedOnId: plan.id },
      basedOnId: plan.id,
      body: renderPlanMarkdown({ ...edited, labelById: catalog.labelById, track: plan.track, version: plan.version + 1 }),
      content: edited.content,
      createdAt: now,
      createdBy: userActorRef(user.id),
      criteria: edited.criteria,
      track: plan.track,
    },
    projectId,
    tenantId,
  });
  publishPlanChange(deps, { plan: created, projectId, reason: 'plan-edit-drafted', user });
  return { createdVersion: true, ok: true, plan: presentPlan(created, { basedOn: plan, catalog }) };
}

/**
 * Approves the latest draft at the revision the approver reviewed (`input.revision`). The
 * approver becomes the owner; earlier approved versions and older drafts of the track
 * become superseded. A plan with no acceptance criteria, or one that still cites a
 * superseded decision, cannot be approved.
 */
export async function approvePlanForUser(deps, { input, planId, projectId, user }) {
  const tenantId = await requireRights(deps, { projectId, user });
  const plan = await requirePlan(deps, { planId, projectId, tenantId });
  if (plan.status !== 'draft') {
    throw plan.status === 'approved'
      ? planConflict('plan_already_approved', 'This plan version is already approved.')
      : planConflict('plan_superseded', 'This plan version was superseded by a newer approved version.');
  }
  if (Number(plan.revision) !== Number(input.revision)) throw revisionConflict(plan);
  if (plan.criteria.length === 0) {
    throw planConflict('plan_incomplete', 'Add at least one acceptance criterion before approving the plan.');
  }
  const { catalog, decisions } = await loadCatalog(deps, { projectId, tenantId, track: plan.track });
  const cited = citedDecisionIds(plan);
  const stale = staleCitations(cited, decisions);
  if (stale.length > 0) throw staleCitationsConflict(stale);

  // The repository approves only the revision checked above and checks the citations again
  // under lock, so a concurrent edit or supersede conflicts instead of being approved.
  const result = await deps.plansRepository.approvePlan({
    approvedBy: userActorRef(user.id),
    approvedByName: user.name ?? '',
    citedDecisionIds: cited,
    expectedRevision: plan.revision,
    now: clock(deps),
    planId,
    projectId,
    tenantId,
  });
  if (!result) throw new HttpError(404, 'Plan not found.');

  publishPlanChange(deps, { plan: result.plan, projectId, reason: 'plan-approved', user });
  const basedOn = result.plan.basedOnId ? await deps.plansRepository.getPlan({ planId: result.plan.basedOnId, projectId, tenantId }) : null;
  return { ok: true, plan: presentPlan(result.plan, { basedOn, catalog }), supersededPlanIds: result.superseded };
}

// ---------------------------------------------------------------------------
// Propose work
// ---------------------------------------------------------------------------

function criteriaFor(ids, criteriaById) {
  return ids.map((id) => ({ id, scenario: criteriaById.get(id)?.scenario ?? '' }));
}

function topicIdsFor(decisionIds, catalog) {
  const ids = [];
  for (const id of decisionIds) {
    const topicId = catalog.byId.get(id)?.topicId;
    if (topicId && !ids.includes(topicId)) ids.push(topicId);
  }
  return ids;
}

function proposalMessage({ epics, plan, storyCount }) {
  const newEpics = epics.filter((epic) => !epic.existingEpicId).length;
  const parts = [];
  if (newEpics > 0) parts.push(`${newEpics} new epic${newEpics === 1 ? '' : 's'}`);
  parts.push(`${storyCount} stor${storyCount === 1 ? 'y' : 'ies'}`);
  return `Proposed work from the ${planTitle(plan.track, plan.version)}: ${parts.join(' and ')}. Each story lists the acceptance criteria it implements and the decisions behind them. Review them below; nothing is added to the project until you apply it.`;
}

/**
 * Turns the approved plan's scope and criteria into proposed epics and stories in the
 * caller's AI Workspace review, the same pending-review flow as other assistant proposals.
 * Criteria already implemented by applied work from an earlier proposal are left out.
 */
export async function proposeWorkForUser(deps, { planId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, user });
  const plan = await requirePlan(deps, { planId, projectId, tenantId });
  if (plan.status !== 'approved') {
    throw planConflict('plan_not_approved', 'Approve this plan before proposing work from it.');
  }
  if (typeof deps.requirementsAiService?.proposeWork !== 'function') throw aiNotConfiguredError();

  const [{ catalog }, project, earlier] = await Promise.all([
    loadCatalog(deps, { projectId, tenantId, track: plan.track }),
    deps.projectRepository.getProjectDetail({ projectId, tenantId }),
    deps.plansRepository.listProposals({ planId, projectId, tenantId }),
  ]);
  const isApplied = appliedMatcher(project, plan);
  const covered = [...new Set(earlier
    .flatMap((record) => record.items)
    .filter((item) => item.kind === 'story' && isApplied(item))
    .flatMap((item) => item.criteriaIds))];
  const remaining = plan.criteria.filter((criterion) => !covered.includes(criterion.id));
  if (remaining.length === 0) {
    throw planConflict('plan_work_applied', 'Every acceptance criterion in this plan already has applied work.', { coveredCriteriaIds: covered });
  }

  const existingEpics = (project?.epics ?? []).map((epic, index) => ({ id: epic.id, name: epic.name, ref: `EP${index + 1}` }));
  const modelInput = buildWorkBreakdownModelInput({ criteria: remaining, existingEpics, labelById: catalog.labelById, plan });
  const raw = await callPlanAi(deps, { fn: 'proposeWork', logName: 'requirements.plan.proposeWork', modelInput, projectId, tenantId, track: plan.track });
  const parsed = workBreakdownOutputSchema.safeParse(raw?.output);
  if (!parsed.success) {
    throw retryableAiError(502, 'ai_output_invalid', 'Odin returned the proposed work in an unexpected shape. Nothing changed. Try again.');
  }
  const breakdown = validateWorkBreakdown(parsed.data, { criteria: plan.criteria, excludeCriteriaIds: covered, existingEpics });
  if (breakdown.epics.length === 0) {
    throw new HttpError(502, 'work_output_uncited', {
      details: {
        code: 'work_output_uncited',
        message: 'None of the proposed stories implemented an acceptance criterion of this plan. Nothing changed. Try again.',
        retryable: true,
      },
    });
  }

  const criteriaById = new Map(plan.criteria.map((criterion) => [criterion.id, criterion]));
  const newEpics = [];
  const storiesUnderExisting = [];
  const planned = [];
  for (const epic of breakdown.epics) {
    const storyNodes = epic.stories.map((story) => ({
      entry: story,
      node: {
        description: renderStoryDescription({ catalog, criteriaById, plan, story }),
        id: randomUUID(),
        name: story.title,
        sourceClarificationIds: topicIdsFor(story.decisionIds, catalog),
        status: 'Not Started',
      },
    }));
    if (epic.existingEpicId) {
      storiesUnderExisting.push(...storyNodes.map(({ node }) => ({ node, parentId: epic.existingEpicId })));
      planned.push({ epic, existing: true, id: epic.existingEpicId, storyNodes });
      continue;
    }
    const node = {
      description: renderEpicDescription({ catalog, epic, plan }),
      id: randomUUID(),
      name: epic.title,
      status: 'Not Started',
      stories: storyNodes.map(({ node: storyNode }) => storyNode),
    };
    newEpics.push(node);
    planned.push({ epic, existing: false, id: node.id, storyNodes });
  }

  const previous = earlier.find((record) => record.proposedBy === userActorRef(user.id)) ?? null;
  const storyCount = planned.reduce((total, entry) => total + entry.storyNodes.length, 0);
  const placed = await deps.agentChatService.stageWorkItems({
    chatId: previous?.sessionId ?? null,
    epics: newEpics,
    message: proposalMessage({ epics: breakdown.epics, plan, storyCount }),
    projectId,
    rationale: `From the ${planTitle(plan.track, plan.version)}.`,
    stories: storiesUnderExisting,
    title: `${planTitle(plan.track, plan.version)} · proposed work`,
    user,
    withdrawItemIds: (previous?.items ?? []).map((item) => item.actionId),
  });
  const actionByTarget = new Map(placed.actions.map((action) => [action.targetId, action.id]));

  const items = [];
  for (const entry of planned) {
    const parent = { existing: entry.existing, itemId: entry.id, kind: 'epic', title: entry.epic.title };
    if (!entry.existing) {
      items.push({
        acceptanceCriteria: criteriaFor(epicCriteriaIds(entry.epic), criteriaById),
        actionId: actionByTarget.get(entry.id),
        criteriaIds: epicCriteriaIds(entry.epic),
        itemId: entry.id,
        kind: 'epic',
        parent: null,
        sourceDecisionIds: epicDecisionIds(entry.epic),
        storyCount: entry.storyNodes.length,
        title: entry.epic.title,
      });
    }
    for (const { entry: story, node } of entry.storyNodes) {
      items.push({
        acceptanceCriteria: criteriaFor(story.criteriaIds, criteriaById),
        actionId: entry.existing ? actionByTarget.get(node.id) : actionByTarget.get(entry.id),
        criteriaIds: story.criteriaIds,
        itemId: node.id,
        kind: 'story',
        parent,
        sourceDecisionIds: story.decisionIds,
        storyCount: 0,
        title: story.title,
      });
    }
  }

  await deps.plansRepository.saveProposal({
    now: clock(deps),
    projectId,
    proposal: {
      audit: {
        dropped: breakdown.dropped,
        model: raw?.model ?? null,
        provider: deps.requirementsAiService.provider ?? 'custom',
        uncoveredCriteriaIds: breakdown.uncoveredCriteriaIds,
      },
      items,
      planId: plan.id,
      proposedBy: userActorRef(user.id),
      proposedByName: user.name ?? '',
      sessionId: placed.session.id,
      track: plan.track,
    },
    tenantId,
  });

  publishPlanChange(deps, { plan, projectId, reason: 'work-proposed', user });
  return {
    alreadyAppliedCriteriaIds: covered,
    dropped: breakdown.dropped,
    ok: true,
    planId: plan.id,
    proposals: items.map((item) => ({ ...item, status: 'pending' })),
    reviewLink: reviewLinkFor({ actionIds: placed.actions.map((action) => action.id), projectId, sessionId: placed.session.id }),
    uncoveredCriteriaIds: breakdown.uncoveredCriteriaIds,
  };
}
