import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAgentExecutionRepository, createMysqlAgentExecutionRepository, ensureMysqlAgentMonitorEditorSchema } from '../src/modules/assistant/agent-execution.repository.js';
import { materializeDueGoalMonitors, materializeGoalEvent, monitorRunsReadOnly, monitorRunUserId } from '../src/modules/assistant/agent-monitors.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// A goal's monitor runs act as whoever last set the monitor up. They may make changes only when
// that is the goal's owner and the owner allowed it (autoApply): anyone else who can edit the plan
// can rewrite a monitor, and must not get the owner's hands by doing so.

const TENANT = 'tenant-1';
const PROJECT = 'project-1';

async function fixture() {
  const users = ['owner', 'contributor'].map((id) => ({ authMethod: 'basic', email: `${id}@example.com`, id, memberships: [{ role: 'user', tenantId: TENANT }], name: id, password: 'Secret123!' }));
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: TENANT, name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT]: [{ id: 'owner', role: 'admin' }, { id: 'contributor', role: 'editor' }] },
    projects: [{ epics: [], id: PROJECT, name: 'Launch', status: 'In Progress', tenantId: TENANT }],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'r3-monitor-author-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  const executionRepository = createInMemoryAgentExecutionRepository();
  const app = createApp({ agentExecutionRepository: executionRepository, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, projectRepository, sessionsRepository, tokenService });
  const as = (userId) => ({
    patch: (path, body) => request(app).patch(path).set('Authorization', `Bearer ${tokens.get(userId)}`).send(body),
    post: (path, body) => request(app).post(path).set('Authorization', `Bearer ${tokens.get(userId)}`).send(body),
  });
  let clock = Date.parse('2030-01-01T12:00:00.000Z');
  // Fires every due monitor, then returns each run queued for it: who it acts as and whether it may write.
  async function fire(monitorId) {
    clock += 60 * 60_000;
    await materializeDueGoalMonitors({ executionRepository, now: new Date(clock), projectRepository });
    const runs = (await executionRepository.listRuns({ tenantId: TENANT })).filter((run) => run.idempotencyKey.startsWith(`monitor:${monitorId}:`));
    const latest = runs.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey)).at(-1);
    return { message: latest.payload.input.message, readOnly: latest.payload.input.readOnly, userId: latest.userId, payloadUserId: latest.payload.userId };
  }
  return { as, executionRepository, fire };
}

