import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'manager@example.com', id: 'manager', memberships: [{ role: 'manager', tenantId: 'tenant-1' }], name: 'Manager', password: 'Secret123!' },
    { authMethod: 'basic', email: 'member@example.com', id: 'member', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Member', password: 'Secret123!' },
    { authMethod: 'basic', email: 'outsider@example.com', id: 'outsider', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Outsider', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'member', role: 'member' }], 'project-2': [] },
    projects: [
      { epics: [], id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-1' },
      { epics: [], id: 'project-2', name: 'ERP', status: 'At Risk', tenantId: 'tenant-1' },
    ],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'resource-finance-test-secret-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository(); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  const complianceRepository = createInMemoryComplianceRepository();
  const storedReceipts = new Map();
  const fileStorage = { async delete(id) { storedReceipts.delete(id); }, async read(id) { const bytes = storedReceipts.get(id); if (!bytes) throw new Error('missing'); return { bytes, size: bytes.length }; }, async write(id, bytes) { storedReceipts.set(id, Buffer.from(bytes)); } };
  const fileScanner = { async scanBytes() { return { clean: true, scanner: 'test' }; } };
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, complianceRepository, domainEventSweepIntervalMs: 0, fileScanner, fileStorage, projectRepository, resourceFinanceRepository, sessionsRepository, tokenService });
  return { app, authorization: (id) => `Bearer ${tokens.get(id)}`, storedReceipts };
}

test('financial entry mutation and deletion are locked by record-scoped legal hold', async () => {
  const { app, authorization } = await fixture();
  const entry = await request(app).post('/api/resource-planning/financial-entries').set('Authorization', authorization('manager')).send({ amount: 25000, effectiveDate: '2026-07-01', entryKind: 'forecast', projectId: 'project-1' });
  assert.equal(entry.status, 201);
  const hold = await request(app).post('/api/compliance/legal-holds').set('Authorization', authorization('admin')).send({ reason: 'Preserve this ledger source for audit review.', resourceId: entry.body.value.id, resourceType: 'financial_entry' });
  assert.equal(hold.status, 201);
  assert.equal((await request(app).patch(`/api/resource-planning/financial-entries/${entry.body.value.id}`).set('Authorization', authorization('manager')).send({ amount: 26000, expectedVersion: 1 })).status, 423);
  assert.equal((await request(app).delete(`/api/resource-planning/financial-entries/${entry.body.value.id}`).set('Authorization', authorization('manager')).send({ expectedVersion: 1 })).status, 423);
  assert.equal((await request(app).post(`/api/compliance/legal-holds/${hold.body.value.id}/release`).set('Authorization', authorization('admin')).send({ expectedVersion: 1, reason: 'The financial preservation duty has ended.' })).status, 200);
  assert.equal((await request(app).delete(`/api/resource-planning/financial-entries/${entry.body.value.id}`).set('Authorization', authorization('manager')).send({ expectedVersion: 1 })).status, 200);
});

