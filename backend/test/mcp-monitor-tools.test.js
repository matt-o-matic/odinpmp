import assert from 'node:assert/strict';
import test from 'node:test';
import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { MONITOR_LIMITS } from '../src/mcp/memory-tools.js';
import { toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';

// Creating, listing and stopping monitors against a fake Odin REST API. A monitor is a goal with
// one scheduled monitor; mcp-monitor-api.test.js runs the tools against the real routes.

const HOUR = 60 * 60 * 1000;
const goal = (overrides = {}) => ({ constraints: { autoApply: false, readOnly: true }, id: 'goal-1', ownerUserId: 'user-1', projectId: 'project-1', scope: { kind: 'assistant-watch' }, status: 'active', success: { measure: 'Tell me if the launch slips.' }, tenantId: 'tenant-1', title: 'Watch: Launch', version: 1, ...overrides });
const monitor = (overrides = {}) => ({ enabled: true, goalId: 'goal-1', id: 'monitor-1', intervalMinutes: 1440, lastEvaluatedAt: null, nextRunAt: '2026-11-01T00:00:00.000Z', payload: { context: {}, sessionId: 's' }, projectId: 'project-1', runCount: 2, stop: { endAt: '2026-11-30T23:59:59.999Z', maxRuns: null }, tenantId: 'tenant-1', title: 'Launch', triggerType: 'schedule', version: 5, ...overrides });

function tools(respond) {
  const calls = [];
  const catalog = createOdinToolCatalog({ api: { request: async (...args) => { calls.push(args); return respond(...args); } }, extended: true });
  const call = (name, args) => {
    const entry = catalog.find((candidate) => candidate.name === name);
    return entry.handler(entry.schema.parse(args));
  };
  return { call, calls };
}

test('creating a monitor asks the user first, then makes a read-only goal and its schedule', async () => {
  assert.equal(toolNeedsConfirmation('odin_create_monitor', { title: 'Launch', watchFor: 'x' }), true);
  assert.equal(toolNeedsConfirmation('odin_stop_monitor', { goalId: 'goal-1', monitorId: 'monitor-1' }), false);
  const { call, calls } = tools((method, path, options) => (path === '/api/agent-goals'
    ? { goal: { ...goal(), ...options.body, id: 'goal-1', version: 1 }, ok: true }
    : { monitor: monitor({ ...options.body, payload: { context: options.body.payload, sessionId: 's' }, runCount: 0 }), ok: true }));
  const before = Date.now();
  const result = await call('odin_create_monitor', { everyHours: 12, projectId: 'project-1', title: 'Launch date slipping', until: new Date(before + 10 * 24 * HOUR).toISOString().slice(0, 10), watchFor: 'Tell me if the Launch milestone moves past 2026-12-01.' });
  assert.equal(calls.length, 2);
  const [[goalMethod, goalPath, { body: goalBody }], [monitorMethod, monitorPath, { body: monitorBody }]] = calls;
  assert.deepEqual([goalMethod, goalPath, monitorMethod, monitorPath], ['POST', '/api/agent-goals', 'POST', '/api/agent-goals/goal-1/monitors']);
  assert.deepEqual(goalBody, { constraints: { autoApply: false, readOnly: true }, projectId: 'project-1', scope: { kind: 'assistant-watch' }, success: { measure: 'Tell me if the Launch milestone moves past 2026-12-01.' }, title: 'Watch: Launch date slipping' });
  assert.equal(monitorBody.triggerType, 'schedule');
  assert.equal(monitorBody.intervalMinutes, 720);
  assert.ok(Math.abs(Date.parse(monitorBody.nextRunAt) - (before + 12 * HOUR)) < 5000, 'the first check is one interval away');
  assert.match(monitorBody.stop.endAt, /T23:59:59\.999Z$/);
  assert.match(monitorBody.payload.report, /make no changes/);
  assert.deepEqual([result.ok, result.monitor.watchFor, result.monitor.everyHours, result.monitor.running, result.checks >= 19 && result.checks <= 21], [true, 'Tell me if the Launch milestone moves past 2026-12-01.', 12, true, true]);
});

test('a monitor\'s dates and check count are bounded before anything is created', async () => {
  const { call, calls } = tools(() => { throw new Error('Must not call Odin.'); });
  const day = (offset) => new Date(Date.now() + offset * 24 * HOUR).toISOString().slice(0, 10);
  for (const [args, code] of [
    [{ until: day(-1) }, 'invalid_until'],
    [{ until: day(MONITOR_LIMITS.days + 2) }, 'invalid_until'],
    [{ everyHours: 1, until: day(30) }, 'too_many_checks'],
    [{ everyHours: 168, until: day(3) }, 'invalid_until'],
  ]) {
    await assert.rejects(call('odin_create_monitor', { title: 'Launch', watchFor: 'x', ...args }), { code }, JSON.stringify(args));
  }
  const preview = await call('odin_create_monitor', { dryRun: true, title: 'Launch', watchFor: 'x' });
  assert.deepEqual([preview.dryRun, preview.requests.length, preview.checks >= 29 && preview.checks <= 30], [true, 2, true]);
  assert.equal(calls.length, 0);
});

test('a goal whose monitor could not be created is cancelled, and refusals say what access is needed', async () => {
  const { call, calls } = tools((method, path) => {
    if (method === 'POST' && path === '/api/agent-goals') return { goal: goal({ version: 1 }), ok: true };
    if (method === 'POST') throw new OdinApiError(400, 'http_400', 'upstream');
    return { goal: goal({ status: 'cancelled', version: 2 }), ok: true };
  });
  await assert.rejects(call('odin_create_monitor', { projectId: 'project-1', title: 'Launch', watchFor: 'x' }), { status: 400 });
  assert.deepEqual(calls.at(-1), ['PATCH', '/api/agent-goals/goal-1', { body: { expectedVersion: 1, status: 'cancelled' } }]);
  const refused = tools(() => { throw new OdinApiError(404, 'http_404', 'upstream'); });
  await assert.rejects(refused.call('odin_create_monitor', { projectId: 'project-1', title: 'Launch', watchFor: 'x' }), (error) => /plan-edit/.test(error.message));
});

test('listing shows running monitors, skips goals the user only reads, and includes stopped ones on request', async () => {
  const { call, calls } = tools((method, path) => {
    if (path === '/api/agent-goals') return { goals: [goal(), goal({ id: 'goal-2', title: 'Watch: Budget' }), goal({ id: 'goal-3', status: 'cancelled' }), goal({ id: 'goal-4' })], ok: true };
    if (path === '/api/agent-goals/goal-1/monitors') return { goal: goal(), monitors: [monitor(), monitor({ enabled: false, id: 'monitor-off' })], ok: true };
    if (path === '/api/agent-goals/goal-3/monitors') return { goal: goal({ id: 'goal-3', status: 'cancelled' }), monitors: [monitor({ goalId: 'goal-3', id: 'monitor-3' })], ok: true };
    if (path === '/api/agent-goals/goal-4/monitors') return { goal: goal({ id: 'goal-4' }), monitors: [], ok: true };
    throw new OdinApiError(404, 'http_404', 'upstream');
  });
  const running = await call('odin_list_monitors', { projectId: 'project-1' });
  assert.deepEqual(calls[0], ['GET', '/api/agent-goals', { query: { projectId: 'project-1' } }]);
  assert.deepEqual(running.monitors, [{ checks: 2, endsAt: '2026-11-30T23:59:59.999Z', everyHours: 24, goalId: 'goal-1', id: 'monitor-1', lastCheckAt: null, nextCheckAt: '2026-11-01T00:00:00.000Z', projectId: 'project-1', running: true, title: 'Launch', watchFor: 'Tell me if the launch slips.' }]);
  const all = await call('odin_list_monitors', { includeStopped: true });
  assert.deepEqual(all.monitors.map((entry) => [entry.id, entry.running]), [['monitor-1', true], ['monitor-off', false], ['monitor-3', false]]);
});

test('stopping disables the monitor and cancels a watch goal with nothing else running', async () => {
  const { call, calls } = tools((method, path, options) => {
    if (method === 'GET') return { goal: goal(), monitors: [monitor()], ok: true };
    if (path === '/api/agent-goals/monitors/monitor-1') return { monitor: monitor({ enabled: false, version: 6 }), ok: true };
    return { goal: goal({ status: 'cancelled', version: 2 }), ok: true, request: options };
  });
  const result = await call('odin_stop_monitor', { goalId: 'goal-1', monitorId: 'monitor-1' });
  assert.deepEqual(calls.slice(1), [
    ['PATCH', '/api/agent-goals/monitors/monitor-1', { body: { enabled: false, expectedVersion: 5 } }],
    ['PATCH', '/api/agent-goals/goal-1', { body: { expectedVersion: 1, status: 'cancelled' } }],
  ]);
  assert.deepEqual([result.goalStopped, result.monitor.running, result.monitor.nextCheckAt], [true, false, null]);

  // A goal set up elsewhere, or with another monitor still running, keeps going.
  const shared = tools((method) => (method === 'GET'
    ? { goal: goal({ scope: {} }), monitors: [monitor(), monitor({ id: 'monitor-2' })], ok: true }
    : { monitor: monitor({ enabled: false }), ok: true }));
  assert.equal((await shared.call('odin_stop_monitor', { goalId: 'goal-1', monitorId: 'monitor-1' })).goalStopped, false);
  assert.equal(shared.calls.length, 2);
  const missing = tools(() => ({ goal: goal(), monitors: [], ok: true }));
  await assert.rejects(missing.call('odin_stop_monitor', { goalId: 'goal-1', monitorId: 'monitor-9' }), { code: 'monitor_not_found' });
});