test("another plan editor's change to a monitor makes its runs read-only and their own, until the owner saves it again", async () => {
  const { as, fire } = await fixture();
  const goal = (await as('owner').post('/api/agent-goals', { constraints: { autoApply: true }, projectId: PROJECT, title: 'Keep the plan tidy' })).body.goal;
  const created = await as('owner').post(`/api/agent-goals/${goal.id}/monitors`, { intervalMinutes: 5, nextRunAt: '2030-01-01T12:00:00.000Z', payload: { instructions: 'Close finished stories.' }, title: 'Tidy', triggerType: 'schedule' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let monitor = created.body.monitor;
  assert.deepEqual(await fire(monitor.id).then(({ payloadUserId, readOnly, userId }) => ({ payloadUserId, readOnly, userId })), { payloadUserId: 'owner', readOnly: false, userId: 'owner' });

  // The contributor rewrites the owner's monitor. The goal still allows changes, but not from them.
  const rewritten = await as('contributor').patch(`/api/agent-goals/monitors/${monitor.id}`, { expectedVersion: monitor.version + 1, payload: { instructions: 'Delete every epic.' } });
  assert.equal(rewritten.status, 200, JSON.stringify(rewritten.body));
  monitor = rewritten.body.monitor;
  const hijacked = await fire(monitor.id);
  assert.match(hijacked.message, /Delete every epic/);
  assert.deepEqual({ payloadUserId: hijacked.payloadUserId, readOnly: hijacked.readOnly, userId: hijacked.userId }, { payloadUserId: 'contributor', readOnly: true, userId: 'contributor' });
  assert.match(hijacked.message, /read-only/);

  // Once the owner saves it again, its runs are the owner's and may make changes.
  const restored = await as('owner').patch(`/api/agent-goals/monitors/${monitor.id}`, { expectedVersion: monitor.version + 1, payload: { instructions: 'Close finished stories.' } });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const owned = await fire(monitor.id);
  assert.deepEqual({ readOnly: owned.readOnly, userId: owned.userId }, { readOnly: false, userId: 'owner' });
});

test("a monitor someone else adds to the owner's goal runs read-only, as them", async () => {
  const { as, fire } = await fixture();
  const goal = (await as('owner').post('/api/agent-goals', { constraints: { autoApply: true }, projectId: PROJECT, title: 'Keep the plan tidy' })).body.goal;
  const created = await as('contributor').post(`/api/agent-goals/${goal.id}/monitors`, { intervalMinutes: 5, nextRunAt: '2030-01-01T12:00:00.000Z', payload: { instructions: 'Reassign everything to me.' }, title: 'Mine', triggerType: 'schedule' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await fire(created.body.monitor.id);
  assert.deepEqual({ readOnly: run.readOnly, userId: run.userId }, { readOnly: true, userId: 'contributor' });
});

test('a monitor from before who set it up was recorded runs read-only, as its creator', () => {
  const goal = { constraints: { autoApply: true }, ownerUserId: 'owner' };
  const legacy = { ownerUserId: 'owner', updatedByUserId: null };
  assert.deepEqual([monitorRunsReadOnly(goal, legacy), monitorRunUserId(legacy)], [true, 'owner']);
  assert.equal(monitorRunsReadOnly(goal, { ...legacy, updatedByUserId: 'owner' }), false);
  assert.equal(monitorRunsReadOnly({ constraints: {}, ownerUserId: 'owner' }, { ...legacy, updatedByUserId: 'owner' }), true, 'the goal must still allow changes');
  assert.equal(monitorRunsReadOnly({ constraints: { autoApply: true }, ownerUserId: null }, { ownerUserId: 'owner', updatedByUserId: 'owner' }), true, 'a goal without an owner never writes');
});

// The MySQL repository keeps who set each monitor up in updated_by_user_id: set on create, changed
// only by an update that names someone. A stand-in pool holds one monitor row.
test('the MySQL repository records who last set each monitor up', async () => {
  const statements = [];
  let row = null;
  const execute = async (sql, params = []) => {
    statements.push(sql);
    if (/information_schema\.columns/i.test(sql)) return [/'version'/.test(sql) ? [{ column_name: 'version' }] : []];
    if (sql.startsWith('INSERT INTO agent_goal_monitors')) {
      const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(', ');
      const values = sql.match(/VALUES \(([^)]+)\)/)[1].split(', ');
      let next = 0;
      row = Object.fromEntries(columns.map((column, index) => [column, values[index] === '?' ? params[next++] : Number(values[index])]));
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT * FROM agent_goal_monitors WHERE id')) return [row ? [row] : []];
    if (sql.startsWith('UPDATE agent_goal_monitors SET title')) {
      assert.match(sql, /updated_by_user_id = COALESCE\(\?, updated_by_user_id\)/);
      row = { ...row, title: params[0], updated_by_user_id: params[8] ?? row.updated_by_user_id, version: row.version + 1 };
      return [{ affectedRows: 1 }];
    }
    return [[]];
  };
  await ensureMysqlAgentMonitorEditorSchema({ execute });
  assert.ok(statements.some((sql) => sql === 'ALTER TABLE agent_goal_monitors ADD COLUMN updated_by_user_id VARCHAR(36) NULL AFTER owner_user_id'), 'migration 0077 adds the column where missing');
  statements.length = 0;
  const repository = createMysqlAgentExecutionRepository({ pool: { execute } });
  const created = await repository.createMonitor({ goalId: 'goal-1', input: { intervalMinutes: 15, payload: { sessionId: 'session-1' }, title: 'Health', triggerType: 'schedule' }, ownerUserId: 'owner', projectId: PROJECT, tenantId: TENANT });
  assert.equal(created.updatedByUserId, 'owner');
  assert.deepEqual(statements.filter((sql) => /ALTER TABLE|CREATE TABLE|information_schema/i.test(sql)), [], 'setting up a monitor changes no schema');
  const scheduled = await repository.updateMonitor({ expectedVersion: 1, monitorId: created.id, patch: { title: 'Health, by the scheduler' }, tenantId: TENANT });
  assert.equal(scheduled.updatedByUserId, 'owner');
  const edited = await repository.updateMonitor({ expectedVersion: 2, monitorId: created.id, patch: { title: 'Health, edited' }, tenantId: TENANT, updatedByUserId: 'contributor' });
  assert.equal(edited.updatedByUserId, 'contributor');
});

test('an event about a ticket agents may not see reaches no monitor, and a governance change names no link to one', async () => {
  const repository = createInMemoryAgentExecutionRepository();
  const goal = await repository.createGoal({ ownerUserId: 'owner', projectId: PROJECT, tenantId: TENANT, title: 'Watch the launch' });
  for (const eventType of ['workflow.transitioned', 'governance.changed']) {
    await repository.createMonitor({ goalId: goal.id, input: { eventType, payload: { sessionId: `session-${eventType}` }, title: eventType, triggerType: 'event' }, ownerUserId: 'owner', projectId: PROJECT, tenantId: TENANT });
  }
  const projectRepository = { getProjectDetail: async () => ({ epics: [{ id: 'epic-1', stories: [{ id: 'story-1', tasks: [] }] }], id: PROJECT, tickets: [{ externalReviewState: 'pending', id: 'ticket-hidden' }, { externalReviewState: 'validated', id: 'ticket-seen' }] }) };
  const fire = (eventType, event, eventId) => materializeGoalEvent({ event, eventId, eventType, executionRepository: repository, projectId: PROJECT, projectRepository, tenantId: TENANT });
  assert.deepEqual(await fire('workflow.transitioned', { itemId: 'ticket-hidden', itemType: 'ticket', toState: 'triage' }, 'event-1'), []);
  assert.equal((await fire('workflow.transitioned', { itemId: 'ticket-seen', itemType: 'ticket', toState: 'triage' }, 'event-2')).length, 1);
  assert.equal((await fire('governance.changed', { action: 'updated', change: { id: 'milestone-1', title: 'Refunds live', workItemId: 'ticket-hidden' }, entityType: 'milestone' }, 'event-3')).length, 1);
  // A schedule baseline carries every dependency and milestone in its snapshot.
  const baseline = { id: 'baseline-1', name: 'Approved plan', snapshot: {
    dependencies: [{ dependencyType: 'FS', lagDays: 0, predecessorId: 'ticket-hidden', successorId: 'story-1' }, { dependencyType: 'FS', lagDays: 0, predecessorId: 'epic-1', successorId: 'story-1' }],
    items: [{ id: 'story-1', name: 'Pay by card', type: 'story' }],
    milestones: [{ id: 'milestone-2', targetDate: '2026-11-30', title: 'Baseline launch', workItemId: 'ticket-hidden' }],
  } };
  assert.equal((await fire('governance.changed', { action: 'created', change: baseline, entityType: 'schedule_baseline' }, 'event-4')).length, 1);
  const told = JSON.stringify((await repository.listRuns({ goalId: goal.id, tenantId: TENANT })).map((run) => [run.payload.input.message, run.payload.trigger]));
  assert.doesNotMatch(told, /ticket-hidden/);
  assert.match(told, /ticket-seen/);
  assert.match(told, /Refunds live/);
  assert.match(told, /Baseline launch/);
  assert.match(told, /epic-1/);
});
