import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'editor@example.com', id: 'editor', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Editor', password: 'Secret123!' },
    { authMethod: 'basic', email: 'viewer@example.com', id: 'viewer', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Viewer', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: { 'project-1': [{ id: 'editor', role: 'editor' }, { id: 'viewer', role: 'viewer' }] },
      projects: [{
        endDate: '2026-07-10', epics: [{ id: 'epic-1', name: 'Epic', stories: [{
          id: 'story-1', name: 'Story', targetEndDate: '2026-07-05', targetStartDate: '2026-07-01', tasks: [
            { id: 'task-1', name: 'First', targetEndDate: '2026-07-03', targetStartDate: '2026-07-01' },
            { id: 'task-2', name: 'Second', targetEndDate: '2026-07-12', targetStartDate: '2026-07-04' },
          ],
        }]}], id: 'project-1', name: 'Project', startDate: '2026-07-01', status: 'In Progress', tenantId: 'tenant-1', updatedAt: '2026-07-01T00:00:00.000Z',
      }],
    },
  });
  const tokenService = createTokenService({ issuer: 'test', secret: 'governance-test-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  return {
    app: createApp({ assistantStaleRunSweepIntervalMs: 0, authRepository, projectRepository, sessionsRepository, tokenService }),
    token: (userId) => tokens.get(userId),
  };
}

