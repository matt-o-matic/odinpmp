import { randomUUID } from 'node:crypto';

import {
  claimAgentRunSchema,
  createAgentStepSchema,
  createApprovalSchema,
  createToolCallSchema,
  enqueueAgentRunSchema,
  failAgentRunSchema,
  ownedAgentRunSchema,
  recordAgentRunTraceSchema,
  agentRunUsageSchema,
  createAgentMonitorSchema,
  updateAgentMonitorSchema,
} from './agent-execution.schema.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'dead_lettered']);

function iso(value = new Date()) {
  return new Date(value).toISOString();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function errorRecord(error) {
  if (error instanceof Error) {
    return { code: error.code ?? null, message: error.message, name: error.name };
  }
  return { code: null, message: String(error ?? 'Unknown execution error.'), name: 'Error' };
}

function createState(seed = {}) {
  return {
    approvals: seed.approvals ?? new Map(),
    checkpoints: seed.checkpoints ?? new Map(),
    events: seed.events ?? new Map(),
    goals: seed.goals ?? new Map(),
    monitors: seed.monitors ?? new Map(),
    notifications: seed.notifications ?? new Map(),
    runs: seed.runs ?? new Map(),
    steps: seed.steps ?? new Map(),
    traces: seed.traces ?? new Map(),
    toolCalls: seed.toolCalls ?? new Map(),
  };
}

function appendMemoryEvent(state, runId, type, data = {}, now = new Date()) {
  const events = state.events.get(runId) ?? [];
  const event = {
    availableAt: iso(now),
    createdAt: iso(now),
    data: clone(data),
    deliveryAttempts: 0,
    deliveryStatus: 'pending',
    id: randomUUID(),
    runId,
    sequence: events.length + 1,
    type,
  };
  events.push(event);
  state.events.set(runId, events);
  return clone(event);
}

function findByIdempotency(records, tenantId, idempotencyKey) {
  return [...records.values()].find((record) => (
    record.tenantId === tenantId && record.idempotencyKey === idempotencyKey
  ));
}

export function createInMemoryAgentExecutionRepository({ state: providedState } = {}) {
  const state = createState(providedState);

  async function enqueueRun(input) {
    const parsed = enqueueAgentRunSchema.parse(input);
    const existing = findByIdempotency(state.runs, parsed.tenantId, parsed.idempotencyKey);
    if (existing) return { created: false, run: clone(existing) };
    const now = new Date();
    const run = {
      ...parsed,
      attemptCount: 0,
      availableAt: iso(now),
      completedAt: null,
      createdAt: iso(now),
      deadLetteredAt: null,
      error: null,
      id: randomUUID(),
      leaseExpiresAt: null,
      leaseToken: null,
      leaseWorkerId: null,
      output: null,
      status: 'queued',
      usage: agentRunUsageSchema.parse({}),
      updatedAt: iso(now),
    };
    state.runs.set(run.id, run);
    appendMemoryEvent(state, run.id, 'run.queued', { idempotencyKey: run.idempotencyKey }, now);
    return { created: true, run: clone(run) };
  }

  async function createGoal({ constraints = {}, ownerUserId = null, projectId = null, scope = {}, success = {}, tenantId, title }) {
    const goal = { constraints: clone(constraints), createdAt: iso(), id: randomUUID(), ownerUserId, projectId, scope: clone(scope), status: 'active', success: clone(success), tenantId, title: String(title ?? '').trim(), updatedAt: iso(), version: 1 };
    if (!goal.tenantId || !goal.title) throw new Error('Agent goal requires tenantId and title.');
    state.goals.set(goal.id, goal);
    return clone(goal);
  }

  async function updateGoal({ expectedVersion, goalId, patch = {}, tenantId }) {
    const goal = state.goals.get(goalId);
    if (!goal || goal.tenantId !== tenantId) return null;
    if (goal.version !== expectedVersion) {
      throw Object.assign(new Error('Agent goal changed since it was loaded.'), {
        code: 'agent_goal_version_conflict', actualVersion: goal.version, expectedVersion,
      });
    }
    Object.assign(goal, clone(patch), { updatedAt: iso(), version: goal.version + 1 });
    return clone(goal);
  }

  async function createMonitor({ goalId, input, ownerUserId, projectId = null, tenantId }) {
    const parsed = createAgentMonitorSchema.parse(input);
    const now = new Date();
    const monitor = {
      ...clone(parsed), createdAt: iso(now), enabled: true, goalId, id: randomUUID(),
      lastEvaluatedAt: null, nextRunAt: parsed.triggerType === 'schedule' ? iso(parsed.nextRunAt ?? now) : null,
      ownerUserId, projectId, runCount: 0, stop: { ...parsed.stop, endAt: parsed.stop.endAt ? iso(parsed.stop.endAt) : null },
      tenantId, updatedAt: iso(now), updatedByUserId: ownerUserId, version: 1,
    };
    state.monitors.set(monitor.id, monitor);
    return clone(monitor);
  }

  async function createNotification({ dedupeKey, evidence = {}, goalId, kind, message, monitorId = null, ownerUserId, projectId = null, severity = 'warning', tenantId, title }) {
    const existing = [...state.notifications.values()].find((item) => item.tenantId === tenantId && item.dedupeKey === dedupeKey);
    if (existing) return { created: false, notification: clone(existing) };
    const notification = {
      createdAt: iso(), dedupeKey, evidence: clone(evidence), goalId, id: randomUUID(), kind,
      message, monitorId, ownerUserId, projectId, severity, status: 'unread', tenantId, title,
      updatedAt: iso(), version: 1,
    };
    state.notifications.set(notification.id, notification);
    return { created: true, notification: clone(notification) };
  }

  async function updateNotification({ expectedVersion, notificationId, patch = {}, tenantId }) {
    const notification = state.notifications.get(notificationId);
    if (!notification || notification.tenantId !== tenantId) return null;
    if (notification.version !== expectedVersion) {
      throw Object.assign(new Error('Agent goal notification changed since it was loaded.'), {
        actualVersion: notification.version, code: 'agent_goal_notification_version_conflict', expectedVersion,
      });
    }
    Object.assign(notification, clone(patch), { updatedAt: iso(), version: notification.version + 1 });
    return clone(notification);
  }

  // updatedByUserId: the person whose edit this is. The scheduler's own updates leave it as it was.
  async function updateMonitor({ expectedVersion, monitorId, patch = {}, tenantId, updatedByUserId = null }) {
    const monitor = state.monitors.get(monitorId);
    if (!monitor || monitor.tenantId !== tenantId) return null;
    if (monitor.version !== expectedVersion) throw Object.assign(new Error('Agent monitor changed since it was loaded.'), { code: 'agent_monitor_version_conflict', actualVersion: monitor.version, expectedVersion });
    const parsed = updateAgentMonitorSchema.parse({ ...patch, expectedVersion });
    const { expectedVersion: _expectedVersion, ...changes } = parsed;
    if (changes.nextRunAt instanceof Date) changes.nextRunAt = iso(changes.nextRunAt);
    if (changes.stop?.endAt instanceof Date) changes.stop.endAt = iso(changes.stop.endAt);
    Object.assign(monitor, clone(changes), { ...(updatedByUserId ? { updatedByUserId } : {}), updatedAt: iso(), version: monitor.version + 1 });
    return clone(monitor);
  }

  async function markMonitorFired({ monitorId, nextRunAt = null, now = new Date(), scheduledFor = null, tenantId }) {
    const monitor = state.monitors.get(monitorId);
    if (!monitor || monitor.tenantId !== tenantId) return null;
    if (scheduledFor && monitor.nextRunAt !== iso(scheduledFor)) return clone(monitor);
    monitor.lastEvaluatedAt = iso(now);
    monitor.nextRunAt = nextRunAt ? iso(nextRunAt) : monitor.nextRunAt;
    monitor.runCount += 1;
    monitor.updatedAt = iso(now);
    monitor.version += 1;
    return clone(monitor);
  }

  async function claimNextRun(input) {
    const parsed = claimAgentRunSchema.parse(input);
    const now = parsed.now ?? new Date();
    const nowMs = now.getTime();
    const candidates = [...state.runs.values()]
      .filter((run) => !parsed.runTypes?.length || parsed.runTypes.includes(run.runType))
      .filter((run) => (
        ['queued', 'retry_scheduled'].includes(run.status) && Date.parse(run.availableAt) <= nowMs
      ) || (run.status === 'running' && Date.parse(run.leaseExpiresAt ?? 0) <= nowMs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const run = candidates[0];
    if (!run) return null;
    if (run.attemptCount >= run.maxAttempts) {
      run.status = 'dead_lettered';
      run.deadLetteredAt = iso(now);
      run.updatedAt = iso(now);
      appendMemoryEvent(state, run.id, 'run.dead_lettered', { reason: 'attempts_exhausted' }, now);
      return claimNextRun(parsed);
    }
    run.attemptCount += 1;
    run.leaseToken = randomUUID();
    run.leaseWorkerId = parsed.workerId;
    run.leaseExpiresAt = iso(nowMs + parsed.leaseMs);
    run.status = 'running';
    run.updatedAt = iso(now);
    appendMemoryEvent(state, run.id, 'run.claimed', {
      attempt: run.attemptCount,
      leaseExpiresAt: run.leaseExpiresAt,
      workerId: parsed.workerId,
    }, now);
    return clone(run);
  }

  async function claimRun({ runId, ...input }) {
    const parsed = claimAgentRunSchema.parse(input);
    const run = state.runs.get(runId);
    const now = parsed.now ?? new Date();
    const claimable = run && ((['queued', 'retry_scheduled'].includes(run.status) && Date.parse(run.availableAt) <= now.getTime())
      || (run.status === 'running' && Date.parse(run.leaseExpiresAt ?? 0) <= now.getTime()));
    if (!claimable || run.attemptCount >= run.maxAttempts) return null;
    run.attemptCount += 1;
    run.leaseToken = randomUUID();
    run.leaseWorkerId = parsed.workerId;
    run.leaseExpiresAt = iso(now.getTime() + parsed.leaseMs);
    run.status = 'running';
    run.updatedAt = iso(now);
    appendMemoryEvent(state, run.id, 'run.claimed', { attempt: run.attemptCount, leaseExpiresAt: run.leaseExpiresAt, workerId: parsed.workerId }, now);
    return clone(run);
  }

  function requireOwnedRun(input) {
    const parsed = ownedAgentRunSchema.parse(input);
    const run = state.runs.get(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    if (run.leaseWorkerId !== parsed.workerId || run.leaseToken !== parsed.leaseToken) {
      const error = new Error('Agent run lease is not owned by this worker.');
      error.code = 'agent_run_lease_lost';
      throw error;
    }
    if (Date.parse(run.leaseExpiresAt ?? 0) <= (parsed.now ?? new Date()).getTime()) {
      const error = new Error('Agent run lease has expired.');
      error.code = 'agent_run_lease_expired';
      throw error;
    }
    return { parsed, run };
  }

  async function heartbeatRun(input) {
    const { parsed, run } = requireOwnedRun(input);
    const leaseMs = Math.max(100, Number(input.leaseMs ?? 30_000));
    const now = parsed.now ?? new Date();
    run.leaseExpiresAt = iso(now.getTime() + leaseMs);
    run.updatedAt = iso(now);
    appendMemoryEvent(state, run.id, 'run.heartbeat', { leaseExpiresAt: run.leaseExpiresAt }, now);
    return clone(run);
  }

  async function completeRun(input) {
    const existing = state.runs.get(String(input.runId ?? ''));
    if (existing?.status === 'completed') return clone(existing);
    const { parsed, run } = requireOwnedRun(input);
    const now = parsed.now ?? new Date();
    run.completedAt = iso(now);
    run.output = clone(input.output ?? null);
    run.status = 'completed';
    run.updatedAt = iso(now);
    run.leaseExpiresAt = null;
    run.leaseToken = null;
    run.leaseWorkerId = null;
    appendMemoryEvent(state, run.id, 'run.completed', {}, now);
    return clone(run);
  }

  async function failRun(input) {
    const parsed = failAgentRunSchema.parse(input);
    const { run } = requireOwnedRun(parsed);
    const now = parsed.now ?? new Date();
    run.error = errorRecord(parsed.error);
    run.leaseExpiresAt = null;
    run.leaseToken = null;
    run.leaseWorkerId = null;
    if (parsed.retryable && run.attemptCount < run.maxAttempts) {
      const delayMs = Math.min(60 * 60 * 1000, parsed.retryBaseMs * (2 ** Math.max(0, run.attemptCount - 1)));
      run.availableAt = iso(now.getTime() + delayMs);
      run.status = 'retry_scheduled';
      appendMemoryEvent(state, run.id, 'run.retry_scheduled', { delayMs, error: run.error }, now);
    } else {
      run.status = parsed.retryable ? 'dead_lettered' : 'failed';
      run.deadLetteredAt = run.status === 'dead_lettered' ? iso(now) : null;
      appendMemoryEvent(state, run.id, `run.${run.status}`, { error: run.error }, now);
    }
    run.updatedAt = iso(now);
    return clone(run);
  }

  async function pauseRun(runId, now = new Date()) {
    const run = state.runs.get(runId);
    if (!run || terminalStatuses.has(run.status)) return run ? clone(run) : null;
    run.status = 'paused';
    run.leaseExpiresAt = null;
    run.leaseToken = null;
    run.leaseWorkerId = null;
    run.updatedAt = iso(now);
    appendMemoryEvent(state, run.id, 'run.paused', {}, now);
    return clone(run);
  }

  async function resumeRun(runId, { fromStepId = null, now = new Date() } = {}) {
    const run = state.runs.get(runId);
    if (!run || !['paused', 'failed', 'dead_lettered', 'cancelled'].includes(run.status)) return run ? clone(run) : null;
    run.availableAt = iso(now);
    run.attemptCount = fromStepId ? 0 : run.attemptCount;
    run.deadLetteredAt = null;
    run.error = null;
    run.status = 'queued';
    run.updatedAt = iso(now);
    appendMemoryEvent(state, run.id, fromStepId ? 'run.retry_from_step' : 'run.resumed', { fromStepId }, now);
    return clone(run);
  }

  async function cancelRun(runId, now = new Date()) {
    const run = state.runs.get(runId);
    if (!run || terminalStatuses.has(run.status)) return run ? clone(run) : null;
    run.status = 'cancelled';
    run.completedAt = iso(now);
    run.leaseExpiresAt = null;
    run.leaseToken = null;
    run.leaseWorkerId = null;
    run.updatedAt = iso(now);
    appendMemoryEvent(state, run.id, 'run.cancelled', {}, now);
    return clone(run);
  }

  async function createStep(input) {
    const parsed = createAgentStepSchema.parse(input);
    const run = state.runs.get(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const existing = [...state.steps.values()].find((step) => step.runId === parsed.runId && step.idempotencyKey === parsed.idempotencyKey);
    if (existing) return { created: false, step: clone(existing) };
    const step = { ...parsed, createdAt: iso(), id: randomUUID(), output: null, status: 'pending', tenantId: run.tenantId, updatedAt: iso() };
    state.steps.set(step.id, step);
    return { created: true, step: clone(step) };
  }

  async function createToolCall(input) {
    const parsed = createToolCallSchema.parse(input);
    const run = state.runs.get(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const existing = [...state.toolCalls.values()].find((call) => call.runId === parsed.runId && call.idempotencyKey === parsed.idempotencyKey);
    if (existing) return { created: false, toolCall: clone(existing) };
    const toolCall = { ...parsed, createdAt: iso(), error: null, id: randomUUID(), result: null, status: 'pending', tenantId: run.tenantId, updatedAt: iso() };
    state.toolCalls.set(toolCall.id, toolCall);
    return { created: true, toolCall: clone(toolCall) };
  }

  async function createApproval(input) {
    const parsed = createApprovalSchema.parse(input);
    const run = state.runs.get(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const approval = { ...parsed, createdAt: iso(), decidedAt: null, decidedBy: null, id: randomUUID(), status: 'pending', tenantId: run.tenantId, updatedAt: iso() };
    state.approvals.set(approval.id, approval);
    appendMemoryEvent(state, run.id, 'approval.requested', { approvalId: approval.id });
    return clone(approval);
  }

  async function saveCheckpoint({ checkpoint, idempotencyKey, runId, stepId = null }) {
    const run = state.runs.get(runId);
    if (!run) throw new Error('Agent run not found.');
    const key = `${runId}:${idempotencyKey}`;
    const existing = state.checkpoints.get(key);
    if (existing) return { checkpoint: clone(existing), created: false };
    const record = { checkpoint: clone(checkpoint), createdAt: iso(), id: randomUUID(), idempotencyKey, runId, stepId, tenantId: run.tenantId };
    state.checkpoints.set(key, record);
    appendMemoryEvent(state, run.id, 'run.checkpointed', { checkpointId: record.id, stepId });
    return { checkpoint: clone(record), created: true };
  }

  async function consumeRunUsage({ runId, usage }) {
    const run = state.runs.get(runId);
    if (!run) throw new Error('Agent run not found.');
    const delta = agentRunUsageSchema.parse(usage);
    const projected = Object.fromEntries(Object.keys(delta).map((key) => [key, run.usage[key] + delta[key]]));
    const exceeded = Object.keys(projected).filter((key) => projected[key] > run.budgets[key]);
    if (exceeded.length) {
      appendMemoryEvent(state, run.id, 'run.budget_exceeded', { budgets: clone(run.budgets), exceeded, projected });
      throw Object.assign(new Error(`Agent run budget exceeded: ${exceeded.join(', ')}.`), {
        code: 'agent_run_budget_exceeded', exceeded, projected,
      });
    }
    run.usage = projected;
    run.updatedAt = iso();
    appendMemoryEvent(state, run.id, 'run.usage_recorded', { delta, usage: projected });
    return clone(run);
  }

  async function recordTrace(input) {
    const parsed = recordAgentRunTraceSchema.parse(input);
    const run = state.runs.get(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const traces = state.traces.get(run.id) ?? [];
    const existing = traces.find((trace) => trace.idempotencyKey === parsed.idempotencyKey);
    if (existing) return { created: false, trace: clone(existing) };
    const trace = { ...parsed, createdAt: iso(), id: randomUUID(), tenantId: run.tenantId };
    traces.push(trace);
    state.traces.set(run.id, traces);
    appendMemoryEvent(state, run.id, 'run.trace_recorded', { traceId: trace.id, traceType: trace.traceType });
    return { created: true, trace: clone(trace) };
  }

  return {
    appendEvent: async ({ data, runId, type }) => appendMemoryEvent(state, runId, type, data),
    cancelRun,
    claimNextRun,
    claimRun,
    completeRun,
    consumeRunUsage,
    createGoal,
    createMonitor,
    createNotification,
    createApproval,
    createStep,
    createToolCall,
    enqueueRun,
    failRun,
    getRun: async (runId) => clone(state.runs.get(runId) ?? null),
    getGoal: async ({ goalId, tenantId }) => {
      const goal = state.goals.get(goalId);
      return clone(goal?.tenantId === tenantId ? goal : null);
    },
    getMonitor: async ({ monitorId, tenantId }) => {
      const monitor = state.monitors.get(monitorId);
      return clone(monitor?.tenantId === tenantId ? monitor : null);
    },
    getNotification: async ({ notificationId, tenantId }) => {
      const notification = state.notifications.get(notificationId);
      return clone(notification?.tenantId === tenantId ? notification : null);
    },
    heartbeatRun,
    listEvents: async (runId) => clone(state.events.get(runId) ?? []),
    listGoals: async ({ ownerUserId = null, projectId = null, tenantId }) => clone([...state.goals.values()]
      .filter((goal) => goal.tenantId === tenantId)
      .filter((goal) => projectId == null || goal.projectId === projectId)
      .filter((goal) => ownerUserId == null || goal.ownerUserId === ownerUserId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))),
    listDueMonitors: async ({ limit = 100, now = new Date() }) => clone([...state.monitors.values()]
      .filter((monitor) => monitor.enabled && monitor.triggerType === 'schedule' && Date.parse(monitor.nextRunAt ?? '') <= now.getTime())
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))
      .slice(0, limit)),
    listEventMonitors: async ({ eventType, projectId = null, tenantId }) => clone([...state.monitors.values()]
      .filter((monitor) => monitor.enabled && monitor.triggerType === 'event' && monitor.tenantId === tenantId && monitor.eventType === eventType)
      .filter((monitor) => projectId == null || monitor.projectId === projectId)),
    listMonitors: async ({ goalId, tenantId }) => clone([...state.monitors.values()]
      .filter((monitor) => monitor.tenantId === tenantId && monitor.goalId === goalId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))),
    listNotifications: async ({ goalId = null, ownerUserId = null, projectId = null, status = null, tenantId }) => clone([...state.notifications.values()]
      .filter((item) => item.tenantId === tenantId)
      .filter((item) => goalId == null || item.goalId === goalId)
      .filter((item) => ownerUserId == null || item.ownerUserId === ownerUserId)
      .filter((item) => projectId == null || item.projectId === projectId)
      .filter((item) => status == null || item.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))),
    listRuns: async ({ goalId = null, tenantId }) => clone([...state.runs.values()]
      .filter((run) => run.tenantId === tenantId && (goalId == null || run.goalId === goalId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))),
    listTraces: async (runId) => clone(state.traces.get(runId) ?? []),
    pauseRun,
    markMonitorFired,
    resumeRun,
    recordTrace,
    saveCheckpoint,
    state,
    updateGoal,
    updateMonitor,
    updateNotification,
  };
}

export async function ensureMysqlAgentGoalAutomationSchema(executor) {
  const [versionColumns = []] = await executor.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_goals' AND column_name = 'version'`);
  if (versionColumns.length === 0) {
    await executor.execute(`ALTER TABLE agent_goals ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER status`);
  }
  await executor.execute(`CREATE TABLE IF NOT EXISTS agent_goal_monitors (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, goal_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NULL, owner_user_id VARCHAR(36) NOT NULL, title VARCHAR(255) NOT NULL, trigger_type VARCHAR(32) NOT NULL, event_type VARCHAR(128) NULL, interval_minutes INT NULL, next_run_at DATETIME(3) NULL, last_evaluated_at DATETIME(3) NULL, enabled TINYINT(1) NOT NULL DEFAULT 1, condition_json JSON NOT NULL, payload_json JSON NOT NULL, stop_json JSON NOT NULL, run_count INT NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_agent_monitors_due (enabled, trigger_type, next_run_at), KEY idx_agent_monitors_event (enabled, event_type), KEY idx_agent_monitors_goal (tenant_id, goal_id))`);
}

// Who last created or changed each goal monitor (migration 0077). Monitors from before it have no
// one recorded, so their runs stay read-only until the goal's owner saves them again.
export async function ensureMysqlAgentMonitorEditorSchema(executor) {
  const [columns = []] = await executor.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_goal_monitors' AND column_name = 'updated_by_user_id'`);
  if (columns.length === 0) await executor.execute('ALTER TABLE agent_goal_monitors ADD COLUMN updated_by_user_id VARCHAR(36) NULL AFTER owner_user_id');
}

export async function ensureMysqlAgentGoalNotificationSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS agent_goal_notifications (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, goal_id VARCHAR(36) NOT NULL, monitor_id VARCHAR(36) NULL, project_id VARCHAR(36) NULL, owner_user_id VARCHAR(36) NOT NULL, kind VARCHAR(64) NOT NULL, severity VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, title VARCHAR(255) NOT NULL, message TEXT NOT NULL, evidence_json JSON NOT NULL, dedupe_key VARCHAR(255) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_agent_goal_notification_dedupe (tenant_id, dedupe_key), KEY idx_agent_goal_notifications_owner (tenant_id, owner_user_id, status, created_at), KEY idx_agent_goal_notifications_goal (tenant_id, goal_id, created_at))`);
}

export async function ensureMysqlAgentExecutionSchema(executor) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS agent_goals (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NULL, owner_user_id VARCHAR(36) NULL, title VARCHAR(255) NOT NULL, status VARCHAR(32) NOT NULL, scope_json JSON NOT NULL, success_json JSON NOT NULL, constraints_json JSON NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_agent_goals_tenant_status (tenant_id, status))`,
    `CREATE TABLE IF NOT EXISTS agent_runs (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, goal_id VARCHAR(36) NULL, project_id VARCHAR(36) NULL, session_id VARCHAR(128) NULL, user_id VARCHAR(36) NULL, run_type VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, idempotency_key VARCHAR(128) NOT NULL, payload_json JSON NOT NULL, output_json JSON NULL, error_json JSON NULL, attempt_count INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 5, available_at DATETIME(3) NOT NULL, lease_worker_id VARCHAR(128) NULL, lease_token VARCHAR(36) NULL, lease_expires_at DATETIME(3) NULL, completed_at DATETIME(3) NULL, dead_lettered_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_agent_runs_tenant_idempotency (tenant_id, idempotency_key), KEY idx_agent_runs_claim (status, available_at, lease_expires_at), KEY idx_agent_runs_session (session_id))`,
    `CREATE TABLE IF NOT EXISTS agent_steps (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, run_id VARCHAR(36) NOT NULL, sequence_no INT NOT NULL, name VARCHAR(128) NOT NULL, step_type VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, idempotency_key VARCHAR(128) NOT NULL, input_json JSON NOT NULL, output_json JSON NULL, error_json JSON NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_agent_steps_run_idempotency (run_id, idempotency_key), KEY idx_agent_steps_run_sequence (run_id, sequence_no))`,
    `CREATE TABLE IF NOT EXISTS tool_calls (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, run_id VARCHAR(36) NOT NULL, step_id VARCHAR(36) NULL, tool_name VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL, idempotency_key VARCHAR(128) NOT NULL, arguments_json JSON NOT NULL, result_json JSON NULL, error_json JSON NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_tool_calls_run_idempotency (run_id, idempotency_key), KEY idx_tool_calls_run (run_id))`,
    `CREATE TABLE IF NOT EXISTS approvals (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, run_id VARCHAR(36) NOT NULL, step_id VARCHAR(36) NULL, tool_call_id VARCHAR(36) NULL, status VARCHAR(32) NOT NULL, summary TEXT NOT NULL, policy_json JSON NOT NULL, requested_by VARCHAR(36) NULL, decided_by VARCHAR(36) NULL, expires_at DATETIME(3) NULL, decided_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_approvals_run_status (run_id, status))`,
    `CREATE TABLE IF NOT EXISTS run_events (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, run_id VARCHAR(36) NOT NULL, sequence_no BIGINT NOT NULL, event_type VARCHAR(128) NOT NULL, data_json JSON NOT NULL, delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending', delivery_attempts INT NOT NULL DEFAULT 0, available_at DATETIME(3) NOT NULL, delivery_lease_token VARCHAR(36) NULL, delivery_lease_expires_at DATETIME(3) NULL, published_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, UNIQUE KEY uq_run_events_sequence (run_id, sequence_no), KEY idx_run_events_run_created (run_id, created_at), KEY idx_run_events_delivery (delivery_status, available_at, delivery_lease_expires_at))`,
    `CREATE TABLE IF NOT EXISTS run_checkpoints (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, run_id VARCHAR(36) NOT NULL, step_id VARCHAR(36) NULL, idempotency_key VARCHAR(128) NOT NULL, checkpoint_json JSON NOT NULL, created_at DATETIME(3) NOT NULL, UNIQUE KEY uq_run_checkpoints_idempotency (run_id, idempotency_key), KEY idx_run_checkpoints_run_created (run_id, created_at))`,
    `CREATE TABLE IF NOT EXISTS run_budgets (run_id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, budget_json JSON NOT NULL, usage_json JSON NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_run_budgets_tenant (tenant_id))`,
    `CREATE TABLE IF NOT EXISTS run_traces (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, run_id VARCHAR(36) NOT NULL, step_id VARCHAR(36) NULL, tool_call_id VARCHAR(36) NULL, trace_type VARCHAR(32) NOT NULL, idempotency_key VARCHAR(128) NOT NULL, model VARCHAR(128) NULL, prompt_id VARCHAR(128) NULL, request_id VARCHAR(256) NULL, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, cost_usd DECIMAL(16,8) NOT NULL DEFAULT 0, latency_ms BIGINT NOT NULL DEFAULT 0, policy_json JSON NULL, eval_json JSON NULL, metadata_json JSON NOT NULL, created_at DATETIME(3) NOT NULL, UNIQUE KEY uq_run_traces_idempotency (run_id, idempotency_key), KEY idx_run_traces_run_created (run_id, created_at))`,
  ];
  for (const statement of statements) await executor.execute(statement);
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function mapMysqlRun(row) {
  if (!row) return null;
  return {
    attemptCount: Number(row.attempt_count),
    availableAt: iso(row.available_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    deadLetteredAt: row.dead_lettered_at ? iso(row.dead_lettered_at) : null,
    error: parseJson(row.error_json),
    goalId: row.goal_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    leaseToken: row.lease_token,
    leaseWorkerId: row.lease_worker_id,
    maxAttempts: Number(row.max_attempts),
    output: parseJson(row.output_json),
    payload: parseJson(row.payload_json, {}),
    projectId: row.project_id,
    runType: row.run_type,
    sessionId: row.session_id,
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: iso(row.updated_at),
    userId: row.user_id,
  };
}

function mapMysqlTrace(row) {
  return row ? {
    costUsd: Number(row.cost_usd), createdAt: iso(row.created_at), eval: parseJson(row.eval_json),
    id: row.id, idempotencyKey: row.idempotency_key, inputTokens: Number(row.input_tokens),
    latencyMs: Number(row.latency_ms), metadata: parseJson(row.metadata_json, {}), model: row.model,
    outputTokens: Number(row.output_tokens), policy: parseJson(row.policy_json), promptId: row.prompt_id,
    requestId: row.request_id, runId: row.run_id, stepId: row.step_id, tenantId: row.tenant_id,
    toolCallId: row.tool_call_id, traceType: row.trace_type,
  } : null;
}

function mapMysqlGoal(row) {
  return row ? {
    constraints: parseJson(row.constraints_json, {}), createdAt: iso(row.created_at), id: row.id,
    ownerUserId: row.owner_user_id, projectId: row.project_id, scope: parseJson(row.scope_json, {}),
    status: row.status, success: parseJson(row.success_json, {}), tenantId: row.tenant_id, title: row.title,
    updatedAt: iso(row.updated_at), version: Number(row.version ?? 1),
  } : null;
}

function mapMysqlMonitor(row) {
  return row ? {
    condition: parseJson(row.condition_json, {}), createdAt: iso(row.created_at), enabled: Boolean(row.enabled),
    eventType: row.event_type, goalId: row.goal_id, id: row.id, intervalMinutes: row.interval_minutes == null ? null : Number(row.interval_minutes),
    lastEvaluatedAt: row.last_evaluated_at ? iso(row.last_evaluated_at) : null, nextRunAt: row.next_run_at ? iso(row.next_run_at) : null,
    ownerUserId: row.owner_user_id, payload: parseJson(row.payload_json, {}), projectId: row.project_id, runCount: Number(row.run_count),
    stop: parseJson(row.stop_json, {}), tenantId: row.tenant_id, title: row.title, triggerType: row.trigger_type,
    updatedAt: iso(row.updated_at), updatedByUserId: row.updated_by_user_id ?? null, version: Number(row.version),
  } : null;
}

function mapMysqlNotification(row) {
  return row ? {
    createdAt: iso(row.created_at), dedupeKey: row.dedupe_key, evidence: parseJson(row.evidence_json, {}),
    goalId: row.goal_id, id: row.id, kind: row.kind, message: row.message, monitorId: row.monitor_id,
    ownerUserId: row.owner_user_id, projectId: row.project_id, severity: row.severity, status: row.status,
    tenantId: row.tenant_id, title: row.title, updatedAt: iso(row.updated_at), version: Number(row.version),
  } : null;
}

export function createMysqlAgentExecutionRepository({ pool }) {
  async function attachBudget(run, executor = pool) {
    if (!run) return null;
    const [rows] = await executor.execute('SELECT budget_json, usage_json FROM run_budgets WHERE run_id = ? LIMIT 1', [run.id]);
    return {
      ...run,
      budgets: parseJson(rows[0]?.budget_json, {}),
      usage: parseJson(rows[0]?.usage_json, agentRunUsageSchema.parse({})),
    };
  }
  async function createGoal({ constraints = {}, ownerUserId = null, projectId = null, scope = {}, success = {}, tenantId, title }) {
    const goal = { id: randomUUID(), status: 'active', tenantId, title: String(title ?? '').trim() };
    if (!goal.tenantId || !goal.title) throw new Error('Agent goal requires tenantId and title.');
    const now = new Date();
    await pool.execute(`INSERT INTO agent_goals (id, tenant_id, project_id, owner_user_id, title, status, version, scope_json, success_json, constraints_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`, [goal.id, tenantId, projectId, ownerUserId, goal.title, JSON.stringify(scope), JSON.stringify(success), JSON.stringify(constraints), now, now]);
    return { ...goal, constraints, createdAt: iso(now), ownerUserId, projectId, scope, success, updatedAt: iso(now), version: 1 };
  }
  async function createNotification({ dedupeKey, evidence = {}, goalId, kind, message, monitorId = null, ownerUserId, projectId = null, severity = 'warning', tenantId, title }) {
    const id = randomUUID(); const now = new Date();
    const [result] = await pool.execute(`INSERT IGNORE INTO agent_goal_notifications (id, tenant_id, goal_id, monitor_id, project_id, owner_user_id, kind, severity, status, title, message, evidence_json, dedupe_key, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, 1, ?, ?)`, [id, tenantId, goalId, monitorId, projectId, ownerUserId, kind, severity, title, message, JSON.stringify(evidence), dedupeKey, now, now]);
    const [rows] = await pool.execute('SELECT * FROM agent_goal_notifications WHERE tenant_id = ? AND dedupe_key = ? LIMIT 1', [tenantId, dedupeKey]);
    return { created: Number(result.affectedRows) === 1, notification: mapMysqlNotification(rows[0]) };
  }
  async function listNotifications({ goalId = null, ownerUserId = null, projectId = null, status = null, tenantId }) {
    const clauses = ['tenant_id = ?']; const params = [tenantId];
    if (goalId != null) { clauses.push('goal_id = ?'); params.push(goalId); }
    if (ownerUserId != null) { clauses.push('owner_user_id = ?'); params.push(ownerUserId); }
    if (projectId != null) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status != null) { clauses.push('status = ?'); params.push(status); }
    const [rows] = await pool.execute(`SELECT * FROM agent_goal_notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id`, params);
    return rows.map(mapMysqlNotification);
  }
  async function getNotification({ notificationId, tenantId }) {
    const [rows] = await pool.execute('SELECT * FROM agent_goal_notifications WHERE id = ? AND tenant_id = ? LIMIT 1', [notificationId, tenantId]);
    return mapMysqlNotification(rows[0]);
  }
  async function updateNotification({ expectedVersion, notificationId, patch = {}, tenantId }) {
    const [result] = await pool.execute(`UPDATE agent_goal_notifications SET status = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [patch.status, notificationId, tenantId, expectedVersion]);
    if (Number(result.affectedRows) !== 1) {
      const [rows] = await pool.execute('SELECT version FROM agent_goal_notifications WHERE id = ? AND tenant_id = ? LIMIT 1', [notificationId, tenantId]);
      if (rows.length === 0) return null;
      throw Object.assign(new Error('Agent goal notification changed since it was loaded.'), { actualVersion: Number(rows[0].version), code: 'agent_goal_notification_version_conflict', expectedVersion });
    }
    const [rows] = await pool.execute('SELECT * FROM agent_goal_notifications WHERE id = ? AND tenant_id = ? LIMIT 1', [notificationId, tenantId]);
    return mapMysqlNotification(rows[0]);
  }
  async function getGoal({ goalId, tenantId }) {
    const [rows] = await pool.execute('SELECT * FROM agent_goals WHERE id = ? AND tenant_id = ? LIMIT 1', [goalId, tenantId]);
    return mapMysqlGoal(rows[0]);
  }
  async function listGoals({ ownerUserId = null, projectId = null, tenantId }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenantId];
    if (projectId != null) { clauses.push('project_id = ?'); params.push(projectId); }
    if (ownerUserId != null) { clauses.push('owner_user_id = ?'); params.push(ownerUserId); }
    const [rows] = await pool.execute(`SELECT * FROM agent_goals WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id`, params);
    return rows.map(mapMysqlGoal);
  }
  async function updateGoal({ expectedVersion, goalId, patch = {}, tenantId }) {
    const existing = await getGoal({ goalId, tenantId });
    if (!existing) return null;
    const next = { ...existing, ...patch };
    const [result] = await pool.execute(`UPDATE agent_goals SET project_id = ?, title = ?, status = ?, scope_json = ?, success_json = ?, constraints_json = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [next.projectId, next.title, next.status, JSON.stringify(next.scope), JSON.stringify(next.success), JSON.stringify(next.constraints), goalId, tenantId, expectedVersion]);
    if (Number(result.affectedRows) !== 1) {
      const current = await getGoal({ goalId, tenantId });
      throw Object.assign(new Error('Agent goal changed since it was loaded.'), { code: 'agent_goal_version_conflict', actualVersion: current?.version ?? null, expectedVersion });
    }
    return getGoal({ goalId, tenantId });
  }
  async function listRuns({ goalId = null, tenantId }) {
    const clauses = ['tenant_id = ?']; const params = [tenantId];
    if (goalId != null) { clauses.push('goal_id = ?'); params.push(goalId); }
    const [rows] = await pool.execute(`SELECT * FROM agent_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id`, params);
    return Promise.all(rows.map((row) => attachBudget(mapMysqlRun(row))));
  }
  async function createMonitor({ goalId, input, ownerUserId, projectId = null, tenantId }) {
    const parsed = createAgentMonitorSchema.parse(input); const id = randomUUID(); const now = new Date();
    const nextRunAt = parsed.triggerType === 'schedule' ? (parsed.nextRunAt ?? now) : null;
    const stop = { ...parsed.stop, endAt: parsed.stop.endAt ? iso(parsed.stop.endAt) : null };
    await pool.execute(`INSERT INTO agent_goal_monitors (id, tenant_id, goal_id, project_id, owner_user_id, updated_by_user_id, title, trigger_type, event_type, interval_minutes, next_run_at, enabled, condition_json, payload_json, stop_json, run_count, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 1, ?, ?)`, [id, tenantId, goalId, projectId, ownerUserId, ownerUserId, parsed.title, parsed.triggerType, parsed.eventType, parsed.intervalMinutes, nextRunAt, JSON.stringify(parsed.condition), JSON.stringify(parsed.payload), JSON.stringify(stop), now, now]);
    return getMonitor({ monitorId: id, tenantId });
  }
  async function getMonitor({ monitorId, tenantId }) {
    const [rows] = await pool.execute('SELECT * FROM agent_goal_monitors WHERE id = ? AND tenant_id = ? LIMIT 1', [monitorId, tenantId]);
    return mapMysqlMonitor(rows[0]);
  }
  async function listMonitors({ goalId, tenantId }) {
    const [rows] = await pool.execute('SELECT * FROM agent_goal_monitors WHERE tenant_id = ? AND goal_id = ? ORDER BY updated_at DESC, id', [tenantId, goalId]);
    return rows.map(mapMysqlMonitor);
  }
  async function listDueMonitors({ limit = 100, now = new Date() }) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const [rows] = await pool.execute(`SELECT * FROM agent_goal_monitors WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ${safeLimit}`, [now]);
    return rows.map(mapMysqlMonitor);
  }
  async function listEventMonitors({ eventType, projectId = null, tenantId }) {
    const [rows] = projectId == null
      ? await pool.execute(`SELECT * FROM agent_goal_monitors WHERE enabled = 1 AND trigger_type = 'event' AND tenant_id = ? AND event_type = ? ORDER BY id`, [tenantId, eventType])
      : await pool.execute(`SELECT * FROM agent_goal_monitors WHERE enabled = 1 AND trigger_type = 'event' AND tenant_id = ? AND event_type = ? AND project_id = ? ORDER BY id`, [tenantId, eventType, projectId]);
    return rows.map(mapMysqlMonitor);
  }
  async function updateMonitor({ expectedVersion, monitorId, patch = {}, tenantId, updatedByUserId = null }) {
    const existing = await getMonitor({ monitorId, tenantId }); if (!existing) return null;
    const parsed = updateAgentMonitorSchema.parse({ ...patch, expectedVersion });
    const next = { ...existing, ...parsed, stop: parsed.stop ? { ...parsed.stop, endAt: parsed.stop.endAt ? iso(parsed.stop.endAt) : null } : existing.stop };
    const [result] = await pool.execute(`UPDATE agent_goal_monitors SET title = ?, event_type = ?, interval_minutes = ?, next_run_at = ?, enabled = ?, condition_json = ?, payload_json = ?, stop_json = ?, updated_by_user_id = COALESCE(?, updated_by_user_id), version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [next.title, next.eventType, next.intervalMinutes, next.nextRunAt ? new Date(next.nextRunAt) : null, next.enabled ? 1 : 0, JSON.stringify(next.condition), JSON.stringify(next.payload), JSON.stringify(next.stop), updatedByUserId, monitorId, tenantId, expectedVersion]);
    if (Number(result.affectedRows) !== 1) { const current = await getMonitor({ monitorId, tenantId }); throw Object.assign(new Error('Agent monitor changed since it was loaded.'), { code: 'agent_monitor_version_conflict', actualVersion: current?.version ?? null, expectedVersion }); }
    return getMonitor({ monitorId, tenantId });
  }
  async function markMonitorFired({ monitorId, nextRunAt = null, now = new Date(), scheduledFor = null, tenantId }) {
    const clauses = ['id = ?', 'tenant_id = ?']; const params = [nextRunAt, now, now, monitorId, tenantId];
    if (scheduledFor) { clauses.push('next_run_at = ?'); params.push(scheduledFor); }
    await pool.execute(`UPDATE agent_goal_monitors SET next_run_at = ?, last_evaluated_at = ?, run_count = run_count + 1, version = version + 1, updated_at = ? WHERE ${clauses.join(' AND ')}`, params);
    return getMonitor({ monitorId, tenantId });
  }
  async function enqueueRun(input) {
    const parsed = enqueueAgentRunSchema.parse(input);
    const id = randomUUID();
    const now = new Date();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT IGNORE INTO agent_runs (id, tenant_id, goal_id, project_id, session_id, user_id, run_type, status, idempotency_key, payload_json, attempt_count, max_attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?)`,
        [id, parsed.tenantId, parsed.goalId ?? null, parsed.projectId ?? null, parsed.sessionId ?? null, parsed.userId ?? null, parsed.runType, parsed.idempotencyKey, JSON.stringify(parsed.payload), parsed.maxAttempts, now, now, now],
      );
      const created = Number(result.affectedRows) === 1;
      if (created) await connection.execute(`INSERT INTO run_budgets (run_id, tenant_id, budget_json, usage_json, updated_at) VALUES (?, ?, ?, ?, ?)`, [id, parsed.tenantId, JSON.stringify(parsed.budgets), JSON.stringify(agentRunUsageSchema.parse({})), now]);
      const [rows] = await connection.execute('SELECT * FROM agent_runs WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1', [parsed.tenantId, parsed.idempotencyKey]);
      const run = await attachBudget(mapMysqlRun(rows[0]), connection);
      await connection.commit();
      return { created, run };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async function claimNextRun(input) {
    const parsed = claimAgentRunSchema.parse(input);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const now = parsed.now ?? new Date();
      const typeClause = parsed.runTypes?.length ? ` AND run_type IN (${parsed.runTypes.map(() => '?').join(', ')})` : '';
      const [rows] = await connection.execute(
        `SELECT * FROM agent_runs WHERE (((status IN ('queued', 'retry_scheduled')) AND available_at <= ?) OR (status = 'running' AND lease_expires_at <= ?))${typeClause} AND attempt_count < max_attempts ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now, now, ...(parsed.runTypes ?? [])],
      );
      if (!rows[0]) { await connection.commit(); return null; }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + parsed.leaseMs);
      await connection.execute(`UPDATE agent_runs SET status = 'running', attempt_count = attempt_count + 1, lease_worker_id = ?, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`, [parsed.workerId, leaseToken, leaseExpiresAt, now, rows[0].id]);
      const [claimedRows] = await connection.execute('SELECT * FROM agent_runs WHERE id = ?', [rows[0].id]);
      await connection.commit();
      return attachBudget(mapMysqlRun(claimedRows[0]), connection);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function claimRun({ runId, ...input }) {
    const parsed = claimAgentRunSchema.parse(input);
    const now = parsed.now ?? new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + parsed.leaseMs);
    const [result] = await pool.execute(
      `UPDATE agent_runs SET status = 'running', attempt_count = attempt_count + 1, lease_worker_id = ?, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND attempt_count < max_attempts AND (((status IN ('queued', 'retry_scheduled')) AND available_at <= ?) OR (status = 'running' AND lease_expires_at <= ?))`,
      [parsed.workerId, leaseToken, leaseExpiresAt, now, runId, now, now],
    );
    if (Number(result.affectedRows) !== 1) return null;
    const [rows] = await pool.execute('SELECT * FROM agent_runs WHERE id = ?', [runId]);
    return attachBudget(mapMysqlRun(rows[0]));
  }

  async function heartbeatRun(input) {
    const parsed = ownedAgentRunSchema.parse(input);
    const now = parsed.now ?? new Date();
    const expires = new Date(now.getTime() + Math.max(100, Number(input.leaseMs ?? 30_000)));
    const [result] = await pool.execute(`UPDATE agent_runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_worker_id = ? AND lease_token = ? AND lease_expires_at > ?`, [expires, now, parsed.runId, parsed.workerId, parsed.leaseToken, now]);
    if (Number(result.affectedRows) !== 1) throw Object.assign(new Error('Agent run lease is not owned or has expired.'), { code: 'agent_run_lease_lost' });
    const [rows] = await pool.execute('SELECT * FROM agent_runs WHERE id = ?', [parsed.runId]);
    return attachBudget(mapMysqlRun(rows[0]));
  }

  async function completeRun(input) {
    const parsed = ownedAgentRunSchema.parse(input);
    const now = parsed.now ?? new Date();
    const [result] = await pool.execute(`UPDATE agent_runs SET status = 'completed', output_json = ?, completed_at = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_worker_id = ? AND lease_token = ? AND lease_expires_at > ?`, [JSON.stringify(input.output ?? null), now, now, parsed.runId, parsed.workerId, parsed.leaseToken, now]);
    if (Number(result.affectedRows) !== 1) {
      const [rows] = await pool.execute('SELECT * FROM agent_runs WHERE id = ?', [parsed.runId]);
      if (rows[0]?.status === 'completed') return attachBudget(mapMysqlRun(rows[0]));
      throw Object.assign(new Error('Agent run lease is not owned or has expired.'), { code: 'agent_run_lease_lost' });
    }
    const [rows] = await pool.execute('SELECT * FROM agent_runs WHERE id = ?', [parsed.runId]);
    return attachBudget(mapMysqlRun(rows[0]));
  }

  async function getRun(runId) {
    const [rows] = await pool.execute('SELECT * FROM agent_runs WHERE id = ? LIMIT 1', [runId]);
    return attachBudget(mapMysqlRun(rows[0]));
  }

  async function failRun(input) {
    const parsed = failAgentRunSchema.parse(input);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const now = parsed.now ?? new Date();
      const [rows] = await connection.execute('SELECT * FROM agent_runs WHERE id = ? LIMIT 1 FOR UPDATE', [parsed.runId]);
      const run = mapMysqlRun(rows[0]);
      if (!run || run.status !== 'running' || run.leaseWorkerId !== parsed.workerId || run.leaseToken !== parsed.leaseToken || Date.parse(run.leaseExpiresAt) <= now.getTime()) {
        throw Object.assign(new Error('Agent run lease is not owned or has expired.'), { code: 'agent_run_lease_lost' });
      }
      const retry = parsed.retryable && run.attemptCount < run.maxAttempts;
      const status = retry ? 'retry_scheduled' : parsed.retryable ? 'dead_lettered' : 'failed';
      const delayMs = retry ? Math.min(60 * 60 * 1000, parsed.retryBaseMs * (2 ** Math.max(0, run.attemptCount - 1))) : 0;
      await connection.execute(
        `UPDATE agent_runs SET status = ?, error_json = ?, available_at = ?, dead_lettered_at = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        [status, JSON.stringify(errorRecord(parsed.error)), new Date(now.getTime() + delayMs), status === 'dead_lettered' ? now : null, now, parsed.runId],
      );
      await connection.commit();
      return getRun(parsed.runId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function setRunStatus(runId, status, { fromStepId = null, now = new Date() } = {}) {
    const terminal = status === 'cancelled';
    const [result] = await pool.execute(
      `UPDATE agent_runs SET status = ?, available_at = ?, error_json = ${status === 'queued' ? 'NULL' : 'error_json'}, dead_lettered_at = ${status === 'queued' ? 'NULL' : 'dead_lettered_at'}, completed_at = ?, lease_worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [status, now, terminal ? now : null, now, runId],
    );
    if (Number(result.affectedRows) !== 1) return null;
    if (fromStepId) await appendEvent({ data: { fromStepId }, runId, type: 'run.retry_from_step' });
    return getRun(runId);
  }

  async function appendEvent({ data = {}, runId, type }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [runs] = await connection.execute('SELECT tenant_id FROM agent_runs WHERE id = ? LIMIT 1 FOR UPDATE', [runId]);
      if (!runs[0]) throw new Error('Agent run not found.');
      const [sequences] = await connection.execute('SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?', [runId]);
      const event = { createdAt: iso(), data, id: randomUUID(), runId, sequence: Number(sequences[0]?.next_sequence ?? 1), type };
      await connection.execute(`INSERT INTO run_events (id, tenant_id, run_id, sequence_no, event_type, data_json, delivery_status, delivery_attempts, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, [event.id, runs[0].tenant_id, runId, event.sequence, type, JSON.stringify(data), new Date(event.createdAt), new Date(event.createdAt)]);
      await connection.commit();
      return event;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function listEvents(runId) {
    const [rows] = await pool.execute('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence_no ASC', [runId]);
    return rows.map((row) => ({ createdAt: iso(row.created_at), data: parseJson(row.data_json, {}), id: row.id, runId: row.run_id, sequence: Number(row.sequence_no), type: row.event_type }));
  }

  async function createStep(input) {
    const parsed = createAgentStepSchema.parse(input);
    const run = await getRun(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const id = randomUUID();
    const now = new Date();
    const [result] = await pool.execute(`INSERT IGNORE INTO agent_steps (id, tenant_id, run_id, sequence_no, name, step_type, status, idempotency_key, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, [id, run.tenantId, run.id, parsed.sequence, parsed.name, parsed.stepType, parsed.idempotencyKey, JSON.stringify(parsed.input), now, now]);
    const [rows] = await pool.execute('SELECT * FROM agent_steps WHERE run_id = ? AND idempotency_key = ? LIMIT 1', [run.id, parsed.idempotencyKey]);
    return { created: Number(result.affectedRows) === 1, step: rows[0] ?? null };
  }

  async function createToolCall(input) {
    const parsed = createToolCallSchema.parse(input);
    const run = await getRun(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const id = randomUUID();
    const now = new Date();
    const [result] = await pool.execute(`INSERT IGNORE INTO tool_calls (id, tenant_id, run_id, step_id, tool_name, status, idempotency_key, arguments_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, [id, run.tenantId, run.id, parsed.stepId, parsed.toolName, parsed.idempotencyKey, JSON.stringify(parsed.arguments), now, now]);
    const [rows] = await pool.execute('SELECT * FROM tool_calls WHERE run_id = ? AND idempotency_key = ? LIMIT 1', [run.id, parsed.idempotencyKey]);
    return { created: Number(result.affectedRows) === 1, toolCall: rows[0] ?? null };
  }

  async function createApproval(input) {
    const parsed = createApprovalSchema.parse(input);
    const run = await getRun(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const approval = { ...parsed, id: randomUUID(), status: 'pending' };
    const now = new Date();
    await pool.execute(`INSERT INTO approvals (id, tenant_id, run_id, step_id, tool_call_id, status, summary, policy_json, requested_by, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`, [approval.id, run.tenantId, run.id, parsed.stepId, parsed.toolCallId, parsed.summary, JSON.stringify(parsed.policy), parsed.requestedBy, parsed.expiresAt ?? null, now, now]);
    await appendEvent({ data: { approvalId: approval.id }, runId: run.id, type: 'approval.requested' });
    return approval;
  }

  async function saveCheckpoint({ checkpoint, idempotencyKey, runId, stepId = null }) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run not found.');
    const id = randomUUID();
    const now = new Date();
    const [result] = await pool.execute(`INSERT IGNORE INTO run_checkpoints (id, tenant_id, run_id, step_id, idempotency_key, checkpoint_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, run.tenantId, run.id, stepId, idempotencyKey, JSON.stringify(checkpoint), now]);
    const [rows] = await pool.execute('SELECT * FROM run_checkpoints WHERE run_id = ? AND idempotency_key = ? LIMIT 1', [run.id, idempotencyKey]);
    return { checkpoint: rows[0] ?? null, created: Number(result.affectedRows) === 1 };
  }

  async function consumeRunUsage({ runId, usage }) {
    const delta = agentRunUsageSchema.parse(usage);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT budget_json, usage_json FROM run_budgets WHERE run_id = ? FOR UPDATE', [runId]);
      if (!rows[0]) throw new Error('Agent run budget not found.');
      const budgets = parseJson(rows[0].budget_json, {});
      const current = parseJson(rows[0].usage_json, agentRunUsageSchema.parse({}));
      const projected = Object.fromEntries(Object.keys(delta).map((key) => [key, current[key] + delta[key]]));
      const exceeded = Object.keys(projected).filter((key) => projected[key] > budgets[key]);
      if (exceeded.length) {
        await connection.rollback();
        await appendEvent({ data: { budgets, exceeded, projected }, runId, type: 'run.budget_exceeded' });
        throw Object.assign(new Error(`Agent run budget exceeded: ${exceeded.join(', ')}.`), { code: 'agent_run_budget_exceeded', exceeded, projected });
      }
      await connection.execute('UPDATE run_budgets SET usage_json = ?, updated_at = ? WHERE run_id = ?', [JSON.stringify(projected), new Date(), runId]);
      await connection.commit();
      await appendEvent({ data: { delta, usage: projected }, runId, type: 'run.usage_recorded' });
      return { ...(await getRun(runId)), budgets, usage: projected };
    } catch (error) {
      try { await connection.rollback(); } catch (_rollbackError) {}
      throw error;
    } finally { connection.release(); }
  }

  async function recordTrace(input) {
    const parsed = recordAgentRunTraceSchema.parse(input);
    const run = await getRun(parsed.runId);
    if (!run) throw new Error('Agent run not found.');
    const id = randomUUID();
    const now = new Date();
    const [result] = await pool.execute(`INSERT IGNORE INTO run_traces (id, tenant_id, run_id, step_id, tool_call_id, trace_type, idempotency_key, model, prompt_id, request_id, input_tokens, output_tokens, cost_usd, latency_ms, policy_json, eval_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, run.tenantId, run.id, parsed.stepId ?? null, parsed.toolCallId ?? null, parsed.traceType, parsed.idempotencyKey, parsed.model ?? null, parsed.promptId ?? null, parsed.requestId ?? null, parsed.inputTokens, parsed.outputTokens, parsed.costUsd, parsed.latencyMs, parsed.policy == null ? null : JSON.stringify(parsed.policy), parsed.eval == null ? null : JSON.stringify(parsed.eval), JSON.stringify(parsed.metadata), now]);
    const [rows] = await pool.execute('SELECT * FROM run_traces WHERE run_id = ? AND idempotency_key = ? LIMIT 1', [run.id, parsed.idempotencyKey]);
    if (Number(result.affectedRows) === 1) await appendEvent({ data: { traceId: id, traceType: parsed.traceType }, runId: run.id, type: 'run.trace_recorded' });
    return { created: Number(result.affectedRows) === 1, trace: mapMysqlTrace(rows[0]) };
  }

  async function listTraces(runId) {
    const [rows] = await pool.execute('SELECT * FROM run_traces WHERE run_id = ? ORDER BY created_at ASC, id ASC', [runId]);
    return rows.map(mapMysqlTrace);
  }

  return {
    appendEvent,
    cancelRun: (runId, now) => setRunStatus(runId, 'cancelled', { now }),
    claimNextRun,
    claimRun,
    completeRun,
    consumeRunUsage,
    createApproval,
    createGoal,
    createMonitor,
    createNotification,
    createStep,
    createToolCall,
    enqueueRun,
    failRun,
    getGoal,
    getMonitor,
    getNotification,
    getRun,
    heartbeatRun,
    listEvents,
    listGoals,
    listDueMonitors,
    listEventMonitors,
    listMonitors,
    listNotifications,
    listRuns,
    listTraces,
    markMonitorFired,
    pauseRun: (runId, now) => setRunStatus(runId, 'paused', { now }),
    resumeRun: (runId, options) => setRunStatus(runId, 'queued', options),
    recordTrace,
    saveCheckpoint,
    updateGoal,
    updateMonitor,
    updateNotification,
  };
}
