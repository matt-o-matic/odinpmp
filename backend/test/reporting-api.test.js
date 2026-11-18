import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryPortfolioRepository } from '../src/modules/portfolio/portfolio.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

async function fixture({ appOptions = {} } = {}) {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'manager@example.com', id: 'manager', memberships: [{ role: 'manager', tenantId: 'tenant-1' }], name: 'Manager', password: 'Secret123!' },
    { authMethod: 'basic', email: 'member@example.com', id: 'member', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Member', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'member', role: 'member' }], 'project-2': [] },
    projects: [
      { description: 'Customer launch and onboarding', endDate: '2026-09-30', epics: [{ id: 'epic-1', name: 'Launch delivery', status: 'In Progress', stories: [] }], id: 'project-1', name: 'Launch', startDate: '2026-07-01', status: 'In Progress', tenantId: 'tenant-1', updatedAt: '2026-07-11T00:00:00.000Z' },
      { description: 'Confidential merger plan', epics: [], id: 'project-2', name: 'Secret merger', status: 'At Risk', tenantId: 'tenant-1', updatedAt: '2026-07-11T00:00:00.000Z' },
    ],
  } });
  const governanceRepository = createInMemoryGovernanceRepository();
  await governanceRepository.createItem({ input: { description: 'Vendor capacity could delay onboarding.', dueDate: null, impact: 'high', kind: 'risk', ownerId: null, probability: 'medium', responsePlan: 'Keep a backup vendor.', status: 'open', title: 'Vendor capacity' }, projectId: 'project-1', tenantId: 'tenant-1' });
  await governanceRepository.createItem({ input: { description: 'Confidential issue.', dueDate: null, impact: 'critical', kind: 'risk', ownerId: null, probability: 'high', responsePlan: '', status: 'open', title: 'Secret issue' }, projectId: 'project-2', tenantId: 'tenant-1' });
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  await resourceFinanceRepository.createFinancialEntry({ input: { amount: 100000, category: 'Envelope', currency: 'USD', effectiveDate: '2026-07-01', entryKind: 'budget', note: '', projectId: 'project-1', sourceId: null, sourceType: 'manual', status: 'approved' }, tenantId: 'tenant-1' });
  const tokenService = createTokenService({ issuer: 'test', secret: 'reporting-test-secret-is-long-enough' }); const sessionsRepository = createInMemorySessionsRepository(); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const reportingRepository = createInMemoryReportingRepository();
  const complianceRepository = createInMemoryComplianceRepository();
  const mailRepository = createInMemoryMailRepository();
  const workflowRepository = createInMemoryWorkflowRepository();
  const app = createApp({ agentExecutionRepository: createInMemoryAgentExecutionRepository(), agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, complianceRepository, domainEventSweepIntervalMs: 0, frontendAppUrl: 'https://odin.example/app', governanceRepository, mailRepository, portfolioRepository: createInMemoryPortfolioRepository(), projectRepository, reportingRepository, reportSubscriptionSweepIntervalMs: 0, resourceFinanceRepository, sessionsRepository, tokenService, workflowRepository, ...appOptions });
  return { app, authRepository, authorization: (id) => `Bearer ${tokens.get(id)}`, governanceRepository, mailRepository, reportingRepository, workflowRepository };
}

test('report deletion is locked while a record-scoped legal hold is active', async () => {
  const { app, authorization } = await fixture();
  const report = await request(app).post('/api/reporting/reports').set('Authorization', authorization('manager')).send({ columns: ['projectId', 'projectName'], dataset: 'project', name: 'Litigation report', visibility: 'tenant' });
  assert.equal(report.status, 201);
  const hold = await request(app).post('/api/compliance/legal-holds').set('Authorization', authorization('admin')).send({ reason: 'Preserve this report for pending litigation.', resourceId: report.body.value.id, resourceType: 'report' });
  assert.equal(hold.status, 201);
  const blocked = await request(app).delete(`/api/reporting/reports/${report.body.value.id}`).set('Authorization', authorization('manager')).send({ expectedVersion: 1 });
  assert.equal(blocked.status, 423); assert.equal(blocked.body.details.code, 'record_legal_hold_active');
  assert.equal((await request(app).post(`/api/compliance/legal-holds/${hold.body.value.id}/release`).set('Authorization', authorization('admin')).send({ expectedVersion: 1, reason: 'The preservation duty has formally ended.' })).status, 200);
  assert.equal((await request(app).delete(`/api/reporting/reports/${report.body.value.id}`).set('Authorization', authorization('manager')).send({ expectedVersion: 1 })).status, 200);
});

