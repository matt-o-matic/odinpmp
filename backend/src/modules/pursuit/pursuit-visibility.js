// Who sees which pursuit tasks (docs/engagements/qna.md Q-06, plan.md "Pursuit board", AC-20).
//
// Internal members of the project see every pursuit task. An outside person (a guest or
// stakeholder, or a resource without a login) sees the tasks assigned to them; with the project
// setting "Guests see the whole board" on, they see every pursuit task. Either way they change the
// status of, comment on and attach files to only the tasks assigned to them.
//
// An outside person is assigned a task as `resource:<resourceId>` (a profile without a login) or
// `stakeholder:<stakeholderId>`. They are one identity by email (access_links), so a stakeholder
// also owns the tasks assigned to an active profile without a login that has their email.
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { pursuitTasksOf } from '../../lib/projects/pursuit.js';
import { resourceAssigneeId } from '../resource-finance/assignee-resources.js';
import { DEFAULT_PROJECT_SETTINGS } from './pursuit.repository.js';

export const OUTSIDER_TYPES = Object.freeze(['resource', 'stakeholder']);
// The changes an outside person may make to a task of their own.
export const OUTSIDER_CHANGES = Object.freeze(['attachment', 'comment', 'status']);
const STAKEHOLDER_ASSIGNEE_PREFIX = 'stakeholder:';

export function stakeholderAssigneeId(stakeholderId) {
  return `${STAKEHOLDER_ASSIGNEE_PREFIX}${stakeholderId}`;
}

/** The stakeholder id in a `stakeholder:<id>` assignee, or null. */
export function stakeholderIdFromAssignee(assigneeId) {
  const value = String(assigneeId ?? '');
  return value.startsWith(STAKEHOLDER_ASSIGNEE_PREFIX) ? value.slice(STAKEHOLDER_ASSIGNEE_PREFIX.length) || null : null;
}

/**
 * The project with each pursuit task assigned to a stakeholder named as that stakeholder. The
 * project stores only the `stakeholder:<id>` assignee; stakeholders live with the assistant's
 * records. Other work is returned as it is.
 */
export function nameOutsideAssignees(project, stakeholders = []) {
  if (!project) return project;
  const names = new Map((stakeholders ?? []).map((stakeholder) => [String(stakeholder.id), stakeholder.name ?? '']));
  const nameTask = (task) => {
    const stakeholderId = stakeholderIdFromAssignee(task.assigneeId);
    return stakeholderId && names.has(stakeholderId) ? { ...task, assigneeName: names.get(stakeholderId) } : task;
  };
  return {
    ...project,
    epics: (project.epics ?? []).map((epic) => ({
      ...epic,
      stories: (epic.stories ?? []).map((story) => ({ ...story, tasks: (story.tasks ?? []).map(nameTask) })),
    })),
  };
}

/**
 * The outside people a member may assign a pursuit task to: the project's stakeholders, as
 * `stakeholder:<id>` assignees, each marked when they are a channel guest.
 */
export async function pursuitOutsideAssignees(deps, { projectId, tenantId }) {
  const [stakeholders, guests] = await Promise.all([
    deps.assistantRepository?.listProjectStakeholders ? deps.assistantRepository.listProjectStakeholders({ projectId, tenantId }) : [],
    deps.projectRepository?.listProjectChannelGuests ? deps.projectRepository.listProjectChannelGuests({ projectId, tenantId }) : [],
  ]);
  const guestIds = new Set((guests ?? []).map((guest) => String(guest.stakeholderId)));
  return {
    assignees: (stakeholders ?? []).map((stakeholder) => ({ guest: guestIds.has(String(stakeholder.id)), id: stakeholderAssigneeId(stakeholder.id), name: stakeholder.name ?? '' })),
    stakeholders: stakeholders ?? [],
  };
}

function notYourTask() {
  return new HttpError(403, 'Only work assigned to you can be changed here.', { details: { code: 'not_your_task' } });
}

function taskNotFound() {
  return new HttpError(404, 'Work item not found.', { details: { code: 'task_not_found' } });
}

/**
 * The assignee ids that are this outside person on a project, or null when they are not one of
 * its outside people: a stakeholder must be on the project; a resource is taken as given, since
 * the caller (a task-access link) has resolved them already.
 */
