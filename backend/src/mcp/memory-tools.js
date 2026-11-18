import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import { memoryTypes, sensitivities } from '../modules/memory/agent-memory.schema.js';

// What the assistant remembers and watches, for the in-app assistant only: the memory and goal
// routes refuse MCP credentials, and a monitor's checks are assistant turns.
//
// Correcting and forgetting a memory reuse Odin's checks: its author, a workspace admin, or
// someone who can edit the plan of its project, never a memory under legal hold.
//
// A monitor ("tell me if the launch slips") is an Odin goal with one scheduled monitor. Each
// check runs the assistant as the user, which reports in a new assistant chat. The goal is
// read-only (constraints.readOnly), so the check's turn refuses every change it tries: it runs
// unattended and reads content anyone could have written. Project monitors need plan-edit
// access, as goals do.

export const MONITOR_LIMITS = Object.freeze({ checks: 200, days: 365, defaultDays: 30, goals: 25 });
const WATCH_SCOPE = 'assistant-watch';
const DAY = 24 * 60 * 60 * 1000;

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

function remap(error, mapping) {
  if (error instanceof OdinApiError && mapping[error.status]) {
    const [code, message] = mapping[error.status];
    throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
}

function presentMemory(memory) {
  return {
    id: memory.id,
    title: memory.title,
    content: clip(memory.content, 600),
    memoryType: memory.memoryType,
    sensitivity: memory.sensitivity,
    confidence: memory.confidence,
    projectId: memory.projectId ?? null,
    version: memory.version,
    updatedAt: memory.updatedAt ?? null,
  };
}

function presentMonitor(monitor, goal) {
  return {
    id: monitor.id,
    goalId: monitor.goalId,
    title: monitor.title,
    watchFor: goal?.success?.measure ?? monitor.payload?.context?.watchFor ?? null,
    projectId: monitor.projectId ?? null,
    running: Boolean(monitor.enabled) && goal?.status === 'active',
    everyHours: monitor.intervalMinutes ? Math.round((monitor.intervalMinutes / 60) * 100) / 100 : null,
    nextCheckAt: monitor.enabled ? monitor.nextRunAt ?? null : null,
    endsAt: monitor.stop?.endAt ?? null,
    checks: monitor.runCount ?? 0,
    lastCheckAt: monitor.lastEvaluatedAt ?? null,
  };
}

/** Registers the memory and monitor tools on createOdinToolCatalog's `tool` helper. */
export function registerMemoryTools({ api, dryRun, extended, id, tool }) {
  if (!extended) return;
  const memoryPath = (memoryId) => `/api/agent-memory/${encodeURIComponent(memoryId)}`;
  const memoryShape = {
    memoryId: id.describe('Memory id from odin_search_memory.'),
    expectedVersion: z.number().int().positive().describe('The memory\'s version from odin_search_memory.'),
  };
  const memoryErrors = {
    403: ['memory_not_changeable', 'The user cannot change this memory: only its author, a workspace admin, or someone who can edit its project\'s plan can.'],
    404: ['memory_not_found', 'Memory not found, or the user cannot change it: only its author, a workspace admin, or someone who can edit its project\'s plan can. Find memories with odin_search_memory.'],
    409: ['version_conflict', 'The memory changed since it was read. Search for it again with odin_search_memory and use its current version. Nothing was changed.'],
    423: ['legal_hold', 'This memory is under legal hold, so it cannot be changed or forgotten.'],
  };
  const CORRECTABLE = ['title', 'content', 'memoryType', 'confidence', 'sensitivity'];

  tool('odin_correct_memory', [
    'Correct something the assistant remembers: its title, content, type, confidence or sensitivity. Omitted fields stay as they are.',
    'Use when the user says a remembered decision, preference or fact is wrong or out of date. Odin keeps a record that it was corrected.',
  ].join(' '), z.object({
    ...memoryShape,
    title: z.string().trim().min(1).max(255).optional(),
    content: z.string().trim().min(1).max(20_000).optional().describe('The whole corrected text.'),
    memoryType: z.enum(memoryTypes).optional(),
    confidence: z.number().min(0).max(1).optional(),
    sensitivity: z.enum(sensitivities).optional(),
    dryRun,
  }).strict(), async ({ dryRun: preview, expectedVersion, memoryId, ...fields }) => {
    const changes = Object.fromEntries(CORRECTABLE.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
    if (!Object.keys(changes).length) throw new OdinApiError(400, 'nothing_to_change', `Give at least one of ${CORRECTABLE.join(', ')}.`);
    const body = { expectedVersion, ...changes };
    if (preview) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'PATCH', path: memoryPath(memoryId), body } };
    try {
      const result = await api.request('PATCH', memoryPath(memoryId), { body });
      return { ok: true, changed: result.embeddingStatus !== 'unchanged', memory: presentMemory(result.memory) };
    } catch (error) {
      return remap(error, memoryErrors);
    }
  }, { write: true, destructive: true, purpose: 'Fix something the assistant remembered wrongly or that is out of date.' });

  tool('odin_forget_memory', 'Forget something the assistant remembers, so later chats no longer recall it. Nobody can undo it from the assistant.', z.object({ ...memoryShape, dryRun }).strict(), async ({ dryRun: preview, expectedVersion, memoryId }) => {
    if (preview) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'DELETE', path: memoryPath(memoryId), body: { expectedVersion } } };
    try {
      const result = await api.request('DELETE', memoryPath(memoryId), { body: { expectedVersion } });
      return { ok: true, forgottenMemoryId: result.forgottenMemoryId ?? memoryId };
    } catch (error) {
      return remap(error, memoryErrors);
    }
  }, { write: true, destructive: true, confirm: true, purpose: 'Forget something the assistant remembered.' });

  const goalErrors = {
    403: ['http_403', 'The user cannot set up monitors on this project: that needs plan-edit access.'],
    404: ['http_404', 'Project not found, or the user cannot set up monitors on it: that needs plan-edit access.'],
  };

  tool('odin_create_monitor', [
    'Watch for something and tell the user when it happens, such as "tell me if the launch slips" or "let me know when the API stories are all done".',
    'Every everyHours until the end date (30 days by default), the assistant checks as the user and reports in a new assistant chat. Checks are read-only: Odin refuses any change one tries.',
    'Write watchFor as the full instruction for that check, with names, dates and thresholds, since the check starts with no memory of this chat.',
    `At most ${MONITOR_LIMITS.checks} checks per monitor. A project monitor needs plan-edit access; without projectId it is the user's own.`,
  ].join(' '), z.object({
    projectId: id.optional(),
    title: z.string().trim().min(1).max(120).describe('Short name, such as "Launch date slipping".'),
    watchFor: z.string().trim().min(1).max(2000).describe('What to check and when to tell the user, such as "Tell me if the Launch milestone moves past 2026-12-01 or any story it depends on is overdue."'),
    everyHours: z.number().int().min(1).max(168).default(24),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Last day to check (YYYY-MM-DD), within ${MONITOR_LIMITS.days} days. Defaults to ${MONITOR_LIMITS.defaultDays} days from now.`),
    dryRun,
  }).strict(), async (args) => {
    const now = Date.now();
    const endAt = args.until ? Date.parse(`${args.until}T23:59:59.999Z`) : now + MONITOR_LIMITS.defaultDays * DAY;
    if (!Number.isFinite(endAt) || endAt <= now) throw new OdinApiError(400, 'invalid_until', 'until must be a real date after today.');
    if (endAt > now + MONITOR_LIMITS.days * DAY) throw new OdinApiError(400, 'invalid_until', `until must be within ${MONITOR_LIMITS.days} days.`);
    const interval = args.everyHours * 60 * 60 * 1000;
    const checks = Math.floor((endAt - now) / interval);
    if (checks < 1) throw new OdinApiError(400, 'invalid_until', 'until ends before the first check. Choose a later date or check more often.');
    if (checks > MONITOR_LIMITS.checks) throw new OdinApiError(400, 'too_many_checks', `That is ${checks} checks; a monitor makes at most ${MONITOR_LIMITS.checks}. Check less often or end sooner.`);
    const report = 'Only read and report: make no changes. Say plainly whether it has happened, with the evidence, and what changed since the last check.';
    const goal = {
      constraints: { autoApply: false, readOnly: true },
      projectId: args.projectId ?? null,
      scope: { kind: WATCH_SCOPE },
      success: { measure: args.watchFor },
      title: `Watch: ${args.title}`,
    };
    const monitor = {
      intervalMinutes: args.everyHours * 60,
      nextRunAt: new Date(now + interval).toISOString(),
      payload: { report, watchFor: args.watchFor },
      stop: { endAt: new Date(endAt).toISOString(), maxRuns: null },
      title: args.title,
      triggerType: 'schedule',
    };
    if (args.dryRun) {
      return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, checks, requests: [
        { method: 'POST', path: '/api/agent-goals', body: goal },
        { method: 'POST', path: '/api/agent-goals/{goalId}/monitors', body: monitor },
      ] };
    }
    let created;
    try {
      created = (await api.request('POST', '/api/agent-goals', { body: goal })).goal;
    } catch (error) {
      return remap(error, goalErrors);
    }
    try {
      const result = await api.request('POST', `/api/agent-goals/${encodeURIComponent(created.id)}/monitors`, { body: monitor });
      return { ok: true, checks, monitor: presentMonitor(result.monitor, created) };
    } catch (error) {
      // A goal without its monitor would never run; cancel it so it does not linger.
      await api.request('PATCH', `/api/agent-goals/${encodeURIComponent(created.id)}`, { body: { expectedVersion: created.version, status: 'cancelled' } }).catch(() => {});
      return remap(error, goalErrors);
    }
  }, { write: true, confirm: true, purpose: 'Keep an eye on something and tell me if it happens, such as the launch slipping or work running late.' });

  tool('odin_list_monitors', [
    'List what the assistant is watching for the user: each monitor\'s title, what it watches for, how often it checks, its next check, end date and checks so far.',
    'With projectId, that project\'s monitors (needs plan-edit access); without it, the user\'s own (a workspace admin sees everyone\'s). Stopped monitors are left out unless includeStopped.',
  ].join(' '), z.object({ projectId: id.optional(), includeStopped: z.boolean().default(false) }).strict(), async ({ includeStopped, projectId }) => {
    let goals;
    try {
      goals = (await api.request('GET', '/api/agent-goals', { query: projectId ? { projectId } : {} })).goals ?? [];
    } catch (error) {
      return remap(error, { 404: ['http_404', 'Project not found, or not accessible.'] });
    }
    const wanted = goals.filter((goal) => includeStopped || goal.status === 'active');
    const read = wanted.slice(0, MONITOR_LIMITS.goals);
    const monitors = [];
    for (const goal of read) {
      // Monitors are listed to those who may change them; skip goals this user only reads.
      const result = await api.request('GET', `/api/agent-goals/${encodeURIComponent(goal.id)}/monitors`).catch((error) => {
        if (error instanceof OdinApiError && [403, 404].includes(error.status)) return null;
        throw error;
      });
      for (const monitor of result?.monitors ?? []) {
        const entry = presentMonitor(monitor, goal);
        if (includeStopped || entry.running) monitors.push(entry);
      }
    }
    return { ok: true, monitors, ...(wanted.length > read.length ? { note: `Only the first ${read.length} of ${wanted.length} goals were read.` } : {}) };
  }, { purpose: 'See what the assistant is watching for me.' });

  tool('odin_stop_monitor', 'Stop a monitor so the assistant no longer checks. goalId and monitorId come from odin_list_monitors. A monitor made by odin_create_monitor stops with its goal.', z.object({
    goalId: id,
    monitorId: id,
    dryRun,
  }).strict(), async ({ dryRun: preview, goalId, monitorId }) => {
    const goalPath = `/api/agent-goals/${encodeURIComponent(goalId)}`;
    if (preview) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'PATCH', path: `/api/agent-goals/monitors/${encodeURIComponent(monitorId)}`, body: { enabled: false } } };
    const notFound = ['monitor_not_found', 'Monitor not found, or the user cannot change it. Get ids from odin_list_monitors.'];
    let listed;
    try {
      listed = await api.request('GET', `${goalPath}/monitors`);
    } catch (error) {
      return remap(error, { 403: notFound, 404: notFound });
    }
    const monitor = (listed.monitors ?? []).find((entry) => entry.id === monitorId);
    if (!monitor) throw new OdinApiError(404, ...notFound);
    let stopped = monitor;
    if (monitor.enabled) {
      try {
        stopped = (await api.request('PATCH', `/api/agent-goals/monitors/${encodeURIComponent(monitorId)}`, { body: { enabled: false, expectedVersion: monitor.version } })).monitor;
      } catch (error) {
        return remap(error, { 404: notFound, 409: ['version_conflict', 'The monitor changed while stopping it. Try again.'] });
      }
    }
    const goal = listed.goal;
    const othersRunning = (listed.monitors ?? []).some((entry) => entry.id !== monitorId && entry.enabled);
    // The monitor is already stopped; its watch goal is cancelled too when nothing else runs on
    // it, but a goal someone just changed is left for them rather than failing the stop.
    const goalStopped = goal?.scope?.kind === WATCH_SCOPE && goal.status === 'active' && !othersRunning
      && await api.request('PATCH', goalPath, { body: { expectedVersion: goal.version, status: 'cancelled' } }).then(() => true, () => false);
    return { ok: true, monitor: presentMonitor({ ...stopped, enabled: false }, goalStopped ? { ...goal, status: 'cancelled' } : goal), goalStopped };
  }, { write: true, purpose: 'Stop watching something the assistant was asked to keep an eye on.' });
}