test('resource planning API manages pools, skills, leave, allocations, capacity, time, and finance rollups', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager');
  const pool = await request(app).post('/api/resource-planning/pools').set('Authorization', manager).send({ name: 'Product engineering' });
  assert.equal(pool.status, 201);
  const resource = await request(app).post('/api/resource-planning/resources').set('Authorization', manager).send({
    billRate: 225, capacityHoursPerWeek: 40, costRate: 150, currency: 'USD', name: 'Alex Engineer', poolId: pool.body.value.id,
    roles: ['Engineer'], skills: [{ level: 5, name: 'Delivery' }], userId: 'member',
  });
  assert.equal(resource.status, 201);
  assert.equal((await request(app).post('/api/resource-planning/calendar-entries').set('Authorization', manager).send({
    endDate: '2099-01-01', entryType: 'leave', hoursPerDay: 2, resourceId: resource.body.value.id, startDate: '2000-01-01', status: 'approved',
  })).status, 201);
  const allocation = await request(app).post('/api/resource-planning/allocations').set('Authorization', manager).send({
    allocationPercent: 100, endDate: '2099-12-31', hoursPerWeek: 35, projectId: 'project-1', resourceId: resource.body.value.id,
    scenario: 'baseline', startDate: '2000-01-01', status: 'active',
  });
  assert.equal(allocation.status, 201);
  const period = await request(app).post('/api/resource-planning/timesheet-periods').set('Authorization', manager).send({ endDate: '2026-07-12', name: 'July week two', startDate: '2026-07-06' });
  assert.equal(period.status, 201);
  const accountingPeriod = await request(app).post('/api/resource-planning/accounting-periods').set('Authorization', manager).send({ endDate: '2026-07-31', fiscalYear: 2026, name: 'July 2026', periodNumber: 7, startDate: '2026-07-01' });
  assert.equal(accountingPeriod.status, 201);
  const financePolicy = await request(app).post('/api/resource-planning/finance-policies').set('Authorization', manager).send({ actualCostVariancePercent: 5, expenseApprovalAmount: 1000, forecastVariancePercent: 10, minimumMarginPercent: 15, name: 'Delivery controls', projectId: 'project-1' });
  assert.equal(financePolicy.status, 201);
  assert.equal((await request(app).post('/api/resource-planning/time-entries').set('Authorization', authorization('member')).send({
    hours: 7.5, periodId: period.body.value.id, projectId: 'project-1', resourceId: resource.body.value.id, workDate: '2026-07-11',
  })).status, 201);
  const expense = await request(app).post('/api/resource-planning/expenses').set('Authorization', manager).send({
    amount: 1200, category: 'Travel', currency: 'USD', expenseDate: '2026-07-11', projectId: 'project-1', resourceId: resource.body.value.id,
  });
  assert.equal(expense.status, 201);
  assert.equal((await request(app).patch(`/api/resource-planning/expenses/${expense.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 1, status: 'approved' })).status, 403);
  assert.equal((await request(app).patch(`/api/resource-planning/expenses/${expense.body.value.id}`).set('Authorization', authorization('admin')).send({ expectedVersion: 1, status: 'approved' })).status, 200);
  assert.equal((await request(app).post('/api/resource-planning/resource-rates').set('Authorization', manager).send({ billRate: 240, costRate: 160, currency: 'USD', effectiveStart: '2026-07-01', resourceId: resource.body.value.id, status: 'approved' })).status, 201);
  assert.equal((await request(app).post('/api/resource-planning/exchange-rates').set('Authorization', manager).send({ baseCurrency: 'USD', effectiveDate: '2026-07-01', quoteCurrency: 'EUR', rate: 0.91, source: 'Treasury', status: 'approved' })).status, 201);
  assert.equal((await request(app).post('/api/resource-planning/expense-receipts').set('Authorization', manager).send({ contentType: 'application/pdf', expenseId: expense.body.value.id, fileName: 'hotel.pdf', sha256: 'a'.repeat(64), sizeBytes: 8192, storageKey: 'tenant-1/receipts/hotel.pdf' })).status, 201);
  const finance = await request(app).post('/api/resource-planning/financial-entries').set('Authorization', manager).send({
    amount: 500000, category: 'Approved envelope', effectiveDate: '2026-07-01', entryKind: 'budget', projectId: 'project-1', status: 'approved',
  });
  assert.equal(finance.status, 201);
  assert.equal((await request(app).patch(`/api/resource-planning/financial-entries/${finance.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 1, status: 'posted' })).status, 403);
  const posted = await request(app).patch(`/api/resource-planning/financial-entries/${finance.body.value.id}`).set('Authorization', authorization('admin')).send({ expectedVersion: 1, status: 'posted' });
  assert.equal(posted.status, 200);
  assert.equal((await request(app).patch(`/api/resource-planning/financial-entries/${finance.body.value.id}`).set('Authorization', authorization('admin')).send({ amount: 600000, expectedVersion: 2 })).status, 409);

  const workspace = await request(app).get('/api/resource-planning?projectId=project-1&scenario=baseline&reportingCurrency=EUR').set('Authorization', manager);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.capacity[0].availableHours, 30);
  assert.deepEqual(workspace.body.calendarEntries[0].weekdays, [1, 2, 3, 4, 5]);
  assert.equal(workspace.body.calendarEntries[0].timezone, 'UTC');
  assert.equal(workspace.body.capacity[0].allocatedHours, 35);
  assert.equal(workspace.body.capacity[0].overallocated, true);
  assert.equal(workspace.body.timeRollup.submittedHours, 7.5);
  assert.equal(workspace.body.financialRollup.byKind.budget, 500000);
  assert.equal(workspace.body.financialRollup.expenseByCurrency.USD, 1200);
  assert.equal(workspace.body.analysis.weekly[0].demandHours, 35);
  assert.equal(workspace.body.analysis.scenarios.find((item) => item.scenario === 'baseline').projectedWeeklyMargin, 2800);
  assert.equal(workspace.body.analysis.financialPerformance[0].budget, 500000);
  assert.equal(workspace.body.analysis.financialPerformance[0].reporting.budget, 455000);
  assert.equal(workspace.body.analysis.scenarios.find((item) => item.scenario === 'baseline').reportingTotals.projectedWeeklyMargin, 2548);
  assert.equal(workspace.body.resourceRates[0].costRate, 160);
  assert.equal(workspace.body.timesheetPeriods[0].name, 'July week two');
  assert.equal(workspace.body.expenseReceipts[0].fileName, 'hotel.pdf');
  assert.equal(workspace.body.exchangeRates[0].rate, 0.91);
  assert.equal(workspace.body.accountingPeriods[0].name, 'July 2026');
  assert.equal(workspace.body.financePolicies[0].name, 'Delivery controls');
});

