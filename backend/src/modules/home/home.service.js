import { mapWithConcurrency } from '../../lib/async/map-with-concurrency.js';
import { PROJECT_CAPABILITIES, getTenantMembership, hasProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { STAGED_FOR_APPROVAL_ORIGIN } from '../assistant/assistant-recovery-actions.js';
import { wrapProjectRepositoryForAssistant } from '../assistant/assistant-ticket-visibility.js';
import { analyzeProjectSchedule } from '../governance/schedule-analysis.js';
import { getContributorLeaderboardForUser } from '../metrics/metrics.service.js';
import { workflowDoneStatesFromSnapshot } from '../metrics/work-completion-metrics.js';
import { collectMyItemsWithoutRefresh } from '../requirements/requirements.service.js';
import { addDays, dateOnly } from './home-dates.js';
import {
  alertCandidates,
  approvalCandidates,
  buildTabs,
  canEditProject,
  FOCUS_MAX,
  ownWorkCandidates,
  rankHomeItems,
  requirementsCandidates,
  riskCandidates,
  scheduleCandidates,
  teamCandidates,
  workspaceCandidates,
} from './home-focus.js';
import { flattenProjectItems } from './home-items.js';
import { HOME_LENS, HOME_LENSES } from './home-lenses.js';
import {
  CHANGE_TREND_DAYS,
  LEADERBOARD_DAYS,
  changeTrendsFrom,
  leaderboardFrom,
  myWorkCounts,
  railSprints,
  teamCounts,
  workspaceCounts,
} from './home-rail.js';
import { generateRecoveryProposals, presentProposal, selectProposals } from './home-recovery.js';
import { evaluateActiveSprints } from './home-sprints.js';
import { buildHomeStatus } from './home-status.js';

// GET /api/home: one payload for the signed-in person's home, in place of a call per project.
// Each project's reads run at most HOME_PROJECT_CONCURRENCY at a time, for at most
// HOME_PROJECT_LIMIT projects (in rank order). Requirements are read without queuing summary
// refreshes. A source that fails is reported in `sources` and the rest still rank.

export const HOME_PROJECT_LIMIT = 50;
export const HOME_PROJECT_CONCURRENCY = 4;

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function settle(promise) {
  return Promise.resolve(promise).then((value) => value, (error) => (error instanceof Error ? error : new Error(String(error))));
}

function failed(value) {
  return value instanceof Error;
}

function createSourceTracker({ tenantId, userId }) {
  const sources = new Map();
  const entry = (key) => {
    if (!sources.has(key)) sources.set(key, { failedProjectIds: [], key, status: 'ok' });
    return sources.get(key);
  };
  return {
    fail(key, error, projectId = null) {
      const source = entry(key);
      source.status = 'error';
      if (projectId && !source.failedProjectIds.includes(projectId)) source.failedProjectIds.push(projectId);
      logBackendError({
        context: buildOperationLogContext('home.source', { projectId, source: key, tenantId, userId }),
        error,
        level: 'warn',
        message: 'A Home source failed to load.',
      });
    },
    list() {
      return [...sources.values()];
    },
    ok(key) {
      entry(key);
    },
    record(key, value, projectId = null) {
      if (failed(value)) this.fail(key, value, projectId);
      else this.ok(key);
      return failed(value) ? null : value;
    },
  };
}

// Team view: tenant managers manage every project they see; others the projects where they
// hold the project manager or project admin role.
function managesProject(tenantRole, projectRole) {
  return String(tenantRole).toLowerCase() === 'manager' || ['admin', 'manager'].includes(String(projectRole ?? '').toLowerCase());
}

// What each view reads per project beyond its detail, open sprints and governance.
const LENS_NEEDS = Object.freeze({
  [HOME_LENS.MY_WORK]: Object.freeze({ analysis: true, relations: true, requirements: true }),
  [HOME_LENS.TEAM]: Object.freeze({ analysis: true, relations: true, requirements: true }),
  // The workspace view counts behind sprints, which needs items, sprints and the calendar.
  [HOME_LENS.WORKSPACE]: Object.freeze({ analysis: false, relations: false, requirements: false }),
});

/**
 * The viewer, their workspace role, and the projects Home may read: visible and not archived,
 * at most HOME_PROJECT_LIMIT in rank order, each checked for read access (one query each).
 * Views are decided from this before any project's data is read.
 */
async function loadHomeAccess(deps, { user }) {
  const tenantId = tenantIdFor(user);
  const tenantRole = String(getTenantMembership(user, tenantId)?.role ?? 'user').toLowerCase();
  const sources = createSourceTracker({ tenantId, userId: user.id });
  const listed = await settle(deps.projectRepository.listProjectsForTenant({ tenantId, user }));
  const visible = (sources.record('projects', listed) ?? []).filter((project) => project.status !== 'Archived');
  const checked = await mapWithConcurrency(visible.slice(0, HOME_PROJECT_LIMIT), HOME_PROJECT_CONCURRENCY, async (summary) => {
    const access = await settle(deps.projectRepository.getProjectAccess({ projectId: summary.id, tenantId, userId: user.id }));
    if (failed(access)) {
      sources.fail('projects', access, summary.id);
      return null;
    }
    const readable = access?.exists && hasProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectRole: access.projectRole, tenantRole, userCapabilities: user.capabilities });
    return readable ? { managed: managesProject(tenantRole, access.projectRole), projectRole: access.projectRole ?? null, summary } : null;
  });
  const projects = checked.filter(Boolean);
  return { lenses: availableLenses({ projects, tenantRole }), projects, sources, tenantId, tenantRole, total: visible.length, visibleProjectIds: visible.map((project) => project.id) };
}

