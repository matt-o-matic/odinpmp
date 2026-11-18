import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL resource-finance repository persists capacity and immutable financial ledgers', { skip: !databaseUrl, timeout: 15_000 }, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await applyMysqlMigrations(pool, [
      '0015_resource_finance',
      '0028_resource_finance_advanced',
      '0033_resource_calendar_recurrence',
      '0034_resource_finance_controls',
      '0080_resource_email',
      '0087_resource_links',
    ]);
    const repository = createMysqlResourceFinanceRepository({ pool });
    const resourcePool = await repository.createPool({ input: { description: '', managerId: null, name: 'Engineering', status: 'active' }, tenantId: 'tenant-resource' });
    const resource = await repository.createResource({ input: {
      billRate: 220, capacityHoursPerWeek: 40, costRate: 140, currency: 'USD', location: 'Remote', name: 'Alex',
      poolId: resourcePool.id, roles: ['Engineer'], skills: [{ level: 5, name: 'Delivery' }], status: 'active', userId: 'user-alex',
    }, tenantId: 'tenant-resource' });
    const targetResource = await repository.createResource({ input: {
      billRate: 220, capacityHoursPerWeek: 40, costRate: 140, currency: 'USD', location: 'Remote', name: 'Blair',
      poolId: resourcePool.id, roles: ['Engineer'], skills: [{ level: 5, name: 'Delivery' }], status: 'active', userId: 'user-blair',
    }, tenantId: 'tenant-resource' });
    await repository.createCalendarEntry({ input: { endDate: '2026-07-15', entryType: 'leave', hoursPerDay: 8, note: '', resourceId: resource.id, startDate: '2026-07-14', status: 'approved' }, tenantId: 'tenant-resource' });
    const allocation = await repository.createAllocation({ input: { allocationPercent: 100, endDate: '2026-12-31', hoursPerWeek: 40, projectId: 'project-1', resourceId: resource.id, role: 'Engineer', scenario: 'baseline', startDate: '2026-01-01', status: 'active' }, tenantId: 'tenant-resource' });
    const period = await repository.createTimesheetPeriod({ input: { approvalDueDate: '2026-07-15', endDate: '2026-07-12', name: 'July week two', startDate: '2026-07-06', status: 'open' }, tenantId: 'tenant-resource' });
    await repository.createAccountingPeriod({ input: { endDate: '2026-07-31', fiscalYear: 2026, name: 'July 2026', periodNumber: 7, startDate: '2026-07-01', status: 'open' }, tenantId: 'tenant-resource' });
    await repository.createFinancePolicy({ input: { actualCostVariancePercent: 5, expenseApprovalAmount: 1000, forecastVariancePercent: 10, minimumMarginPercent: 15, name: 'Delivery controls', projectId: 'project-1', status: 'active' }, tenantId: 'tenant-resource' });
    await repository.createTimeEntry({ input: { billable: true, hours: 8, note: '', periodId: period.id, projectId: 'project-1', resourceId: resource.id, status: 'approved', workDate: '2026-07-10', workItemId: null }, tenantId: 'tenant-resource' });
    await repository.createResourceRate({ input: { billRate: 230, costRate: 145, currency: 'USD', effectiveEnd: null, effectiveStart: '2026-07-01', resourceId: resource.id, status: 'approved' }, tenantId: 'tenant-resource' });
    const expense = await repository.createExpense({ input: { amount: 125, category: 'Travel', currency: 'USD', expenseDate: '2026-07-10', note: '', projectId: 'project-1', receiptReference: '', resourceId: resource.id, status: 'approved' }, tenantId: 'tenant-resource' });
    await repository.createExpenseReceipt({ input: { contentType: 'application/pdf', expenseId: expense.id, fileName: 'receipt.pdf', sha256: 'b'.repeat(64), sizeBytes: 2048, status: 'active', storageKey: 'tenant-resource/receipt.pdf' }, tenantId: 'tenant-resource' });
    await repository.createExchangeRate({ input: { baseCurrency: 'USD', effectiveDate: '2026-07-01', quoteCurrency: 'EUR', rate: 0.91, source: 'Treasury', status: 'approved' }, tenantId: 'tenant-resource' });
    const financial = await repository.createFinancialEntry({ input: { amount: 250000, category: 'Delivery', currency: 'USD', effectiveDate: '2026-07-01', entryKind: 'budget', note: '', projectId: 'project-1', sourceId: null, sourceType: 'manual', status: 'draft' }, tenantId: 'tenant-resource' });
    const posted = await repository.updateFinancialEntry({ financialEntryId: financial.id, input: { expectedVersion: 1, status: 'posted' }, tenantId: 'tenant-resource' });
    assert.equal(posted.version, 2);
    await assert.rejects(repository.updateFinancialEntry({ financialEntryId: financial.id, input: { amount: 300000, expectedVersion: 2 }, tenantId: 'tenant-resource' }), /immutable/i);
    const updatedAllocation = await repository.updateAllocation({ allocationId: allocation.id, input: { expectedVersion: 1, hoursPerWeek: 32 }, tenantId: 'tenant-resource' });
    assert.equal(updatedAllocation.version, 2);
    await assert.rejects(repository.updateAllocation({ allocationId: allocation.id, input: { expectedVersion: 1, hoursPerWeek: 20 }, tenantId: 'tenant-resource' }), (error) => error.statusCode === 409 && error.details.code === 'resource_finance_version_conflict');
    const leveled = await repository.applyLevelingRecommendation({ allocationId: allocation.id, expectedVersion: 2, hours: 12, targetResourceId: targetResource.id, tenantId: 'tenant-resource' });
    assert.equal(leveled.sourceAllocation.hoursPerWeek, 20);
    assert.equal(leveled.targetAllocation.hoursPerWeek, 12);
    assert.equal(leveled.targetAllocation.resourceId, targetResource.id);
    await assert.rejects(repository.applyLevelingRecommendation({ allocationId: allocation.id, expectedVersion: 2, hours: 1, targetResourceId: targetResource.id, tenantId: 'tenant-resource' }), (error) => error.statusCode === 409);
    const snapshot = await repository.listSnapshot({ tenantId: 'tenant-resource' });
    assert.equal(snapshot.resources[0].skills[0].name, 'Delivery');
    assert.equal(snapshot.calendarEntries.length, 1);
    assert.deepEqual(snapshot.calendarEntries[0].weekdays, [1, 2, 3, 4, 5]);
    assert.equal(snapshot.calendarEntries[0].timezone, 'UTC');
    assert.deepEqual(snapshot.allocations.map((item) => item.hoursPerWeek).sort((left, right) => left - right), [12, 20]);
    assert.equal(snapshot.financialEntries[0].status, 'posted');
    assert.equal(snapshot.resourceRates[0].billRate, 230);
    assert.equal(snapshot.timesheetPeriods[0].name, 'July week two');
    assert.equal(snapshot.timeEntries[0].periodId, period.id);
    assert.equal(snapshot.expenseReceipts[0].sha256, 'b'.repeat(64));
    assert.equal(snapshot.exchangeRates[0].rate, 0.91);
    assert.equal(snapshot.accountingPeriods[0].periodNumber, 7);
    assert.equal(snapshot.financePolicies[0].minimumMarginPercent, 15);
  } finally { await pool.end(); }
});