test('resource and finance reads hide inaccessible projects, rates, and ledgers from ordinary members', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager');
  const resource = await request(app).post('/api/resource-planning/resources').set('Authorization', manager).send({ costRate: 200, name: 'Visible resource', userId: 'member' });
  await request(app).post('/api/resource-planning/allocations').set('Authorization', manager).send({ endDate: '2026-12-31', projectId: 'project-1', resourceId: resource.body.value.id, startDate: '2026-01-01' });
  await request(app).post('/api/resource-planning/allocations').set('Authorization', manager).send({ endDate: '2026-12-31', projectId: 'project-2', resourceId: resource.body.value.id, startDate: '2026-01-01' });
  await request(app).post('/api/resource-planning/financial-entries').set('Authorization', manager).send({ amount: 1000, effectiveDate: '2026-07-01', entryKind: 'forecast', projectId: 'project-1' });
  const member = await request(app).get('/api/resource-planning').set('Authorization', authorization('member'));
  assert.equal(member.status, 200);
  assert.equal(member.body.allocations.length, 1);
  assert.equal(member.body.allocations[0].projectId, 'project-1');
  assert.equal(member.body.resources[0].costRate, null);
  assert.equal(member.body.financialEntries.length, 0);
  assert.deepEqual(member.body.analysis.financialPerformance, []);
  assert.deepEqual(Object.keys(member.body.analysis.scenarios[0]).sort(), ['allocatedHoursPerWeek', 'scenario']);
  assert.deepEqual(member.body.resourceRates, []);
  assert.deepEqual(member.body.expenseReceipts, []);
  assert.deepEqual(member.body.exchangeRates, []);
  assert.equal(member.body.canManageFinance, false);
  assert.equal((await request(app).get('/api/resource-planning?projectId=project-2').set('Authorization', authorization('outsider'))).status, 404);
  assert.equal((await request(app).post('/api/resource-planning/resources').set('Authorization', authorization('member')).send({ name: 'Denied' })).status, 404);
});