test('reporting analytics incrementally materializes visible CDC facts and serves sequence-valid cache entries', async () => {
  const { app, authorization, reportingRepository } = await fixture();
  const recent = Date.now() - 24 * 60 * 60 * 1000;
  await reportingRepository.captureWarehouseChange({ event: { createdAt: new Date(recent).toISOString(), eventType: 'workflow.transitioned', id: 'visible-event', payload: {}, projectId: 'project-1', tenantId: 'tenant-1' } });
  await reportingRepository.captureWarehouseChange({ event: { createdAt: new Date(recent + 60 * 1000).toISOString(), eventType: 'governance.changed', id: 'hidden-event', payload: {}, projectId: 'project-2', tenantId: 'tenant-1' } });
  const first = await request(app).get('/api/reporting/analytics/change-trends?days=90').set('Authorization', authorization('member'));
  assert.equal(first.status, 200); assert.equal(first.body.cache, 'miss'); assert.deepEqual(first.body.facts.map((item) => item.projectId), ['project-1']); assert.equal(first.body.freshness.source, 'cdc-incremental-warehouse'); assert.equal(first.body.trends[0].forecastNextPeriod, 1);
  const second = await request(app).get('/api/reporting/analytics/change-trends?days=90').set('Authorization', authorization('member'));
  assert.equal(second.status, 200); assert.equal(second.body.cache, 'hit');
});

test('reporting API materializes permission-aware global search and facets', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager'); const member = authorization('member');
  const refreshed = await request(app).post('/api/reporting/search/refresh').set('Authorization', manager);
  assert.equal(refreshed.status, 200); assert.ok(refreshed.body.indexed >= 5);
  const visible = await request(app).get('/api/reporting/search?query=launch').set('Authorization', member);
  assert.equal(visible.status, 200); assert.ok(visible.body.records.some((item) => item.title === 'Launch')); assert.doesNotMatch(JSON.stringify(visible.body), /Secret merger|Secret issue|Confidential/);
  const risk = await request(app).get('/api/reporting/search?query=vendor&types=risk&facets=impact:high').set('Authorization', member);
  assert.equal(risk.status, 200); assert.deepEqual(risk.body.records.map((item) => item.title), ['Vendor capacity']); assert.equal(risk.body.facetCounts.impact.high, 1);
  assert.equal((await request(app).post('/api/reporting/search/refresh').set('Authorization', member)).status, 404);
});

test('global search builds a stale tenant index at search time for any member without widening visibility', async () => {
  const { app, authorization, reportingRepository } = await fixture(); const member = authorization('member');
  assert.equal(await reportingRepository.getSearchIndexFreshness({ tenantId: 'tenant-1' }), null);
  const result = await request(app).get('/api/reporting/search?query=vendor').set('Authorization', member);
  assert.equal(result.status, 200); assert.deepEqual(result.body.records.map((item) => item.title), ['Vendor capacity']);
  assert.equal(result.body.records[0].url, '/projects/project-1/governance');
  assert.ok(await reportingRepository.getSearchIndexFreshness({ tenantId: 'tenant-1' }));
  // The tenant-wide build indexed the hidden project, but the member's results still exclude it.
  assert.ok((await reportingRepository.searchDocuments({ limit: 50, offset: 0, projectIds: ['project-2'], query: 'secret', tenantId: 'tenant-1', types: [] })).total >= 1);
  const hidden = await request(app).get('/api/reporting/search?query=secret').set('Authorization', member);
  assert.equal(hidden.status, 200); assert.equal(hidden.body.total, 0); assert.doesNotMatch(JSON.stringify(hidden.body), /Secret merger|Secret issue|Confidential/);
  const scoped = await request(app).get('/api/reporting/search?query=secret&projectId=project-2').set('Authorization', member);
  assert.notEqual(scoped.status, 200);
});

test('global search picks up changes once the index is older than the configured age', async () => {
  const { app, authorization, governanceRepository } = await fixture({ appOptions: { searchIndexMaxAgeMs: 20 } }); const member = authorization('member');
  assert.equal((await request(app).get('/api/reporting/search?query=escalation').set('Authorization', member)).body.total, 0);
  await governanceRepository.createItem({ input: { description: 'Escalation path for the onboarding vendor.', dueDate: null, impact: 'medium', kind: 'issue', ownerId: null, probability: 'medium', responsePlan: '', status: 'open', title: 'Escalation path' }, projectId: 'project-1', tenantId: 'tenant-1' });
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  const fresh = await request(app).get('/api/reporting/search?query=escalation').set('Authorization', member);
  assert.equal(fresh.status, 200); assert.deepEqual(fresh.body.records.map((item) => item.title), ['Escalation path']);
});

