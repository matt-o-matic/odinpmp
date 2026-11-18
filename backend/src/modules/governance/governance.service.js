import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { filterProjectTicketsForAssistant, isTicketVisibleToAssistant } from '../assistant/assistant-ticket-visibility.js';
import { analyzeProjectSchedule } from './schedule-analysis.js';

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

async function authorize(user, projectId, projectRepository, capability) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability, projectId, repository: projectRepository, tenantId, user });
  return tenantId;
}

/**
 * Governance as agents see it, as if the tickets agents may not see never existed: a
 * dependency on one is left out, and a milestone tracking one tracks nothing. A deleted ticket is
 * judged by the review state its last revision recorded, as Insights judges it.
 */
async function agentLinks({ insightsRepository, project, projectId, tenantId }) {
  const live = new Map((project?.tickets ?? []).map((ticket) => [ticket.id, isTicketVisibleToAssistant(ticket)]));
  const hidden = new Set([...live].filter(([, visible]) => !visible).map(([itemId]) => itemId));
  for (const { externalReviewState, itemId } of (await insightsRepository?.listTicketReviewStates?.({ projectId, tenantId })) ?? []) {
    if (!live.has(itemId) && !(externalReviewState && isTicketVisibleToAssistant({ externalReviewState }))) hidden.add(itemId);
  }
  const shown = (itemId) => (hidden.has(itemId) ? null : itemId ?? null);
  const dependencies = (records = []) => records.filter((record) => !hidden.has(record.predecessorId) && !hidden.has(record.successorId));
  const milestones = (records = []) => records.map((record) => ({ ...record, workItemId: shown(record.workItemId) }));
  const baseline = (record) => (record?.snapshot ? { ...record, snapshot: { ...record.snapshot, dependencies: dependencies(record.snapshot.dependencies), milestones: milestones(record.snapshot.milestones) } } : record);
  return {
    // The one record a write answers with, which a person may have linked to a hidden ticket.
    record(value) {
      if (!value || typeof value !== 'object') return value;
      if ('workItemId' in value) return milestones([value])[0];
      if ('predecessorId' in value) return { ...value, predecessorId: shown(value.predecessorId), successorId: shown(value.successorId) };
      return baseline(value);
    },
    snapshot: (value) => ({ ...value, dependencies: dependencies(value.dependencies), milestones: milestones(value.milestones), scheduleBaselines: (value.scheduleBaselines ?? []).map(baseline) }),
  };
}

export async function getGovernanceForUser({ agentView = false, governanceRepository, insightsRepository = null, projectId, projectRepository, user }) {
  const tenantId = await authorize(user, projectId, projectRepository, PROJECT_CAPABILITIES.READ);
  const snapshot = await governanceRepository.listSnapshot({ projectId, tenantId });
  if (!agentView) return { ok: true, ...snapshot };
  const links = await agentLinks({ insightsRepository, project: await projectRepository.getProjectDetail({ projectId, tenantId }), projectId, tenantId });
  return { ok: true, ...links.snapshot(snapshot) };
}

export async function analyzeScheduleForUser({ agentView = false, governanceRepository, insightsRepository = null, projectId, projectRepository, user }) {
  const tenantId = await authorize(user, projectId, projectRepository, PROJECT_CAPABILITIES.READ);
  const [fullProject, fullSnapshot] = await Promise.all([
    projectRepository.getProjectDetail({ projectId, tenantId }),
    governanceRepository.listSnapshot({ projectId, tenantId }),
  ]);
  if (!fullProject) throw new HttpError(404, 'Project not found.');
  const links = agentView ? await agentLinks({ insightsRepository, project: fullProject, projectId, tenantId }) : null;
  const project = links ? filterProjectTicketsForAssistant(fullProject) : fullProject;
  const snapshot = links ? links.snapshot(fullSnapshot) : fullSnapshot;
  return { analysis: analyzeProjectSchedule(project, snapshot.dependencies, { baseline: snapshot.scheduleBaselines?.[0] ?? null, calendar: snapshot.workingCalendar, milestones: snapshot.milestones }), ok: true };
}