test('resource managers atomically split or move allocations with optimistic locking and project authorization', async () => {
  const { app, authorization } = await fixture();
  const manager = authorization('manager');
  const source = await request(app).post('/api/resource-planning/resources').set('Authorization', manager).send({ name: 'Source engineer', skills: [{ level: 5, name: 'Delivery' }] });
  const target = await request(app).post('/api/resource-planning/resources').set('Authorization', manager).send({ name: 'Target engineer', skills: [{ level: 5, name: 'Delivery' }] });
  const allocation = await request(app).post('/api/resource-planning/allocations').set('Authorization', manager).send({
    allocationPercent: 100, endDate: '2026-12-31', hoursPerWeek: 40, projectId: 'project-1', resourceId: source.body.value.id,
    role: 'Delivery', scenario: 'baseline', startDate: '2026-01-01', status: 'active',
  });

  const split = await request(app).post(`/api/resource-planning/allocations/${allocation.body.value.id}/level`).set('Authorization', manager).send({
    expectedVersion: 1, hours: 12, targetResourceId: target.body.value.id,
  });
  assert.equal(split.status, 200);
  assert.equal(split.body.value.sourceAllocation.hoursPerWeek, 28);
  assert.equal(split.body.value.sourceAllocation.allocationPercent, 70);
  assert.equal(split.body.value.targetAllocation.hoursPerWeek, 12);
  assert.equal(split.body.value.targetAllocation.allocationPercent, 30);
  assert.equal(split.body.value.targetAllocation.resourceId, target.body.value.id);

  const stale = await request(app).post(`/api/resource-planning/allocations/${allocation.body.value.id}/level`).set('Authorization', manager).send({ expectedVersion: 1, hours: 4, targetResourceId: target.body.value.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'resource_finance_version_conflict');
  assert.equal((await request(app).post(`/api/resource-planning/allocations/${allocation.body.value.id}/level`).set('Authorization', authorization('member')).send({ expectedVersion: 2, hours: 28, targetResourceId: target.body.value.id })).status, 404);

  const moved = await request(app).post(`/api/resource-planning/allocations/${allocation.body.value.id}/level`).set('Authorization', manager).send({ expectedVersion: 2, hours: 28, targetResourceId: target.body.value.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.value.sourceAllocation, null);
  assert.equal(moved.body.value.targetAllocation.resourceId, target.body.value.id);
  assert.equal(moved.body.value.targetAllocation.version, 3);
});

test('expense receipt upload scans, hashes, stores, authorizes, downloads, and deletes binary content', async () => {
  const { app, authorization, storedReceipts } = await fixture(); const manager = authorization('manager');
  const resource = await request(app).post('/api/resource-planning/resources').set('Authorization', manager).send({ name: 'Receipt owner' });
  const expense = await request(app).post('/api/resource-planning/expenses').set('Authorization', manager).send({ amount: 42, category: 'Travel', currency: 'USD', expenseDate: '2026-07-11', projectId: 'project-1', resourceId: resource.body.value.id });
  const bytes = Buffer.from('receipt-binary-content');
  assert.equal((await request(app).post(`/api/resource-planning/expenses/${expense.body.value.id}/receipt-content`).set('Authorization', manager).send({ contentBase64: 'not-base64!', contentType: 'application/pdf', fileName: 'bad.pdf' })).status, 400);
  const uploaded = await request(app).post(`/api/resource-planning/expenses/${expense.body.value.id}/receipt-content`).set('Authorization', manager).send({ contentBase64: bytes.toString('base64'), contentType: 'application/pdf', fileName: 'receipt.pdf' });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.value.sizeBytes, bytes.length);
  assert.match(uploaded.body.value.sha256, /^[a-f0-9]{64}$/);
  assert.equal(storedReceipts.size, 1);
  const content = await request(app).get(`/api/resource-planning/expense-receipts/${uploaded.body.value.id}/content`).set('Authorization', manager).buffer(true).parse((response, callback) => { const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks))); });
  assert.equal(content.status, 200); assert.deepEqual(content.body, bytes); assert.match(content.headers['content-disposition'], /receipt\.pdf/);
  assert.equal((await request(app).get(`/api/resource-planning/expense-receipts/${uploaded.body.value.id}/content`).set('Authorization', authorization('member'))).status, 404);
  assert.equal((await request(app).delete(`/api/resource-planning/expense-receipts/${uploaded.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 1 })).status, 200);
  assert.equal(storedReceipts.size, 0);
});

test('linking a resource to a login merges a duplicate profile, and project rates respect the minimum', async () => {
  const { app, authorization } = await fixture();
  const manager = authorization('manager');
  const post = (path, body) => request(app).post(`/api/resource-planning${path}`).set('Authorization', manager).send(body);
  const patch = (path, body) => request(app).patch(`/api/resource-planning${path}`).set('Authorization', manager).send(body);

  // Odin made a profile when the member was given work; someone also typed one in by hand.
  const auto = (await post('/resources', { name: 'Member', roles: ['Developer'], skills: [{ level: 2, name: 'Vue' }], userId: 'member' })).body.value;
  const manual = (await post('/resources', { billRate: 150, minBillRate: 120, name: 'Mem Ber', skills: [{ level: 4, name: 'vue' }] })).body.value;
  const autoAllocation = (await post('/allocations', { endDate: '2026-12-31', hoursPerWeek: 0, origin: 'assignment', projectId: 'project-1', resourceId: auto.id, startDate: '2026-07-01', status: 'active' })).body.value;
  assert.equal(autoAllocation.origin, 'assignment');

  // A second profile for the same login is refused outright.
  assert.equal((await post('/resources', { name: 'Again', userId: 'member' })).status, 409);
  // Only people in the workspace can be linked.
  assert.equal((await patch(`/resources/${manual.id}`, { expectedVersion: 1, userId: 'nobody' })).status, 404);

  const linked = await patch(`/resources/${manual.id}`, { expectedVersion: 1, userId: 'member' });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.value.userId, 'member');
  assert.deepEqual(linked.body.value.roles, ['Developer']);
  assert.deepEqual(linked.body.value.skills, [{ level: 4, name: 'vue' }]);

  const team = await request(app).get('/api/resource-planning/projects/project-1/team').set('Authorization', manager);
  assert.equal(team.status, 200);
  assert.deepEqual(team.body.people.map((person) => [person.resource.name, person.assigneeId]), [['Mem Ber', 'member']]);
  assert.equal(team.body.allocations[0].resourceId, manual.id);
  assert.equal(team.body.directory.some((resource) => resource.id === auto.id), false);

  const allocation = team.body.allocations[0];
  const tooLow = await patch(`/allocations/${allocation.id}`, { billRate: 100, expectedVersion: allocation.version });
  assert.equal(tooLow.status, 400);
  assert.match(tooLow.body.message ?? tooLow.body.error ?? '', /minimum/);
  const ok = await patch(`/allocations/${allocation.id}`, { billRate: 135.5, expectedVersion: allocation.version });
  assert.equal(ok.body.value.billRate, 135.5);

  // A resource with no login owns work as resource:<id>; members see names but no rates or directory.
  const contractor = (await post('/resources', { billRate: 90, name: 'Casey Contractor' })).body.value;
  await post('/allocations', { endDate: '2026-12-31', projectId: 'project-1', resourceId: contractor.id, startDate: '2026-07-01', status: 'proposed' });
  const memberView = await request(app).get('/api/resource-planning/projects/project-1/team').set('Authorization', authorization('member'));
  assert.equal(memberView.status, 200);
  assert.deepEqual(memberView.body.people.map((person) => person.assigneeId), [`resource:${contractor.id}`, 'member']);
  assert.equal(memberView.body.people[0].resource.billRate, undefined);
  assert.deepEqual(memberView.body.directory, []);
  assert.equal((await request(app).get('/api/resource-planning/projects/project-2/team').set('Authorization', authorization('member'))).status, 404);
});

test('adding someone without a login to a project makes one profile and one allocation, and reuses a matching profile', async () => {
  const { app, authorization } = await fixture();
  const manager = authorization('manager');
  const add = (projectId, body, as = manager) => request(app).post(`/api/resource-planning/projects/${projectId}/resources`).set('Authorization', as).send(body);
  const today = new Date().toISOString().slice(0, 10);

  const added = await add('project-1', { allocation: { billRate: 110, hoursPerWeek: 20, role: 'QA' }, billRate: 95, capacityHoursPerWeek: 40, name: 'Casey Contractor', roles: ['QA engineer'], userId: 'member' });
  assert.equal(added.status, 201);
  assert.deepEqual([added.body.added, added.body.created, added.body.resource.userId, added.body.resource.billRate], [true, true, null, 95]);
  assert.equal(added.body.assigneeId, `resource:${added.body.resource.id}`);
  // A project without dates gets a year from today; 20 of 40 hours is half their week.
  assert.deepEqual(
    [added.body.allocation.startDate, added.body.allocation.allocationPercent, added.body.allocation.billRate, added.body.allocation.status, added.body.allocation.origin],
    [today, 50, 110, 'active', 'manual'],
  );
  assert.ok(added.body.allocation.endDate > today);

  // The same person again changes nothing; on another project they keep one profile.
  const again = await add('project-1', { allocation: { hoursPerWeek: 10 }, name: 'casey contractor' });
  assert.deepEqual([again.status, again.body.added, again.body.created, again.body.allocation.id], [201, false, false, added.body.allocation.id]);
  const elsewhere = await add('project-2', { allocation: { endDate: '2027-06-30', startDate: '2027-01-01' }, billRate: 999, name: 'Casey Contractor' });
  assert.deepEqual([elsewhere.body.added, elsewhere.body.created, elsewhere.body.resource.id, elsewhere.body.resource.billRate], [true, false, added.body.resource.id, 95]);
  assert.deepEqual([elsewhere.body.allocation.startDate, elsewhere.body.allocation.endDate], ['2027-01-01', '2027-06-30']);

  // A workspace user's name, dates out of order, and someone who cannot manage resources are refused.
  assert.equal((await add('project-1', { name: 'Member' })).status, 409);
  assert.equal((await add('project-1', { allocation: { endDate: '2027-01-01', startDate: '2027-02-01' }, name: 'Pia Placeholder' })).status, 400);
  assert.equal((await add('project-1', { name: 'Pia Placeholder' }, authorization('member'))).status, 404);
  assert.equal((await add('project-missing', { name: 'Pia Placeholder' })).status, 404);

  const workspace = await request(app).get('/api/resource-planning').set('Authorization', manager);
  assert.deepEqual(workspace.body.resources.map((resource) => resource.name), ['Casey Contractor']);
  const team = await request(app).get('/api/resource-planning/projects/project-1/team').set('Authorization', manager);
  assert.deepEqual(team.body.people.map((person) => person.assigneeId), [added.body.assigneeId]);
});

test('an email on someone added without a login says who they are, and their profile changes through the project', async () => {
  const { app, authorization } = await fixture();
  const manager = authorization('manager');
  const add = (projectId, body, as = manager) => request(app).post(`/api/resource-planning/projects/${projectId}/resources`).set('Authorization', as).send(body);
  const edit = (projectId, resourceId, body, as = manager) => request(app).patch(`/api/resource-planning/projects/${projectId}/resources/${resourceId}`).set('Authorization', as).send(body);

  // A member's name is fine with an email that isn't theirs: the email tells the two apart.
  const twin = await add('project-1', { email: 'Member.Personal@Mail.example', name: 'Member' });
  assert.deepEqual([twin.status, twin.body.created, twin.body.resource.email, twin.body.resource.name], [201, true, 'member.personal@mail.example', 'Member']);
  assert.equal((await add('project-1', { name: 'Member' })).status, 409);
  // A member's own email is refused: they sign in instead.
  assert.equal((await add('project-1', { email: 'member@example.com', name: 'Pia Placeholder' })).body.details?.code, 'email_has_login');

  // The same email on another project is the same profile, whatever the name says.
  const again = await add('project-2', { email: 'member.personal@mail.example', name: 'M. Personal' });
  assert.deepEqual([again.body.created, again.body.resource.id], [false, twin.body.resource.id]);
  // A profile under the name with no email takes the one given; with another email, it's someone else.
  const casey = await add('project-1', { name: 'Casey Contractor' });
  const caseyAgain = await add('project-2', { email: 'casey@vendor.example', name: 'Casey Contractor' });
  assert.deepEqual([caseyAgain.body.created, caseyAgain.body.resource.id, caseyAgain.body.resource.email], [false, casey.body.resource.id, 'casey@vendor.example']);
  const otherCasey = await add('project-1', { email: 'casey@elsewhere.example', name: 'Casey Contractor' });
  assert.deepEqual([otherCasey.body.created, otherCasey.body.resource.id === casey.body.resource.id], [true, false]);

  // Their profile changes through a project they are on, with the email checks; a login's doesn't.
  const resource = twin.body.resource;
  const renamed = await edit('project-1', resource.id, { email: 'pia@vendor.example', expectedVersion: resource.version, name: 'Pia Personal' });
  assert.deepEqual([renamed.status, renamed.body.resource.name, renamed.body.resource.email], [200, 'Pia Personal', 'pia@vendor.example']);
  assert.equal((await edit('project-1', resource.id, { expectedVersion: resource.version, name: 'Stale' })).status, 409);
  assert.equal((await edit('project-1', resource.id, { email: 'casey@vendor.example', expectedVersion: renamed.body.resource.version })).body.details?.code, 'email_in_use');
  assert.equal((await edit('project-1', resource.id, { expectedVersion: renamed.body.resource.version, userId: 'member' })).status, 400);
  assert.equal((await edit('project-1', resource.id, { expectedVersion: renamed.body.resource.version, name: 'Nope' }, authorization('member'))).status, 404);
  assert.equal((await edit('project-1', otherCasey.body.resource.id, { expectedVersion: 1, name: 'Off project' }, manager)).status, 200);
  assert.equal((await edit('project-2', otherCasey.body.resource.id, { expectedVersion: 2, name: 'Not here' })).status, 404);
  const linked = (await request(app).post('/api/resource-planning/resources').set('Authorization', manager).send({ name: 'Mem Ber', userId: 'member' })).body.value;
  await request(app).post('/api/resource-planning/allocations').set('Authorization', manager).send({ endDate: '2027-12-31', projectId: 'project-1', resourceId: linked.id, startDate: '2026-01-01' });
  assert.equal((await edit('project-1', linked.id, { expectedVersion: linked.version, name: 'Renamed' })).body.details?.code, 'resource_has_login');
});
