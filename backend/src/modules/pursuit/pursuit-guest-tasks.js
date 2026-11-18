// The guests' task source (guests/guest-tasks.js), built on the pursuit board's visibility rule
// (pursuit-visibility.js, docs/engagements/qna.md Q-06): a guest sees the pursuit tasks assigned
// to their stakeholder record, or every pursuit task while "Guests see the whole board" is on.
// They change the status of, comment on and attach files to only their own.
//
// A guest writes as their stakeholder (`stakeholder:<id>`), as a task-access link writes as its
// resource (`resource:<id>`), so revisions, comments and files name them.
import sanitizeHtml from 'sanitize-html';

import { markdownToSafeHtml } from '../../lib/content/email-markdown.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { publishProjectChanged } from '../../lib/events/project-live-events.js';
import { LINK_COMMENT_HTML } from '../access/access.service.js';
import { writeProjectItemChange } from '../projects/projects.service.js';
import { planWorkflowTransitions } from '../workflows/workflows.service.js';
import { nameOutsideAssignees, outsiderAssigneeIds, pursuitTasksForOutsider, stakeholderAssigneeId } from './pursuit-visibility.js';

// The board's statuses when no task workflow is bound (as the pursuit board and task links use).
const BOARD_STATUSES = Object.freeze(['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed']);

function taskNotFound() {
  return new HttpError(404, 'Task not found.', { details: { code: 'task_not_found' } });
}

function notYourTask() {
  return new HttpError(403, 'Only tasks assigned to you can be changed here.', { details: { code: 'not_your_task' } });
}

function invalid(message, code) {
  return new HttpError(400, message, { details: { code } });
}

// The statuses a task may take: the project's task workflow when one is bound, or the board's.
async function taskStatuses(deps, { projectId, tenantId }) {
  const snapshot = deps.workflowRepository?.listSnapshot ? await deps.workflowRepository.listSnapshot({ tenantId }) : null;
  const binding = snapshot?.bindings?.find((entry) => entry.projectId === projectId && entry.itemType === 'task');
  const workflow = binding ? snapshot.workflows.find((entry) => entry.id === binding.workflowId && entry.status === 'active') : null;
  if (workflow?.states?.length) return workflow.states.map((state) => state.key);
  return [...BOARD_STATUSES];
}

function presentTask(task) {
  return {
    assignedToMe: task.mine,
    assigneeName: task.mine ? '' : task.assigneeName ?? '',
    canAttach: task.canChange.includes('attachment'),
    canComment: task.canChange.includes('comment'),
    canUpdate: task.canChange.includes('status'),
    dueDate: task.targetEndDate ? String(task.targetEndDate).slice(0, 10) : null,
    id: task.id,
    name: task.name,
    priority: task.priority ?? null,
    status: task.status,
    version: task.version ?? null,
  };
}

function presentComment(comment, actorId) {
  return {
    authorName: comment.author?.name ?? comment.userName ?? '',
    createdAt: comment.createdAt,
    html: sanitizeHtml(String(comment.comment ?? ''), LINK_COMMENT_HTML),
    id: comment.id,
    mine: comment.userId === actorId,
  };
}

