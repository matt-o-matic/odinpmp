import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository, createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { loadDeletedProjectIds } from '../src/modules/reporting/deleted-project-scope.js';
import { createInMemoryReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const TENANT = 'tenant-1';

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: TENANT }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'manager@example.com', id: 'manager', memberships: [{ role: 'manager', tenantId: TENANT }], name: 'Manager', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: TENANT, name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-alpha': [{ id: 'manager', role: 'manager' }], 'project-beta': [{ id: 'manager', role: 'manager' }] },
    projects: [
      { epics: [], id: 'project-alpha', name: 'Alpha', status: 'In Progress', tenantId: TENANT, updatedAt: '2026-10-01T00:00:00.000Z' },
      { epics: [], id: 'project-beta', name: 'Beta', status: 'Planned', tenantId: TENANT, updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
  } });
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  const resource = await resourceFinanceRepository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', location: '', name: 'Alex', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId: TENANT });
  for (const [projectId, hoursPerWeek] of [['project-alpha', 30], ['project-beta', 20]]) {
    await resourceFinanceRepository.createAllocation({ input: { allocationPercent: hoursPerWeek * 2.5, endDate: '2026-12-31', hoursPerWeek, projectId, resourceId: resource.id, role: 'Engineer', scenario: 'baseline', startDate: '2026-01-01', status: 'active' }, tenantId: TENANT });
  }
  const tokenService = createTokenService({ issuer: 'test', secret: 'reporting-deleted-projects-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id });
    tokens.set(user.id, `Bearer ${token}`);
  }
  const app = createApp({
    agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0, projectRepository,
    reportingRepository: createInMemoryReportingRepository(), reportSubscriptionSweepIntervalMs: 0, resourceFinanceRepository, sessionsRepository, tokenService,
  });
  return { app, auth: (id) => tokens.get(id) };
}

test('reports and views scoped to a deleted project drop out of reporting until it is restored', async () => {
  const { app, auth } = await fixture();
  const report = await request(app).post('/api/reporting/reports').set('Authorization', auth('manager'))
    .send({ columns: ['projectId', 'projectName'], dataset: 'project', name: 'Alpha status', projectId: 'project-alpha', visibility: 'tenant' });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const reportId = report.body.value.id;
  const view = await request(app).post('/api/reporting/views').set('Authorization', auth('manager'))
    .send({ name: 'Alpha resources', projectId: 'project-alpha', surface: 'resources', visibility: 'tenant' });
  assert.equal(view.status, 201, JSON.stringify(view.body));
  const tenantWide = await request(app).post('/api/reporting/reports').set('Authorization', auth('manager'))
    .send({ columns: ['projectId', 'projectName'], dataset: 'project', name: 'All projects', visibility: 'tenant' });
  assert.equal((await request(app).post(`/api/reporting/reports/${tenantWide.body.value.id}/run`).set('Authorization', auth('admin')).send({})).status, 200);

  const workspace = async (id) => (await request(app).get('/api/reporting').set('Authorization', auth(id))).body;
  assert.deepEqual((await workspace('admin')).reports.map((item) => item.name), ['All projects', 'Alpha status']);

  assert.equal((await request(app).delete('/api/projects/project-alpha').set('Authorization', auth('admin'))).status, 200);

  for (const id of ['admin', 'manager']) {
    const after = await workspace(id);
    assert.deepEqual(after.reports.map((item) => item.name), ['All projects'], `${id} no longer sees the deleted project's report`);
    assert.equal(after.views.some((item) => item.projectId === 'project-alpha'), false);
    // A snapshot taken before the delete no longer shows the deleted project's rows, even to managers.
    assert.deepEqual(after.latestSnapshots[tenantWide.body.value.id].data.map((row) => row.projectId), ['project-beta']);
  }
  assert.equal((await request(app).post(`/api/reporting/reports/${reportId}/run`).set('Authorization', auth('manager')).send({})).status, 404);
  const subscription = await request(app).post('/api/reporting/subscriptions').set('Authorization', auth('manager'))
    .send({ nextRunAt: '2026-11-01T00:00:00.000Z', reportId, schedule: { intervalMinutes: 60 } });
  assert.equal(subscription.status, 404);

  assert.equal((await request(app).post('/api/projects/project-alpha/restore').set('Authorization', auth('admin'))).status, 200);
  assert.deepEqual((await workspace('manager')).reports.map((item) => item.name), ['All projects', 'Alpha status']);
  assert.equal((await request(app).post(`/api/reporting/reports/${reportId}/run`).set('Authorization', auth('manager')).send({})).status, 200);
});

test('the resource dataset ignores allocations on a deleted project', async () => {
  const { app, auth } = await fixture();
  const resourceRow = async () => {
    const response = await request(app).get('/api/reporting/bi/resource').set('Authorization', auth('admin'));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.rows[0];
  };
  const before = await resourceRow();
  assert.equal(before.allocatedHoursPerWeek, 50);
  assert.equal(before.overallocated, true);

  assert.equal((await request(app).delete('/api/projects/project-alpha').set('Authorization', auth('admin'))).status, 200);
  const after = await resourceRow();
  assert.equal(after.allocatedHoursPerWeek, 20);
  assert.equal(after.overallocated, false);
  assert.equal(after.utilizationPercent, 50);
  const dashboards = await request(app).get('/api/reporting/dashboards').set('Authorization', auth('admin'));
  assert.equal(dashboards.body.resource.overallocatedCount, 0);
});

test('MySQL: deleted project ids come from the soft-delete flag for the tenant', async () => {
  const statements = [];
  const execute = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push({ params, sql: text });
    if (/information_schema/i.test(text)) return [[{ count: 1 }]];
    if (/FROM projects p/.test(text)) return [[{ deletedAt: new Date('2026-10-09T12:00:00Z'), deletedBy: 'admin', id: 'project-alpha', name: 'Alpha', status: 'In Progress' }]];
    return [[]];
  };
  const repository = createMysqlProjectsRepository({ pool: { execute, getConnection: async () => ({ execute, query: execute, release() {} }), query: execute } });

  assert.deepEqual([...await loadDeletedProjectIds(repository, TENANT)], ['project-alpha']);
  const read = statements.find((statement) => /FROM projects p/.test(statement.sql));
  assert.match(read.sql, /WHERE p\.tenant_id = \? AND COALESCE\(p\.deleted, 0\) <> 0/);
  assert.deepEqual(read.params, [TENANT]);
  assert.deepEqual([...await loadDeletedProjectIds({}, TENANT)], [], 'repositories without soft delete report none');
});
