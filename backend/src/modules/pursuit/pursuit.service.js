// The pursuit board, its settings, moving pursuit tasks to the project, and the pursuit Insights.
import { resolveDecisionRights } from '../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { onlyPursuitWork, pursuitParents, pursuitTasksOf, withoutPursuitWork } from '../../lib/projects/pursuit.js';
import { addDays } from '../insights/insights-history.js';
import { isWorkItemDone, loadWorkflowDoneStates } from '../metrics/work-completion-metrics.js';
import { buildActivityCard, buildAgeCard, buildPeopleCard, buildSowCard, buildTasksCard } from './pursuit-insights.js';
import { nameOutsideAssignees, pursuitOutsideAssignees } from './pursuit-visibility.js';
import { readSowLink } from './sow-link.js';

const CHANGE_PAGE = 1000;
const MAX_CHANGE_PAGES = 10;
const HISTORY_DAYS = 365;

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

async function requireCapability({ capability, projectId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const access = await requireProjectCapability({ capability, projectId, repository: projectRepository, tenantId, user });
  return { projectRole: access?.projectRole ?? null, tenantId };
}

async function hasCapability(args) {
  try {
    await requireCapability(args);
    return true;
  } catch {
    return false;
  }
}

async function canManageSettings({ projectId, projectRepository, tenantId, user }) {
  return (await resolveDecisionRights({ projectId, repository: projectRepository, tenantId, user })).allowed;
}

/**
 * The pursuit board's work for a member: the hidden Pursuit story that new tasks go under, and
 * the pursuit tasks. An open engagement made before 0100 gets its Pursuit story here.
 */
export async function getPursuitForUser({ deps, projectId, user }) {
  const { projectRepository } = deps;
  const { tenantId } = await requireCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, projectRepository, user });
  let project = await projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  if (!project) throw new HttpError(404, 'Project not found.');
  const canEdit = await hasCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, projectRepository, user });
  if (!pursuitParents(project).story && canEdit && project.kind === PROJECT_KIND_ENGAGEMENT && project.engagementStatus === 'open') {
    await projectRepository.ensurePursuitStory({ projectId, tenantId });
    project = await projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  }
  const { epic, story } = pursuitParents(project);
  // Tasks assigned to a guest or stakeholder show their name, and the board offers them.
  const outside = await pursuitOutsideAssignees(deps, { projectId, tenantId });
  return {
    epicId: epic?.id ?? null,
    ok: true,
    outsideAssignees: outside.assignees,
    project: nameOutsideAssignees(onlyPursuitWork(project), outside.stakeholders),
    settings: await projectRepository.getProjectSettings({ projectId, tenantId }),
    storyId: story?.id ?? null,
    taskCount: pursuitTasksOf(project).length,
    viewer: { canEdit, canManageSettings: await canManageSettings({ projectId, projectRepository, tenantId, user }) },
  };
}

/** The project's settings, which everyone on the project may read. */
export async function getProjectSettingsForUser({ deps, projectId, user }) {
  const { projectRepository } = deps;
  const { tenantId } = await requireCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, projectRepository, user });
  const settings = await projectRepository.getProjectSettings({ projectId, tenantId });
  if (!settings) throw new HttpError(404, 'Project not found.');
  return { canManage: await canManageSettings({ projectId, projectRepository, tenantId, user }), ok: true, settings };
}

/** Changes the settings. Only people with decision rights on the project may. */
export async function saveProjectSettingsForUser({ deps, input, projectId, user }) {
  const { projectRepository } = deps;
  const { tenantId } = await requireCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, projectRepository, user });
  if (!await canManageSettings({ projectId, projectRepository, tenantId, user })) {
    throw new HttpError(403, 'Only project admins and managers can change these settings.', { details: { code: 'decision_rights_required' } });
  }
  const { expectedVersion, ...changes } = input;
  const settings = await projectRepository.saveProjectSettings({ expectedVersion, input: changes, projectId, tenantId, user });
  if (!settings) throw new HttpError(404, 'Project not found.');
  return { canManage: true, ok: true, settings };
}

/**
 * Moves pursuit tasks under a story on the plan, by people who can edit the plan. One
 * task or several, all or none.
 */
export async function movePursuitTasksForUser({ deps, input, projectId, user }) {
  const { projectRepository } = deps;
  const { tenantId } = await requireCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, projectRepository, user });
  const result = await projectRepository.movePursuitTasks({
    expectedVersions: input.expectedVersions ?? {}, projectId, storyId: input.storyId, taskIds: [...new Set(input.taskIds)], tenantId, user,
  });
  if (!result) throw new HttpError(404, 'Project not found.');
  const project = await projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  return { moved: result.moved, ok: true, project: withoutPursuitWork(project), pursuit: onlyPursuitWork(project), storyId: result.storyId };
}

