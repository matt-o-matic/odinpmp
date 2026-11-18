import { randomUUID } from 'node:crypto';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { isProjectSoftDeleted } from '../projects/project-deletion.service.js';
import { goalRunsReadOnly, READ_ONLY_RUN_PROMPT } from './agent-monitors.js';

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function isTenantAdmin(user, tenantId) {
  return user?.memberships?.some((membership) => membership.tenantId === tenantId && membership.role === 'admin');
}

async function authorizeGoal({ capability = PROJECT_CAPABILITIES.READ, goal, projectRepository, user }) {
  if (!goal) throw new HttpError(404, 'Agent goal not found.');
  if (goal.projectId) {
    await requireProjectCapability({ capability, projectId: goal.projectId, repository: projectRepository, tenantId: goal.tenantId, user });
    return;
  }
  if (goal.ownerUserId !== user.id && !isTenantAdmin(user, goal.tenantId)) throw new HttpError(404, 'Agent goal not found.');
}

export async function listAgentGoalsForUser({ executionRepository, projectId = null, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  if (projectId) {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  }
  const goals = await executionRepository.listGoals({
    ownerUserId: projectId || isTenantAdmin(user, tenantId) ? null : user.id,
    projectId,
    tenantId,
  });
  if (projectId) return { goals, ok: true };
  const deletedProjectIds = new Set();
  for (const goalProjectId of new Set(goals.map((goal) => goal.projectId).filter(Boolean))) {
    if (await isProjectSoftDeleted(projectRepository, { projectId: goalProjectId, tenantId })) deletedProjectIds.add(goalProjectId);
  }
  return { goals: goals.filter((goal) => !deletedProjectIds.has(goal.projectId)), ok: true };
}

export async function getAgentGoalForUser({ executionRepository, goalId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const goal = await executionRepository.getGoal({ goalId, tenantId });
  await authorizeGoal({ goal, projectRepository, user });
  const runs = await executionRepository.listRuns({ goalId, tenantId });
  return { goal, ok: true, runs };
}

export async function listAgentGoalNotificationsForUser({ executionRepository, goalId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const goal = await executionRepository.getGoal({ goalId, tenantId });
  await authorizeGoal({ goal, projectRepository, user });
  const notifications = await executionRepository.listNotifications({ goalId, tenantId });
  return { goal, notifications, ok: true };
}

export async function updateAgentGoalNotificationForUser({ executionRepository, input, notificationId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const notification = await executionRepository.getNotification({ notificationId, tenantId });
  if (!notification) throw new HttpError(404, 'Agent goal notification not found.');
  const goal = await executionRepository.getGoal({ goalId: notification.goalId, tenantId });
  await authorizeGoal({ goal, projectRepository, user });
  try {
    const updated = await executionRepository.updateNotification({
      expectedVersion: input.expectedVersion, notificationId, patch: { status: input.status }, tenantId,
    });
    if (!updated) throw new HttpError(404, 'Agent goal notification not found.');
    return { notification: updated, ok: true };
  } catch (error) {
    if (error?.code === 'agent_goal_notification_version_conflict') {
      throw new HttpError(409, error.message, { details: {
        actualVersion: error.actualVersion, code: error.code, expectedVersion: error.expectedVersion,
      } });
    }
    throw error;
  }
}

export async function createAgentGoalForUser({ executionRepository, input, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  if (input.projectId) {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: input.projectId, repository: projectRepository, tenantId, user });
  }
  const goal = await executionRepository.createGoal({ ...input, ownerUserId: user.id, tenantId });
  return { goal, ok: true };
}

export async function updateAgentGoalForUser({ executionRepository, goalId, input, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const goal = await executionRepository.getGoal({ goalId, tenantId });
  await authorizeGoal({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, goal, projectRepository, user });
  if (input.projectId && input.projectId !== goal.projectId) {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: input.projectId, repository: projectRepository, tenantId, user });
  }
  const { expectedVersion, ...patch } = input;
  // Anyone who can edit the plan can edit the goal, but its monitor runs act as its owner. So only
  // the owner may let runs make changes (autoApply), and anyone else's edit takes that away. The
  // governance screen saves constraints whole, without readOnly or autoApply, so both carry over.
  const owner = goal.ownerUserId === user.id;
  if (patch.constraints?.autoApply === true && !owner) throw new HttpError(403, "Only the goal's owner can let its runs make changes.");
  if (patch.constraints || (!owner && goal.constraints?.autoApply === true)) {
    const constraints = patch.constraints ?? goal.constraints ?? {};
    patch.constraints = { ...constraints, autoApply: owner && (constraints.autoApply ?? goal.constraints?.autoApply) === true };
    if (goal.constraints?.readOnly === true) {
      if ('readOnly' in constraints && constraints.readOnly !== true) throw new HttpError(400, 'This goal is read-only and stays that way. Set up a new goal for one that makes changes.');
      patch.constraints = { ...patch.constraints, autoApply: false, readOnly: true };
    }
  }
  try {
    const updatedGoal = await executionRepository.updateGoal({ expectedVersion, goalId, patch, tenantId });
    if (!updatedGoal) throw new HttpError(404, 'Agent goal not found.');
    return { goal: updatedGoal, ok: true };
  } catch (error) {
    if (error?.code === 'agent_goal_version_conflict') {
      throw new HttpError(409, error.message, { details: {
        actualVersion: error.actualVersion, code: error.code, expectedVersion: error.expectedVersion,
      } });
    }
    throw error;
  }
}

export async function runAgentGoalForUser({
  assistantRepository, executionRepository, goalId, input = {}, liveEventBus, projectRepository, user,
}) {
  const tenantId = tenantIdFor(user);
  const goal = await executionRepository.getGoal({ goalId, tenantId });
  await authorizeGoal({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, goal, projectRepository, user });
  if (goal.status !== 'active') throw new HttpError(409, 'Only active goals can start new runs.');
  const idempotencyKey = String(input.idempotencyKey ?? '').trim() || `goal:${goal.id}:manual:${randomUUID()}`;
  // Runs execute as a new assistant chat on the goal's project; the id ties the run's records together.
  const sessionResult = { session: { id: randomUUID(), projectId: goal.projectId ?? null } };
  const message = [
    `Pursue durable project-management goal: ${goal.title}`,
    `Success criteria: ${JSON.stringify(goal.success)}`,
    `Scope: ${JSON.stringify(goal.scope)}`,
    `Constraints: ${JSON.stringify(goal.constraints)}`,
    goalRunsReadOnly(goal)
      ? `Inspect current state and report what you find. ${READ_ONLY_RUN_PROMPT}`
      : "Inspect current state and make evidence-backed progress. The goal's owner has allowed its runs to make changes.",
  ].join('\n');
  const result = await executionRepository.enqueueRun({
    budgets: goal.constraints?.budgets ?? {},
    goalId: goal.id,
    idempotencyKey,
    maxAttempts: Number(goal.constraints?.maxAttempts ?? 5),
    payload: {
      input: { allowWebResearch: Boolean(goal.constraints?.allowWebResearch), forceGenerate: false, message, readOnly: goalRunsReadOnly(goal), title: goal.title },
      sessionId: sessionResult.session.id,
      trigger: { goalId: goal.id, type: 'manual' },
      userId: user.id,
    },
    projectId: goal.projectId,
    runType: 'assistant_turn',
    sessionId: sessionResult.session.id,
    tenantId,
    userId: user.id,
  });
  return { created: result.created, ok: true, run: result.run, session: sessionResult.session };
}