async function loadProjectContext(deps, { histories, needs, project, sources, tenantId, tenantRole, user, workflowState }) {
  const { projectRole, summary } = project;
  const projectId = summary.id;
  const repository = deps.projectRepository;
  // One project's reads run one after another, so HOME_PROJECT_CONCURRENCY projects hold at
  // most that many pool connections at a time.
  const detail = await settle(repository.getProjectDetail({ projectId, tenantId }));
  if (failed(detail) || !detail) {
    if (failed(detail)) sources.fail('projects', detail, projectId);
    return null;
  }
  sources.ok('projects');
  const sprints = sources.record('sprints', await settle(repository.listOpenSprints ? repository.listOpenSprints({ projectId, tenantId }) : { sprints: [] }), projectId);
  const governance = sources.record('governance', await settle(deps.governanceRepository?.listSnapshot ? deps.governanceRepository.listSnapshot({ latestBaselineOnly: true, projectId, tenantId }) : null), projectId);
  const relations = needs.relations
    ? sources.record('relations', await settle(repository.listWorkItemRelations ? repository.listWorkItemRelations({ projectId, tenantId }) : []), projectId)
    : [];
  const myItems = needs.requirements
    ? sources.record('requirements', await settle(deps.requirements?.requirementsRepository ? collectMyItemsWithoutRefresh(deps.requirements, { projectId, tenantId, user }) : null), projectId)
    : null;

  let analysis = null;
  if (governance && needs.analysis) {
    try {
      analysis = analyzeProjectSchedule(detail, governance.dependencies ?? [], { baseline: governance.scheduleBaselines?.[0] ?? null, calendar: governance.workingCalendar, milestones: governance.milestones ?? [] });
    } catch (error) {
      sources.fail('governance', error, projectId);
    }
  }
  const items = flattenProjectItems(detail, workflowState ? workflowDoneStatesFromSnapshot(workflowState, projectId) : null);
  const members = new Map();
  for (const item of items) if (item.assigneeId && item.assigneeName && !members.has(item.assigneeId)) members.set(item.assigneeId, item.assigneeName);
  return {
    analysis,
    calendar: governance?.workingCalendar ?? null,
    canEdit: canEditProject(user, tenantRole, projectRole),
    governance,
    histories,
    items,
    itemsById: new Map(items.map((item) => [item.id, item])),
    managed: project.managed,
    members,
    myItems,
    project: { endDate: dateOnly(detail.endDate ?? summary.endDate), id: projectId, name: detail.name ?? summary.name ?? 'Project', status: detail.status ?? summary.status ?? '' },
    projectRole,
    relations: relations ?? [],
    sprints: (sprints?.sprints ?? []).map((sprint) => ({ ...sprint, staffing: sprint.staffing ?? [] })),
  };
}

// Leaves out approvals on tickets an agent may not see. With those tickets gone from each
// project's items, a ticket approval whose item is missing is on a hidden or deleted ticket.
function withoutHiddenTicketApprovals(workflowState, contexts) {
  if (!workflowState?.approvals?.length) return workflowState;
  const byProject = new Map(contexts.map((ctx) => [ctx.project.id, ctx]));
  const approvals = workflowState.approvals.filter((approval) => approval.itemType !== 'ticket' || byProject.get(approval.projectId)?.itemsById.has(approval.itemId));
  return { ...workflowState, approvals };
}