function scheduleBaselineSnapshot(project, governance) {
  const items = [];
  for (const epic of project.epics ?? []) {
    items.push({ id: epic.id, name: epic.name, targetEndDate: epic.targetEndDate ?? null, targetStartDate: epic.targetStartDate ?? null, type: 'epic' });
    for (const story of epic.stories ?? []) {
      items.push({ id: story.id, name: story.name, targetEndDate: story.targetEndDate ?? null, targetStartDate: story.targetStartDate ?? null, type: 'story' });
      for (const task of story.tasks ?? []) items.push({ id: task.id, name: task.name, targetEndDate: task.targetEndDate ?? null, targetStartDate: task.targetStartDate ?? null, type: 'task' });
    }
  }
  return {
    calendar: governance.workingCalendar ?? null,
    capturedSchema: 'schedule-baseline.v1',
    dependencies: (governance.dependencies ?? []).map(({ dependencyType, lagDays, predecessorId, successorId }) => ({ dependencyType, lagDays, predecessorId, successorId })),
    items,
    milestones: (governance.milestones ?? []).map(({ id, status, targetDate, title, workItemId }) => ({ id, status, targetDate, title, workItemId })),
    project: { endDate: project.endDate ?? null, id: project.id, startDate: project.startDate ?? null },
  };
}

export async function createScheduleBaselineForUser({
  agentView = false,
  domainEvent = null,
  domainEventOutboxRepository = null,
  governanceRepository,
  input,
  insightsRepository = null,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = await authorize(user, projectId, projectRepository, PROJECT_CAPABILITIES.PLAN_EDIT);
  const [project, governance] = await Promise.all([
    projectRepository.getProjectDetail({ projectId, tenantId }), governanceRepository.listSnapshot({ projectId, tenantId }),
  ]);
  if (!project) throw new HttpError(404, 'Project not found.');
  const snapshot = scheduleBaselineSnapshot(project, governance);
  return mutateGovernanceForUser({
    agentView,
    domainEvent,
    domainEventOutboxRepository,
    governanceRepository,
    input,
    insightsRepository,
    operation: (repository, args) => repository.createScheduleBaseline({
      ...args,
      createdBy: user.id,
      snapshot,
    }),
    payload: { input },
    projectId,
    projectRepository,
    user,
  });
}

export async function putWorkingCalendarForUser({ governanceRepository, input, projectId, projectRepository, user }) {
  const tenantId = await authorize(user, projectId, projectRepository, PROJECT_CAPABILITIES.PLAN_EDIT);
  return { ok: true, value: await governanceRepository.putWorkingCalendar({ input, projectId, tenantId }) };
}

export async function mutateGovernanceForUser({ agentView = false, domainEvent = null, domainEventOutboxRepository = null, governanceRepository, insightsRepository = null, operation, payload, projectId, projectRepository, user }) {
  const tenantId = await authorize(user, projectId, projectRepository, PROJECT_CAPABILITIES.PLAN_EDIT);
  const execute = async (repository, outboxRepository = domainEventOutboxRepository) => {
    const value = await operation(repository, { ...payload, projectId, tenantId });
    if (value == null || value === false) throw new HttpError(404, 'Governance record not found.');
    if (domainEvent && outboxRepository) {
      await outboxRepository.enqueue({
        ...domainEvent,
        payload: {
          ...domainEvent.payload,
          change: typeof value === 'object' ? value : null,
          entityId: domainEvent.payload?.entityId ?? value?.id ?? null,
        },
        projectId,
        tenantId,
      });
    }
    return value;
  };
  const supportsAtomicOutbox = domainEvent
    && typeof governanceRepository.transaction === 'function'
    && typeof domainEventOutboxRepository?.withExecutor === 'function';
  const value = supportsAtomicOutbox
    ? await governanceRepository.transaction((repository, executor) => execute(repository, domainEventOutboxRepository.withExecutor(executor)))
    : await execute(governanceRepository);
  if (!agentView) return { ok: true, value };
  const links = await agentLinks({ insightsRepository, project: await projectRepository.getProjectDetail({ projectId, tenantId }), projectId, tenantId });
  return { ok: true, value: links.record(value) };
}