export async function outsiderAssigneeIds(deps, { principal, projectId, tenantId }) {
  if (!principal?.id || !OUTSIDER_TYPES.includes(principal.type)) return null;
  if (principal.type === 'resource') return new Set([resourceAssigneeId(principal.id)]);
  const stakeholder = await deps.assistantRepository?.findProjectStakeholderById?.({ projectId, stakeholderId: principal.id, tenantId });
  if (!stakeholder) return null;
  const ids = new Set([stakeholderAssigneeId(stakeholder.id)]);
  if (stakeholder.email && deps.resourceFinanceRepository?.listResourcesByEmail) {
    const resources = await deps.resourceFinanceRepository.listResourcesByEmail({ email: stakeholder.email, tenantId });
    for (const resource of resources) {
      if (!resource.userId && resource.status === 'active') ids.add(resourceAssigneeId(resource.id));
    }
  }
  return ids;
}

/**
 * The pursuit tasks an outside person sees on a project (with pursuit work loaded), each with
 * `mine` (assigned to them) and what they may change. With `guestsSeeBoard` they see every task.
 */
export function pursuitTasksForOutsider({ assigneeIds, guestsSeeBoard = DEFAULT_PROJECT_SETTINGS.guestsSeeBoard, project }) {
  const ids = assigneeIds ?? new Set();
  return pursuitTasksOf(project)
    .map((task) => ({ task, mine: ids.has(task.assigneeId ?? '') }))
    .filter(({ mine }) => mine || guestsSeeBoard)
    .map(({ mine, task }) => ({ ...task, canChange: mine ? [...OUTSIDER_CHANGES] : [], mine }));
}

/** Whether an outside person may make `change` (status, comment or attachment) to `task`. */
export function canOutsiderChangePursuitTask({ assigneeIds, change, task }) {
  return OUTSIDER_CHANGES.includes(change) && Boolean(task) && (assigneeIds ?? new Set()).has(task.assigneeId ?? '');
}

export function assertOutsiderCanChangePursuitTask(args) {
  if (!canOutsiderChangePursuitTask(args)) throw notYourTask();
}

/**
 * The pursuit tasks visible to a principal on a project, by role and setting:
 * - `{ type: 'user', user }`: a workspace member; every task when they can read the project;
 * - `{ type: 'stakeholder' | 'resource', id }`: an outside person, as pursuitTasksForOutsider.
 * Returns `{ canSeeAll, settings, tasks }`; tasks carry `mine` and `canChange`.
 */
export async function listPursuitTasksVisibleTo(deps, { principal, projectId, tenantId }) {
  const settings = await deps.projectRepository.getProjectSettings({ projectId, tenantId });
  if (!settings) throw new HttpError(404, 'Project not found.');
  const project = await deps.projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  if (!project) throw new HttpError(404, 'Project not found.');

  if (principal?.type === 'user') {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: deps.projectRepository, tenantId, user: principal.user });
    const canEdit = await canEditPlan(deps, { projectId, tenantId, user: principal.user });
    const tasks = pursuitTasksOf(project).map((task) => ({
      ...task,
      canChange: canEdit ? [...OUTSIDER_CHANGES] : [],
      mine: task.assigneeId === principal.user.id,
    }));
    return { canSeeAll: true, settings, tasks };
  }

  const assigneeIds = await outsiderAssigneeIds(deps, { principal, projectId, tenantId });
  if (!assigneeIds) return { canSeeAll: false, settings, tasks: [] };
  return {
    canSeeAll: settings.guestsSeeBoard,
    settings,
    tasks: pursuitTasksForOutsider({ assigneeIds, guestsSeeBoard: settings.guestsSeeBoard, project }),
  };
}

/**
 * Settles that an outside person may make `change` to a pursuit task, and returns the task.
 * A task they can't see is 404 `task_not_found`; one they see but don't own is 403 `not_your_task`.
 */
export async function requireOutsiderPursuitChange(deps, { change, principal, projectId, taskId, tenantId }) {
  const { tasks } = await listPursuitTasksVisibleTo(deps, { principal, projectId, tenantId });
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task) throw taskNotFound();
  if (!task.canChange.includes(change)) throw notYourTask();
  return task;
}

async function canEditPlan(deps, { projectId, tenantId, user }) {
  try {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: deps.projectRepository, tenantId, user });
    return true;
  } catch {
    return false;
  }
}