/** The ids of the pursuit tasks that are not done, by the task workflow when one is bound. */
export async function openPursuitTaskIds({ projectId, projectRepository, tenantId, workflowRepository = null }) {
  const project = await projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  const doneStates = await loadWorkflowDoneStates({ projectId, tenantId, workflowRepository });
  return pursuitTasksOf(project).filter((task) => !isWorkItemDone('task', task.status, doneStates)).map((task) => task.id);
}

/**
 * The step a conversion runs inside its transaction for "Move open pursuit tasks to the project
 * board": a visible Pursuit handover story on the plan, with the open tasks under it.
 */
export function moveOpenPursuitTasksStep({ projectRepository, taskIds, user }) {
  return async ({ executor, projectId, tenantId }) => {
    if (!taskIds.length) return;
    const { storyId } = await projectRepository.createHandoverStory({ executor, projectId, tenantId, user });
    await projectRepository.movePursuitTasks({ executor, projectId, storyId, taskIds, tenantId, user });
  };
}

async function readChanges({ projectId, projectRepository, tenantId }) {
  if (!projectRepository.listProjectChanges) return [];
  const entries = [];
  let afterSeq = 0;
  for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
    const result = await projectRepository.listProjectChanges({ afterSeq, limit: CHANGE_PAGE, projectId, settleMs: 0, tenantId });
    entries.push(...result.entries);
    if (!result.more || !result.entries.length) break;
    afterSeq = result.entries.at(-1).seq;
  }
  return entries;
}

// Posts come from channels (0096_channels); `channelActivityReader` returns
// `[{ at, actorId, channelId, channelName }]` for a project's posts since a date.
async function readActivity({ channelActivityReader, projectId, since, tenantId }, changes) {
  const files = changes
    .filter((entry) => entry.entityType === 'file' && ['create', 'version'].includes(entry.action))
    .map((entry) => ({ actorId: entry.actorId ?? null, at: entry.at, channelId: entry.detail?.channelId ?? null, channelName: entry.detail?.channelName ?? null, kind: 'file' }));
  const posts = channelActivityReader ? (await channelActivityReader({ projectId, since, tenantId })).map((post) => ({ ...post, kind: 'post' })) : [];
  return [...posts, ...files];
}

/**
 * The engagement's Insights cards: SOW, tasks, activity, people and age. For members of
 * the project; guests have no route to it.
 */
export async function getPursuitInsightsForUser({ deps, projectId, user }) {
  const { assistantRepository = null, insightsRepository = null, projectRepository, workflowRepository = null } = deps;
  const { tenantId } = await requireCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, projectRepository, user });
  const now = deps.insightsClock?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const project = await projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  if (!project) throw new HttpError(404, 'Project not found.');
  const tasks = pursuitTasksOf(project);
  const taskIds = new Set(tasks.map((task) => task.id));
  const since = addDays(today, -HISTORY_DAYS);

  const [doneStates, history, changes, validUsers, stakeholders, sow] = await Promise.all([
    loadWorkflowDoneStates({ projectId, tenantId, workflowRepository }),
    insightsRepository?.listItemHistory ? insightsRepository.listItemHistory({ projectId, since, tenantId }) : { events: [] },
    readChanges({ projectId, projectRepository, tenantId }),
    projectRepository.getValidUsers ? projectRepository.getValidUsers({ projectId, tenantId, user }) : null,
    assistantRepository?.listProjectStakeholders ? assistantRepository.listProjectStakeholders({ projectId, tenantId }) : [],
    readSowLink({ projectId, reader: deps.sowLinkReader ?? null, tenantId }),
  ]);
  const activity = await readActivity({ channelActivityReader: deps.channelActivityReader ?? null, projectId, since: addDays(today, -7 * 8), tenantId }, changes);
  const lastActivityAt = [...changes.map((entry) => entry.at), ...activity.map((entry) => entry.at)].filter(Boolean).map((at) => new Date(at).toISOString()).sort().at(-1) ?? null;
  const people = [
    ...(validUsers?.project_users ?? []).map((member) => ({ id: member.id, kind: 'member', name: member.name ?? '' })),
    ...stakeholders.map((stakeholder) => ({ id: stakeholder.id, kind: 'guest', name: stakeholder.name ?? '' })),
  ];

  const build = (builder) => {
    try {
      return builder();
    } catch {
      return { data: null, message: 'This card could not be loaded. Other cards are unaffected.', status: 'error' };
    }
  };
  return {
    asOf: now.toISOString(),
    cards: {
      activity: build(() => buildActivityCard({ activity, today })),
      age: build(() => buildAgeCard({ createdAt: project.createdAt, lastActivityAt, today })),
      people: build(() => buildPeopleCard({ activity, people, today })),
      sow: build(() => buildSowCard({ sow })),
      tasks: build(() => buildTasksCard({ createdAt: project.createdAt, doneStates: doneStates?.get('task') ? doneStates : null, events: (history?.events ?? []).filter((event) => taskIds.has(event.itemId)), tasks: pursuitTasksOf(nameOutsideAssignees(project, stakeholders)), today })),
    },
    ok: true,
    project: { createdAt: project.createdAt, id: project.id, kind: project.kind, name: project.name },
  };
}
