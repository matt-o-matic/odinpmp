import { randomUUID } from 'node:crypto';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

async function goalForWrite({ executionRepository, goalId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const goal = await executionRepository.getGoal({ goalId, tenantId });
  if (!goal) throw new HttpError(404, 'Agent goal not found.');
  if (goal.projectId) await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: goal.projectId, repository: projectRepository, tenantId, user });
  else if (goal.ownerUserId !== user.id) throw new HttpError(404, 'Agent goal not found.');
  return { goal, tenantId };
}

export async function listAgentMonitorsForUser({ executionRepository, goalId, projectRepository, user }) {
  const { goal, tenantId } = await goalForWrite({ executionRepository, goalId, projectRepository, user });
  return { goal, monitors: await executionRepository.listMonitors({ goalId, tenantId }), ok: true };
}

export async function createAgentMonitorForUser({ assistantRepository, executionRepository, goalId, input, liveEventBus, projectRepository, user }) {
  const { goal, tenantId } = await goalForWrite({ executionRepository, goalId, projectRepository, user });
  // Runs execute as a new assistant chat on the goal's project; the id ties the run's records together.
  const sessionResult = { session: { id: randomUUID(), projectId: goal.projectId ?? null } };
  const monitor = await executionRepository.createMonitor({
    goalId, input: { ...input, payload: { context: input.payload, sessionId: sessionResult.session.id } },
    ownerUserId: user.id, projectId: goal.projectId, tenantId,
  });
  return { monitor, ok: true, session: sessionResult.session };
}

export async function updateAgentMonitorForUser({ executionRepository, monitorId, input, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const monitor = await executionRepository.getMonitor({ monitorId, tenantId });
  if (!monitor) throw new HttpError(404, 'Agent monitor not found.');
  await goalForWrite({ executionRepository, goalId: monitor.goalId, projectRepository, user });
  const { expectedVersion, ...patch } = input;
  if (patch.payload) patch.payload = { ...monitor.payload, context: patch.payload };
  try {
    // Recorded on every edit: runs act as whoever last set the monitor up (agent-monitors.js).
    const updated = await executionRepository.updateMonitor({ expectedVersion, monitorId, patch, tenantId, updatedByUserId: user.id });
    return { monitor: updated, ok: true };
  } catch (error) {
    if (error?.code === 'agent_monitor_version_conflict') throw new HttpError(409, error.message, { details: { actualVersion: error.actualVersion, code: error.code, expectedVersion } });
    throw error;
  }
}