/**
 * Everything Home reads per project for one view, for the projects loadHomeAccess allowed. An
 * agent's view reads each project without the tickets agents may not see, so no card,
 * count or total comes from one: not their own cards, nor blockers or approvals on them.
 */
async function loadHomeContext(deps, access, { agentView = false, needs, now, user }) {
  const { projects, sources, tenantId, tenantRole } = access;
  const projectIds = projects.map((project) => project.summary.id);
  const workflowState = sources.record('workflows', await settle(deps.workflowRepository?.listProjectWorkflowState
    ? deps.workflowRepository.listProjectWorkflowState({ now, projectIds, tenantId })
    : null));
  // Grouped once, so each project sees only its own overdue transitions.
  const historiesByProject = new Map();
  for (const history of workflowState?.histories ?? []) {
    if (!historiesByProject.has(history.projectId)) historiesByProject.set(history.projectId, []);
    historiesByProject.get(history.projectId).push(history);
  }
  const projectDeps = agentView ? { ...deps, projectRepository: wrapProjectRepositoryForAssistant(deps.projectRepository) } : deps;
  const loaded = await mapWithConcurrency(projects, HOME_PROJECT_CONCURRENCY, (project) => loadProjectContext(projectDeps, {
    histories: historiesByProject.get(project.summary.id) ?? [],
    needs,
    project,
    sources,
    tenantId,
    tenantRole,
    user,
    workflowState,
  }));
  const contexts = loaded.filter(Boolean);
  return {
    contexts,
    now,
    projectCount: access.total,
    sources,
    tenantId,
    tenantRole,
    today: dateOnly(now),
    truncated: access.total > HOME_PROJECT_LIMIT,
    workflowState: agentView ? withoutHiddenTicketApprovals(workflowState, contexts) : workflowState,
  };
}

export function availableLenses({ projects, tenantRole }) {
  const lenses = [HOME_LENS.MY_WORK];
  if (tenantRole === 'manager' || projects.some((project) => project.managed)) lenses.push(HOME_LENS.TEAM);
  if (tenantRole === 'admin') lenses.push(HOME_LENS.WORKSPACE);
  return lenses;
}

async function storedHomeLens(deps, user) {
  try {
    const profile = deps.usersRepository?.getProfile ? await deps.usersRepository.getProfile({ userId: user.id }) : null;
    return profile?.preferences?.homeLens ?? user.preferences?.homeLens ?? null;
  } catch (_error) {
    // The saved view is a convenience; Home still opens on the default one.
    return user.preferences?.homeLens ?? null;
  }
}

function defaultLens(lenses, stored) {
  if (stored && lenses.includes(stored)) return stored;
  if (lenses.includes(HOME_LENS.WORKSPACE)) return HOME_LENS.WORKSPACE;
  if (lenses.includes(HOME_LENS.TEAM)) return HOME_LENS.TEAM;
  return HOME_LENS.MY_WORK;
}

function requireLens(lens, lenses) {
  if (!lenses.includes(lens)) throw new HttpError(403, 'That Home view is not available to you.', { details: { code: 'home_lens_unavailable', lenses } });
  return lens;
}

function lensContexts(context, lens) {
  return lens === HOME_LENS.TEAM ? context.contexts.filter((ctx) => ctx.managed) : context.contexts;
}

function allMembers(contexts) {
  const members = new Map();
  for (const ctx of contexts) for (const [id, name] of ctx.members) if (!members.has(id)) members.set(id, name);
  return members;
}

/** The status for a lens and, when someone is behind there, every proposal for them. */
function statusAndProposals(context, lens, viewer) {
  const scope = lensContexts(context, lens);
  const sprints = evaluateActiveSprints(scope, context.today);
  const { status, subject } = buildHomeStatus({ lens, members: allMembers(scope), sprints, today: context.today, viewer });
  const proposals = subject ? generateRecoveryProposals({ entry: subject.entry, subject: subject.subject, today: context.today, viewer }) : [];
  return { proposals, sprints, status, subject };
}

