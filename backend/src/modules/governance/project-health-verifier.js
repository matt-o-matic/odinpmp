import { analyzeProjectSchedule } from './schedule-analysis.js';

const ACTIVE_GOVERNANCE_STATUSES = new Set(['open', 'monitoring']);
const CLOSED_MILESTONE_STATUSES = new Set(['achieved']);

function workItems(project = {}) {
  const result = [];
  for (const epic of project.epics ?? []) {
    result.push(epic);
    for (const story of epic.stories ?? []) {
      result.push(story);
      result.push(...(story.tasks ?? []));
    }
  }
  return result;
}

function dateOnly(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function check(id, failures, summary) {
  return { evidence: failures, id, passed: failures.length === 0, summary };
}

export function verifyProjectHealth({ now = new Date(), project = {}, snapshot = {} } = {}) {
  const dependencies = snapshot.dependencies ?? [];
  const items = snapshot.items ?? [];
  const milestones = snapshot.milestones ?? [];
  const schedule = analyzeProjectSchedule(project, dependencies, { baseline: snapshot.scheduleBaselines?.[0] ?? null, calendar: snapshot.workingCalendar, milestones });
  const knownItemIds = new Set(workItems(project).map((item) => item.id).filter(Boolean));
  const today = now.toISOString().slice(0, 10);

  const invalidDependencies = dependencies
    .filter((dependency) => !knownItemIds.has(dependency.predecessorId) || !knownItemIds.has(dependency.successorId))
    .map((dependency) => ({
      dependencyId: dependency.id ?? null,
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
    }));
  const invalidDates = workItems(project)
    .filter((item) => dateOnly(item.targetStartDate) && dateOnly(item.targetEndDate) && dateOnly(item.targetStartDate) > dateOnly(item.targetEndDate))
    .map((item) => ({ itemId: item.id, targetEndDate: item.targetEndDate, targetStartDate: item.targetStartDate }));
  const overdueMilestones = milestones
    .filter((milestone) => !CLOSED_MILESTONE_STATUSES.has(milestone.status) && dateOnly(milestone.targetDate) < today)
    .map((milestone) => ({ milestoneId: milestone.id, status: milestone.status, targetDate: milestone.targetDate, title: milestone.title }));
  const criticalRisks = items
    .filter((item) => item.kind === 'risk' && item.impact === 'critical' && ACTIVE_GOVERNANCE_STATUSES.has(item.status))
    .map((item) => ({ itemId: item.id, status: item.status, title: item.title }));
  const overdueGovernance = items
    .filter((item) => ACTIVE_GOVERNANCE_STATUSES.has(item.status) && dateOnly(item.dueDate) && dateOnly(item.dueDate) < today)
    .map((item) => ({ dueDate: item.dueDate, itemId: item.id, kind: item.kind, title: item.title }));

  const checks = [
    check('schedule.no_cycles', schedule.cyclicItemIds.map((itemId) => ({ itemId })), 'Dependency graph contains no cycles.'),
    check('schedule.valid_references', invalidDependencies, 'Every dependency references current project work items.'),
    check('schedule.valid_dates', invalidDates, 'Work-item target dates are internally consistent.'),
    check('milestones.not_overdue', overdueMilestones, 'No unachieved milestone is overdue.'),
    check('governance.no_open_critical_risks', criticalRisks, 'No critical risk remains open or monitoring.'),
    check('governance.no_overdue_actions', overdueGovernance, 'No active governance item is overdue.'),
  ];

  return {
    checks,
    checkedAt: now.toISOString(),
    evidence: { schedule },
    failedCheckIds: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
    passed: checks.every((entry) => entry.passed),
    verifier: 'project_health.v1',
  };
}
