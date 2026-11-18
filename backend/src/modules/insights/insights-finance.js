// Earned value for a project, for managers and admins only. The KPIs come from the
// resource-finance analysis the Resources screen uses; the weekly series reapplies its
// formulas on past days: planned value is the budget times schedule progress, earned value
// the budget times percent complete (from item history), actual cost the approved spend so far.

import { analyzeResourceFinance, completionPercentForItems, scheduleProgress } from '../resource-finance/resource-finance-analysis.js';
import { emptyCard, readyCard } from './insights-cards.js';
import { WORK_ITEM_TYPES, dateOnly, daysBetween, replayAt, sampleDates } from './insights-history.js';

const CHART_SAMPLE_TARGET = 13;

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function actualCostThrough(snapshot, { currency, date, projectId }) {
  const entries = (snapshot.financialEntries ?? [])
    .filter((entry) => entry.projectId === projectId && entry.currency === currency && entry.entryKind === 'actual_cost' && ['approved', 'posted'].includes(entry.status) && dateOnly(entry.effectiveDate) <= date)
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  const expenses = (snapshot.expenses ?? [])
    .filter((expense) => expense.projectId === projectId && expense.currency === currency && expense.status === 'approved' && dateOnly(expense.expenseDate) <= date)
    .reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);
  return entries + expenses;
}

export function buildEarnedValueCard(ctx) {
  if (!ctx.finance.authorized) return { data: null, message: 'Cost and earned value are visible to managers and admins.', status: 'forbidden' };
  if (ctx.finance.snapshot instanceof Error) throw ctx.finance.snapshot;
  const snapshot = ctx.finance.snapshot ?? {};
  const projectId = ctx.project.id;
  const analysis = analyzeResourceFinance({ asOfDate: ctx.today, projects: [ctx.project], snapshot, visibleProjectIds: [projectId] });
  const records = analysis.financialPerformance.filter((record) => record.projectId === projectId && record.budget > 0).sort((left, right) => right.budget - left.budget);
  const record = records[0];
  if (!record) return emptyCard('No approved budget for this project yet. Earned value appears once a budget is recorded.', { label: 'Open Finance', target: 'finance' });

  const start = dateOnly(ctx.project.startDate) && dateOnly(ctx.project.startDate) > ctx.windowStart ? dateOnly(ctx.project.startDate) : ctx.windowStart;
  const from = start > ctx.today ? ctx.today : start;
  const dates = sampleDates(from, ctx.today, Math.max(1, Math.ceil(daysBetween(from, ctx.today) / CHART_SAMPLE_TARGET)));
  const percents = replayAt({
    dates,
    events: ctx.events,
    items: ctx.items,
    reduce: (states) => completionPercentForItems(states.filter((state) => state.exists && WORK_ITEM_TYPES.has(state.itemType)), ctx.project.status),
  });
  const series = dates.map((date, index) => ({
    ac: round(actualCostThrough(snapshot, { currency: record.currency, date, projectId })),
    date,
    // Before the first recorded change, progress on that day is unknown.
    ev: date >= ctx.coverageStart || date === ctx.today ? round(record.budget * percents[index] / 100) : null,
    pv: round(record.budget * scheduleProgress(ctx.project, date) / 100),
  }));
  return readyCard({
    budget: record.budget,
    currency: record.currency,
    kpis: {
      ac: record.actualCost,
      cpi: record.costPerformanceIndex,
      eac: record.estimateAtCompletion,
      ev: record.earnedValue,
      pv: record.plannedValue,
      spi: record.schedulePerformanceIndex,
    },
    otherCurrencies: records.slice(1).map((entry) => entry.currency),
    series,
  });
}