function candidatesFor(lens, context, { alerts, viewerId, workspace }) {
  const { contexts, now, today, workflowState } = context;
  if (lens === HOME_LENS.WORKSPACE) return workspaceCandidates({ ...workspace, now, today, viewerId });
  const candidates = [
    ...contexts.flatMap((ctx) => ownWorkCandidates(ctx, { histories: ctx.histories, now, today, viewerId })),
    ...contexts.flatMap((ctx) => requirementsCandidates(ctx, { lens, today })),
    ...contexts.flatMap((ctx) => riskCandidates(ctx, { lens, viewerId })),
    ...alertCandidates(alerts ?? [], contexts),
  ];
  if (lens === HOME_LENS.TEAM) {
    const managed = lensContexts(context, lens);
    candidates.push(
      ...managed.flatMap((ctx) => teamCandidates(ctx, { histories: ctx.histories, now, today, viewerId })),
      ...managed.flatMap((ctx) => scheduleCandidates(ctx, { today })),
      ...approvalCandidates(managed, { now, tenantRole: context.tenantRole, viewerId, workflowSnapshot: workflowState }),
    );
  }
  return candidates;
}

async function loadWorkspaceSources(deps, { sources, tenantId, user }) {
  const [identity, platform, connectors, members] = await Promise.all([
    settle(deps.identityRepository?.listSnapshot ? deps.identityRepository.listSnapshot({ tenantId }) : null),
    settle(deps.platformRepository?.listSnapshot ? deps.platformRepository.listSnapshot({ tenantId }) : null),
    settle(deps.connectorRepository?.listSnapshot ? deps.connectorRepository.listSnapshot({ tenantId }) : null),
    settle(deps.tenantsRepository?.listExistingUsers ? deps.tenantsRepository.listExistingUsers({ tenantId, user }) : null),
  ]);
  const memberList = sources.record('members', members);
  return {
    connectors: sources.record('connectors', connectors),
    identity: sources.record('identity', identity),
    members: memberList,
    platform: sources.record('integrations', platform),
    userNames: new Map((memberList ?? []).map((member) => [member.id, member.name])),
  };
}

function viewerOf(user) {
  return { id: user.id, name: String(user.name ?? '').trim() };
}

export async function getHomeForUser(deps, { agentView = false, lens: requestedLens = null, user }) {
  const now = deps.homeClock?.() ?? new Date();
  const access = await loadHomeAccess(deps, { user });
  const { lenses } = access;
  const preferred = defaultLens(lenses, await storedHomeLens(deps, user));
  const lens = requestedLens ? requireLens(requestedLens, lenses) : preferred;
  const context = await loadHomeContext(deps, access, { agentView, needs: LENS_NEEDS[lens], now, user });
  const { contexts, sources, tenantId, today } = context;
  const viewer = viewerOf(user);

  // The leaderboard and change trends are counted ahead of time, hidden tickets included, so the
  // agent view goes without them.
  const [alerts, leaderboard, changes, workspace] = await Promise.all([
    lens === HOME_LENS.WORKSPACE ? null : settle(deps.agentExecutionRepository?.listNotifications ? deps.agentExecutionRepository.listNotifications({ ownerUserId: user.id, status: 'unread', tenantId }) : []),
    agentView ? null : settle(deps.metricsRepository ? getContributorLeaderboardForUser(user, { days: LEADERBOARD_DAYS }, deps.metricsRepository, deps.authRepository, deps.projectRepository) : null),
    agentView ? null : settle(deps.reportingRepository?.getReportingAnalytics
      ? deps.reportingRepository.getReportingAnalytics({ projectIds: access.visibleProjectIds, since: addDays(today, -(CHANGE_TREND_DAYS - 1)), tenantId }).then((facts) => ({ facts }))
      : null),
    lens === HOME_LENS.WORKSPACE ? loadWorkspaceSources(deps, { sources, tenantId, user }) : null,
  ]);
  const unread = alerts == null ? [] : sources.record('alerts', alerts) ?? [];
  const visibleAlerts = unread.filter((alert) => !alert.projectId || contexts.some((ctx) => ctx.project.id === alert.projectId));

  // The workspace view counts behind sprints but proposes nothing: their managers do.
  const { proposals, sprints, status, subject } = statusAndProposals(context, lens, viewer);
  const { focus, items } = rankHomeItems(candidatesFor(lens, context, { alerts: visibleAlerts, viewerId: user.id, workspace }));
  const tabs = buildTabs(lens, items);

  let counts;
  if (lens === HOME_LENS.WORKSPACE) counts = workspaceCounts(workspace);
  else if (lens === HOME_LENS.TEAM) counts = teamCounts({ approvals: items.filter((item) => item.kind === 'approval'), contexts: lensContexts(context, lens), sprints });
  else counts = myWorkCounts({ alerts: visibleAlerts, contexts, today, viewerId: user.id });

  return {
    asOf: now.toISOString(),
    focus: { items: focus.slice(0, FOCUS_MAX), total: focus.length },
    items: tabs.items,
    ok: true,
    rail: {
      changeTrends: !agentView && sources.record('changes', changes) ? changeTrendsFrom(changes, today) : null,
      counts,
      leaderboard: !agentView && sources.record('leaderboard', leaderboard) ? leaderboardFrom(leaderboard) : null,
      sprints: railSprints({ lens, sprints, viewerId: user.id }),
    },
    recovery: {
      generatedAt: now.toISOString(),
      mode: 'hybrid',
      proposals: selectProposals(proposals).map(presentProposal),
      subject: subject ? { personId: subject.subject.personId ?? null, projectId: subject.entry.ctx.project.id, scope: subject.subject.scope, sprintId: subject.entry.sprint.id } : null,
    },
    sources: sources.list(),
    status,
    tabs: tabs.tabs,
    viewer: {
      defaultLens: preferred,
      id: user.id,
      lens,
      lenses,
      managedProjectCount: access.projects.filter((project) => project.managed).length,
      name: viewer.name,
      projectCount: context.projectCount,
      projectsTruncated: context.truncated,
      tenantRole: context.tenantRole,
      twoFactorEnabled: Boolean(user.preferences?.twoFactorEnabled),
    },
  };
}