test('global search keeps serving a fresh index without rebuilding on every request', async () => {
  const { app, authorization, governanceRepository } = await fixture(); const member = authorization('member');
  assert.equal((await request(app).get('/api/reporting/search?query=launch').set('Authorization', member)).status, 200);
  await governanceRepository.createItem({ input: { description: 'Added after the index was built.', dueDate: null, impact: 'low', kind: 'issue', ownerId: null, probability: 'low', responsePlan: '', status: 'open', title: 'Escalation path' }, projectId: 'project-1', tenantId: 'tenant-1' });
  assert.equal((await request(app).get('/api/reporting/search?query=escalation').set('Authorization', member)).body.total, 0);
  // The manager's manual refresh still rebuilds immediately.
  assert.equal((await request(app).post('/api/reporting/search/refresh').set('Authorization', authorization('manager'))).status, 200);
  assert.equal((await request(app).get('/api/reporting/search?query=escalation').set('Authorization', member)).body.total, 1);
});

test('reporting subscriptions execute durably, advance schedules, and queue deduplicated email links', async () => {
  const { app, authorization, mailRepository } = await fixture(); const manager = authorization('manager'); const member = authorization('member');
  const report = await request(app).post('/api/reporting/reports').set('Authorization', manager).send({ columns: ['projectName', 'status'], dataset: 'project', name: 'Daily project status', visibility: 'tenant' });
  const subscription = await request(app).post('/api/reporting/subscriptions').set('Authorization', member).send({ deliveryChannel: 'email', format: 'xlsx', nextRunAt: '2026-07-11T12:00:00.000Z', recipients: ['member@example.com'], reportId: report.body.value.id, schedule: { intervalMinutes: 1440, timezone: 'America/New_York' } });
  assert.equal(subscription.status, 201);
  const results = await app.locals.materializeDueReportSubscriptions({ now: new Date('2026-07-11T12:00:00.000Z') });
  assert.equal(results[0].status, 'completed'); assert.equal(mailRepository.state.queue.length, 1); assert.match(mailRepository.state.queue[0].body, /reports\?report=/);
  const workspace = await request(app).get('/api/reporting').set('Authorization', member); assert.equal(workspace.body.subscriptions[0].lastRunAt, '2026-07-11T12:00:00.000Z'); assert.equal(workspace.body.subscriptions[0].nextRunAt, '2026-07-12T12:00:00.000Z'); assert.equal(workspace.body.runs[0].status, 'completed');
  assert.deepEqual(await app.locals.materializeDueReportSubscriptions({ now: new Date('2026-07-11T12:00:01.000Z') }), []); assert.equal(mailRepository.state.queue.length, 1);
});

test('reporting API rejects unscoped project visibility and unauthorized email recipients', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager'); const member = authorization('member');
  const unscopedView = await request(app).post('/api/reporting/views').set('Authorization', member).send({ filters: {}, name: 'Invalid project view', surface: 'projects', visibility: 'project' });
  assert.equal(unscopedView.status, 400);
  const report = await request(app).post('/api/reporting/reports').set('Authorization', manager).send({ columns: ['projectName', 'status'], dataset: 'project', name: 'Shared status', visibility: 'tenant' });
  assert.equal(report.status, 201);
  const unauthorizedDelivery = await request(app).post('/api/reporting/subscriptions').set('Authorization', member).send({ deliveryChannel: 'email', format: 'pdf', nextRunAt: '2030-01-01T12:00:00.000Z', recipients: ['executive@example.com'], reportId: report.body.value.id, schedule: { intervalMinutes: 1440, timezone: 'America/New_York' } });
  assert.equal(unauthorizedDelivery.status, 403);
  const authorizedDelivery = await request(app).post('/api/reporting/subscriptions').set('Authorization', manager).send({ deliveryChannel: 'email', format: 'pdf', nextRunAt: '2030-01-01T12:00:00.000Z', recipients: ['executive@example.com'], reportId: report.body.value.id, schedule: { intervalMinutes: 1440, timezone: 'America/New_York' } });
  assert.equal(authorizedDelivery.status, 201);
});

