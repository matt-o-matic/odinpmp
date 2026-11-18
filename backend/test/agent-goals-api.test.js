import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'editor@example.com', id: 'editor', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Editor', password: 'Secret123!' },
    { authMethod: 'basic', email: 'planner@example.com', id: 'planner', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Planner', password: 'Secret123!' },
    { authMethod: 'basic', email: 'viewer@example.com', id: 'viewer', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Viewer', password: 'Secret123!' },
    { authMethod: 'basic', email: 'outsider@example.com', id: 'outsider', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Outsider', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'editor', role: 'editor' }, { id: 'planner', role: 'editor' }, { id: 'viewer', role: 'viewer' }] },
    projects: [{ epics: [], id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-1', updatedAt: '2026-07-01T00:00:00.000Z' }],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'agent-goals-test-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  const agentExecutionRepository = createInMemoryAgentExecutionRepository();
  return {
    agentExecutionRepository,
    app: createApp({ agentExecutionRepository, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, projectRepository, sessionsRepository, tokenService }),
    authorization: (userId) => `Bearer ${tokens.get(userId)}`,
  };
}

test('agent goal API creates, lists, versions, pauses, and starts durable runs', async () => {
  const { app, authorization } = await fixture();
  const created = await request(app).post('/api/agent-goals').set('Authorization', authorization('editor')).send({
    constraints: { budgets: { costUsd: 0.25 }, maxAttempts: 3 },
    projectId: 'project-1', scope: { measures: ['milestone_health'] },
    success: { measure: 'No missed critical milestone', plan: { root: { all: [{ checkId: 'integration.deliveries_succeeded', criteria: { eventTypes: ['workflow.transitioned'] }, id: 'delivery-complete', type: 'integration.v1' }] }, version: 'verifier-plan.v1' } }, title: 'Monitor launch readiness',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.goal.version, 1);
  assert.equal(created.body.goal.success.plan.version, 'verifier-plan.v1');
  assert.deepEqual(created.body.goal.success.plan.root.all[0].criteria.eventTypes, ['workflow.transitioned']);
  const goalId = created.body.goal.id;
  const listed = await request(app).get('/api/agent-goals?projectId=project-1').set('Authorization', authorization('viewer'));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.goals[0].id, goalId);
  const paused = await request(app).patch(`/api/agent-goals/${goalId}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, status: 'paused' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.goal.version, 2);
  assert.equal((await request(app).post(`/api/agent-goals/${goalId}/runs`).set('Authorization', authorization('editor')).send({})).status, 409);
  const resumed = await request(app).patch(`/api/agent-goals/${goalId}`).set('Authorization', authorization('editor')).send({ expectedVersion: 2, status: 'active' });
  assert.equal(resumed.status, 200);
  const run = await request(app).post(`/api/agent-goals/${goalId}/runs`).set('Authorization', authorization('editor')).send({ idempotencyKey: 'manual-run-1' });
  assert.equal(run.status, 202);
  assert.equal(run.body.run.goalId, goalId);
  const detail = await request(app).get(`/api/agent-goals/${goalId}`).set('Authorization', authorization('viewer'));
  assert.equal(detail.body.runs.length, 1);
});

test('agent goal API masks unauthorized projects and denies viewer mutations', async () => {
  const { app, authorization } = await fixture();
  assert.equal((await request(app).post('/api/agent-goals').set('Authorization', authorization('viewer')).send({ projectId: 'project-1', title: 'No write' })).status, 404);
  assert.equal((await request(app).get('/api/agent-goals?projectId=project-1').set('Authorization', authorization('outsider'))).status, 404);
});

// The governance screen saves constraints whole, with the editor's choice in autoApply.
test("only a goal's owner can let it make changes, and another editor's save turns that off", async () => {
  const { app, authorization } = await fixture();
  const screenConstraints = (autoApply) => ({ allowWebResearch: false, autoApply, escalation: { afterRuns: 1, channels: ['in_app'] }, maxAttempts: 5 });
  const created = await request(app).post('/api/agent-goals').set('Authorization', authorization('editor')).send({
    constraints: screenConstraints(true), projectId: 'project-1', scope: { projectIds: ['project-1'] }, success: { measure: 'The plan is tidy.' }, title: 'Tidy the plan',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.goal.constraints.autoApply, true);
  const goalPath = `/api/agent-goals/${created.body.goal.id}`;

  const refused = await request(app).patch(goalPath).set('Authorization', authorization('planner')).send({ constraints: screenConstraints(true), expectedVersion: 1 });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  const edited = await request(app).patch(goalPath).set('Authorization', authorization('planner')).send({ constraints: screenConstraints(false), expectedVersion: 1, title: 'Tidy the launch plan' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.goal.constraints.autoApply, false);

  const restored = await request(app).patch(goalPath).set('Authorization', authorization('editor')).send({ constraints: screenConstraints(true), expectedVersion: 2 });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.goal.constraints.autoApply, true);
});

test('agent goal API returns structured stale-version conflicts', async () => {
  const { app, authorization } = await fixture();
  const created = await request(app).post('/api/agent-goals').set('Authorization', authorization('editor')).send({ projectId: 'project-1', title: 'Versioned goal' });
  const goalId = created.body.goal.id;
  assert.equal((await request(app).patch(`/api/agent-goals/${goalId}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, status: 'paused' })).status, 200);
  const stale = await request(app).patch(`/api/agent-goals/${goalId}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, status: 'completed' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'agent_goal_version_conflict');
});

test('agent goal API creates persistent scheduled and event monitors with versioned controls', async () => {
  const { app, authorization } = await fixture();
  const created = await request(app).post('/api/agent-goals').set('Authorization', authorization('editor')).send({ projectId: 'project-1', title: 'Monitor delivery' });
  const goalId = created.body.goal.id;
  const scheduled = await request(app).post(`/api/agent-goals/${goalId}/monitors`).set('Authorization', authorization('editor')).send({
    intervalMinutes: 30, nextRunAt: '2030-01-01T12:00:00.000Z', payload: { focus: 'critical path' }, title: 'Schedule health', triggerType: 'schedule',
  });
  assert.equal(scheduled.status, 201);
  assert.equal(scheduled.body.monitor.version, 1);
  assert.ok(scheduled.body.monitor.payload.sessionId);
  assert.deepEqual(scheduled.body.monitor.payload.context, { focus: 'critical path' });
  const event = await request(app).post(`/api/agent-goals/${goalId}/monitors`).set('Authorization', authorization('editor')).send({
    condition: { 'change.impact': 'critical' }, eventType: 'governance.changed', title: 'Critical risk', triggerType: 'event',
  });
  assert.equal(event.status, 201);
  const listed = await request(app).get(`/api/agent-goals/${goalId}/monitors`).set('Authorization', authorization('editor'));
  assert.equal(listed.body.monitors.length, 2);
  const disabled = await request(app).patch(`/api/agent-goals/monitors/${scheduled.body.monitor.id}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.monitor.enabled, false);
  const stale = await request(app).patch(`/api/agent-goals/monitors/${scheduled.body.monitor.id}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, enabled: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'agent_monitor_version_conflict');
});

test('critical governance changes materialize matching event monitor runs', async () => {
  const { agentExecutionRepository, app, authorization } = await fixture();
  const created = await request(app).post('/api/agent-goals').set('Authorization', authorization('editor')).send({ projectId: 'project-1', title: 'Watch critical risks' });
  const goalId = created.body.goal.id;
  assert.equal((await request(app).post(`/api/agent-goals/${goalId}/monitors`).set('Authorization', authorization('editor')).send({
    condition: { 'change.impact': 'critical' }, eventType: 'governance.changed', title: 'Critical risk response', triggerType: 'event',
  })).status, 201);
  assert.equal((await request(app).post('/api/projects/project-1/governance/items').set('Authorization', authorization('editor')).send({
    impact: 'medium', kind: 'risk', title: 'Medium risk',
  })).status, 201);
  assert.equal((await agentExecutionRepository.listRuns({ goalId, tenantId: 'tenant-1' })).length, 0);
  assert.equal((await request(app).post('/api/projects/project-1/governance/items').set('Authorization', authorization('editor')).send({
    impact: 'critical', kind: 'risk', title: 'Critical risk',
  })).status, 201);
  const runs = await agentExecutionRepository.listRuns({ goalId, tenantId: 'tenant-1' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runType, 'assistant_turn');
  assert.equal(runs[0].payload.trigger.eventType, 'governance.changed');
});

test('goal attention API lists authorized notifications and versions acknowledgement', async () => {
  const { agentExecutionRepository, app, authorization } = await fixture();
  const created = await request(app).post('/api/agent-goals').set('Authorization', authorization('editor')).send({ projectId: 'project-1', title: 'Protect launch' });
  const goal = created.body.goal;
  const attention = await agentExecutionRepository.createNotification({
    dedupeKey: 'attention-api-1', evidence: { failedCheckIds: ['schedule.no_cycles'] }, goalId: goal.id,
    kind: 'verifier_failed', message: 'Schedule verification failed.', ownerUserId: 'editor', projectId: 'project-1',
    severity: 'warning', tenantId: 'tenant-1', title: 'Goal needs attention',
  });
  const listed = await request(app).get(`/api/agent-goals/${goal.id}/notifications`).set('Authorization', authorization('viewer'));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.notifications[0].id, attention.notification.id);
  const read = await request(app).patch(`/api/agent-goals/notifications/${attention.notification.id}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, status: 'read' });
  assert.equal(read.status, 200);
  assert.equal(read.body.notification.status, 'read');
  const stale = await request(app).patch(`/api/agent-goals/notifications/${attention.notification.id}`).set('Authorization', authorization('editor')).send({ expectedVersion: 1, status: 'dismissed' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'agent_goal_notification_version_conflict');
});