export async function saveHomeLensForUser(deps, { lens, user }) {
  requireLens(lens, (await loadHomeAccess(deps, { user })).lenses);
  if (!deps.usersRepository?.updatePreferences) throw new HttpError(503, 'Preferences cannot be saved right now.');
  const saved = await deps.usersRepository.updatePreferences({ preferences: { homeLens: lens }, userId: user.id });
  if (!saved) throw new HttpError(404, 'User not found.');
  return { lens, ok: true };
}

function stageMessage(proposal, status) {
  const evidence = (status.evidence ?? []).map((entry) => `- ${entry.label}`).join('\n');
  return [
    `**${proposal.summary}**`,
    `${status.headline}. ${proposal.detail} ${proposal.impact.text}`.trim(),
    evidence ? `Why Odin suggested it:\n${evidence}` : '',
    `What changes when you apply it: ${proposal.stage.rationaleSummary}`,
    'Nothing has changed yet. Apply or dismiss it below, or ask me about the trade-offs first.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Stages one recovery proposal into a new AI Workspace session. The proposals are worked out
 * again here from current data, so an id that no longer exists (the data moved on) or that
 * the person may not apply is refused; the client never sends a proposal body. Staging the
 * same proposal again reopens the session it already went to while that change is pending.
 */
export async function stageHomeRecoveryForUser(deps, { proposalId, user }) {
  const now = deps.homeClock?.() ?? new Date();
  const access = await loadHomeAccess(deps, { user });
  const context = await loadHomeContext(deps, access, { needs: LENS_NEEDS[HOME_LENS.MY_WORK], now, user });
  const viewer = viewerOf(user);
  const lenses = access.lenses.filter((lens) => lens !== HOME_LENS.WORKSPACE);
  let match = null;
  for (const lens of lenses) {
    const { proposals, status } = statusAndProposals(context, lens, viewer);
    const proposal = proposals.find((candidate) => candidate.id === proposalId);
    if (proposal) {
      match = { proposal, status };
      break;
    }
  }
  if (!match) throw new HttpError(404, 'This proposal is out of date. Reload Home to see the current options.', { details: { code: 'home_proposal_stale' } });
  const { proposal, status } = match;
  if (!proposal.permitted) throw new HttpError(403, proposal.blockedReason ?? 'You may not make this change.', { details: { code: 'home_proposal_not_permitted' } });

  // Staging the same proposal again reopens the chat it went to while it is still pending.
  const staged = await deps.agentChatService.stageRecovery({
    action: { ...proposal.stage, origin: { homeProposalId: proposalId, kind: STAGED_FOR_APPROVAL_ORIGIN, type: proposal.type } },
    message: stageMessage(proposal, status),
    projectId: proposal.projectId,
    rationale: `Home recovery proposal: ${proposal.summary}.`,
    title: proposal.summary.slice(0, 120),
    user,
  });
  return { assistantSessionId: staged.chatId, ok: true, reused: staged.reused };
}

export { HOME_LENSES };
