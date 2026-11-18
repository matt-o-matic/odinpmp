import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { pursuitItemIds, withoutPursuitWork } from '../../lib/projects/pursuit.js';
import { filterProjectTicketsForAssistant, isTicketVisibleToAssistant } from '../assistant/assistant-ticket-visibility.js';
import { analyzeProjectSchedule, normalizeWorkingCalendar } from '../governance/schedule-analysis.js';
import {
  buildBurnupCard,
  buildCumulativeFlowCard,
  buildHeadlineCard,
  buildHealth,
  buildMilestonesCard,
  buildSprintBurndownCard,
  buildThroughputCard,
  buildTicketFlowCard,
  buildTicketsBySeverityCard,
  buildVelocityCard,
  readyCard,
} from './insights-cards.js';
import { buildEarnedValueCard } from './insights-finance.js';
import { buildGanttCard } from './insights-gantt.js';
import { addDays, collectProjectItems, dateOnly, daysBetween } from './insights-history.js';
import {
  REPORT_CARD_TYPE,
  canEditInsightsLayout,
  canSeeFinance,
  effectiveInsightsLayout,
  normalizeInsightsCards,
} from './insights-layout.js';
import { getInsightsReportCard, listProjectReports, reportVisibleOnProject } from './insights-reports.js';

// History reaches back at least half a year so velocity can replay older sprints exactly.
export const HISTORY_LOOKBACK_DAYS = 182;

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function settle(promise) {
  return Promise.resolve(promise).then((value) => value, (error) => (error instanceof Error ? error : new Error(String(error))));
}

function unwrap(value) {
  if (value instanceof Error) throw value;
  return value;
}

function cardError(error, cardType, logContext) {
  logBackendError(error, { context: buildOperationLogContext('insights.card', { ...logContext, cardType }) });
  return { data: null, message: 'This card could not be loaded. Other cards are unaffected.', status: 'error' };
}

