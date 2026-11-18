import {
  appendMysqlProjectChanges, commentChange, createInMemoryProjectChangeLog, fileChange, itemRevisionChange, listMysqlItemChanges, listMysqlProjectChanges, relationChange, splitStoryChanges, sprintChange,
} from '../changes/project-change-log.js';
import { createInMemoryItemChangeRequests, createMysqlItemChangeRequests } from '../changes/item-change-requests.js';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  extractMentionedUserIds,
  sanitizeRichHtml,
} from '../../lib/content/html-content.js';
import {
  normalizeStoredRichTextMarkdown,
  renderStoredRichTextToHtml,
} from '../../lib/content/rich-text.js';
import {
  buildMentionNotification,
  extractMentionSpans,
} from '../../lib/mentions/mention-notifications.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { isOfficeFile, isStoredPreview, OFFICE_CONTENT_TYPES, OFFICE_EXTENSIONS } from '../../lib/files/file-preview.js';
import { assertFileScanClean } from '../../lib/files/file-scan-status.js';
import {
  assignBoardColumnKeys,
  moveKanbanItem,
  normalizeBoardColumnKey,
  resolveBoardColumnForPatch,
  resolveKanbanColumn,
  slugifyBoardColumnKey,
  sortKanbanItems,
} from '../../lib/projects/kanban-placement.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import {
  COMPLETED_STATUS,
  normalizeActualHours,
  normalizePercentComplete,
  normalizeRemainingHours,
  storyCompletionCascades,
  workProgressPercent,
} from '../../lib/projects/work-progress.js';
import {
  applyChildEstimates,
  applyProjectEstimateRollups,
  estimateOverrideFlag,
} from '../../lib/projects/work-estimates.js';
import {
  CANONICAL_PROJECT_STATUSES,
  isCanonicalProjectStatus,
  normalizeStoredProjectStatusForDisplay as normalizeProjectStatusForDisplay,
  resolveStoredProjectStatusRow,
} from '../../lib/projects/project-statuses.js';
import { queueMentionEmail } from '../mail/mail.service.js';
import { findEmailOptOuts, isOptedOut, readUserPreferencesMemory, readUserPreferencesMysql } from '../users/notification-preferences.js';
import { ensureOnce } from '../../lib/database/ensure-once.js';
import { ensureMysqlAssigneeResources, resourceIdFromAssignee, treeAssigneeIds } from '../resource-finance/assignee-resources.js';
import { assertTicketReferences, inTicketProjectScope } from './ticket-references.js';
import {
  activeProjectSql,
  createInMemoryProjectDeletionMethods,
  createMysqlProjectDeletionMethods,
} from './project-deletion.repository.js';
import { deliveryProjectSql, engagementFieldsOf, projectKindOf } from '../../lib/projects/project-kind.js';
import {
  createInMemoryEngagementMethods,
  createMysqlEngagementMethods,
  engagementColumnsSql,
  engagementFieldsFromRow,
} from '../engagements/engagements.repository.js';
import { createInMemoryChannelActivityMethods, createMysqlChannelActivityMethods } from '../channels/channel-activity.repository.js';
import { createInMemorySearchSourceMethods, createMysqlSearchSourceMethods } from '../reporting/search-sources.repository.js';
import { createInMemoryChannelMethods, createMysqlChannelMethods, editingMarker } from '../channels/channels.repository.js';
import {
  BOARD_SCOPE_PURSUIT,
  isPursuitItem,
  onlyPursuitWork,
  pursuitItemIds,
  syncPursuitMarkers,
  withoutPursuitWork,
} from '../../lib/projects/pursuit.js';
import { createInMemoryPursuitMethods, createMysqlPursuitMethods } from '../pursuit/pursuit.repository.js';
import { archiveRecordIds, copyArchiveWithNewIds } from './project-archive-ids.js';
import { createInMemoryOdinReplyMethods, createMysqlOdinReplyMethods } from '../channels/odin-replies.repository.js';
import { createInMemoryPollMethods, createMysqlPollMethods } from '../channels/polls.repository.js';
import { createInMemoryChatMethods, createMysqlChatMethods, DM_TARGET_TYPE } from '../chat/chat.repository.js';

export const CANONICAL_TASK_TYPES = ['Epic', 'Story', 'Task', 'Ticket'];

export const TICKET_CATEGORIES = ['defect', 'support', 'question', 'change_request'];
export const TICKET_SEVERITIES = ['S1', 'S2', 'S3', 'S4'];
export const TICKET_EXTERNAL_REVIEW_STATES = ['not_external', 'pending', 'validated', 'rejected'];
export const WORK_ITEM_RELATION_TYPES = ['caused_by', 'affects', 'duplicate_of', 'blocks'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireExpectedProjectVersion(expectedUpdatedAt, actualUpdatedAt) {
  if (!expectedUpdatedAt) return;
  if (Date.parse(expectedUpdatedAt) !== Date.parse(actualUpdatedAt)) {
    throw new HttpError(409, 'Project changed since it was loaded. Refresh and retry.', {
      details: { actualUpdatedAt, code: 'project_version_conflict', expectedUpdatedAt },
    });
  }
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function rowDate(value) {
  return value ? toIsoString(value) : null;
}

function toMysqlDateTime(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }

  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.valueOf())) {
    return parsed.toISOString().slice(0, 19).replace('T', ' ');
  }

  return normalized.slice(0, 19).replace('T', ' ');
}

function archiveDateTime(value) {
  return toMysqlDateTime(value ?? new Date());
}

function normalizeArchiveUserMappings(userMappings = []) {
  return new Map(
    (Array.isArray(userMappings) ? userMappings : [])
      .map((entry) => [String(entry?.sourceUserId ?? '').trim(), String(entry?.targetUserId ?? '').trim()])
      .filter(([sourceUserId]) => sourceUserId),
  );
}

function mappedArchiveUserId(sourceUserId, userMap, fallback = null) {
  const normalized = String(sourceUserId ?? '').trim();
  if (!normalized) {
    return fallback;
  }

  return userMap.get(normalized) || fallback;
}

function normalizeArchiveOverwriteMode(value) {
  return ['project', 'all'].includes(value) ? value : 'none';
}

function archiveConflictGroups(conflicts = []) {
  const groups = new Map();
  for (const conflict of conflicts ?? []) {
    const type = String(conflict?.type ?? '').trim();
    const id = String(conflict?.id ?? '').trim();
    if (!type || !id) {
      continue;
    }

    const group = groups.get(type) ?? {
      count: 0,
      ids: [],
      type,
    };
    group.count += 1;
    group.ids.push(id);
    groups.set(type, group);
  }

  return [...groups.values()].sort((left, right) => left.type.localeCompare(right.type));
}

function archiveConflictDetails(conflicts = []) {
  return {
    conflictGroups: archiveConflictGroups(conflicts),
    conflicts,
  };
}

function throwArchiveConflict(conflicts, message = 'Project archive conflicts with existing records.') {
  throw new HttpError(409, message, {
    details: archiveConflictDetails(conflicts),
  });
}

function normalizeArchiveStakeholders(archiveData = {}) {
  const stakeholdersById = new Map();
  const addStakeholder = (input = {}) => {
    const id = String(input.id ?? '').trim();
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!id || !email || stakeholdersById.has(id)) {
      return;
    }

    stakeholdersById.set(id, {
      accessToken: String(input.access_token ?? input.accessToken ?? '').trim() || randomUUID().replace(/-/g, ''),
      createdAt: input.created_at ?? input.createdAt,
      email,
      id,
      name: String(input.name ?? '').trim() || email,
      roleTitle: input.role_title ?? input.roleTitle ?? '',
      updatedAt: input.updated_at ?? input.updatedAt ?? input.created_at ?? input.createdAt,
    });
  };

  for (const stakeholder of archiveData.stakeholders ?? []) {
    addStakeholder(stakeholder);
  }
  for (const stakeholder of archiveData.assistantProjectState?.stakeholders ?? []) {
    addStakeholder(stakeholder);
  }
  for (const stakeholder of archiveData.assistantProjectState?.stakeholderContacts ?? []) {
    addStakeholder(stakeholder);
  }

  return [...stakeholdersById.values()];
}

function remapTaskArchiveAssignments(task, userMap) {
  const nextTask = {
    ...task,
    assigneeId: mappedArchiveUserId(task.assigneeId, userMap, null),
    assigneeName: mappedArchiveUserId(task.assigneeId, userMap, null) ? task.assigneeName : '',
  };

  if (Array.isArray(nextTask.stories)) {
    nextTask.stories = nextTask.stories.map((story) => remapTaskArchiveAssignments(story, userMap));
  }
  if (Array.isArray(nextTask.tasks)) {
    nextTask.tasks = nextTask.tasks.map((child) => remapTaskArchiveAssignments(child, userMap));
  }

  return nextTask;
}

// An archive is an upload. What it says about files is checked before an overwrite touches
// anything, as storage deletes do not roll back.
function assertArchiveFileRecords(archiveData = {}) {
  const fileIds = new Set((archiveData.files ?? []).map((file) => file.id));
  for (const version of archiveData.fileVersions ?? []) {
    if (!fileIds.has(version.file_id ?? version.fileId)) throw new HttpError(400, 'The archive has a file version without its file.');
  }
  for (const link of archiveData.fileLinks ?? []) {
    if (!fileIds.has(link.file_id ?? link.fileId)) throw new HttpError(400, 'The archive has a file link without its file.');
  }
}

function collectArchiveSourceUserIds(archiveData = {}) {
  const ids = new Set();
  const add = (value) => {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      ids.add(normalized);
    }
  };
  const walkTask = (task) => {
    add(task?.assigneeId);
    for (const child of task?.stories ?? []) walkTask(child);
    for (const child of task?.tasks ?? []) walkTask(child);
  };

  for (const user of archiveData.users ?? []) add(user.id);
  for (const user of archiveData.projectUsers ?? []) add(user.user_id ?? user.id);
  for (const sprintStaffing of archiveData.sprintStaffing ?? []) add(sprintStaffing.user_id ?? sprintStaffing.userId);
  for (const comment of archiveData.comments ?? []) add(comment.user_id ?? comment.userId);
  for (const vote of archiveData.commentVotes ?? []) add(vote.user_id ?? vote.userId);
  for (const file of archiveData.files ?? []) add(file.user_id ?? file.userId ?? file.uploadedBy?.id);
  for (const version of archiveData.fileVersions ?? []) add(version.user_id ?? version.userId);
  for (const link of archiveData.fileLinks ?? []) add(link.created_by ?? link.createdBy);
  for (const task of archiveData.project?.epics ?? []) walkTask(task);
  for (const log of archiveData.taskLogs ?? []) {
    const data = typeof log.log_data === 'string' ? safeJsonParse(log.log_data, {}) : log.log_data;
    add(data?.assigned_to);
  }
  for (const assignment of archiveData.clarificationAssignments ?? []) {
    if (assignment.actor_type === 'user' || assignment.actorType === 'user') add(assignment.actor_id ?? assignment.actorId);
  }
  for (const comment of archiveData.clarificationComments ?? []) {
    if (comment.actor_type === 'user' || comment.actorType === 'user') add(comment.actor_id ?? comment.actorId);
  }
  for (const reaction of archiveData.clarificationCommentReactions ?? []) {
    if (reaction.actor_type === 'user' || reaction.actorType === 'user') add(reaction.actor_id ?? reaction.actorId);
  }

  return [...ids];
}

function collectArchiveProjectTaskIds(project = {}) {
  const ids = [];
  const walkTask = (task) => {
    const id = String(task?.id ?? '').trim();
    if (id) {
      ids.push(id);
    }
    for (const child of task?.stories ?? []) walkTask(child);
    for (const child of task?.tasks ?? []) walkTask(child);
  };

  for (const epic of project?.epics ?? []) walkTask(epic);
  return ids;
}

function archiveTaskLogTaskId(log) {
  return String(log?.task_id ?? log?.taskId ?? '').trim();
}

function buildArchiveSourceUsers(archiveData = {}, tenantUsers = []) {
  const usersById = new Map((archiveData.users ?? []).map((user) => [user.id, user]));
  const targetByEmail = new Map(
    tenantUsers
      .map((user) => [String(user.email ?? '').trim().toLowerCase(), user])
      .filter(([email]) => email),
  );

  return collectArchiveSourceUserIds(archiveData).map((id) => {
    const user = usersById.get(id) ?? {};
    const email = String(user.email ?? '').trim();
    const suggested = email ? targetByEmail.get(email.toLowerCase()) ?? null : null;

    return {
      email,
      id,
      name: user.name ?? id,
      suggestedTargetUserId: suggested?.id ?? null,
    };
  });
}

function countProjectTasks(project = {}) {
  let count = 0;
  const walk = (task) => {
    count += 1;
    for (const child of task?.stories ?? []) walk(child);
    for (const child of task?.tasks ?? []) walk(child);
  };

  for (const epic of project.epics ?? []) {
    walk(epic);
  }

  return count;
}

function membershipForTenant(user, tenantId) {
  return user?.memberships?.find((item) => item.tenantId === tenantId) ?? user?.memberships?.[0] ?? null;
}

function isTenantModerator(user, tenantId) {
  const role = membershipForTenant(user, tenantId)?.role ?? 'user';
  return role === 'admin' || role === 'manager';
}

function canEditComment(user, ownerUserId) {
  return user?.id === ownerUserId;
}

function sortProjects(projects) {
  return [...projects].sort((left, right) => {
    if (left.rank == null && right.rank != null) {
      return 1;
    }

    if (left.rank != null && right.rank == null) {
      return -1;
    }

    if (left.rank != null && right.rank != null && left.rank !== right.rank) {
      return left.rank - right.rank;
    }

    return left.name.localeCompare(right.name);
  });
}

function roundProgress(value) {
  return Math.round(value * 10) / 10;
}

function resolveAssigneeName(authRepository, assigneeId, fallbackName = '') {
  if (!assigneeId) {
    return fallbackName;
  }

  const user = authRepository?.state?.users?.find((item) => item.id === assigneeId);
  return user?.name ?? fallbackName;
}

function normalizeLeafTask(task, authRepository) {
  const assigneeId = task.assigneeId ?? null;
  const status = task.status ?? 'Not Started';

  return {
    actualHours: normalizeActualHours(task.actualHours),
    estimateOverride: estimateOverrideFlag(task.estimateOverride) === 1,
    assigneeId,
    assigneeName: resolveAssigneeName(authRepository, assigneeId, task.assigneeName ?? ''),
    boardColumn: normalizeBoardColumnKey(task.boardColumn),
    description: normalizeStoredRichTextMarkdown(task.description ?? ''),
    id: task.id ?? randomUUID(),
    name: task.name,
    percentComplete: normalizePercentComplete(task.percentComplete),
    points: task.points ?? null,
    priority: task.priority ?? 4,
    progress: workProgressPercent('task', { ...task, status }),
    remainingHours: normalizeRemainingHours(task.remainingHours),
    sprintId: task.sprintId ?? null,
    sprintSortOrder: task.sprintSortOrder ?? null,
    status,
    sourceClarificationIds: Array.isArray(task.sourceClarificationIds)
      ? [...new Set(task.sourceClarificationIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
      : [],
    targetEndDate: dateOnlyValue(task.targetEndDate),
    targetHourEstimate: task.targetHourEstimate ?? null,
    targetStartDate: dateOnlyValue(task.targetStartDate),
    updatedAt: task.updatedAt ?? new Date().toISOString(),
    version: Number.isInteger(task.version) && task.version > 0 ? task.version : 1,
    ...(isPursuitItem(task) ? { pursuit: true } : {}),
  };
}

function normalizeTicketFields(task) {
  return {
    actualResult: task.actualResult ?? '',
    buildVersion: task.buildVersion ?? '',
    category: TICKET_CATEGORIES.includes(task.category) ? task.category : 'defect',
    environmentId: task.environmentId ?? null,
    expectedResult: task.expectedResult ?? '',
    externalReviewState: TICKET_EXTERNAL_REVIEW_STATES.includes(task.externalReviewState) ? task.externalReviewState : 'not_external',
    fixedInReleaseId: task.fixedInReleaseId ?? null,
    foundInReleaseId: task.foundInReleaseId ?? null,
    lastReopenedAt: task.lastReopenedAt ?? null,
    reopenCount: Number.isInteger(task.reopenCount) && task.reopenCount > 0 ? task.reopenCount : 0,
    reporterExternalId: task.reporterExternalId ?? null,
    reproSteps: task.reproSteps ?? '',
    severity: TICKET_SEVERITIES.includes(task.severity) ? task.severity : 'S3',
  };
}

function normalizeTaskNode(task, level, authRepository, { parentId = null } = {}) {
  const baseTask = normalizeLeafTask(task, authRepository);
  const issueType = level === 'epic' ? 'epic' : level === 'story' ? 'story' : level === 'ticket' ? 'ticket' : 'task';

  if (level === 'ticket') {
    return {
      ...baseTask,
      ...normalizeTicketFields(task),
      issueType,
      parentId: task.parentId ?? parentId ?? null,
    };
  }

  if (level === 'task') {
    return {
      ...baseTask,
      issueType,
    };
  }

  const childKey = level === 'epic' ? 'stories' : 'tasks';
  const childLevel = level === 'epic' ? 'story' : 'task';
  const children = (task[childKey] ?? []).map((child) => normalizeTaskNode(child, childLevel, authRepository));
  const node = {
    ...baseTask,
    [childKey]: children,
    issueType,
  };

  applyChildEstimates(node, children);

  return {
    ...node,
    progress: workProgressPercent(level, node),
  };
}

function normalizeSprint(sprint, projectId) {
  return {
    endDate: dateOnlyValue(sprint.endDate),
    goal: sanitizeRichHtml(sprint.goal ?? ''),
    id: sprint.id ?? randomUUID(),
    name: sprint.name,
    projectId: sprint.projectId ?? projectId,
    sortOrder: sprint.sortOrder ?? 0,
    startDate: dateOnlyValue(sprint.startDate),
    status: sprint.status ?? 'planned',
  };
}

function normalizeSprintStaffingEntry(entry, sprintId) {
  return {
    allocationPctOverride: entry.allocationPctOverride ?? null,
    capacityHours: entry.capacityHours ?? null,
    notes: String(entry.notes ?? ''),
    sprintId: entry.sprintId ?? sprintId,
    userId: entry.userId,
  };
}

function createDefaultKanbanConfig() {
  return {
    assigneeIds: [],
    columns: [],
    hideDone: false,
    includeBacklog: true,
    issueTypes: [],
    presets: [],
    search: '',
    selectedSprintIds: [],
    statusValues: [],
    swimlane: 'none',
  };
}

function normalizeKanbanConfig(config = {}) {
  const defaults = createDefaultKanbanConfig();
  return {
    ...defaults,
    ...config,
    assigneeIds: Array.isArray(config.assigneeIds) ? [...config.assigneeIds] : [],
    columns: Array.isArray(config.columns)
      ? assignBoardColumnKeys(config.columns.map((column) => ({
          defaultStatus: String(column?.defaultStatus ?? '').trim(),
          key: normalizeBoardColumnKey(column?.key),
          name: String(column?.name ?? '').trim(),
          statuses: Array.isArray(column?.statuses) ? column.statuses.map((status) => String(status ?? '').trim()).filter(Boolean) : [],
        })).filter((column) => column.name && column.defaultStatus && column.statuses.length > 0))
      : [],
    issueTypes: Array.isArray(config.issueTypes) ? [...config.issueTypes] : [],
    presets: Array.isArray(config.presets)
      ? config.presets.map((preset) => ({
          filters: normalizeKanbanConfig(preset?.filters ?? {}),
          id: String(preset?.id ?? '').trim(),
          name: String(preset?.name ?? '').trim(),
        })).filter((preset) => preset.id && preset.name)
      : [],
    search: String(config.search ?? '').trim(),
    selectedSprintIds: Array.isArray(config.selectedSprintIds) ? [...config.selectedSprintIds] : [],
    statusValues: Array.isArray(config.statusValues) ? [...config.statusValues] : [],
    swimlane: ['none', 'assignee', 'epic', 'sprint', 'issueType'].includes(config.swimlane) ? config.swimlane : 'none',
  };
}

function buildDefaultKanbanColumns(statuses = []) {
  return assignBoardColumnKeys(statuses.map((status) => ({
    defaultStatus: status,
    key: slugifyBoardColumnKey(status),
    name: status,
    statuses: [status],
  })));
}

function placeKanbanCards(items, columns) {
  return items.map((item) => ({
    ...item,
    columnKey: resolveKanbanColumn(item, columns)?.key ?? null,
  }));
}

function projectStatusOptionsFromProject(project) {
  const found = new Set();
  for (const epic of project?.epics ?? []) {
    if (epic?.status) found.add(epic.status);
    for (const story of epic.stories ?? []) {
      if (story?.status) found.add(story.status);
      for (const task of story.tasks ?? []) {
        if (task?.status) found.add(task.status);
      }
    }
  }

  const orderedDefaults = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];
  const ordered = orderedDefaults.filter((status) => found.has(status));
  for (const status of found) {
    if (!ordered.includes(status)) {
      ordered.push(status);
    }
  }

  return ordered;
}

// Board and sprint cards. Delivery views get delivery work only. The pursuit board gets the
// pursuit tasks as a flat list: their hidden story is not a card.
function buildPlanningItems(project, { scope = 'delivery' } = {}) {
  const items = [];
  let treeOrder = 0;
  const pursuitScope = scope === BOARD_SCOPE_PURSUIT;

  for (const epic of project?.epics ?? []) {
    if (isPursuitItem(epic) !== pursuitScope) continue;
    for (const story of epic.stories ?? []) {
      if (!pursuitScope) items.push({
        assigneeId: story.assigneeId ?? null,
        assigneeName: story.assigneeName ?? '',
        boardColumn: story.boardColumn ?? null,
        epicId: epic.id,
        epicName: epic.name,
        id: story.id,
        issueType: 'story',
        name: story.name,
        parentId: epic.id,
        parentName: epic.name,
        points: story.points ?? null,
        priority: story.priority ?? 4,
        sprintId: story.sprintId ?? null,
        sprintSortOrder: story.sprintSortOrder ?? null,
        status: story.status ?? 'Not Started',
        storyId: story.id,
        storyName: story.name,
        treeOrder: treeOrder++,
        targetEndDate: dateOnlyValue(story.targetEndDate),
        targetHourEstimate: story.targetHourEstimate ?? null,
        targetStartDate: dateOnlyValue(story.targetStartDate),
      });

      for (const task of story.tasks ?? []) {
        items.push({
          assigneeId: task.assigneeId ?? null,
          assigneeName: task.assigneeName ?? '',
          boardColumn: task.boardColumn ?? null,
          epicId: epic.id,
          epicName: epic.name,
          id: task.id,
          issueType: 'task',
          name: task.name,
          parentId: story.id,
          parentName: story.name,
          points: task.points ?? null,
          priority: task.priority ?? 4,
          sprintId: task.sprintId ?? null,
          sprintSortOrder: task.sprintSortOrder ?? null,
          status: task.status ?? 'Not Started',
          storyId: story.id,
          storyName: story.name,
          treeOrder: treeOrder++,
          targetEndDate: dateOnlyValue(task.targetEndDate),
          targetHourEstimate: task.targetHourEstimate ?? null,
          targetStartDate: dateOnlyValue(task.targetStartDate),
        });
      }
    }
  }

  return items;
}

function buildPlanningSummary(items, staffing = []) {
  const totalPoints = items.reduce((sum, item) => sum + (Number(item.points ?? 0) || 0), 0);
  const totalHours = items.reduce((sum, item) => sum + (Number(item.targetHourEstimate ?? 0) || 0), 0);
  const completedCount = items.filter((item) => item.status === 'Completed').length;
  const storyCount = items.filter((item) => item.issueType === 'story').length;
  const taskCount = items.filter((item) => item.issueType === 'task').length;
  const capacityHours = staffing.reduce((sum, entry) => sum + (Number(entry.capacityHours ?? 0) || 0), 0);

  return {
    capacityHours,
    completedCount,
    completedPercent: items.length > 0 ? roundProgress((completedCount / items.length) * 100) : 0,
    storyCount,
    taskCount,
    totalHours,
    totalItems: items.length,
    totalPoints,
  };
}

function sortPlanningItemsByOrder(items) {
  return [...items].sort((left, right) => {
    const orderDelta = Number(left.sprintSortOrder ?? 0) - Number(right.sprintSortOrder ?? 0);
    if (orderDelta !== 0) {
      return orderDelta;
    }

    return Number(left.treeOrder ?? 0) - Number(right.treeOrder ?? 0);
  });
}

const KANBAN_RANK_UPDATE_BATCH_SIZE = 200;

function orderKanbanItems(items, ranks) {
  return sortKanbanItems(sortPlanningItemsByOrder(items), ranks);
}

// Returns the full board order with `itemId` moved next to its anchor, or null when the
// item is not a story or task on this project's board (`scope`: the delivery or pursuit board).
function reorderKanbanItemIds(project, ranks, { afterItemId, beforeItemId, itemId, scope = 'delivery' }) {
  const orderedIds = orderKanbanItems(buildPlanningItems(project, { scope }), ranks).map((item) => item.id);

  if (!orderedIds.includes(itemId)) {
    return null;
  }

  const nextIds = moveKanbanItem(orderedIds, itemId, { afterItemId, beforeItemId });
  if (!nextIds) {
    throw new HttpError(409, 'The board changed since it was loaded. Refresh and try again.');
  }

  return nextIds;
}

// Each person keeps one board view per project and board.
const KANBAN_CONFIG_KEYS = { delivery: 'project_kanban_config', pursuit: 'project_pursuit_kanban_config' };

function kanbanConfigKey(scope) {
  return KANBAN_CONFIG_KEYS[scope] ?? KANBAN_CONFIG_KEYS.delivery;
}

function kanbanConfigStateKey(projectId, userId, scope) {
  return scope === BOARD_SCOPE_PURSUIT ? `${projectId}:${userId}:pursuit` : `${projectId}:${userId}`;
}

// The pursuit board is a flat list of tasks with no sprints, so sprint and type filters that a
// saved view carries never hide its cards.
function kanbanFiltersForScope(filters, scope) {
  if (scope !== BOARD_SCOPE_PURSUIT) return filters;
  return { ...filters, includeBacklog: true, issueTypes: [], selectedSprintIds: [], swimlane: ['none', 'assignee'].includes(filters.swimlane) ? filters.swimlane : 'none' };
}

function kanbanFiltersProjectItems(items, filters) {
  const search = String(filters?.search ?? '').trim().toLowerCase();
  const sprintSet = new Set(filters?.selectedSprintIds ?? []);
  const assigneeSet = new Set(filters?.assigneeIds ?? []);
  const statusSet = new Set(filters?.statusValues ?? []);
  const issueTypeSet = new Set(filters?.issueTypes ?? []);

  return items.filter((item) => {
    if (!filters?.includeBacklog && !item.sprintId) {
      return false;
    }

    if (sprintSet.size > 0 && item.sprintId && !sprintSet.has(item.sprintId)) {
      return false;
    }

    if (sprintSet.size > 0 && !filters?.includeBacklog && !item.sprintId) {
      return false;
    }

    if (assigneeSet.size > 0 && !assigneeSet.has(item.assigneeId ?? '')) {
      return false;
    }

    if (statusSet.size > 0 && !statusSet.has(item.status)) {
      return false;
    }

    if (issueTypeSet.size > 0 && !issueTypeSet.has(item.issueType)) {
      return false;
    }

    if (filters?.hideDone && item.status === 'Completed') {
      return false;
    }

    if (!search) {
      return true;
    }

    return [
      item.assigneeName,
      item.epicName,
      item.name,
      item.parentName,
      item.storyName,
      item.status,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search));
  });
}

function findStoryContextInProject(project, storyId) {
  for (const epic of project?.epics ?? []) {
    for (const [storyIndex, story] of (epic.stories ?? []).entries()) {
      if (story.id === storyId) {
        return {
          epic,
          story,
          storyIndex,
          stories: epic.stories,
        };
      }
    }
  }

  return null;
}

function findProjectItemContext(project, itemId) {
  for (const [epicIndex, epic] of (project?.epics ?? []).entries()) {
    if (epic.id === itemId) {
      return { collection: project.epics, index: epicIndex, itemType: 'epic', node: epic, parent: null, parentId: null };
    }
    for (const [storyIndex, story] of (epic.stories ?? []).entries()) {
      if (story.id === itemId) {
        return { collection: epic.stories, index: storyIndex, itemType: 'story', node: story, parent: epic, parentId: epic.id };
      }
      for (const [taskIndex, task] of (story.tasks ?? []).entries()) {
        if (task.id === itemId) {
          return { collection: story.tasks, index: taskIndex, itemType: 'task', node: task, parent: story, parentId: story.id };
        }
      }
    }
  }
  for (const [ticketIndex, ticket] of (project?.tickets ?? []).entries()) {
    if (ticket.id === itemId) {
      return { collection: project.tickets, index: ticketIndex, itemType: 'ticket', node: ticket, parent: null, parentId: ticket.parentId ?? null };
    }
  }
  return null;
}

function projectItemCollection(project, itemType, parentId) {
  if (itemType === 'epic') {
    if (parentId) throw new HttpError(400, 'Epics cannot have a parent item.');
    return project.epics;
  }
  if (itemType === 'ticket') {
    // Tickets are a flat project-level collection; parentId is a reference, not containment.
    if (parentId) {
      const parent = findProjectItemContext(project, parentId);
      if (!parent || !['epic', 'story', 'task'].includes(parent.itemType)) {
        throw new HttpError(400, 'Tickets require an existing epic, story, or task parent when a parent is set.');
      }
    }
    if (!Array.isArray(project.tickets)) {
      project.tickets = [];
    }
    return project.tickets;
  }
  const parent = findProjectItemContext(project, parentId);
  const requiredParentType = itemType === 'story' ? 'epic' : 'story';
  if (!parent || parent.itemType !== requiredParentType) {
    throw new HttpError(400, `${itemType === 'story' ? 'Stories' : 'Tasks'} require an existing ${requiredParentType} parent.`);
  }
  return itemType === 'story' ? parent.node.stories : parent.node.tasks;
}

function projectItemSnapshot(context) {
  if (!context) return null;
  const node = clone(context.node);
  delete node.stories;
  delete node.tasks;
  return {
    itemType: context.itemType,
    node,
    parentId: context.parentId,
    position: context.index,
  };
}

function flattenProjectItemSnapshots(project) {
  const snapshots = new Map();
  const add = (node, itemType, parentId, position) => {
    const context = { index: position, itemType, node, parentId };
    snapshots.set(node.id, projectItemSnapshot(context));
  };
  for (const [epicIndex, epic] of (project?.epics ?? []).entries()) {
    add(epic, 'epic', null, epicIndex);
    for (const [storyIndex, story] of (epic.stories ?? []).entries()) {
      add(story, 'story', epic.id, storyIndex);
      for (const [taskIndex, task] of (story.tasks ?? []).entries()) add(task, 'task', story.id, taskIndex);
    }
  }
  for (const [ticketIndex, ticket] of (project?.tickets ?? []).entries()) {
    add(ticket, 'ticket', ticket.parentId ?? null, ticketIndex);
  }
  return snapshots;
}

function comparableProjectItemSnapshot(snapshot) {
  if (!snapshot) return null;
  const copy = clone(snapshot);
  delete copy.node.updatedAt;
  delete copy.node.version;
  delete copy.node.progress;
  delete copy.node.assigneeName;
  return copy;
}

function projectItemSnapshotChanged(before, after) {
  return JSON.stringify(comparableProjectItemSnapshot(before)) !== JSON.stringify(comparableProjectItemSnapshot(after));
}

function nextProjectTimestamp(previous) {
  const now = Date.now();
  const previousMs = Date.parse(previous ?? '') || 0;
  return new Date(Math.max(now, previousMs + 1)).toISOString();
}

function projectItemConflict(expectedVersion, actualVersion) {
  if (Number(expectedVersion) !== Number(actualVersion)) {
    throw new HttpError(409, 'Project item changed since it was loaded. Refresh and retry.', {
      details: { actualVersion: Number(actualVersion), code: 'project_item_version_conflict', expectedVersion: Number(expectedVersion) },
    });
  }
}

function normalizeProject(project, authRepository) {
  const now = new Date().toISOString();

  return {
    createdAt: project.createdAt ?? now,
    description: normalizeStoredRichTextMarkdown(project.description ?? ''),
    endDate: project.endDate ?? null,
    epics: (project.epics ?? []).map((epic) => normalizeTaskNode(epic, 'epic', authRepository)),
    id: project.id ?? randomUUID(),
    name: project.name,
    rank: project.rank ?? null,
    role: project.role ?? 'user',
    startDate: project.startDate ?? null,
    status: normalizeProjectStatusForDisplay(project.status ?? 'Planned'),
    tenantId: project.tenantId,
    tickets: (project.tickets ?? []).map((ticket) => normalizeTaskNode(ticket, 'ticket', authRepository)),
    updatedAt: project.updatedAt ?? now,
    ...engagementFieldsOf(project),
  };
}

function buildDemoProjects(authRepository, seed = {}) {
  const tenant = authRepository?.state?.tenants?.[0];
  const user = authRepository?.state?.users?.[0];

  if (!tenant || !user) {
    return [];
  }

  if (seed.projects?.length) {
    return seed.projects.map((project) => normalizeProject(project, authRepository));
  }

  return [
    normalizeProject(
      {
        createdAt: '2026-05-01T10:00:00.000Z',
        description: 'Rebuild the onboarding and activation funnel with clearer ownership and sequencing.',
        endDate: '2026-07-15',
        id: 'demo-project-launch-readiness',
        name: 'Launch Readiness',
        rank: 1,
        role: 'admin',
        startDate: '2026-05-10',
        status: 'In Progress',
        tenantId: tenant.id,
        updatedAt: '2026-05-12T08:30:00.000Z',
        epics: [
          {
            assigneeId: user.id,
            assigneeName: user.name,
            description: 'Stabilize intake and assignment flow.',
            id: 'demo-epic-intake',
            name: 'Intake Workflow',
            points: 13,
            priority: 4,
            progress: 62.5,
            status: 'In Progress',
            stories: [
              {
                assigneeId: user.id,
                assigneeName: user.name,
                description: 'Route incoming work to the right owner.',
                id: 'demo-story-routing',
                name: 'Routing Rules',
                progress: 50,
                status: 'In Progress',
                tasks: [
                  {
                    assigneeId: user.id,
                    assigneeName: user.name,
                    description: 'Document every assignment condition.',
                    id: 'demo-task-rules',
                    name: 'Define routing logic',
                    progress: 100,
                    status: 'Completed',
                  },
                  {
                    assigneeId: user.id,
                    assigneeName: user.name,
                    description: 'Add fallback owner logic for edge cases.',
                    id: 'demo-task-owner',
                    name: 'Fallback ownership',
                    progress: 0,
                    status: 'Not Started',
                  },
                ],
              },
              {
                assigneeId: user.id,
                assigneeName: user.name,
                description: 'Clarify activation triggers for new accounts.',
                id: 'demo-story-activation',
                name: 'Activation Signals',
                progress: 75,
                status: 'In Progress',
                tasks: [
                  {
                    assigneeId: user.id,
                    assigneeName: user.name,
                    description: 'Define event thresholds.',
                    id: 'demo-task-thresholds',
                    name: 'Threshold definitions',
                    progress: 100,
                    status: 'Completed',
                  },
                  {
                    assigneeId: user.id,
                    assigneeName: user.name,
                    description: 'Map actions after activation.',
                    id: 'demo-task-actions',
                    name: 'Activation actions',
                    progress: 50,
                    status: 'In Progress',
                  },
                ],
              },
            ],
          },
        ],
      },
      authRepository,
    ),
    normalizeProject(
      {
        createdAt: '2026-04-01T10:00:00.000Z',
        description: 'Prepare backlog cleanup for the following quarter.',
        endDate: '2026-08-01',
        id: 'demo-project-backlog-reset',
        name: 'Backlog Reset',
        rank: 2,
        role: 'admin',
        startDate: '2026-06-01',
        status: 'Planned',
        tenantId: tenant.id,
        updatedAt: '2026-05-11T08:30:00.000Z',
        epics: [],
      },
      authRepository,
    ),
  ];
}

function summarizeProject(project, role) {
  return {
    createdAt: project.createdAt,
    description: project.description,
    endDate: project.endDate,
    id: project.id,
    kind: projectKindOf(project),
    name: project.name,
    rank: project.rank,
    role,
    startDate: project.startDate,
    status: project.status,
    tenantId: project.tenantId,
    updatedAt: project.updatedAt,
  };
}

function findTargetInProject(project, targetType, targetId) {
  if (!project) {
    return null;
  }

  if (targetType === 'project') {
    return project.id === targetId ? project : null;
  }

  if (targetType === 'clarification') {
    return { id: targetId, issueType: 'clarification' };
  }

  // Tickets are a flat project-level collection rather than tree nodes, so they
  // are resolved before the epic walk rather than inside it.
  if (targetType === 'ticket') {
    return (project.tickets ?? []).find((ticket) => ticket.id === targetId) ?? null;
  }

  for (const epic of project.epics ?? []) {
    if (epic.id === targetId && targetType === 'epic') {
      return epic;
    }

    for (const story of epic.stories ?? []) {
      if (story.id === targetId && targetType === 'story') {
        return story;
      }

      for (const task of story.tasks ?? []) {
        if (task.id === targetId && targetType === 'task') {
          return task;
        }
      }
    }
  }

  return null;
}

// For a delete that must not take anyone's replies with it (the assistant's undo): a moderator's
// delete otherwise removes the whole thread. Checked in the same call as the delete.
function commentHasReplies() {
  return new HttpError(409, 'Someone has replied to this comment.', { details: { code: 'comment_has_replies' } });
}

// The same for a delete that must not take an edit made since (expectedTextHash, the SHA-256 of
// the text as Odin returns it), one that must not take or strand anything linked to or put on an
// item (withoutDependents), and an upload that must not save over a file it did not expect.
function commentTextChanged(expectedTextHash, text) {
  if (expectedTextHash !== undefined && createHash('sha256').update(String(text ?? '')).digest('hex') !== expectedTextHash) {
    throw new HttpError(409, 'Someone has edited this comment.', { details: { code: 'comment_changed' } });
  }
}

function itemHasDependents() {
  return new HttpError(409, 'Something links to this item or is on it now.', { details: { code: 'item_has_dependents' } });
}

function fileNameTaken() {
  return new HttpError(409, 'A file with this name is already there.', { details: { code: 'file_exists' } });
}

function fileChanged() {
  return new HttpError(409, 'The file under this name changed since it was listed.', { details: { code: 'file_changed' } });
}

const sameStoredFileName = (left, right) => String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();

// A file that kept its place and changed only its name was renamed; any other change moved it.
const fileMoveAction = (from, to) => (from.targetType === to.targetType && from.targetId === to.targetId && (from.folderId ?? null) === (to.folderId ?? null) ? 'rename' : 'move');

// Contents scanned before they were saved, as the base64 path scans them: clean, with their SHA-256.
function scannedBeforeSaving(bytes) {
  return { scanStatus: 'clean', scannedAt: new Date(), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function fileVersionUnavailable() {
  return new HttpError(409, 'That version was deleted or removed, so it cannot be restored.', { details: { code: 'version_unavailable' } });
}

function stalledVersion(currentVersion) {
  return new HttpError(409, 'The file under this name changed since it was listed.', { details: { code: 'file_changed', currentVersion } });
}

function uploadNotReady() {
  return new HttpError(409, 'This upload is not ready to save. Send every part first.', { details: { code: 'upload_not_ready' } });
}

function currentVersionDelete() {
  return new HttpError(409, 'The current version cannot be deleted. Upload a new version first, or delete the whole file.', { details: { code: 'current_version' } });
}

// A stored object as a stream: from storage that streams, or from its bytes for one that does not
// (the in-memory default). end is inclusive, as in an HTTP Range.
async function openStoredStream(storage, storageKey, { end, start } = {}) {
  if (typeof storage.createReadStream === 'function') return storage.createReadStream(storageKey, { end, start });
  const buffer = Buffer.from((await storage.read(storageKey)).bytes);
  return { size: buffer.length, stream: Readable.from([buffer.subarray(start ?? 0, end == null ? buffer.length : end + 1)]) };
}

// A stored object's SHA-256, read as a stream.
async function hashStoredObject(storage, storageKey) {
  const { stream } = await openStoredStream(storage, storageKey);
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// The name a kept-both upload takes on its target: "plan (2).pdf", or the next number free.
function keptBothName(fileName, taken) {
  const name = String(fileName ?? 'file');
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${randomUUID().slice(0, 8)})${extension}`;
}

function buildCommentTree(comments) {
  const byId = new Map();
  const roots = [];

  for (const comment of comments) {
    byId.set(comment.id, {
      ...comment,
      children: [],
    });
  }

  for (const comment of byId.values()) {
    if (comment.parentId && byId.has(comment.parentId)) {
      byId.get(comment.parentId).children.push(comment);
    } else {
      roots.push(comment);
    }
  }

  return roots;
}

export function createInMemoryProjectsRepository({
  authRepository,
  fileScanner,
  fileStorage,
  frontendAppUrl = '',
  mailRepository,
  seed = {},
  ticketConfigRepository = null,
  // The project change log. Shared with the in-memory governance
  // repository so dependency changes land in the same log.
  changeLog = createInMemoryProjectChangeLog(),
  itemChangeRequests = createInMemoryItemChangeRequests(),
} = {}) {
  const inMemoryFileBytes = new Map();
  const revisionObservers = createRevisionObservers();
  // An item revision, and its change log entry.
  function pushRevision(revision) {
    state.projectItemRevisions.push(revision);
    changeLog.append([itemRevisionChange(revision)]);
    revisionObservers.emit(revision);
  }
  const storage = fileStorage ?? {
    async delete(fileId) {
      inMemoryFileBytes.delete(fileId);
    },
    async read(fileId) {
      const bytes = inMemoryFileBytes.get(fileId) ?? Buffer.alloc(0);
      return {
        bytes,
        size: bytes.length,
      };
    },
    async write(fileId, bytes) {
      inMemoryFileBytes.set(fileId, Buffer.from(bytes));
    },
  };
  const state = {
    comments: clone(seed.comments ?? []),
    commentVotes: [],
    files: clone(seed.files ?? []),
    fileLinks: clone(seed.fileLinks ?? []),
    fileVersions: clone(seed.fileVersions ?? []),
    fileUploads: [],
    kanbanConfigs: new Map(),
    kanbanRanks: new Map(),
    mentionEvents: [],
    projectItemRevisions: [],
    ticketIntakeInvitations: [],
    workItemRelations: [],
    deletedProjectItems: new Map(),
    projectMemberships: new Map(),
    projects: buildDemoProjects(authRepository, seed),
    sprintStaffing: new Map(),
    sprints: clone(seed.sprints ?? []),
  };
  for (const [projectId, memberships] of Object.entries(seed.projectMemberships ?? {})) {
    state.projectMemberships.set(projectId, clone(memberships));
  }
  const scanner = fileScanner && typeof fileScanner.scanBytes === 'function'
    ? fileScanner
    : {
        enabled: false,
        async scanBytes() {
          return { clean: true, scanner: 'noop' };
        },
      };

  async function requireTicketReferences(item, { projectId, tenantId }) {
    if (!ticketConfigRepository) return;
    await assertTicketReferences(item, async ({ kind }, id) => {
      const entries = await ticketConfigRepository.listTicketConfigList({ kind, tenantId });
      return entries.find((entry) => entry.id === id && inTicketProjectScope(entry, projectId));
    });
  }

  function listUsersForTenant(tenantId, query = '') {
    const normalizedQuery = query.trim().toLowerCase();

    return (authRepository?.state?.users ?? [])
      .filter((user) => user.memberships?.some((membership) => membership.tenantId === tenantId))
      .filter((user) => {
        if (!normalizedQuery) {
          return true;
        }

        return [user.name, user.email]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .map((user) => ({
        email: user.email,
        id: user.id,
        name: user.name,
        picture: user.picture ?? '',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function projectForTenant(projectId, tenantId) {
    return state.projects.find((item) => item.id === projectId && item.tenantId === tenantId) ?? null;
  }

  function sprintKey(projectId, userId) {
    return `${projectId}:${userId}`;
  }

  function sprintRowsForProject(projectId) {
    return state.sprints
      .filter((sprint) => sprint.projectId === projectId)
      .map((sprint) => normalizeSprint(sprint, projectId))
      .sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }
        return left.name.localeCompare(right.name);
      });
  }

  function staffingRowsForSprint(sprintId) {
    return (state.sprintStaffing.get(sprintId) ?? []).map((entry) => normalizeSprintStaffingEntry(entry, sprintId));
  }

  function buildProjectMembers(projectId, tenantId) {
    const tenantUsers = (authRepository?.state?.users ?? [])
      .flatMap((entry) => {
        const membership = entry.memberships?.find((item) => item.tenantId === tenantId);
        if (!membership) {
          return [];
        }

        const projectMembership = (state.projectMemberships.get(projectId) ?? []).find((item) => item.id === entry.id) ?? null;
        return [{
          allocationPct: projectMembership?.project_allocation ?? null,
          defaultBillRate: projectMembership?.default_bill_rate ?? null,
          email: entry.email,
          id: entry.id,
          name: entry.name,
          picture: entry.picture ?? '',
          projectAllocation: projectMembership?.project_allocation ?? null,
          projectBillRate: projectMembership?.project_bill_rate ?? null,
          role: projectMembership?.role ?? membership.role ?? 'user',
        }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    return tenantUsers;
  }

  function rebuildProject(project) {
    project.epics = (project.epics ?? []).map((epic) => normalizeTaskNode(epic, 'epic', authRepository));
    project.updatedAt = new Date().toISOString();
    return project;
  }

  function findStoryContext(project, storyId) {
    for (const epic of project?.epics ?? []) {
      const stories = epic.stories ?? [];
      const storyIndex = stories.findIndex((story) => story.id === storyId);

      if (storyIndex >= 0) {
        return {
          epic,
          stories,
          story: stories[storyIndex],
          storyIndex,
        };
      }
    }

    return null;
  }

  function findTaskContext(project, taskId) {
    for (const epic of project?.epics ?? []) {
      for (const story of epic.stories ?? []) {
        const tasks = story.tasks ?? [];
        const taskIndex = tasks.findIndex((task) => task.id === taskId);

        if (taskIndex >= 0) {
          return {
            epic,
            story,
            task: tasks[taskIndex],
            taskIndex,
            tasks,
          };
        }
      }
    }

    return null;
  }

  function nextSprintSortOrder(project, sprintId) {
    const items = buildPlanningItems(project).filter((item) => (item.sprintId ?? null) === (sprintId ?? null));
    const maxValue = items.reduce((max, item) => Math.max(max, Number(item.sprintSortOrder ?? -1)), -1);
    return maxValue + 1;
  }

  function buildSprintPlanningPayload(project, tenantId) {
    const members = buildProjectMembers(project.id, tenantId);
    const items = buildPlanningItems(project);
    const sprints = sprintRowsForProject(project.id).map((sprint) => {
      const sprintItems = items.filter((item) => item.sprintId === sprint.id);
      const staffing = staffingRowsForSprint(sprint.id);
      return {
        ...sprint,
        items: sortPlanningItemsByOrder(sprintItems),
        staffing,
        summary: buildPlanningSummary(sprintItems, staffing),
      };
    });

    const backlogItems = items
      .filter((item) => item.sprintId == null);

    return {
      backlog: {
        items: sortPlanningItemsByOrder(backlogItems),
        summary: buildPlanningSummary(backlogItems, []),
      },
      members,
      sprints,
    };
  }

  function assertTarget(projectId, tenantId, targetType, targetId) {
    // A direct message conversation stands in for the project of its files (chat.repository.js).
    if (targetType === DM_TARGET_TYPE) {
      return projectId === targetId && (state.directConversations ?? []).some((conversation) => conversation.id === targetId && conversation.tenantId === tenantId) ? { id: targetId, tenantId } : null;
    }
    const project = projectForTenant(projectId, tenantId);

    if (!project) {
      return null;
    }

    if (targetType === 'clarification') {
      return project;
    }

    // A channel's library.
    if (targetType === 'channel') {
      return (state.channels ?? []).some((channel) => channel.id === targetId && channel.projectId === projectId && channel.tenantId === tenantId) ? project : null;
    }

    return findTargetInProject(project, targetType, targetId) ? project : null;
  }

  function recordMentionEvent({ html, projectId, source, targetId, targetType, userId }) {
    const mentionedUserIds = extractMentionedUserIds(html);

    if (mentionedUserIds.length === 0) {
      return;
    }

    state.mentionEvents.push({
      createdAt: new Date().toISOString(),
      mentionedUserIds,
      projectId,
      source,
      targetId,
      targetType,
      userId,
    });
  }

  // skipUserIds: people the text already mentioned before this save, who were emailed then.
  async function queueMentionEmails({ html, projectId, skipUserIds = [], targetId, targetType, userId }) {
    if (!mailRepository || typeof mailRepository.queueMail !== 'function') {
      recordMentionEvent({ html, projectId, source: 'mention-detected', targetId, targetType, userId });
      return;
    }
    const spans = extractMentionSpans(html).filter((span) => !skipUserIds.includes(span.userId));

    if (spans.length === 0) {
      return;
    }
    const project = state.projects.find((row) => row.id === projectId) ?? null;
    const commenter = authRepository?.state?.users?.find((entry) => entry.id === userId)
      ?? { id: userId, name: 'Unknown user', email: '', timezone: 'UTC' };
    const projectName = project?.name ?? 'Project';
    const optOuts = await findEmailOptOuts({ kind: 'mentions', read: (query) => readUserPreferencesMemory(authRepository?.state?.users, query), userIds: spans.map((span) => span.userId) });

    for (const span of spans) {
      // Only people in the project's workspace: a span can name any user id.
      const mentioned = authRepository?.state?.users?.find((entry) => entry.id === span.userId
        && entry.memberships?.some((membership) => membership.tenantId === project?.tenantId));
      if (!mentioned?.email || isOptedOut(optOuts, { userId: mentioned.id })) {
        continue;
      }

      const target = {
        id: targetId,
        type: targetType,
        fullSpan: span.fullSpan,
      };

      const mention = buildMentionNotification({
        commenter,
        frontendAppUrl,
        html,
        mentionedUser: {
          email: mentioned.email,
          id: mentioned.id,
          name: mentioned.name,
        },
        project: {
          id: projectId,
          name: projectName,
        },
        target,
      });

      await queueMentionEmail({
        mailRepository,
        mention,
        targetId,
      });
    }
  }

  function listTargetComments({ projectId, targetId, targetType, tenantId }) {
    if (!assertTarget(projectId, tenantId, targetType, targetId)) return [];
    return buildCommentTree(state.comments
      .filter((comment) => comment.projectId === projectId && comment.targetId === targetId && comment.targetType === targetType)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((comment) => serializeComment(comment)));
  }

  // A file as readers get it: its current version, and the work items that link to it now.
  function fileView(file) {
    const { editingBy: _editingBy, editingSince: _editingSince, previewStorageKey: _previewStorageKey, storageKey, ...stored } = clone(file);
    const project = projectForTenant(file.projectId, file.tenantId);
    return {
      ...stored,
      // Who marked it as being edited, and its folder in a channel library.
      editing: editingMarker({ editingBy: file.editingBy, editingName: authRepository?.state?.users?.find((user) => user.id === file.editingBy)?.name ?? null, editingSince: file.editingSince }),
      folderId: file.folderId ?? null,
      // Files saved before 0097 were scanned before saving.
      scanStatus: file.scanStatus ?? 'clean',
      scannedAt: file.scannedAt ?? null,
      sha256: file.sha256 ?? null,
      // Internal unless someone shared it with stakeholders.
      audience: file.audience === 'external' ? 'external' : 'internal',
      links: state.fileLinks.filter((link) => link.fileId === file.id).flatMap((link) => {
        const target = findTargetInProject(project, link.targetType, link.targetId);
        return target ? [{ id: link.id, linkedAt: link.createdAt, targetId: link.targetId, targetName: target.name ?? null, targetType: link.targetType }] : [];
      }),
      targetName: file.targetType === 'channel'
        ? (state.channels ?? []).find((channel) => channel.id === file.targetId)?.name ?? null
        : file.targetType === 'project' || file.targetType === 'clarification' ? null : findTargetInProject(project, file.targetType, file.targetId)?.name ?? null,
      version: file.version ?? 1,
      versionNote: file.versionNote ?? '',
      versionUploadedAt: file.versionUploadedAt ?? file.updatedAt,
    };
  }

  // One version of a file as stored, and the file as it read then: the current version when
  // version is null. Null for no such version, or one deleted.
  function describeStoredVersion(file, version = null) {
    const current = fileView(file);
    if (version == null || version === current.version) {
      return { contentType: file.contentType, current: true, file: current, fileName: file.fileName, fileSize: Number(file.fileSize ?? 0), previewStorageKey: file.previewStorageKey ?? null, scanStatus: current.scanStatus, sha256: current.sha256, storageKey: file.storageKey ?? file.id, version: current.version };
    }
    const earlier = state.fileVersions.find((item) => item.fileId === file.id && item.tenantId === file.tenantId && item.version === version);
    if (!earlier || earlier.deletedAt) return null;
    const scanStatus = earlier.scanStatus ?? 'clean';
    const sha256 = earlier.sha256 ?? null;
    return {
      contentType: earlier.contentType,
      current: false,
      file: { ...current, contentType: earlier.contentType, fileName: earlier.fileName, fileSize: earlier.fileSize, scanStatus, sha256, signature: earlier.signature, uploadedBy: clone(earlier.uploadedBy), version: earlier.version, versionNote: earlier.note, versionUploadedAt: earlier.uploadedAt },
      fileName: earlier.fileName,
      fileSize: Number(earlier.fileSize ?? 0),
      previewStorageKey: earlier.previewStorageKey ?? null,
      scanStatus,
      sha256,
      storageKey: earlier.storageKey,
      version: earlier.version,
    };
  }

  function listTargetFiles({ includeLinked = false, projectId, targetId, targetType, tenantId }) {
    if (!assertTarget(projectId, tenantId, targetType, targetId)) return [];
    const linked = new Set(includeLinked ? state.fileLinks.filter((link) => link.targetId === targetId && link.targetType === targetType).map((link) => link.fileId) : []);
    return state.files
      .filter((file) => (targetType === 'project' && targetId === projectId ? file.projectId === projectId : file.projectId === projectId && ((file.targetId === targetId && file.targetType === targetType) || linked.has(file.id))))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((file) => fileView(file));
  }

  // scan holds the new contents' scan status, SHA-256 and scan time: clean for contents scanned
  // before saving, pending for an upload the scan worker has yet to read, or an earlier version's.
  function supersedeStoredFile(file, { fileDescription, fileName, fileSize, fileType, note = '', scan, signature, storageKey, user }) {
    state.fileVersions.push({
      contentType: file.contentType,
      fileId: file.id,
      fileName: file.fileName,
      fileSize: file.fileSize,
      id: randomUUID(),
      note: file.versionNote ?? '',
      previewStorageKey: file.previewStorageKey ?? null,
      scanStatus: file.scanStatus ?? 'clean',
      scannedAt: file.scannedAt ?? null,
      sha256: file.sha256 ?? null,
      signature: file.signature ?? null,
      storageKey: file.storageKey ?? file.id,
      tenantId: file.tenantId,
      uploadedAt: file.versionUploadedAt ?? file.updatedAt,
      uploadedBy: clone(file.uploadedBy),
      version: file.version ?? 1,
    });
    const now = new Date().toISOString();
    // A new version from the person editing it clears their marker.
    if (file.editingBy && file.editingBy === user.id) Object.assign(file, { editingBy: null, editingSince: null });
    Object.assign(file, {
      contentType: fileType,
      description: fileDescription ?? file.description ?? '',
      fileName,
      fileSize,
      // A restored version keeps its preview; new contents get theirs from the preview worker.
      previewStorageKey: scan.previewStorageKey ?? null,
      scanStatus: scan.scanStatus,
      scannedAt: scan.scannedAt ?? null,
      sha256: scan.sha256 ?? null,
      signature,
      storageKey,
      updatedAt: now,
      uploadedBy: { id: user.id, name: user.name },
      version: (file.version ?? 1) + 1,
      versionNote: note ?? '',
      versionUploadedAt: now,
    });
  }

  async function dropStoredFiles(fileIds) {
    const ids = new Set(fileIds);
    const keys = new Set(state.fileVersions.filter((version) => ids.has(version.fileId)).flatMap((version) => [version.storageKey, ...(isStoredPreview(version.previewStorageKey) ? [version.previewStorageKey] : [])]));
    for (const file of state.files) {
      if (!ids.has(file.id)) continue;
      keys.add(file.storageKey ?? file.id);
      if (isStoredPreview(file.previewStorageKey)) keys.add(file.previewStorageKey);
    }
    for (const key of keys) await storage.delete(key);
    state.fileLinks = state.fileLinks.filter((link) => !ids.has(link.fileId));
    state.fileVersions = state.fileVersions.filter((version) => !ids.has(version.fileId));
    state.files = state.files.filter((file) => !ids.has(file.id));
    // A file's comments go with it, and posts no longer carry it.
    state.discussionPosts = (state.discussionPosts ?? []).filter((post) => !(post.targetType === 'file' && ids.has(post.targetId)));
    state.discussionPostFiles = (state.discussionPostFiles ?? []).filter((link) => !ids.has(link.fileId));
  }

  function serializeComment(comment) {
    const author = authRepository?.state?.users?.find((user) => user.id === comment.userId);

    return {
      author: {
        id: author?.id ?? comment.userId,
        // Someone without a login (`resource:<id>`) is named as they were when they commented.
        name: author?.name ?? comment.authorName ?? 'Unknown user',
        picture: author?.picture ?? '',
      },
      comment: comment.comment,
      createdAt: comment.createdAt,
      downvotes: Number(comment.downvotes ?? 0),
      id: comment.id,
      parentId: comment.parentId,
      targetId: comment.targetId,
      targetType: comment.targetType,
      upvotes: Number(comment.upvotes ?? 0),
      updatedAt: comment.updatedAt,
      userId: comment.userId,
    };
  }

  return {
    state,
    ...createInMemoryProjectDeletionMethods({ authRepository, state }),
    ...createInMemoryEngagementMethods({ authRepository, changeLog, normalizeProject: (project) => normalizeProject(project, authRepository), state }),
    ...createInMemoryChannelMethods({ authRepository, changeLog, state }),
    ...createInMemoryChatMethods({ authRepository, state }),
    ...createInMemoryChannelActivityMethods({ authRepository, state }),
    ...createInMemorySearchSourceMethods({ authRepository, state }),
    ...createInMemoryPursuitMethods({
      helpers: { findProjectItemContext, nextProjectTimestamp, projectItemSnapshot },
      normalizeTaskNode: (node, level) => normalizeTaskNode(node, level, authRepository),
      pushRevision,
      state,
    }),
    ...createInMemoryOdinReplyMethods({ state }),
    ...createInMemoryPollMethods({ state }),
    // Delivery projects only, unless includeEngagements: engagements stay out of delivery views.
    async listProjectsForTenant({ includeEngagements = false, tenantId, user }) {
      const membership = user.memberships?.find((item) => item.tenantId === tenantId) ?? user.memberships?.[0] ?? null;
      const role = membership?.role ?? 'user';
      const canSeeAllProjects = ['admin', 'manager'].includes(String(role).toLowerCase());

      return sortProjects(state.projects.filter((project) => {
        if (project.tenantId !== tenantId) {
          return false;
        }
        if (!includeEngagements && projectKindOf(project) !== 'delivery') {
          return false;
        }
        if (canSeeAllProjects) {
          return true;
        }

        const memberships = state.projectMemberships.get(project.id);
        return memberships
          ? memberships.some((entry) => entry.id === user.id && entry.role)
          : Boolean(project.role);
      })).map((project) => {
        const projectRole = state.projectMemberships.get(project.id)
          ?.find((entry) => entry.id === user.id)?.role;
        return summarizeProject(project, projectRole ?? project.role ?? role);
      });
    },
    async getProjectAccess({ projectId, tenantId, userId }) {
      const project = projectForTenant(projectId, tenantId);
      if (!project) {
        return { exists: false, projectRole: null };
      }

      const memberships = state.projectMemberships.get(projectId);
      return {
        exists: true,
        projectRole: memberships
          ? memberships.find((entry) => entry.id === userId)?.role ?? null
          : project.role ?? null,
      };
    },
    // Delivery work only, unless includePursuit (src/lib/projects/pursuit.js).
    async getProjectDetail({ includePursuit = false, projectId, tenantId }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;
      const detail = clone(applyProjectEstimateRollups(project));
      return includePursuit ? detail : withoutPursuitWork(detail);
    },
    async getValidUsers({ projectId, tenantId }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const tenantUsers = (authRepository?.state?.users ?? [])
        .flatMap((user) => {
          const membership = user.memberships?.find((m) => m.tenantId === tenantId);
          if (!membership) return [];
          return [{
            email: user.email,
            id: user.id,
            name: user.name,
            role: membership.role ?? 'user',
          }];
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      const projectMemberships = state.projectMemberships.get(projectId);
      const projectUsers = Array.isArray(projectMemberships)
        ? projectMemberships.map((entry) => {
            const tenantUser = tenantUsers.find((user) => user.id === entry.id);

            return {
              ...entry,
              email: tenantUser?.email ?? entry.email ?? '',
              name: tenantUser?.name ?? entry.name ?? '',
              role: entry.role ?? tenantUser?.role ?? 'user',
            };
          })
        : [];

      return {
        project_users: projectUsers,
        tenant_users: tenantUsers,
        validStatusTypes: {
          Completed: 'in-memory-completed',
          'In Progress': 'in-memory-in-progress',
          'Not Started': 'in-memory-not-started',
        },
        validTaskTypes: {
          Epic: 'in-memory-epic',
          Story: 'in-memory-story',
          Task: 'in-memory-task',
        },
      };
    },
    async setProjectPermissions({ projectId, tenantId, validUsers, user }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const isModerator = isTenantModerator(user, tenantId);
      const existingMemberships = state.projectMemberships.get(projectId);
      const currentMembership = Array.isArray(existingMemberships)
        ? existingMemberships.find((entry) => entry.id === user?.id)
        : null;
      const isProjectAdmin = currentMembership?.role === 'admin';

      if (!isModerator && !isProjectAdmin) {
        throw new Error('Forbidden');
      }

      const tenantUsersById = new Map(
        (authRepository?.state?.users ?? [])
          .flatMap((entry) => {
            const membership = entry.memberships?.find((m) => m.tenantId === tenantId);
            if (!membership) return [];
            return [[entry.id, {
              email: entry.email,
              name: entry.name,
              role: membership.role ?? 'user',
            }]];
          }),
      );

      const normalized = (validUsers ?? []).map((entry) => {
        const tenantUser = tenantUsersById.get(entry.id);

        return {
          default_bill_rate: null,
          email: tenantUser?.email ?? '',
          id: entry.id,
          min_bill_rate: null,
          name: tenantUser?.name ?? '',
          project_allocation: entry.project_allocation ?? null,
          project_bill_rate: entry.project_bill_rate ?? null,
          role: entry.role ?? tenantUser?.role ?? 'user',
        };
      });

      state.projectMemberships.set(projectId, normalized);

      return {
        message: 'Project permissions updated.',
        project_users: normalized,
      };
    },
    async listProjectSprints({ projectId, tenantId }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      return buildSprintPlanningPayload(project, tenantId);
    },
    // A project's sprints alone, in board order, without the planning payload.
    async listSprintRows({ projectId, tenantId }) {
      return projectForTenant(projectId, tenantId) ? sprintRowsForProject(projectId) : null;
    },
    // Home reads the active and planned sprints, with staffing on the active ones, without the
    // planning payload (which rebuilds the whole project).
    async listOpenSprints({ projectId, tenantId }) {
      if (!projectForTenant(projectId, tenantId)) {
        return null;
      }

      return {
        sprints: sprintRowsForProject(projectId)
          .filter((sprint) => ['active', 'planned'].includes(String(sprint.status).toLowerCase()))
          .map((sprint) => ({ ...sprint, staffing: String(sprint.status).toLowerCase() === 'active' ? staffingRowsForSprint(sprint.id) : [] })),
      };
    },
    async createProjectSprint({ input, projectId, tenantId }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const sprint = normalizeSprint({
        ...input,
        id: input.id ?? randomUUID(),
        projectId,
        sortOrder: sprintRowsForProject(projectId).length,
      }, projectId);

      state.sprints.push(sprint);
      return clone(sprint);
    },
    async updateProjectSprint({ input, projectId, sprintId, tenantId }) {
      const project = projectForTenant(projectId, tenantId);
      const sprint = state.sprints.find((entry) => entry.id === sprintId && entry.projectId === projectId);

      if (!project || !sprint) {
        return null;
      }

      sprint.name = input.name;
      sprint.goal = sanitizeRichHtml(input.goal ?? '');
      sprint.status = input.status ?? sprint.status ?? 'planned';
      sprint.startDate = input.startDate ?? null;
      sprint.endDate = input.endDate ?? null;
      return clone(normalizeSprint(sprint, projectId));
    },
    async updateProjectSprintStatus({ projectId, sprintId, status, tenantId }) {
      const project = projectForTenant(projectId, tenantId);
      const sprint = state.sprints.find((entry) => entry.id === sprintId && entry.projectId === projectId);

      if (!project || !sprint) {
        return null;
      }

      sprint.status = status;
      return clone(normalizeSprint(sprint, projectId));
    },
    async saveSprintStaffing({ projectId, sprintId, staffing, tenantId }) {
      const project = projectForTenant(projectId, tenantId);
      const sprint = state.sprints.find((entry) => entry.id === sprintId && entry.projectId === projectId);

      if (!project || !sprint) {
        return null;
      }

      const allowedUsers = new Set(buildProjectMembers(projectId, tenantId).map((entry) => entry.id));
      const normalized = (staffing ?? [])
        .filter((entry) => allowedUsers.has(entry.userId))
        .map((entry) => normalizeSprintStaffingEntry(entry, sprintId));

      state.sprintStaffing.set(sprintId, normalized);

      return {
        sprint: clone(normalizeSprint(sprint, projectId)),
        staffing: clone(normalized),
      };
    },
    changeLog,
    async listProjectChanges(args) {
      return changeLog.list(args);
    },
    // Changes written outside this repository (schedule dependencies) join the same log.
    observeItemRevisions(listener) {
      return revisionObservers.observe(listener);
    },
    async recordProjectChanges(entries) {
      changeLog.append(entries);
    },
    // Idempotency keys for odin_apply_item_changes (changes/item-change-requests.js).
    itemChangeRequests,
    async listItemChanges(args) {
      return changeLog.listItems(args);
    },
    // The newest `limit` comments on each target, oldest first, below `before` ({ createdAt, id })
    // when it pages back. Returns a Map of targetId to { comments, more }.
    async listItemComments({ limit, projectId, targets }) {
      const result = new Map();
      for (const { before = null, targetId } of targets) {
        const older = state.comments
          .filter((comment) => comment.projectId === projectId && comment.targetId === targetId
            && (!before || comment.createdAt < before.createdAt || (comment.createdAt === before.createdAt && comment.id < before.id)))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
        result.set(targetId, { comments: older.slice(0, limit).reverse().map((comment) => serializeComment(comment)), more: older.length > limit });
      }
      return result;
    },
    // Links where any of the items is either end.
    async listRelationsForItems({ itemIds, projectId, tenantId }) {
      const wanted = new Set(itemIds);
      return clone(state.workItemRelations.filter((relation) => relation.projectId === projectId && relation.tenantId === tenantId
        && (wanted.has(relation.fromItemId) || wanted.has(relation.toItemId))));
    },
    // How many comments each target has, and when the latest was written or edited.
    async listCommentActivity({ projectId, targetIds, tenantId }) {
      const wanted = new Set(targetIds ?? []);
      const activity = new Map();
      for (const comment of state.comments) {
        if (comment.projectId !== projectId || !wanted.has(comment.targetId)) continue;
        const entry = activity.get(comment.targetId) ?? { count: 0, lastAt: null };
        const at = [comment.createdAt, comment.updatedAt].filter(Boolean).sort().at(-1) ?? null;
        activity.set(comment.targetId, { count: entry.count + 1, lastAt: !entry.lastAt || (at && at > entry.lastAt) ? at : entry.lastAt });
      }
      return activity;
    },
    async assignItemsToSprint({ assignments, projectId, tenantId, user }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }
      const sprintsBefore = flattenProjectItemSnapshots(project);

      for (const assignment of assignments ?? []) {
        if (assignment.itemType === 'story') {
          const context = findStoryContext(project, assignment.itemId);
          if (!context) {
            continue;
          }

          context.story.sprintId = assignment.sprintId ?? null;
          context.story.sprintSortOrder = nextSprintSortOrder(project, assignment.sprintId ?? null);

          for (const task of context.story.tasks ?? []) {
            task.sprintId = assignment.sprintId ?? null;
            task.sprintSortOrder = nextSprintSortOrder(project, assignment.sprintId ?? null);
          }
        }

        if (assignment.itemType === 'task') {
          const context = findTaskContext(project, assignment.itemId);
          if (!context) {
            continue;
          }

          context.task.sprintId = assignment.sprintId ?? null;
          context.task.sprintSortOrder = nextSprintSortOrder(project, assignment.sprintId ?? null);
        }
      }

      changeLog.append([...flattenProjectItemSnapshots(project)].map(([itemId, after]) => {
        const from = sprintsBefore.get(itemId)?.node?.sprintId ?? null;
        const to = after.node?.sprintId ?? null;
        return from === to ? null : sprintChange({ actorId: user?.id ?? '', from, itemId, itemType: after.itemType, projectId, tenantId, to });
      }));
      rebuildProject(project);
      return clone(project);
    },
    async splitStory({ input, projectId, storyId, tenantId, user }) {
      const project = projectForTenant(projectId, tenantId);
      const storyContext = project ? findStoryContext(project, storyId) : null;

      if (!project || !storyContext) {
        return null;
      }

      const selectedTaskIds = new Set(input.taskIds ?? []);
      const movingTasks = (storyContext.story.tasks ?? []).filter((task) => selectedTaskIds.has(task.id));

      if (movingTasks.length === 0) {
        return null;
      }

      const movedPoints = movingTasks.reduce((sum, task) => sum + (Number(task.points ?? 0) || 0), 0);
      const movedHours = movingTasks.reduce((sum, task) => sum + (Number(task.targetHourEstimate ?? 0) || 0), 0);
      const nextStory = normalizeTaskNode({
        assigneeId: input.assigneeId ?? storyContext.story.assigneeId ?? null,
        assigneeName: resolveAssigneeName(authRepository, input.assigneeId ?? storyContext.story.assigneeId ?? null, storyContext.story.assigneeName ?? ''),
        description: input.description ?? storyContext.story.description ?? '',
        id: randomUUID(),
        name: input.name,
        points: input.points ?? (movedPoints || null),
        priority: input.priority ?? storyContext.story.priority ?? 4,
        sourceClarificationIds: input.sourceClarificationIds ?? storyContext.story.sourceClarificationIds ?? [],
        sprintId: input.sprintId ?? null,
        sprintSortOrder: nextSprintSortOrder(project, input.sprintId ?? null),
        status: input.status ?? storyContext.story.status ?? 'Not Started',
        targetEndDate: input.targetEndDate ?? storyContext.story.targetEndDate ?? null,
        targetHourEstimate: input.targetHourEstimate ?? (movedHours || null),
        targetStartDate: input.targetStartDate ?? storyContext.story.targetStartDate ?? null,
        tasks: movingTasks.map((task, index) => ({
          ...task,
          sprintId: input.sprintId ?? task.sprintId ?? null,
          sprintSortOrder: index,
        })),
      }, 'story', authRepository);

      storyContext.story.tasks = (storyContext.story.tasks ?? []).filter((task) => !selectedTaskIds.has(task.id));

      if (storyContext.story.points != null) {
        storyContext.story.points = Math.max(0, Number(storyContext.story.points ?? 0) - movedPoints);
      }
      if (storyContext.story.targetHourEstimate != null) {
        storyContext.story.targetHourEstimate = Math.max(0, Number(storyContext.story.targetHourEstimate ?? 0) - movedHours);
      }

      storyContext.stories.splice(storyContext.storyIndex + 1, 0, nextStory);
      changeLog.append(splitStoryChanges({ movedTaskIds: [...selectedTaskIds], projectId, story: nextStory, storyId, tenantId, user }));
      rebuildProject(project);

      return {
        project: clone(applyProjectEstimateRollups(project)),
        story: clone(nextStory),
      };
    },
    async getKanbanConfig({ projectId, scope = 'delivery', tenantId, user }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const config = state.kanbanConfigs.get(kanbanConfigStateKey(projectId, user?.id ?? '', scope)) ?? createDefaultKanbanConfig();
      return normalizeKanbanConfig(config);
    },
    async saveKanbanConfig({ config, projectId, scope = 'delivery', tenantId, user }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const normalized = normalizeKanbanConfig(config);
      state.kanbanConfigs.set(kanbanConfigStateKey(projectId, user?.id ?? '', scope), normalized);
      return clone(normalized);
    },
    async reorderKanbanItem({ afterItemId, beforeItemId, itemId, projectId, scope = 'delivery', tenantId }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const ranks = state.kanbanRanks.get(projectId) ?? new Map();
      const nextIds = reorderKanbanItemIds(project, ranks, { afterItemId, beforeItemId, itemId, scope });
      if (!nextIds) {
        return null;
      }

      // The delivery and pursuit boards keep separate orders in one map; a reorder on one leaves
      // the other's ranks as they were.
      const merged = new Map(ranks);
      nextIds.forEach((id, index) => merged.set(id, index));
      state.kanbanRanks.set(projectId, merged);
      return true;
    },
    async getKanbanBoard({ filters, projectId, scope = 'delivery', tenantId, user }) {
      const project = projectForTenant(projectId, tenantId);

      if (!project) {
        return null;
      }

      const savedConfig = normalizeKanbanConfig(state.kanbanConfigs.get(kanbanConfigStateKey(projectId, user?.id ?? '', scope)) ?? {});
      const effectiveFilters = kanbanFiltersForScope(normalizeKanbanConfig({
        ...savedConfig,
        ...filters,
      }), scope);
      const items = orderKanbanItems(
        kanbanFiltersProjectItems(buildPlanningItems(project, { scope }), effectiveFilters),
        state.kanbanRanks.get(projectId) ?? new Map(),
      );
      const statuses = projectStatusOptionsFromProject(scope === BOARD_SCOPE_PURSUIT ? onlyPursuitWork(project) : withoutPursuitWork(project));
      const columns = effectiveFilters.columns.length > 0
        ? effectiveFilters.columns
        : buildDefaultKanbanColumns(statuses);

      return {
        cards: placeKanbanCards(items, columns),
        columns,
        filters: effectiveFilters,
        members: buildProjectMembers(projectId, tenantId),
        sprints: sprintRowsForProject(projectId),
        swimlane: effectiveFilters.swimlane,
      };
    },
    async createProject({ input, tenantId }) {
      const now = new Date().toISOString();
      const project = normalizeProject(
        {
          ...input,
          createdAt: now,
          epics: [],
          role: 'admin',
          tenantId,
          updatedAt: now,
        },
        authRepository,
      );

      state.projects.push(project);
      return clone(project);
    },
    // Removes a project created moments ago whose template could not be applied.
    async discardCreatedProject({ projectId, tenantId }) {
      const index = state.projects.findIndex((item) => item.id === projectId && item.tenantId === tenantId);
      if (index < 0) return false;
      state.projects.splice(index, 1);
      return true;
    },
    async updateProject({ input, projectId, tenantId, user }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);

      if (!project) {
        return null;
      }
      requireExpectedProjectVersion(input.expectedUpdatedAt, project.updatedAt);
      // Saving a description emails only people it newly mentions: a rename shouldn't email again.
      const mentionedBefore = extractMentionSpans(renderStoredRichTextToHtml(project.description ?? '')).map((span) => span.userId);

      project.name = input.name;
      project.description = normalizeStoredRichTextMarkdown(input.description);
      project.status = normalizeProjectStatusForDisplay(input.status);
      project.startDate = input.startDate;
      project.endDate = input.endDate;
      project.updatedAt = nextProjectTimestamp(project.updatedAt);
      changeLog.append([{ action: 'update', actorId: user?.id ?? '', entityId: projectId, entityType: 'project', projectId, tenantId }]);

      await queueMentionEmails({
        html: renderStoredRichTextToHtml(project.description),
        projectId,
        skipUserIds: mentionedBefore,
        targetId: projectId,
        targetType: 'project',
        userId: user?.id ?? '',
      });

      return clone(project);
    },
    async replaceProjectTree({ input, projectId, tenantId, user }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);

      if (!project) {
        return null;
      }
      requireExpectedProjectVersion(input.expectedUpdatedAt, project.updatedAt);

      const beforeSnapshots = flattenProjectItemSnapshots(project);
      const previousVersions = new Map();
      const previousTracking = new Map();
      const remember = (node) => {
        previousVersions.set(node.id, Number(node.version ?? 1));
        previousTracking.set(node.id, {
          actualHours: node.actualHours ?? null,
          estimateOverride: node.estimateOverride === true,
          percentComplete: node.percentComplete ?? null,
          remainingHours: node.remainingHours ?? null,
        });
      };
      const collectVersions = (nodes, childKey) => {
        for (const node of nodes ?? []) {
          remember(node);
          if (childKey === 'stories') {
            for (const story of node.stories ?? []) {
              remember(story);
              for (const task of story.tasks ?? []) remember(task);
            }
          }
        }
      };
      collectVersions(project.epics, 'stories');
      const updatedAt = nextProjectTimestamp(project.updatedAt);
      // Tree writers that do not carry tracking fields (assistant commits) keep the stored values.
      const withVersion = (node) => {
        const previous = previousTracking.get(node.id) ?? {};
        return {
          ...node,
          actualHours: node.actualHours === undefined ? previous.actualHours ?? null : node.actualHours,
          estimateOverride: node.estimateOverride === undefined ? previous.estimateOverride === true : node.estimateOverride,
          percentComplete: node.percentComplete === undefined ? previous.percentComplete ?? null : node.percentComplete,
          remainingHours: node.remainingHours === undefined ? previous.remainingHours ?? null : node.remainingHours,
          updatedAt,
          version: (previousVersions.get(node.id) ?? 0) + 1,
        };
      };
      // The plan never holds pursuit work, so the tree it saves keeps the stored pursuit epics.
      const pursuitEpics = (project.epics ?? []).filter(isPursuitItem);
      const pursuitIds = new Set(pursuitEpics.map((epic) => epic.id));
      project.epics = [...(input.epics ?? []).filter((epic) => !pursuitIds.has(epic.id)).map((epic) => normalizeTaskNode({
        ...withVersion(epic),
        stories: (epic.stories ?? []).map((story) => ({
          ...withVersion(story),
          tasks: (story.tasks ?? []).map(withVersion),
        })),
      }, 'epic', authRepository)).map((epic) => {
        delete epic.pursuit;
        return epic;
      }), ...pursuitEpics];
      syncPursuitMarkers(project.epics);
      project.updatedAt = updatedAt;
      const afterSnapshots = flattenProjectItemSnapshots(project);
      for (const itemId of new Set([...beforeSnapshots.keys(), ...afterSnapshots.keys()])) {
        const before = beforeSnapshots.get(itemId) ?? null;
        const after = afterSnapshots.get(itemId) ?? null;
        if (!projectItemSnapshotChanged(before, after)) continue;
        const versionBefore = before?.node?.version ?? null;
        const versionAfter = after?.node?.version ?? (Number(versionBefore ?? 0) + 1);
        pushRevision({
          action: !before ? 'create' : !after ? 'delete' : 'update', actorName: user?.name ?? '', actorUserId: user?.id ?? '', after, before,
          createdAt: updatedAt, id: randomUUID(), itemId, itemType: after?.itemType ?? before.itemType,
          projectId, tenantId, versionAfter, versionBefore,
        });
        if (!after && before) state.deletedProjectItems.set(`${tenantId}:${projectId}:${itemId}`, { ...before, deletedAt: updatedAt, version: versionAfter });
      }

      const walk = async (node, type) => {
        await queueMentionEmails({
          html: renderStoredRichTextToHtml(node.description ?? ''),
          projectId,
          targetId: node.id,
          targetType: type,
          userId: user?.id ?? '',
        });

        if (type === 'epic') {
          for (const story of node.stories ?? []) {
            await walk(story, 'story');
          }
        } else if (type === 'story') {
          for (const task of node.tasks ?? []) {
            await walk(task, 'task');
          }
        }
      };

      for (const epic of project.epics ?? []) {
        await walk(epic, 'epic');
      }

      return clone(project);
    },
    async createTicketIntakeInvitation({ input, projectId, tenantId, user }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;

      const invitation = {
        createdAt: new Date().toISOString(),
        createdBy: user?.id ?? '',
        expiresAt: input.expiresAt ?? null,
        id: randomUUID(),
        intakeToken: randomUUID().replace(/-/g, ''),
        lastSubmittedAt: null,
        projectId,
        replyToken: randomUUID().replace(/-/g, ''),
        reporterEmail: input.reporterEmail,
        reporterName: input.reporterName ?? '',
        revokedAt: null,
        submissionCount: 0,
        tenantId,
      };
      state.ticketIntakeInvitations.push(invitation);
      return clone(invitation);
    },
    async listTicketIntakeInvitations({ projectId, tenantId }) {
      return clone(state.ticketIntakeInvitations.filter(
        (invitation) => invitation.tenantId === tenantId && invitation.projectId === projectId,
      ));
    },
    async revokeTicketIntakeInvitation({ invitationId, projectId, tenantId }) {
      const invitation = state.ticketIntakeInvitations.find((entry) => entry.id === invitationId
        && entry.projectId === projectId
        && entry.tenantId === tenantId);
      if (!invitation) return false;
      invitation.revokedAt = new Date().toISOString();
      return true;
    },
    // Token lookup deliberately returns null for expired and revoked tokens as well as
    // unknown ones, so callers cannot distinguish the cases.
    async getTicketIntakeInvitationByToken({ intakeToken }) {
      const invitation = state.ticketIntakeInvitations.find((entry) => entry.intakeToken === intakeToken);
      if (!invitation || invitation.revokedAt) return null;
      if (invitation.expiresAt && Date.parse(invitation.expiresAt) <= Date.now()) return null;
      return clone(invitation);
    },
    async getTicketIntakeInvitationByReplyToken({ replyToken }) {
      const invitation = state.ticketIntakeInvitations.find((entry) => entry.replyToken === replyToken);
      if (!invitation || invitation.revokedAt) return null;
      return clone(invitation);
    },
    // Unlike the token lookups this returns revoked and expired invitations too; callers decide.
    async getTicketIntakeInvitationById({ invitationId, projectId, tenantId }) {
      const invitation = state.ticketIntakeInvitations.find((entry) => entry.id === invitationId
        && entry.projectId === projectId && entry.tenantId === tenantId);
      return invitation ? clone(invitation) : null;
    },
    async recordTicketIntakeSubmission({ invitationId }) {
      const invitation = state.ticketIntakeInvitations.find((entry) => entry.id === invitationId);
      if (!invitation) return null;
      invitation.submissionCount += 1;
      invitation.lastSubmittedAt = new Date().toISOString();
      return clone(invitation);
    },
    async listTickets({ filters = {}, tenantId, user }) {
      const visible = await this.listProjectsForTenant({ tenantId, user });
      const allowed = new Set(
        (filters.projectIds?.length ? visible.filter((project) => filters.projectIds.includes(project.id)) : visible)
          .map((project) => project.id),
      );
      const projectNames = new Map(visible.map((project) => [project.id, project.name]));
      const matched = [];

      for (const project of state.projects) {
        if (project.tenantId !== tenantId || !allowed.has(project.id)) continue;
        for (const ticket of project.tickets ?? []) {
          if (!matchesTicketFilters(ticket, filters)) continue;
          matched.push({ ...clone(ticket), projectId: project.id, projectName: projectNames.get(project.id) ?? project.name });
        }
      }

      const sorted = sortTicketsForListing(matched);
      const cursor = decodeTicketCursor(filters.cursor);
      const startIndex = cursor ? sorted.findIndex((ticket) => ticket.id === cursor.id) + 1 : 0;
      const page = sorted.slice(Math.max(0, startIndex), Math.max(0, startIndex) + (filters.limit ?? 50));

      return {
        nextCursor: page.length === (filters.limit ?? 50) && startIndex + page.length < sorted.length
          ? encodeTicketCursor(page[page.length - 1])
          : null,
        tickets: page,
        total: sorted.length,
      };
    },
    async listWorkItemRelations({ itemId, projectId, tenantId }) {
      return clone(state.workItemRelations.filter((relation) => relation.tenantId === tenantId
        && relation.projectId === projectId
        && (!itemId || relation.fromItemId === itemId || relation.toItemId === itemId)));
    },
    async createWorkItemRelation({ input, itemId, projectId, tenantId, user }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;
      if (itemId === input.toItemId) throw new HttpError(400, 'A work item cannot relate to itself.');
      if (!findProjectItemContext(project, itemId)) throw new HttpError(404, 'Project item not found.');
      // Relations may not cross a project boundary.
      if (!findProjectItemContext(project, input.toItemId)) {
        throw new HttpError(400, 'Related work items must belong to the same project.');
      }

      const existing = state.workItemRelations.find((relation) => relation.fromItemId === itemId
        && relation.toItemId === input.toItemId
        && relation.relationType === input.relationType);
      // Creating the same relation twice is idempotent. `created` says which happened, so
      // an undo of the create leaves a link that was already there.
      if (existing) return { created: false, relation: clone(existing) };

      const relation = {
        createdAt: new Date().toISOString(),
        createdBy: user?.id ?? '',
        fromItemId: itemId,
        id: randomUUID(),
        projectId,
        relationType: input.relationType,
        tenantId,
        toItemId: input.toItemId,
      };
      state.workItemRelations.push(relation);
      changeLog.append([relationChange({ action: 'create', actorId: user?.id ?? '', projectId, relation, tenantId })]);
      return { created: true, relation: clone(relation) };
    },
    async deleteWorkItemRelation({ relationId, projectId, tenantId, user }) {
      const index = state.workItemRelations.findIndex((relation) => relation.id === relationId
        && relation.projectId === projectId
        && relation.tenantId === tenantId);
      if (index === -1) return false;
      const [relation] = state.workItemRelations.splice(index, 1);
      changeLog.append([relationChange({ action: 'delete', actorId: user?.id ?? '', projectId, relation, tenantId })]);
      return true;
    },
    async createProjectItem({ input, projectId, tenantId, user }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;
      if (input.itemType === 'ticket') await requireTicketReferences(input.item, { projectId, tenantId });
      const itemId = String(input.item?.id ?? '').trim() || randomUUID();
      if (findProjectItemContext(project, itemId) || state.deletedProjectItems.has(`${tenantId}:${projectId}:${itemId}`)) {
        throw new HttpError(409, 'A project item with this id already exists.');
      }
      const collection = projectItemCollection(project, input.itemType, input.parentId ?? null);
      const now = nextProjectTimestamp(project.updatedAt);
      const { pursuit: _pursuit, ...itemFields } = input.item ?? {};
      const node = normalizeTaskNode(
        { ...itemFields, id: itemId, updatedAt: now, version: 1 },
        input.itemType,
        authRepository,
        { parentId: input.parentId ?? null },
      );
      const position = Math.min(input.position ?? collection.length, collection.length);
      collection.splice(position, 0, node);
      // A story or task under the Pursuit epic is pursuit work.
      syncPursuitMarkers(project.epics);
      project.updatedAt = now;
      const context = findProjectItemContext(project, itemId);
      const after = projectItemSnapshot(context);
      const revision = {
        action: 'create', actorName: user?.name ?? '', actorUserId: user?.id ?? '', after, before: null, createdAt: now,
        id: randomUUID(), itemId, itemType: input.itemType, projectId, tenantId, versionAfter: 1, versionBefore: null,
      };
      pushRevision(revision);
      return { item: clone(context.node), project: clone(applyProjectEstimateRollups(project)), revision: clone(revision) };
    },
    async updateProjectItem({ input, itemId, projectId, tenantId, user, verifyTicketContent = null }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;
      const context = findProjectItemContext(project, itemId);
      if (!context) return null;
      projectItemConflict(input.expectedVersion, context.node.version);
      if (context.itemType === 'ticket') await requireTicketReferences(input.patch ?? {}, { projectId, tenantId });
      if (verifyTicketContent) {
        const target = { projectId, targetId: itemId, targetType: 'ticket', tenantId };
        verifyTicketContent({ attachments: listTargetFiles(target), comments: listTargetComments(target), ticket: context.node });
      }
      const before = projectItemSnapshot(context);
      const originalChildren = context.itemType === 'epic' ? context.node.stories : context.itemType === 'story' ? context.node.tasks : null;
      const patch = { ...(input.patch ?? {}) };
      delete patch.id;
      delete patch.version;
      delete patch.updatedAt;
      delete patch.stories;
      delete patch.tasks;
      delete patch.pursuit;
      const now = nextProjectTimestamp(project.updatedAt);
      const nextParentId = input.parentId === undefined ? context.parentId : input.parentId;
      const normalized = normalizeTaskNode(
        { ...context.node, ...patch, boardColumn: resolveBoardColumnForPatch(context.node, patch) },
        context.itemType,
        authRepository,
        { parentId: nextParentId ?? null },
      );
      if (context.itemType === 'epic') normalized.stories = originalChildren;
      if (context.itemType === 'story') normalized.tasks = originalChildren;
      if (context.itemType === 'ticket') normalized.parentId = nextParentId ?? null;
      normalized.id = itemId;
      normalized.updatedAt = now;
      normalized.version = Number(context.node.version) + 1;
      context.collection[context.index] = normalized;
      const nextCollection = projectItemCollection(project, context.itemType, nextParentId ?? null);
      if (nextCollection !== context.collection) {
        context.collection.splice(context.collection.indexOf(normalized), 1);
        nextCollection.splice(Math.min(input.position ?? nextCollection.length, nextCollection.length), 0, normalized);
      } else if (input.position !== undefined) {
        const currentIndex = nextCollection.indexOf(normalized);
        nextCollection.splice(currentIndex, 1);
        nextCollection.splice(Math.min(input.position, nextCollection.length), 0, normalized);
      }
      // Moving an item in or out of the Pursuit story moves it in or out of pursuit work.
      syncPursuitMarkers(project.epics);
      project.updatedAt = now;
      const updatedContext = findProjectItemContext(project, itemId);
      const after = projectItemSnapshot(updatedContext);
      const revision = {
        action: 'update', actorName: user?.name ?? '', actorUserId: user?.id ?? '', after, before, createdAt: now,
        id: randomUUID(), itemId, itemType: context.itemType, projectId, tenantId,
        versionAfter: normalized.version, versionBefore: Number(input.expectedVersion),
      };
      pushRevision(revision);
      if (context.itemType === 'story' && storyCompletionCascades(context.node.status, normalized.status)) {
        for (const [taskIndex, task] of (normalized.tasks ?? []).entries()) {
          if (task.status === COMPLETED_STATUS) continue;
          const completedTask = normalizeTaskNode(
            { ...task, boardColumn: resolveBoardColumnForPatch(task, { status: COMPLETED_STATUS }), status: COMPLETED_STATUS },
            'task',
            authRepository,
          );
          completedTask.updatedAt = now;
          completedTask.version = Number(task.version) + 1;
          normalized.tasks[taskIndex] = completedTask;
          pushRevision({
            action: 'update', actorName: user?.name ?? '', actorUserId: user?.id ?? '',
            after: projectItemSnapshot({ index: taskIndex, itemType: 'task', node: completedTask, parentId: itemId }),
            before: projectItemSnapshot({ index: taskIndex, itemType: 'task', node: task, parentId: itemId }),
            createdAt: now, id: randomUUID(), itemId: completedTask.id, itemType: 'task', projectId, tenantId,
            versionAfter: completedTask.version, versionBefore: Number(task.version),
          });
        }
      }
      return { item: clone(normalized), project: clone(applyProjectEstimateRollups(project)), revision: clone(revision) };
    },
    async deleteProjectItem({ expectedVersion, itemId, projectId, tenantId, user, withoutDependents = false }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;
      const context = findProjectItemContext(project, itemId);
      if (!context) return null;
      projectItemConflict(expectedVersion, context.node.version);
      const childCount = context.itemType === 'epic' ? context.node.stories.length : context.itemType === 'story' ? context.node.tasks.length : 0;
      if (childCount > 0) throw new HttpError(409, 'Delete child items before deleting this project item.');
      if (withoutDependents && (state.workItemRelations.some((relation) => relation.projectId === projectId && (relation.fromItemId === itemId || relation.toItemId === itemId))
        || state.comments.some((comment) => comment.projectId === projectId && comment.targetId === itemId)
        || state.files.some((file) => file.projectId === projectId && file.targetId === itemId)
        || state.fileLinks.some((link) => link.projectId === projectId && link.targetId === itemId))) throw itemHasDependents();
      const before = projectItemSnapshot(context);
      const now = nextProjectTimestamp(project.updatedAt);
      const deletedVersion = Number(context.node.version) + 1;
      context.collection.splice(context.index, 1);
      // Relations in both directions go with the item, leaving no orphan rows.
      state.workItemRelations = state.workItemRelations.filter(
        (relation) => relation.fromItemId !== itemId && relation.toItemId !== itemId,
      );
      state.deletedProjectItems.set(`${tenantId}:${projectId}:${itemId}`, { ...before, deletedAt: now, version: deletedVersion });
      project.updatedAt = now;
      const revision = {
        action: 'delete', actorName: user?.name ?? '', actorUserId: user?.id ?? '', after: null, before, createdAt: now,
        id: randomUUID(), itemId, itemType: context.itemType, projectId, tenantId,
        versionAfter: deletedVersion, versionBefore: Number(expectedVersion),
      };
      pushRevision(revision);
      return { item: null, project: clone(applyProjectEstimateRollups(project)), revision: clone(revision) };
    },
    async listProjectItemRevisions({ itemId, limit = 25, projectId, tenantId }) {
      const userName = (id) => authRepository?.state?.users?.find((user) => user.id === id)?.name;
      return clone(state.projectItemRevisions
        .filter((item) => item.tenantId === tenantId && item.projectId === projectId && item.itemId === itemId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((revision) => ({ ...revision, actorName: userName(revision.actorUserId) ?? revision.actorName ?? '' })));
    },
    async restoreProjectItemRevision({ expectedVersion, itemId, projectId, revisionId, revisionState = 'after', tenantId, user }) {
      const project = state.projects.find((item) => item.id === projectId && item.tenantId === tenantId);
      if (!project) return null;
      const revisionToRestore = state.projectItemRevisions.find((item) => item.id === revisionId && item.itemId === itemId && item.projectId === projectId && item.tenantId === tenantId);
      if (!revisionToRestore) throw new HttpError(404, 'Project item revision not found.');
      const active = findProjectItemContext(project, itemId);
      const deletedKey = `${tenantId}:${projectId}:${itemId}`;
      const deleted = state.deletedProjectItems.get(deletedKey) ?? null;
      const actualVersion = active?.node?.version ?? deleted?.version;
      if (!actualVersion) return null;
      projectItemConflict(expectedVersion, actualVersion);
      const target = clone(revisionState === 'before' ? revisionToRestore.before : (revisionToRestore.after ?? revisionToRestore.before));
      if (!target) throw new HttpError(409, 'This revision has no restorable item state.');
      const before = active ? projectItemSnapshot(active) : clone(deleted);
      if (active) active.collection.splice(active.index, 1);
      const collection = projectItemCollection(project, target.itemType, target.parentId ?? null);
      const now = nextProjectTimestamp(project.updatedAt);
      const node = normalizeTaskNode({ ...target.node, id: itemId, updatedAt: now, version: Number(actualVersion) + 1 }, target.itemType, authRepository);
      collection.splice(Math.min(target.position ?? collection.length, collection.length), 0, node);
      syncPursuitMarkers(project.epics);
      state.deletedProjectItems.delete(deletedKey);
      project.updatedAt = now;
      const after = projectItemSnapshot(findProjectItemContext(project, itemId));
      const revision = {
        action: 'restore', actorName: user?.name ?? '', actorUserId: user?.id ?? '', after, before, createdAt: now,
        id: randomUUID(), itemId, itemType: target.itemType, projectId, tenantId,
        versionAfter: node.version, versionBefore: Number(expectedVersion),
      };
      pushRevision(revision);
      return { item: clone(node), project: clone(applyProjectEstimateRollups(project)), revision: clone(revision) };
    },
    async listMentionableUsers({ tenantId, query }) {
      return listUsersForTenant(tenantId, query);
    },
    async listComments(target) {
      return listTargetComments(target);
    },
    async addComment({ comment, parentId, projectId, targetId, targetType, tenantId, user }) {
      if (!assertTarget(projectId, tenantId, targetType, targetId)) {
        throw new Error('Invalid comment target.');
      }

      const now = new Date().toISOString();
      const savedComment = {
        authorName: user.name ?? null,
        comment: sanitizeRichHtml(comment),
        createdAt: now,
        downvotes: 0,
        id: randomUUID(),
        parentId,
        projectId,
        targetId,
        targetType,
        upvotes: 0,
        updatedAt: now,
        userId: user.id,
      };

      state.comments.push(savedComment);
      changeLog.append([commentChange({ action: 'create', actorId: user.id, comment: savedComment, projectId, tenantId })]);
      await queueMentionEmails({
        html: savedComment.comment,
        projectId,
        targetId,
        targetType,
        userId: user.id,
      });

      return serializeComment(savedComment);
    },
    async updateComment({ commentHtml, commentId, projectId, tenantId, user }) {
      const comment = state.comments.find((item) => item.id === commentId && item.projectId === projectId);

      if (!comment || comment.projectId !== projectId) {
        return null;
      }

      if (!canEditComment(user, comment.userId)) {
        throw new Error('Forbidden');
      }

      comment.comment = sanitizeRichHtml(commentHtml);
      comment.updatedAt = new Date().toISOString();
      changeLog.append([commentChange({ action: 'update', actorId: user.id, comment, projectId, tenantId })]);

      await queueMentionEmails({
        html: comment.comment,
        projectId,
        targetId: comment.targetId,
        targetType: comment.targetType,
        userId: user.id,
      });

      return serializeComment(comment);
    },
    async deleteComment({ commentId, expectedTextHash, projectId, tenantId, user, withoutReplies = false }) {
      const comment = state.comments.find((item) => item.id === commentId && item.projectId === projectId);

      if (!comment) {
        return false;
      }

      const childCount = state.comments.filter((item) => item.parentId === commentId).length;
      const isModerator = isTenantModerator(user, tenantId);

      if (!isModerator && !canEditComment(user, comment.userId)) {
        throw new Error('Forbidden');
      }

      if (withoutReplies && childCount > 0) {
        throw commentHasReplies();
      }

      commentTextChanged(expectedTextHash, serializeComment(comment).comment);

      if (!isModerator && childCount > 0) {
        throw new Error('Forbidden');
      }

      if (!isModerator) {
        state.comments = state.comments.filter((item) => item.id !== commentId);
        changeLog.append([commentChange({ action: 'delete', actorId: user.id, comment, projectId, tenantId })]);
        return true;
      }

      const idsToDelete = new Set([commentId]);
      let changed = true;

      while (changed) {
        changed = false;

        for (const item of state.comments) {
          if (item.parentId && idsToDelete.has(item.parentId) && !idsToDelete.has(item.id)) {
            idsToDelete.add(item.id);
            changed = true;
          }
        }
      }

      changeLog.append(state.comments.filter((item) => idsToDelete.has(item.id)).map((item) => commentChange({ action: 'delete', actorId: user.id, comment: item, projectId, tenantId })));
      state.comments = state.comments.filter((item) => !idsToDelete.has(item.id));
      return true;
    },
    async voteComment({ commentId, projectId, tenantId, user, vote }) {
      const comment = state.comments.find((item) => item.id === commentId && item.projectId === projectId);

      if (!comment) {
        return null;
      }

      if (!assertTarget(projectId, tenantId, comment.targetType, comment.targetId)) {
        return null;
      }

      const existing = state.commentVotes.find((row) => row.commentId === commentId && row.userId === user.id) ?? null;
      let upvotes = Number(comment.upvotes ?? 0);
      let downvotes = Number(comment.downvotes ?? 0);

      if (!existing) {
        state.commentVotes.push({
          commentId,
          createdAt: new Date().toISOString(),
          id: randomUUID(),
          userId: user.id,
          vote,
        });

        if (vote === 'up') {
          upvotes += 1;
        } else {
          downvotes += 1;
        }
      } else if (existing.vote === vote) {
        state.commentVotes = state.commentVotes.filter((row) => row.id !== existing.id);

        if (vote === 'up') {
          upvotes = Math.max(0, upvotes - 1);
        } else {
          downvotes = Math.max(0, downvotes - 1);
        }
      } else {
        if (existing.vote === 'up') {
          upvotes = Math.max(0, upvotes - 1);
        } else {
          downvotes = Math.max(0, downvotes - 1);
        }

        if (vote === 'up') {
          upvotes += 1;
        } else {
          downvotes += 1;
        }

        existing.vote = vote;
        existing.updatedAt = new Date().toISOString();
      }

      comment.upvotes = upvotes;
      comment.downvotes = downvotes;
      comment.updatedAt = new Date().toISOString();

      return {
        downvotes,
        id: commentId,
        upvotes,
      };
    },
    async listFiles(target) {
      return listTargetFiles(target);
    },
    async isFileTarget({ projectId, targetId, targetType, tenantId }) {
      return Boolean(assertTarget(projectId, tenantId, targetType, targetId));
    },
    async saveFile({ createOnly = false, expectedSignature, fileContentsBase64, fileDescription, fileName, fileType, folderId = null, inlineImage, projectId, targetId, targetType, tenantId, user }) {
      if (!assertTarget(projectId, tenantId, targetType, targetId)) {
        throw new Error('Invalid file target.');
      }

      // A name is taken within its folder (in a channel library) on the target.
      const named = state.files.filter((file) => file.projectId === projectId && file.targetId === targetId && file.targetType === targetType && (file.folderId ?? null) === (folderId ?? null) && sameStoredFileName(file.fileName, fileName));
      if (createOnly && named.length) throw fileNameTaken();
      if (expectedSignature !== undefined && !(named.length ? named.map((file) => file.signature ?? null) : [null]).includes(expectedSignature)) throw fileChanged();

      const bytes = Buffer.from(fileContentsBase64, 'base64');

      if (scanner.enabled) {
        const scan = await scanner.scanBytes(bytes);
        if (!scan?.clean) {
          throw new Error('File failed virus scan.');
        }
      }

      const signature = createHash('md5').update(bytes).digest('hex');
      if (named[0]) {
        const existing = named[0];
        if (existing.signature === signature && existing.contentType === fileType) {
          Object.assign(existing, { description: fileDescription ?? '', updatedAt: new Date().toISOString() });
          return { ...fileView(existing), unchanged: true };
        }
        const storageKey = randomUUID();
        await storage.write(storageKey, bytes);
        supersedeStoredFile(existing, { fileDescription: fileDescription ?? '', fileName: existing.fileName, fileSize: bytes.length, fileType, scan: scannedBeforeSaving(bytes), signature, storageKey, user });
        changeLog.append([fileChange({ action: 'version', actorId: user.id, file: fileView(existing), projectId, tenantId })]);
        return fileView(existing);
      }

      const fileId = randomUUID();
      const now = new Date().toISOString();

      await storage.write(fileId, bytes);

      const scan = scannedBeforeSaving(bytes);
      const file = {
        contentType: fileType,
        createdAt: now,
        fileName,
        fileSize: bytes.length,
        folderId: folderId ?? null,
        id: fileId,
        inlineImage: Boolean(inlineImage),
        projectId,
        scanStatus: scan.scanStatus,
        scannedAt: scan.scannedAt.toISOString(),
        sha256: scan.sha256,
        // The contents' MD5, as MySQL keeps it: a file saved over within a second shows by it.
        signature,
        targetId,
        targetType,
        tenantId,
        updatedAt: now,
        uploadedBy: {
          id: user.id,
          name: user.name,
        },
        description: fileDescription ?? '',
      };

      state.files.push(file);
      changeLog.append([fileChange({ action: 'create', actorId: user.id, file, projectId, tenantId })]);

      return fileView(file);
    },
    async getFileRecord({ fileId, tenantId }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      return file ? fileView(file) : null;
    },
    async saveFileVersion({ expectedVersion, fileContentsBase64, fileDescription, fileId, fileName, fileType, note, projectId, tenantId, user }) {
      const bytes = Buffer.from(fileContentsBase64, 'base64');
      if (scanner.enabled) {
        const scan = await scanner.scanBytes(bytes);
        if (!scan?.clean) throw new Error('File failed virus scan.');
      }
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      if ((file.version ?? 1) !== expectedVersion) throw fileChanged();
      const name = fileName ?? file.fileName;
      const type = fileType ?? file.contentType;
      if (state.files.some((item) => item.id !== file.id && item.projectId === file.projectId && item.targetId === file.targetId && item.targetType === file.targetType && (item.folderId ?? null) === (file.folderId ?? null) && sameStoredFileName(item.fileName, name))) throw fileNameTaken();
      const signature = createHash('md5').update(bytes).digest('hex');
      if (file.signature === signature && file.fileName === name && file.contentType === type) return { file: fileView(file), unchanged: true };
      const storageKey = randomUUID();
      await storage.write(storageKey, bytes);
      supersedeStoredFile(file, { fileDescription, fileName: name, fileSize: bytes.length, fileType: type, note, scan: scannedBeforeSaving(bytes), signature, storageKey, user });
      changeLog.append([fileChange({ action: 'version', actorId: user.id, file: fileView(file), note, projectId, tenantId })]);
      return { file: fileView(file), unchanged: false };
    },
    async restoreFileVersion({ expectedVersion, fileId, projectId, tenantId, user, version }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      if ((file.version ?? 1) !== expectedVersion) throw fileChanged();
      const earlier = state.fileVersions.find((item) => item.fileId === fileId && item.tenantId === tenantId && item.version === version);
      if (!earlier) return null;
      if (earlier.deletedAt || (earlier.scanStatus ?? 'clean') === 'infected') throw fileVersionUnavailable();
      if (state.files.some((item) => item.id !== file.id && item.projectId === file.projectId && item.targetId === file.targetId && item.targetType === file.targetType && (item.folderId ?? null) === (file.folderId ?? null) && sameStoredFileName(item.fileName, earlier.fileName))) throw fileNameTaken();
      if (file.signature === earlier.signature && file.fileName === earlier.fileName && file.contentType === earlier.contentType) return { file: fileView(file), unchanged: true };
      const note = `Restored from version ${version}`;
      supersedeStoredFile(file, { fileName: earlier.fileName, fileSize: earlier.fileSize, fileType: earlier.contentType, note, scan: { previewStorageKey: earlier.previewStorageKey ?? null, scanStatus: earlier.scanStatus ?? 'clean', scannedAt: earlier.scannedAt ?? null, sha256: earlier.sha256 ?? null }, signature: earlier.signature, storageKey: earlier.storageKey, user });
      changeLog.append([fileChange({ action: 'restore', actorId: user.id, file: fileView(file), note, projectId, tenantId })]);
      return { file: fileView(file), unchanged: false };
    },
    async listFileVersions({ fileId, tenantId }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      const view = fileView(file);
      return [
        { contentType: view.contentType, current: true, deletedAt: null, fileName: view.fileName, fileSize: view.fileSize, note: view.versionNote, scanStatus: view.scanStatus, sha256: view.sha256, signature: view.signature ?? null, uploadedAt: view.versionUploadedAt, uploadedBy: view.uploadedBy, version: view.version },
        ...state.fileVersions.filter((item) => item.fileId === fileId && item.tenantId === tenantId)
          .sort((left, right) => right.version - left.version)
          .map(({ contentType, deletedAt, fileName, fileSize, note, scanStatus, sha256, signature, uploadedAt, uploadedBy, version }) => clone({ contentType, current: false, deletedAt: deletedAt ?? null, fileName, fileSize, note, scanStatus: scanStatus ?? 'clean', sha256: sha256 ?? null, signature, uploadedAt, uploadedBy, version })),
      ];
    },
    async linkFile({ fileId, projectId, targetId, targetType, tenantId, user }) {
      if (!assertTarget(projectId, tenantId, targetType, targetId)) throw new Error('Invalid file target.');
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      const exists = state.fileLinks.some((link) => link.fileId === fileId && link.targetId === targetId && link.targetType === targetType);
      if (exists || (file.targetId === targetId && file.targetType === targetType)) return { file: fileView(file), linked: false };
      state.fileLinks.push({ createdAt: new Date().toISOString(), createdBy: user.id, fileId, id: randomUUID(), projectId, targetId, targetType, tenantId });
      changeLog.append([fileChange({ action: 'link', actorId: user.id, file: fileView(file), link: { targetId, targetType }, projectId, tenantId })]);
      return { file: fileView(file), linked: true };
    },
    async unlinkFile({ fileId, linkId, projectId, tenantId, user }) {
      const link = state.fileLinks.find((item) => item.id === linkId && item.fileId === fileId && item.projectId === projectId && item.tenantId === tenantId);
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!link || !file) return null;
      state.fileLinks = state.fileLinks.filter((item) => item.id !== linkId);
      changeLog.append([fileChange({ action: 'unlink', actorId: user.id, file: fileView(file), link, projectId, tenantId })]);
      return { file: fileView(file) };
    },
    async setFileAudience({ audience, fileId, projectId, tenantId, user }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId && item.projectId === projectId);
      if (!file) return null;
      if ((file.audience ?? 'internal') === audience) return { changed: false, file: fileView(file) };
      file.audience = audience;
      file.updatedAt = new Date().toISOString();
      changeLog.append([fileChange({ action: 'audience', actorId: user.id, file: fileView(file), projectId, tenantId })]);
      return { changed: true, file: fileView(file) };
    },
    // Renames a file, moves it to another target or folder, or both, keeping its id, versions,
    // links and comments. A name is taken within its destination folder, as on upload.
    async moveFile({ fileId, fileName, folderId = null, projectId, targetId, targetType, tenantId, user }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId && item.projectId === projectId);
      if (!file) return null;
      if (!assertTarget(projectId, tenantId, targetType, targetId)) throw new Error('Invalid file target.');
      const from = { fileName: file.fileName, folderId: file.folderId ?? null, targetId: file.targetId, targetType: file.targetType };
      const to = { fileName, folderId: folderId ?? null, targetId, targetType };
      if (from.fileName === to.fileName && from.folderId === to.folderId && from.targetId === to.targetId && from.targetType === to.targetType) return { changed: false, file: fileView(file) };
      if (state.files.some((item) => item.id !== file.id && item.projectId === projectId && item.targetId === targetId && item.targetType === targetType && (item.folderId ?? null) === to.folderId && sameStoredFileName(item.fileName, fileName))) throw fileNameTaken();
      Object.assign(file, to, { updatedAt: new Date().toISOString() });
      changeLog.append([fileChange({ action: fileMoveAction(from, to), actorId: user.id, extra: { from }, file: fileView(file), projectId, tenantId })]);
      return { changed: true, file: fileView(file) };
    },
    // One version's storage object and what it holds: the current version when version is null.
    // No bytes are read. Null when there is no such version or it was deleted.
    async describeFileVersion({ fileId, tenantId, version = null }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      return file ? describeStoredVersion(file, version) : null;
    },
    // One version's bytes with the storage object that holds them, which a signature request pins.
    // Without includeBytes, only its SHA-256: the stored one, or one hashed from a stream.
    async getFileVersionSource({ fileId, tenantId, version = null, includeBytes = true }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      const described = describeStoredVersion(file, version);
      if (!described) return null;
      assertFileScanClean(described.scanStatus);
      const bytes = includeBytes ? Buffer.from((await storage.read(described.storageKey)).bytes) : null;
      return {
        ...(bytes ? { bytes } : {}),
        contentType: described.contentType,
        fileName: described.fileName,
        fileSize: described.fileSize,
        projectId: file.projectId,
        scanStatus: described.scanStatus,
        sha256: described.sha256 ?? (bytes ? createHash('sha256').update(bytes).digest('hex') : await hashStoredObject(storage, described.storageKey)),
        storageKey: described.storageKey,
        version: described.version,
      };
    },
    async readStoredObject(storageKey) {
      const asset = await storage.read(storageKey);
      return Buffer.from(asset.bytes);
    },
    async getFileAsset({ fileId, tenantId, version = null }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      const described = describeStoredVersion(file, version);
      if (!described) return null;
      assertFileScanClean(described.scanStatus);
      const asset = await storage.read(described.storageKey);
      return { ...asset, contentType: described.contentType, file: described.file };
    },
    // A version's contents as a stream, or bytes start to end (inclusive) of them, after its scan.
    async openFileContent({ end, fileId, start, tenantId, version = null }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);
      if (!file) return null;
      const described = describeStoredVersion(file, version);
      if (!described) return null;
      assertFileScanClean(described.scanStatus);
      return { ...described, ...await openStoredStream(storage, described.storageKey, { end, start }) };
    },
    async openStoredObject(storageKey, range = {}) {
      return openStoredStream(storage, storageKey, range);
    },
    // Multipart uploads (file_uploads).
    async createFileUpload(upload) {
      state.fileUploads.push(clone(upload));
      return clone(upload);
    },
    async getFileUpload({ tenantId, uploadId }) {
      const upload = state.fileUploads.find((item) => item.id === uploadId && item.tenantId === tenantId);
      return upload ? clone(upload) : null;
    },
    // Moves an upload from one of the statuses in from to status. False when it was in none of them.
    async setFileUploadStatus({ from, status, tenantId, uploadId }) {
      const upload = state.fileUploads.find((item) => item.id === uploadId && item.tenantId === tenantId);
      if (!upload || !from.includes(upload.status)) return false;
      upload.status = status;
      return true;
    },
    async listExpiredFileUploads({ limit = 50, now = new Date() } = {}) {
      return state.fileUploads
        .filter((item) => ['uploading', 'assembled'].includes(item.status) && new Date(item.expiresAt) <= now)
        .slice(0, limit)
        .map((item) => clone(item));
    },
    // The assembled object of an upload becomes a file, or a new version of one, waiting for its scan.
    async saveUploadedFile({ expectedVersion = null, fileDescription, keepBoth = false, note = '', size, upload, user }) {
      const { projectId, targetId, targetType, tenantId } = upload;
      const stored = state.fileUploads.find((item) => item.id === upload.id && item.tenantId === tenantId);
      if (!stored || stored.status !== 'assembled') throw uploadNotReady();
      if (!assertTarget(projectId, tenantId, targetType, targetId)) throw new Error('Invalid file target.');
      // Names are taken within a folder: the file's own for a new version, the upload's otherwise.
      const versioned = upload.fileId && !keepBoth ? state.files.find((item) => item.id === upload.fileId && item.tenantId === tenantId) : null;
      const folderId = versioned ? versioned.folderId ?? null : upload.folderId ?? null;
      const onTarget = (name, exceptId = null) => state.files.some((item) => item.id !== exceptId && item.projectId === projectId && item.targetId === targetId && item.targetType === targetType && (item.folderId ?? null) === folderId && sameStoredFileName(item.fileName, name));
      const scan = { scanStatus: 'pending', scannedAt: null, sha256: null };
      const supersede = (file, fileName) => supersedeStoredFile(file, { fileDescription, fileName, fileSize: size, fileType: upload.contentType, note, scan, signature: null, storageKey: upload.storageKey, user });
      let file;
      let action = 'version';
      if (upload.fileId && !keepBoth) {
        file = state.files.find((item) => item.id === upload.fileId && item.tenantId === tenantId && item.projectId === projectId);
        if (!file) throw new HttpError(404, 'File not found.');
        if ((file.version ?? 1) !== (expectedVersion ?? upload.baseVersion)) throw stalledVersion(file.version ?? 1);
        if (onTarget(upload.fileName, file.id)) throw fileNameTaken();
        supersede(file, upload.fileName);
      } else {
        file = keepBoth ? null : state.files.find((item) => item.projectId === projectId && item.targetId === targetId && item.targetType === targetType && (item.folderId ?? null) === folderId && sameStoredFileName(item.fileName, upload.fileName));
        if (file) {
          supersede(file, file.fileName);
        } else {
          action = 'create';
          const now = new Date().toISOString();
          file = {
            contentType: upload.contentType,
            createdAt: now,
            description: fileDescription ?? '',
            fileName: onTarget(upload.fileName) ? keptBothName(upload.fileName, (name) => onTarget(name)) : upload.fileName,
            fileSize: size,
            folderId: upload.folderId ?? null,
            id: randomUUID(),
            inlineImage: String(upload.contentType).toLowerCase().startsWith('image/'),
            projectId,
            ...scan,
            signature: null,
            storageKey: upload.storageKey,
            targetId,
            targetType,
            tenantId,
            updatedAt: now,
            uploadedBy: { id: user.id, name: user.name },
          };
          state.files.push(file);
        }
      }
      Object.assign(stored, { fileId: file.id, status: 'completed' });
      // Direct messages are not project work, so their files stay out of the change log.
      if (targetType !== DM_TARGET_TYPE) changeLog.append([fileChange({ action, actorId: user.id, file: fileView(file), note: action === 'version' ? note : null, projectId, tenantId })]);
      return { file: fileView(file) };
    },
    // Storage objects waiting for a scan, each once however many rows hold it.
    async listPendingScanObjects({ limit = 10 } = {}) {
      const objects = new Map();
      for (const file of state.files) {
        if ((file.scanStatus ?? 'clean') === 'pending') objects.set(file.storageKey ?? file.id, { size: Number(file.fileSize ?? 0), storageKey: file.storageKey ?? file.id, tenantId: file.tenantId });
      }
      for (const version of state.fileVersions) {
        if ((version.scanStatus ?? 'clean') === 'pending' && !version.deletedAt) objects.set(version.storageKey, { size: Number(version.fileSize ?? 0), storageKey: version.storageKey, tenantId: version.tenantId });
      }
      return [...objects.values()].slice(0, limit);
    },
    // A scan's result on every pending row that holds the object. An infected old version is
    // marked deleted as well; the current one keeps its row, marked infected. Returns each file and
    // version touched, with who uploaded it, for the notice.
    async recordObjectScan({ md5 = null, scanStatus, sha256 = null, storageKey }) {
      const at = new Date().toISOString();
      const touched = [];
      for (const file of state.files) {
        if ((file.storageKey ?? file.id) !== storageKey || (file.scanStatus ?? 'clean') !== 'pending') continue;
        Object.assign(file, { scanStatus, scannedAt: at, sha256: sha256 ?? file.sha256 ?? null, signature: file.signature ?? md5 });
        touched.push({ current: true, file, uploadedBy: file.uploadedBy, version: file.version ?? 1 });
      }
      for (const version of state.fileVersions) {
        if (version.storageKey !== storageKey || (version.scanStatus ?? 'clean') !== 'pending' || version.deletedAt) continue;
        Object.assign(version, { scanStatus, scannedAt: at, sha256: sha256 ?? version.sha256 ?? null, signature: version.signature ?? md5, ...(scanStatus === 'infected' ? { deletedAt: at, deletedBy: 'system:scanner' } : {}) });
        const file = state.files.find((item) => item.id === version.fileId && item.tenantId === version.tenantId);
        if (file) touched.push({ current: false, file, uploadedBy: version.uploadedBy, version: version.version });
      }
      changeLog.append(touched.map(({ file, version }) => fileChange({ action: 'scanned', actorId: 'system:scanner', extra: { scanStatus, scannedVersion: version }, file: fileView(file), projectId: file.projectId, tenantId: file.tenantId })));
      return touched.map(({ current, file, uploadedBy, version }) => {
        const uploader = authRepository?.state?.users?.find((entry) => entry.id === uploadedBy?.id);
        return { current, fileId: file.id, fileName: file.fileName, projectId: file.projectId, projectName: projectForTenant(file.projectId, file.tenantId)?.name ?? '', tenantId: file.tenantId, uploader: { email: uploader?.email ?? '', id: uploadedBy?.id ?? null, name: uploader?.name ?? uploadedBy?.name ?? '' }, version };
      });
    },
    // Office files whose scan passed and that have no preview yet (lib/files/file-preview.js), up to
    // maxBytes, each object once however many rows hold it. Newest first.
    async listPendingPreviewObjects({ limit = 10, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
      const objects = new Map();
      const due = (row) => (row.scanStatus ?? 'clean') === 'clean' && !row.previewStorageKey && !row.deletedAt && Number(row.fileSize ?? 0) <= maxBytes && isOfficeFile(row);
      const add = (row, storageKey, at) => {
        const known = objects.get(storageKey);
        if (!known || at > known.at) objects.set(storageKey, { at, contentType: row.contentType, fileName: row.fileName, size: Number(row.fileSize ?? 0), storageKey });
      };
      for (const file of state.files) if (due(file)) add(file, file.storageKey ?? file.id, file.versionUploadedAt ?? file.updatedAt ?? '');
      for (const version of state.fileVersions) if (due(version)) add(version, version.storageKey, version.uploadedAt ?? '');
      return [...objects.values()].sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, limit).map(({ at: _at, ...entry }) => entry);
    },
    // A preview's result (the PDF's key, or NO_PREVIEW) on every row that holds the object and has
    // none yet. Returns each file and version touched.
    async recordObjectPreview({ previewStorageKey, storageKey }) {
      const touched = [];
      for (const file of state.files) {
        if ((file.storageKey ?? file.id) !== storageKey || file.previewStorageKey || (file.scanStatus ?? 'clean') !== 'clean') continue;
        file.previewStorageKey = previewStorageKey;
        touched.push({ current: true, fileId: file.id, projectId: file.projectId, tenantId: file.tenantId, version: file.version ?? 1 });
      }
      for (const version of state.fileVersions) {
        if (version.storageKey !== storageKey || version.previewStorageKey || version.deletedAt || (version.scanStatus ?? 'clean') !== 'clean') continue;
        version.previewStorageKey = previewStorageKey;
        const file = state.files.find((item) => item.id === version.fileId && item.tenantId === version.tenantId);
        if (file) touched.push({ current: false, fileId: file.id, projectId: file.projectId, tenantId: file.tenantId, version: version.version });
      }
      return touched;
    },
    // Marks an old version deleted. Returns its storage key when no other version still holds the
    // object, for the caller to delete once the row is saved.
    async deleteFileVersion({ fileId, projectId, tenantId, user, version }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId && item.projectId === projectId);
      if (!file) return null;
      if ((file.version ?? 1) === version) throw currentVersionDelete();
      const earlier = state.fileVersions.find((item) => item.fileId === fileId && item.tenantId === tenantId && item.version === version);
      if (!earlier || earlier.deletedAt) return null;
      Object.assign(earlier, { deletedAt: new Date().toISOString(), deletedBy: user.id });
      const stillHeld = (file.storageKey ?? file.id) === earlier.storageKey || state.fileVersions.some((item) => item !== earlier && !item.deletedAt && item.storageKey === earlier.storageKey);
      changeLog.append([fileChange({ action: 'version_delete', actorId: user.id, extra: { deletedVersion: version }, file: fileView(file), projectId, tenantId })]);
      return { file: fileView(file), previewStorageKey: !stillHeld && isStoredPreview(earlier.previewStorageKey) ? earlier.previewStorageKey : null, storageKey: stillHeld ? null : earlier.storageKey, version };
    },
    // What a project's files take in storage: every live version, each stored object once.
    async getProjectFileStorage({ projectId, tenantId }) {
      const files = state.files.filter((item) => item.projectId === projectId && item.tenantId === tenantId);
      const ids = new Set(files.map((file) => file.id));
      const objects = new Map();
      let versions = 0;
      for (const file of files) {
        versions += 1;
        if ((file.scanStatus ?? 'clean') !== 'infected') objects.set(file.storageKey ?? file.id, Number(file.fileSize ?? 0));
      }
      for (const version of state.fileVersions) {
        if (!ids.has(version.fileId) || version.deletedAt || (version.scanStatus ?? 'clean') === 'infected') continue;
        versions += 1;
        objects.set(version.storageKey, Number(version.fileSize ?? 0));
      }
      return { bytes: [...objects.values()].reduce((sum, size) => sum + size, 0), files: files.length, versions };
    },
    async deleteFile({ fileId, tenantId, user = null }) {
      const file = state.files.find((item) => item.id === fileId && item.tenantId === tenantId);

      if (!file) {
        return false;
      }

      const deleted = fileView(file);
      await dropStoredFiles([fileId]);
      if (user) changeLog.append([fileChange({ action: 'delete', actorId: user.id, file: deleted, projectId: file.projectId, tenantId })]);
      return true;
    },
    async exportProjectArchiveData({ projectId, tenantId }) {
      const project = projectForTenant(projectId, tenantId);
      if (!project) {
        return null;
      }

      const files = [];
      // Only contents that passed their scan: anything else is not downloadable, or is gone.
      for (const file of state.files.filter((item) => item.projectId === projectId && item.tenantId === tenantId && (item.scanStatus ?? 'clean') === 'clean')) {
        const asset = await storage.read(file.storageKey ?? file.id);
        const { storageKey, ...stored } = clone(file);
        files.push({
          ...stored,
          contentsBase64: Buffer.from(asset.bytes).toString('base64'),
        });
      }
      const fileIds = new Set(files.map((file) => file.id));
      const fileVersions = [];
      for (const version of state.fileVersions.filter((item) => fileIds.has(item.fileId) && !item.deletedAt && (item.scanStatus ?? 'clean') === 'clean')) {
        const asset = await storage.read(version.storageKey);
        const { storageKey, ...stored } = clone(version);
        fileVersions.push({ ...stored, contentsBase64: Buffer.from(asset.bytes).toString('base64'), userId: version.uploadedBy?.id });
      }
      const fileLinks = clone(state.fileLinks.filter((link) => fileIds.has(link.fileId)));

      const sourceUserIds = collectArchiveSourceUserIds({
        comments: state.comments.filter((item) => item.projectId === projectId),
        fileLinks,
        fileVersions,
        files,
        project,
        projectUsers: state.projectMemberships.get(projectId) ?? [],
        sprintStaffing: [...state.sprintStaffing.values()].flat(),
      });
      const users = (authRepository?.state?.users ?? [])
        .filter((user) => sourceUserIds.includes(user.id))
        .map((user) => ({
          email: user.email,
          id: user.id,
          name: user.name,
        }));

      return {
        archiveVersion: 1,
        exportedAt: new Date().toISOString(),
        fileLinks,
        fileVersions,
        files,
        project: clone(applyProjectEstimateRollups(project)),
        projectUsers: clone(state.projectMemberships.get(projectId) ?? []),
        comments: clone(state.comments.filter((item) => item.projectId === projectId)),
        commentVotes: clone(state.commentVotes.filter((item) => state.comments.some((comment) => comment.projectId === projectId && comment.id === item.commentId))),
        sprintStaffing: clone([...state.sprintStaffing.values()].flat().filter((item) => state.sprints.some((sprint) => sprint.projectId === projectId && sprint.id === item.sprintId))),
        sprints: clone(state.sprints.filter((item) => item.projectId === projectId)),
        users,
      };
    },
    // Archive ids another workspace holds: its project, work items or files.
    archiveHeldElsewhere(archiveData, tenantId) {
      const ids = archiveRecordIds(archiveData);
      const otherProjects = [...state.projects, ...state.deletedProjects.map((entry) => entry.project)].filter((project) => project.tenantId !== tenantId);
      const otherTaskIds = new Set(otherProjects.flatMap((project) => collectArchiveProjectTaskIds(project)));
      return [
        ...ids.get('project').filter((id) => otherProjects.some((project) => project.id === id)).map((id) => ({ id, type: 'project' })),
        ...ids.get('task').filter((id) => otherTaskIds.has(id)).map((id) => ({ id, type: 'task' })),
        ...ids.get('file').filter((id) => state.files.some((file) => file.id === id && file.tenantId !== tenantId)).map((id) => ({ id, type: 'file' })),
      ];
    },
    async inspectProjectArchiveData({ archiveData, tenantId }) {
      const tenantUsers = listUsersForTenant(tenantId);
      const projectId = archiveData?.project?.id ?? '';
      const conflicts = [];
      // A copy gets new ids, so nothing in this workspace conflicts with it.
      const importsAsCopy = this.archiveHeldElsewhere(archiveData, tenantId).length > 0;

      const projectExists = (project) => project.id === projectId && project.tenantId === tenantId;
      if (projectId && (state.projects.some(projectExists) || state.deletedProjects.some((entry) => projectExists(entry.project)))) {
        conflicts.push({ id: projectId, type: 'project' });
      }
      for (const file of archiveData?.files ?? []) {
        if (state.files.some((item) => item.id === file.id && item.tenantId === tenantId)) {
          conflicts.push({ id: file.id, type: 'file' });
        }
      }
      if (importsAsCopy) conflicts.length = 0;

      return {
        conflicts,
        conflictGroups: archiveConflictGroups(conflicts),
        importsAsCopy,
        project: archiveData?.project
          ? {
              id: archiveData.project.id,
              name: archiveData.project.name,
              taskCount: countProjectTasks(archiveData.project),
            }
          : null,
        sourceUsers: buildArchiveSourceUsers(archiveData, tenantUsers),
        tenantUsers,
      };
    },
    async importProjectArchiveData({ archiveData: sourceArchive, assistantRepository, overwriteMode = 'none', tenantId, user, userMappings, vaultFiles: sourceVaultFiles }) {
      assertArchiveFileRecords(sourceArchive);
      // Another workspace's records are never replaced: the project comes in as a copy.
      const copy = this.archiveHeldElsewhere(sourceArchive, tenantId).length > 0
        ? copyArchiveWithNewIds({ archiveData: sourceArchive, vaultFiles: sourceVaultFiles })
        : null;
      const archiveData = copy?.archiveData ?? sourceArchive;
      const vaultFiles = copy?.vaultFiles ?? sourceVaultFiles;
      const inspection = await this.inspectProjectArchiveData({ archiveData, tenantId });
      const normalizedOverwriteMode = copy ? 'none' : normalizeArchiveOverwriteMode(overwriteMode);
      if (inspection.conflicts.length > 0) {
        if (normalizedOverwriteMode === 'none') {
          throwArchiveConflict(inspection.conflicts);
        }
        if (
          normalizedOverwriteMode === 'project'
          && !inspection.conflicts.some((conflict) => conflict.type === 'project' && conflict.id === archiveData.project?.id)
        ) {
          throwArchiveConflict(inspection.conflicts, 'Project overwrite requires a matching project conflict.');
        }
        if (normalizedOverwriteMode === 'project') {
          const projectId = archiveData.project?.id;
          const outsideProjectConflicts = inspection.conflicts.filter((conflict) => {
            if (conflict.type === 'project') {
              return conflict.id !== projectId;
            }
            if (conflict.type === 'file') {
              const file = state.files.find((item) => item.id === conflict.id && item.tenantId === tenantId);
              return file?.projectId !== projectId;
            }
            return true;
          });
          if (outsideProjectConflicts.length > 0) {
            throwArchiveConflict(outsideProjectConflicts, 'Project overwrite cannot remove conflicts outside this project.');
          }
        }

        const projectId = archiveData.project?.id;
        if (projectId && ['project', 'all'].includes(normalizedOverwriteMode)) {
          await dropStoredFiles(state.files.filter((file) => file.projectId === projectId && file.tenantId === tenantId).map((file) => file.id));
          state.projects = state.projects.filter((project) => !(project.id === projectId && project.tenantId === tenantId));
          state.deletedProjects = state.deletedProjects.filter((entry) => !(entry.project.id === projectId && entry.project.tenantId === tenantId));
          state.projectMemberships.delete(projectId);
          state.sprints = state.sprints.filter((sprint) => sprint.projectId !== projectId);
          for (const [sprintId, staffing] of state.sprintStaffing.entries()) {
            if (state.sprints.some((sprint) => sprint.id === sprintId)) {
              state.sprintStaffing.set(sprintId, staffing);
            } else {
              state.sprintStaffing.delete(sprintId);
            }
          }
          state.comments = state.comments.filter((comment) => comment.projectId !== projectId);
          state.files = state.files.filter((file) => !(file.projectId === projectId && file.tenantId === tenantId));
        }

        if (normalizedOverwriteMode === 'all') {
          const conflictFileIds = new Set(inspection.conflicts
            .filter((conflict) => conflict.type === 'file')
            .map((conflict) => conflict.id));
          await dropStoredFiles([...conflictFileIds].filter((fileId) => state.files.some((file) => file.id === fileId && file.tenantId === tenantId)));
        }

        const remainingInspection = await this.inspectProjectArchiveData({ archiveData, tenantId });
        if (remainingInspection.conflicts.length > 0) {
          throwArchiveConflict(remainingInspection.conflicts, 'Project archive still conflicts after overwrite cleanup.');
        }
      }

      const userMap = normalizeArchiveUserMappings(userMappings);
      const project = clone(archiveData.project);
      project.tenantId = tenantId;
      project.role = 'admin';
      project.epics = (project.epics ?? []).map((task) => remapTaskArchiveAssignments(task, userMap));
      state.projects.push(rebuildProject(project));

      const projectUsers = (archiveData.projectUsers ?? [])
        .flatMap((entry) => {
          const userId = mappedArchiveUserId(entry.user_id ?? entry.id, userMap, null);
          return userId ? [{ ...entry, id: userId, role: entry.role ?? 'user' }] : [];
        });
      if (!projectUsers.some((entry) => entry.id === user.id)) {
        projectUsers.push({
          email: user.email,
          id: user.id,
          name: user.name,
          role: 'admin',
        });
      }
      state.projectMemberships.set(project.id, projectUsers);

      for (const sprint of archiveData.sprints ?? []) {
        state.sprints.push({ ...sprint, projectId: project.id });
      }
      for (const staffing of archiveData.sprintStaffing ?? []) {
        const userId = mappedArchiveUserId(staffing.userId ?? staffing.user_id, userMap, null);
        if (!userId) {
          continue;
        }
        const sprintId = staffing.sprintId ?? staffing.sprint_id;
        state.sprintStaffing.set(sprintId, [
          ...(state.sprintStaffing.get(sprintId) ?? []),
          { ...staffing, sprintId, userId },
        ]);
      }
      for (const comment of archiveData.comments ?? []) {
        state.comments.push({
          ...comment,
          projectId: project.id,
          userId: mappedArchiveUserId(comment.userId ?? comment.user_id, userMap, user.id),
        });
      }
      for (const file of archiveData.files ?? []) {
        if (state.files.some((item) => item.id === file.id)) throw new HttpError(400, 'The archive has a file id already in use.');
        const bytes = vaultFiles.get(file.id);
        const storageKey = randomUUID();
        await storage.write(storageKey, bytes);
        const nextFile = clone(file);
        delete nextFile.contentsBase64;
        state.files.push({
          ...nextFile,
          storageKey,
          projectId: project.id,
          tenantId,
          uploadedBy: {
            id: mappedArchiveUserId(file.uploadedBy?.id ?? file.userId ?? file.user_id, userMap, user.id),
            name: file.uploadedBy?.name ?? 'Unknown user',
          },
        });
      }
      for (const version of archiveData.fileVersions ?? []) {
        const versionId = randomUUID();
        await storage.write(versionId, vaultFiles.get(version.id));
        const { contentsBase64, userId, ...stored } = clone(version);
        state.fileVersions.push({ ...stored, id: versionId, storageKey: versionId, tenantId, uploadedBy: { id: mappedArchiveUserId(version.uploadedBy?.id ?? userId, userMap, user.id), name: version.uploadedBy?.name ?? 'Unknown user' } });
      }
      for (const link of archiveData.fileLinks ?? []) {
        if (!findTargetInProject(project, link.targetType, link.targetId)) continue;
        state.fileLinks.push({ ...clone(link), createdBy: mappedArchiveUserId(link.createdBy, userMap, user.id), id: randomUUID(), projectId: project.id, tenantId });
      }

      if (archiveData.assistantProjectState && assistantRepository?.saveProjectAssistantState) {
        await assistantRepository.saveProjectAssistantState({
          projectId: project.id,
          tenantId,
          value: archiveData.assistantProjectState,
        });
      }

      return {
        copied: Boolean(copy),
        importedProjectId: project.id,
        project,
      };
    },
  };
}

// DATE columns come back from mysql2 as Date objects at local midnight. The API and the
// editor's date inputs use plain YYYY-MM-DD, so convert them before they leave the repository.
export function dateOnlyValue(value) {
  if (value == null || value === '') {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) {
      return null;
    }

    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

// Shared cross-project ticket filtering. Project is a filter, not a container.
export function matchesTicketFilters(ticket, filters = {}) {
  const anyOf = (values, actual) => !values?.length || values.includes(actual);
  const search = String(filters.search ?? '').trim().toLowerCase();

  if (!anyOf(filters.categories, ticket.category)) return false;
  if (!anyOf(filters.severities, ticket.severity)) return false;
  if (!anyOf(filters.statusValues, ticket.status)) return false;
  if (!anyOf(filters.assigneeIds, ticket.assigneeId)) return false;
  if (!anyOf(filters.environmentIds, ticket.environmentId)) return false;
  if (!anyOf(filters.externalReviewStates, ticket.externalReviewState)) return false;
  if (filters.releaseIds?.length
    && !filters.releaseIds.includes(ticket.foundInReleaseId)
    && !filters.releaseIds.includes(ticket.fixedInReleaseId)) return false;
  if (filters.reopened && !(Number(ticket.reopenCount) > 0)) return false;
  if (search) {
    const haystack = `${ticket.name ?? ''} ${ticket.description ?? ''} ${ticket.reproSteps ?? ''}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  return true;
}

// Stable cursor over (updatedAt desc, id) so pagination does not repeat or skip rows
// while the underlying data is unchanged.
export function encodeTicketCursor(ticket) {
  return Buffer.from(`${ticket.updatedAt ?? ''}|${ticket.id}`, 'utf8').toString('base64url');
}

export function decodeTicketCursor(cursor) {
  if (!cursor) return null;
  const [updatedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return id ? { id, updatedAt } : null;
}

export function sortTicketsForListing(tickets) {
  return [...tickets].sort((left, right) => {
    const byDate = String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
    return byDate !== 0 ? byDate : String(left.id).localeCompare(String(right.id));
  });
}

function ticketFieldsFromRow(row) {
  return {
    actualResult: row.actual_result ?? '',
    buildVersion: row.build_version ?? '',
    category: row.category ?? 'defect',
    environmentId: row.environment_id ?? null,
    expectedResult: row.expected_result ?? '',
    externalReviewState: row.external_review_state ?? 'not_external',
    fixedInReleaseId: row.fixed_in_release_id ?? null,
    foundInReleaseId: row.found_in_release_id ?? null,
    lastReopenedAt: toIsoString(row.last_reopened_at),
    reopenCount: Number(row.reopen_count ?? 0),
    reporterExternalId: row.reporter_external_id ?? null,
    reproSteps: row.repro_steps ?? '',
    severity: row.severity ?? 'S3',
  };
}

function childTaskTypeName(currentTaskTypeName) {
  if (currentTaskTypeName === 'Epic') {
    return 'Story';
  }

  if (currentTaskTypeName === 'Story') {
    return 'Task';
  }

  return null;
}

// Work run once a transaction commits, by the connection it runs on (afterCommit).
const afterCommitWork = new WeakMap();

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    afterCommitWork.set(connection, []);
    const result = await handler(connection);
    await connection.commit();
    for (const work of afterCommitWork.get(connection) ?? []) work();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    afterCommitWork.delete(connection);
    connection.release();
  }
}

/** Runs `work` once the transaction on `executor` commits, or now when there is none. */
function afterCommit(executor, work) {
  const queued = afterCommitWork.get(executor);
  if (queued) queued.push(work);
  else work();
}

/**
 * Listeners told of each work item revision once it is saved (and, on MySQL, committed), such as
 * assignment notifications (modules/notifications). A listener's failure never fails the save.
 */
function createRevisionObservers() {
  const listeners = new Set();
  return {
    emit(revision) {
      for (const listener of listeners) {
        Promise.resolve().then(() => listener(structuredClone(revision))).catch(() => {});
      }
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [tableName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [tableName, indexName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

export async function ensureMysqlProjectStatuses(executor) {
  const [rows] = await executor.execute(
    `
      SELECT id, project_status_name AS projectStatusName
      FROM project_statuses
      ORDER BY id
    `,
    [],
  );

  if (rows.length > 0) {
    return rows;
  }

  for (const status of CANONICAL_PROJECT_STATUSES) {
    await executor.execute(
      `
        INSERT INTO project_statuses (
          project_status_name,
          project_status_description
        ) VALUES (?, ?)
      `,
      [status, `${status} project status`],
    );
  }

  const [seededRows] = await executor.execute(
    `
      SELECT id, project_status_name AS projectStatusName
      FROM project_statuses
      ORDER BY id
    `,
    [],
  );

  return seededRows;
}

export async function ensureMysqlProjectTaskTypes(executor) {
  const [rows] = await executor.execute(
    `
      SELECT
        id,
        task_type_name AS taskTypeName,
        tenant_id AS tenantId,
        project_id AS projectId,
        deleted,
        sort_order AS sortOrder
      FROM task_types
      WHERE tenant_id IS NULL
        AND project_id IS NULL
      ORDER BY sort_order, id
    `,
    [],
  );

  const activeNames = new Set(
    rows
      .filter((row) => Number(row.deleted ?? 0) === 0)
      .map((row) => String(row.taskTypeName ?? '').trim())
      .filter(Boolean),
  );
  const missingNames = CANONICAL_TASK_TYPES.filter((taskTypeName) => !activeNames.has(taskTypeName));

  if (missingNames.length === 0) {
    return rows;
  }

  for (const [index, taskTypeName] of CANONICAL_TASK_TYPES.entries()) {
    if (activeNames.has(taskTypeName)) {
      continue;
    }

    await executor.execute(
      `
        INSERT INTO task_types (
          tenant_id,
          project_id,
          task_type_name,
          sort_order,
          deleted
        ) VALUES (?, ?, ?, ?, 0)
      `,
      [null, null, taskTypeName, index],
    );
  }

  const [seededRows] = await executor.execute(
    `
      SELECT
        id,
        task_type_name AS taskTypeName,
        tenant_id AS tenantId,
        project_id AS projectId,
        deleted,
        sort_order AS sortOrder
      FROM task_types
      WHERE tenant_id IS NULL
        AND project_id IS NULL
      ORDER BY sort_order, id
    `,
    [],
  );

  return seededRows;
}

export async function ensureMysqlProjectPlanningSchema(executor) {
  if (!await columnExists(executor, 'projects', 'rank')) {
    await executor.execute('ALTER TABLE projects ADD COLUMN `rank` INT NULL AFTER end_date');
  }

  if (!await tableExists(executor, 'project_sprints')) {
    await executor.execute(
      `
        CREATE TABLE project_sprints (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          project_id VARCHAR(36) NOT NULL,
          name VARCHAR(255) NOT NULL,
          goal MEDIUMTEXT NULL,
          sprint_status VARCHAR(32) NOT NULL DEFAULT 'planned',
          start_date DATE NULL,
          end_date DATE NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          deleted TINYINT(1) NOT NULL DEFAULT 0,
          INDEX idx_project_sprints_project (project_id),
          INDEX idx_project_sprints_status (sprint_status)
        )
      `,
    );
  }

  if (!await tableExists(executor, 'project_sprint_staffing')) {
    await executor.execute(
      `
        CREATE TABLE project_sprint_staffing (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          sprint_id VARCHAR(36) NOT NULL,
          user_id VARCHAR(36) NOT NULL,
          capacity_hours DECIMAL(10,2) NULL,
          allocation_pct_override INT NULL,
          notes TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_project_sprint_staffing_sprint (sprint_id),
          INDEX idx_project_sprint_staffing_user (user_id)
        )
      `,
    );
  }

  if (!await columnExists(executor, 'tasks', 'target_hour_estimate')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN target_hour_estimate INT NULL');
  }

  if (!await columnExists(executor, 'tasks', 'sprint_id')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN sprint_id VARCHAR(36) NULL');
  }

  if (!await columnExists(executor, 'tasks', 'sprint_sort_order')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN sprint_sort_order INT NULL');
  }

  if (!await columnExists(executor, 'tasks', 'board_sort_order')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN board_sort_order INT NULL');
  }

  if (!await columnExists(executor, 'tasks', 'source_clarification_ids')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN source_clarification_ids TEXT NULL');
  }
}

export async function ensureMysqlTicketingSchema(executor) {
  const ticketColumns = [
    ['category', 'VARCHAR(32) NULL'],
    ['severity', 'VARCHAR(4) NULL'],
    ['repro_steps', 'TEXT NULL'],
    ['expected_result', 'TEXT NULL'],
    ['actual_result', 'TEXT NULL'],
    ['environment_id', 'VARCHAR(36) NULL'],
    ['build_version', 'VARCHAR(120) NULL'],
    ['found_in_release_id', 'VARCHAR(36) NULL'],
    ['fixed_in_release_id', 'VARCHAR(36) NULL'],
    ['reporter_external_id', 'VARCHAR(128) NULL'],
    ['external_review_state', "VARCHAR(24) NOT NULL DEFAULT 'not_external'"],
  ];

  for (const [columnName, definition] of ticketColumns) {
    if (!await columnExists(executor, 'tasks', columnName)) {
      await executor.execute(`ALTER TABLE tasks ADD COLUMN ${columnName} ${definition}`);
    }
  }

  if (!await indexExists(executor, 'tasks', 'idx_tasks_ticket_triage')) {
    await executor.execute('CREATE INDEX idx_tasks_ticket_triage ON tasks (project_id, category, severity)');
  }

  if (!await indexExists(executor, 'tasks', 'idx_tasks_external_review')) {
    await executor.execute('CREATE INDEX idx_tasks_external_review ON tasks (external_review_state)');
  }

  if (!await tableExists(executor, 'work_item_relations')) {
    await executor.execute(`
      CREATE TABLE work_item_relations (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        from_item_id VARCHAR(36) NOT NULL,
        to_item_id VARCHAR(36) NOT NULL,
        relation_type VARCHAR(24) NOT NULL,
        created_by VARCHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_work_item_relation (from_item_id, to_item_id, relation_type),
        INDEX idx_work_item_relations_from (tenant_id, project_id, from_item_id),
        INDEX idx_work_item_relations_to (tenant_id, project_id, to_item_id)
      )
    `);
  }
}

export async function ensureMysqlTicketIntakeSchema(executor) {
  if (!await tableExists(executor, 'ticket_intake_invitations')) {
    await executor.execute(`
      CREATE TABLE ticket_intake_invitations (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        reporter_email VARCHAR(255) NOT NULL,
        reporter_name VARCHAR(160) NOT NULL,
        intake_token VARCHAR(120) NOT NULL,
        reply_token VARCHAR(120) NOT NULL,
        expires_at DATETIME(3) NULL,
        revoked_at DATETIME(3) NULL,
        submission_count INT NOT NULL DEFAULT 0,
        last_submitted_at DATETIME(3) NULL,
        created_by VARCHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_ticket_intake_token (intake_token),
        UNIQUE KEY uq_ticket_intake_reply_token (reply_token),
        KEY idx_ticket_intake_scope (tenant_id, project_id)
      )
    `);
  }
}

export const DEFAULT_TENANT_ENVIRONMENTS = ['Development', 'Staging', 'UAT', 'Production'];

export async function ensureMysqlTicketConfigSchema(executor) {
  for (const tableName of ['tenant_environments', 'tenant_releases']) {
    if (!await tableExists(executor, tableName)) {
      await executor.execute(`
        CREATE TABLE ${tableName} (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          project_id VARCHAR(36) NULL,
          name VARCHAR(160) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          status VARCHAR(16) NOT NULL DEFAULT 'active',
          version INT NOT NULL DEFAULT 1,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY uq_${tableName}_name (tenant_id, project_id, name),
          INDEX idx_${tableName}_tenant (tenant_id, status, sort_order)
        )
      `);
    }
  }
}

export async function ensureMysqlTenantEnvironmentDefaults(executor, tenantId) {
  if (!tenantId) {
    return [];
  }

  // Seed only a tenant that has no environments yet, so a default an admin renamed or
  // re-scoped does not reappear on the next read.
  const [existing] = await executor.execute(
    'SELECT id FROM tenant_environments WHERE tenant_id = ? LIMIT 1',
    [tenantId],
  );

  for (const [index, name] of DEFAULT_TENANT_ENVIRONMENTS.entries()) {
    if (existing.length > 0) {
      break;
    }

    await executor.execute(
      `INSERT INTO tenant_environments (id, tenant_id, project_id, name, sort_order, status, version, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'active', 1, NOW(3), NOW(3))`,
      [randomUUID(), tenantId, name, index],
    );
  }

  const [rows] = await executor.execute(
    'SELECT id, name, sort_order AS sortOrder, status, version FROM tenant_environments WHERE tenant_id = ? AND project_id IS NULL ORDER BY sort_order, name',
    [tenantId],
  );
  return rows;
}

export async function ensureMysqlProjectItemVersioningSchema(executor) {
  if (!await columnExists(executor, 'tasks', 'version')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER updated_at');
  }

  if (!await columnExists(executor, 'tasks', 'board_column')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN board_column VARCHAR(80) NULL');
  }

  if (!await tableExists(executor, 'project_item_revisions')) {
    await executor.execute(`
      CREATE TABLE project_item_revisions (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        item_id VARCHAR(36) NOT NULL,
        item_type VARCHAR(16) NOT NULL,
        action VARCHAR(16) NOT NULL,
        version_before INT NULL,
        version_after INT NOT NULL,
        before_json JSON NULL,
        after_json JSON NULL,
        actor_user_id VARCHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_project_item_revisions_item (tenant_id, project_id, item_id, created_at),
        INDEX idx_project_item_revisions_project (tenant_id, project_id, created_at)
      )
    `);
  }
}

export async function ensureMysqlProjectItemProgressSchema(executor) {
  if (!await columnExists(executor, 'tasks', 'percent_complete')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN percent_complete TINYINT UNSIGNED NULL');
  }
}

export async function ensureMysqlProjectItemActualHoursSchema(executor) {
  if (!await columnExists(executor, 'tasks', 'actual_hours')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN actual_hours DECIMAL(10,2) NULL');
  }
}

export async function ensureMysqlProjectItemEstimateOverrideSchema(executor) {
  if (!await columnExists(executor, 'tasks', 'estimate_override')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN estimate_override TINYINT(1) NOT NULL DEFAULT 0');
  }
}

// 0081_project_item_remaining_hours
export async function ensureMysqlProjectItemRemainingHoursSchema(executor) {
  if (!await columnExists(executor, 'tasks', 'remaining_hours')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN remaining_hours DECIMAL(10,2) NULL');
  }
}

// 0082_project_item_revision_actor: revisions by actors that are not users, such as
// `resource:<id>` (task access links) and `external:<id>` (ticket intake), which outgrow 36.
export async function ensureMysqlProjectItemRevisionActorSchema(executor) {
  const [rows] = await executor.execute(
    `
      SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'project_item_revisions'
        AND COLUMN_NAME = 'actor_user_id'
      LIMIT 1
    `,
  );
  if (!(Number(rows[0]?.maxLength) < 128)) return;
  await executor.execute('ALTER TABLE project_item_revisions MODIFY COLUMN actor_user_id VARCHAR(128) NOT NULL');
}

// 0083_comment_actor: comments by people without a login (`resource:<id>`). The legacy column is
// a char(36) foreign key to users.id, which refuses them at any length, so the key is dropped and
// the column widened, as audit_log's was (0059).
export async function ensureMysqlCommentActorSchema(executor) {
  if (!await tableExists(executor, 'comments')) return;
  const [foreignKeys] = await executor.execute(
    `
      SELECT CONSTRAINT_NAME AS name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'comments'
        AND COLUMN_NAME = 'user_id'
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `,
  );
  for (const { name } of foreignKeys) {
    if (name) await executor.execute(`ALTER TABLE comments DROP FOREIGN KEY \`${String(name).replace(/`/g, '``')}\``);
  }
  const [rows] = await executor.execute(
    `
      SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'comments'
        AND COLUMN_NAME = 'user_id'
      LIMIT 1
    `,
  );
  if (!(Number(rows[0]?.maxLength) < 128)) return;
  await executor.execute('ALTER TABLE comments MODIFY COLUMN user_id VARCHAR(128) NOT NULL');
}

// The item tracking columns of migrations 0050, 0058, 0060 and 0081, each registered on its own.
async function ensureMysqlProjectItemTrackingSchema(executor) {
  await ensureMysqlProjectItemProgressSchema(executor);
  await ensureMysqlProjectItemActualHoursSchema(executor);
  await ensureMysqlProjectItemEstimateOverrideSchema(executor);
  await ensureMysqlProjectItemRemainingHoursSchema(executor);
}

export function createMysqlProjectsRepository({ fileScanner, fileStorage, frontendAppUrl = '', mailRepository, pool }) {
  const revisionObservers = createRevisionObservers();
  const storage = fileStorage ?? {
    async delete() {},
    async read() {
      return {
        bytes: Buffer.alloc(0),
        size: 0,
      };
    },
    async write() {},
  };
  const scanner = fileScanner && typeof fileScanner.scanBytes === 'function'
    ? fileScanner
    : {
        enabled: false,
        async scanBytes() {
          return { clean: true, scanner: 'noop' };
        },
      };

  async function upsertProjectPreference(executor, { key, projectId, tenantId, userId, value }) {
    const [rows] = await executor.execute(
      `
        SELECT id
        FROM preferences
        WHERE \`key\` = ?
          AND tenant_id = ?
          AND user_id = ?
          AND project_id = ?
        LIMIT 1
      `,
      [key, tenantId, userId, projectId],
    );

    if (rows[0]?.id) {
      await executor.execute(
        'UPDATE preferences SET value = ?, updated_at = NOW() WHERE id = ?',
        [value, rows[0].id],
      );
      return rows[0].id;
    }

    const id = randomUUID();
    await executor.execute(
      `
        INSERT INTO preferences (id, tenant_id, user_id, project_id, \`key\`, \`value\`, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `,
      [id, tenantId, userId, projectId, key, value],
    );

    return id;
  }

  async function listMySqlSprintRows(executor, projectId) {
    const [rows] = await executor.execute(
      `
        SELECT
          id,
          project_id AS projectId,
          name,
          goal,
          sprint_status AS status,
          start_date AS startDate,
          end_date AS endDate,
          sort_order AS sortOrder
        FROM project_sprints
        WHERE project_id = ?
          AND deleted = 0
        ORDER BY sort_order ASC, created_at ASC
      `,
      [projectId],
    );

    return rows.map((row) => normalizeSprint(row, projectId));
  }

  async function listMySqlSprintStaffing(executor, sprintId) {
    const [rows] = await executor.execute(
      `
        SELECT
          sprint_id AS sprintId,
          user_id AS userId,
          capacity_hours AS capacityHours,
          allocation_pct_override AS allocationPctOverride,
          notes
        FROM project_sprint_staffing
        WHERE sprint_id = ?
        ORDER BY updated_at ASC, created_at ASC
      `,
      [sprintId],
    );

    return rows.map((row) => normalizeSprintStaffingEntry(row, sprintId));
  }

  async function listMySqlProjectMembers(executor, projectId, tenantId) {
    const [rows] = await executor.execute(
      `
        SELECT
          u.id,
          u.name,
          u.email,
          up.role,
          up.project_bill_rate AS projectBillRate,
          up.project_allocation AS projectAllocation,
          ut.default_bill_rate AS defaultBillRate,
          ut.min_bill_rate AS minBillRate
        FROM user_project up
        INNER JOIN users u ON u.id = up.user_id
        LEFT JOIN user_tenant ut
          ON ut.user_id = u.id
          AND ut.tenant_id = ?
        WHERE up.project_id = ?
        ORDER BY u.name ASC
      `,
      [tenantId, projectId],
    );

    return rows.map((row) => ({
      defaultBillRate: row.defaultBillRate ?? null,
      email: row.email ?? '',
      id: row.id,
      minBillRate: row.minBillRate ?? null,
      name: row.name ?? '',
      projectAllocation: row.projectAllocation ?? null,
      projectBillRate: row.projectBillRate ?? null,
      role: row.role ?? 'user',
    }));
  }

  async function getNextMySqlSprintSortOrder(executor, projectId, sprintId) {
    const [rows] = sprintId == null
      ? await executor.execute(
          `
            SELECT COALESCE(MAX(sprint_sort_order), -1) AS maxOrder
            FROM tasks
            WHERE project_id = ?
              AND deleted = 0
              AND sprint_id IS NULL
          `,
          [projectId],
        )
      : await executor.execute(
          `
            SELECT COALESCE(MAX(sprint_sort_order), -1) AS maxOrder
            FROM tasks
            WHERE project_id = ?
              AND deleted = 0
              AND sprint_id = ?
          `,
          [projectId, sprintId],
        );

    return Number(rows[0]?.maxOrder ?? -1) + 1;
  }

  async function readMySqlKanbanRanks(executor, projectId) {
    const [rows] = await executor.execute(
      'SELECT id, board_sort_order FROM tasks WHERE project_id = ? AND deleted = 0 AND board_sort_order IS NOT NULL',
      [projectId],
    );
    return new Map(rows.map((row) => [row.id, Number(row.board_sort_order)]));
  }

  async function buildMySqlSprintPlanningPayload(executor, projectId, tenantId, { scope = 'delivery' } = {}) {
    const project = await getProjectDetail(executor, { includePursuit: scope === BOARD_SCOPE_PURSUIT, projectId, tenantId });

    if (!project) {
      return null;
    }

    const items = buildPlanningItems(project, { scope });
    const members = await listMySqlProjectMembers(executor, projectId, tenantId);
    const sprintRows = await listMySqlSprintRows(executor, projectId);
    const sprints = [];

    for (const sprint of sprintRows) {
      const staffing = await listMySqlSprintStaffing(executor, sprint.id);
      const sprintItems = items.filter((item) => item.sprintId === sprint.id);
      sprints.push({
        ...sprint,
        items: sortPlanningItemsByOrder(sprintItems),
        staffing,
        summary: buildPlanningSummary(sprintItems, staffing),
      });
    }

    const backlogItems = items.filter((item) => item.sprintId == null);

    return {
      backlog: {
        items: sortPlanningItemsByOrder(backlogItems),
        summary: buildPlanningSummary(backlogItems, []),
      },
      members,
      project,
      sprints,
    };
  }

  async function queueMentionEmailsMysql({ html, projectId, skipUserIds = [], targetId, targetType, tenantId, userId }) {
    if (!mailRepository || typeof mailRepository.queueMail !== 'function') {
      return;
    }

    const spans = extractMentionSpans(html).filter((span) => !skipUserIds.includes(span.userId));
    if (spans.length === 0) {
      return;
    }

    const [projectRows] = await pool.execute(
      'SELECT id, name FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
      [projectId, tenantId],
    );
    const projectName = projectRows[0]?.name ?? 'Project';

    const [commenterRows] = await pool.execute(
      'SELECT id, name, email, timezone FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    const commenter = commenterRows[0]
      ? {
          id: commenterRows[0].id,
          name: commenterRows[0].name ?? 'Unknown user',
          email: commenterRows[0].email ?? '',
          timezone: commenterRows[0].timezone ?? 'UTC',
        }
      : { id: userId, name: 'Unknown user', email: '', timezone: 'UTC' };

    async function resolveTargetNames() {
      if (!targetType || targetType === 'project') {
        return { epicName: null, storyName: null, taskName: null };
      }

      if (targetType === 'epic') {
        const [rows] = await pool.execute(
          'SELECT name FROM tasks WHERE id = ? AND project_id = ? AND deleted = 0 LIMIT 1',
          [targetId, projectId],
        );
        return { epicName: rows[0]?.name ?? null, storyName: null, taskName: null };
      }

      if (targetType === 'story') {
        const [rows] = await pool.execute(
          'SELECT name, parent_task_id AS parentTaskId FROM tasks WHERE id = ? AND project_id = ? AND deleted = 0 LIMIT 1',
          [targetId, projectId],
        );
        const storyName = rows[0]?.name ?? null;
        const epicId = rows[0]?.parentTaskId ?? null;
        let epicName = null;

        if (epicId) {
          const [epicRows] = await pool.execute(
            'SELECT name FROM tasks WHERE id = ? AND project_id = ? AND deleted = 0 LIMIT 1',
            [epicId, projectId],
          );
          epicName = epicRows[0]?.name ?? null;
        }

        return { epicName, storyName, taskName: null };
      }

      if (targetType === 'task') {
        const [taskRows] = await pool.execute(
          'SELECT name, parent_task_id AS parentTaskId FROM tasks WHERE id = ? AND project_id = ? AND deleted = 0 LIMIT 1',
          [targetId, projectId],
        );
        const taskName = taskRows[0]?.name ?? null;
        const storyId = taskRows[0]?.parentTaskId ?? null;
        let storyName = null;
        let epicName = null;

        if (storyId) {
          const [storyRows] = await pool.execute(
            'SELECT name, parent_task_id AS parentTaskId FROM tasks WHERE id = ? AND project_id = ? AND deleted = 0 LIMIT 1',
            [storyId, projectId],
          );
          storyName = storyRows[0]?.name ?? null;
          const epicId = storyRows[0]?.parentTaskId ?? null;

          if (epicId) {
            const [epicRows] = await pool.execute(
              'SELECT name FROM tasks WHERE id = ? AND project_id = ? AND deleted = 0 LIMIT 1',
              [epicId, projectId],
            );
            epicName = epicRows[0]?.name ?? null;
          }
        }

        return { epicName, storyName, taskName };
      }

      return { epicName: null, storyName: null, taskName: null };
    }

    const names = await resolveTargetNames();
    const optOuts = await findEmailOptOuts({ kind: 'mentions', read: (query) => readUserPreferencesMysql(pool, query), userIds: spans.map((span) => span.userId) });

    for (const span of spans) {
      if (isOptedOut(optOuts, { userId: span.userId })) {
        continue;
      }
      // Only people in the project's workspace: a span can name any user id.
      const [mentionedRows] = await pool.execute(
        'SELECT u.id, u.name, u.email FROM users u INNER JOIN user_tenant ut ON ut.user_id = u.id AND ut.tenant_id = ? WHERE u.id = ? LIMIT 1',
        [tenantId, span.userId],
      );
      const mentioned = mentionedRows[0];

      if (!mentioned?.email) {
        continue;
      }

      const target = {
        ...names,
        fullSpan: span.fullSpan,
        id: targetId,
        type: targetType,
      };

      const mention = buildMentionNotification({
        commenter,
        frontendAppUrl,
        html,
        mentionedUser: {
          email: mentioned.email,
          id: mentioned.id,
          name: mentioned.name ?? 'Unknown user',
        },
        project: {
          id: projectId,
          name: projectName,
        },
        target,
      });

      await queueMentionEmail({
        mailRepository,
        mention,
        targetId,
      });
    }
  }

  async function safeQueueMentionEmailsMysql(args) {
    try {
      await queueMentionEmailsMysql(args);
    } catch (error) {
      logBackendError({
        context: buildOperationLogContext('projects.queueMentionEmails', {
          mentionCount: Array.isArray(args?.mentions) ? args.mentions.length : null,
          projectId: args?.projectId ?? null,
          targetId: args?.targetId ?? null,
          targetType: args?.targetType ?? null,
        }),
        error,
        level: 'warn',
        message: 'Mention email queue failed.',
      });
    }
  }
  async function getTaskTypeIds(executor, tenantId, projectId) {
    await ensureOnce(pool, ensureMysqlProjectTaskTypes, executor);
    const [rows] = await executor.execute(
      `
        SELECT id, task_type_name AS taskTypeName, tenant_id AS tenantId, project_id AS projectId, deleted
        FROM task_types
        WHERE (tenant_id IS NULL AND project_id IS NULL)
           OR (tenant_id = ? AND project_id IS NULL)
           OR (project_id = ?)
        ORDER BY sort_order
      `,
      [tenantId, projectId],
    );
    const [referencedRows] = await executor.execute(
      'SELECT DISTINCT task_type AS taskTypeId FROM tasks WHERE project_id = ?',
      [projectId],
    );
    const referencedIds = new Set(referencedRows.map((row) => row.taskTypeId));
    const taskTypeIds = {};

    for (const row of rows) {
      const include = Number(row.deleted) === 0 || referencedIds.has(row.id);

      if (include && !taskTypeIds[row.taskTypeName]) {
        taskTypeIds[row.taskTypeName] = row.id;
      }
    }

    return taskTypeIds;
  }

  async function getTaskStatusIds(executor, tenantId, projectId) {
    const [rows] = await executor.execute(
      `
        SELECT id, task_status_name AS taskStatusName, tenant_id AS tenantId, project_id AS projectId, deleted
        FROM task_statuses
        WHERE (tenant_id IS NULL AND project_id IS NULL)
           OR (tenant_id = ? AND project_id IS NULL)
           OR (project_id = ?)
        ORDER BY sort_order
      `,
      [tenantId, projectId],
    );
    const taskStatusIds = {};

    for (const row of rows) {
      if (Number(row.deleted ?? 0) !== 0) {
        continue;
      }

      if (row.taskStatusName && !taskStatusIds[row.taskStatusName]) {
        taskStatusIds[row.taskStatusName] = row.id;
      }
    }

    return taskStatusIds;
  }

  async function getTaskStatus(executor, taskId) {
    const [rows] = await executor.execute(
      `
        SELECT log_data AS logData
        FROM task_log
        WHERE task_id = ?
          AND log_action = 'status_change'
        ORDER BY log_date DESC, id DESC
        LIMIT 1
      `,
      [taskId],
    );

    if (!rows[0]?.logData) {
      return 'Not Started';
    }

    const logData = JSON.parse(rows[0].logData);
    return logData.status ?? 'Not Started';
  }

  async function getTaskAssignee(executor, taskId) {
    const [rows] = await executor.execute(
      `
        SELECT log_data AS logData
        FROM task_log
        WHERE task_id = ?
          AND log_action = 'assign'
        ORDER BY log_date DESC, id DESC
        LIMIT 1
      `,
      [taskId],
    );

    if (!rows[0]?.logData) {
      return {
        assigneeId: null,
        assigneeName: '',
      };
    }

    const logData = JSON.parse(rows[0].logData);
    const userId = logData.assigned_to ?? null;

    if (!userId) {
      return {
        assigneeId: null,
        assigneeName: '',
      };
    }

    const resourceOwners = await loadResourceAssignees(executor, [userId]);
    const resourceOwner = resourceOwners.get(String(userId));
    if (resourceOwner && !resourceOwner.userId) return { assigneeId: userId, assigneeName: resourceOwner.name };
    const ownerId = resourceOwner?.userId ?? userId;
    const [userRows] = await executor.execute('SELECT id, name FROM users WHERE id = ? LIMIT 1', [ownerId]);

    return {
      assigneeId: userRows[0]?.id ?? ownerId,
      assigneeName: userRows[0]?.name ?? '',
    };
  }

  // Work owned by a resource is stored as `resource:<id>`. A resource linked to a login owns its
  // work as that user, so linking a resource later hands them everything it already owns.
  async function loadResourceAssignees(executor, assigneeIds) {
    const resourceIds = [...new Set(assigneeIds.map(resourceIdFromAssignee).filter(Boolean))];
    const owners = new Map();
    if (!resourceIds.length) return owners;
    try {
      const [rows] = await executor.execute(
        `SELECT id, name, user_id FROM enterprise_resources WHERE id IN (${resourceIds.map(() => '?').join(', ')})`,
        resourceIds,
      );
      for (const row of rows) owners.set(`resource:${row.id}`, { name: row.name, userId: row.user_id ?? null });
    } catch (error) {
      if (error?.code !== 'ER_NO_SUCH_TABLE') throw error;
    }
    return owners;
  }

  // Loads a project's item rows with each item's latest status and assignee in four queries,
  // so building the tree no longer costs several queries per item. The lookups match
  // getTaskStatus and getTaskAssignee, which still serve single-item reads. log_date has
  // one-second precision, so same-second entries fall back to the MySQL UUID() id, which
  // sorts in creation order within a second.
  async function loadProjectItemLookup(executor, projectId) {
    const [rows] = await executor.execute(
      'SELECT * FROM tasks WHERE project_id = ? AND deleted = 0 ORDER BY sort_order, id',
      [projectId],
    );
    const key = (value) => String(value ?? '').toLowerCase();
    const latestLogData = async (action) => {
      const [logRows] = await executor.execute(
        `
          SELECT ranked.taskId, ranked.logData
          FROM (
            SELECT
              l.task_id AS taskId,
              l.log_data AS logData,
              ROW_NUMBER() OVER (PARTITION BY l.task_id ORDER BY l.log_date DESC, l.id DESC) AS position
            FROM task_log l
            INNER JOIN tasks t ON t.id = l.task_id
            WHERE t.project_id = ?
              AND t.deleted = 0
              AND l.log_action = ?
          ) ranked
          WHERE ranked.position = 1
        `,
        [projectId, action],
      );
      return new Map(logRows.map((row) => [key(row.taskId), row.logData]));
    };
    const statusLogs = await latestLogData('status_change');
    const assignLogs = await latestLogData('assign');

    const assignedUserIds = new Map();
    for (const [taskId, logData] of assignLogs) {
      if (logData) assignedUserIds.set(taskId, JSON.parse(logData).assigned_to ?? null);
    }
    const assigneeIds = [...new Set([...assignedUserIds.values()].filter(Boolean))];
    const resourceOwners = await loadResourceAssignees(executor, assigneeIds);
    const userIds = [...new Set(assigneeIds.map((id) => (resourceOwners.has(id) ? resourceOwners.get(id).userId : id)).filter(Boolean))];
    const usersById = new Map();
    if (userIds.length > 0) {
      const [userRows] = await executor.execute(
        `SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`,
        userIds,
      );
      for (const user of userRows) usersById.set(key(user.id), user);
    }

    const rowsByTypeAndParent = new Map();
    const rowsByType = new Map();
    for (const row of rows) {
      const groupKey = `${row.task_type}:${key(row.parent_task_id)}`;
      rowsByTypeAndParent.set(groupKey, [...(rowsByTypeAndParent.get(groupKey) ?? []), row]);
      rowsByType.set(String(row.task_type), [...(rowsByType.get(String(row.task_type)) ?? []), row]);
    }

    return {
      assigneeOf(taskId) {
        const userId = assignedUserIds.get(key(taskId)) ?? null;
        if (!userId) return { assigneeId: null, assigneeName: '' };
        const resourceOwner = resourceOwners.get(String(userId));
        if (resourceOwner && !resourceOwner.userId) return { assigneeId: userId, assigneeName: resourceOwner.name };
        const ownerId = resourceOwner?.userId ?? userId;
        const user = usersById.get(key(ownerId));
        return { assigneeId: user?.id ?? ownerId, assigneeName: user?.name ?? '' };
      },
      childrenOf(taskTypeId, parentId = null) {
        return rowsByTypeAndParent.get(`${taskTypeId}:${key(parentId)}`) ?? [];
      },
      rowsOfType(taskTypeId) {
        return rowsByType.get(String(taskTypeId)) ?? [];
      },
      statusOf(taskId) {
        const logData = statusLogs.get(key(taskId));
        return logData ? JSON.parse(logData).status ?? 'Not Started' : 'Not Started';
      },
    };
  }

  function buildTaskTree(lookup, taskTypeIds, task, currentTaskTypeName) {
    const status = lookup.statusOf(task.id);
    const assignee = lookup.assigneeOf(task.id);
    const childTypeName = childTaskTypeName(currentTaskTypeName);
    const taskData = {
      actualHours: normalizeActualHours(task.actual_hours),
      estimateOverride: estimateOverrideFlag(task.estimate_override) === 1,
      assigneeId: assignee.assigneeId,
      assigneeName: assignee.assigneeName,
      boardColumn: task.board_column ?? null,
      description: normalizeStoredRichTextMarkdown(task.description ?? ''),
      id: task.id,
      name: task.name,
      percentComplete: normalizePercentComplete(task.percent_complete),
      points: task.points != null ? Number(task.points) : null,
      priority: task.priority != null ? Number(task.priority) : 4,
      progress: 0,
      remainingHours: normalizeRemainingHours(task.remaining_hours),
      sprintId: task.sprint_id ?? null,
      sprintSortOrder: task.sprint_sort_order != null ? Number(task.sprint_sort_order) : null,
      status,
      sourceClarificationIds: safeJsonParse(task.source_clarification_ids, []),
      targetEndDate: dateOnlyValue(task.target_end_date),
      targetHourEstimate: task.target_hour_estimate != null ? Number(task.target_hour_estimate) : null,
      targetStartDate: dateOnlyValue(task.target_start_date),
      updatedAt: toIsoString(task.updated_at),
      version: Number(task.version ?? 1),
      ...(Number(task.pursuit) === 1 ? { pursuit: true } : {}),
    };

    const progressLevel = String(currentTaskTypeName ?? '').toLowerCase();

    if (!childTypeName || !taskTypeIds[childTypeName]) {
      taskData.progress = workProgressPercent(progressLevel, taskData);
      return taskData;
    }

    const childKey = currentTaskTypeName === 'Epic' ? 'stories' : 'tasks';
    taskData[childKey] = lookup.childrenOf(taskTypeIds[childTypeName], task.id)
      .map((childTask) => buildTaskTree(lookup, taskTypeIds, childTask, childTypeName));
    applyChildEstimates(taskData, taskData[childKey]);
    taskData.progress = workProgressPercent(progressLevel, taskData);

    return taskData;
  }

  async function getProjectStatusId(executor, statusValue) {
    const rows = await ensureMysqlProjectStatuses(executor);
    try {
      return resolveStoredProjectStatusRow(rows, statusValue).id;
    } catch (error) {
      // Status tables seeded before Review and Archived existed lack those rows; add a
      // canonical status the first time a project uses it.
      if (!isCanonicalProjectStatus(statusValue)) throw error;
      const status = normalizeProjectStatusForDisplay(statusValue);
      const [result] = await executor.execute(
        'INSERT INTO project_statuses (project_status_name, project_status_description) VALUES (?, ?)',
        [status, `${status} project status`],
      );
      return result.insertId;
    }
  }

  async function insertTaskLog(executor, taskId, action, data) {
    await executor.execute(
      `
        INSERT INTO task_log (id, task_id, log_action, log_data, log_date)
        VALUES (UUID(), ?, ?, ?, NOW())
      `,
      [taskId, action, JSON.stringify(data)],
    );
  }

  async function upsertTaskNode(executor, {
    parentTaskId,
    projectId,
    sortOrder,
    task,
    taskTypeId,
  }) {
    const requestedTaskId = String(task?.id ?? '').trim();
    const [rows] = requestedTaskId
      ? await executor.execute(
          'SELECT id FROM tasks WHERE id = ? AND project_id = ? LIMIT 1',
          [requestedTaskId, projectId],
        )
      : [[]];
    const taskId = rows[0]?.id ?? randomUUID();

    const params = [
      projectId,
      taskTypeId,
      parentTaskId,
      task.name,
      normalizeStoredRichTextMarkdown(task.description ?? ''),
      task.priority ?? 4,
      task.points ?? null,
      task.targetStartDate ?? null,
      task.targetEndDate ?? null,
      task.targetHourEstimate ?? null,
      Array.isArray(task.sourceClarificationIds) && task.sourceClarificationIds.length > 0
        ? JSON.stringify(task.sourceClarificationIds.map((value) => String(value ?? '').trim()).filter(Boolean))
        : null,
      task.sprintId ?? null,
      task.sprintSortOrder ?? null,
      sortOrder,
    ];

    if (rows[0]?.id) {
      // Tree writers that do not carry tracking fields (assistant commits) keep the stored values.
      const tracking = [
        ['percent_complete', task.percentComplete, normalizePercentComplete],
        ['actual_hours', task.actualHours, normalizeActualHours],
        ['estimate_override', task.estimateOverride, estimateOverrideFlag],
        ['remaining_hours', task.remainingHours, normalizeRemainingHours],
      ].filter(([, value]) => value !== undefined);
      await executor.execute(
        `
          UPDATE tasks SET
            project_id = ?,
            task_type = ?,
            parent_task_id = ?,
            name = ?,
            description = ?,
            priority = ?,
            points = ?,
            target_start_date = ?,
            target_end_date = ?,
            target_hour_estimate = ?,
            source_clarification_ids = ?,
            sprint_id = ?,
            sprint_sort_order = ?,
            sort_order = ?,${tracking.map(([column]) => `\n            ${column} = ?,`).join('')}
            updated_at = NOW(),
            version = version + 1,
            deleted = 0
          WHERE id = ?
        `,
        [...params, ...tracking.map(([, value, normalize]) => normalize(value)), taskId],
      );
    } else {
      await executor.execute(
        `
          INSERT INTO tasks (
            id,
            project_id,
            task_type,
            parent_task_id,
            name,
            description,
            priority,
            points,
            target_start_date,
            target_end_date,
            target_hour_estimate,
            source_clarification_ids,
            sprint_id,
            sprint_sort_order,
            sort_order,
            percent_complete,
            actual_hours,
            estimate_override,
            remaining_hours,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [taskId, ...params, normalizePercentComplete(task.percentComplete), normalizeActualHours(task.actualHours), estimateOverrideFlag(task.estimateOverride), normalizeRemainingHours(task.remainingHours)],
      );
    }

    await insertTaskLog(executor, taskId, 'assign', {
      assigned_to: task.assigneeId ?? null,
    });
    await insertTaskLog(executor, taskId, 'status_change', {
      status: task.status ?? 'Not Started',
    });

    return taskId;
  }

  // savedIds, when given, maps each node's id to the id it was saved under: a new node gets a fresh
  // one, since an incoming id is never trusted for an insert.
  async function upsertTaskNodes(executor, {
    parentTaskId,
    projectId,
    retainedIds,
    savedIds = null,
    taskNodes,
    taskTypeIds,
    taskTypeName,
  }) {
    const taskTypeId = taskTypeIds[taskTypeName];

    if (!taskTypeId) {
      throw new Error(`Task type ${taskTypeName} is not configured for project ${projectId}.`);
    }

    const childKey = taskTypeName === 'Epic' ? 'stories' : taskTypeName === 'Story' ? 'tasks' : null;
    const childTypeName = childTaskTypeName(taskTypeName);

    for (const [index, task] of taskNodes.entries()) {
      const taskId = await upsertTaskNode(executor, {
        parentTaskId,
        projectId,
        sortOrder: index,
        task,
        taskTypeId,
      });
      retainedIds.add(taskId);
      if (savedIds && task?.id) savedIds.set(task.id, taskId);

      if (childKey && childTypeName) {
        await upsertTaskNodes(executor, {
          parentTaskId: taskId,
          projectId,
          retainedIds,
          savedIds,
          taskNodes: task[childKey] ?? [],
          taskTypeIds,
          taskTypeName: childTypeName,
        });
      }
    }
  }

  // Deletes the epics, stories and tasks a tree save left out. Tickets share the table but not the
  // tree, so they are never swept: a save or split would otherwise delete every ticket.
  async function markRemovedTasksDeleted(executor, projectId, retainedIds) {
    const [rows] = await executor.execute(
      // The plan never holds pursuit work, so a tree it saves leaves pursuit items alone.
      `SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.deleted = 0 AND t.pursuit = 0
         AND NOT EXISTS (SELECT 1 FROM task_types tt WHERE tt.id = t.task_type AND tt.task_type_name = 'Ticket')`,
      [projectId],
    );

    for (const row of rows) {
      if (retainedIds.has(row.id)) {
        continue;
      }

      await executor.execute(
        'UPDATE tasks SET deleted = 1, updated_at = NOW(), version = version + 1 WHERE id = ?',
        [row.id],
      );
      await insertTaskLog(executor, row.id, 'deleted', {
        deleted: true,
      });
    }
  }

  // Delivery work only, unless includePursuit (src/lib/projects/pursuit.js).
  async function getProjectDetail(executor, { includePursuit = false, projectId, tenantId }) {
    const [projectRows] = await executor.execute(
      `
        SELECT
          p.id,
          p.tenant_id AS tenantId,
          p.name,
          p.description,
          ps.project_status_name AS status,
          p.start_date AS startDate,
          p.end_date AS endDate,
          p.\`rank\` AS \`rank\`,
          p.updated_at AS updatedAt,
          p.created_at AS createdAt,
          ${engagementColumnsSql('p')}
        FROM projects p
        INNER JOIN project_statuses ps ON ps.id = p.project_status
        WHERE p.id = ?
          AND p.tenant_id = ?
          AND ${activeProjectSql('p')}
        LIMIT 1
      `,
      [projectId, tenantId],
    );

    if (!projectRows[0]) {
      return null;
    }

    const taskTypeIds = await getTaskTypeIds(executor, tenantId, projectId);
    const project = {
      createdAt: toIsoString(projectRows[0].createdAt),
      description: normalizeStoredRichTextMarkdown(projectRows[0].description ?? ''),
      endDate: dateOnlyValue(projectRows[0].endDate),
      epics: [],
      id: projectRows[0].id,
      name: projectRows[0].name,
      rank: projectRows[0].rank != null ? Number(projectRows[0].rank) : null,
      startDate: dateOnlyValue(projectRows[0].startDate),
      status: normalizeProjectStatusForDisplay(projectRows[0].status),
      tenantId: projectRows[0].tenantId,
      tickets: [],
      updatedAt: toIsoString(projectRows[0].updatedAt),
      ...engagementFieldsFromRow(projectRows[0]),
    };

    const lookup = await loadProjectItemLookup(executor, projectId);
    project.tickets = buildProjectTickets(lookup, taskTypeIds);

    if (!taskTypeIds.Epic) {
      return project;
    }

    project.epics = lookup.childrenOf(taskTypeIds.Epic, null)
      .map((epic) => buildTaskTree(lookup, taskTypeIds, epic, 'Epic'));

    return includePursuit ? project : withoutPursuitWork(project);
  }

  // Sets an item's pursuit marker from its parent's, and a story's tasks' from the story, so a
  // task or story moved in or out of pursuit work is marked as where it now sits. Epics and
  // tickets keep theirs.
  async function syncMysqlPursuitMarker(executor, { itemId, projectId }) {
    const [rows] = await executor.execute(
      `SELECT tt.task_type_name AS itemType, parent.pursuit AS parentPursuit
       FROM tasks t
       INNER JOIN task_types tt ON tt.id = t.task_type
       LEFT JOIN tasks parent ON parent.id = t.parent_task_id
       WHERE t.id = ? AND t.project_id = ? LIMIT 1`,
      [itemId, projectId],
    );
    const itemType = String(rows[0]?.itemType ?? '').toLowerCase();
    if (!['story', 'task'].includes(itemType)) return;
    const pursuit = Number(rows[0].parentPursuit) === 1 ? 1 : 0;
    await executor.execute('UPDATE tasks SET pursuit = ? WHERE id = ? AND project_id = ?', [pursuit, itemId, projectId]);
    if (itemType === 'story') {
      await executor.execute(
        `UPDATE tasks SET pursuit = ? WHERE parent_task_id = ? AND project_id = ?
           AND task_type IN (SELECT id FROM task_types WHERE task_type_name = 'Task')`,
        [pursuit, itemId, projectId],
      );
    }
  }

  // Tickets are a flat project-level collection rather than tree nodes.
  // A ticket's parentId may point at any epic/story/task or be null; it never nests.
  function buildProjectTickets(lookup, taskTypeIds) {
    if (!taskTypeIds.Ticket) {
      return [];
    }

    const rows = lookup.rowsOfType(taskTypeIds.Ticket);
    const tickets = [];

    for (const row of rows) {
      const status = lookup.statusOf(row.id);
      const assignee = lookup.assigneeOf(row.id);
      tickets.push({
        actualHours: normalizeActualHours(row.actual_hours),
        assigneeId: assignee.assigneeId,
        assigneeName: assignee.assigneeName,
        boardColumn: row.board_column ?? null,
        description: normalizeStoredRichTextMarkdown(row.description ?? ''),
        id: row.id,
        name: row.name,
        parentId: row.parent_task_id ?? null,
        percentComplete: normalizePercentComplete(row.percent_complete),
        points: row.points != null ? Number(row.points) : null,
        priority: row.priority != null ? Number(row.priority) : 4,
        progress: workProgressPercent('ticket', { percentComplete: row.percent_complete, status }),
        remainingHours: normalizeRemainingHours(row.remaining_hours),
        sprintId: row.sprint_id ?? null,
        sprintSortOrder: row.sprint_sort_order != null ? Number(row.sprint_sort_order) : null,
        status,
        targetEndDate: dateOnlyValue(row.target_end_date),
        targetHourEstimate: row.target_hour_estimate != null ? Number(row.target_hour_estimate) : null,
        targetStartDate: dateOnlyValue(row.target_start_date),
        updatedAt: toIsoString(row.updated_at),
        version: Number(row.version ?? 1),
        ...ticketFieldsFromRow(row),
      });
    }

    return tickets;
  }

  async function getMysqlProjectItemRow(executor, { forUpdate = false, itemId, projectId, tenantId }) {
    const [rows] = await executor.execute(
      `
        SELECT
          t.*,
          tt.task_type_name AS item_type
        FROM tasks t
        INNER JOIN projects p ON p.id = t.project_id
        INNER JOIN task_types tt ON tt.id = t.task_type
        WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?
        LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}
      `,
      [itemId, projectId, tenantId],
    );
    return rows[0] ?? null;
  }

  async function mysqlProjectItemSnapshot(executor, row) {
    if (!row) return null;
    const status = await getTaskStatus(executor, row.id);
    const assignee = await getTaskAssignee(executor, row.id);
    const itemType = String(row.item_type ?? '').toLowerCase();
    return {
      itemType,
      node: {
        actualHours: normalizeActualHours(row.actual_hours),
        estimateOverride: estimateOverrideFlag(row.estimate_override) === 1,
        assigneeId: assignee.assigneeId,
        assigneeName: assignee.assigneeName,
        boardColumn: row.board_column ?? null,
        description: normalizeStoredRichTextMarkdown(row.description ?? ''),
        id: row.id,
        name: row.name,
        percentComplete: normalizePercentComplete(row.percent_complete),
        points: row.points == null ? null : Number(row.points),
        priority: row.priority == null ? 4 : Number(row.priority),
        remainingHours: normalizeRemainingHours(row.remaining_hours),
        sprintId: row.sprint_id ?? null,
        sprintSortOrder: row.sprint_sort_order == null ? null : Number(row.sprint_sort_order),
        status,
        sourceClarificationIds: safeJsonParse(row.source_clarification_ids, []),
        targetEndDate: dateOnlyValue(row.target_end_date),
        targetHourEstimate: row.target_hour_estimate == null ? null : Number(row.target_hour_estimate),
        targetStartDate: dateOnlyValue(row.target_start_date),
        updatedAt: toIsoString(row.updated_at),
        version: Number(row.version ?? 1),
        ...(itemType === 'ticket' ? ticketFieldsFromRow(row) : {}),
      },
      parentId: row.parent_task_id ?? null,
      position: Number(row.sort_order ?? 0),
    };
  }

  async function requireMysqlProjectItemParent(executor, { itemType, parentId, projectId, tenantId }) {
    if (itemType === 'epic') {
      if (parentId) throw new HttpError(400, 'Epics cannot have a parent item.');
      return null;
    }
    if (itemType === 'ticket') {
      // Tickets may hang off any work item or directly off the project.
      if (!parentId) return null;
      const row = await getMysqlProjectItemRow(executor, { itemId: parentId, projectId, tenantId });
      if (!row || row.deleted || !['epic', 'story', 'task'].includes(String(row.item_type ?? '').toLowerCase())) {
        throw new HttpError(400, 'Tickets require an existing epic, story, or task parent when a parent is set.');
      }
      return row;
    }
    if (!parentId) throw new HttpError(400, `${itemType === 'story' ? 'Stories' : 'Tasks'} require a parent item.`);
    const row = await getMysqlProjectItemRow(executor, { itemId: parentId, projectId, tenantId });
    const requiredType = itemType === 'story' ? 'epic' : 'story';
    if (!row || row.deleted || String(row.item_type ?? '').toLowerCase() !== requiredType) {
      throw new HttpError(400, `${itemType === 'story' ? 'Stories' : 'Tasks'} require an existing ${requiredType} parent.`);
    }
    return row;
  }

  async function requireTicketReferences(executor, { item, projectId, tenantId }) {
    await assertTicketReferences(item, async ({ table }, id) => {
      const [rows] = await executor.execute(
        `SELECT id, status FROM ${table} WHERE id = ? AND tenant_id = ? AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
        [id, tenantId, projectId],
      );
      return rows[0];
    });
  }

  async function nextMysqlProjectItemPosition(executor, { parentId, projectId, taskTypeId }) {
    const [rows] = parentId
      ? await executor.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextPosition FROM tasks WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0', [projectId, taskTypeId, parentId])
      : await executor.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextPosition FROM tasks WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0', [projectId, taskTypeId]);
    return Number(rows[0]?.nextPosition ?? 0);
  }

  async function insertMysqlProjectItemRevision(executor, revision) {
    await executor.execute(
      `INSERT INTO project_item_revisions (id, tenant_id, project_id, item_id, item_type, action, version_before, version_after, before_json, after_json, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
      [revision.id, revision.tenantId, revision.projectId, revision.itemId, revision.itemType, revision.action,
        revision.versionBefore, revision.versionAfter,
        revision.before ? JSON.stringify(revision.before) : null,
        revision.after ? JSON.stringify(revision.after) : null,
        revision.actorUserId],
    );
    await appendMysqlProjectChanges(executor, [itemRevisionChange(revision)]);
    afterCommit(executor, () => revisionObservers.emit(revision));
  }

  // Completing a story completes its open tasks in the same transaction. Each task gets its
  // own version bump, status log entry, and revision, as if it had been updated directly.
  async function completeMysqlStoryTasks(executor, { projectId, storyId, tenantId, user }) {
    const [rows] = await executor.execute(
      `SELECT t.*, tt.task_type_name AS item_type
       FROM tasks t
       INNER JOIN task_types tt ON tt.id = t.task_type
       WHERE t.parent_task_id = ? AND t.project_id = ? AND t.deleted = 0
       ORDER BY t.sort_order
       FOR UPDATE`,
      [storyId, projectId],
    );
    for (const row of rows) {
      if (String(row.item_type ?? '').toLowerCase() !== 'task') continue;
      const before = await mysqlProjectItemSnapshot(executor, row);
      if (before.node.status === COMPLETED_STATUS) continue;
      const boardColumn = resolveBoardColumnForPatch(before.node, { status: COMPLETED_STATUS });
      await executor.execute(
        'UPDATE tasks SET board_column = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND project_id = ?',
        [boardColumn, row.id, projectId],
      );
      await insertTaskLog(executor, row.id, 'status_change', { status: COMPLETED_STATUS });
      const after = await mysqlProjectItemSnapshot(executor, await getMysqlProjectItemRow(executor, { itemId: row.id, projectId, tenantId }));
      await insertMysqlProjectItemRevision(executor, {
        action: 'update', actorUserId: user?.id ?? '', after, before, id: randomUUID(), itemId: row.id, itemType: 'task',
        projectId, tenantId, versionAfter: Number(row.version) + 1, versionBefore: Number(row.version),
      });
    }
  }

  // Who made each revision, by name: a user, or someone without a login (`resource:<id>`).
  async function withRevisionActorNames(executor, revisions) {
    const names = new Map();
    const userIds = [...new Set(revisions.map((revision) => revision.actorUserId).filter((id) => id && !resourceIdFromAssignee(id)))];
    if (userIds.length) {
      const [rows] = await executor.execute(`SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`, userIds);
      for (const row of rows) names.set(row.id, row.name ?? '');
    }
    for (const [id, owner] of await loadResourceAssignees(executor, revisions.map((revision) => revision.actorUserId ?? ''))) names.set(id, owner.name);
    return revisions.map((revision) => ({ ...revision, actorName: names.get(revision.actorUserId) ?? '' }));
  }

  function mapMysqlProjectItemRevision(row) {
    return {
      action: row.action,
      actorUserId: row.actorUserId,
      after: safeJsonParse(row.afterJson, null),
      before: safeJsonParse(row.beforeJson, null),
      createdAt: toIsoString(row.createdAt),
      id: row.id,
      itemId: row.itemId,
      itemType: row.itemType,
      projectId: row.projectId,
      tenantId: row.tenantId,
      versionAfter: Number(row.versionAfter),
      versionBefore: row.versionBefore == null ? null : Number(row.versionBefore),
    };
  }

  async function validateTargetForProject(executor, {
    projectId,
    targetId,
    targetType,
    tenantId,
  }) {
    // A channel's library.
    if (targetType === 'channel') {
      const [rows] = await executor.execute('SELECT id, project_id AS projectId, tenant_id AS tenantId FROM project_channels WHERE id = ? AND project_id = ? AND tenant_id = ? LIMIT 1', [targetId, projectId, tenantId]);
      return rows[0] ?? null;
    }

    // A direct message conversation stands in for the project of its files (chat.repository.js).
    if (targetType === DM_TARGET_TYPE) {
      if (projectId !== targetId) return null;
      const [rows] = await executor.execute('SELECT id, id AS projectId, tenant_id AS tenantId FROM direct_conversations WHERE id = ? AND tenant_id = ? LIMIT 1', [targetId, tenantId]);
      return rows[0] ?? null;
    }

    if (targetType === 'project') {
      const [rows] = await executor.execute(
        `
          SELECT id, tenant_id AS tenantId
          FROM projects
          WHERE id = ?
            AND tenant_id = ?
            AND (deleted IS NULL OR deleted = 0)
          LIMIT 1
        `,
        [targetId, tenantId],
      );

      return rows[0]?.id === projectId ? rows[0] : null;
    }

    if (targetType === 'clarification') {
      const [rows] = await executor.execute(
        `
          SELECT
            id,
            project_id AS projectId,
            tenant_id AS tenantId
          FROM project_clarifications
          WHERE id = ?
            AND project_id = ?
            AND tenant_id = ?
          LIMIT 1
        `,
        [targetId, projectId, tenantId],
      );

      return rows[0] ?? null;
    }

    const [rows] = await executor.execute(
      `
        SELECT
          t.id,
          t.project_id AS projectId,
          p.tenant_id AS tenantId,
          tt.task_type_name AS taskTypeName
        FROM tasks t
        INNER JOIN projects p ON p.id = t.project_id
        LEFT JOIN task_types tt ON tt.id = t.task_type
        WHERE t.id = ?
          AND t.project_id = ?
          AND p.tenant_id = ?
          AND t.deleted = 0
        LIMIT 1
      `,
      [targetId, projectId, tenantId],
    );

    if (!rows[0]) {
      return null;
    }

    const taskTypeName = String(rows[0].taskTypeName ?? '').trim().toLowerCase();

    if (taskTypeName && taskTypeName !== targetType) {
      return null;
    }

    return rows[0];
  }

  async function resolveCommentContext(executor, {
    commentId,
    projectId,
    tenantId,
  }) {
    const [rows] = await executor.execute(
      `
        SELECT
          id,
          tenant_id AS tenantId,
          user_id AS userId,
          target_id AS targetId,
          target_type AS targetType,
          parent_id AS parentId,
          comment,
          upvotes,
          downvotes,
          date_added AS createdAt,
          date_updated AS updatedAt
        FROM comments
        WHERE id = ?
          AND tenant_id = ?
        LIMIT 1
      `,
      [commentId, tenantId],
    );

    if (!rows[0]) {
      return null;
    }

    const target = await validateTargetForProject(executor, {
      projectId,
      targetId: rows[0].targetId,
      targetType: rows[0].targetType,
      tenantId,
    });

    return target ? rows[0] : null;
  }

  async function ensureParentComment(executor, {
    parentId,
    targetId,
    targetType,
    tenantId,
  }) {
    if (!parentId) {
      return;
    }

    const [rows] = await executor.execute(
      `
        SELECT id
        FROM comments
        WHERE id = ?
          AND tenant_id = ?
          AND target_id = ?
          AND target_type = ?
        LIMIT 1
      `,
      [parentId, tenantId, targetId, targetType],
    );

    if (!rows[0]?.id) {
      throw new Error('Invalid parent comment.');
    }
  }

  // Comments by someone without a login (`resource:<id>`, from a task access link) have no user
  // row; they are named after the resource.
  async function withResourceAuthorNames(executor, rows) {
    const resourceAuthors = rows.filter((row) => row.authorName == null && resourceIdFromAssignee(row.userId)).map((row) => row.userId);
    if (!resourceAuthors.length) return rows;
    const owners = await loadResourceAssignees(executor, resourceAuthors);
    return rows.map((row) => (row.authorName == null && owners.has(row.userId) ? { ...row, authorName: owners.get(row.userId).name } : row));
  }

  // lock takes shared locks on the target's comments until the transaction ends, so none can be
  // added or edited in between.
  async function listCommentRows(executor, {
    lock = false,
    targetId,
    targetType,
    tenantId,
  }) {
    const [rows] = await executor.execute(
      `
        SELECT
          c.id,
          c.user_id AS userId,
          c.target_id AS targetId,
          c.target_type AS targetType,
          c.parent_id AS parentId,
          c.comment,
          c.upvotes,
          c.downvotes,
          c.date_added AS createdAt,
          c.date_updated AS updatedAt,
          u.name AS authorName,
          COALESCE(avatar_pref.value, '') AS authorPicture
        FROM comments c
        LEFT JOIN users u ON u.id = c.user_id
        LEFT JOIN preferences avatar_pref
          ON avatar_pref.user_id = u.id
          AND avatar_pref.tenant_id IS NULL
          AND avatar_pref.project_id IS NULL
          AND avatar_pref.key = 'user_avatar'
        WHERE c.tenant_id = ?
          AND c.target_id = ?
          AND c.target_type = ?
        ORDER BY c.date_added ASC${lock ? ' FOR SHARE OF c' : ''}
      `,
      [tenantId, targetId, targetType],
    );

    return withResourceAuthorNames(executor, rows);
  }

  // One item's files. lock works as in listCommentRows.
  const FILE_COLUMNS = `
    fv.id,
    fv.tenant_id AS tenantId,
    fv.user_id AS userId,
    fv.target_id AS targetId,
    fv.target_type AS targetType,
    fv.file_name AS fileName,
    fv.file_desc AS fileDescription,
    fv.file_type AS fileType,
    fv.file_size AS fileSize,
    fv.signature AS signature,
    fv.current_version AS version,
    fv.version_note AS versionNote,
    fv.file_modified AS versionUploadedAt,
    fv.created_at AS createdAt,
    fv.updated_at AS updatedAt,
    fv.audience AS audience,
    fv.scan_status AS scanStatus,
    fv.sha256 AS sha256,
    fv.scanned_at AS scannedAt,
    fv.folder_id AS folderId,
    fv.editing_by AS editingBy,
    fv.editing_since AS editingSince,
    (SELECT eu.name FROM users eu WHERE eu.id = fv.editing_by) AS editingName`;

  async function listTargetFileRows(executor, { lock = false, projectId, targetId, targetType, tenantId }) {
    const [rows] = await executor.execute(
      `
        SELECT
          ${FILE_COLUMNS},
          ? AS projectId,
          (SELECT ch.name FROM project_channels ch WHERE ch.id = fv.target_id AND fv.target_type = 'channel') AS targetName,
          u.name AS uploaderName
        FROM file_vault fv
        LEFT JOIN users u ON u.id = fv.user_id
        WHERE fv.tenant_id = ?
          AND fv.target_id = ?
          AND fv.target_type = ?
        ORDER BY fv.updated_at DESC, fv.file_name ASC${lock ? ' FOR SHARE OF fv' : ''}
      `,
      [projectId, tenantId, targetId, targetType],
    );
    return rows;
  }

  function serializeMysqlComment(row) {
    return {
      author: {
        id: row.userId,
        name: row.authorName ?? 'Unknown user',
        picture: row.authorPicture ?? '',
      },
      comment: sanitizeRichHtml(row.comment ?? ''),
      createdAt: toIsoString(row.createdAt),
      downvotes: Number(row.downvotes ?? 0),
      id: row.id,
      parentId: row.parentId ?? null,
      targetId: row.targetId,
      targetType: row.targetType,
      upvotes: Number(row.upvotes ?? 0),
      updatedAt: toIsoString(row.updatedAt),
      userId: row.userId,
    };
  }

  function serializeMysqlFile(row) {
    return {
      // Internal unless someone shared it with stakeholders.
      audience: row.audience === 'external' ? 'external' : 'internal',
      contentType: row.fileType,
      createdAt: toIsoString(row.createdAt),
      description: row.fileDescription ?? '',
      // Who marked it as being edited, and its folder in a channel library.
      editing: editingMarker(row),
      fileName: row.fileName,
      fileSize: Number(row.fileSize ?? 0),
      folderId: row.folderId ?? null,
      id: row.id,
      inlineImage: String(row.fileType ?? '').toLowerCase().startsWith('image/'),
      projectId: row.projectId,
      scanStatus: row.scanStatus ?? 'clean',
      scannedAt: row.scannedAt ? toIsoString(row.scannedAt) : null,
      sha256: row.sha256 ?? null,
      signature: row.signature ?? null,
      targetId: row.targetId,
      targetName: row.targetName ?? null,
      targetType: row.targetType,
      tenantId: row.tenantId,
      updatedAt: toIsoString(row.updatedAt),
      uploadedBy: {
        id: row.userId,
        name: row.uploaderName ?? 'Unknown user',
      },
      version: Number(row.version ?? 1),
      versionNote: row.versionNote ?? '',
      versionUploadedAt: toIsoString(row.versionUploadedAt ?? row.updatedAt),
    };
  }

  // Each file's links to work items, by the name each item has now. A link to a deleted item stays
  // stored, so restoring the item brings it back, and is left out here.
  async function withFileLinks(executor, files, tenantId) {
    if (!files.length) return files;
    const [rows] = await executor.execute(
      `
        SELECT
          fl.id,
          fl.file_id AS fileId,
          fl.target_id AS targetId,
          fl.target_type AS targetType,
          fl.created_at AS linkedAt,
          t.name AS targetName
        FROM file_links fl
        INNER JOIN tasks t ON t.id = fl.target_id AND t.project_id = fl.project_id AND t.deleted = 0
        WHERE fl.tenant_id = ?
          AND fl.file_id IN (${files.map(() => '?').join(', ')})
        ORDER BY fl.created_at ASC
      `,
      [tenantId, ...files.map((file) => file.id)],
    );
    return files.map((file) => ({
      ...file,
      links: rows.filter((row) => row.fileId === file.id).map(({ fileId, linkedAt, ...link }) => ({ ...link, linkedAt: toIsoString(linkedAt) })),
    }));
  }

  // Anything that gives a file a name on a target takes this first, always before a file's row:
  // two files locking only themselves could each find a name free and both take it.
  async function lockProjectFileNames(connection, { projectId, tenantId }) {
    await connection.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [projectId, tenantId]);
  }

  // One file's stored row, locked for the rest of the transaction.
  async function lockFileRow(connection, { fileId, tenantId }) {
    const [rows] = await connection.execute('SELECT * FROM file_vault WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [fileId, tenantId]);
    return rows[0] ?? null;
  }

  async function assertFileNameFree(connection, { file, fileName, tenantId }) {
    const [rows] = await connection.execute(
      'SELECT id FROM file_vault WHERE tenant_id = ? AND target_id = ? AND target_type = ? AND folder_id <=> ? AND file_name = ? AND id <> ? LIMIT 1',
      [tenantId, file.target_id, file.target_type, file.folder_id ?? null, fileName, file.id],
    );
    if (rows[0]) throw fileNameTaken();
  }

  // The file's current contents become a version in file_versions, and these take their place.
  // storageKey names contents already stored: a new object, or an earlier version's when restoring.
  // scan is the new contents' scan status, SHA-256 and scan time (see supersedeStoredFile).
  async function supersedeFile(connection, file, { fileDescription, fileName, fileSize, fileType, note = null, scan, signature, storageKey, userId }) {
    await connection.execute(
      `
        INSERT INTO file_versions (id, tenant_id, file_id, version_number, storage_key, user_id, file_name, file_type, file_size, signature, version_note, uploaded_at, scan_status, sha256, scanned_at, preview_storage_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), file.tenant_id, file.id, file.current_version, file.storage_key ?? file.id, file.user_id, file.file_name, file.file_type, file.file_size, file.signature, file.version_note, file.file_modified ?? file.updated_at ?? new Date(), file.scan_status ?? 'clean', file.sha256 ?? null, file.scanned_at ?? null, file.preview_storage_key ?? null],
    );
    await connection.execute(
      `
        UPDATE file_vault
        SET user_id = ?,
            file_name = ?,
            file_desc = ?,
            file_type = ?,
            file_size = ?,
            file_modified = NOW(),
            signature = ?,
            current_version = current_version + 1,
            storage_key = ?,
            version_note = ?,
            scan_status = ?,
            sha256 = ?,
            scanned_at = ?,
            preview_storage_key = ?,
            editing_since = IF(editing_by <=> ?, NULL, editing_since),
            editing_by = IF(editing_by <=> ?, NULL, editing_by),
            updated_at = NOW()
        WHERE id = ?
      `,
      // A restored version keeps its preview; new contents get theirs from the preview worker. A
      // new version from the person editing the file clears their marker (editing_since first:
      // MySQL applies assignments in order).
      [userId, fileName, fileDescription ?? file.file_desc ?? '', fileType, fileSize, signature, storageKey, note, scan.scanStatus, scan.sha256 ?? null, scan.scannedAt ?? null, scan.previewStorageKey ?? null, userId, userId, file.id],
    );
  }

  async function readFileRecord(executor, { fileId, tenantId }) {
    const [rows] = await executor.execute(
      `
        SELECT
          ${FILE_COLUMNS},
          fv.storage_key AS storageKey,
          fv.preview_storage_key AS previewStorageKey,
          CASE
            WHEN fv.target_type = 'project' THEN fv.target_id
            WHEN fv.target_type = 'clarification' THEN pc.project_id
            WHEN fv.target_type = 'channel' THEN ch.project_id
            WHEN fv.target_type = 'dm' THEN fv.target_id
            ELSE t.project_id
          END AS projectId,
          CASE
            WHEN fv.target_type = 'project' THEN NULL
            WHEN fv.target_type = 'clarification' THEN pc.prompt
            WHEN fv.target_type = 'channel' THEN ch.name
            ELSE t.name
          END AS targetName,
          u.name AS uploaderName
        FROM file_vault fv
        LEFT JOIN users u ON u.id = fv.user_id
        LEFT JOIN tasks t
          ON t.id = fv.target_id
          AND fv.target_type NOT IN ('project', 'channel', 'dm')
        LEFT JOIN project_clarifications pc
          ON pc.id = fv.target_id
          AND fv.target_type = 'clarification'
        LEFT JOIN project_channels ch
          ON ch.id = fv.target_id
          AND fv.target_type = 'channel'
        WHERE fv.id = ?
          AND fv.tenant_id = ?
        LIMIT 1
      `,
      [fileId, tenantId],
    );
    return rows[0] ?? null;
  }

  async function fileRecordWithLinks(executor, { fileId, tenantId }) {
    const row = await readFileRecord(executor, { fileId, tenantId });
    return row ? (await withFileLinks(executor, [serializeMysqlFile(row)], tenantId))[0] : null;
  }

  // One version of a file as stored, and the file as it read then: the current version when
  // version is null. Null for no such version, or one deleted. No bytes are read.
  async function describeMysqlFileVersion(executor, { fileId, tenantId, version = null }) {
    const row = await readFileRecord(executor, { fileId, tenantId });
    if (!row) return null;
    const file = serializeMysqlFile(row);
    if (version == null || version === file.version) {
      return { contentType: row.fileType, current: true, file, fileName: file.fileName, fileSize: file.fileSize, previewStorageKey: row.previewStorageKey ?? null, scanStatus: file.scanStatus, sha256: file.sha256, storageKey: row.storageKey ?? fileId, version: file.version };
    }
    const [versions] = await executor.execute(
      'SELECT fv.*, u.name AS uploaderName FROM file_versions fv LEFT JOIN users u ON u.id = fv.user_id WHERE fv.file_id = ? AND fv.tenant_id = ? AND fv.version_number = ? AND fv.deleted_at IS NULL LIMIT 1',
      [fileId, tenantId, version],
    );
    if (!versions[0]) return null;
    const earlier = serializeFileVersionRow(versions[0]);
    return {
      contentType: earlier.contentType,
      current: false,
      // An earlier version reads as the file it was then: its name, type and size.
      file: { ...file, contentType: earlier.contentType, fileName: earlier.fileName, fileSize: earlier.fileSize, scanStatus: earlier.scanStatus, sha256: earlier.sha256, signature: earlier.signature, uploadedBy: earlier.uploadedBy, version: earlier.version, versionNote: earlier.note, versionUploadedAt: earlier.uploadedAt },
      fileName: earlier.fileName,
      fileSize: earlier.fileSize,
      previewStorageKey: versions[0].preview_storage_key ?? null,
      scanStatus: earlier.scanStatus,
      sha256: earlier.sha256,
      storageKey: versions[0].storage_key,
      version: earlier.version,
    };
  }

  function serializeFileUploadRow(row) {
    return {
      baseVersion: row.base_version == null ? null : Number(row.base_version),
      contentType: row.content_type,
      createdAt: toIsoString(row.created_at),
      createdBy: row.created_by,
      expiresAt: toIsoString(row.expires_at),
      fileId: row.file_id ?? null,
      fileName: row.name,
      folderId: row.folder_id ?? null,
      id: row.id,
      partSize: Number(row.part_size),
      projectId: row.project_id,
      size: Number(row.size),
      status: row.status,
      storageKey: row.storage_key,
      storageUploadId: row.s3_upload_id,
      targetId: row.target_id,
      targetType: row.target_type,
      tenantId: row.tenant_id,
    };
  }

  function serializeFileVersionRow(row) {
    return {
      contentType: row.file_type ?? 'application/octet-stream',
      current: false,
      fileName: row.file_name,
      fileSize: Number(row.file_size ?? 0),
      deletedAt: row.deleted_at ? toIsoString(row.deleted_at) : null,
      note: row.version_note ?? '',
      scanStatus: row.scan_status ?? 'clean',
      sha256: row.sha256 ?? null,
      signature: row.signature ?? null,
      uploadedAt: toIsoString(row.uploaded_at),
      uploadedBy: { id: row.user_id, name: row.uploaderName ?? 'Unknown user' },
      version: Number(row.version_number),
    };
  }

  async function listTenantUsersForArchive(executor, tenantId) {
    const [rows] = await executor.execute(
      `
        SELECT u.id, u.name, u.email, ut.role
        FROM user_tenant ut
        INNER JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = ?
        ORDER BY u.name ASC
      `,
      [tenantId],
    );

    return rows.map((row) => ({
      email: row.email,
      id: row.id,
      name: row.name,
      role: row.role ?? 'user',
    }));
  }

  async function selectRows(executor, sql, params) {
    const [rows] = await executor.execute(sql, params);
    return rows;
  }

  // Where each archived record type lands, and how to tell whether a row with that id belongs to
  // this workspace. Tables without a tenant column belong to it through their project.
  const ARCHIVE_RECORD_OWNERSHIP = {
    clarification: { table: 'project_clarifications' },
    clarification_assignment: { table: 'project_clarification_assignments' },
    clarification_comment: { table: 'project_clarification_comments' },
    clarification_email_message: { table: 'project_clarification_email_messages' },
    clarification_invitation: { table: 'project_clarification_invitations' },
    clarification_reaction: { table: 'project_clarification_comment_reactions' },
    comment: { table: 'comments' },
    comment_vote: { owned: 'SELECT v.id FROM comment_votes v JOIN comments c ON c.id = v.comment_id WHERE c.tenant_id = ? AND v.id IN', table: 'comment_votes' },
    file: { table: 'file_vault' },
    preference: { table: 'preferences' },
    project: { table: 'projects' },
    project_user: { owned: 'SELECT up.id FROM user_project up JOIN projects p ON p.id = up.project_id WHERE p.tenant_id = ? AND up.id IN', table: 'user_project' },
    sprint: { owned: 'SELECT s.id FROM project_sprints s JOIN projects p ON p.id = s.project_id WHERE p.tenant_id = ? AND s.id IN', table: 'project_sprints' },
    sprint_staffing: { owned: 'SELECT st.id FROM project_sprint_staffing st JOIN project_sprints s ON s.id = st.sprint_id JOIN projects p ON p.id = s.project_id WHERE p.tenant_id = ? AND st.id IN', table: 'project_sprint_staffing' },
    stakeholder: { table: 'project_stakeholders' },
    summary: { table: 'summary_documents' },
    task: { owned: 'SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.tenant_id = ? AND t.id IN', table: 'tasks' },
    task_log: { owned: 'SELECT l.id FROM task_log l JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id WHERE p.tenant_id = ? AND l.id IN', table: 'task_log' },
  };

  // conflicts: archive ids this workspace already has, which an overwrite may replace.
  // heldElsewhere: archive ids another workspace has. Those records are never touched; the
  // archive is imported as a copy with new ids instead.
  async function archiveIdConflicts(executor, { archiveData, tenantId }) {
    const conflicts = [];
    const heldElsewhere = [];
    for (const [type, ids] of archiveRecordIds(archiveData)) {
      if (ids.length === 0) continue;
      const { owned, table } = ARCHIVE_RECORD_OWNERSHIP[type];
      const placeholders = `(${ids.map(() => '?').join(', ')})`;
      const [ownedRows] = await executor.execute(
        `${owned ?? `SELECT id FROM ${table} WHERE tenant_id = ? AND id IN`} ${placeholders}`,
        [tenantId, ...ids],
      );
      const [anyRows] = await executor.execute(`SELECT id FROM ${table} WHERE id IN ${placeholders}`, ids);
      const ownedIds = new Set(ownedRows.map((row) => String(row.id)));
      for (const row of anyRows) {
        (ownedIds.has(String(row.id)) ? conflicts : heldElsewhere).push({ id: row.id, type });
      }
    }
    return { conflicts, heldElsewhere };
  }

  // Storage deletes do not roll back, so a caller whose transaction can still fail passes
  // obsoleteKeys and deletes those objects once it has committed.
  async function deleteFilesByIds(executor, fileIds = [], tenantId, obsoleteKeys = null) {
    const uniqueIds = [...new Set((fileIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return;
    }

    const placeholders = uniqueIds.map(() => '?').join(', ');
    const [rows] = await executor.execute(
      `SELECT id, storage_key, preview_storage_key FROM file_vault WHERE id IN (${placeholders}) AND tenant_id = ?`,
      [...uniqueIds, tenantId],
    );
    if (rows.length > 0) {
      const ids = rows.map((row) => row.id);
      const idList = ids.map(() => '?').join(', ');
      const [versions] = await executor.execute(`SELECT storage_key, preview_storage_key FROM file_versions WHERE file_id IN (${idList}) AND tenant_id = ?`, [...ids, tenantId]);
      const previews = [...rows, ...versions].map((row) => row.preview_storage_key).filter(isStoredPreview);
      // Only keys these rows hold: a file's id is its object's name only when its row says so.
      for (const key of new Set([...rows.map((row) => row.storage_key ?? row.id), ...versions.map((row) => row.storage_key), ...previews])) {
        if (obsoleteKeys) obsoleteKeys.add(key);
        else await storage.delete(key);
      }
      await executor.execute(`DELETE FROM file_links WHERE file_id IN (${idList}) AND tenant_id = ?`, [...ids, tenantId]);
      // A file's comments go with it, and posts no longer carry it.
      await executor.execute(`DELETE FROM discussion_posts WHERE tenant_id = ? AND target_type = 'file' AND target_id IN (${idList})`, [tenantId, ...ids]);
      await executor.execute(`DELETE FROM discussion_post_files WHERE file_id IN (${idList})`, ids);
      await executor.execute(`DELETE FROM file_versions WHERE file_id IN (${idList}) AND tenant_id = ?`, [...ids, tenantId]);
      await executor.execute(`DELETE FROM file_vault WHERE id IN (${idList}) AND tenant_id = ?`, [...ids, tenantId]);
    }
  }

  // After a commit, when the rows are gone for good. An object that won't delete is left orphaned.
  async function deleteStoredObjects(keys) {
    await Promise.allSettled([...keys].map((key) => storage.delete(key)));
  }

  async function deleteRowsByIds(executor, tableName, ids = [], tenantId, tenantColumn = 'tenant_id') {
    const uniqueIds = [...new Set((ids ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return;
    }

    const placeholders = uniqueIds.map(() => '?').join(', ');
    const tenantClause = tenantColumn ? ` AND ${tenantColumn} = ?` : '';
    const params = tenantColumn ? [...uniqueIds, tenantId] : uniqueIds;
    await executor.execute(`DELETE FROM ${tableName} WHERE id IN (${placeholders})${tenantClause}`, params);
  }

  async function deleteRowsByColumn(executor, tableName, columnName, values = [], tenantId = null, tenantColumn = 'tenant_id') {
    const uniqueValues = [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
    if (uniqueValues.length === 0) {
      return;
    }

    const placeholders = uniqueValues.map(() => '?').join(', ');
    const tenantClause = tenantColumn ? ` AND ${tenantColumn} = ?` : '';
    const params = tenantColumn ? [...uniqueValues, tenantId] : uniqueValues;
    await executor.execute(`DELETE FROM ${tableName} WHERE ${columnName} IN (${placeholders})${tenantClause}`, params);
  }

  async function taskDescendantIdsMysql(executor, taskIds = []) {
    const seenIds = new Set((taskIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean));
    if (seenIds.size === 0) {
      return [...seenIds];
    }

    let frontier = [...seenIds];
    while (frontier.length > 0) {
      const placeholders = frontier.map(() => '?').join(', ');
      const [rows] = await executor.execute(
        `SELECT id FROM tasks WHERE parent_task_id IN (${placeholders})`,
        frontier,
      );
      frontier = rows
        .map((row) => String(row.id ?? '').trim())
        .filter((id) => id && !seenIds.has(id));
      for (const id of frontier) {
        seenIds.add(id);
      }
    }

    return [...seenIds];
  }

  async function deleteTasksLeafFirstMysql(executor, taskIds = []) {
    const ids = await taskDescendantIdsMysql(executor, taskIds);
    if (ids.length === 0) {
      return ids;
    }

    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await executor.execute(
      `SELECT id, parent_task_id AS parentTaskId FROM tasks WHERE id IN (${placeholders})`,
      ids,
    );
    const parentById = new Map(rows.map((row) => [String(row.id), row.parentTaskId ? String(row.parentTaskId) : null]));
    const depthById = new Map();
    const depthFor = (id) => {
      if (depthById.has(id)) {
        return depthById.get(id);
      }
      const parentId = parentById.get(id);
      const depth = parentId && parentById.has(parentId) ? depthFor(parentId) + 1 : 0;
      depthById.set(id, depth);
      return depth;
    };
    const orderedIds = rows
      .map((row) => String(row.id))
      .sort((left, right) => depthFor(right) - depthFor(left));

    for (const id of orderedIds) {
      await executor.execute('DELETE FROM tasks WHERE id = ?', [id]);
    }

    return ids;
  }

  async function projectOwnedConflictSetsMysql(executor, { projectId, tenantId }) {
    const sets = new Map([['project', new Set(projectId ? [projectId] : [])]]);
    const add = (type, ids = []) => sets.set(type, new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean)));
    const taskIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute('SELECT id FROM tasks WHERE project_id = ?', [projectId]);
      return rows.map((row) => row.id);
    })();
    const sprintIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute('SELECT id FROM project_sprints WHERE project_id = ?', [projectId]);
      return rows.map((row) => row.id);
    })();
    const projectUserIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute('SELECT id FROM user_project WHERE project_id = ?', [projectId]);
      return rows.map((row) => row.id);
    })();
    const clarificationIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarifications WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const scopedTargetIds = [projectId, ...taskIds, ...clarificationIds].filter(Boolean);
    const commentIds = await (async () => {
      if (scopedTargetIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM comments WHERE tenant_id = ? AND target_id IN (${scopedTargetIds.map(() => '?').join(', ')})`,
        [tenantId, ...scopedTargetIds],
      );
      return rows.map((row) => row.id);
    })();
    const commentVoteIds = await (async () => {
      if (commentIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM comment_votes WHERE comment_id IN (${commentIds.map(() => '?').join(', ')})`,
        commentIds,
      );
      return rows.map((row) => row.id);
    })();
    const fileIds = await (async () => {
      if (scopedTargetIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM file_vault WHERE tenant_id = ? AND target_id IN (${scopedTargetIds.map(() => '?').join(', ')})`,
        [tenantId, ...scopedTargetIds],
      );
      return rows.map((row) => row.id);
    })();
    const preferenceIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM preferences WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const stakeholderIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_stakeholders WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const sprintStaffingIds = await (async () => {
      if (sprintIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM project_sprint_staffing WHERE sprint_id IN (${sprintIds.map(() => '?').join(', ')})`,
        sprintIds,
      );
      return rows.map((row) => row.id);
    })();
    const taskLogIds = await (async () => {
      if (taskIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM task_log WHERE task_id IN (${taskIds.map(() => '?').join(', ')})`,
        taskIds,
      );
      return rows.map((row) => row.id);
    })();
    const summaryIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM summary_documents WHERE tenant_id = ? AND source_kind = ? AND source_id = ?',
        [tenantId, 'project', projectId],
      );
      return rows.map((row) => row.id);
    })();
    const clarificationAssignmentIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const clarificationCommentIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarification_comments WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const clarificationReactionIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarification_comment_reactions WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const clarificationInvitationIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarification_invitations WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const clarificationEmailMessageIds = await (async () => {
      if (!projectId) return [];
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarification_email_messages WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();

    add('project_user', projectUserIds);
    add('task', taskIds);
    add('task_log', taskLogIds);
    add('sprint', sprintIds);
    add('sprint_staffing', sprintStaffingIds);
    add('comment', commentIds);
    add('comment_vote', commentVoteIds);
    add('file', fileIds);
    add('preference', preferenceIds);
    add('stakeholder', stakeholderIds);
    add('clarification', clarificationIds);
    add('clarification_assignment', clarificationAssignmentIds);
    add('clarification_comment', clarificationCommentIds);
    add('clarification_reaction', clarificationReactionIds);
    add('clarification_invitation', clarificationInvitationIds);
    add('clarification_email_message', clarificationEmailMessageIds);
    add('summary', summaryIds);
    return sets;
  }

  async function deleteProjectArchiveRecordsMysql(executor, { obsoleteKeys = null, projectId, tenantId }) {
    // Before any file row, in the order saving a file takes them.
    await lockProjectFileNames(executor, { projectId, tenantId });
    if (!projectId) {
      return;
    }
    // Several tables below have no tenant column, so make sure the project is this workspace's.
    const [owned] = await executor.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1', [projectId, tenantId]);
    if (!owned[0]) {
      return;
    }

    const taskIds = await (async () => {
      const [rows] = await executor.execute('SELECT id FROM tasks WHERE project_id = ?', [projectId]);
      return rows.map((row) => row.id);
    })();
    const sprintIds = await (async () => {
      const [rows] = await executor.execute('SELECT id FROM project_sprints WHERE project_id = ?', [projectId]);
      return rows.map((row) => row.id);
    })();
    const clarificationIds = await (async () => {
      const [rows] = await executor.execute(
        'SELECT id FROM project_clarifications WHERE tenant_id = ? AND project_id = ?',
        [tenantId, projectId],
      );
      return rows.map((row) => row.id);
    })();
    const commentIds = await (async () => {
      const scopedTargetIds = [projectId, ...taskIds, ...clarificationIds];
      if (scopedTargetIds.length === 0) return [];
      const placeholders = scopedTargetIds.map(() => '?').join(', ');
      const [rows] = await executor.execute(
        `SELECT id FROM comments WHERE tenant_id = ? AND target_id IN (${placeholders})`,
        [tenantId, ...scopedTargetIds],
      );
      return rows.map((row) => row.id);
    })();
    const fileIds = await (async () => {
      const scopedTargetIds = [projectId, ...taskIds, ...clarificationIds];
      if (scopedTargetIds.length === 0) return [];
      const placeholders = scopedTargetIds.map(() => '?').join(', ');
      const [rows] = await executor.execute(
        `SELECT id FROM file_vault WHERE tenant_id = ? AND target_id IN (${placeholders})`,
        [tenantId, ...scopedTargetIds],
      );
      return rows.map((row) => row.id);
    })();

    await deleteRowsByColumn(executor, 'comment_votes', 'comment_id', commentIds, tenantId, null);
    await deleteRowsByIds(executor, 'comments', commentIds, tenantId);
    await deleteFilesByIds(executor, fileIds, tenantId, obsoleteKeys);
    await deleteRowsByColumn(executor, 'task_log', 'task_id', taskIds, tenantId, null);
    await deleteRowsByColumn(executor, 'project_sprint_staffing', 'sprint_id', sprintIds, tenantId, null);
    await executor.execute('DELETE FROM project_clarification_email_messages WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM project_clarification_invitations WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM project_clarification_comment_reactions WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM project_clarification_comments WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM project_clarifications WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM project_stakeholders WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM summary_documents WHERE tenant_id = ? AND source_kind = ? AND source_id = ?', [tenantId, 'project', projectId]);
    await executor.execute('DELETE FROM preferences WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
    await executor.execute('DELETE FROM user_project WHERE project_id = ?', [projectId]);
    await deleteRowsByIds(executor, 'project_sprints', sprintIds, tenantId, null);
    await deleteTasksLeafFirstMysql(executor, taskIds);
    await executor.execute('DELETE FROM projects WHERE tenant_id = ? AND id = ?', [tenantId, projectId]);
  }

  async function deleteArchiveConflictRecordsMysql(executor, { conflicts = [], obsoleteKeys = null, tenantId }) {
    for (const conflict of conflicts.filter((entry) => entry.type === 'project')) {
      await lockProjectFileNames(executor, { projectId: conflict.id, tenantId });
    }
    const idsFor = (type) => conflicts.filter((conflict) => conflict.type === type).map((conflict) => conflict.id);
    const taskIds = await taskDescendantIdsMysql(executor, idsFor('task'));
    const sprintIds = idsFor('sprint');
    const commentIds = idsFor('comment');
    const clarificationIds = idsFor('clarification');
    const clarificationInvitationIds = idsFor('clarification_invitation');
    const clarificationCommentIds = idsFor('clarification_comment');
    const taskTargetCommentIds = await (async () => {
      if (taskIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM comments WHERE tenant_id = ? AND target_id IN (${taskIds.map(() => '?').join(', ')})`,
        [tenantId, ...taskIds],
      );
      return rows.map((row) => row.id);
    })();
    const taskTargetFileIds = await (async () => {
      if (taskIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM file_vault WHERE tenant_id = ? AND target_id IN (${taskIds.map(() => '?').join(', ')})`,
        [tenantId, ...taskIds],
      );
      return rows.map((row) => row.id);
    })();
    const allCommentIds = [...new Set([...commentIds, ...taskTargetCommentIds])];

    await deleteRowsByColumn(executor, 'task_log', 'task_id', taskIds, tenantId, null);
    await deleteRowsByIds(executor, 'task_log', idsFor('task_log'), tenantId, null);
    await deleteRowsByColumn(executor, 'project_sprint_staffing', 'sprint_id', sprintIds, tenantId, null);
    await deleteRowsByIds(executor, 'project_sprint_staffing', idsFor('sprint_staffing'), tenantId, null);
    await deleteRowsByIds(executor, 'comment_votes', idsFor('comment_vote'), tenantId, null);
    await deleteRowsByColumn(executor, 'comment_votes', 'comment_id', allCommentIds, tenantId, null);
    await deleteRowsByIds(executor, 'comments', allCommentIds, tenantId);
    await deleteFilesByIds(executor, [...idsFor('file'), ...taskTargetFileIds], tenantId, obsoleteKeys);
    await deleteRowsByColumn(executor, 'file_links', 'target_id', taskIds, tenantId);
    await deleteRowsByIds(executor, 'preferences', idsFor('preference'), tenantId);
    const invitationIds = await (async () => {
      if (clarificationIds.length === 0) return [];
      const [rows] = await executor.execute(
        `SELECT id FROM project_clarification_invitations WHERE clarification_id IN (${clarificationIds.map(() => '?').join(', ')}) AND tenant_id = ?`,
        [...clarificationIds, tenantId],
      );
      return rows.map((row) => row.id);
    })();
    await deleteRowsByColumn(executor, 'project_clarification_email_messages', 'invitation_id', clarificationInvitationIds, tenantId, null);
    await deleteRowsByColumn(executor, 'project_clarification_email_messages', 'invitation_id', invitationIds, tenantId, null);
    await deleteRowsByIds(executor, 'project_clarification_email_messages', idsFor('clarification_email_message'), tenantId);
    await deleteRowsByColumn(executor, 'project_clarification_comment_reactions', 'comment_id', clarificationCommentIds, tenantId, null);
    await deleteRowsByColumn(executor, 'project_clarification_invitations', 'clarification_id', clarificationIds, tenantId);
    await deleteRowsByIds(executor, 'project_clarification_invitations', clarificationInvitationIds, tenantId);
    await deleteRowsByColumn(executor, 'project_clarification_comment_reactions', 'clarification_id', clarificationIds, tenantId);
    await deleteRowsByIds(executor, 'project_clarification_comment_reactions', idsFor('clarification_reaction'), tenantId);
    await deleteRowsByColumn(executor, 'project_clarification_comments', 'clarification_id', clarificationIds, tenantId);
    await deleteRowsByIds(executor, 'project_clarification_comments', clarificationCommentIds, tenantId);
    await deleteRowsByColumn(executor, 'project_clarification_assignments', 'clarification_id', clarificationIds, tenantId);
    await deleteRowsByIds(executor, 'project_clarification_assignments', idsFor('clarification_assignment'), tenantId);
    await deleteRowsByIds(executor, 'project_clarifications', clarificationIds, tenantId);
    await deleteRowsByIds(executor, 'user_project', idsFor('project_user'), tenantId, null);
    await deleteRowsByIds(executor, 'project_stakeholders', idsFor('stakeholder'), tenantId);
    await deleteRowsByIds(executor, 'summary_documents', idsFor('summary'), tenantId);
    await deleteRowsByIds(executor, 'project_sprints', sprintIds, tenantId, null);
    await deleteTasksLeafFirstMysql(executor, taskIds);
  }

  async function insertArchiveTaskNode(connection, { parentTaskId, projectId, skipGeneratedLogs = false, task, taskTypeName, tenantId, userMap }) {
    const taskTypeIds = await getTaskTypeIds(connection, tenantId, projectId);
    const taskTypeId = taskTypeIds[taskTypeName];
    if (!taskTypeId) {
      throw new Error(`Task type ${taskTypeName} is not configured for project ${projectId}.`);
    }
    await connection.execute(
      `
        INSERT INTO tasks (
          id,
          project_id,
          task_type,
          parent_task_id,
          name,
          description,
          priority,
          points,
          target_start_date,
          target_end_date,
          target_hour_estimate,
          source_clarification_ids,
          sprint_id,
          sprint_sort_order,
          sort_order,
          created_at,
          updated_at,
          deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      [
        task.id,
        projectId,
        taskTypeId,
        parentTaskId,
        task.name,
        normalizeStoredRichTextMarkdown(task.description ?? ''),
        task.priority ?? 4,
        task.points ?? null,
        task.targetStartDate ?? null,
        task.targetEndDate ?? null,
        task.targetHourEstimate ?? null,
        Array.isArray(task.sourceClarificationIds) && task.sourceClarificationIds.length > 0
          ? JSON.stringify(task.sourceClarificationIds)
          : null,
        task.sprintId ?? null,
        task.sprintSortOrder ?? null,
        task.sortOrder ?? 0,
        archiveDateTime(task.createdAt),
        archiveDateTime(task.updatedAt),
      ],
    );

    if (!skipGeneratedLogs) {
      await connection.execute(
        'INSERT INTO task_log (id, task_id, log_action, log_data, log_date) VALUES (?, ?, ?, ?, ?)',
        [
          randomUUID(),
          task.id,
          'assign',
          JSON.stringify({ assigned_to: mappedArchiveUserId(task.assigneeId, userMap, null) }),
          archiveDateTime(task.updatedAt),
        ],
      );
      await connection.execute(
        'INSERT INTO task_log (id, task_id, log_action, log_data, log_date) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), task.id, 'status_change', JSON.stringify({ status: task.status ?? 'Not Started' }), archiveDateTime(task.updatedAt)],
      );
    }

    for (const [index, story] of (task.stories ?? []).entries()) {
      await insertArchiveTaskNode(connection, {
        parentTaskId: task.id,
        projectId,
        skipGeneratedLogs,
        task: { ...story, sortOrder: story.sortOrder ?? index },
        taskTypeName: 'Story',
        tenantId,
        userMap,
      });
    }
    for (const [index, childTask] of (task.tasks ?? []).entries()) {
      await insertArchiveTaskNode(connection, {
        parentTaskId: task.id,
        projectId,
        skipGeneratedLogs,
        task: { ...childTask, sortOrder: childTask.sortOrder ?? index },
        taskTypeName: 'Task',
        tenantId,
        userMap,
      });
    }
  }

  return {
    ...createMysqlProjectDeletionMethods({ pool }),
    ...createMysqlEngagementMethods({ getProjectDetail, getProjectStatusId, pool }),
    ...createMysqlChannelMethods({ pool }),
    ...createMysqlChatMethods({ pool }),
    ...createMysqlChannelActivityMethods({ pool }),
    ...createMysqlSearchSourceMethods({ pool }),
    ...createMysqlPursuitMethods({ getMysqlProjectItemRow, getTaskTypeIds, insertRevision: insertMysqlProjectItemRevision, insertTaskLog, mysqlProjectItemSnapshot, pool }),
    ...createMysqlOdinReplyMethods({ pool }),
    ...createMysqlPollMethods({ pool }),
    // Delivery projects only, unless includeEngagements: engagements stay out of delivery views.
    async listProjectsForTenant({ includeEngagements = false, tenantId, user }) {
      const canSeeAllProjects = isTenantModerator(user, tenantId);
      const [rows] = await pool.execute(
        `
          SELECT
            p.id,
            p.tenant_id AS tenantId,
            p.name,
            p.description,
            ps.project_status_name AS status,
            p.start_date AS startDate,
            p.end_date AS endDate,
            p.\`rank\` AS \`rank\`,
            p.updated_at AS updatedAt,
            p.created_at AS createdAt,
            p.kind AS kind,
            up.role AS projectRole
          FROM projects p
          LEFT JOIN user_project up
            ON up.project_id = p.id
            AND up.user_id = ?
            AND up.role IS NOT NULL
          INNER JOIN project_statuses ps ON ps.id = p.project_status
          WHERE p.tenant_id = ?
            AND ${activeProjectSql('p')}
            AND (? = 1 OR ${deliveryProjectSql('p')})
            AND (? = 1 OR up.user_id IS NOT NULL)
          ORDER BY p.\`rank\` IS NULL, p.\`rank\`, p.name
        `,
        [user.id, tenantId, includeEngagements ? 1 : 0, canSeeAllProjects ? 1 : 0],
      );
      const membership = user.memberships?.find((item) => item.tenantId === tenantId) ?? user.memberships?.[0] ?? null;

      return rows.map((row) => ({
        createdAt: toIsoString(row.createdAt),
        description: normalizeStoredRichTextMarkdown(row.description ?? ''),
        endDate: dateOnlyValue(row.endDate),
        id: row.id,
        kind: projectKindOf(row),
        name: row.name,
        rank: row.rank != null ? Number(row.rank) : null,
        role: row.projectRole ?? membership?.role ?? 'user',
        startDate: dateOnlyValue(row.startDate),
        status: normalizeProjectStatusForDisplay(row.status),
        tenantId: row.tenantId,
        updatedAt: toIsoString(row.updatedAt),
      }));
    },
    async getProjectAccess({ projectId, tenantId, userId }) {
      const [rows] = await pool.execute(
        `
          SELECT
            p.id,
            up.role AS projectRole
          FROM projects p
          LEFT JOIN user_project up
            ON up.project_id = p.id
            AND up.user_id = ?
          WHERE p.id = ?
            AND p.tenant_id = ?
            AND ${activeProjectSql('p')}
          LIMIT 1
        `,
        [userId, projectId, tenantId],
      );

      return {
        exists: Boolean(rows[0]),
        projectRole: rows[0]?.projectRole ?? null,
      };
    },
    async getProjectDetail(params) {
      return getProjectDetail(pool, params);
    },
    async getValidUsers({ projectId, tenantId }) {
      const [projectRows] = await pool.execute(
        'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
        [projectId, tenantId],
      );

      if (!projectRows[0]) {
        return null;
      }

      const [projectUserRows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            up.role,
            up.project_bill_rate,
            up.project_allocation,
            ut.default_bill_rate,
            ut.min_bill_rate
          FROM user_project up
          INNER JOIN users u ON u.id = up.user_id
          INNER JOIN projects p ON p.id = up.project_id
          LEFT JOIN user_tenant ut
            ON ut.tenant_id = p.tenant_id
            AND ut.user_id = u.id
          WHERE up.project_id = ?
            AND p.tenant_id = ?
        `,
        [projectId, tenantId],
      );

      const [tenantUserRows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            ut.role
          FROM user_tenant ut
          INNER JOIN users u ON u.id = ut.user_id
          WHERE ut.tenant_id = ?
          ORDER BY u.name ASC
        `,
        [tenantId],
      );

      const validTaskTypes = await getTaskTypeIds(pool, tenantId, projectId);
      const validStatusTypes = await getTaskStatusIds(pool, tenantId, projectId);

      return {
        project_users: projectUserRows ?? [],
        tenant_users: tenantUserRows ?? [],
        validStatusTypes,
        validTaskTypes,
      };
    },
    async setProjectPermissions({ projectId, tenantId, validUsers, user }) {
      const [projectRows] = await pool.execute(
        'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
        [projectId, tenantId],
      );

      if (!projectRows[0]) {
        return null;
      }

      const isModerator = isTenantModerator(user, tenantId);

      if (!isModerator) {
        const [roleRows] = await pool.execute(
          'SELECT role FROM user_project WHERE project_id = ? AND user_id = ? LIMIT 1',
          [projectId, user?.id ?? ''],
        );
        const isProjectAdmin = roleRows[0]?.role === 'admin';

        if (!isProjectAdmin) {
          throw new Error('Forbidden');
        }
      }

      const normalized = Array.isArray(validUsers) ? validUsers : [];
      const uniqueUserIds = [...new Set(normalized.map((entry) => entry?.id).filter(Boolean))];

      const allowedTenantUsers = new Set();

      if (uniqueUserIds.length > 0) {
        const placeholders = uniqueUserIds.map(() => '?').join(', ');
        const [rows] = await pool.execute(
          `
            SELECT user_id AS userId
            FROM user_tenant
            WHERE tenant_id = ?
              AND user_id IN (${placeholders})
          `,
          [tenantId, ...uniqueUserIds],
        );

        for (const row of rows) {
          if (row?.userId) {
            allowedTenantUsers.add(row.userId);
          }
        }
      }

      await withTransaction(pool, async (connection) => {
        const [currentRows] = await connection.execute(
          'SELECT id, user_id AS userId FROM user_project WHERE project_id = ?',
          [projectId],
        );
        const currentByUserId = new Map(currentRows.map((row) => [row.userId, row.id]));

        for (const entry of normalized) {
          const userId = entry?.id ?? '';
          if (!userId || !allowedTenantUsers.has(userId)) {
            continue;
          }

          const role = entry.role ?? 'user';
          const billRate = entry.project_bill_rate ?? null;
          const allocation = entry.project_allocation ?? null;

          if (!currentByUserId.has(userId)) {
            await connection.execute(
              `
                INSERT INTO user_project (id, user_id, project_id, role, project_bill_rate, project_allocation)
                VALUES (?, ?, ?, ?, ?, ?)
              `,
              [randomUUID(), userId, projectId, role, billRate, allocation],
            );
          } else {
            await connection.execute(
              `
                UPDATE user_project
                SET role = ?,
                    project_bill_rate = ?,
                    project_allocation = ?,
                    updated_at = NOW()
                WHERE id = ?
              `,
              [role, billRate, allocation, currentByUserId.get(userId)],
            );
          }
        }

        const keepSet = new Set(uniqueUserIds.filter((id) => allowedTenantUsers.has(id)));

        for (const [userId, relId] of currentByUserId.entries()) {
          if (!keepSet.has(userId)) {
            await connection.execute('DELETE FROM user_project WHERE id = ?', [relId]);
          }
        }
      });

      const [updatedRows] = await pool.execute(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            up.role,
            up.project_bill_rate,
            up.project_allocation,
            ut.default_bill_rate,
            ut.min_bill_rate
          FROM user_project up
          INNER JOIN users u ON u.id = up.user_id
          LEFT JOIN user_tenant ut
            ON ut.tenant_id = ?
            AND ut.user_id = u.id
          WHERE up.project_id = ?
          ORDER BY u.name ASC
        `,
        [tenantId, projectId],
      );

      return {
        message: 'Project permissions updated.',
        project_users: updatedRows ?? [],
      };
    },
    async listProjectSprints({ projectId, tenantId }) {
      const payload = await buildMySqlSprintPlanningPayload(pool, projectId, tenantId);

      if (!payload) {
        return null;
      }

      return {
        backlog: payload.backlog,
        members: payload.members,
        sprints: payload.sprints,
      };
    },
    // A project's sprints alone, in board order, without the planning payload.
    async listSprintRows({ projectId, tenantId }) {
      const [projects] = await pool.execute(`SELECT id FROM projects WHERE id = ? AND tenant_id = ? AND ${activeProjectSql('')} LIMIT 1`, [projectId, tenantId]);
      return projects[0] ? listMySqlSprintRows(pool, projectId) : null;
    },
    // Home reads the active and planned sprints in one query and the active ones' staffing in
    // one more, without the planning payload (which rebuilds the whole project).
    async listOpenSprints({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT
            s.id,
            s.project_id AS projectId,
            s.name,
            s.goal,
            s.sprint_status AS status,
            s.start_date AS startDate,
            s.end_date AS endDate,
            s.sort_order AS sortOrder
          FROM project_sprints s
          INNER JOIN projects p ON p.id = s.project_id
          WHERE s.project_id = ?
            AND p.tenant_id = ?
            AND s.deleted = 0
            AND s.sprint_status IN ('active', 'planned')
          ORDER BY s.sort_order ASC, s.created_at ASC
        `,
        [projectId, tenantId],
      );
      const sprints = rows.map((row) => normalizeSprint(row, projectId));
      const activeIds = sprints.filter((sprint) => String(sprint.status).toLowerCase() === 'active').map((sprint) => sprint.id);
      const staffing = new Map(activeIds.map((id) => [id, []]));
      if (activeIds.length > 0) {
        const [staffingRows] = await pool.execute(
          `
            SELECT
              sprint_id AS sprintId,
              user_id AS userId,
              capacity_hours AS capacityHours,
              allocation_pct_override AS allocationPctOverride,
              notes
            FROM project_sprint_staffing
            WHERE sprint_id IN (${activeIds.map(() => '?').join(', ')})
            ORDER BY updated_at ASC, created_at ASC
          `,
          activeIds,
        );
        for (const row of staffingRows) staffing.get(row.sprintId)?.push(normalizeSprintStaffingEntry(row, row.sprintId));
      }

      return { sprints: sprints.map((sprint) => ({ ...sprint, staffing: staffing.get(sprint.id) ?? [] })) };
    },
    async createProjectSprint({ input, projectId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [projectRows] = await connection.execute(
          'SELECT id, updated_at AS updatedAt FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id) {
          return null;
        }

        const sprint = normalizeSprint({
          ...input,
          id: randomUUID(),
          projectId,
          sortOrder: (await listMySqlSprintRows(connection, projectId)).length,
        }, projectId);

        await connection.execute(
          `
            INSERT INTO project_sprints (
              id,
              project_id,
              name,
              goal,
              sprint_status,
              start_date,
              end_date,
              sort_order,
              created_at,
              updated_at,
              deleted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 0)
          `,
          [
            sprint.id,
            projectId,
            sprint.name,
            sprint.goal,
            sprint.status,
            sprint.startDate,
            sprint.endDate,
            sprint.sortOrder,
          ],
        );

        return sprint;
      });
    },
    async updateProjectSprint({ input, projectId, sprintId, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `
            SELECT id, sort_order AS sortOrder
            FROM project_sprints
            WHERE id = ?
              AND project_id = ?
              AND deleted = 0
            LIMIT 1
          `,
          [sprintId, projectId],
        );
        const [projectRows] = await connection.execute(
          'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id || !rows[0]?.id) {
          return null;
        }

        const sprint = normalizeSprint({
          ...input,
          id: sprintId,
          projectId,
          sortOrder: Number(rows[0].sortOrder ?? 0),
        }, projectId);

        await connection.execute(
          `
            UPDATE project_sprints
            SET name = ?,
                goal = ?,
                sprint_status = ?,
                start_date = ?,
                end_date = ?,
                updated_at = NOW()
            WHERE id = ?
              AND project_id = ?
          `,
          [
            sprint.name,
            sprint.goal,
            sprint.status,
            sprint.startDate,
            sprint.endDate,
            sprint.id,
            projectId,
          ],
        );

        return sprint;
      });
    },
    async updateProjectSprintStatus({ projectId, sprintId, status, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `
            SELECT id, name, goal, start_date AS startDate, end_date AS endDate, sort_order AS sortOrder
            FROM project_sprints
            WHERE id = ?
              AND project_id = ?
              AND deleted = 0
            LIMIT 1
          `,
          [sprintId, projectId],
        );
        const [projectRows] = await connection.execute(
          'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id || !rows[0]?.id) {
          return null;
        }

        await connection.execute(
          `
            UPDATE project_sprints
            SET sprint_status = ?,
                updated_at = NOW()
            WHERE id = ?
              AND project_id = ?
          `,
          [status, sprintId, projectId],
        );

        return normalizeSprint({
          ...rows[0],
          id: sprintId,
          projectId,
          status,
        }, projectId);
      });
    },
    async saveSprintStaffing({ projectId, sprintId, staffing, tenantId }) {
      return withTransaction(pool, async (connection) => {
        const [sprintRows] = await connection.execute(
          `
            SELECT id, name, goal, sprint_status AS status, start_date AS startDate, end_date AS endDate, sort_order AS sortOrder
            FROM project_sprints
            WHERE id = ?
              AND project_id = ?
              AND deleted = 0
            LIMIT 1
          `,
          [sprintId, projectId],
        );
        const [projectRows] = await connection.execute(
          'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id || !sprintRows[0]?.id) {
          return null;
        }

        const allowedUserIds = new Set((await listMySqlProjectMembers(connection, projectId, tenantId)).map((member) => member.id));
        const normalized = (Array.isArray(staffing) ? staffing : [])
          .filter((entry) => allowedUserIds.has(entry?.userId ?? ''))
          .map((entry) => normalizeSprintStaffingEntry(entry, sprintId));

        await connection.execute('DELETE FROM project_sprint_staffing WHERE sprint_id = ?', [sprintId]);

        for (const entry of normalized) {
          await connection.execute(
            `
              INSERT INTO project_sprint_staffing (
                id,
                sprint_id,
                user_id,
                capacity_hours,
                allocation_pct_override,
                notes,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
            `,
            [
              randomUUID(),
              sprintId,
              entry.userId,
              entry.capacityHours,
              entry.allocationPctOverride,
              entry.notes,
            ],
          );
        }

        return {
          sprint: normalizeSprint(sprintRows[0], projectId),
          staffing: normalized,
        };
      });
    },
    async listProjectChanges(args) {
      return listMysqlProjectChanges(pool, args);
    },
    // Changes written outside this repository (schedule dependencies) join the same log.
    observeItemRevisions(listener) {
      return revisionObservers.observe(listener);
    },
    async recordProjectChanges(entries) {
      await appendMysqlProjectChanges(pool, entries);
    },
    // Idempotency keys for odin_apply_item_changes (changes/item-change-requests.js).
    itemChangeRequests: createMysqlItemChangeRequests(pool),
    async listItemChanges(args) {
      return listMysqlItemChanges(pool, args);
    },
    // The newest `limit` comments on each target, oldest first, below `before` ({ createdAt, id })
    // when it pages back: one query for every target read from the newest, one more for each
    // paged back. Returns a Map of targetId to { comments, more }.
    async listItemComments({ limit, targets, tenantId }) {
      const result = new Map();
      const read = async (targetIds, before = null) => {
        if (!targetIds.length) return;
        const [rows] = await pool.query(
          `SELECT * FROM (
             SELECT c.id, c.user_id AS userId, c.target_id AS targetId, c.target_type AS targetType, c.parent_id AS parentId, c.comment,
               c.upvotes, c.downvotes, c.date_added AS createdAt, c.date_updated AS updatedAt, u.name AS authorName,
               ROW_NUMBER() OVER (PARTITION BY c.target_id ORDER BY c.date_added DESC, c.id DESC) AS rn
             FROM comments c
             LEFT JOIN users u ON u.id = c.user_id
             WHERE c.tenant_id = ? AND c.target_id IN (?) ${before ? 'AND (c.date_added < ? OR (c.date_added = ? AND c.id < ?))' : ''}
           ) ranked WHERE rn <= ? ORDER BY targetId, createdAt, id`,
          [tenantId, targetIds, ...(before ? [new Date(before.createdAt), new Date(before.createdAt), before.id] : []), limit + 1],
        );
        const named = await withResourceAuthorNames(pool, rows);
        for (const targetId of targetIds) {
          const own = named.filter((row) => row.targetId === targetId);
          // Rows come oldest first; the extra one, read to see whether more wait, is the oldest.
          const more = own.length > limit;
          result.set(targetId, { comments: (more ? own.slice(1) : own).map(serializeMysqlComment), more });
        }
      };
      await read(targets.filter((target) => !target.before).map((target) => target.targetId));
      for (const target of targets.filter((candidate) => candidate.before)) await read([target.targetId], target.before);
      return result;
    },
    // Links where any of the items is either end.
    async listRelationsForItems({ itemIds, projectId, tenantId }) {
      if (!itemIds.length) return [];
      const [rows] = await pool.query(
        `SELECT id, from_item_id AS fromItemId, to_item_id AS toItemId, relation_type AS relationType, created_by AS createdBy, created_at AS createdAt
         FROM work_item_relations WHERE tenant_id = ? AND project_id = ? AND (from_item_id IN (?) OR to_item_id IN (?)) ORDER BY created_at, id`,
        [tenantId, projectId, itemIds, itemIds],
      );
      return rows.map((row) => ({ ...row, createdAt: toIsoString(row.createdAt) }));
    },
    // How many comments each target has, and when the latest was written or edited.
    async listCommentActivity({ targetIds, tenantId }) {
      const ids = [...new Set(targetIds ?? [])];
      const activity = new Map();
      for (let start = 0; start < ids.length; start += 500) {
        const chunk = ids.slice(start, start + 500);
        const [rows] = await pool.query(
          `SELECT target_id AS targetId, COUNT(*) AS count, MAX(GREATEST(date_added, COALESCE(date_updated, date_added))) AS lastAt
           FROM comments WHERE tenant_id = ? AND target_id IN (?) GROUP BY target_id`,
          [tenantId, chunk],
        );
        for (const row of rows) activity.set(row.targetId, { count: Number(row.count), lastAt: row.lastAt ? toIsoString(row.lastAt) : null });
      }
      return activity;
    },
    async assignItemsToSprint({ assignments, projectId, tenantId, user }) {
      const updated = await withTransaction(pool, async (connection) => {
        const [projectRows] = await connection.execute(
          'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id) {
          return false;
        }

        const sprintIds = [...new Set((assignments ?? []).map((entry) => entry?.sprintId).filter(Boolean))];

        if (sprintIds.length > 0) {
          const [rows] = await connection.execute(
            `
              SELECT id
              FROM project_sprints
              WHERE project_id = ?
                AND deleted = 0
                AND id IN (${sprintIds.map(() => '?').join(', ')})
            `,
            [projectId, ...sprintIds],
          );

          if (rows.length !== sprintIds.length) {
            throw new HttpError(409, 'A target sprint no longer exists in this project.');
          }
        }
        const sprintsOf = async () => new Map((await connection.execute(
          'SELECT t.id, t.sprint_id AS sprintId, tt.task_type_name AS itemType FROM tasks t INNER JOIN task_types tt ON tt.id = t.task_type WHERE t.project_id = ? AND t.deleted = 0',
          [projectId],
        ))[0].map((row) => [row.id, row]));
        const sprintsBefore = await sprintsOf();
        for (const assignment of assignments ?? []) {
          const target = await validateTargetForProject(connection, {
            projectId,
            targetId: assignment.itemId,
            targetType: assignment.itemType,
            tenantId,
          });

          if (!target) {
            return false;
          }

          const sprintSortOrder = await getNextMySqlSprintSortOrder(connection, projectId, assignment.sprintId ?? null);

          await connection.execute(
            `
              UPDATE tasks
              SET sprint_id = ?,
                  sprint_sort_order = ?,
                  updated_at = NOW()
              WHERE id = ?
                AND project_id = ?
                AND deleted = 0
            `,
            [assignment.sprintId ?? null, sprintSortOrder, assignment.itemId, projectId],
          );

          if (assignment.itemType === 'story') {
            const [childRows] = await connection.execute(
              `
                SELECT id
                FROM tasks
                WHERE parent_task_id = ?
                  AND project_id = ?
                  AND deleted = 0
                ORDER BY COALESCE(sprint_sort_order, 999999), name, id
              `,
              [assignment.itemId, projectId],
            );

            for (const child of childRows) {
              const childSprintSortOrder = await getNextMySqlSprintSortOrder(connection, projectId, assignment.sprintId ?? null);

              await connection.execute(
                `
                  UPDATE tasks
                  SET sprint_id = ?,
                      sprint_sort_order = ?,
                      updated_at = NOW()
                  WHERE id = ?
                    AND project_id = ?
                    AND deleted = 0
                `,
                [assignment.sprintId ?? null, childSprintSortOrder, child.id, projectId],
              );
            }
          }
        }
        await appendMysqlProjectChanges(connection, [...await sprintsOf()].map(([itemId, after]) => {
          const from = sprintsBefore.get(itemId)?.sprintId ?? null;
          const to = after.sprintId ?? null;
          return from === to ? null : sprintChange({ actorId: user?.id ?? '', from, itemId, itemType: String(after.itemType ?? '').toLowerCase(), projectId, tenantId, to });
        }));
        return true;
      });

      if (!updated) {
        return null;
      }

      return getProjectDetail(pool, {
        projectId,
        tenantId,
      });
    },
    async splitStory({ input, projectId, storyId, tenantId, user }) {
      const planning = await buildMySqlSprintPlanningPayload(pool, projectId, tenantId);

      if (!planning?.project) {
        return null;
      }

      const project = planning.project;
      const storyContext = findStoryContextInProject(project, storyId);

      if (!storyContext) {
        return null;
      }

      const selectedTaskIds = new Set(input.taskIds ?? []);
      const movingTasks = (storyContext.story.tasks ?? []).filter((task) => selectedTaskIds.has(task.id));

      if (movingTasks.length === 0) {
        return null;
      }

      const movedPoints = movingTasks.reduce((sum, task) => sum + (Number(task.points ?? 0) || 0), 0);
      const movedHours = movingTasks.reduce((sum, task) => sum + (Number(task.targetHourEstimate ?? 0) || 0), 0);
      const nextStoryId = randomUUID();
      const sprintSortOrder = await getNextMySqlSprintSortOrder(pool, projectId, input.sprintId ?? null);
      const nextStory = normalizeTaskNode({
        assigneeId: input.assigneeId ?? storyContext.story.assigneeId ?? null,
        assigneeName: storyContext.story.assigneeName ?? '',
        description: input.description ?? storyContext.story.description ?? '',
        id: nextStoryId,
        name: input.name,
        points: input.points ?? (movedPoints || null),
        priority: input.priority ?? storyContext.story.priority ?? 4,
        sourceClarificationIds: input.sourceClarificationIds ?? storyContext.story.sourceClarificationIds ?? [],
        sprintId: input.sprintId ?? null,
        sprintSortOrder,
        status: input.status ?? storyContext.story.status ?? 'Not Started',
        targetEndDate: input.targetEndDate ?? storyContext.story.targetEndDate ?? null,
        targetHourEstimate: input.targetHourEstimate ?? (movedHours || null),
        targetStartDate: input.targetStartDate ?? storyContext.story.targetStartDate ?? null,
        tasks: movingTasks.map((task, index) => ({
          ...task,
          sprintId: input.sprintId ?? task.sprintId ?? null,
          sprintSortOrder: index,
        })),
      }, 'story');

      storyContext.story.tasks = (storyContext.story.tasks ?? []).filter((task) => !selectedTaskIds.has(task.id));

      if (storyContext.story.points != null) {
        storyContext.story.points = Math.max(0, Number(storyContext.story.points ?? 0) - movedPoints);
      }
      if (storyContext.story.targetHourEstimate != null) {
        storyContext.story.targetHourEstimate = Math.max(0, Number(storyContext.story.targetHourEstimate ?? 0) - movedHours);
      }

      storyContext.stories.splice(storyContext.storyIndex + 1, 0, nextStory);

      const savedIds = new Map();
      await withTransaction(pool, async (connection) => {
        const taskTypeIds = await getTaskTypeIds(connection, tenantId, projectId);
        const retainedIds = new Set();

        await upsertTaskNodes(connection, {
          parentTaskId: null,
          projectId,
          retainedIds,
          savedIds,
          taskNodes: project.epics ?? [],
          taskTypeIds,
          taskTypeName: 'Epic',
        });
        await markRemovedTasksDeleted(connection, projectId, retainedIds);
        await ensureMysqlAssigneeResources(connection, { projectId, tenantId, userIds: treeAssigneeIds(project.epics) });
        await appendMysqlProjectChanges(connection, splitStoryChanges({
          movedTaskIds: [...selectedTaskIds].map((id) => savedIds.get(id) ?? id), projectId, story: { ...nextStory, id: savedIds.get(nextStoryId) ?? nextStoryId }, storyId, tenantId, user,
        }));
      });

      // The new story was saved under an id of the insert's own.
      const savedStoryId = savedIds.get(nextStoryId) ?? nextStoryId;
      await safeQueueMentionEmailsMysql({
        html: nextStory.description ?? '',
        projectId,
        targetId: savedStoryId,
        targetType: 'story',
        tenantId,
        userId: input.assigneeId ?? storyContext.story.assigneeId ?? '',
      });

      const updatedProject = await getProjectDetail(pool, {
        projectId,
        tenantId,
      });
      const updatedStory = findStoryContextInProject(updatedProject, savedStoryId)?.story ?? null;

      return updatedProject && updatedStory
        ? {
            project: updatedProject,
            story: updatedStory,
          }
        : null;
    },
    async getKanbanConfig({ projectId, scope = 'delivery', tenantId, user }) {
      const project = await getProjectDetail(pool, { projectId, tenantId });

      if (!project) {
        return null;
      }

      const [rows] = await pool.execute(
        `
          SELECT value
          FROM preferences
          WHERE tenant_id = ?
            AND user_id = ?
            AND project_id = ?
            AND \`key\` = ?
          LIMIT 1
        `,
        [tenantId, user?.id ?? '', projectId, kanbanConfigKey(scope)],
      );

      if (!rows[0]?.value) {
        return createDefaultKanbanConfig();
      }

      try {
        return normalizeKanbanConfig(JSON.parse(rows[0].value));
      } catch (_error) {
        return createDefaultKanbanConfig();
      }
    },
    async saveKanbanConfig({ config, projectId, scope = 'delivery', tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const [projectRows] = await connection.execute(
          'SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id) {
          return null;
        }

        const normalized = normalizeKanbanConfig(config);
        await upsertProjectPreference(connection, {
          key: kanbanConfigKey(scope),
          projectId,
          tenantId,
          userId: user?.id ?? '',
          value: JSON.stringify(normalized),
        });

        return normalized;
      });
    },
    async reorderKanbanItem({ afterItemId, beforeItemId, itemId, projectId, scope = 'delivery', tenantId }) {
      const payload = await buildMySqlSprintPlanningPayload(pool, projectId, tenantId, { scope });

      if (!payload?.project) {
        return null;
      }

      return withTransaction(pool, async (connection) => {
        // Locking the project row serializes concurrent reorders, which each rewrite ranks.
        await connection.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? FOR UPDATE', [projectId, tenantId]);
        const ranks = await readMySqlKanbanRanks(connection, projectId);
        const nextIds = reorderKanbanItemIds(payload.project, ranks, { afterItemId, beforeItemId, itemId, scope });

        if (!nextIds) {
          return null;
        }

        const changed = nextIds
          .map((id, rank) => [id, rank])
          .filter(([id, rank]) => ranks.get(id) !== rank);

        for (let start = 0; start < changed.length; start += KANBAN_RANK_UPDATE_BATCH_SIZE) {
          const batch = changed.slice(start, start + KANBAN_RANK_UPDATE_BATCH_SIZE);
          await connection.execute(
            `UPDATE tasks SET board_sort_order = CASE id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END
             WHERE project_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
            [...batch.flat(), projectId, ...batch.map(([id]) => id)],
          );
        }

        return true;
      });
    },
    async getKanbanBoard({ filters, projectId, scope = 'delivery', tenantId, user }) {
      const payload = await buildMySqlSprintPlanningPayload(pool, projectId, tenantId, { scope });

      if (!payload?.project) {
        return null;
      }

      const savedConfig = await this.getKanbanConfig({
        projectId,
        scope,
        tenantId,
        user,
      });
      const effectiveFilters = kanbanFiltersForScope(normalizeKanbanConfig({
        ...savedConfig,
        ...filters,
      }), scope);
      const items = orderKanbanItems(
        kanbanFiltersProjectItems(buildPlanningItems(payload.project, { scope }), effectiveFilters),
        await readMySqlKanbanRanks(pool, projectId),
      );
      const statuses = projectStatusOptionsFromProject(scope === BOARD_SCOPE_PURSUIT ? onlyPursuitWork(payload.project) : payload.project);
      const columns = effectiveFilters.columns.length > 0
        ? effectiveFilters.columns
        : buildDefaultKanbanColumns(statuses);

      return {
        cards: placeKanbanCards(items, columns),
        columns,
        filters: effectiveFilters,
        members: payload.members,
        sprints: await listMySqlSprintRows(pool, projectId),
        swimlane: effectiveFilters.swimlane,
      };
    },
    async createProject({ input, tenantId, user }) {
      const projectId = await withTransaction(pool, async (connection) => {
        const projectStatusId = await getProjectStatusId(connection, input.status);
        const projectId = randomUUID();

        await connection.execute(
          `
            INSERT INTO projects (
              id,
              tenant_id,
              name,
              description,
              project_status,
              start_date,
              end_date,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `,
          [
            projectId,
            tenantId,
            input.name,
            normalizeStoredRichTextMarkdown(input.description),
            projectStatusId,
            input.startDate,
            input.endDate,
          ],
        );
        await connection.execute(
          `
            INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at)
            VALUES (?, ?, ?, 'admin', NOW(), NOW())
          `,
          [randomUUID(), user.id, projectId],
        );

        return projectId;
      });

      const project = await getProjectDetail(pool, {
        projectId,
        tenantId,
      });

      return {
        ...project,
        role: 'admin',
      };
    },
    // Removes a project created moments ago whose template could not be applied.
    async discardCreatedProject({ projectId, tenantId }) {
      const obsoleteKeys = new Set();
      await withTransaction(pool, (connection) => deleteProjectArchiveRecordsMysql(connection, { obsoleteKeys, projectId, tenantId }));
      await deleteStoredObjects(obsoleteKeys);
      return true;
    },
    async updateProject({ input, projectId, tenantId, user }) {
      let mentionedBefore = [];
      const updated = await withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          'SELECT id, updated_at AS updatedAt, description FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE',
          [projectId, tenantId],
        );

        if (!rows[0]?.id) {
          return false;
        }
        requireExpectedProjectVersion(input.expectedUpdatedAt, rowDate(rows[0].updatedAt));
        // Saving a description emails only people it newly mentions: a rename shouldn't email again.
        mentionedBefore = extractMentionSpans(renderStoredRichTextToHtml(rows[0].description ?? '')).map((span) => span.userId);

        const projectStatusId = await getProjectStatusId(connection, input.status);

        await connection.execute(
          `
            UPDATE projects
            SET name = ?,
                description = ?,
                project_status = ?,
                start_date = ?,
                end_date = ?,
                updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3)))
            WHERE id = ?
              AND tenant_id = ?
          `,
          [
            input.name,
            normalizeStoredRichTextMarkdown(input.description),
            projectStatusId,
            input.startDate,
            input.endDate,
            projectId,
            tenantId,
          ],
        );
        await appendMysqlProjectChanges(connection, [{ action: 'update', actorId: user?.id ?? '', entityId: projectId, entityType: 'project', projectId, tenantId }]);
        return true;
      });

      if (!updated) {
        return null;
      }

      await safeQueueMentionEmailsMysql({
        html: renderStoredRichTextToHtml(input.description),
        projectId,
        skipUserIds: mentionedBefore,
        targetId: projectId,
        targetType: 'project',
        tenantId,
        userId: user?.id ?? '',
      });

      return getProjectDetail(pool, {
        projectId,
        tenantId,
      });
    },
    async replaceProjectTree({ input, projectId, tenantId, user }) {
      const updated = await withTransaction(pool, async (connection) => {
        const [projectRows] = await connection.execute(
          'SELECT id, updated_at AS updatedAt FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE',
          [projectId, tenantId],
        );

        if (!projectRows[0]?.id) {
          return false;
        }
        requireExpectedProjectVersion(input.expectedUpdatedAt, rowDate(projectRows[0].updatedAt));

        const beforeProject = await getProjectDetail(connection, { projectId, tenantId });
        const taskTypeIds = await getTaskTypeIds(connection, tenantId, projectId);
        const retainedIds = new Set();

        await upsertTaskNodes(connection, {
          parentTaskId: null,
          projectId,
          retainedIds,
          taskNodes: input.epics ?? [],
          taskTypeIds,
          taskTypeName: 'Epic',
        });
        await markRemovedTasksDeleted(connection, projectId, retainedIds);
        await ensureMysqlAssigneeResources(connection, { projectId, tenantId, userIds: treeAssigneeIds(input.epics) });
        await connection.execute('UPDATE projects SET updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3))) WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);

        const afterProject = await getProjectDetail(connection, { projectId, tenantId });
        const beforeSnapshots = flattenProjectItemSnapshots(beforeProject);
        const afterSnapshots = flattenProjectItemSnapshots(afterProject);
        for (const itemId of new Set([...beforeSnapshots.keys(), ...afterSnapshots.keys()])) {
          const before = beforeSnapshots.get(itemId) ?? null;
          const after = afterSnapshots.get(itemId) ?? null;
          if (!projectItemSnapshotChanged(before, after)) continue;
          const versionBefore = before?.node?.version ?? null;
          const versionAfter = after?.node?.version ?? (Number(versionBefore ?? 0) + 1);
          await insertMysqlProjectItemRevision(connection, {
            action: !before ? 'create' : !after ? 'delete' : 'update', actorUserId: user?.id ?? '', after, before,
            id: randomUUID(), itemId, itemType: after?.itemType ?? before.itemType, projectId, tenantId, versionAfter, versionBefore,
          });
        }

        return true;
      });

      if (!updated) {
        return null;
      }

      const walk = async (node, type) => {
        await safeQueueMentionEmailsMysql({
          html: renderStoredRichTextToHtml(node.description ?? ''),
          projectId,
          targetId: node.id,
          targetType: type,
          tenantId,
          userId: user?.id ?? '',
        });

        if (type === 'epic') {
          for (const story of node.stories ?? []) {
            await walk(story, 'story');
          }
        } else if (type === 'story') {
          for (const task of node.tasks ?? []) {
            await walk(task, 'task');
          }
        }
      };

      for (const epic of input.epics ?? []) {
        await walk(epic, 'epic');
      }

      return getProjectDetail(pool, {
        projectId,
        tenantId,
      });
    },
    async createTicketIntakeInvitation({ input, projectId, tenantId, user }) {
      const [projects] = await pool.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1', [projectId, tenantId]);
      if (!projects[0]) return null;

      const id = randomUUID();
      const intakeToken = randomUUID().replace(/-/g, '');
      const replyToken = randomUUID().replace(/-/g, '');
      await pool.execute(
        `INSERT INTO ticket_intake_invitations (id, tenant_id, project_id, reporter_email, reporter_name, intake_token, reply_token, expires_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
        [id, tenantId, projectId, input.reporterEmail, input.reporterName ?? '', intakeToken, replyToken,
          input.expiresAt ? toMysqlDateTime(input.expiresAt) : null, user?.id ?? ''],
      );
      return this.getTicketIntakeInvitationByToken({ intakeToken });
    },
    async listTicketIntakeInvitations({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT id, tenant_id AS tenantId, project_id AS projectId, reporter_email AS reporterEmail, reporter_name AS reporterName,
                intake_token AS intakeToken, reply_token AS replyToken, expires_at AS expiresAt, revoked_at AS revokedAt,
                submission_count AS submissionCount, last_submitted_at AS lastSubmittedAt, created_by AS createdBy, created_at AS createdAt
         FROM ticket_intake_invitations WHERE tenant_id = ? AND project_id = ? ORDER BY created_at DESC`,
        [tenantId, projectId],
      );
      return rows.map((row) => ({
        ...row,
        createdAt: toIsoString(row.createdAt),
        expiresAt: row.expiresAt ? toIsoString(row.expiresAt) : null,
        lastSubmittedAt: row.lastSubmittedAt ? toIsoString(row.lastSubmittedAt) : null,
        revokedAt: row.revokedAt ? toIsoString(row.revokedAt) : null,
        submissionCount: Number(row.submissionCount ?? 0),
      }));
    },
    async revokeTicketIntakeInvitation({ invitationId, projectId, tenantId }) {
      const [result] = await pool.execute(
        'UPDATE ticket_intake_invitations SET revoked_at = NOW(3), updated_at = NOW(3) WHERE id = ? AND project_id = ? AND tenant_id = ? AND revoked_at IS NULL',
        [invitationId, projectId, tenantId],
      );
      return Number(result?.affectedRows ?? 0) > 0;
    },
    // Expired and revoked tokens return null exactly like unknown ones, so a caller
    // cannot distinguish the cases or learn whether the project exists.
    async getTicketIntakeInvitationByToken({ intakeToken }) {
      const [rows] = await pool.execute(
        `SELECT id, tenant_id AS tenantId, project_id AS projectId, reporter_email AS reporterEmail, reporter_name AS reporterName,
                intake_token AS intakeToken, reply_token AS replyToken, expires_at AS expiresAt, revoked_at AS revokedAt,
                submission_count AS submissionCount, last_submitted_at AS lastSubmittedAt, created_by AS createdBy, created_at AS createdAt
         FROM ticket_intake_invitations
         WHERE intake_token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW(3))
         LIMIT 1`,
        [intakeToken],
      );
      if (!rows[0]) return null;
      return {
        ...rows[0],
        createdAt: toIsoString(rows[0].createdAt),
        expiresAt: rows[0].expiresAt ? toIsoString(rows[0].expiresAt) : null,
        lastSubmittedAt: rows[0].lastSubmittedAt ? toIsoString(rows[0].lastSubmittedAt) : null,
        revokedAt: null,
        submissionCount: Number(rows[0].submissionCount ?? 0),
      };
    },
    async getTicketIntakeInvitationByReplyToken({ replyToken }) {
      const [rows] = await pool.execute(
        `SELECT id, tenant_id AS tenantId, project_id AS projectId, reporter_email AS reporterEmail, reporter_name AS reporterName,
                intake_token AS intakeToken, reply_token AS replyToken
         FROM ticket_intake_invitations WHERE reply_token = ? AND revoked_at IS NULL LIMIT 1`,
        [replyToken],
      );
      return rows[0] ?? null;
    },
    // Unlike the token lookups this returns revoked and expired invitations too; callers decide.
    async getTicketIntakeInvitationById({ invitationId, projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT id, tenant_id AS tenantId, project_id AS projectId, reporter_email AS reporterEmail, reporter_name AS reporterName,
                intake_token AS intakeToken, reply_token AS replyToken, expires_at AS expiresAt, revoked_at AS revokedAt
         FROM ticket_intake_invitations WHERE id = ? AND project_id = ? AND tenant_id = ? LIMIT 1`,
        [invitationId, projectId, tenantId],
      );
      if (!rows[0]) return null;
      return {
        ...rows[0],
        expiresAt: rows[0].expiresAt ? toIsoString(rows[0].expiresAt) : null,
        revokedAt: rows[0].revokedAt ? toIsoString(rows[0].revokedAt) : null,
      };
    },
    async recordTicketIntakeSubmission({ invitationId }) {
      await pool.execute(
        'UPDATE ticket_intake_invitations SET submission_count = submission_count + 1, last_submitted_at = NOW(3), updated_at = NOW(3) WHERE id = ?',
        [invitationId],
      );
      return true;
    },
    async listTickets({ filters = {}, tenantId, user }) {
      const visible = await this.listProjectsForTenant({ tenantId, user });
      const scoped = filters.projectIds?.length
        ? visible.filter((project) => filters.projectIds.includes(project.id))
        : visible;
      // A ticket in an unauthorized project is absent, not redacted.
      if (scoped.length === 0) return { nextCursor: null, tickets: [], total: 0 };

      const projectNames = new Map(scoped.map((project) => [project.id, project.name]));
      const placeholders = scoped.map(() => '?').join(', ');
      const [rows] = await pool.execute(
        `SELECT t.*, tt.task_type_name AS item_type
         FROM tasks t
         INNER JOIN task_types tt ON tt.id = t.task_type
         WHERE t.deleted = 0 AND tt.task_type_name = 'Ticket' AND t.project_id IN (${placeholders})`,
        scoped.map((project) => project.id),
      );

      const matched = [];
      for (const row of rows) {
        const status = await getTaskStatus(pool, row.id);
        const assignee = await getTaskAssignee(pool, row.id);
        const ticket = {
          assigneeId: assignee.assigneeId,
          assigneeName: assignee.assigneeName,
          boardColumn: row.board_column ?? null,
          description: normalizeStoredRichTextMarkdown(row.description ?? ''),
          id: row.id,
          name: row.name,
          parentId: row.parent_task_id ?? null,
          points: row.points == null ? null : Number(row.points),
          priority: row.priority == null ? 4 : Number(row.priority),
          projectId: row.project_id,
          projectName: projectNames.get(row.project_id) ?? '',
          sprintId: row.sprint_id ?? null,
          status,
          targetEndDate: dateOnlyValue(row.target_end_date),
          targetHourEstimate: row.target_hour_estimate == null ? null : Number(row.target_hour_estimate),
          targetStartDate: dateOnlyValue(row.target_start_date),
          updatedAt: toIsoString(row.updated_at),
          version: Number(row.version ?? 1),
          ...ticketFieldsFromRow(row),
        };
        if (matchesTicketFilters(ticket, filters)) matched.push(ticket);
      }

      const sorted = sortTicketsForListing(matched);
      const cursor = decodeTicketCursor(filters.cursor);
      const startIndex = cursor ? sorted.findIndex((ticket) => ticket.id === cursor.id) + 1 : 0;
      const limit = filters.limit ?? 50;
      const page = sorted.slice(Math.max(0, startIndex), Math.max(0, startIndex) + limit);

      return {
        nextCursor: page.length === limit && startIndex + page.length < sorted.length ? encodeTicketCursor(page[page.length - 1]) : null,
        tickets: page,
        total: sorted.length,
      };
    },
    async listWorkItemRelations({ itemId, projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT id, from_item_id AS fromItemId, to_item_id AS toItemId, relation_type AS relationType, created_by AS createdBy, created_at AS createdAt, project_id AS projectId, tenant_id AS tenantId
         FROM work_item_relations
         WHERE tenant_id = ? AND project_id = ?${itemId ? ' AND (from_item_id = ? OR to_item_id = ?)' : ''}
         ORDER BY created_at, id`,
        itemId ? [tenantId, projectId, itemId, itemId] : [tenantId, projectId],
      );
      return rows.map((row) => ({ ...row, createdAt: toIsoString(row.createdAt) }));
    },
    async createWorkItemRelation({ input, itemId, projectId, tenantId, user }) {
      if (itemId === input.toItemId) throw new HttpError(400, 'A work item cannot relate to itself.');
      const from = await getMysqlProjectItemRow(pool, { itemId, projectId, tenantId });
      if (!from || from.deleted) throw new HttpError(404, 'Project item not found.');
      // Relations may not cross a project boundary.
      const to = await getMysqlProjectItemRow(pool, { itemId: input.toItemId, projectId, tenantId });
      if (!to || to.deleted) throw new HttpError(400, 'Related work items must belong to the same project.');

      const id = randomUUID();
      // The unique key makes a repeated create idempotent rather than duplicated.
      await pool.execute(
        `INSERT INTO work_item_relations (id, tenant_id, project_id, from_item_id, to_item_id, relation_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE id = id`,
        [id, tenantId, projectId, itemId, input.toItemId, input.relationType, user?.id ?? ''],
      );
      const [rows] = await pool.execute(
        `SELECT id, from_item_id AS fromItemId, to_item_id AS toItemId, relation_type AS relationType, created_by AS createdBy, created_at AS createdAt, project_id AS projectId, tenant_id AS tenantId
         FROM work_item_relations WHERE from_item_id = ? AND to_item_id = ? AND relation_type = ? LIMIT 1`,
        [itemId, input.toItemId, input.relationType],
      );
      // The row is new only if it has the id generated here. affectedRows can't tell: mysql2 sets
      // FOUND_ROWS, under which a duplicate left as it was counts as 1, like an insert.
      if (rows[0]?.id === id) await appendMysqlProjectChanges(pool, [relationChange({ action: 'create', actorId: user?.id ?? '', projectId, relation: rows[0], tenantId })]);
      return rows[0] ? { created: rows[0].id === id, relation: { ...rows[0], createdAt: toIsoString(rows[0].createdAt) } } : null;
    },
    async deleteWorkItemRelation({ projectId, relationId, tenantId, user }) {
      const [found] = await pool.execute(
        'SELECT id, from_item_id AS fromItemId, to_item_id AS toItemId, relation_type AS relationType FROM work_item_relations WHERE id = ? AND project_id = ? AND tenant_id = ?',
        [relationId, projectId, tenantId],
      );
      const [result] = await pool.execute(
        'DELETE FROM work_item_relations WHERE id = ? AND project_id = ? AND tenant_id = ?',
        [relationId, projectId, tenantId],
      );
      const deleted = Number(result?.affectedRows ?? 0) > 0;
      if (deleted && found[0]) await appendMysqlProjectChanges(pool, [relationChange({ action: 'delete', actorId: user?.id ?? '', projectId, relation: found[0], tenantId })]);
      return deleted;
    },
    async createProjectItem({ input, projectId, tenantId, user }) {
      const itemId = String(input.item?.id ?? '').trim() || randomUUID();
      if (itemId.length > 36) throw new HttpError(400, 'Project item ids cannot exceed 36 characters.');
      const revision = await withTransaction(pool, async (connection) => {
        const [projects] = await connection.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [projectId, tenantId]);
        if (!projects[0]) return null;
        if (await getMysqlProjectItemRow(connection, { itemId, projectId, tenantId })) throw new HttpError(409, 'A project item with this id already exists.');
        await requireMysqlProjectItemParent(connection, { itemType: input.itemType, parentId: input.parentId ?? null, projectId, tenantId });
        const taskTypeIds = await getTaskTypeIds(connection, tenantId, projectId);
        const taskTypeId = taskTypeIds[input.itemType[0].toUpperCase() + input.itemType.slice(1)];
        if (!taskTypeId) throw new HttpError(409, `Task type ${input.itemType} is not configured for this project.`);
        const nextPosition = await nextMysqlProjectItemPosition(connection, { parentId: input.parentId ?? null, projectId, taskTypeId });
        const position = Math.min(input.position ?? nextPosition, nextPosition);
        if (input.parentId) {
          await connection.execute('UPDATE tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0 AND sort_order >= ?', [projectId, taskTypeId, input.parentId, position]);
        } else {
          await connection.execute('UPDATE tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0 AND sort_order >= ?', [projectId, taskTypeId, position]);
        }
        const item = input.item;
        const isTicket = input.itemType === 'ticket';
        if (isTicket) {
          await requireTicketReferences(connection, { item, projectId, tenantId });
        }
        await connection.execute(
          `INSERT INTO tasks (id, project_id, task_type, parent_task_id, name, description, priority, points, target_start_date, target_end_date, target_hour_estimate, source_clarification_ids, sprint_id, sprint_sort_order, board_column, sort_order, percent_complete, actual_hours, estimate_override, remaining_hours, created_at, updated_at, version, deleted${isTicket ? ', category, severity, repro_steps, expected_result, actual_result, environment_id, build_version, found_in_release_id, fixed_in_release_id, reporter_external_id, external_review_state' : ''})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3), 1, 0${isTicket ? ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' : ''})`,
          [itemId, projectId, taskTypeId, input.parentId ?? null, item.name, normalizeStoredRichTextMarkdown(item.description ?? ''), item.priority ?? 4,
            item.points ?? null, item.targetStartDate ?? null, item.targetEndDate ?? null, item.targetHourEstimate ?? null,
            item.sourceClarificationIds?.length ? JSON.stringify(item.sourceClarificationIds) : null, item.sprintId ?? null, item.sprintSortOrder ?? null, normalizeBoardColumnKey(item.boardColumn), position,
            normalizePercentComplete(item.percentComplete), normalizeActualHours(item.actualHours), estimateOverrideFlag(item.estimateOverride),
            normalizeRemainingHours(item.remainingHours),
            ...(isTicket
              ? [item.category ?? 'defect', item.severity ?? 'S3', item.reproSteps ?? '', item.expectedResult ?? '', item.actualResult ?? '',
                item.environmentId ?? null, item.buildVersion ?? '', item.foundInReleaseId ?? null, item.fixedInReleaseId ?? null,
                item.reporterExternalId ?? null, item.externalReviewState ?? 'not_external']
              : [])],
        );
        await insertTaskLog(connection, itemId, 'assign', { assigned_to: item.assigneeId ?? null });
        await ensureMysqlAssigneeResources(connection, { projectId, tenantId, userIds: [item.assigneeId] });
        await insertTaskLog(connection, itemId, 'status_change', { status: item.status ?? 'Not Started' });
        // A story or task under the Pursuit epic is pursuit work.
        if (input.parentId) await syncMysqlPursuitMarker(connection, { itemId, projectId });
        const row = await getMysqlProjectItemRow(connection, { itemId, projectId, tenantId });
        const after = await mysqlProjectItemSnapshot(connection, row);
        const created = { action: 'create', actorUserId: user?.id ?? '', after, before: null, createdAt: new Date().toISOString(), id: randomUUID(), itemId, itemType: input.itemType, projectId, tenantId, versionAfter: 1, versionBefore: null };
        await insertMysqlProjectItemRevision(connection, created);
        await connection.execute('UPDATE projects SET updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3))) WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);
        return created;
      });
      if (!revision) return null;
      const project = await getProjectDetail(pool, { includePursuit: true, projectId, tenantId });
      return { item: findProjectItemContext(project, itemId)?.node ?? null, project, revision };
    },
    async updateProjectItem({ input, itemId, projectId, tenantId, user, verifyTicketContent = null }) {
      const revision = await withTransaction(pool, async (connection) => {
        const row = await getMysqlProjectItemRow(connection, { forUpdate: true, itemId, projectId, tenantId });
        if (!row || row.deleted) return null;
        projectItemConflict(input.expectedVersion, row.version);
        const itemType = String(row.item_type).toLowerCase();
        const before = await mysqlProjectItemSnapshot(connection, row);
        if (verifyTicketContent) {
          // The row is locked; the comment and file reads lock theirs, so what is verified here is
          // what commits.
          const target = { projectId, targetId: itemId, targetType: 'ticket', tenantId };
          const comments = buildCommentTree((await listCommentRows(connection, { ...target, lock: true })).map((entry) => serializeMysqlComment(entry)));
          const attachments = (await listTargetFileRows(connection, { ...target, lock: true })).map((entry) => serializeMysqlFile(entry));
          verifyTicketContent({ attachments, comments, ticket: before.node });
        }
        const nextParentId = input.parentId === undefined ? row.parent_task_id : input.parentId;
        await requireMysqlProjectItemParent(connection, { itemType, parentId: nextParentId ?? null, projectId, tenantId });
        const nextPositionAvailable = await nextMysqlProjectItemPosition(connection, { parentId: nextParentId ?? null, projectId, taskTypeId: row.task_type });
        const requestedPosition = input.position === undefined ? Number(row.sort_order) : Math.min(input.position, Math.max(0, nextPositionAvailable - (nextParentId === row.parent_task_id ? 1 : 0)));
        if (nextParentId !== row.parent_task_id || requestedPosition !== Number(row.sort_order)) {
          if (row.parent_task_id) {
            await connection.execute('UPDATE tasks SET sort_order = sort_order - 1 WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0 AND sort_order > ?', [projectId, row.task_type, row.parent_task_id, row.sort_order]);
          } else {
            await connection.execute('UPDATE tasks SET sort_order = sort_order - 1 WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0 AND sort_order > ?', [projectId, row.task_type, row.sort_order]);
          }
          if (nextParentId) {
            await connection.execute('UPDATE tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0 AND sort_order >= ?', [projectId, row.task_type, nextParentId, requestedPosition]);
          } else {
            await connection.execute('UPDATE tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0 AND sort_order >= ?', [projectId, row.task_type, requestedPosition]);
          }
        }
        const patch = input.patch ?? {};
        const columns = [];
        const params = [];
        const fieldMap = {
          actualHours: ['actual_hours', normalizeActualHours],
          estimateOverride: ['estimate_override', estimateOverrideFlag],
          description: ['description', (value) => normalizeStoredRichTextMarkdown(value ?? '')], name: ['name', String], percentComplete: ['percent_complete', normalizePercentComplete],
          points: ['points', (value) => value ?? null], priority: ['priority', Number], remainingHours: ['remaining_hours', normalizeRemainingHours],
          sprintId: ['sprint_id', (value) => value ?? null], sprintSortOrder: ['sprint_sort_order', (value) => value ?? null],
          sourceClarificationIds: ['source_clarification_ids', (value) => value?.length ? JSON.stringify(value) : null], targetEndDate: ['target_end_date', (value) => value ?? null],
          targetHourEstimate: ['target_hour_estimate', (value) => value ?? null], targetStartDate: ['target_start_date', (value) => value ?? null],
        };
        if (itemType === 'ticket') {
          await requireTicketReferences(connection, { item: patch, projectId, tenantId });
          Object.assign(fieldMap, {
            actualResult: ['actual_result', (value) => value ?? ''],
            buildVersion: ['build_version', (value) => value ?? ''],
            category: ['category', (value) => value ?? 'defect'],
            environmentId: ['environment_id', (value) => value ?? null],
            expectedResult: ['expected_result', (value) => value ?? ''],
            externalReviewState: ['external_review_state', (value) => value ?? 'not_external'],
            fixedInReleaseId: ['fixed_in_release_id', (value) => value ?? null],
            foundInReleaseId: ['found_in_release_id', (value) => value ?? null],
            lastReopenedAt: ['last_reopened_at', (value) => (value ? new Date(value) : null)],
            reopenCount: ['reopen_count', Number],
            reproSteps: ['repro_steps', (value) => value ?? ''],
            severity: ['severity', (value) => value ?? 'S3'],
          });
        }
        for (const [key, [column, normalize]] of Object.entries(fieldMap)) {
          if (patch[key] !== undefined) { columns.push(`${column} = ?`); params.push(normalize(patch[key])); }
        }
        const nextBoardColumn = resolveBoardColumnForPatch(before.node, patch);
        if (nextBoardColumn !== before.node.boardColumn) { columns.push('board_column = ?'); params.push(nextBoardColumn); }
        columns.push('parent_task_id = ?', 'sort_order = ?', 'version = version + 1', 'updated_at = NOW(3)');
        params.push(nextParentId ?? null, requestedPosition, itemId, projectId);
        await connection.execute(`UPDATE tasks SET ${columns.join(', ')} WHERE id = ? AND project_id = ?`, params);
        if ((nextParentId ?? null) !== (row.parent_task_id ?? null)) await syncMysqlPursuitMarker(connection, { itemId, projectId });
        if (patch.assigneeId !== undefined) {
          await insertTaskLog(connection, itemId, 'assign', { assigned_to: patch.assigneeId ?? null });
          await ensureMysqlAssigneeResources(connection, { projectId, tenantId, userIds: [patch.assigneeId] });
        }
        if (patch.status !== undefined) await insertTaskLog(connection, itemId, 'status_change', { status: patch.status });
        if (itemType === 'ticket' && patch.reopenCount !== undefined) await insertTaskLog(connection, itemId, 'reopen', { reopen_count: Number(patch.reopenCount) });
        if (itemType === 'story' && patch.status !== undefined && storyCompletionCascades(before.node.status, patch.status)) {
          await completeMysqlStoryTasks(connection, { projectId, storyId: itemId, tenantId, user });
        }
        const updatedRow = await getMysqlProjectItemRow(connection, { itemId, projectId, tenantId });
        const after = await mysqlProjectItemSnapshot(connection, updatedRow);
        const updated = { action: 'update', actorUserId: user?.id ?? '', after, before, createdAt: new Date().toISOString(), id: randomUUID(), itemId, itemType, projectId, tenantId, versionAfter: Number(row.version) + 1, versionBefore: Number(row.version) };
        await insertMysqlProjectItemRevision(connection, updated);
        await connection.execute('UPDATE projects SET updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3))) WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);
        return updated;
      });
      if (!revision) return null;
      const project = await getProjectDetail(pool, { includePursuit: true, projectId, tenantId });
      return { item: findProjectItemContext(project, itemId)?.node ?? null, project, revision };
    },
    async deleteProjectItem({ expectedVersion, itemId, projectId, tenantId, user, withoutDependents = false }) {
      const revision = await withTransaction(pool, async (connection) => {
        const row = await getMysqlProjectItemRow(connection, { forUpdate: true, itemId, projectId, tenantId });
        if (!row || row.deleted) return null;
        projectItemConflict(expectedVersion, row.version);
        const [children] = await connection.execute('SELECT id FROM tasks WHERE parent_task_id = ? AND project_id = ? AND deleted = 0 LIMIT 1', [itemId, projectId]);
        if (children[0]) throw new HttpError(409, 'Delete child items before deleting this project item.');
        if (withoutDependents) {
          for (const [sql, params] of [
            ['SELECT id FROM work_item_relations WHERE project_id = ? AND (from_item_id = ? OR to_item_id = ?) LIMIT 1', [projectId, itemId, itemId]],
            ['SELECT id FROM comments WHERE tenant_id = ? AND target_id = ? LIMIT 1', [tenantId, itemId]],
            ['SELECT id FROM file_vault WHERE tenant_id = ? AND target_id = ? LIMIT 1', [tenantId, itemId]],
            ['SELECT id FROM file_links WHERE tenant_id = ? AND target_id = ? LIMIT 1', [tenantId, itemId]],
            ['SELECT id FROM project_time_entries WHERE tenant_id = ? AND work_item_id = ? LIMIT 1', [tenantId, itemId]],
          ]) {
            // A table not made yet holds nothing.
            const [rows] = await connection.execute(sql, params).catch((error) => { if (error?.code === 'ER_NO_SUCH_TABLE') return [[]]; throw error; });
            if (rows.length) throw itemHasDependents();
          }
        }
        const before = await mysqlProjectItemSnapshot(connection, row);
        await connection.execute('UPDATE tasks SET deleted = 1, version = version + 1, updated_at = NOW(3) WHERE id = ? AND project_id = ?', [itemId, projectId]);
        if (row.parent_task_id) {
          await connection.execute('UPDATE tasks SET sort_order = sort_order - 1 WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0 AND sort_order > ?', [projectId, row.task_type, row.parent_task_id, row.sort_order]);
        } else {
          await connection.execute('UPDATE tasks SET sort_order = sort_order - 1 WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0 AND sort_order > ?', [projectId, row.task_type, row.sort_order]);
        }
        // Relations in both directions go with the item, leaving no orphan rows.
        await connection.execute(
          'DELETE FROM work_item_relations WHERE project_id = ? AND (from_item_id = ? OR to_item_id = ?)',
          [projectId, itemId, itemId],
        ).catch(() => {});
        await insertTaskLog(connection, itemId, 'deleted', { deleted: true });
        const deleted = { action: 'delete', actorUserId: user?.id ?? '', after: null, before, createdAt: new Date().toISOString(), id: randomUUID(), itemId, itemType: String(row.item_type).toLowerCase(), projectId, tenantId, versionAfter: Number(row.version) + 1, versionBefore: Number(row.version) };
        await insertMysqlProjectItemRevision(connection, deleted);
        await connection.execute('UPDATE projects SET updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3))) WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);
        return deleted;
      });
      if (!revision) return null;
      return { item: null, project: await getProjectDetail(pool, { includePursuit: true, projectId, tenantId }), revision };
    },
    async listProjectItemRevisions({ itemId, limit = 25, projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT id, tenant_id AS tenantId, project_id AS projectId, item_id AS itemId, item_type AS itemType, action,
                version_before AS versionBefore, version_after AS versionAfter, before_json AS beforeJson, after_json AS afterJson,
                actor_user_id AS actorUserId, created_at AS createdAt
         FROM project_item_revisions WHERE tenant_id = ? AND project_id = ? AND item_id = ? ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 25))}`,
        [tenantId, projectId, itemId],
      );
      return withRevisionActorNames(pool, rows.map(mapMysqlProjectItemRevision));
    },
    async restoreProjectItemRevision({ expectedVersion, itemId, projectId, revisionId, revisionState = 'after', tenantId, user }) {
      const revision = await withTransaction(pool, async (connection) => {
        const row = await getMysqlProjectItemRow(connection, { forUpdate: true, itemId, projectId, tenantId });
        if (!row) return null;
        projectItemConflict(expectedVersion, row.version);
        const [revisionRows] = await connection.execute(
          `SELECT id, tenant_id AS tenantId, project_id AS projectId, item_id AS itemId, item_type AS itemType, action,
                  version_before AS versionBefore, version_after AS versionAfter, before_json AS beforeJson, after_json AS afterJson,
                  actor_user_id AS actorUserId, created_at AS createdAt
           FROM project_item_revisions WHERE id = ? AND tenant_id = ? AND project_id = ? AND item_id = ? LIMIT 1`,
          [revisionId, tenantId, projectId, itemId],
        );
        if (!revisionRows[0]) throw new HttpError(404, 'Project item revision not found.');
        const selected = mapMysqlProjectItemRevision(revisionRows[0]);
        const target = revisionState === 'before' ? selected.before : (selected.after ?? selected.before);
        if (!target) throw new HttpError(409, 'This revision has no restorable item state.');
        const itemType = String(row.item_type).toLowerCase();
        if (target.itemType !== itemType) throw new HttpError(409, 'A project item cannot be restored as a different type.');
        await requireMysqlProjectItemParent(connection, { itemType, parentId: target.parentId ?? null, projectId, tenantId });
        const before = await mysqlProjectItemSnapshot(connection, row);
        const node = target.node;
        if (!row.deleted) {
          if (row.parent_task_id) {
            await connection.execute('UPDATE tasks SET sort_order = sort_order - 1 WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0 AND id <> ? AND sort_order > ?', [projectId, row.task_type, row.parent_task_id, itemId, row.sort_order]);
          } else {
            await connection.execute('UPDATE tasks SET sort_order = sort_order - 1 WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0 AND id <> ? AND sort_order > ?', [projectId, row.task_type, itemId, row.sort_order]);
          }
        }
        const availablePosition = await nextMysqlProjectItemPosition(connection, { parentId: target.parentId ?? null, projectId, taskTypeId: row.task_type });
        const restoredPosition = Math.min(target.position ?? availablePosition, availablePosition);
        if (target.parentId) {
          await connection.execute('UPDATE tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0 AND id <> ? AND sort_order >= ?', [projectId, row.task_type, target.parentId, itemId, restoredPosition]);
        } else {
          await connection.execute('UPDATE tasks SET sort_order = sort_order + 1 WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0 AND id <> ? AND sort_order >= ?', [projectId, row.task_type, itemId, restoredPosition]);
        }
        // Revisions recorded before a tracking field existed leave its stored value alone.
        const tracking = [
          ['percent_complete', node.percentComplete, normalizePercentComplete],
          ['actual_hours', node.actualHours, normalizeActualHours],
          ['estimate_override', node.estimateOverride, estimateOverrideFlag],
          ['remaining_hours', node.remainingHours, normalizeRemainingHours],
        ].filter(([, value]) => value !== undefined);
        await connection.execute(
          `UPDATE tasks SET parent_task_id = ?, name = ?, description = ?, priority = ?, points = ?, target_start_date = ?, target_end_date = ?,
             target_hour_estimate = ?, source_clarification_ids = ?, sprint_id = ?, sprint_sort_order = ?, board_column = ?, sort_order = ?, deleted = 0,${tracking.map(([column]) => ` ${column} = ?,`).join('')}
             version = version + 1, updated_at = NOW(3) WHERE id = ? AND project_id = ?`,
          [target.parentId ?? null, node.name, normalizeStoredRichTextMarkdown(node.description ?? ''), node.priority ?? 4, node.points ?? null,
            node.targetStartDate ?? null, node.targetEndDate ?? null, node.targetHourEstimate ?? null,
            node.sourceClarificationIds?.length ? JSON.stringify(node.sourceClarificationIds) : null, node.sprintId ?? null, node.sprintSortOrder ?? null,
            normalizeBoardColumnKey(node.boardColumn), restoredPosition, ...tracking.map(([, value, normalize]) => normalize(value)), itemId, projectId],
        );
        await insertTaskLog(connection, itemId, 'assign', { assigned_to: node.assigneeId ?? null });
        await ensureMysqlAssigneeResources(connection, { projectId, tenantId, userIds: [node.assigneeId] });
        await insertTaskLog(connection, itemId, 'status_change', { status: node.status ?? 'Not Started' });
        await syncMysqlPursuitMarker(connection, { itemId, projectId });
        const restoredRow = await getMysqlProjectItemRow(connection, { itemId, projectId, tenantId });
        const after = await mysqlProjectItemSnapshot(connection, restoredRow);
        const restored = { action: 'restore', actorUserId: user?.id ?? '', after, before, createdAt: new Date().toISOString(), id: randomUUID(), itemId, itemType, projectId, tenantId, versionAfter: Number(row.version) + 1, versionBefore: Number(row.version) };
        await insertMysqlProjectItemRevision(connection, restored);
        await connection.execute('UPDATE projects SET updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3))) WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);
        return restored;
      });
      if (!revision) return null;
      const project = await getProjectDetail(pool, { includePursuit: true, projectId, tenantId });
      return { item: findProjectItemContext(project, itemId)?.node ?? null, project, revision };
    },
    async listMentionableUsers({ projectId, query, tenantId }) {
      const target = await validateTargetForProject(pool, {
        projectId,
        targetId: projectId,
        targetType: 'project',
        tenantId,
      });

      if (!target) {
        return [];
      }

      const normalizedQuery = `%${String(query ?? '').trim().toLowerCase()}%`;
      const hasQuery = String(query ?? '').trim().length > 0;
      const [rows] = await pool.execute(
        `
          SELECT DISTINCT
            u.id,
            u.name,
            u.email,
            COALESCE(avatar_pref.value, '') AS picture
          FROM user_tenant ut
          INNER JOIN users u ON u.id = ut.user_id
          LEFT JOIN preferences avatar_pref
            ON avatar_pref.user_id = u.id
            AND avatar_pref.tenant_id IS NULL
            AND avatar_pref.project_id IS NULL
            AND avatar_pref.key = 'user_avatar'
          WHERE ut.tenant_id = ?
            AND (
              ? = 0
              OR LOWER(u.name) LIKE ?
              OR LOWER(u.email) LIKE ?
            )
          ORDER BY u.name ASC
        `,
        [tenantId, hasQuery ? 1 : 0, normalizedQuery, normalizedQuery],
      );

      return rows.map((row) => ({
        email: row.email,
        id: row.id,
        name: row.name,
        picture: row.picture ?? '',
      }));
    },
    async listComments({ projectId, targetId, targetType, tenantId }) {
      const target = await validateTargetForProject(pool, {
        projectId,
        targetId,
        targetType,
        tenantId,
      });

      if (!target) {
        return [];
      }

      const rows = await listCommentRows(pool, {
        targetId,
        targetType,
        tenantId,
      });

      return buildCommentTree(rows.map((row) => serializeMysqlComment(row)));
    },
    async addComment({ comment, parentId, projectId, targetId, targetType, tenantId, user }) {
      const saved = await withTransaction(pool, async (connection) => {
        const target = await validateTargetForProject(connection, {
          projectId,
          targetId,
          targetType,
          tenantId,
        });

        if (!target) {
          throw new Error('Invalid comment target.');
        }

        await ensureParentComment(connection, {
          parentId,
          targetId,
          targetType,
          tenantId,
        });

        const commentId = randomUUID();
        const sanitizedComment = sanitizeRichHtml(comment);

        await connection.execute(
          `
            INSERT INTO comments (
              id,
              tenant_id,
              user_id,
              target_id,
              target_type,
              parent_id,
              comment,
              upvotes,
              downvotes,
              date_added,
              date_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NOW(), NOW())
          `,
          [commentId, tenantId, user.id, targetId, targetType, parentId, sanitizedComment],
        );
        await appendMysqlProjectChanges(connection, [commentChange({ action: 'create', actorId: user.id, comment: { id: commentId, parentId, targetId, targetType }, projectId, tenantId })]);

        const [rows] = await connection.execute(
          `
            SELECT
              c.id,
              c.user_id AS userId,
              c.target_id AS targetId,
              c.target_type AS targetType,
              c.parent_id AS parentId,
              c.comment,
              c.upvotes,
              c.downvotes,
              c.date_added AS createdAt,
              c.date_updated AS updatedAt,
              u.name AS authorName,
              COALESCE(avatar_pref.value, '') AS authorPicture
            FROM comments c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN preferences avatar_pref
              ON avatar_pref.user_id = u.id
              AND avatar_pref.tenant_id IS NULL
              AND avatar_pref.project_id IS NULL
              AND avatar_pref.key = 'user_avatar'
            WHERE c.id = ?
            LIMIT 1
          `,
          [commentId],
        );

        const [row] = await withResourceAuthorNames(connection, rows);
        return row ? serializeMysqlComment(row) : null;
      });

      if (saved) {
        await safeQueueMentionEmailsMysql({
          html: saved.comment,
          projectId,
          targetId,
          targetType,
          tenantId,
          userId: user?.id ?? '',
        });
      }

      return saved;
    },
    async updateComment({ commentHtml, commentId, projectId, tenantId, user }) {
      const saved = await withTransaction(pool, async (connection) => {
        const existing = await resolveCommentContext(connection, {
          commentId,
          projectId,
          tenantId,
        });

        if (!existing) {
          return null;
        }

        if (!canEditComment(user, existing.userId)) {
          throw new Error('Forbidden');
        }

        await connection.execute(
          `
            UPDATE comments
            SET comment = ?,
                date_updated = NOW()
            WHERE id = ?
          `,
          [sanitizeRichHtml(commentHtml), commentId],
        );
        await appendMysqlProjectChanges(connection, [commentChange({ action: 'update', actorId: user.id, comment: { ...existing, id: commentId }, projectId, tenantId })]);

        const [rows] = await connection.execute(
          `
            SELECT
              c.id,
              c.user_id AS userId,
              c.target_id AS targetId,
              c.target_type AS targetType,
              c.parent_id AS parentId,
              c.comment,
              c.upvotes,
              c.downvotes,
              c.date_added AS createdAt,
              c.date_updated AS updatedAt,
              u.name AS authorName,
              COALESCE(avatar_pref.value, '') AS authorPicture
            FROM comments c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN preferences avatar_pref
              ON avatar_pref.user_id = u.id
              AND avatar_pref.tenant_id IS NULL
              AND avatar_pref.project_id IS NULL
              AND avatar_pref.key = 'user_avatar'
            WHERE c.id = ?
            LIMIT 1
          `,
          [commentId],
        );

        const [row] = await withResourceAuthorNames(connection, rows);
        return row ? serializeMysqlComment(row) : null;
      });

      if (saved) {
        await safeQueueMentionEmailsMysql({
          html: saved.comment,
          projectId,
          targetId: saved.targetId,
          targetType: saved.targetType,
          tenantId,
          userId: user?.id ?? '',
        });
      }

      return saved;
    },
    async voteComment({ commentId, projectId, tenantId, user, vote }) {
      return withTransaction(pool, async (connection) => {
        const existing = await resolveCommentContext(connection, {
          commentId,
          projectId,
          tenantId,
        });

        if (!existing) {
          return null;
        }

        const normalizedVote = vote === 'down' ? 'down' : 'up';
        let upvotes = Number(existing.upvotes ?? 0);
        let downvotes = Number(existing.downvotes ?? 0);

        const [voteRows] = await connection.execute(
          'SELECT id, vote FROM comment_votes WHERE comment_id = ? AND user_id = ? LIMIT 1',
          [commentId, user.id],
        );

        if (!voteRows[0]) {
          await connection.execute(
            `
              INSERT INTO comment_votes (id, comment_id, user_id, vote, created_at, updated_at)
              VALUES (?, ?, ?, ?, NOW(), NOW())
            `,
            [randomUUID(), commentId, user.id, normalizedVote],
          );

          if (normalizedVote === 'up') {
            upvotes += 1;
          } else {
            downvotes += 1;
          }
        } else if (voteRows[0].vote === normalizedVote) {
          await connection.execute('DELETE FROM comment_votes WHERE id = ?', [voteRows[0].id]);

          if (normalizedVote === 'up') {
            upvotes = Math.max(0, upvotes - 1);
          } else {
            downvotes = Math.max(0, downvotes - 1);
          }
        } else {
          await connection.execute(
            'UPDATE comment_votes SET vote = ?, updated_at = NOW() WHERE id = ?',
            [normalizedVote, voteRows[0].id],
          );

          if (voteRows[0].vote === 'up') {
            upvotes = Math.max(0, upvotes - 1);
            downvotes += 1;
          } else {
            downvotes = Math.max(0, downvotes - 1);
            upvotes += 1;
          }
        }

        await connection.execute(
          'UPDATE comments SET upvotes = ?, downvotes = ?, date_updated = NOW() WHERE id = ? AND tenant_id = ?',
          [upvotes, downvotes, commentId, tenantId],
        );

        return {
          downvotes,
          id: commentId,
          upvotes,
        };
      });
    },
    async deleteComment({ commentId, expectedTextHash, projectId, tenantId, user, withoutReplies = false }) {
      return withTransaction(pool, async (connection) => {
        const existing = await resolveCommentContext(connection, {
          commentId,
          projectId,
          tenantId,
        });

        if (!existing) {
          return false;
        }

        if (expectedTextHash !== undefined) {
          // Locked, so an edit can't land between this check and the delete.
          const [locked] = await connection.execute('SELECT comment FROM comments WHERE id = ? AND tenant_id = ? FOR UPDATE', [commentId, tenantId]);
          commentTextChanged(expectedTextHash, sanitizeRichHtml(locked[0]?.comment ?? ''));
        }

        const isModerator = isTenantModerator(user, tenantId);

        if (!isModerator && !canEditComment(user, existing.userId)) {
          throw new Error('Forbidden');
        }

        const [childRows] = await connection.execute(
          'SELECT id FROM comments WHERE parent_id = ?',
          [commentId],
        );

        if (!isModerator && childRows.length > 0) {
          throw new Error('Forbidden');
        }

        if (withoutReplies && childRows.length > 0) {
          throw commentHasReplies();
        }

        const idsToDelete = new Set([commentId]);

        if (isModerator) {
          const queue = [commentId];

          while (queue.length > 0) {
            const currentId = queue.shift();
            const [rows] = await connection.execute(
              'SELECT id FROM comments WHERE parent_id = ?',
              [currentId],
            );

            for (const row of rows) {
              if (!idsToDelete.has(row.id)) {
                idsToDelete.add(row.id);
                queue.push(row.id);
              }
            }
          }
        }

        for (const id of idsToDelete) {
          await connection.execute('DELETE FROM comment_votes WHERE comment_id = ?', [id]);
        }

        await connection.execute(
          `DELETE FROM comments WHERE id IN (${[...idsToDelete].map(() => '?').join(', ')})`,
          [...idsToDelete],
        );
        // Replies go with their comment; each is logged on the same target.
        await appendMysqlProjectChanges(connection, [...idsToDelete].map((id) => commentChange({ action: 'delete', actorId: user.id, comment: { ...existing, id, parentId: id === commentId ? existing.parentId ?? null : commentId }, projectId, tenantId })));

        return true;
      });
    },
    async isFileTarget({ projectId, targetId, targetType, tenantId }) {
      return Boolean(await validateTargetForProject(pool, { projectId, targetId, targetType, tenantId }));
    },
    async listFiles({ includeLinked = false, projectId, targetId, targetType, tenantId }) {
      const target = await validateTargetForProject(pool, {
        projectId,
        targetId,
        targetType,
        tenantId,
      });

      if (!target) {
        return [];
      }

      if (targetType === 'project' && targetId === projectId) {
        const [rows] = await pool.execute(
          `
            SELECT
              ${FILE_COLUMNS},
              ? AS projectId,
              CASE WHEN fv.target_type = 'clarification' THEN pc.prompt WHEN fv.target_type = 'channel' THEN ch.name ELSE t.name END AS targetName,
              u.name AS uploaderName
            FROM file_vault fv
            LEFT JOIN users u ON u.id = fv.user_id
            LEFT JOIN tasks t
              ON t.id = fv.target_id
              AND fv.target_type NOT IN ('project', 'clarification', 'channel')
            LEFT JOIN project_clarifications pc
              ON pc.id = fv.target_id
              AND fv.target_type = 'clarification'
            LEFT JOIN project_channels ch
              ON ch.id = fv.target_id
              AND fv.target_type = 'channel'
            WHERE fv.tenant_id = ?
              AND (
                (fv.target_type = 'project' AND fv.target_id = ?)
                OR t.project_id = ?
                OR pc.project_id = ?
                OR ch.project_id = ?
              )
            ORDER BY fv.updated_at DESC, fv.file_name ASC
          `,
          [projectId, tenantId, projectId, projectId, projectId, projectId],
        );

        return withFileLinks(pool, rows.map((row) => serializeMysqlFile(row)), tenantId);
      }

      const files = (await listTargetFileRows(pool, { projectId, targetId, targetType, tenantId })).map((row) => serializeMysqlFile(row));
      if (!includeLinked) return files;
      const [links] = await pool.execute('SELECT file_id AS fileId FROM file_links WHERE tenant_id = ? AND target_id = ? AND target_type = ?', [tenantId, targetId, targetType]);
      const homed = new Set(files.map((file) => file.id));
      const linked = [];
      for (const { fileId } of links) {
        if (homed.has(fileId)) continue;
        const record = await readFileRecord(pool, { fileId, tenantId });
        if (record) linked.push(serializeMysqlFile(record));
      }
      return withFileLinks(pool, [...files, ...linked].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))), tenantId);
    },
    async saveFile({
      createOnly = false,
      expectedSignature,
      fileContentsBase64,
      fileDescription,
      fileName,
      fileType,
      folderId = null,
      inlineImage,
      projectId,
      targetId,
      targetType,
      tenantId,
      user,
    }) {
      const bytes = Buffer.from(fileContentsBase64, 'base64');

      if (scanner.enabled) {
        const scan = await scanner.scanBytes(bytes);
        if (!scan?.clean) {
          throw new Error('File failed virus scan.');
        }
      }

      return withTransaction(pool, async (connection) => {
        await lockProjectFileNames(connection, { projectId, tenantId });
        const target = await validateTargetForProject(connection, {
          projectId,
          targetId,
          targetType,
          tenantId,
        });

        if (!target) {
          throw new Error('Invalid file target.');
        }

        const signature = createHash('md5').update(bytes).digest('hex');
        const guarded = createOnly || expectedSignature !== undefined;
        // A save under a name already there is a new version of that file. An upload that must not
        // save over someone's file locks the row it finds, so a save over it can't land in between.
        const [existingRows] = await connection.execute(
          `
            SELECT id, signature
            FROM file_vault
            WHERE tenant_id = ?
              AND target_id = ?
              AND target_type = ?
              AND folder_id <=> ?
              AND file_name = ?
            LIMIT 1${guarded ? ' FOR UPDATE' : ''}
          `,
          [tenantId, targetId, targetType, folderId ?? null, fileName],
        );
        if (createOnly && existingRows[0]) throw fileNameTaken();
        if (expectedSignature !== undefined && (existingRows[0]?.signature ?? null) !== expectedSignature) throw fileChanged();
        const fileId = existingRows[0]?.id ?? randomUUID();
        const existing = existingRows[0] ? await lockFileRow(connection, { fileId, tenantId }) : null;

        if (existing && existing.signature === signature && existing.file_type === fileType) {
          // The same contents again: nothing new to keep.
          await connection.execute('UPDATE file_vault SET file_desc = ?, updated_at = NOW() WHERE id = ?', [fileDescription ?? '', fileId]);
        } else if (existing) {
          const storageKey = randomUUID();
          await storage.write(storageKey, bytes);
          await supersedeFile(connection, existing, { fileDescription: fileDescription ?? '', fileName: existing.file_name, fileSize: bytes.length, fileType, scan: scannedBeforeSaving(bytes), signature, storageKey, userId: user.id });
        } else {
          await connection.execute(
            `
              INSERT INTO file_vault (
                id,
                tenant_id,
                user_id,
                target_id,
                target_type,
                file_name,
                file_desc,
                file_type,
                file_size,
                file_modified,
                signature,
                created_at,
                updated_at,
                scan_status,
                sha256,
                scanned_at,
                folder_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), NOW(), 'clean', ?, NOW(3), ?)
            `,
            [
              fileId,
              tenantId,
              user.id,
              targetId,
              targetType,
              fileName,
              fileDescription ?? '',
              fileType,
              bytes.length,
              signature,
              scannedBeforeSaving(bytes).sha256,
              folderId ?? null,
            ],
          );
          await storage.write(fileId, bytes);
        }

        const [rows] = await connection.execute(
          `
            SELECT
              ${FILE_COLUMNS},
              ? AS projectId,
              u.name AS uploaderName
            FROM file_vault fv
            LEFT JOIN users u ON u.id = fv.user_id
            WHERE fv.id = ?
            LIMIT 1
          `,
          [projectId, fileId],
        );
        if (!rows[0]) return null;
        const saved = serializeMysqlFile(rows[0]);
        if (!existing || saved.version !== Number(existing.current_version)) {
          await appendMysqlProjectChanges(connection, [fileChange({ action: existing ? 'version' : 'create', actorId: user.id, file: saved, projectId, tenantId })]);
        }

        return {
          ...saved,
          inlineImage: Boolean(inlineImage || String(rows[0].fileType).toLowerCase().startsWith('image/')),
          unchanged: Boolean(existing) && saved.version === Number(existing.current_version),
        };
      });
    },
    async getFileRecord({ fileId, tenantId }) {
      return fileRecordWithLinks(pool, { fileId, tenantId });
    },
    async saveFileVersion({ expectedVersion, fileContentsBase64, fileDescription, fileId, fileName, fileType, note, projectId, tenantId, user }) {
      const bytes = Buffer.from(fileContentsBase64, 'base64');
      if (scanner.enabled) {
        const scan = await scanner.scanBytes(bytes);
        if (!scan?.clean) throw new Error('File failed virus scan.');
      }
      const signature = createHash('md5').update(bytes).digest('hex');
      return withTransaction(pool, async (connection) => {
        await lockProjectFileNames(connection, { projectId, tenantId });
        const file = await lockFileRow(connection, { fileId, tenantId });
        if (!file) return null;
        if (Number(file.current_version) !== expectedVersion) throw fileChanged();
        const name = fileName ?? file.file_name;
        const type = fileType ?? file.file_type;
        await assertFileNameFree(connection, { file, fileName: name, tenantId });
        const unchanged = file.signature === signature && file.file_name === name && file.file_type === type;
        if (unchanged) return { file: await fileRecordWithLinks(connection, { fileId, tenantId }), unchanged: true };
        const storageKey = randomUUID();
        await storage.write(storageKey, bytes);
        await supersedeFile(connection, file, { fileDescription, fileName: name, fileSize: bytes.length, fileType: type, note, scan: scannedBeforeSaving(bytes), signature, storageKey, userId: user.id });
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: 'version', actorId: user.id, file: saved, note, projectId, tenantId })]);
        return { file: saved, unchanged: false };
      });
    },
    async restoreFileVersion({ expectedVersion, fileId, projectId, tenantId, user, version }) {
      return withTransaction(pool, async (connection) => {
        await lockProjectFileNames(connection, { projectId, tenantId });
        const file = await lockFileRow(connection, { fileId, tenantId });
        if (!file) return null;
        if (Number(file.current_version) !== expectedVersion) throw fileChanged();
        const [rows] = await connection.execute('SELECT * FROM file_versions WHERE file_id = ? AND tenant_id = ? AND version_number = ? LIMIT 1', [fileId, tenantId, version]);
        const earlier = rows[0];
        if (!earlier) return null;
        if (earlier.deleted_at || earlier.scan_status === 'infected') throw fileVersionUnavailable();
        await assertFileNameFree(connection, { file, fileName: earlier.file_name, tenantId });
        if (file.signature === earlier.signature && file.file_name === earlier.file_name && file.file_type === earlier.file_type) {
          return { file: await fileRecordWithLinks(connection, { fileId, tenantId }), unchanged: true };
        }
        const note = `Restored from version ${version}`;
        await supersedeFile(connection, file, { fileName: earlier.file_name, fileSize: earlier.file_size, fileType: earlier.file_type, note, scan: { previewStorageKey: earlier.preview_storage_key ?? null, scanStatus: earlier.scan_status ?? 'clean', scannedAt: earlier.scanned_at ?? null, sha256: earlier.sha256 ?? null }, signature: earlier.signature, storageKey: earlier.storage_key, userId: user.id });
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: 'restore', actorId: user.id, file: saved, note, projectId, tenantId })]);
        return { file: saved, unchanged: false };
      });
    },
    async listFileVersions({ fileId, tenantId }) {
      const current = await readFileRecord(pool, { fileId, tenantId });
      if (!current) return null;
      const [rows] = await pool.execute(
        `
          SELECT fv.*, u.name AS uploaderName
          FROM file_versions fv
          LEFT JOIN users u ON u.id = fv.user_id
          WHERE fv.file_id = ?
            AND fv.tenant_id = ?
          ORDER BY fv.version_number DESC
        `,
        [fileId, tenantId],
      );
      const file = serializeMysqlFile(current);
      return [
        { contentType: file.contentType, current: true, deletedAt: null, fileName: file.fileName, fileSize: file.fileSize, note: file.versionNote, scanStatus: file.scanStatus, sha256: file.sha256, signature: file.signature, uploadedAt: file.versionUploadedAt, uploadedBy: file.uploadedBy, version: file.version },
        ...rows.map((row) => serializeFileVersionRow(row)),
      ];
    },
    async linkFile({ fileId, projectId, targetId, targetType, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const target = await validateTargetForProject(connection, { projectId, targetId, targetType, tenantId });
        if (!target) throw new Error('Invalid file target.');
        const file = await lockFileRow(connection, { fileId, tenantId });
        if (!file) return null;
        const [existing] = await connection.execute('SELECT id FROM file_links WHERE file_id = ? AND target_id = ? AND target_type = ? LIMIT 1', [fileId, targetId, targetType]);
        const home = file.target_id === targetId && file.target_type === targetType;
        if (existing[0] || home) return { file: await fileRecordWithLinks(connection, { fileId, tenantId }), linked: false };
        await connection.execute(
          'INSERT INTO file_links (id, tenant_id, project_id, file_id, target_type, target_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))',
          [randomUUID(), tenantId, projectId, fileId, targetType, targetId, user.id],
        );
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: 'link', actorId: user.id, file: saved, link: { targetId, targetType }, projectId, tenantId })]);
        return { file: saved, linked: true };
      });
    },
    async unlinkFile({ fileId, linkId, projectId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute('SELECT id, target_id AS targetId, target_type AS targetType FROM file_links WHERE id = ? AND file_id = ? AND tenant_id = ? AND project_id = ? LIMIT 1 FOR UPDATE', [linkId, fileId, tenantId, projectId]);
        if (!rows[0]) return null;
        await connection.execute('DELETE FROM file_links WHERE id = ?', [linkId]);
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: 'unlink', actorId: user.id, file: saved, link: rows[0], projectId, tenantId })]);
        return { file: saved };
      });
    },
    async setFileAudience({ audience, fileId, projectId, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        const file = await lockFileRow(connection, { fileId, tenantId });
        if (!file) return null;
        const record = await fileRecordWithLinks(connection, { fileId, tenantId });
        if (!record || record.projectId !== projectId) return null;
        if (record.audience === audience) return { changed: false, file: record };
        await connection.execute('UPDATE file_vault SET audience = ?, updated_at = NOW() WHERE id = ?', [audience, fileId]);
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: 'audience', actorId: user.id, file: saved, projectId, tenantId })]);
        return { changed: true, file: saved };
      });
    },
    // Renames a file, moves it to another target or folder, or both (see the in-memory version).
    async moveFile({ fileId, fileName, folderId = null, projectId, targetId, targetType, tenantId, user }) {
      return withTransaction(pool, async (connection) => {
        if (!await validateTargetForProject(connection, { projectId, targetId, targetType, tenantId })) throw new Error('Invalid file target.');
        await lockProjectFileNames(connection, { projectId, tenantId });
        const row = await lockFileRow(connection, { fileId, tenantId });
        if (!row) return null;
        const record = await fileRecordWithLinks(connection, { fileId, tenantId });
        if (!record || record.projectId !== projectId) return null;
        const from = { fileName: row.file_name, folderId: row.folder_id ?? null, targetId: row.target_id, targetType: row.target_type };
        const to = { fileName, folderId: folderId ?? null, targetId, targetType };
        if (from.fileName === to.fileName && from.folderId === to.folderId && from.targetId === to.targetId && from.targetType === to.targetType) return { changed: false, file: record };
        await assertFileNameFree(connection, { file: { folder_id: to.folderId, id: fileId, target_id: targetId, target_type: targetType }, fileName, tenantId });
        await connection.execute(
          'UPDATE file_vault SET target_type = ?, target_id = ?, folder_id = ?, file_name = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?',
          [targetType, targetId, to.folderId, fileName, fileId, tenantId],
        );
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: fileMoveAction(from, to), actorId: user.id, extra: { from }, file: saved, projectId, tenantId })]);
        return { changed: true, file: saved };
      });
    },
    // One version's storage object and what it holds: the current version when version is null.
    // No bytes are read. Null when there is no such version or it was deleted.
    async describeFileVersion({ fileId, tenantId, version = null }) {
      return describeMysqlFileVersion(pool, { fileId, tenantId, version });
    },
    // One version's bytes with the storage object that holds them, which a signature request pins.
    // Without includeBytes, only its SHA-256: the stored one, or one hashed from a stream.
    async getFileVersionSource({ fileId, tenantId, version = null, includeBytes = true }) {
      const described = await describeMysqlFileVersion(pool, { fileId, tenantId, version });
      if (!described) return null;
      assertFileScanClean(described.scanStatus);
      const bytes = includeBytes ? Buffer.from((await storage.read(described.storageKey)).bytes) : null;
      return {
        ...(bytes ? { bytes } : {}),
        contentType: described.contentType,
        fileName: described.fileName,
        fileSize: described.fileSize,
        projectId: described.file.projectId,
        scanStatus: described.scanStatus,
        sha256: described.sha256 ?? (bytes ? createHash('sha256').update(bytes).digest('hex') : await hashStoredObject(storage, described.storageKey)),
        storageKey: described.storageKey,
        version: described.version,
      };
    },
    async readStoredObject(storageKey) {
      const asset = await storage.read(storageKey);
      return Buffer.from(asset.bytes);
    },
    async getFileAsset({ fileId, tenantId, version = null }) {
      const described = await describeMysqlFileVersion(pool, { fileId, tenantId, version });
      if (!described) return null;
      assertFileScanClean(described.scanStatus);
      const asset = await storage.read(described.storageKey);
      return { ...asset, contentType: described.contentType, file: described.file };
    },
    // A version's contents as a stream, or bytes start to end (inclusive) of them, after its scan.
    async openFileContent({ end, fileId, start, tenantId, version = null }) {
      const described = await describeMysqlFileVersion(pool, { fileId, tenantId, version });
      if (!described) return null;
      assertFileScanClean(described.scanStatus);
      return { ...described, ...await openStoredStream(storage, described.storageKey, { end, start }) };
    },
    async openStoredObject(storageKey, range = {}) {
      return openStoredStream(storage, storageKey, range);
    },
    // Multipart uploads (file_uploads).
    async createFileUpload(upload) {
      await pool.execute(
        `INSERT INTO file_uploads (id, tenant_id, project_id, target_type, target_id, folder_id, file_id, base_version, name, size, content_type, storage_key, s3_upload_id, part_size, status, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [upload.id, upload.tenantId, upload.projectId, upload.targetType, upload.targetId, upload.folderId ?? null, upload.fileId ?? null, upload.baseVersion ?? null, upload.fileName, upload.size, upload.contentType, upload.storageKey, upload.storageUploadId, upload.partSize, upload.status, upload.createdBy, new Date(upload.createdAt), new Date(upload.expiresAt)],
      );
      return { ...upload };
    },
    async getFileUpload({ tenantId, uploadId }) {
      const [rows] = await pool.execute('SELECT * FROM file_uploads WHERE id = ? AND tenant_id = ? LIMIT 1', [uploadId, tenantId]);
      return rows[0] ? serializeFileUploadRow(rows[0]) : null;
    },
    // Moves an upload from one of the statuses in from to status. False when it was in none of them.
    async setFileUploadStatus({ from, status, tenantId, uploadId }) {
      const [result] = await pool.execute(
        `UPDATE file_uploads SET status = ? WHERE id = ? AND tenant_id = ? AND status IN (${from.map(() => '?').join(', ')})`,
        [status, uploadId, tenantId, ...from],
      );
      return Number(result.affectedRows ?? 0) > 0;
    },
    async listExpiredFileUploads({ limit = 50, now = new Date() } = {}) {
      const [rows] = await pool.execute(
        `SELECT * FROM file_uploads WHERE status IN ('uploading', 'assembled') AND expires_at <= ? ORDER BY expires_at ASC LIMIT ${Math.max(1, Math.min(500, Number(limit) || 50))}`,
        [now],
      );
      return rows.map(serializeFileUploadRow);
    },
    // The assembled object of an upload becomes a file, or a new version of one, waiting for its scan.
    async saveUploadedFile({ expectedVersion = null, fileDescription, keepBoth = false, note = '', size, upload, user }) {
      const { projectId, targetId, targetType, tenantId } = upload;
      return withTransaction(pool, async (connection) => {
        await lockProjectFileNames(connection, { projectId, tenantId });
        const [uploads] = await connection.execute('SELECT status FROM file_uploads WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [upload.id, tenantId]);
        if (uploads[0]?.status !== 'assembled') throw uploadNotReady();
        const target = await validateTargetForProject(connection, { projectId, targetId, targetType, tenantId });
        if (!target) throw new Error('Invalid file target.');
        // Names are taken within a folder (in a channel library) on the target.
        const folderId = upload.folderId ?? null;
        const nameTaken = async (name, exceptId = '') => {
          const [rows] = await connection.execute('SELECT id FROM file_vault WHERE tenant_id = ? AND target_id = ? AND target_type = ? AND folder_id <=> ? AND file_name = ? AND id <> ? LIMIT 1', [tenantId, targetId, targetType, folderId, name, exceptId]);
          return Boolean(rows[0]);
        };
        const scan = { scanStatus: 'pending', scannedAt: null, sha256: null };
        const supersede = (file, fileName) => supersedeFile(connection, file, { fileDescription, fileName, fileSize: size, fileType: upload.contentType, note: note || null, scan, signature: null, storageKey: upload.storageKey, userId: user.id });
        let fileId;
        let action = 'version';
        if (upload.fileId && !keepBoth) {
          const file = await lockFileRow(connection, { fileId: upload.fileId, tenantId });
          const record = file ? await readFileRecord(connection, { fileId: upload.fileId, tenantId }) : null;
          if (!file || record?.projectId !== projectId) throw new HttpError(404, 'File not found.');
          if (Number(file.current_version) !== Number(expectedVersion ?? upload.baseVersion)) throw stalledVersion(Number(file.current_version));
          await assertFileNameFree(connection, { file, fileName: upload.fileName, tenantId });
          await supersede(file, upload.fileName);
          fileId = file.id;
        } else {
          const [named] = keepBoth ? [[]] : await connection.execute('SELECT id FROM file_vault WHERE tenant_id = ? AND target_id = ? AND target_type = ? AND folder_id <=> ? AND file_name = ? LIMIT 1', [tenantId, targetId, targetType, folderId, upload.fileName]);
          const existing = named[0] ? await lockFileRow(connection, { fileId: named[0].id, tenantId }) : null;
          if (existing) {
            await supersede(existing, existing.file_name);
            fileId = existing.id;
          } else {
            action = 'create';
            fileId = randomUUID();
            let fileName = upload.fileName;
            if (await nameTaken(fileName)) {
              const taken = new Set();
              const [rows] = await connection.execute('SELECT file_name AS name FROM file_vault WHERE tenant_id = ? AND target_id = ? AND target_type = ? AND folder_id <=> ?', [tenantId, targetId, targetType, folderId]);
              for (const row of rows) taken.add(String(row.name ?? '').trim().toLowerCase());
              fileName = keptBothName(upload.fileName, (name) => taken.has(name.trim().toLowerCase()));
            }
            await connection.execute(
              `INSERT INTO file_vault (id, tenant_id, user_id, target_id, target_type, file_name, file_desc, file_type, file_size, file_modified, signature, created_at, updated_at, storage_key, folder_id, scan_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL, NOW(), NOW(), ?, ?, 'pending')`,
              [fileId, tenantId, user.id, targetId, targetType, fileName, fileDescription ?? '', upload.contentType, size, upload.storageKey, upload.folderId ?? null],
            );
          }
        }
        await connection.execute("UPDATE file_uploads SET status = 'completed', file_id = ? WHERE id = ?", [fileId, upload.id]);
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        // Direct messages are not project work, so their files stay out of the change log.
        if (targetType !== DM_TARGET_TYPE) await appendMysqlProjectChanges(connection, [fileChange({ action, actorId: user.id, file: saved, note: action === 'version' ? note : null, projectId, tenantId })]);
        return { file: saved };
      });
    },
    // Storage objects waiting for a scan, each once however many rows hold it.
    async listPendingScanObjects({ limit = 10 } = {}) {
      const [rows] = await pool.execute(
        `SELECT storageKey, MAX(size) AS size, MIN(tenantId) AS tenantId FROM (
           SELECT COALESCE(storage_key, id) AS storageKey, file_size AS size, tenant_id AS tenantId FROM file_vault WHERE scan_status = 'pending'
           UNION ALL
           SELECT storage_key, file_size, tenant_id FROM file_versions WHERE scan_status = 'pending' AND deleted_at IS NULL
         ) pending GROUP BY storageKey LIMIT ${Math.max(1, Math.min(100, Number(limit) || 10))}`,
      );
      return rows.map((row) => ({ size: Number(row.size ?? 0), storageKey: row.storageKey, tenantId: row.tenantId }));
    },
    // A scan's result on every pending row that holds the object. An infected old version is
    // marked deleted as well; the current one keeps its row, marked infected. Returns each file and
    // version touched, with who uploaded it, for the notice.
    async recordObjectScan({ md5 = null, scanStatus, sha256 = null, storageKey }) {
      return withTransaction(pool, async (connection) => {
        const [currentRows] = await connection.execute(
          `SELECT fv.id, fv.tenant_id AS tenantId, fv.current_version AS version, fv.user_id AS uploaderId
           FROM file_vault fv WHERE COALESCE(fv.storage_key, fv.id) = ? AND fv.scan_status = 'pending' FOR UPDATE`,
          [storageKey],
        );
        const [versionRows] = await connection.execute(
          `SELECT v.id AS versionId, v.file_id AS id, v.tenant_id AS tenantId, v.version_number AS version, v.user_id AS uploaderId
           FROM file_versions v WHERE v.storage_key = ? AND v.scan_status = 'pending' AND v.deleted_at IS NULL FOR UPDATE`,
          [storageKey],
        );
        if (currentRows.length) {
          await connection.execute(
            `UPDATE file_vault SET scan_status = ?, sha256 = COALESCE(?, sha256), signature = COALESCE(signature, ?), scanned_at = NOW(3)
             WHERE id IN (${currentRows.map(() => '?').join(', ')})`,
            [scanStatus, sha256, md5, ...currentRows.map((row) => row.id)],
          );
        }
        if (versionRows.length) {
          await connection.execute(
            `UPDATE file_versions SET scan_status = ?, sha256 = COALESCE(?, sha256), signature = COALESCE(signature, ?), scanned_at = NOW(3)${scanStatus === 'infected' ? ", deleted_at = NOW(3), deleted_by = 'system:scanner'" : ''}
             WHERE id IN (${versionRows.map(() => '?').join(', ')})`,
            [scanStatus, sha256, md5, ...versionRows.map((row) => row.versionId)],
          );
        }
        const touched = [];
        for (const [current, rows] of [[true, currentRows], [false, versionRows]]) {
          for (const row of rows) {
            const file = await fileRecordWithLinks(connection, { fileId: row.id, tenantId: row.tenantId });
            if (!file?.projectId) continue;
            const [people] = await connection.execute('SELECT name, email FROM users WHERE id = ? LIMIT 1', [row.uploaderId]);
            const [projects] = await connection.execute('SELECT name FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1', [file.projectId, row.tenantId]);
            touched.push({ current, file, projectName: projects[0]?.name ?? '', uploader: { email: people[0]?.email ?? '', id: row.uploaderId, name: people[0]?.name ?? '' }, version: Number(row.version) });
          }
        }
        await appendMysqlProjectChanges(connection, touched.map(({ file, version }) => fileChange({ action: 'scanned', actorId: 'system:scanner', extra: { scanStatus, scannedVersion: version }, file, projectId: file.projectId, tenantId: file.tenantId })));
        return touched.map(({ current, file, projectName, uploader, version }) => ({ current, fileId: file.id, fileName: file.fileName, projectId: file.projectId, projectName, tenantId: file.tenantId, uploader, version }));
      });
    },
    // Office files whose scan passed and that have no preview yet (lib/files/file-preview.js), up to
    // maxBytes, each object once however many rows hold it. Newest first.
    async listPendingPreviewObjects({ limit = 10, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
      const extensions = OFFICE_EXTENSIONS.map(() => '?').join(', ');
      const types = OFFICE_CONTENT_TYPES.map(() => '?').join(', ');
      const office = `(LOWER(SUBSTRING_INDEX(file_name, '.', -1)) IN (${extensions}) OR LOWER(TRIM(SUBSTRING_INDEX(file_type, ';', 1))) IN (${types}))`;
      const officeParameters = [...OFFICE_EXTENSIONS, ...OFFICE_CONTENT_TYPES];
      const [rows] = await pool.execute(
        `SELECT storageKey, MAX(size) AS size, MIN(fileName) AS fileName, MIN(contentType) AS contentType, MAX(at) AS at FROM (
           SELECT COALESCE(storage_key, id) AS storageKey, file_size AS size, file_name AS fileName, file_type AS contentType, updated_at AS at FROM file_vault
           WHERE scan_status = 'clean' AND preview_storage_key IS NULL AND file_size <= ? AND ${office}
           UNION ALL
           SELECT storage_key, file_size, file_name, file_type, uploaded_at FROM file_versions
           WHERE scan_status = 'clean' AND preview_storage_key IS NULL AND deleted_at IS NULL AND file_size <= ? AND ${office}
         ) due GROUP BY storageKey ORDER BY at DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 10))}`,
        [maxBytes, ...officeParameters, maxBytes, ...officeParameters],
      );
      return rows.map((row) => ({ contentType: row.contentType, fileName: row.fileName, size: Number(row.size ?? 0), storageKey: row.storageKey }));
    },
    // A preview's result (the PDF's key, or NO_PREVIEW) on every row that holds the object and has
    // none yet. Returns each file and version touched.
    async recordObjectPreview({ previewStorageKey, storageKey }) {
      return withTransaction(pool, async (connection) => {
        const [currentRows] = await connection.execute(
          `SELECT id, tenant_id AS tenantId, current_version AS version FROM file_vault
           WHERE COALESCE(storage_key, id) = ? AND scan_status = 'clean' AND preview_storage_key IS NULL FOR UPDATE`,
          [storageKey],
        );
        const [versionRows] = await connection.execute(
          `SELECT id AS versionId, file_id AS id, tenant_id AS tenantId, version_number AS version FROM file_versions
           WHERE storage_key = ? AND scan_status = 'clean' AND preview_storage_key IS NULL AND deleted_at IS NULL FOR UPDATE`,
          [storageKey],
        );
        if (currentRows.length) {
          await connection.execute(`UPDATE file_vault SET preview_storage_key = ? WHERE id IN (${currentRows.map(() => '?').join(', ')})`, [previewStorageKey, ...currentRows.map((row) => row.id)]);
        }
        if (versionRows.length) {
          await connection.execute(`UPDATE file_versions SET preview_storage_key = ? WHERE id IN (${versionRows.map(() => '?').join(', ')})`, [previewStorageKey, ...versionRows.map((row) => row.versionId)]);
        }
        const touched = [];
        for (const [current, list] of [[true, currentRows], [false, versionRows]]) {
          for (const row of list) {
            const record = await readFileRecord(connection, { fileId: row.id, tenantId: row.tenantId });
            if (record?.projectId) touched.push({ current, fileId: row.id, projectId: record.projectId, tenantId: row.tenantId, version: Number(row.version) });
          }
        }
        return touched;
      });
    },
    // Marks an old version deleted. Returns its storage key when no other version still holds the
    // object, for the caller to delete once the row is saved.
    async deleteFileVersion({ fileId, projectId, tenantId, user, version }) {
      return withTransaction(pool, async (connection) => {
        const file = await lockFileRow(connection, { fileId, tenantId });
        const record = file ? await readFileRecord(connection, { fileId, tenantId }) : null;
        if (!file || record?.projectId !== projectId) return null;
        if (Number(file.current_version) === version) throw currentVersionDelete();
        const [rows] = await connection.execute('SELECT id, storage_key, preview_storage_key FROM file_versions WHERE file_id = ? AND tenant_id = ? AND version_number = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE', [fileId, tenantId, version]);
        if (!rows[0]) return null;
        await connection.execute('UPDATE file_versions SET deleted_at = NOW(3), deleted_by = ? WHERE id = ?', [user.id, rows[0].id]);
        const storageKey = rows[0].storage_key;
        const [holders] = await connection.execute(
          `SELECT 1 FROM file_vault WHERE COALESCE(storage_key, id) = ?
           UNION ALL SELECT 1 FROM file_versions WHERE storage_key = ? AND deleted_at IS NULL LIMIT 1`,
          [storageKey, storageKey],
        );
        const saved = await fileRecordWithLinks(connection, { fileId, tenantId });
        await appendMysqlProjectChanges(connection, [fileChange({ action: 'version_delete', actorId: user.id, extra: { deletedVersion: version }, file: saved, projectId, tenantId })]);
        return { file: saved, previewStorageKey: !holders.length && isStoredPreview(rows[0].preview_storage_key) ? rows[0].preview_storage_key : null, storageKey: holders.length ? null : storageKey, version };
      });
    },
    // What a project's files take in storage: every live version, each stored object once.
    async getProjectFileStorage({ projectId, tenantId }) {
      const projectFiles = `
        SELECT fv.id, fv.storage_key, fv.file_size, fv.scan_status
        FROM file_vault fv
        LEFT JOIN tasks t ON t.id = fv.target_id AND fv.target_type NOT IN ('project', 'clarification', 'channel')
        LEFT JOIN project_clarifications pc ON pc.id = fv.target_id AND fv.target_type = 'clarification'
        LEFT JOIN project_channels ch ON ch.id = fv.target_id AND fv.target_type = 'channel'
        WHERE fv.tenant_id = ?
          AND ((fv.target_type = 'project' AND fv.target_id = ?) OR t.project_id = ? OR pc.project_id = ? OR ch.project_id = ?)`;
      const parameters = [tenantId, projectId, projectId, projectId, projectId];
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM (
           SELECT storageKey, MAX(size) AS size FROM (
             SELECT COALESCE(f.storage_key, f.id) AS storageKey, f.file_size AS size FROM (${projectFiles}) f WHERE f.scan_status <> 'infected'
             UNION ALL
             SELECT v.storage_key, v.file_size FROM file_versions v INNER JOIN (${projectFiles}) f ON f.id = v.file_id
             WHERE v.deleted_at IS NULL AND v.scan_status <> 'infected'
           ) live GROUP BY storageKey
         ) objects`,
        [...parameters, ...parameters],
      );
      const [counts] = await pool.execute(
        `SELECT COUNT(*) AS files, COALESCE(SUM(1 + (SELECT COUNT(*) FROM file_versions v WHERE v.file_id = f.id AND v.deleted_at IS NULL)), 0) AS versions FROM (${projectFiles}) f`,
        parameters,
      );
      return { bytes: Number(rows[0]?.bytes ?? 0), files: Number(counts[0]?.files ?? 0), versions: Number(counts[0]?.versions ?? 0) };
    },
    async deleteFile({ fileId, tenantId, user = null }) {
      const file = await fileRecordWithLinks(pool, { fileId, tenantId });

      if (!file) {
        return false;
      }

      const obsoleteKeys = new Set();
      await withTransaction(pool, async (connection) => {
        await deleteFilesByIds(connection, [fileId], tenantId, obsoleteKeys);
        if (user && file.projectId) await appendMysqlProjectChanges(connection, [fileChange({ action: 'delete', actorId: user.id, file, projectId: file.projectId, tenantId })]);
      });
      await deleteStoredObjects(obsoleteKeys);

      return true;
    },
    async exportProjectArchiveData({ projectId, tenantId }) {
      const project = await getProjectDetail(pool, { includePursuit: true, projectId, tenantId });
      if (!project) {
        return null;
      }

      const [projectRows] = await pool.execute(
        `
          SELECT
            p.id,
            p.name,
            p.description,
            ps.project_status_name AS status,
            p.start_date AS startDate,
            p.end_date AS endDate,
            p.\`rank\` AS \`rank\`,
            p.created_at AS createdAt,
            p.updated_at AS updatedAt
          FROM projects p
          INNER JOIN project_statuses ps ON ps.id = p.project_status
          WHERE p.id = ? AND p.tenant_id = ?
          LIMIT 1
        `,
        [projectId, tenantId],
      );
      const [projectUsers] = await pool.execute('SELECT id, user_id, project_id, role, created_at, updated_at, project_bill_rate, project_allocation FROM user_project WHERE project_id = ?', [projectId]);
      const archivedTaskIds = collectArchiveProjectTaskIds(project);
      const [taskLogs] = archivedTaskIds.length
        ? await pool.execute(
            `SELECT id, task_id, log_date, log_action, log_data FROM task_log WHERE task_id IN (${archivedTaskIds.map(() => '?').join(', ')}) ORDER BY log_date ASC`,
            archivedTaskIds,
          )
        : [[]];
      const [sprints] = await pool.execute('SELECT id, project_id, name, goal, sprint_status, start_date, end_date, sort_order, created_at, updated_at, deleted FROM project_sprints WHERE project_id = ?', [projectId]);
      const sprintIds = sprints.map((row) => row.id);
      const [sprintStaffing] = sprintIds.length
        ? await pool.execute(`SELECT id, sprint_id, user_id, capacity_hours, allocation_pct_override, notes, created_at, updated_at FROM project_sprint_staffing WHERE sprint_id IN (${sprintIds.map(() => '?').join(', ')})`, sprintIds)
        : [[]];
      const [comments] = await pool.execute(
        `
          SELECT id, tenant_id, user_id, target_id, target_type, parent_id, comment, upvotes, downvotes, date_added, date_updated
          FROM comments
          WHERE tenant_id = ?
            AND (
              target_id = ?
              OR target_id IN (SELECT id FROM tasks WHERE project_id = ?)
              OR BINARY target_id IN (SELECT BINARY id FROM project_clarifications WHERE BINARY project_id = BINARY ?)
            )
        `,
        [tenantId, projectId, projectId, projectId],
      );
      const commentIds = comments.map((row) => row.id);
      const [commentVotes] = commentIds.length
        ? await pool.execute(`SELECT id, comment_id, user_id, vote, created_at, updated_at FROM comment_votes WHERE comment_id IN (${commentIds.map(() => '?').join(', ')})`, commentIds)
        : [[]];
      const [preferences] = await pool.execute('SELECT id, tenant_id, user_id, project_id, `key`, `value`, updated_at FROM preferences WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const stakeholders = await selectRows(pool, 'SELECT id, tenant_id, project_id, name, email, role_title, access_token, created_at, updated_at FROM project_stakeholders WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const clarifications = await selectRows(pool, 'SELECT * FROM project_clarifications WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const clarificationAssignments = await selectRows(pool, 'SELECT * FROM project_clarification_assignments WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const clarificationComments = await selectRows(pool, 'SELECT * FROM project_clarification_comments WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const clarificationCommentReactions = await selectRows(pool, 'SELECT * FROM project_clarification_comment_reactions WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const clarificationInvitations = await selectRows(pool, 'SELECT * FROM project_clarification_invitations WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const clarificationEmailMessages = await selectRows(pool, 'SELECT * FROM project_clarification_email_messages WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      const summaryDocuments = await selectRows(pool, 'SELECT * FROM summary_documents WHERE tenant_id = ? AND source_kind = ? AND source_id = ?', [tenantId, 'project', projectId]);
      const [fileRows] = await pool.execute(
        `
          SELECT id, tenant_id, user_id, target_id, target_type, file_name, file_desc, file_type, file_size, file_modified, signature, created_at, updated_at, current_version, version_note, storage_key
          FROM file_vault
          WHERE tenant_id = ?
            AND scan_status = 'clean'
            AND (
              target_id = ?
              OR target_id IN (SELECT id FROM tasks WHERE project_id = ?)
              OR BINARY target_id IN (SELECT BINARY id FROM project_clarifications WHERE BINARY project_id = BINARY ?)
            )
        `,
        [tenantId, projectId, projectId, projectId],
      );
      const files = [];
      for (const { storage_key: storageKey, ...file } of fileRows) {
        const asset = await storage.read(storageKey ?? file.id);
        files.push({ ...file, contentsBase64: Buffer.from(asset.bytes).toString('base64') });
      }
      const archivedFileIds = files.map((file) => file.id);
      const [fileVersionRows] = archivedFileIds.length
        ? await pool.execute(`SELECT * FROM file_versions WHERE tenant_id = ? AND deleted_at IS NULL AND scan_status = 'clean' AND file_id IN (${archivedFileIds.map(() => '?').join(', ')})`, [tenantId, ...archivedFileIds])
        : [[]];
      const fileVersions = [];
      for (const { storage_key: storageKey, ...version } of fileVersionRows) {
        const asset = await storage.read(storageKey);
        fileVersions.push({ ...version, contentsBase64: Buffer.from(asset.bytes).toString('base64') });
      }
      const [fileLinks] = archivedFileIds.length
        ? await pool.execute(`SELECT * FROM file_links WHERE tenant_id = ? AND file_id IN (${archivedFileIds.map(() => '?').join(', ')})`, [tenantId, ...archivedFileIds])
        : [[]];
      const users = await (async () => {
        const sourceIds = collectArchiveSourceUserIds({
          clarificationAssignments,
          clarificationCommentReactions,
          clarificationComments,
          commentVotes,
          comments,
          fileLinks,
          fileVersions,
          files,
          project,
          projectUsers,
          sprintStaffing,
          taskLogs,
        });
        if (sourceIds.length === 0) {
          return [];
        }
        const [rows] = await pool.execute(
          `SELECT id, name, email FROM users WHERE id IN (${sourceIds.map(() => '?').join(', ')})`,
          sourceIds,
        );
        return rows;
      })();

      return {
        archiveVersion: 1,
        clarificationAssignments,
        clarificationCommentReactions,
        clarificationComments,
        clarificationEmailMessages,
        clarificationInvitations,
        clarifications,
        commentVotes,
        comments,
        exportedAt: new Date().toISOString(),
        fileLinks,
        fileVersions,
        files,
        preferences,
        project: {
          ...project,
          createdAt: rowDate(projectRows[0]?.createdAt),
          rank: projectRows[0]?.rank ?? project.rank ?? null,
          updatedAt: rowDate(projectRows[0]?.updatedAt),
        },
        projectRow: projectRows[0],
        projectUsers,
        sprintStaffing,
        sprints,
        stakeholders,
        summaryDocuments,
        taskLogs,
        users,
      };
    },
    async inspectProjectArchiveData({ archiveData, tenantId }) {
      const tenantUsers = await listTenantUsersForArchive(pool, tenantId);
      const found = await archiveIdConflicts(pool, { archiveData, tenantId });
      // A copy gets new ids, so nothing in this workspace conflicts with it.
      const importsAsCopy = found.heldElsewhere.length > 0;
      const conflicts = importsAsCopy ? [] : found.conflicts;
      return {
        conflicts,
        conflictGroups: archiveConflictGroups(conflicts),
        importsAsCopy,
        project: archiveData?.project
          ? {
              id: archiveData.project.id,
              name: archiveData.project.name,
              taskCount: countProjectTasks(archiveData.project),
            }
          : null,
        sourceUsers: buildArchiveSourceUsers(archiveData, tenantUsers),
        tenantUsers,
      };
    },
    async importProjectArchiveData({ archiveData: sourceArchive, assistantRepository, overwriteMode = 'none', tenantId, user, userMappings, vaultFiles: sourceVaultFiles }) {
      assertArchiveFileRecords(sourceArchive);
      const found = await archiveIdConflicts(pool, { archiveData: sourceArchive, tenantId });
      // Another workspace's records are never replaced: the project comes in as a copy.
      const copy = found.heldElsewhere.length > 0 ? copyArchiveWithNewIds({ archiveData: sourceArchive, vaultFiles: sourceVaultFiles }) : null;
      const archiveData = copy?.archiveData ?? sourceArchive;
      const vaultFiles = copy?.vaultFiles ?? sourceVaultFiles;
      const conflicts = copy ? [] : found.conflicts;
      const normalizedOverwriteMode = copy ? 'none' : normalizeArchiveOverwriteMode(overwriteMode);

      const userMap = normalizeArchiveUserMappings(userMappings);
      const projectId = archiveData?.project?.id;
      const obsoleteKeys = new Set();
      const importedKeys = new Set();
      const archivedTaskIds = new Set(collectArchiveProjectTaskIds(archiveData?.project));
      const hasTaskLogs = (archiveData.taskLogs ?? [])
        .some((log) => archivedTaskIds.has(archiveTaskLogTaskId(log)));
      await withTransaction(pool, async (connection) => {
        // First, so this transaction's reads see whatever a save holding the lock commits.
        if (projectId && conflicts.length > 0 && normalizedOverwriteMode !== 'none') await lockProjectFileNames(connection, { projectId, tenantId });
        if (conflicts.length > 0) {
          if (normalizedOverwriteMode === 'none') {
            throwArchiveConflict(conflicts);
          }
          if (
            normalizedOverwriteMode === 'project'
            && !conflicts.some((conflict) => conflict.type === 'project' && conflict.id === projectId)
          ) {
            throwArchiveConflict(conflicts, 'Project overwrite requires a matching project conflict.');
          }
          if (normalizedOverwriteMode === 'project') {
            const ownedConflictSets = await projectOwnedConflictSetsMysql(connection, { projectId, tenantId });
            const outsideProjectConflicts = conflicts.filter((conflict) => {
              return !ownedConflictSets.get(conflict.type)?.has(String(conflict.id ?? '').trim());
            });
            if (outsideProjectConflicts.length > 0) {
              throwArchiveConflict(outsideProjectConflicts, 'Project overwrite cannot remove conflicts outside this project.');
            }
          }

          // Only a project this workspace has is cleared.
          const replacesProject = conflicts.some((conflict) => conflict.type === 'project' && conflict.id === projectId);
          if (projectId && replacesProject && ['project', 'all'].includes(normalizedOverwriteMode)) {
            await deleteProjectArchiveRecordsMysql(connection, { obsoleteKeys, projectId, tenantId });
          }
          if (normalizedOverwriteMode === 'all') {
            await deleteArchiveConflictRecordsMysql(connection, { conflicts, obsoleteKeys, tenantId });
          }

          const remaining = await archiveIdConflicts(connection, { archiveData, tenantId });
          const remainingConflicts = [...remaining.conflicts, ...remaining.heldElsewhere];
          if (remainingConflicts.length > 0) {
            throwArchiveConflict(remainingConflicts, 'Project archive still conflicts after overwrite cleanup.');
          }
        }

        const projectStatusId = await getProjectStatusId(connection, archiveData.project?.status ?? archiveData.projectRow?.status ?? 'Planned');
        await connection.execute(
          `
            INSERT INTO projects (id, tenant_id, name, description, project_status, start_date, end_date, \`rank\`, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `,
          [
            projectId,
            tenantId,
            archiveData.project?.name,
            normalizeStoredRichTextMarkdown(archiveData.project?.description ?? ''),
            projectStatusId,
            archiveData.project?.startDate ?? null,
            archiveData.project?.endDate ?? null,
            archiveData.project?.rank ?? null,
            archiveDateTime(archiveData.project?.createdAt),
            archiveDateTime(archiveData.project?.updatedAt),
          ],
        );

        for (const [index, epic] of (archiveData.project?.epics ?? []).entries()) {
          await insertArchiveTaskNode(connection, {
            parentTaskId: null,
            projectId,
            skipGeneratedLogs: hasTaskLogs,
            task: { ...epic, sortOrder: epic.sortOrder ?? index },
            taskTypeName: 'Epic',
            tenantId,
            userMap,
          });
        }
        // Pursuit work stays pursuit work in the imported project.
        const pursuitIds = pursuitItemIds(archiveData.project);
        if (pursuitIds.length) {
          await connection.query('UPDATE tasks SET pursuit = 1 WHERE project_id = ? AND id IN (?)', [projectId, pursuitIds]);
        }

        for (const log of archiveData.taskLogs ?? []) {
          const taskId = archiveTaskLogTaskId(log);
          if (!archivedTaskIds.has(taskId)) {
            continue;
          }
          const logData = typeof log.log_data === 'string' ? safeJsonParse(log.log_data, {}) : (log.log_data ?? {});
          const nextLogData = {
            ...logData,
            ...(Object.prototype.hasOwnProperty.call(logData, 'assigned_to')
              ? { assigned_to: mappedArchiveUserId(logData.assigned_to, userMap, null) }
              : {}),
          };
          await connection.execute(
            'INSERT INTO task_log (id, task_id, log_date, log_action, log_data) VALUES (?, ?, ?, ?, ?)',
            [log.id ?? randomUUID(), taskId, archiveDateTime(log.log_date ?? log.logDate), log.log_action ?? log.logAction, JSON.stringify(nextLogData)],
          );
        }

        const projectUserIds = new Set();
        for (const membership of archiveData.projectUsers ?? []) {
          const targetUserId = mappedArchiveUserId(membership.user_id ?? membership.id, userMap, null);
          if (!targetUserId || projectUserIds.has(targetUserId)) {
            continue;
          }
          projectUserIds.add(targetUserId);
          await connection.execute(
            'INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at, project_bill_rate, project_allocation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              membership.id ?? randomUUID(),
              targetUserId,
              projectId,
              membership.role ?? 'user',
              archiveDateTime(membership.created_at ?? membership.createdAt),
              archiveDateTime(membership.updated_at ?? membership.updatedAt),
              membership.project_bill_rate ?? membership.projectBillRate ?? null,
              membership.project_allocation ?? membership.projectAllocation ?? null,
            ],
          );
        }
        if (!projectUserIds.has(user.id)) {
          await connection.execute(
            'INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
            [randomUUID(), user.id, projectId, 'admin'],
          );
        }

        for (const sprint of archiveData.sprints ?? []) {
          await connection.execute(
            'INSERT INTO project_sprints (id, project_id, name, goal, sprint_status, start_date, end_date, sort_order, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [sprint.id, projectId, sprint.name, sprint.goal ?? '', sprint.sprint_status ?? sprint.status ?? 'planned', sprint.start_date ?? sprint.startDate ?? null, sprint.end_date ?? sprint.endDate ?? null, sprint.sort_order ?? sprint.sortOrder ?? 0, archiveDateTime(sprint.created_at ?? sprint.createdAt), archiveDateTime(sprint.updated_at ?? sprint.updatedAt), sprint.deleted ?? 0],
          );
        }
        for (const staffing of archiveData.sprintStaffing ?? []) {
          const targetUserId = mappedArchiveUserId(staffing.user_id ?? staffing.userId, userMap, null);
          if (!targetUserId) continue;
          await connection.execute(
            'INSERT INTO project_sprint_staffing (id, sprint_id, user_id, capacity_hours, allocation_pct_override, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [staffing.id ?? randomUUID(), staffing.sprint_id ?? staffing.sprintId, targetUserId, staffing.capacity_hours ?? staffing.capacityHours ?? null, staffing.allocation_pct_override ?? staffing.allocationPctOverride ?? null, staffing.notes ?? '', archiveDateTime(staffing.created_at ?? staffing.createdAt), archiveDateTime(staffing.updated_at ?? staffing.updatedAt)],
          );
        }
        for (const pref of archiveData.preferences ?? []) {
          const sourceUserId = pref.user_id ?? pref.userId ?? null;
          const targetUserId = sourceUserId ? mappedArchiveUserId(sourceUserId, userMap, null) : null;
          if (sourceUserId && !targetUserId) {
            continue;
          }
          await connection.execute(
            'INSERT INTO preferences (id, tenant_id, user_id, project_id, `key`, `value`, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [pref.id ?? randomUUID(), tenantId, targetUserId, projectId, pref.key, pref.value, archiveDateTime(pref.updated_at ?? pref.updatedAt)],
          );
        }
        for (const stakeholder of normalizeArchiveStakeholders(archiveData)) {
          await connection.execute(
            'INSERT INTO project_stakeholders (id, tenant_id, project_id, name, email, role_title, access_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [stakeholder.id, tenantId, projectId, stakeholder.name, stakeholder.email, stakeholder.roleTitle ?? null, stakeholder.accessToken, archiveDateTime(stakeholder.createdAt), archiveDateTime(stakeholder.updatedAt)],
          );
        }
        for (const clarification of archiveData.clarifications ?? []) {
          await connection.execute(
            `
              INSERT INTO project_clarifications (
                tenant_id, project_id, id, linked_section, blocking_area, prompt, rationale, proposed_draft_impact,
                lifecycle_state, clarification_status, current_answer, current_answer_updated_at, latest_inbound_summary,
                latest_inbound_suggested_answer, latest_inbound_summary_comment_id, latest_inbound_summary_updated_at,
                last_activity_at, last_human_activity_at, last_reviewed_activity_at, last_auto_comment_activity_at,
                created_at, updated_at, track, topic_origin, source_ref, suggested_owner_role
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              tenantId, projectId, clarification.id, clarification.linked_section, clarification.blocking_area, clarification.prompt,
              clarification.rationale, clarification.proposed_draft_impact, clarification.lifecycle_state ?? 'committed',
              clarification.clarification_status ?? 'open', clarification.current_answer ?? null, toMysqlDateTime(clarification.current_answer_updated_at),
              clarification.latest_inbound_summary ?? null, clarification.latest_inbound_suggested_answer ?? null,
              clarification.latest_inbound_summary_comment_id ?? null, toMysqlDateTime(clarification.latest_inbound_summary_updated_at),
              toMysqlDateTime(clarification.last_activity_at), toMysqlDateTime(clarification.last_human_activity_at),
              toMysqlDateTime(clarification.last_reviewed_activity_at), toMysqlDateTime(clarification.last_auto_comment_activity_at),
              archiveDateTime(clarification.created_at), archiveDateTime(clarification.updated_at),
              // Archives from before requirements topics carry no track; they import as Experience.
              ['experience', 'architecture'].includes(clarification.track) ? clarification.track : 'experience',
              clarification.topic_origin ?? 'clarification', clarification.source_ref ?? null, clarification.suggested_owner_role ?? null,
            ],
          );
        }
        for (const assignment of archiveData.clarificationAssignments ?? []) {
          const actorType = assignment.actor_type ?? assignment.actorType;
          const actorId = actorType === 'user' ? mappedArchiveUserId(assignment.actor_id ?? assignment.actorId, userMap, null) : (assignment.actor_id ?? assignment.actorId);
          if (!actorId) continue;
          await connection.execute(
            'INSERT INTO project_clarification_assignments (id, tenant_id, project_id, clarification_id, actor_type, actor_id, actor_label, assignment_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [assignment.id ?? randomUUID(), tenantId, projectId, assignment.clarification_id ?? assignment.clarificationId, actorType, actorId, assignment.actor_label ?? assignment.actorLabel ?? 'Unknown user', assignment.assignment_role ?? assignment.role ?? 'collaborator', archiveDateTime(assignment.created_at ?? assignment.createdAt), archiveDateTime(assignment.updated_at ?? assignment.updatedAt)],
          );
        }
        for (const comment of archiveData.clarificationComments ?? []) {
          const actorType = comment.actor_type ?? comment.actorType;
          const actorId = actorType === 'user' ? mappedArchiveUserId(comment.actor_id ?? comment.actorId, userMap, null) : (comment.actor_id ?? comment.actorId ?? null);
          await connection.execute(
            'INSERT INTO project_clarification_comments (id, tenant_id, project_id, clarification_id, parent_comment_id, actor_type, actor_id, actor_label, comment_body, comment_source, edited_at, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [comment.id ?? randomUUID(), tenantId, projectId, comment.clarification_id ?? comment.clarificationId, comment.parent_comment_id ?? comment.parentCommentId ?? null, actorType, actorId, actorId ? (comment.actor_label ?? comment.actorLabel ?? 'Unknown user') : 'Unknown user', comment.comment_body ?? comment.body ?? '', comment.comment_source ?? comment.source ?? 'comment', toMysqlDateTime(comment.edited_at ?? comment.editedAt), toMysqlDateTime(comment.deleted_at ?? comment.deletedAt), archiveDateTime(comment.created_at ?? comment.createdAt), archiveDateTime(comment.updated_at ?? comment.updatedAt)],
          );
        }
        for (const reaction of archiveData.clarificationCommentReactions ?? []) {
          const actorType = reaction.actor_type ?? reaction.actorType;
          const actorId = actorType === 'user' ? mappedArchiveUserId(reaction.actor_id ?? reaction.actorId, userMap, null) : (reaction.actor_id ?? reaction.actorId);
          if (!actorId) continue;
          await connection.execute(
            'INSERT INTO project_clarification_comment_reactions (id, tenant_id, project_id, clarification_id, comment_id, actor_type, actor_id, reaction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [reaction.id ?? randomUUID(), tenantId, projectId, reaction.clarification_id ?? reaction.clarificationId, reaction.comment_id ?? reaction.commentId, actorType, actorId, reaction.reaction, archiveDateTime(reaction.created_at ?? reaction.createdAt), archiveDateTime(reaction.updated_at ?? reaction.updatedAt)],
          );
        }
        for (const invitation of archiveData.clarificationInvitations ?? []) {
          await connection.execute(
            'INSERT INTO project_clarification_invitations (id, tenant_id, project_id, clarification_id, stakeholder_id, invitation_token, reply_token, mail_status, queued_at, sent_at, last_inbound_at, last_provider_message_id, last_error, deactivated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [invitation.id, tenantId, projectId, invitation.clarification_id, invitation.stakeholder_id, invitation.invitation_token, invitation.reply_token, invitation.mail_status ?? 'pending', toMysqlDateTime(invitation.queued_at), toMysqlDateTime(invitation.sent_at), toMysqlDateTime(invitation.last_inbound_at), invitation.last_provider_message_id ?? null, invitation.last_error ?? null, toMysqlDateTime(invitation.deactivated_at), archiveDateTime(invitation.created_at), archiveDateTime(invitation.updated_at)],
          );
        }
        for (const message of archiveData.clarificationEmailMessages ?? []) {
          await connection.execute(
            'INSERT INTO project_clarification_email_messages (id, tenant_id, project_id, invitation_id, provider_message_id, message_direction, from_email, to_email, subject, normalized_body, in_reply_to, processed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [message.id, tenantId, projectId, message.invitation_id, message.provider_message_id, message.message_direction, message.from_email, message.to_email, message.subject ?? null, message.normalized_body ?? null, message.in_reply_to ?? null, archiveDateTime(message.processed_at), archiveDateTime(message.created_at), archiveDateTime(message.updated_at)],
          );
        }
        for (const comment of archiveData.comments ?? []) {
          await connection.execute(
            'INSERT INTO comments (id, tenant_id, user_id, target_id, target_type, parent_id, comment, upvotes, downvotes, date_added, date_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [comment.id, tenantId, mappedArchiveUserId(comment.user_id ?? comment.userId, userMap, user.id), comment.target_id ?? comment.targetId, comment.target_type ?? comment.targetType, comment.parent_id ?? comment.parentId ?? null, comment.comment ?? '', comment.upvotes ?? 0, comment.downvotes ?? 0, archiveDateTime(comment.date_added ?? comment.createdAt), archiveDateTime(comment.date_updated ?? comment.updatedAt)],
          );
        }
        for (const vote of archiveData.commentVotes ?? []) {
          const targetUserId = mappedArchiveUserId(vote.user_id ?? vote.userId, userMap, null);
          if (!targetUserId) continue;
          await connection.execute(
            'INSERT INTO comment_votes (id, comment_id, user_id, vote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [vote.id ?? randomUUID(), vote.comment_id ?? vote.commentId, targetUserId, vote.vote, archiveDateTime(vote.created_at ?? vote.createdAt), archiveDateTime(vote.updated_at ?? vote.updatedAt)],
          );
        }
        for (const file of archiveData.files ?? []) {
          const bytes = vaultFiles.get(file.id);
          const signature = file.signature ?? createHash('md5').update(bytes).digest('hex');
          const storageKey = randomUUID();
          await connection.execute(
            // Imported contents keep the clean status they were exported with, as before scanning moved
          // after upload.
          'INSERT INTO file_vault (id, tenant_id, user_id, target_id, target_type, file_name, file_desc, file_type, file_size, file_modified, signature, created_at, updated_at, current_version, version_note, storage_key, scan_status, sha256, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'clean\', ?, NOW(3))',
            [file.id, tenantId, mappedArchiveUserId(file.user_id ?? file.userId ?? file.uploadedBy?.id, userMap, user.id), file.target_id ?? file.targetId, file.target_type ?? file.targetType, file.file_name ?? file.fileName, file.file_desc ?? file.description ?? '', file.file_type ?? file.contentType ?? 'application/octet-stream', bytes.length, archiveDateTime(file.file_modified), signature, archiveDateTime(file.created_at ?? file.createdAt), archiveDateTime(file.updated_at ?? file.updatedAt), Number(file.current_version ?? file.version ?? 1), file.version_note ?? file.versionNote ?? null, storageKey, createHash('sha256').update(bytes).digest('hex')],
          );
          // Storage keys are made here, never taken from the archive: storage is one namespace
          // across tenants, and an old object stays until the import has committed.
          importedKeys.add(storageKey);
          await storage.write(storageKey, bytes);
        }
        for (const version of archiveData.fileVersions ?? []) {
          const versionFileId = version.file_id ?? version.fileId;
          const bytes = vaultFiles.get(version.id);
          const versionId = randomUUID();
          await connection.execute(
            'INSERT INTO file_versions (id, tenant_id, file_id, version_number, storage_key, user_id, file_name, file_type, file_size, signature, version_note, uploaded_at, scan_status, sha256, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'clean\', ?, NOW(3))',
            [versionId, tenantId, versionFileId, version.version_number ?? version.version, versionId, mappedArchiveUserId(version.user_id ?? version.userId ?? version.uploadedBy?.id, userMap, user.id), version.file_name ?? version.fileName, version.file_type ?? version.contentType, bytes.length, version.signature ?? createHash('md5').update(bytes).digest('hex'), version.version_note ?? version.note ?? null, archiveDateTime(version.uploaded_at ?? version.uploadedAt), createHash('sha256').update(bytes).digest('hex')],
          );
          importedKeys.add(versionId);
          await storage.write(versionId, bytes);
        }
        for (const link of archiveData.fileLinks ?? []) {
          const linkFileId = link.file_id ?? link.fileId;
          const linkTargetId = link.target_id ?? link.targetId;
          // A link to an item the archive left out, such as a deleted one, has nothing to point at.
          const [targets] = await connection.execute('SELECT id FROM tasks WHERE id = ? AND project_id = ? LIMIT 1', [linkTargetId, projectId]);
          if (!targets[0]) continue;
          await connection.execute(
            'INSERT INTO file_links (id, tenant_id, project_id, file_id, target_type, target_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [randomUUID(), tenantId, projectId, linkFileId, link.target_type ?? link.targetType, linkTargetId, mappedArchiveUserId(link.created_by ?? link.createdBy, userMap, user.id), archiveDateTime(link.created_at ?? link.createdAt)],
          );
        }
        for (const summary of archiveData.summaryDocuments ?? []) {
          await connection.execute(
            `
              INSERT INTO summary_documents (
                id, tenant_id, source_kind, source_id, entity_type, entity_id, parent_entity_type, parent_entity_id,
                title, core_summary, metadata_summary, comment_summary, content_fingerprint, metadata_fingerprint,
                core_model, metadata_model, core_generated_at, metadata_generated_at, stale_core, stale_metadata,
                last_error, last_error_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              summary.id ?? randomUUID(), tenantId, 'project', projectId, summary.entity_type, summary.entity_id,
              summary.parent_entity_type ?? null, summary.parent_entity_id ?? null, summary.title ?? '',
              summary.core_summary ?? null, summary.metadata_summary ?? null, summary.comment_summary ?? null,
              summary.content_fingerprint ?? summary.contentFingerprint ?? '', summary.metadata_fingerprint ?? summary.metadataFingerprint ?? null,
              summary.core_model ?? summary.coreModel ?? null, summary.metadata_model ?? summary.metadataModel ?? null,
              toMysqlDateTime(summary.core_generated_at ?? summary.coreGeneratedAt), toMysqlDateTime(summary.metadata_generated_at ?? summary.metadataGeneratedAt),
              summary.stale_core ?? summary.staleCore ?? 1, summary.stale_metadata ?? summary.staleMetadata ?? 1,
              summary.last_error ?? summary.lastError ?? null, toMysqlDateTime(summary.last_error_at ?? summary.lastErrorAt),
              archiveDateTime(summary.created_at ?? summary.createdAt), archiveDateTime(summary.updated_at ?? summary.updatedAt),
            ],
          );
        }
      }).catch(async (error) => {
        await deleteStoredObjects(importedKeys);
        throw error;
      });
      await deleteStoredObjects(obsoleteKeys);

      const hasAssistantProjectStatePreference = (archiveData.preferences ?? [])
        .some((pref) => pref.key === 'assistant_project_state');
      if (!hasAssistantProjectStatePreference && archiveData.assistantProjectState && assistantRepository?.saveProjectAssistantState) {
        await assistantRepository.saveProjectAssistantState({
          projectId,
          tenantId,
          value: archiveData.assistantProjectState,
        });
      }

      return {
        copied: Boolean(copy),
        importedProjectId: projectId,
        project: await getProjectDetail(pool, { projectId, tenantId }),
      };
    },
  };
}