test('reporting API manages views, reports, snapshots, subscriptions, CSV, and row-level-secured BI feeds', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager'); const member = authorization('member');
  const view = await request(app).post('/api/reporting/views').set('Authorization', member).send({ filters: { status: 'In Progress' }, name: 'My launch work', projectId: 'project-1', surface: 'projects', visibility: 'project' });
  assert.equal(view.status, 201);
  const report = await request(app).post('/api/reporting/reports').set('Authorization', manager).send({ columns: ['projectId', 'projectName', 'status', 'openRiskCount'], dataset: 'executive', name: 'Executive delivery', visibility: 'tenant' });
  assert.equal(report.status, 201);
  const memberWorkspace = await request(app).get('/api/reporting').set('Authorization', member);
  assert.equal(memberWorkspace.status, 200); assert.equal(memberWorkspace.body.reports[0].name, 'Executive delivery'); assert.equal(memberWorkspace.body.views[0].name, 'My launch work');
  const executed = await request(app).post(`/api/reporting/reports/${report.body.value.id}/run`).set('Authorization', member).send({ format: 'json', limit: 100 });
  assert.equal(executed.status, 200); assert.deepEqual(executed.body.rows.map((row) => row.projectName), ['Launch']); assert.equal(executed.body.freshness.rowLevelSecurity, 'visible-project-set');
  const csv = await request(app).post(`/api/reporting/reports/${report.body.value.id}/run`).set('Authorization', manager).send({ format: 'csv', limit: 100 });
  assert.equal(csv.status, 200); assert.match(csv.body.content, /projectId,projectName,status,openRiskCount/); assert.match(csv.body.content, /Secret merger/);
  const securedWorkspace = await request(app).get('/api/reporting').set('Authorization', member);
  assert.deepEqual(securedWorkspace.body.latestSnapshots[report.body.value.id].data.map((row) => row.projectName), ['Launch']);
  const subscription = await request(app).post('/api/reporting/subscriptions').set('Authorization', member).send({ deliveryChannel: 'in_app', format: 'csv', nextRunAt: '2030-01-01T12:00:00.000Z', reportId: report.body.value.id, schedule: { intervalMinutes: 1440, timezone: 'America/New_York' } });
  assert.equal(subscription.status, 201);
  const bi = await request(app).get('/api/reporting/bi/risk?limit=100').set('Authorization', member);
  assert.equal(bi.status, 200); assert.deepEqual(bi.body.rows.map((row) => row.title), ['Vendor capacity']); assert.equal(bi.body.freshness.rowLevelSecurity, 'visible-project-set');
  const dashboard = await request(app).get('/api/reporting/dashboards').set('Authorization', member); assert.equal(dashboard.status, 200); assert.equal(dashboard.body.executive.projectCount, 1); assert.equal(dashboard.body.risk.openCount, 1); assert.equal(dashboard.body.financial.authorized, false);
  const financial = await request(app).post('/api/reporting/reports').set('Authorization', manager).send({ columns: ['projectId', 'amount', 'currency'], dataset: 'financial', name: 'Financial ledger', visibility: 'tenant' });
  assert.equal(financial.status, 201); assert.equal((await request(app).post(`/api/reporting/reports/${financial.body.value.id}/run`).set('Authorization', member).send({})).status, 404);
  assert.equal((await request(app).delete(`/api/reporting/reports/${report.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 1 })).status, 409);
});

test('workflow reporting counts overdue SLA only for the current item state', async () => {
  const { app, authorization, workflowRepository } = await fixture();
  await workflowRepository.recordTransition({ fromState: 'todo', itemId: 'epic-1', itemType: 'epic', projectId: 'project-1', slaDueAt: '2000-01-01T00:00:00.000Z', tenantId: 'tenant-1', toState: 'review', transitionKey: 'review', userId: 'manager' });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await workflowRepository.recordTransition({ fromState: 'review', itemId: 'epic-1', itemType: 'epic', projectId: 'project-1', slaDueAt: '2100-01-01T00:00:00.000Z', tenantId: 'tenant-1', toState: 'done', transitionKey: 'complete', userId: 'manager' });

  const dashboard = await request(app).get('/api/reporting/dashboards').set('Authorization', authorization('manager'));
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.workflow.transitionCount, 2);
  assert.equal(dashboard.body.workflow.overdueSlaCount, 0);
});

test('scheduled report emails skip Odin users who turned off report emails and still reach other recipients', async () => {
  const { app, authRepository, authorization, mailRepository } = await fixture(); const manager = authorization('manager');
  authRepository.state.users.find((user) => user.id === 'member').preferences = { emailNotifSummaries: false, notificationPrefsVersion: 1, twoFactorEnabled: false };
  const report = await request(app).post('/api/reporting/reports').set('Authorization', manager).send({ columns: ['projectName', 'status'], dataset: 'project', name: 'Daily project status', visibility: 'tenant' });
  const subscription = await request(app).post('/api/reporting/subscriptions').set('Authorization', manager).send({ deliveryChannel: 'email', format: 'csv', nextRunAt: '2026-07-11T12:00:00.000Z', recipients: ['member@example.com', 'manager@example.com', 'executive@partner.example'], reportId: report.body.value.id, schedule: { intervalMinutes: 1440, timezone: 'America/New_York' } });
  assert.equal(subscription.status, 201, JSON.stringify(subscription.body));
  const results = await app.locals.materializeDueReportSubscriptions({ now: new Date('2026-07-11T12:00:00.000Z') });
  assert.equal(results[0].status, 'completed');
  assert.deepEqual(mailRepository.state.queue.map((row) => row.recipientEmail).sort(), ['executive@partner.example', 'manager@example.com']);
});
