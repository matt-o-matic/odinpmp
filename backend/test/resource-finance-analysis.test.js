import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeResourceFinance } from '../src/modules/resource-finance/resource-finance-analysis.js';

test('resource finance analysis produces weekly demand, skill matches, leveling, forecasts, margin, and earned value', () => {
  const project = { endDate: '2026-12-31', epics: [{ points: 5, status: 'done', stories: [{ points: 5, status: 'active', tasks: [] }] }], id: 'project-1', startDate: '2026-01-01', status: 'active' };
  const analysis = analyzeResourceFinance({
    asOfDate: '2026-07-06', projects: [project], snapshot: {
      allocations: [
        { endDate: '2026-08-31', hoursPerWeek: 50, id: 'allocation-1', projectId: 'project-1', resourceId: 'resource-1', role: 'backend engineer', scenario: 'baseline', startDate: '2026-07-01', status: 'active' },
        { endDate: '2026-08-31', hoursPerWeek: 30, id: 'allocation-2', projectId: 'project-1', resourceId: 'resource-1', role: 'backend engineer', scenario: 'optimistic', startDate: '2026-07-01', status: 'active' },
      ],
      calendarEntries: [],
      expenses: [{ amount: 100, currency: 'USD', projectId: 'project-1', status: 'approved' }],
      financialEntries: [
        { amount: 1000, currency: 'USD', entryKind: 'budget', projectId: 'project-1', status: 'posted' },
        { amount: 400, currency: 'USD', entryKind: 'actual_cost', projectId: 'project-1', status: 'posted' },
        { amount: 900, currency: 'USD', entryKind: 'revenue', projectId: 'project-1', status: 'posted' },
      ],
      resources: [
        { billRate: 150, capacityHoursPerWeek: 40, costRate: 80, id: 'resource-1', roles: ['Backend Engineer'], skills: [], status: 'active' },
        { billRate: 140, capacityHoursPerWeek: 40, costRate: 70, id: 'resource-2', roles: [], skills: [{ level: 5, name: 'backend engineering' }], status: 'active' },
      ],
      timeEntries: [{ hours: 80, projectId: 'project-1', status: 'approved', workDate: '2026-06-20' }],
    },
  });
  assert.equal(analysis.weekly.find((item) => item.resourceId === 'resource-1').overallocatedHours, 40);
  assert.equal(analysis.skillMatches[0].candidates[0].resourceId, 'resource-2');
  assert.equal(analysis.levelingRecommendations[0].toResourceId, 'resource-2');
  assert.equal(analysis.forecasts[0].weeklyVelocityHours, 10);
  assert.equal(analysis.scenarios.find((item) => item.scenario === 'baseline').projectedWeeklyMargin, 3500);
  assert.equal(analysis.financialPerformance[0].actualCost, 500);
  assert.equal(analysis.financialPerformance[0].earnedValue, 500);
  assert.equal(analysis.financialPerformance[0].margin, 400);
});

test('resource finance analysis scopes every record to visible projects and honors leave', () => {
  const analysis = analyzeResourceFinance({
    asOfDate: '2026-07-06', projects: [{ id: 'visible' }], snapshot: {
      allocations: [{ endDate: '2026-07-10', hoursPerWeek: 20, id: 'a', projectId: 'visible', resourceId: 'r', role: '', scenario: 'baseline', startDate: '2026-07-06', status: 'active' }, { endDate: '2026-07-10', hoursPerWeek: 100, id: 'hidden', projectId: 'hidden', resourceId: 'r', role: '', scenario: 'baseline', startDate: '2026-07-06', status: 'active' }],
      calendarEntries: [{ endDate: '2026-07-07', entryType: 'leave', hoursPerDay: 8, resourceId: 'r', startDate: '2026-07-06', status: 'approved' }],
      resources: [{ capacityHoursPerWeek: 40, id: 'r', roles: [], skills: [], status: 'active' }],
    }, visibleProjectIds: ['visible'],
  });
  assert.equal(analysis.weekly[0].availableHours, 24);
  assert.equal(analysis.weekly[0].demandHours, 20);
  assert.equal(analysis.skillMatches.some((item) => item.allocationId === 'hidden'), false);
});