async function authorize({ projectId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const access = await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  return { projectRole: access?.projectRole ?? null, tenantId };
}

function sprintRows(payload) {
  return (payload?.sprints ?? []).map((sprint) => ({
    endDate: dateOnly(sprint.endDate),
    id: sprint.id,
    name: sprint.name ?? '',
    staffing: sprint.staffing ?? [],
    startDate: dateOnly(sprint.startDate),
    status: sprint.status ?? 'planned',
  }));
}

/**
 * The tickets agents may not see (D-027), live or deleted. A live ticket is judged by its state
 * now, so one validated since counts in history too; a deleted one by the state its last revision
 * recorded, and stays hidden when none was recorded.
 */
async function hiddenTicketIds({ insightsRepository, project, projectId, tenantId }) {
  const live = new Map((project?.tickets ?? []).map((ticket) => [ticket.id, isTicketVisibleToAssistant(ticket)]));
  const hidden = new Set([...live].filter(([, visible]) => !visible).map(([itemId]) => itemId));
  for (const { externalReviewState, itemId } of await insightsRepository.listTicketReviewStates({ projectId, tenantId })) {
    if (!live.has(itemId) && !(externalReviewState && isTicketVisibleToAssistant({ externalReviewState }))) hidden.add(itemId);
  }
  return hidden;
}

/**
 * Insights for one project. An agent's view (D-027) is built as if the tickets agents may not see
 * never existed: they are left out of the project, its links and its history, and contributor
 * totals, which count ticket work without saying which ticket, give way to totals from that history.
 */
export async function getProjectInsightsForUser({ agentView = false, deps, input, projectId, user }) {
  const { governanceRepository, insightsRepository, metricsRepository, projectRepository, reportingRepository, resourceFinanceRepository } = deps;
  const { projectRole, tenantId } = await authorize({ projectId, projectRepository, user });
  const now = deps.insightsClock?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const windowStart = addDays(today, -(input.days - 1));
  const historySince = addDays(today, -Math.max(input.days, HISTORY_LOOKBACK_DAYS));
  const financeAuthorized = canSeeFinance(user, tenantId);

  // Delivery work only. Pursuit items' history is left out too, so they never reappear on past
  // days of a converted engagement's charts (src/lib/projects/pursuit.js).
  const loaded = projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  const detail = loaded.then(withoutPursuitWork);
  const hidden = Promise.all([loaded, agentView ? detail.then((project) => hiddenTicketIds({ insightsRepository, project, projectId, tenantId })) : new Set()])
    .then(([project, tickets]) => new Set([...tickets, ...pursuitItemIds(project)]));
  const [fullProject, governance, sprintPayload, storedLayout, history, metricsRows, financeSnapshot, reportingSnapshot, allRelations, hiddenIds] = await Promise.all([
    detail,
    settle(governanceRepository?.listSnapshot ? governanceRepository.listSnapshot({ projectId, tenantId }) : { dependencies: [], items: [], milestones: [] }),
    settle(projectRepository.listProjectSprints ? projectRepository.listProjectSprints({ projectId, tenantId }) : { sprints: [] }),
    insightsRepository.getLayout({ projectId, tenantId }),
    settle(hidden.then((excluded) => insightsRepository.listItemHistory({ excludeItemIds: [...excluded], projectId, since: historySince, tenantId }))),
    settle(metricsRepository?.listContributorTotals && !agentView
      ? metricsRepository.listContributorTotals({ days: input.days, now, projectId, tenantId, users: deps.authRepository?.state?.users ?? [] })
      : []),
    financeAuthorized ? settle(resourceFinanceRepository?.listSnapshot ? resourceFinanceRepository.listSnapshot({ tenantId }) : {}) : null,
    settle(reportingRepository?.listSnapshot ? reportingRepository.listSnapshot({ tenantId }) : { reports: [], runs: [], snapshots: [], subscriptions: [] }),
    settle(projectRepository.listWorkItemRelations ? projectRepository.listWorkItemRelations({ projectId, tenantId }) : []),
    hidden,
  ]);
  if (!fullProject) throw new HttpError(404, 'Project not found.');
  const project = agentView ? filterProjectTicketsForAssistant(fullProject) : fullProject;
  const relations = allRelations instanceof Error ? [] : allRelations.filter((relation) => !hiddenIds.has(relation.fromItemId) && !hiddenIds.has(relation.toItemId));

  const logContext = { projectId, tenantId };
  const governanceSnapshot = governance instanceof Error ? null : governance;
  const analysis = governanceSnapshot
    ? analyzeProjectSchedule(project, governanceSnapshot.dependencies ?? [], { baseline: governanceSnapshot.scheduleBaselines?.[0] ?? null, calendar: governanceSnapshot.workingCalendar, milestones: governanceSnapshot.milestones ?? [] })
    : null;
  const historyOk = !(history instanceof Error);
  const events = historyOk ? history.events : [];
  const firstRecorded = historyOk ? dateOnly(history.firstRecordedAt) : null;
  let coverageStart = firstRecorded ? (firstRecorded < historySince ? historySince : firstRecorded) : today;
  if (historyOk && history.truncated && events[0]) coverageStart = [coverageStart, dateOnly(events[0].at)].sort().at(-1);
  const sprints = sprintPayload instanceof Error ? [] : sprintRows(sprintPayload);
  const memberNames = new Map((sprintPayload instanceof Error ? [] : sprintPayload?.members ?? []).map((member) => [member.id, member.name]));
  const effectiveSprintId = input.sprintId && sprints.some((sprint) => sprint.id === input.sprintId) ? input.sprintId : null;

  const ctx = {
    analysis,
    calendar: normalizeWorkingCalendar(governanceSnapshot?.workingCalendar ?? null),
    chartStart: windowStart > coverageStart ? windowStart : coverageStart,
    coverageStart,
    days: input.days,
    events,
    finance: { authorized: financeAuthorized, snapshot: financeSnapshot },
    governance: governanceSnapshot,
    historyDays: Math.max(0, daysBetween(coverageStart, today)),
    items: collectProjectItems(project),
    memberNames,
    memo: new Map(),
    metricsRows,
    project,
    relations,
    sprintId: effectiveSprintId,
    sprints,
    today,
    unit: input.unit,
    viewer: { id: user.id },
    windowStart,
  };

  const needsHistory = (build) => () => {
    if (!historyOk) throw history;
    return build(ctx);
  };
  const needsGovernance = (build) => () => {
    if (!governanceSnapshot) throw governance;
    return build(ctx);
  };
  const builders = {
    burnup: needsHistory(buildBurnupCard),
    'cumulative-flow': needsHistory(buildCumulativeFlowCard),
    gantt: () => buildGanttCard(ctx),
    'earned-value': ctx.finance.authorized ? needsHistory(buildEarnedValueCard) : () => buildEarnedValueCard(ctx),
    milestones: needsGovernance(buildMilestonesCard),
    'sprint-burndown': needsHistory(buildSprintBurndownCard),
    throughput: needsHistory(buildThroughputCard),
    'ticket-flow': needsHistory(buildTicketFlowCard),
    'tickets-by-severity': () => buildTicketsBySeverityCard(ctx),
    velocity: needsHistory(buildVelocityCard),
  };
  const cards = {};
  for (const [type, build] of Object.entries(builders)) {
    try {
      cards[type] = build();
    } catch (error) {
      cards[type] = cardError(error, type, logContext);
    }
  }
  try {
    cards.headline = buildHeadlineCard(ctx, { earnedValue: cards['earned-value'] });
  } catch (error) {
    cards.headline = cardError(error, 'headline', logContext);
  }

  let health = null;
  try {
    health = buildHealth(ctx);
  } catch (error) {
    logBackendError(error, { context: buildOperationLogContext('insights.health', logContext) });
  }

  const reports = reportingSnapshot instanceof Error ? null : listProjectReports(reportingSnapshot, { projectId, user });
  cards['saved-reports'] = reports
    ? readyCard({ reports })
    : cardError(reportingSnapshot, 'saved-reports', logContext);

  return {
    asOf: now.toISOString(),
    cards,
    filters: { days: input.days, sprintId: ctx.sprintId, unit: input.unit },
    health,
    history: { coverageStart, firstRecordedAt: historyOk ? history.firstRecordedAt : null, historyDays: ctx.historyDays, truncated: historyOk ? history.truncated : false },
    layout: effectiveInsightsLayout(storedLayout),
    ok: true,
    project: { endDate: dateOnly(project.endDate), id: project.id, name: project.name, startDate: dateOnly(project.startDate) },
    reports: reports ?? [],
    sprints: sprints.map(({ endDate, id, name, startDate, status }) => ({ endDate, id, name, startDate, status })),
    viewer: { canEditLayout: canEditInsightsLayout({ projectRole, tenantId, user }), canSeeFinance: financeAuthorized, userId: user.id },
  };
}

async function requireLayoutEditor({ deps, projectId, user }) {
  const { projectRole, tenantId } = await authorize({ projectId, projectRepository: deps.projectRepository, user });
  if (!canEditInsightsLayout({ projectRole, tenantId, user })) throw new HttpError(403, 'Only project admins and managers can change the Insights layout.');
  return tenantId;
}

export async function saveProjectInsightsLayoutForUser({ deps, input, projectId, user }) {
  const tenantId = await requireLayoutEditor({ deps, projectId, user });
  const cards = normalizeInsightsCards(input.cards);
  const reportIds = cards.filter((card) => card.type === REPORT_CARD_TYPE).map((card) => card.reportId);
  if (reportIds.length > 0) {
    const snapshot = await deps.reportingRepository.listSnapshot({ tenantId });
    const missing = reportIds.filter((reportId) => {
      const report = snapshot.reports.find((record) => record.id === reportId);
      return !report || !reportVisibleOnProject(report, { projectId, user });
    });
    if (missing.length > 0) throw new HttpError(400, 'A report card refers to a report that is missing or not shared on this project.', { details: { reportIds: missing } });
  }
  const stored = await deps.insightsRepository.saveLayout({ cards, expectedVersion: input.expectedVersion, projectId, tenantId, userId: user.id });
  return { layout: effectiveInsightsLayout(stored), ok: true };
}

export async function resetProjectInsightsLayoutForUser({ deps, input, projectId, user }) {
  const tenantId = await requireLayoutEditor({ deps, projectId, user });
  await deps.insightsRepository.deleteLayout({ expectedVersion: input.expectedVersion, projectId, tenantId });
  return { layout: effectiveInsightsLayout(null), ok: true };
}

export async function getProjectInsightsReportCardForUser({ deps, projectId, reportId, user }) {
  const { tenantId } = await authorize({ projectId, projectRepository: deps.projectRepository, user });
  return getInsightsReportCard({
    dependencies: deps,
    now: deps.insightsClock?.() ?? new Date(),
    projectId,
    reportId,
    repository: deps.reportingRepository,
    tenantId,
    user,
  });
}
