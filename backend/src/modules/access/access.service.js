import { isHiddenByModule } from '../engagements/engagement-guard.js';
import { randomUUID } from 'node:crypto';

import sanitizeHtml from 'sanitize-html';

import { markdownToSafeHtml } from '../../lib/content/email-markdown.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { publishProjectChanged } from '../../lib/events/project-live-events.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { assignBoardColumnKeys, resolveKanbanColumn, slugifyBoardColumnKey } from '../../lib/projects/kanban-placement.js';
import { COMPLETED_STATUS, NOT_STARTED_STATUS, storyCompletionCascades } from '../../lib/projects/work-progress.js';
import { queueTaskAccessLinkEmail } from '../mail/mail.service.js';
import { isWorkItemDone, workflowDoneStatesFromSnapshot } from '../metrics/work-completion-metrics.js';
import { writeProjectItemChange } from '../projects/projects.service.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { isPursuitItem, withoutPursuitWork } from '../../lib/projects/pursuit.js';
import { pursuitTasksForOutsider } from '../pursuit/pursuit-visibility.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { computeLinkStatus } from '../requirements/requirements-access-links.js';
import { resourceAssigneeId } from '../resource-finance/assignee-resources.js';
import { planWorkflowTransitions } from '../workflows/workflows.service.js';
import {
  accessLinkCreatedBy,
  buildAccessLinkUrl,
  computeAccessLinkStatus,
  generateAccessToken,
  hashAccessToken,
  normalizeAccessEmail,
  REQUIREMENTS_TOKEN_PURPOSE,
} from './access-links.js';

// The access link. Every request resolves the token to its link and
// works out again what the link's email has in the workspace; nothing about access comes from the
// client. A person with task access sees the project's board and edits only the epics, stories and
// tasks assigned to them, as `resource:<resourceId>`, through the same workflow rules, version
// checks and revision history as the app. Tickets and anyone else's work are never editable from a
// link. The routes say "tasks" for all of it, as the feature does.

const TOUCH_INTERVAL_MS = 60_000;
// Allocation statuses that put a resource on a project, as the Resources tab counts them.
const LIVE_ALLOCATION = new Set(['proposed', 'approved', 'active', 'held']);
// The board the app shows a project before anyone arranges its columns.
const DEFAULT_TASK_STATUSES = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];

/** The deps every function here takes, built from the app's deps. */
export function accessServiceDeps(deps) {
  return {
    accessRepository: deps.accessRepository,
    assistantRepository: deps.assistantRepository,
    authRepository: deps.authRepository ?? null,
    clock: deps.accessClock ?? deps.requirementsClock ?? (() => new Date()),
    frontendAppUrl: deps.frontendAppUrl ?? '',
    liveEventBus: deps.liveEventBus ?? null,
    mailRepository: deps.mailRepository ?? null,
    metricsRepository: deps.metricsRepository ?? null,
    projectRepository: deps.projectRepository,
    requirementsRepository: deps.requirementsRepository,
    resourceFinanceRepository: deps.resourceFinanceRepository,
    workflowRepository: deps.workflowRepository ?? null,
    workspaceModulesRepository: deps.workspaceModulesRepository ?? null,
  };
}

function nowFor(deps) {
  return deps.clock?.() ?? new Date();
}

function linkNotFound() {
  return new HttpError(404, 'This link is not valid.', { details: { code: 'link_not_found' } });
}

function linkRevoked() {
  return new HttpError(410, 'link_revoked', {
    details: { code: 'link_revoked', message: 'This link was turned off. Ask the project team for a new one.' },
  });
}

function linkExpired(expiredAt) {
  return new HttpError(410, 'link_expired', {
    details: { code: 'link_expired', expiredAt, message: 'This link has expired. Ask the project team for a new one.' },
  });
}

function noProjectAccess() {
  return new HttpError(404, 'This link does not open that project.', { details: { code: 'no_project_access' } });
}

function notYourTask() {
  return new HttpError(403, 'Only work assigned to you can be changed here.', { details: { code: 'not_your_task' } });
}

function taskNotFound() {
  return new HttpError(404, 'Work item not found.', { details: { code: 'task_not_found' } });
}

// Outside people change the status of their pursuit tasks and comment on them; hours and
// time stay with the team.
function notOnPursuitTask() {
  return new HttpError(403, 'Pursuit tasks take status changes and comments here.', { details: { code: 'not_allowed_on_pursuit_task' } });
}

// Completing a story completes its open tasks (projects.repository.js), which a link may do only
// to its own.
function othersOpenTasks(count) {
  return new HttpError(409, `${count === 1 ? 'Someone else still has an open task' : `Other people still have ${count} open tasks`} on this story, so it can't be completed here. Ask the project team.`, {
    details: { code: 'story_has_others_open_tasks' },
  });
}

function storyNotAvailable() {
  return new HttpError(403, 'You can\'t add a task to that story.', { details: { code: 'story_not_available' } });
}

