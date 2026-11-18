import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { governanceItemCreateSchema, milestoneUpdateSchema } from '../governance/governance.schema.js';
import { sprintAssignmentsWriteSchema, storySplitSchema } from '../projects/projects.schema.js';

// Recovery proposals from Home (modules/home/home-recovery.js) are staged into an AI Workspace
// chat as a proposal with one item each. They apply only when the person applies them there, and
// each goes through the repository call behind the matching project or governance route, so
// version checks and validation are the same as for an edit made by hand.
export const RECOVERY_ACTION_TYPES = Object.freeze(['sprint_items_move', 'assignee_change', 'story_split', 'milestone_shift', 'governance_item_create']);

// Marks a change staged from Home (home.service.js stageHomeRecoveryForUser). It applies only
// when the person presses Apply: no auto-apply grant covers it, and turns and commits leave it
// pending.
export const STAGED_FOR_APPROVAL_ORIGIN = 'home-recovery';

export function requiresExplicitApply(action) {
  return action?.origin?.kind === STAGED_FOR_APPROVAL_ORIGIN;
}

function staleChange(message, details) {
  return new HttpError(409, `${message} Nothing was applied. Reload Home to see the current options.`, { details: { code: 'recovery_stale', ...details } });
}

function indexProjectNodes(project) {
  const nodes = new Map();
  for (const epic of project?.epics ?? []) {
    nodes.set(epic.id, epic);
    for (const story of epic.stories ?? []) {
      nodes.set(story.id, story);
      for (const task of story.tasks ?? []) nodes.set(task.id, task);
    }
  }
  return nodes;
}

/**
 * Moves and splits carry, in `createPayload.expected`, each item's version, sprint and status
 * when the change was staged, and the sprints it moves work into. Anything that has changed
 * since (an item finished, moved, edited or deleted, or a target sprint closed or removed)
 * refuses the whole change with 409.
 */
async function assertStillAsStaged({ action, projectId, projectRepository, tenantId }) {
  const expected = action.createPayload?.expected;
  if (!expected) throw staleChange('This change was staged without the checks it needs.', { actionId: action.id });
  const project = await projectRepository.getProjectDetail({ projectId, tenantId });
  if (!project) throw new HttpError(404, 'Project not found.');
  const nodes = indexProjectNodes(project);
  for (const item of expected.items ?? []) {
    const node = nodes.get(item.id);
    const changed = !node
      || Number(node.version ?? 1) !== Number(item.version)
      || (node.sprintId ?? null) !== (item.sprintId ?? null)
      || String(node.status ?? '').trim() !== String(item.status ?? '').trim();
    if (changed) throw staleChange(`“${node?.name ?? item.name ?? 'An item'}” changed since this was proposed.`, { itemId: item.id });
  }
  if ((expected.openSprintIds ?? []).length > 0) {
    const open = await projectRepository.listOpenSprints({ projectId, tenantId });
    const openIds = new Set((open?.sprints ?? []).map((sprint) => sprint.id));
    const missing = expected.openSprintIds.find((sprintId) => !openIds.has(sprintId));
    if (missing) throw staleChange('The sprint this change moves work into is no longer open.', { sprintId: missing });
  }
}

/**
 * Queues the governance.changed event the governance routes queue (webhooks and goal
 * monitors), for a governance change applied from a staged proposal. A failure is logged and
 * the applied change stands, as the route's dispatch does.
 */
export async function queueGovernanceChanged({ action, change, domainEventOutboxRepository, entityType, eventAction, projectId, tenantId }) {
  if (!domainEventOutboxRepository?.enqueue) return;
  try {
    await domainEventOutboxRepository.enqueue({
      eventType: 'governance.changed',
      idempotencyKey: `governance:assistant-action:${action.id}`,
      payload: { action: eventAction, change, entityId: change?.id ?? null, entityType },
      projectId,
      tenantId,
    });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('assistant.governanceChangedEvent', { actionId: action.id, entityType, projectId, tenantId }),
      error,
      level: 'warn',
      message: 'An applied governance change could not queue its event.',
    });
  }
}

/** Applies staged recovery changes in order. A type it doesn't know is refused, never skipped. */
export async function applyRecoveryActions({ actions = [], domainEventOutboxRepository = null, governanceRepository = null, projectId, projectRepository, tenantId, user }) {
  for (const action of actions) {
    if (!RECOVERY_ACTION_TYPES.includes(action?.type)) {
      throw new HttpError(400, 'Odin can’t apply this kind of change. Nothing was applied.', { details: { code: 'recovery_unsupported', type: action?.type ?? null } });
    }
    const input = action.createPayload?.input ?? {};
    if (action.type === 'sprint_items_move') {
      await assertStillAsStaged({ action, projectId, projectRepository, tenantId });
      const { assignments } = sprintAssignmentsWriteSchema.parse(input);
      const project = await projectRepository.assignItemsToSprint({ assignments, projectId, tenantId, user });
      if (!project) throw new HttpError(404, 'Project not found.');
      action.appliedRecord = { assignments };
    } else if (action.type === 'assignee_change') {
      const result = await projectRepository.updateProjectItem({
        input: { expectedVersion: Number(input.expectedVersion), patch: { assigneeId: String(input.assigneeId ?? '') } },
        itemId: action.targetId,
        projectId,
        tenantId,
        user,
      });
      if (!result) throw new HttpError(404, 'The work item no longer exists.');
      action.appliedRecord = result.item ?? null;
    } else if (action.type === 'story_split') {
      await assertStillAsStaged({ action, projectId, projectRepository, tenantId });
      const result = await projectRepository.splitStory({ input: storySplitSchema.parse(input), projectId, storyId: action.targetId, tenantId, user });
      if (!result) throw new HttpError(404, 'The story or its tasks changed. Nothing was split.');
      action.appliedRecord = result.story ?? null;
    } else if (action.type === 'milestone_shift') {
      if (!governanceRepository) throw new HttpError(503, 'Project governance storage is unavailable.');
      const record = await governanceRepository.updateMilestone({ input: milestoneUpdateSchema.parse(input), milestoneId: action.targetId, projectId, tenantId });
      if (!record) throw new HttpError(404, 'The milestone no longer exists.');
      action.appliedRecord = record;
      await queueGovernanceChanged({ action, change: record, domainEventOutboxRepository, entityType: 'milestone', eventAction: 'updated', projectId, tenantId });
    } else if (action.type === 'governance_item_create') {
      if (!governanceRepository) throw new HttpError(503, 'Project governance storage is unavailable.');
      const item = governanceItemCreateSchema.parse(input);
      // Home offers a risk only while no open one has its title; someone may have raised it since.
      const { items = [] } = await governanceRepository.listSnapshot({ latestBaselineOnly: true, projectId, tenantId });
      if (items.some((entry) => entry.kind === item.kind && entry.title === item.title && ['open', 'monitoring'].includes(entry.status))) {
        throw staleChange(`An open ${item.kind} named “${item.title}” already exists.`, { title: item.title });
      }
      const record = await governanceRepository.createItem({ input: item, projectId, tenantId });
      action.appliedRecord = record;
      await queueGovernanceChanged({ action, change: record, domainEventOutboxRepository, entityType: 'governance_item', eventAction: 'created', projectId, tenantId });
    }
  }
}