function flatten(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

export function createPursuitGuestTaskSource(deps) {
  // The pursuit tasks the guest sees, with the project they sit in.
  async function visible({ projectId, stakeholderIds, tenantId }) {
    const [settings, project] = await Promise.all([
      deps.projectRepository.getProjectSettings({ projectId, tenantId }),
      deps.projectRepository.getProjectDetail({ includePursuit: true, projectId, tenantId }),
    ]);
    if (!settings || !project) return { project: null, settings, tasks: [] };
    const assigneeIds = new Set();
    for (const id of stakeholderIds ?? []) {
      for (const assigneeId of await outsiderAssigneeIds(deps, { principal: { id, type: 'stakeholder' }, projectId, tenantId }) ?? []) assigneeIds.add(assigneeId);
    }
    if (!assigneeIds.size) return { project, settings, tasks: [] };
    const stakeholders = deps.assistantRepository?.listProjectStakeholders ? await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId }) : [];
    const named = nameOutsideAssignees(project, stakeholders);
    return { project, settings, tasks: pursuitTasksForOutsider({ assigneeIds, guestsSeeBoard: settings.guestsSeeBoard, project: named }) };
  }

  // A pursuit task the guest sees; with `change`, one they may make that change to.
  async function requireTask({ change = null, projectId, stakeholderIds, taskId, tenantId }) {
    const found = await visible({ projectId, stakeholderIds, tenantId });
    const task = found.tasks.find((entry) => entry.id === taskId);
    if (!task) throw taskNotFound();
    if (change && !task.canChange.includes(change)) throw notYourTask();
    return { ...found, task };
  }

  return {
    available: true,

    async listTasksForGuest({ projectId, stakeholderIds, tenantId }) {
      const { settings, tasks } = await visible({ projectId, stakeholderIds, tenantId });
      return {
        statuses: tasks.length ? await taskStatuses(deps, { projectId, tenantId }) : [],
        tasks: tasks.map(presentTask),
        wholeBoard: Boolean(settings?.guestsSeeBoard),
      };
    },

    requireTaskForGuest: requireTask,

    // For Odin's guest turn (channels/odin-guest-api.js): the tasks the guest sees, in the shape
    // the project read gives them, with no more than the guest view shows.
    async listTasks({ projectId, stakeholderId, tenantId }) {
      const { tasks } = await visible({ projectId, stakeholderIds: [stakeholderId], tenantId });
      return tasks.map((task) => ({
        assigneeName: task.assigneeName ?? '',
        id: task.id,
        mine: task.mine,
        name: task.name,
        priority: task.priority ?? null,
        status: task.status,
        targetEndDate: task.targetEndDate ?? null,
      }));
    },

    async updateTaskForGuest({ actor, input, projectId, stakeholderIds, taskId, tenantId }) {
      const { project, task } = await requireTask({ change: 'status', projectId, stakeholderIds, taskId, tenantId });
      const statuses = await taskStatuses(deps, { projectId, tenantId });
      if (!statuses.includes(input.status)) throw invalid(`${input.status} is not a status on this board.`, 'status_not_allowed');
      const writer = { id: stakeholderAssigneeId(actor.stakeholderId), name: actor.name };
      await writeProjectItemChange({
        currentProject: project,
        input: { expectedVersion: task.version, patch: { status: input.status } },
        itemId: taskId,
        metricsRepository: deps.metricsRepository ?? null,
        operation: 'update',
        planTransitions: (nextProject) => planWorkflowTransitions({ currentProject: project, nextProject, projectRole: '', tenantId, user: writer, workflowRepository: deps.workflowRepository }),
        projectId,
        repository: deps.projectRepository,
        tenantId,
        user: writer,
        workflowRepository: deps.workflowRepository ?? null,
      });
      publishProjectChanged(deps.liveEventBus, projectId, { actor: writer, itemId: taskId, reason: 'guest-task-updated' });
      const after = await requireTask({ projectId, stakeholderIds, taskId, tenantId });
      return { task: presentTask(after.task) };
    },

    async listTaskCommentsForGuest({ actor, projectId, stakeholderIds, taskId, tenantId }) {
      const { task } = await requireTask({ projectId, stakeholderIds, taskId, tenantId });
      const tree = await deps.projectRepository.listComments({ projectId, targetId: taskId, targetType: 'task', tenantId });
      const comments = flatten(tree).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      return { canComment: task.canChange.includes('comment'), comments: comments.map((comment) => presentComment(comment, stakeholderAssigneeId(actor.stakeholderId))) };
    },

    async addTaskCommentForGuest({ actor, input, projectId, stakeholderIds, taskId, tenantId }) {
      await requireTask({ change: 'comment', projectId, stakeholderIds, taskId, tenantId });
      const html = markdownToSafeHtml(input.text);
      if (!html) throw invalid('Write something to comment.', 'comment_empty');
      const writer = { id: stakeholderAssigneeId(actor.stakeholderId), name: actor.name };
      const comment = await deps.projectRepository.addComment({ comment: html, parentId: null, projectId, targetId: taskId, targetType: 'task', tenantId, user: writer });
      publishProjectChanged(deps.liveEventBus, projectId, { actor: writer, itemId: taskId, reason: 'guest-task-commented' });
      return { comment: presentComment(comment, writer.id) };
    },
  };
}