test('resource finance analysis applies recurring working weekdays and leave to the actual week', () => {
  const analysis = analyzeResourceFinance({
    asOfDate: '2026-07-06', projects: [{ id: 'project-1' }], snapshot: {
      allocations: [], resources: [{ capacityHoursPerWeek: 40, id: 'r', roles: [], skills: [], status: 'active' }],
      calendarEntries: [
        { endDate: '2026-12-31', entryType: 'working_override', hoursPerDay: 6, resourceId: 'r', startDate: '2026-01-01', status: 'approved', timezone: 'America/New_York', weekdays: [2, 4] },
        { endDate: '2026-07-09', entryType: 'leave', hoursPerDay: 2, resourceId: 'r', startDate: '2026-07-09', status: 'approved', timezone: 'America/New_York', weekdays: [4] },
      ],
    },
  });
  assert.equal(analysis.weekly[0].availableHours, 10);
});

test('resource finance analysis uses effective rates and converts without combining currencies directly', () => {
  const result = analyzeResourceFinance({
    asOfDate: '2026-07-11', projects: [{ epics: [], id: 'project-1' }], reportingCurrency: 'EUR',
    snapshot: {
      allocations: [{ endDate: '2026-08-01', hoursPerWeek: 10, id: 'a1', projectId: 'project-1', resourceId: 'r1', scenario: 'baseline', startDate: '2026-07-01', status: 'active' }],
      calendarEntries: [], exchangeRates: [{ baseCurrency: 'USD', effectiveDate: '2026-07-01', quoteCurrency: 'EUR', rate: 0.9, status: 'approved' }], expenses: [], financialEntries: [],
      resourceRates: [{ billRate: 200, costRate: 100, currency: 'USD', effectiveEnd: null, effectiveStart: '2026-07-01', resourceId: 'r1', status: 'approved' }],
      resources: [{ billRate: 150, capacityHoursPerWeek: 40, costRate: 80, currency: 'USD', id: 'r1', roles: [], skills: [], status: 'active' }], timeEntries: [],
    },
  });
  const baseline = result.scenarios.find((item) => item.scenario === 'baseline');
  assert.equal(baseline.projectedWeeklyMargin, 1000);
  assert.deepEqual(baseline.reportingTotals, { currency: 'EUR', projectedWeeklyCost: 900, projectedWeeklyMargin: 900, projectedWeeklyRevenue: 1800 });
});

test('resource finance analysis applies persisted project threshold policies', () => {
  const result = analyzeResourceFinance({ asOfDate: '2026-07-11', projects: [{ epics: [], id: 'project-1' }], snapshot: {
    allocations: [], expenses: [], resources: [],
    financePolicies: [{ actualCostVariancePercent: 10, forecastVariancePercent: 20, id: 'policy-1', minimumMarginPercent: 25, name: 'Steering controls', projectId: 'project-1', status: 'active' }],
    financialEntries: [
      { amount: 100, currency: 'USD', entryKind: 'budget', projectId: 'project-1', status: 'posted' },
      { amount: 108, currency: 'USD', entryKind: 'actual_cost', projectId: 'project-1', status: 'posted' },
      { amount: 119, currency: 'USD', entryKind: 'forecast', projectId: 'project-1', status: 'posted' },
      { amount: 140, currency: 'USD', entryKind: 'revenue', projectId: 'project-1', status: 'posted' },
    ],
  } });
  assert.deepEqual(result.financialPerformance[0].thresholds, { budgetExceeded: false, forecastExceeded: false, fundingGap: false, negativeMargin: true });
  assert.deepEqual(result.financialPerformance[0].thresholdPolicy, { id: 'policy-1', name: 'Steering controls' });
});