function invalid(message, code) {
  return new HttpError(400, message, { details: { code } });
}

function versionConflict(details = {}) {
  return new HttpError(409, 'Someone else changed this since you loaded it. Reload and try again.', {
    details: { actualVersion: details.actualVersion ?? null, code: 'version_conflict', expectedVersion: details.expectedVersion ?? null },
  });
}

// Repository conflicts carry their own codes; the link's API has one.
function asVersionConflict(error) {
  return ['project_item_version_conflict', 'resource_finance_version_conflict'].includes(error?.details?.code) ? versionConflict(error.details) : error;
}

function dayAfter(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

// When an inactive task grant ended: it was turned off, or its last allocation on the project
// ran out or was completed. Null when neither is known.
function taskGrantEnd(grant, allocations, today) {
  const ends = [];
  if (grant.revokedAt) ends.push(Date.parse(grant.revokedAt));
  for (const allocation of allocations) {
    if (LIVE_ALLOCATION.has(allocation.status) && allocation.endDate && allocation.endDate < today) ends.push(Date.parse(dayAfter(allocation.endDate)));
    else if (allocation.status === 'completed' && allocation.updatedAt) ends.push(Date.parse(allocation.updatedAt));
  }
  const known = ends.filter(Number.isFinite);
  return known.length ? new Date(Math.max(...known)).toISOString() : null;
}

/**
 * What an email has in a workspace now, by project, and every grant it has had with whether it
 * is active and when it ended. Tasks: an active grant for an active resource profile with that
 * email and no login, allocated to the project until today or later, on a project that is not
 * deleted. Requirements: a stakeholder with that email whose requirements link is valid.
 */
export async function evaluateEmailAccess(deps, { email, now, tenantId }) {
  const address = normalizeAccessEmail(email);
  const today = now.toISOString().slice(0, 10);
  const activeProjects = new Map();
  const projectActive = async (projectId) => {
    if (!activeProjects.has(projectId)) activeProjects.set(projectId, await deps.projectRepository.getProjectDeletionState({ projectId, tenantId }) === 'active');
    return activeProjects.get(projectId);
  };
  const projects = new Map();
  const projectEntry = (projectId) => {
    if (!projects.has(projectId)) projects.set(projectId, { projectId, requirements: null, tasks: null });
    return projects.get(projectId);
  };
  const grants = [];

  const resources = (await deps.resourceFinanceRepository.listResourcesByEmail({ email: address, tenantId }))
    .filter((resource) => !resource.userId && resource.status === 'active');
  const resourceIds = resources.map((resource) => resource.id);
  const [taskGrants, allocations] = await Promise.all([
    deps.accessRepository.listTaskAccess({ resourceIds, tenantId }),
    deps.resourceFinanceRepository.listAllocationsForResources({ resourceIds, tenantId }),
  ]);
  for (const grant of taskGrants) {
    const onProject = allocations.filter((allocation) => allocation.resourceId === grant.resourceId && allocation.projectId === grant.projectId);
    const allocated = onProject.some((allocation) => LIVE_ALLOCATION.has(allocation.status) && (!allocation.endDate || allocation.endDate >= today));
    if (!grant.revokedAt && allocated && await projectActive(grant.projectId)) {
      const entry = projectEntry(grant.projectId);
      entry.tasks ??= { grant, resource: resources.find((resource) => resource.id === grant.resourceId), scope: grant.scope };
      grants.push({ active: true, endedAt: null });
    } else {
      grants.push({ active: false, endedAt: taskGrantEnd(grant, onProject, today) });
    }
  }

  // Pursuit tasks assigned to them open their engagement too, with no grant or allocation: an
  // outside person sees the pursuit tasks assigned to them.
  // An engagement shows only while the workspace has the Consulting module on.
  const pursuitAssignments = resourceIds.length && deps.projectRepository.listPursuitAssignments
    ? await deps.projectRepository.listPursuitAssignments({ assigneeIds: resourceIds.map(resourceAssigneeId), tenantId })
    : [];
  for (const { assigneeId, projectId } of pursuitAssignments) {
    if (projects.get(projectId)?.tasks || !await projectActive(projectId) || !await pursuitProjectOpen(deps, { projectId, tenantId })) continue;
    const resource = resources.find((entry) => resourceAssigneeId(entry.id) === assigneeId);
    projectEntry(projectId).tasks = { grant: null, pursuitOnly: true, resource, scope: 'own' };
    grants.push({ active: true, endedAt: null });
  }

  const stakeholders = await deps.assistantRepository.listStakeholdersByEmail({ email: address, tenantId });
  for (const stakeholder of stakeholders) {
    if (!await projectActive(stakeholder.projectId)) continue;
    const scope = { projectId: stakeholder.projectId, stakeholderId: stakeholder.id, tenantId };
    const link = await deps.requirementsRepository.getAccessLinkForStakeholder(scope);
    if (!link) continue;
    const status = computeLinkStatus({ involvement: await deps.requirementsRepository.listStakeholderInvolvement(scope), link, now });
    if (status.valid) {
      projectEntry(stakeholder.projectId).requirements ??= { link, stakeholder };
      grants.push({ active: true, endedAt: null });
    } else {
      grants.push({ active: false, endedAt: link.revokedAt ?? status.expiresAt });
    }
  }

  return {
    grants,
    person: { email: address, name: resources[0]?.name ?? stakeholders[0]?.name ?? '' },
    projects,
  };
}

// An engagement's pursuit tasks reach a link only while the Consulting module is on, as its
// project URLs do (engagement-guard.js).
async function pursuitProjectOpen(deps, { projectId, tenantId }) {
  const kind = await deps.projectRepository.getProjectKind?.({ projectId });
  if (kind?.kind !== PROJECT_KIND_ENGAGEMENT) return true;
  return deps.workspaceModulesRepository ? isModuleEnabled(deps.workspaceModulesRepository, tenantId, CONSULTING_MODULE) : false;
}

/**
 * Resolves a token to its link and what the link opens now. Unknown tokens (a requirements link
 * token among them) are 404 `link_not_found`; revoked links and tokens 410 `link_revoked`;
 * expired links 410 `link_expired`. Use is recorded at most once a minute.
 */
export async function resolveAccessToken(deps, { token }) {
  const found = await deps.accessRepository.findTokenByHash({ tokenHash: hashAccessToken(token) });
  if (!found) throw linkNotFound();
  const { link, token: tokenRecord } = found;
  if (tokenRecord.revokedAt || link.revokedAt) throw linkRevoked();

  const now = nowFor(deps);
  const access = await evaluateEmailAccess(deps, { email: link.email, now, tenantId: link.tenantId });
  const linkStatus = computeAccessLinkStatus({ grants: access.grants, link, now });
  // An engagement drops out while the Consulting module is off.
  // Its grants still count toward the link's lifetime, so switching the module back restores it.
  for (const projectId of [...access.projects.keys()]) {
    if (await isHiddenByModule(deps, projectId)) access.projects.delete(projectId);
  }
  if (linkStatus.status === 'revoked') throw linkRevoked();
  if (linkStatus.status === 'expired') throw linkExpired(linkStatus.expiresAt);

  const lastUsedMs = tokenRecord.lastUsedAt ? Date.parse(tokenRecord.lastUsedAt) : 0;
  if (!lastUsedMs || now.valueOf() - lastUsedMs > TOUCH_INTERVAL_MS) {
    await deps.accessRepository.touchLink({ linkId: link.id, now, tokenId: tokenRecord.id });
  }
  return { ...access, link, linkStatus, now, tenantId: link.tenantId };
}

// The task grant covering a project: who it is for, how much it shows, and who gave it.
function taskGrantFor(access, projectId) {
  const tasks = access.projects.get(projectId)?.tasks;
  if (!tasks) throw noProjectAccess();
  return { assigneeId: resourceAssigneeId(tasks.resource.id), grantedBy: tasks.grant?.grantedBy ?? null, pursuitOnly: Boolean(tasks.pursuitOnly), resource: tasks.resource, scope: tasks.scope };
}

// The person acting through the link, as revisions, comments and live events record them.
function linkActor(grant) {
  return { id: grant.assigneeId, name: grant.resource.name };
}

export async function getAccessHubForToken(deps, { token }) {
  const access = await resolveAccessToken(deps, { token });
  const projects = [];
  for (const entry of access.projects.values()) {
    const project = await deps.projectRepository.getProjectDetail({ projectId: entry.projectId, tenantId: access.tenantId });
    if (!project) continue;
    projects.push({ id: project.id, name: project.name, requirements: Boolean(entry.requirements), tasks: entry.tasks ? { scope: entry.tasks.scope } : null });
  }
  return {
    link: { expiresAt: access.linkStatus.expiresAt, status: access.linkStatus.status },
    ok: true,
    person: access.person,
    projects: projects.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Opens requirements from the access link: a new token on the stakeholder's own requirements
 * link, which must be valid, for the existing portal at /requirements/<token>. The requirements
 * link itself is left as it is, so its lifetime rules still apply.
 */
export async function openRequirementsForToken(deps, { projectId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const requirements = access.projects.get(projectId)?.requirements;
  if (!requirements) throw noProjectAccess();
  const minted = generateAccessToken();
  const record = await deps.requirementsRepository.mintLinkToken({
    createdBy: accessLinkCreatedBy(access.link.id),
    linkId: requirements.link.id,
    now: access.now,
    purpose: REQUIREMENTS_TOKEN_PURPOSE,
    tenantId: access.tenantId,
    tokenHash: hashAccessToken(minted),
  });
  if (!record) throw noProjectAccess();
  return { ok: true, token: minted };
}

function taskWorkflow(snapshot, projectId) {
  const binding = snapshot?.bindings?.find((entry) => entry.projectId === projectId && entry.itemType === 'task');
  return binding ? snapshot.workflows.find((workflow) => workflow.id === binding.workflowId && workflow.status === 'active') ?? null : null;
}

function statusColumns(statuses) {
  return assignBoardColumnKeys(statuses.map((status) => ({ defaultStatus: status, key: slugifyBoardColumnKey(status), name: status, statuses: [status] })));
}

/**
 * The board's columns. Boards are arranged per person in Odin, so this is the board of the
 * manager who gave the access. Until they arrange one it is the board Odin shows by default: a
 * column per state of the project's task workflow (the initial state first), or else per
 * standard status, with any other status a card is in after them.
 */
async function boardColumns(deps, { grant, project, tenantId, workflows }) {
  const saved = grant.grantedBy
    ? await deps.projectRepository.getKanbanConfig({ projectId: project.id, tenantId, user: { id: grant.grantedBy } })
    : null;
  if (saved?.columns?.length) {
    return saved.columns.map(({ defaultStatus, key, name, statuses }) => ({ defaultStatus, key, name, statuses: [...statuses] }));
  }
  const workflow = taskWorkflow(workflows, project.id);
  if (workflow) {
    const states = [...workflow.states].sort((left, right) => Number(Boolean(right.initial)) - Number(Boolean(left.initial)));
    return assignBoardColumnKeys(states.map((state) => ({ defaultStatus: state.key, key: slugifyBoardColumnKey(state.key), name: state.label || state.key, statuses: [state.key] })));
  }
  const statuses = [...DEFAULT_TASK_STATUSES];
  const add = (item) => { if (item.status && !statuses.includes(item.status)) statuses.push(item.status); };
  for (const epic of project.epics ?? []) {
    add(epic);
    for (const story of epic.stories ?? []) {
      add(story);
      for (const task of story.tasks ?? []) add(task);
    }
  }
  return statusColumns(statuses);
}

async function loadTaskBoard(deps, { grant, projectId, tenantId }) {
  const [project, workflows, settings] = await Promise.all([
    deps.projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId }),
    deps.workflowRepository?.listSnapshot ? deps.workflowRepository.listSnapshot({ tenantId }) : null,
    deps.projectRepository.getProjectSettings ? deps.projectRepository.getProjectSettings({ projectId, tenantId }) : null,
  ]);
  if (!project) throw noProjectAccess();
  return { columns: await boardColumns(deps, { grant, project, tenantId, workflows }), project, settings, workflows };
}

/**
 * The work the grant shows, as cards (`items`) and the stories they sit under (`stories`). With
 * `own`, the epics, stories and tasks assigned to the person, and the stories that hold their
 * tasks; with `all`, every story and task as on the app's board, plus epics assigned to them.
 * They may add tasks to any story shown that is not done.
 */
function visibleWork(fullProject, { assigneeId, doneStates, guestsSeeBoard = false, pursuitOnly = false, scope }) {
  const items = [];
  const stories = [];
  const project = pursuitOnly ? { epics: [] } : withoutPursuitWork(fullProject);
  for (const epic of project.epics ?? []) {
    if (epic.assigneeId === assigneeId) items.push({ epic, item: epic, itemType: 'epic', story: null });
    for (const story of epic.stories ?? []) {
      const storyTasks = story.tasks ?? [];
      const theirs = storyTasks.filter((task) => task.assigneeId === assigneeId);
      const storyIsTheirs = story.assigneeId === assigneeId;
      if (scope !== 'all' && !theirs.length && !storyIsTheirs) continue;
      const canAddTask = !isWorkItemDone('story', story.status, doneStates);
      stories.push({ canAddTask, epic, story });
      if (scope === 'all' || storyIsTheirs) items.push({ epic, item: story, itemType: 'story', story });
      for (const task of scope === 'all' ? storyTasks : theirs) items.push({ epic, item: task, itemType: 'task', story });
    }
  }
  // Pursuit tasks follow their own rule, whatever the grant's scope: the ones assigned to them,
  // or every one with "Guests see the whole board". Nobody adds pursuit tasks from a link.
  const pursuitIds = new Set(pursuitTasksForOutsider({ assigneeIds: new Set([assigneeId]), guestsSeeBoard, project: fullProject }).map((task) => task.id));
  for (const epic of (fullProject.epics ?? []).filter(isPursuitItem)) {
    for (const story of epic.stories ?? []) {
      const shown = (story.tasks ?? []).filter((task) => pursuitIds.has(task.id));
      if (!shown.length) continue;
      stories.push({ canAddTask: false, epic, story });
      for (const task of shown) items.push({ epic, item: task, itemType: 'task', story });
    }
  }
  return { items, stories };
}

function findItem(project, itemId) {
  for (const epic of project.epics ?? []) {
    if (epic.id === itemId) return { epic, item: epic, itemType: 'epic', story: null };
    for (const story of epic.stories ?? []) {
      if (story.id === itemId) return { epic, item: story, itemType: 'story', story };
      const task = (story.tasks ?? []).find((entry) => entry.id === itemId);
      if (task) return { epic, item: task, itemType: 'task', story };
    }
  }
  return null;
}

// Work assigned to them. Tickets and anyone else's work are refused alike, and so is delivery
// work on a project the link opens only for its pursuit tasks.
function ownItem(project, itemId, grant) {
  const found = findItem(project, itemId);
  if (!found || found.item.assigneeId !== grant.assigneeId) throw notYourTask();
  if (grant.pursuitOnly && !isPursuitItem(found.item)) throw notYourTask();
  return found;
}

// A card the grant shows, for reading its comments and time.
function visibleItem(project, itemId, grant, settings = null) {
  const found = visibleWork(project, { assigneeId: grant.assigneeId, doneStates: null, guestsSeeBoard: Boolean(settings?.guestsSeeBoard), pursuitOnly: grant.pursuitOnly, scope: grant.scope }).items.find((entry) => entry.item.id === itemId);
  if (!found) throw taskNotFound();
  return found;
}

const decodeEntities = (value) => String(value ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// A description as a link sees it: the Markdown Odin stores, with mentions reduced to the names
// they show and pictures of Odin files left out, so no internal ids leave.
function linkDescription(markdown) {
  return String(markdown ?? '')
    .replace(/<span\b[^>]*\bclass="mention"[^>]*>([\s\S]*?)<\/span>/gi, (_match, label) => decodeEntities(label))
    .replace(/@\[([^\]\n]{1,120})\]\((?:user|stakeholder|person):[A-Za-z0-9_-]{1,64}\)/g, '@$1')
    .replace(/!\[[^\]]*\]\(odin-file:\/\/[^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .trim();
}

// Comment HTML as a link sees it: text and formatting. Mentions keep the name but not the id of
// the person named, and images (Odin files the link can't open) are dropped.
// What a comment shown to an outside person may carry (task-access links, guests' pursuit tasks).
export const LINK_COMMENT_HTML = {
  allowedAttributes: { a: ['href', 'rel', 'target'], span: ['class'] },
  allowedClasses: { span: ['mention'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedTags: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true) },
};

// A description typed through the link, as Markdown without tags: markup such as mention spans
// stays out of what Odin stores.
function plainDescription(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').trim();
}

// One card. `storyId` is the story a task sits under, a story's own id, and null for an epic;
// `parentName` is a task's story or a story's epic.
function presentItem({ epic, item, itemType, story }, { assigneeId, columns }) {
  return {
    actualHours: item.actualHours ?? null,
    assigneeName: item.assigneeName ?? '',
    // The column the card sits in: its placement while that column takes its status, else the
    // first column that does. Null when no column takes the status.
    boardColumn: resolveKanbanColumn(item, columns)?.key ?? null,
    description: linkDescription(item.description),
    epicId: epic.id,
    epicName: epic.name ?? '',
    id: item.id,
    itemType,
    mine: item.assigneeId === assigneeId,
    name: item.name,
    parentName: itemType === 'task' ? story.name ?? '' : itemType === 'story' ? epic.name ?? '' : null,
    priority: item.priority ?? 4,
    remainingHours: item.remainingHours ?? null,
    sprintId: item.sprintId ?? null,
    status: item.status,
    storyId: story?.id ?? null,
    targetEndDate: item.targetEndDate ?? null,
    targetHourEstimate: item.targetHourEstimate ?? null,
    targetStartDate: item.targetStartDate ?? null,
    updatedAt: item.updatedAt ?? null,
    version: item.version,
  };
}

function presentStory({ canAddTask, epic, story }) {
  return {
    assigneeName: story.assigneeName ?? '',
    canAddTask,
    epicName: epic.name,
    id: story.id,
    name: story.name,
    sprintId: story.sprintId ?? null,
    status: story.status,
  };
}

// invoiced: an invoice holds the entry, so it stays as billed.
function presentTimeEntry(entry) {
  return { hours: entry.hours, id: entry.id, invoiced: Boolean(entry.invoiceClaimId), note: entry.note ?? '', status: entry.status, version: entry.version, workDate: entry.workDate };
}

export async function getTaskBoardForToken(deps, { projectId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { columns, project, settings, workflows } = await loadTaskBoard(deps, { grant, projectId, tenantId: access.tenantId });
  const sprints = await deps.projectRepository.listSprintRows({ projectId, tenantId: access.tenantId }) ?? [];
  const work = visibleWork(project, { assigneeId: grant.assigneeId, doneStates: workflows ? workflowDoneStatesFromSnapshot(workflows, projectId) : null, guestsSeeBoard: Boolean(settings?.guestsSeeBoard), pursuitOnly: grant.pursuitOnly, scope: grant.scope });
  return {
    columns: columns.map(({ defaultStatus, key, name, statuses }) => ({ defaultStatus, key, name, statuses })),
    me: { assigneeId: grant.assigneeId, name: grant.resource.name },
    ok: true,
    project: { id: project.id, name: project.name },
    scope: grant.scope,
    sprints: sprints.map((sprint) => ({ endDate: sprint.endDate ?? null, id: sprint.id, name: sprint.name, startDate: sprint.startDate ?? null, status: sprint.status })),
    items: work.items.map((entry) => presentItem(entry, { assigneeId: grant.assigneeId, columns })),
    stories: work.stories.map(presentStory),
  };
}

/**
 * Writes a change as the person behind the link, with no role on the project: the same item
 * write as the app, story completion cascade included, then the live update open project
 * screens refresh on.
 */
async function writeAsLink(deps, { access, currentProject, grant, input, itemId = null, operation, projectId, reason }) {
  const actor = linkActor(grant);
  let result;
  try {
    result = await writeProjectItemChange({
      currentProject,
      input,
      itemId,
      metricsRepository: deps.metricsRepository,
      operation,
      planTransitions: (nextProject) => planWorkflowTransitions({ currentProject, nextProject, projectRole: '', tenantId: access.tenantId, user: actor, workflowRepository: deps.workflowRepository }),
      projectId,
      repository: deps.projectRepository,
      tenantId: access.tenantId,
      user: actor,
      workflowRepository: deps.workflowRepository,
    });
  } catch (error) {
    throw asVersionConflict(error);
  }
  publishProjectChanged(deps.liveEventBus, projectId, { actor, itemId: result.item?.id ?? itemId, reason });
  return result;
}

/**
 * The patch a status, a column, or both ask for, held to the board. A card moved to a column
 * that does not take its status gets the column's default status.
 */
function itemPatch(item, input, columns) {
  const patch = {};
  if (input.remainingHours !== undefined) patch.remainingHours = input.remainingHours;
  if (input.boardColumn !== undefined) {
    const column = columns.find((entry) => entry.key === input.boardColumn);
    if (!column) throw invalid('That column is not on the board.', 'column_not_found');
    const status = input.status ?? (column.statuses.includes(item.status) ? item.status : column.defaultStatus);
    if (!column.statuses.includes(status)) throw invalid(`The ${column.name} column does not take ${status}.`, 'status_not_allowed');
    Object.assign(patch, { boardColumn: column.key, status });
  } else if (input.status !== undefined) {
    if (!columns.some((column) => column.statuses.includes(input.status))) throw invalid(`${input.status} is not a status on this board.`, 'status_not_allowed');
    patch.status = input.status;
  }
  return patch;
}

// A story they complete completes its open tasks; anyone else's among them stop it.
function requireOnlyTheirOpenTasks({ item, itemType }, patch, assigneeId) {
  if (itemType !== 'story' || patch.status === undefined || !storyCompletionCascades(item.status, patch.status)) return;
  const others = (item.tasks ?? []).filter((task) => task.status !== COMPLETED_STATUS && task.assigneeId !== assigneeId);
  if (others.length) throw othersOpenTasks(others.length);
}

function presentWrittenItem(project, itemId, { assigneeId, columns }) {
  const found = findItem(project, itemId);
  return found ? presentItem(found, { assigneeId, columns }) : null;
}

/** Changes the status, column or remaining hours of an epic, story or task assigned to them. */
export async function updateTaskForToken(deps, { input, projectId, taskId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { columns, project } = await loadTaskBoard(deps, { grant, projectId, tenantId: access.tenantId });
  const found = ownItem(project, taskId, grant);
  if (isPursuitItem(found.item) && input.remainingHours !== undefined) throw notOnPursuitTask();
  const patch = itemPatch(found.item, input, columns);
  requireOnlyTheirOpenTasks(found, patch, grant.assigneeId);
  const result = await writeAsLink(deps, {
    access, currentProject: project, grant, input: { expectedVersion: input.expectedVersion, patch },
    itemId: taskId, operation: 'update', projectId, reason: 'task-access-task-updated',
  });
  return { ok: true, task: presentWrittenItem(result.project, taskId, { assigneeId: grant.assigneeId, columns }) };
}

// A new task starts in the first column's default status. A task workflow names the state new
// tasks begin in and refuses any other, so its initial state wins.
function newTaskStatus(columns, workflow) {
  return workflow?.states.find((state) => state.initial)?.key || columns[0]?.defaultStatus || NOT_STARTED_STATUS;
}

export async function createTaskForToken(deps, { input, projectId, storyId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { columns, project, workflows } = await loadTaskBoard(deps, { grant, projectId, tenantId: access.tenantId });
  const doneStates = workflows ? workflowDoneStatesFromSnapshot(workflows, projectId) : null;
  const target = visibleWork(project, { assigneeId: grant.assigneeId, doneStates, pursuitOnly: grant.pursuitOnly, scope: grant.scope }).stories.find((entry) => entry.story.id === storyId);
  if (!target?.canAddTask) throw storyNotAvailable();

  const status = newTaskStatus(columns, taskWorkflow(workflows, projectId));
  const column = columns.find((entry) => entry.statuses.includes(status));
  const item = {
    actualHours: null,
    assigneeId: grant.assigneeId,
    assigneeName: grant.resource.name,
    boardColumn: column?.key ?? null,
    description: plainDescription(input.description),
    id: randomUUID(),
    name: input.name,
    priority: 4,
    sprintId: target.story.sprintId ?? null,
    status,
    targetHourEstimate: input.targetHourEstimate ?? null,
  };
  const result = await writeAsLink(deps, {
    access, currentProject: project, grant, input: { item, itemType: 'task', parentId: storyId }, operation: 'create', projectId, reason: 'task-access-task-created',
  });
  return { ok: true, task: presentWrittenItem(result.project, result.item?.id ?? item.id, { assigneeId: grant.assigneeId, columns }) };
}

function flattenComments(nodes, list = []) {
  for (const node of nodes ?? []) {
    list.push(node);
    flattenComments(node.children, list);
  }
  return list;
}

function presentComment(comment, assigneeId) {
  return {
    authorName: comment.author?.name ?? '',
    createdAt: comment.createdAt,
    html: sanitizeHtml(String(comment.comment ?? ''), LINK_COMMENT_HTML),
    id: comment.id,
    mine: comment.userId === assigneeId,
  };
}

async function readProject(deps, { projectId, tenantId }) {
  const [project, settings] = await Promise.all([
    deps.projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId }),
    deps.projectRepository.getProjectSettings ? deps.projectRepository.getProjectSettings({ projectId, tenantId }) : null,
  ]);
  if (!project) throw noProjectAccess();
  return { project, settings };
}

export async function listTaskCommentsForToken(deps, { projectId, taskId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { project, settings } = await readProject(deps, { projectId, tenantId: access.tenantId });
  const { itemType } = visibleItem(project, taskId, grant, settings);
  const tree = await deps.projectRepository.listComments({ projectId, targetId: taskId, targetType: itemType, tenantId: access.tenantId });
  const comments = flattenComments(tree).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  return { comments: comments.map((comment) => presentComment(comment, grant.assigneeId)), ok: true };
}

/** A comment on work assigned to them, stored as safe HTML the way ticket intake stores replies. */
export async function createTaskCommentForToken(deps, { input, projectId, taskId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { itemType } = ownItem((await readProject(deps, { projectId, tenantId: access.tenantId })).project, taskId, grant);
  const html = markdownToSafeHtml(input.text);
  if (!html) throw invalid('Write something to comment.', 'comment_empty');
  const actor = linkActor(grant);
  const comment = await deps.projectRepository.addComment({
    comment: html, parentId: null, projectId, targetId: taskId, targetType: itemType, tenantId: access.tenantId, user: actor,
  });
  publishProjectChanged(deps.liveEventBus, projectId, { actor, itemId: taskId, reason: 'task-access-commented' });
  return { comment: presentComment(comment, grant.assigneeId), ok: true };
}

export async function listTaskTimeForToken(deps, { projectId, taskId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { project, settings } = await readProject(deps, { projectId, tenantId: access.tenantId });
  visibleItem(project, taskId, grant, settings);
  const entries = await deps.resourceFinanceRepository.listTimeEntries({ projectId, resourceId: grant.resource.id, tenantId: access.tenantId, workItemId: taskId });
  const newestFirst = (left, right) => right.workDate.localeCompare(left.workDate) || String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
  return { entries: [...entries].sort(newestFirst).map(presentTimeEntry), ok: true };
}

// Time in a timesheet period that is not open stays as it is (423), as in the app.
function lockedPeriod(period) {
  if (period && period.status !== 'open') throw new HttpError(423, `The ${period.name} timesheet period is ${period.status}.`);
  return period ?? null;
}

/**
 * Logs submitted, non-billable time for their resource on work assigned to them, in the timesheet
 * period that holds the date, as the app logs time. Remaining hours sent with it update the item
 * first, so a refused change logs nothing.
 */
export async function logTaskTimeForToken(deps, { input, projectId, taskId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const { columns, project } = await loadTaskBoard(deps, { grant, projectId, tenantId: access.tenantId });
  const { item: task } = ownItem(project, taskId, grant);
  if (isPursuitItem(task)) throw notOnPursuitTask();
  const snapshot = await deps.resourceFinanceRepository.listSnapshot({ tenantId: access.tenantId });
  const period = lockedPeriod((snapshot.timesheetPeriods ?? []).find((record) => record.startDate <= input.workDate && record.endDate >= input.workDate));

  let current = project;
  if (input.remainingHours !== undefined) {
    current = (await writeAsLink(deps, {
      access, currentProject: project, grant, input: { expectedVersion: task.version, patch: { remainingHours: input.remainingHours } },
      itemId: taskId, operation: 'update', projectId, reason: 'task-access-task-updated',
    })).project;
  }
  const entry = await deps.resourceFinanceRepository.createTimeEntry({
    input: {
      billable: false, hours: input.hours, note: input.note, periodId: period?.id ?? null, projectId,
      resourceId: grant.resource.id, status: 'submitted', workDate: input.workDate, workItemId: taskId,
    },
    tenantId: access.tenantId,
  });
  return { entry: presentTimeEntry(entry), ok: true, task: presentWrittenItem(current, taskId, { assigneeId: grant.assigneeId, columns }) };
}

/** Deletes one of their own time entries on the project while it is still submitted. */
export async function deleteTimeEntryForToken(deps, { entryId, expectedVersion, projectId, token }) {
  const access = await resolveAccessToken(deps, { token });
  const grant = taskGrantFor(access, projectId);
  const snapshot = await deps.resourceFinanceRepository.listSnapshot({ tenantId: access.tenantId });
  const entry = snapshot.timeEntries.find((record) => record.id === entryId && record.projectId === projectId);
  if (!entry || entry.resourceId !== grant.resource.id || entry.status !== 'submitted') {
    throw new HttpError(404, 'Time entry not found.', { details: { code: 'time_entry_not_found' } });
  }
  lockedPeriod(entry.periodId ? (snapshot.timesheetPeriods ?? []).find((record) => record.id === entry.periodId) : null);
  let removed;
  try {
    // The repository checks it is still theirs, still submitted and in an open period as it deletes.
    removed = await deps.resourceFinanceRepository.deleteTimeEntry({ expectedVersion, ownSubmitted: { resourceId: grant.resource.id }, tenantId: access.tenantId, timeEntryId: entryId });
  } catch (error) {
    throw asVersionConflict(error);
  }
  if (!removed) throw new HttpError(404, 'Time entry not found.', { details: { code: 'time_entry_not_found' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Managers: the link's state, issuing it, and turning it off
// ---------------------------------------------------------------------------

/** The access link for an email as managers see it, or null when there is none. */
export async function describeAccessLink(deps, { email, tenantId }) {
  if (!email) return null;
  const link = await deps.accessRepository.findLinkByEmail({ email, tenantId });
  if (!link) return null;
  const now = nowFor(deps);
  const { grants } = await evaluateEmailAccess(deps, { email, now, tenantId });
  const status = computeAccessLinkStatus({ grants, link, now });
  return { expiresAt: status.expiresAt, lastUsedAt: link.lastUsedAt, status: status.status };
}

/**
 * Emails the link: who sent it, the workspace, the projects it opens now, and the link. The link
 * exists whether or not this works, so a failure is logged and reported as not emailed.
 */
async function emailAccessLink(deps, { email, recipientName, sender, tenantId, url }) {
  if (!deps.mailRepository?.queueMail) return false;
  try {
    const { projects } = await evaluateEmailAccess(deps, { email, now: nowFor(deps), tenantId });
    const projectNames = [];
    for (const projectId of projects.keys()) {
      const project = await deps.projectRepository.getProjectDetail({ projectId, tenantId });
      if (project?.name) projectNames.push(project.name);
    }
    const workspace = await deps.authRepository?.findTenantById?.(tenantId);
    return Boolean(await queueTaskAccessLinkEmail({
      accessUrl: url,
      mailRepository: deps.mailRepository,
      projectNames: projectNames.sort((left, right) => left.localeCompare(right)),
      recipientEmail: email,
      recipientName,
      senderName: sender.name ?? '',
      // mail_queue.mail_target_id is VARCHAR(36) in production.
      targetId: randomUUID(),
      workspaceName: workspace?.name ?? '',
    }));
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('access.emailLink', { tenantId }),
      error,
      level: 'warn',
      message: 'Access link email could not be queued.',
    });
    return false;
  }
}

/**
 * Issues a token on the email's access link, making the link or starting a revoked one afresh,
 * then emails it (`emailed`) or returns its URL to copy, shown this once (`url`).
 */
export async function issueAccessLink(deps, { delivery, email, recipientName, sender, tenantId }) {
  const token = generateAccessToken();
  await deps.accessRepository.issueLinkToken({
    createdBy: `user:${sender.id}`, email, now: nowFor(deps), purpose: delivery, tenantId, tokenHash: hashAccessToken(token),
  });
  const url = buildAccessLinkUrl({ frontendAppUrl: deps.frontendAppUrl, token });
  if (delivery === 'manual') return { emailed: false, ok: true, url };
  return { emailed: await emailAccessLink(deps, { email, recipientName, sender, tenantId, url }), ok: true };
}

/**
 * Turns off the access link for an email across the workspace, with every token on it and every
 * requirements token it minted. Returns whether there was a link to turn off.
 */
export async function revokeAccessLink(deps, { email, revokedBy, tenantId }) {
  const link = email ? await deps.accessRepository.findLinkByEmail({ email, tenantId }) : null;
  if (!link) return false;
  const now = nowFor(deps);
  await deps.accessRepository.revokeLink({ linkId: link.id, now, revokedBy, tenantId });
  await deps.requirementsRepository.revokeTokensCreatedBy({ createdBy: accessLinkCreatedBy(link.id), now, tenantId });
  return true;
}
