import { queueGoalAttentionEmail } from '../mail/mail.service.js';
import { findEmailOptOuts, isOptedOut } from '../users/notification-preferences.js';
import { isProjectSoftDeleted } from '../projects/project-deletion.service.js';
import { DEFAULT_PLATFORM_EVENT_REGISTRY } from '../platform/platform-event-registry.js';
import { verifyAgentGoalSuccess } from './agent-goal-verifier.js';
import { isTicketVisibleToAssistant } from './assistant-ticket-visibility.js';

function valueAtPath(value, path) {
  return String(path ?? '').split('.').filter(Boolean).reduce((current, part) => current?.[part], value);
}

export function monitorConditionMatches(condition = {}, event = {}) {
  return Object.entries(condition ?? {}).every(([path, expected]) => {
    const actual = valueAtPath(event, path);
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function monitorShouldStop(monitor, now) {
  const maxRuns = Number(monitor.stop?.maxRuns ?? 0);
  if (maxRuns > 0 && monitor.runCount >= maxRuns) return true;
  const endAt = Date.parse(monitor.stop?.endAt ?? '');
  return Number.isFinite(endAt) && endAt <= now.getTime();
}

async function disableMonitor(repository, monitor) {
  try {
    await repository.updateMonitor({ expectedVersion: monitor.version, monitorId: monitor.id, patch: { enabled: false }, tenantId: monitor.tenantId });
  } catch (error) {
    if (error?.code !== 'agent_monitor_version_conflict') throw error;
  }
}

async function completeGoalWhenVerified({ executionRepository, goal, governanceRepository, mailRepository, now, platformRepository, projectRepository, resourceFinanceRepository, workflowRepository }) {
  const verification = await verifyAgentGoalSuccess({ executionRepository, goal, governanceRepository, mailRepository, now, platformRepository, projectRepository, resourceFinanceRepository, workflowRepository });
  if (!verification.configured || !verification.passed) return { completed: false, verification };
  try {
    const updatedGoal = await executionRepository.updateGoal({
      expectedVersion: goal.version,
      goalId: goal.id,
      patch: {
        status: 'completed',
        success: { ...goal.success, lastVerification: verification },
      },
      tenantId: goal.tenantId,
    });
    const monitors = await executionRepository.listMonitors({ goalId: goal.id, tenantId: goal.tenantId });
    await Promise.all(monitors.filter((monitor) => monitor.enabled).map((monitor) => disableMonitor(executionRepository, monitor)));
    return { completed: true, goal: updatedGoal, verification };
  } catch (error) {
    if (error?.code === 'agent_goal_version_conflict') return { completed: false, verification };
    throw error;
  }
}

async function createGoalAttention({ authRepository, executionRepository, frontendAppUrl = '', goal, kind, mailRepository, message, monitor, platformRepository, severity = 'warning', title, evidence = {} }) {
  if (!executionRepository.createNotification) return null;
  const signature = kind === 'verifier_failed'
    ? [...(evidence.failedCheckIds ?? [])].sort().join(',') || 'unknown'
    : kind;
  const result = await executionRepository.createNotification({
    dedupeKey: `goal:${goal.id}:monitor:${monitor.id}:${kind}:${signature}`,
    evidence, goalId: goal.id, kind, message, monitorId: monitor.id, ownerUserId: monitor.ownerUserId,
    projectId: monitor.projectId, severity, tenantId: monitor.tenantId, title,
  });
  const channels = new Set(goal.constraints?.escalation?.channels ?? []);
  const emailEnabled = goal.constraints?.escalation?.email === true || channels.has('email');
  const webhookEnabled = goal.constraints?.escalation?.webhook === true || channels.has('webhook');
  const optOuts = result.created && emailEnabled
    ? await findEmailOptOuts({ kind: 'attention', read: authRepository?.listUserPreferences?.bind(authRepository), userIds: [monitor.ownerUserId] })
    : new Set();
  if (result.created && emailEnabled && mailRepository?.queueMail && authRepository?.findUserById && !isOptedOut(optOuts, { userId: monitor.ownerUserId })) {
    const owner = await authRepository.findUserById(monitor.ownerUserId);
    const baseUrl = String(frontendAppUrl ?? '').replace(/\/$/, '');
    const projectPath = monitor.projectId ? `/projects/${encodeURIComponent(monitor.projectId)}?tab=governance` : '';
    await queueGoalAttentionEmail({
      attention: result.notification,
      goal,
      mailRepository,
      recipientEmail: owner?.email ?? '',
      url: `${baseUrl}${projectPath}`,
    });
  }
  if (result.created && webhookEnabled && platformRepository?.materializeWebhookDeliveries) {
    await platformRepository.materializeWebhookDeliveries({ event: DEFAULT_PLATFORM_EVENT_REGISTRY.normalize({
      eventType: 'agent.goal.attention', id: result.notification.id,
      payload: { evidence, goalId: goal.id, kind, message, notificationId: result.notification.id, projectId: goal.projectId, severity, title },
      projectId: goal.projectId, tenantId: goal.tenantId,
    }) });
  }
  return result;
}

async function notifyVerifierFailureIfNeeded({ authRepository, completion, executionRepository, frontendAppUrl, goal, mailRepository, monitor, platformRepository }) {
  if (!completion.verification?.configured || completion.verification.passed) return null;
  const afterRuns = Math.max(1, Number(goal.constraints?.escalation?.afterRuns ?? 1));
  if (monitor.runCount + 1 < afterRuns) return null;
  const failed = completion.verification.failedCheckIds ?? [];
  return createGoalAttention({
    authRepository,
    evidence: completion.verification,
    executionRepository,
    frontendAppUrl,
    goal,
    kind: 'verifier_failed',
    message: `${failed.length} required success predicate or verifier check(s) failed: ${failed.join(', ') || 'verification unavailable'}.`,
    mailRepository, platformRepository,
    monitor,
    severity: failed.some((id) => id.includes('critical') || id.includes('milestone')) ? 'critical' : 'warning',
    title: `Goal needs attention: ${goal.title}`,
  });
}

// Goal runs change nothing unless the goal's owner set constraints.autoApply: checks run
// unattended and read content anyone could have written. readOnly (every monitor the assistant
// sets up) wins over autoApply.
export const goalRunsReadOnly = (goal) => goal?.constraints?.readOnly === true || goal?.constraints?.autoApply !== true;
export const READ_ONLY_RUN_PROMPT = 'This check is read-only: Odin refuses every change, so read, then report. Do not try to change anything.';

// Anyone who can edit the plan can create or change a monitor, and its runs follow what they wrote.
// So a run acts as whoever last set the monitor up, and may make changes only when that is the
// goal's owner and the goal allows it. Monitors with no one recorded predate this and stay read-only.
export const monitorRunUserId = (monitor) => monitor?.updatedByUserId ?? monitor?.ownerUserId;
export const monitorRunsReadOnly = (goal, monitor) => goalRunsReadOnly(goal) || !monitor?.updatedByUserId || monitor.updatedByUserId !== goal?.ownerUserId;

function monitorPrompt(goal, monitor, trigger) {
  return [
    `Pursue durable project-management goal: ${goal.title}`,
    `Monitor: ${monitor.title}`,
    `Trigger: ${JSON.stringify(trigger)}`,
    `Success criteria: ${JSON.stringify(goal.success)}`,
    `Scope: ${JSON.stringify(goal.scope)}`,
    `Constraints: ${JSON.stringify(goal.constraints)}`,
    `Monitor payload: ${JSON.stringify(monitor.payload?.context ?? {})}`,
    monitorRunsReadOnly(goal, monitor)
      ? `Inspect current state and report material changes. ${READ_ONLY_RUN_PROMPT}`
      : "Inspect current state and report material changes. The goal's owner has allowed its runs to make changes.",
  ].join('\n');
}

async function enqueueMonitorRun({ executionRepository, goal, monitor, trigger }) {
  const sessionId = String(monitor.payload?.sessionId ?? '').trim();
  if (!sessionId) throw new Error(`Agent monitor ${monitor.id} has no durable assistant session.`);
  return executionRepository.enqueueRun({
    budgets: goal.constraints?.budgets ?? {},
    goalId: goal.id,
    idempotencyKey: `monitor:${monitor.id}:${trigger.id}`,
    maxAttempts: Number(goal.constraints?.maxAttempts ?? 5),
    payload: {
      input: {
        allowWebResearch: Boolean(goal.constraints?.allowWebResearch),
        forceGenerate: false,
        message: monitorPrompt(goal, monitor, trigger),
        readOnly: monitorRunsReadOnly(goal, monitor),
        title: goal.title,
      },
      sessionId,
      trigger,
      userId: monitorRunUserId(monitor),
    },
    projectId: monitor.projectId,
    runType: 'assistant_turn',
    sessionId,
    tenantId: monitor.tenantId,
    userId: monitorRunUserId(monitor),
  });
}

export async function materializeDueGoalMonitors({ authRepository = null, executionRepository, frontendAppUrl = '', governanceRepository = null, limit = 100, mailRepository = null, now = new Date(), platformRepository = null, projectRepository = null, resourceFinanceRepository = null, workflowRepository = null }) {
  const due = await executionRepository.listDueMonitors({ limit, now });
  const results = [];
  for (const monitor of due) {
    // A deleted project's monitors wait for a restore instead of running against it.
    if (await isProjectSoftDeleted(projectRepository, { projectId: monitor.projectId, tenantId: monitor.tenantId })) {
      const nextRunAt = new Date(now.getTime() + (monitor.intervalMinutes ?? 60) * 60_000);
      await executionRepository.updateMonitor?.({ expectedVersion: monitor.version, monitorId: monitor.id, patch: { nextRunAt }, tenantId: monitor.tenantId }).catch(() => null);
      results.push({ monitorId: monitor.id, status: 'project_deleted' });
      continue;
    }
    const goal = await executionRepository.getGoal({ goalId: monitor.goalId, tenantId: monitor.tenantId });
    if (!goal || goal.status !== 'active' || monitorShouldStop(monitor, now)) {
      await disableMonitor(executionRepository, monitor);
      if (goal?.status === 'active' && monitorShouldStop(monitor, now)) {
        await createGoalAttention({
          authRepository,
          evidence: { runCount: monitor.runCount, stop: monitor.stop }, executionRepository, goal,
          frontendAppUrl,
          kind: 'monitor_stopped', message: `Monitor "${monitor.title}" reached its stop condition before the goal completed.`,
          mailRepository, monitor, platformRepository, severity: 'warning', title: `Goal monitor stopped: ${goal.title}`,
        });
      }
      results.push({ monitorId: monitor.id, status: 'stopped' });
      continue;
    }
    const completion = await completeGoalWhenVerified({ executionRepository, goal, governanceRepository, mailRepository, now, platformRepository, projectRepository, resourceFinanceRepository, workflowRepository });
    if (completion.completed) {
      results.push({ goalId: goal.id, monitorId: monitor.id, status: 'goal_completed', verification: completion.verification });
      continue;
    }
    await notifyVerifierFailureIfNeeded({ authRepository, completion, executionRepository, frontendAppUrl, goal, mailRepository, monitor, platformRepository });
    const scheduledFor = new Date(monitor.nextRunAt);
    const trigger = { id: `schedule:${scheduledFor.toISOString()}`, scheduledFor: scheduledFor.toISOString(), type: 'schedule' };
    const enqueued = await enqueueMonitorRun({ executionRepository, goal, monitor, trigger });
    const nextRunAt = new Date(now.getTime() + monitor.intervalMinutes * 60_000);
    await executionRepository.markMonitorFired({ monitorId: monitor.id, nextRunAt, now, scheduledFor, tenantId: monitor.tenantId });
    results.push({ created: enqueued.created, monitorId: monitor.id, runId: enqueued.run.id, status: 'queued' });
  }
  return results;
}

// An event as a run is told of it (D-027): nothing of a ticket agents may not see, not even its id.
// An event about one reaches no monitor, and a governance change keeps only its links to items agents
// may see in the project (an item since deleted may have been such a ticket).
async function agentEvent({ event, projectId, projectRepository, tenantId }) {
  const project = projectId && projectRepository?.getProjectDetail ? await projectRepository.getProjectDetail({ projectId, tenantId }) : null;
  const items = (project?.epics ?? []).flatMap((epic) => [epic, ...(epic.stories ?? []).flatMap((story) => [story, ...(story.tasks ?? [])])]);
  const known = new Set([...items, ...(project?.tickets ?? []).filter(isTicketVisibleToAssistant)].map((item) => item.id));
  if (event?.itemType === 'ticket' && !known.has(event.itemId)) return null;
  const change = event?.change;
  if (!change || typeof change !== 'object') return event;
  const linksOf = (record) => Object.fromEntries(['workItemId', 'predecessorId', 'successorId'].filter((key) => key in record).map((key) => [key, known.has(record[key]) ? record[key] : null]));
  // A schedule baseline carries the whole plan's dependencies and milestones in its snapshot.
  const snapshot = change.snapshot && typeof change.snapshot === 'object' ? {
    snapshot: {
      ...change.snapshot,
      ...(Array.isArray(change.snapshot.dependencies) ? { dependencies: change.snapshot.dependencies.filter((record) => known.has(record?.predecessorId) && known.has(record?.successorId)) } : {}),
      ...(Array.isArray(change.snapshot.milestones) ? { milestones: change.snapshot.milestones.map((record) => ({ ...record, ...linksOf(record ?? {}) })) } : {}),
    },
  } : {};
  return { ...event, change: { ...change, ...linksOf(change), ...snapshot } };
}

export async function materializeGoalEvent({ authRepository = null, event, eventId, eventType, executionRepository, frontendAppUrl = '', governanceRepository = null, mailRepository = null, platformRepository = null, projectId = null, projectRepository = null, resourceFinanceRepository = null, tenantId, workflowRepository = null }) {
  const monitors = await executionRepository.listEventMonitors({ eventType, projectId, tenantId });
  const shown = monitors.length ? await agentEvent({ event, projectId, projectRepository, tenantId }) : null;
  const results = [];
  for (const monitor of shown ? monitors : []) {
    if (await isProjectSoftDeleted(projectRepository, { projectId: monitor.projectId, tenantId })) continue;
    const goal = await executionRepository.getGoal({ goalId: monitor.goalId, tenantId });
    if (!goal || goal.status !== 'active' || monitorShouldStop(monitor, new Date()) || !monitorConditionMatches(monitor.condition, event)) continue;
    const completion = await completeGoalWhenVerified({ executionRepository, goal, governanceRepository, mailRepository, now: new Date(), platformRepository, projectRepository, resourceFinanceRepository, workflowRepository });
    if (completion.completed) {
      results.push({ goalId: goal.id, monitorId: monitor.id, status: 'goal_completed', verification: completion.verification });
      continue;
    }
    await notifyVerifierFailureIfNeeded({ authRepository, completion, executionRepository, frontendAppUrl, goal, mailRepository, monitor, platformRepository });
    const enqueued = await enqueueMonitorRun({
      executionRepository, goal, monitor,
      trigger: { event: shown, eventType, id: `event:${eventId}`, type: 'event' },
    });
    if (enqueued.created) await executionRepository.markMonitorFired({ monitorId: monitor.id, now: new Date(), tenantId });
    results.push({ created: enqueued.created, monitorId: monitor.id, runId: enqueued.run.id, status: 'queued' });
  }
  return results;
}