test('governance API persists RAID, milestones, dependencies, versions, and schedule analysis', async () => {
  const { app, token } = await fixture();
  const authorization = `Bearer ${token('editor')}`;
  const item = await request(app).post('/api/projects/project-1/governance/items').set('Authorization', authorization).send({ kind: 'risk', title: 'Vendor delay', impact: 'high' });
  assert.equal(item.status, 201);
  assert.equal(item.body.value.version, 1);
  const updated = await request(app).patch(`/api/projects/project-1/governance/items/${item.body.value.id}`).set('Authorization', authorization).send({ expectedVersion: 1, status: 'monitoring' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.value.version, 2);
  const stale = await request(app).patch(`/api/projects/project-1/governance/items/${item.body.value.id}`).set('Authorization', authorization).send({ expectedVersion: 1, status: 'resolved' });
  assert.equal(stale.status, 409);

  assert.equal((await request(app).post('/api/projects/project-1/governance/milestones').set('Authorization', authorization).send({ targetDate: '2026-07-10', title: 'Launch' })).status, 201);
  const dependency = await request(app).post('/api/projects/project-1/governance/dependencies').set('Authorization', authorization).send({ predecessorId: 'task-1', successorId: 'task-2' });
  assert.equal(dependency.status, 201);
  const updatedDependency = await request(app).patch(`/api/projects/project-1/governance/dependencies/${dependency.body.value.id}`).set('Authorization', authorization).send({
    dependencyType: 'SS', expectedVersion: 1, lagDays: 2, predecessorId: 'task-1', successorId: 'task-2',
  });
  assert.equal(updatedDependency.status, 200);
  assert.equal(updatedDependency.body.value.version, 2);
  assert.equal(updatedDependency.body.value.dependencyType, 'SS');
  assert.equal((await request(app).patch(`/api/projects/project-1/governance/dependencies/${dependency.body.value.id}`).set('Authorization', authorization).send({
    dependencyType: 'FS', expectedVersion: 1, lagDays: 0, predecessorId: 'task-1', successorId: 'task-2',
  })).status, 409);
  const snapshot = await request(app).get('/api/projects/project-1/governance').set('Authorization', authorization);
  assert.equal(snapshot.body.items.length, 1);
  assert.equal(snapshot.body.milestones.length, 1);
  assert.equal(snapshot.body.dependencies.length, 1);
  const calendar = await request(app).put('/api/projects/project-1/governance/working-calendar').set('Authorization', authorization).send({
    expectedVersion: null, holidays: ['2026-07-06'], hoursPerDay: 7.5, timezone: 'America/New_York', workingDays: [1, 2, 3, 4, 5],
  });
  assert.equal(calendar.status, 200);
  assert.equal(calendar.body.value.version, 1);
  const baseline = await request(app).post('/api/projects/project-1/governance/schedule-baselines').set('Authorization', authorization).send({ name: 'Approved launch plan', note: 'Steering committee approval.' });
  assert.equal(baseline.status, 201);
  assert.equal(baseline.body.value.snapshot.capturedSchema, 'schedule-baseline.v1');
  const movedTask = await request(app).patch('/api/projects/project-1/items/task-2').set('Authorization', authorization).send({ expectedVersion: 1, patch: { targetEndDate: '2026-07-15' } });
  assert.equal(movedTask.status, 200);
  const analysis = await request(app).get('/api/projects/project-1/governance/schedule-analysis').set('Authorization', authorization);
  assert.equal(analysis.body.analysis.passed, true);
  assert.deepEqual(analysis.body.analysis.criticalPathIds, ['task-2']);
  assert.equal(analysis.body.analysis.itemTimings.find((entry) => entry.id === 'task-1').totalFloatWorkingDays > 0, true);
  assert.equal(analysis.body.analysis.forecastVarianceDays, 3);
  assert.equal(analysis.body.analysis.calendar.hoursPerDay, 7.5);
  assert.equal(analysis.body.analysis.baselineVariance.baselineName, 'Approved launch plan');
  assert.equal(analysis.body.analysis.baselineVariance.itemVariances.find((entry) => entry.id === 'task-2').finishVarianceWorkingDays, 3);
  const domainEvents = await app.locals.domainEventOutboxRepository.list();
  assert.equal(domainEvents.length, 7);
  assert.equal(domainEvents.every((event) => event.eventType === 'governance.changed' && event.status === 'processed'), true);
});

test('governance writes deny project viewers while reads remain available', async () => {
  const { app, token } = await fixture();
  const authorization = `Bearer ${token('viewer')}`;
  assert.equal((await request(app).get('/api/projects/project-1/governance').set('Authorization', authorization)).status, 200);
  assert.equal((await request(app).post('/api/projects/project-1/governance/items').set('Authorization', authorization).send({ kind: 'issue', title: 'No write' })).status, 404);
  assert.equal((await request(app).put('/api/projects/project-1/governance/working-calendar').set('Authorization', authorization).send({})).status, 404);
});

test('governance records are deleted at their current version, and a dependency between the same items of the same type exists once', async () => {
  const { app, token } = await fixture();
  const editor = `Bearer ${token('editor')}`;
  const send = (method, path, body) => request(app)[method](`/api/projects/project-1/governance${path}`).set('Authorization', editor).send(body);
  const item = (await send('post', '/items', { kind: 'issue', title: 'Card vendor outage' })).body.value;
  const milestone = (await send('post', '/milestones', { targetDate: '2026-07-10', title: 'Launch' })).body.value;
  const dependency = (await send('post', '/dependencies', { predecessorId: 'task-1', successorId: 'task-2' })).body.value;

  const duplicate = await send('post', '/dependencies', { dependencyType: 'FS', lagDays: 3, predecessorId: 'task-1', successorId: 'task-2' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.details.code, 'dependency_exists');
  assert.equal((await send('post', '/dependencies', { dependencyType: 'SS', predecessorId: 'task-1', successorId: 'task-2' })).status, 201);
  const renamed = await send('patch', `/dependencies/${dependency.id}`, { dependencyType: 'SS', expectedVersion: 1, lagDays: 0, predecessorId: 'task-1', successorId: 'task-2' });
  assert.equal(renamed.status, 409, 'changing it into the SS dependency that exists is refused');
  assert.equal((await send('patch', `/dependencies/${dependency.id}`, { dependencyType: 'FS', expectedVersion: 1, lagDays: 2, predecessorId: 'task-1', successorId: 'task-2' })).status, 200, 'it may keep its own pair and type');

  for (const [path, record, version] of [['/items', item, 1], ['/milestones', milestone, 1], ['/dependencies', dependency, 2]]) {
    assert.equal((await send('delete', `${path}/${record.id}`, { expectedVersion: version + 1 })).status, 409, `${path} stale`);
    assert.equal((await send('delete', `${path}/${record.id}`, {})).status, 400, `${path} without a version`);
    const deleted = await send('delete', `${path}/${record.id}`, { expectedVersion: version });
    assert.deepEqual([deleted.status, deleted.body.value], [200, true], path);
    assert.equal((await send('delete', `${path}/${record.id}`, { expectedVersion: version })).status, 404, `${path} gone`);
  }
  const snapshot = (await request(app).get('/api/projects/project-1/governance').set('Authorization', editor)).body;
  assert.deepEqual([snapshot.items.length, snapshot.milestones.length, snapshot.dependencies.map((entry) => entry.dependencyType)], [0, 0, ['SS']]);
});

test('project viewers cannot delete governance records, change the calendar or save a baseline', async () => {
  const { app, token } = await fixture();
  const editor = `Bearer ${token('editor')}`;
  const viewer = `Bearer ${token('viewer')}`;
  const milestone = (await request(app).post('/api/projects/project-1/governance/milestones').set('Authorization', editor).send({ targetDate: '2026-07-10', title: 'Launch' })).body.value;
  for (const [method, path, body] of [
    ['delete', `/milestones/${milestone.id}`, { expectedVersion: 1 }],
    ['put', '/working-calendar', { expectedVersion: null, holidays: ['2026-07-06'] }],
    ['post', '/schedule-baselines', { name: 'Viewer plan' }],
  ]) {
    assert.equal((await request(app)[method](`/api/projects/project-1/governance${path}`).set('Authorization', viewer).send(body)).status, 404, `${method} ${path}`);
  }
  const snapshot = (await request(app).get('/api/projects/project-1/governance').set('Authorization', viewer)).body;
  assert.deepEqual([snapshot.milestones.length, snapshot.workingCalendar, snapshot.scheduleBaselines.length], [1, null, 0]);
});

test('schedule analysis reports dependency cycles deterministically', async () => {
  const { analyzeProjectSchedule } = await import('../src/modules/governance/schedule-analysis.js');
  const project = { epics: [{ id: 'a', stories: [{ id: 'b', tasks: [] }] }] };
  const result = analyzeProjectSchedule(project, [
    { predecessorId: 'a', successorId: 'b' }, { predecessorId: 'b', successorId: 'a' },
  ]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.cyclicItemIds.sort(), ['a', 'b']);
});
