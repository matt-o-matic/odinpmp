const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function date(value) { return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`); }
function dateOnly(value) { return value.toISOString().slice(0, 10); }
function round(value, digits = 2) { const factor = 10 ** digits; return Math.round((Number(value) + Number.EPSILON) * factor) / factor; }
function startOfWeek(value) { const result = date(value); const day = result.getUTCDay(); result.setUTCDate(result.getUTCDate() - (day === 0 ? 6 : day - 1)); return result; }
function overlapDays(start, end, weekStart, weekdays = [1, 2, 3, 4, 5]) {
  const from = Math.max(date(start).getTime(), weekStart.getTime());
  const to = Math.min(date(end).getTime(), weekStart.getTime() + WEEK_MS - DAY_MS);
  if (to < from) return 0;
  let count = 0;
  const selected = new Set(weekdays);
  for (let current = from; current <= to; current += DAY_MS) { if (selected.has(new Date(current).getUTCDay())) count += 1; }
  return count;
}
function active(record) { return ['approved', 'active'].includes(record.status); }
function key(projectId, currency) { return `${projectId}:${currency}`; }
function normalize(value) { return String(value ?? '').trim().toLowerCase(); }
function tokens(value) { return normalize(value).split(/[^a-z0-9]+/).filter(Boolean); }

/** Percent complete over epics, stories and tasks, each weighted by its points (at least 1). */
export function completionPercentForItems(items, projectStatus = null) {
  if (!items.length) return ['completed', 'done', 'closed'].includes(normalize(projectStatus)) ? 100 : 0;
  const total = items.reduce((sum, item) => sum + Math.max(1, Number(item.points) || 1), 0);
  const complete = items.filter((item) => ['completed', 'done', 'closed'].includes(normalize(item.status))).reduce((sum, item) => sum + Math.max(1, Number(item.points) || 1), 0);
  return round(complete / total * 100);
}

function completionPercent(project) {
  const items = [];
  for (const epic of project?.epics ?? []) { items.push(epic); for (const story of epic.stories ?? []) { items.push(story); for (const task of story.tasks ?? []) items.push(task); } }
  return completionPercentForItems(items, project?.status);
}

export function scheduleProgress(project, asOfDate) {
  if (!project?.startDate || !project?.endDate) return 0;
  const start = date(project.startDate).getTime(); const end = date(project.endDate).getTime(); const asOf = date(asOfDate).getTime();
  if (end <= start) return asOf >= end ? 100 : 0;
  return round(Math.max(0, Math.min(1, (asOf - start) / (end - start))) * 100);
}

function resourceSkillScore(resource, allocation) {
  const required = new Set(tokens(allocation.role));
  if (!required.size) return 0;
  const roles = new Set((resource.roles ?? []).flatMap(tokens));
  const skills = new Map((resource.skills ?? []).flatMap((skill) => tokens(skill.name).map((token) => [token, Number(skill.level) || 1])));
  let score = 0;
  for (const token of required) { if (roles.has(token)) score += 5; if (skills.has(token)) score += skills.get(token); }
  return score;
}

function effectiveRate(resource, rates, asOfDate) {
  const rate = rates.filter((item) => item.resourceId === resource.id && item.status === 'approved' && item.effectiveStart <= asOfDate && (!item.effectiveEnd || item.effectiveEnd >= asOfDate))
    .sort((left, right) => right.effectiveStart.localeCompare(left.effectiveStart))[0];
  return rate ?? resource;
}

function exchangeRate(from, to, rates, asOfDate) {
  if (!to || from === to) return 1;
  const eligible = rates.filter((item) => item.status === 'approved' && item.effectiveDate <= asOfDate).sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate));
  const direct = eligible.find((item) => item.baseCurrency === from && item.quoteCurrency === to);
  if (direct) return Number(direct.rate);
  const inverse = eligible.find((item) => item.baseCurrency === to && item.quoteCurrency === from);
  return inverse ? 1 / Number(inverse.rate) : null;
}

function weeklyBounds(allocations, asOfDate, horizonWeeks) {
  const start = startOfWeek(asOfDate);
  const latest = allocations.reduce((result, item) => Math.max(result, date(item.endDate).getTime()), start.getTime());
  const weeks = Math.max(1, Math.min(horizonWeeks, Math.ceil((latest - start.getTime()) / WEEK_MS) + 1));
  return Array.from({ length: weeks }, (_, index) => new Date(start.getTime() + index * WEEK_MS));
}

export function weeklyAvailableHours(resource, entries = [], value = new Date().toISOString().slice(0, 10)) {
  const weekStart = startOfWeek(value);
  const relevant = entries.filter((entry) => entry.resourceId === resource.id && entry.status === 'approved');
  const overrides = relevant.filter((entry) => entry.entryType === 'working_override').map((entry) => ({ ...entry, days: overlapDays(entry.startDate, entry.endDate, weekStart, entry.weekdays) })).filter((entry) => entry.days > 0);
  let availableHours = overrides.length
    ? overrides.reduce((sum, entry) => sum + Number(entry.hoursPerDay) * entry.days, 0)
    : Number(resource.capacityHoursPerWeek) || 0;
  for (const entry of relevant.filter((item) => item.entryType !== 'working_override')) {
    availableHours -= Number(entry.hoursPerDay) * overlapDays(entry.startDate, entry.endDate, weekStart, entry.weekdays);
  }
  return Math.max(0, round(availableHours));
}

export function analyzeResourceFinance({
  asOfDate = new Date().toISOString().slice(0, 10),
  horizonWeeks = 26,
  projects = [],
  reportingCurrency = null,
  snapshot = {},
  visibleProjectIds = projects.map((project) => project.id),
} = {}) {
  const visible = new Set(visibleProjectIds);
  const resources = (snapshot.resources ?? []).filter((item) => item.status === 'active');
  const allocations = (snapshot.allocations ?? []).filter((item) => visible.has(item.projectId));
  const calendar = (snapshot.calendarEntries ?? []).filter((item) => item.status === 'approved');
  const weeks = weeklyBounds(allocations, asOfDate, Math.max(1, Math.min(104, Number(horizonWeeks) || 26)));
  const resourceById = new Map(resources.map((item) => [item.id, item]));

  const weekly = [];
  for (const weekStart of weeks) {
    const weekId = dateOnly(weekStart);
    for (const resource of resources) {
      const availableHours = weeklyAvailableHours(resource, calendar, weekId);
      const demand = allocations.filter((item) => item.resourceId === resource.id && active(item) && overlapDays(item.startDate, item.endDate, weekStart) > 0);
      const demandHours = round(demand.reduce((sum, item) => sum + Number(item.hoursPerWeek || 0), 0));
      weekly.push({ availableHours, demandHours, overallocatedHours: round(Math.max(0, demandHours - availableHours)), resourceId: resource.id, utilizationPercent: availableHours ? round(demandHours / availableHours * 100) : demandHours ? 100 : 0, weekStart: weekId });
    }
  }

  const skillMatches = allocations.filter(active).map((allocation) => {
    const assigned = resourceById.get(allocation.resourceId);
    const candidates = resources.filter((resource) => resource.id !== allocation.resourceId).map((resource) => ({ resourceId: resource.id, score: resourceSkillScore(resource, allocation) })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.resourceId.localeCompare(right.resourceId)).slice(0, 5);
    return { allocationId: allocation.id, assignedResourceId: allocation.resourceId, assignedScore: assigned ? resourceSkillScore(assigned, allocation) : 0, candidates, projectId: allocation.projectId, requiredRole: allocation.role };
  });

  const levelingRecommendations = weekly.filter((item) => item.overallocatedHours > 0).flatMap((overload) => {
    const sourceAllocations = allocations.filter((item) => item.resourceId === overload.resourceId && active(item) && overlapDays(item.startDate, item.endDate, date(overload.weekStart)) > 0);
    const recommendations = [];
    for (const allocation of sourceAllocations) {
      const alternatives = skillMatches.find((item) => item.allocationId === allocation.id)?.candidates ?? [];
      const candidate = alternatives.find((alternative) => {
        const capacity = weekly.find((item) => item.resourceId === alternative.resourceId && item.weekStart === overload.weekStart);
        return capacity && capacity.availableHours > capacity.demandHours;
      });
      if (candidate) recommendations.push({ allocationId: allocation.id, fromResourceId: overload.resourceId, hours: round(Math.min(overload.overallocatedHours, allocation.hoursPerWeek)), projectId: allocation.projectId, score: candidate.score, toResourceId: candidate.resourceId, weekStart: overload.weekStart });
    }
    return recommendations.slice(0, 3);
  });

  const approvedTime = (snapshot.timeEntries ?? []).filter((item) => item.status === 'approved' && visible.has(item.projectId));
  const forecasts = projects.filter((project) => visible.has(project.id)).map((project) => {
    const recentStart = date(asOfDate).getTime() - 56 * DAY_MS;
    const recentHours = approvedTime.filter((item) => item.projectId === project.id && date(item.workDate).getTime() >= recentStart && date(item.workDate).getTime() <= date(asOfDate).getTime()).reduce((sum, item) => sum + Number(item.hours), 0);
    const weeklyVelocityHours = round(recentHours / 8);
    const remainingAllocationHours = round(allocations.filter((item) => item.projectId === project.id && active(item) && item.endDate >= asOfDate).reduce((sum, item) => {
      const remainingWeeks = Math.max(0, Math.ceil((date(item.endDate).getTime() - Math.max(date(item.startDate).getTime(), date(asOfDate).getTime())) / WEEK_MS));
      return sum + remainingWeeks * Number(item.hoursPerWeek);
    }, 0));
    return { completionPercent: completionPercent(project), projectedWeeksRemaining: weeklyVelocityHours ? round(remainingAllocationHours / weeklyVelocityHours, 1) : null, projectId: project.id, remainingAllocationHours, scheduleProgressPercent: scheduleProgress(project, asOfDate), weeklyVelocityHours };
  });

  const rates = snapshot.resourceRates ?? [];
  const scenarios = ['baseline', 'optimistic', 'constrained'].map((scenario) => {
    const records = allocations.filter((item) => item.scenario === scenario && active(item));
    const currencies = new Map();
    for (const record of records) {
      const resource = resourceById.get(record.resourceId); if (!resource) continue;
      const rate = effectiveRate(resource, rates, asOfDate); const currency = rate.currency ?? resource.currency;
      const value = currencies.get(currency) ?? { currency, projectedWeeklyCost: 0, projectedWeeklyRevenue: 0 };
      value.projectedWeeklyCost += Number(record.hoursPerWeek) * Number(rate.costRate ?? 0);
      value.projectedWeeklyRevenue += Number(record.hoursPerWeek) * Number(rate.billRate ?? 0);
      currencies.set(currency, value);
    }
    const currencyBreakdown = [...currencies.values()].map((item) => ({ ...item, projectedWeeklyCost: round(item.projectedWeeklyCost), projectedWeeklyMargin: round(item.projectedWeeklyRevenue - item.projectedWeeklyCost), projectedWeeklyRevenue: round(item.projectedWeeklyRevenue) })).sort((left, right) => left.currency.localeCompare(right.currency));
    const single = currencyBreakdown.length === 1 ? currencyBreakdown[0] : null;
    const converted = reportingCurrency ? currencyBreakdown.map((item) => ({ item, rate: exchangeRate(item.currency, reportingCurrency, snapshot.exchangeRates ?? [], asOfDate) })) : [];
    const canConvert = converted.length > 0 && converted.every(({ rate }) => rate != null);
    const reportingTotals = canConvert ? {
      currency: reportingCurrency,
      projectedWeeklyCost: round(converted.reduce((sum, { item, rate }) => sum + item.projectedWeeklyCost * rate, 0)),
      projectedWeeklyRevenue: round(converted.reduce((sum, { item, rate }) => sum + item.projectedWeeklyRevenue * rate, 0)),
    } : null;
    if (reportingTotals) reportingTotals.projectedWeeklyMargin = round(reportingTotals.projectedWeeklyRevenue - reportingTotals.projectedWeeklyCost);
    return {
      allocatedHoursPerWeek: round(records.reduce((sum, item) => sum + Number(item.hoursPerWeek), 0)),
      currencyBreakdown,
      projectedWeeklyCost: single?.projectedWeeklyCost ?? null,
      projectedWeeklyMargin: single?.projectedWeeklyMargin ?? null,
      projectedWeeklyRevenue: single?.projectedWeeklyRevenue ?? null,
      reportingTotals,
      scenario,
    };
  });

  const finance = new Map();
  for (const entry of (snapshot.financialEntries ?? []).filter((item) => visible.has(item.projectId) && ['approved', 'posted'].includes(item.status))) {
    const record = finance.get(key(entry.projectId, entry.currency)) ?? { actualCost: 0, budget: 0, commitment: 0, currency: entry.currency, forecast: 0, funding: 0, projectId: entry.projectId, revenue: 0 };
    const field = ({ actual_cost: 'actualCost', budget: 'budget', commitment: 'commitment', forecast: 'forecast', funding: 'funding', revenue: 'revenue' })[entry.entryKind];
    if (field) record[field] += Number(entry.amount);
    finance.set(key(entry.projectId, entry.currency), record);
  }
  for (const expense of (snapshot.expenses ?? []).filter((item) => visible.has(item.projectId) && item.status === 'approved')) {
    const record = finance.get(key(expense.projectId, expense.currency)) ?? { actualCost: 0, budget: 0, commitment: 0, currency: expense.currency, forecast: 0, funding: 0, projectId: expense.projectId, revenue: 0 };
    record.actualCost += Number(expense.amount); finance.set(key(expense.projectId, expense.currency), record);
  }
  const projectById = new Map(projects.map((item) => [item.id, item]));
  const financialPerformance = [...finance.values()].map((record) => {
    const project = projectById.get(record.projectId);
    const complete = completionPercent(project) / 100; const scheduled = scheduleProgress(project, asOfDate) / 100;
    const earnedValue = record.budget * complete; const plannedValue = record.budget * scheduled;
    const projectedCost = record.forecast || record.actualCost + record.commitment;
    const activePolicies = (snapshot.financePolicies ?? []).filter((policy) => policy.status === 'active' && (!policy.projectId || policy.projectId === record.projectId));
    const policy = activePolicies.find((item) => item.projectId === record.projectId) ?? activePolicies.find((item) => !item.projectId) ?? { actualCostVariancePercent: 0, forecastVariancePercent: 0, minimumMarginPercent: 0 };
    const conversion = exchangeRate(record.currency, reportingCurrency, snapshot.exchangeRates ?? [], asOfDate);
    const reporting = reportingCurrency && conversion != null ? {
      actualCost: round(record.actualCost * conversion), budget: round(record.budget * conversion), currency: reportingCurrency,
      forecast: round(record.forecast * conversion), funding: round(record.funding * conversion), rate: round(conversion, 10), revenue: round(record.revenue * conversion),
    } : null;
    return {
      ...Object.fromEntries(Object.entries(record).map(([field, value]) => typeof value === 'number' ? [field, round(value)] : [field, value])),
      costPerformanceIndex: record.actualCost ? round(earnedValue / record.actualCost, 3) : null,
      earnedValue: round(earnedValue),
      estimateAtCompletion: record.budget && record.actualCost && earnedValue ? round(record.budget / (earnedValue / record.actualCost)) : round(projectedCost),
      margin: round(record.revenue - record.actualCost),
      marginPercent: record.revenue ? round((record.revenue - record.actualCost) / record.revenue * 100) : null,
      plannedValue: round(plannedValue),
      projectedCost: round(projectedCost),
      reporting,
      schedulePerformanceIndex: plannedValue ? round(earnedValue / plannedValue, 3) : null,
      thresholds: {
        budgetExceeded: record.budget > 0 && record.actualCost > record.budget * (1 + Number(policy.actualCostVariancePercent ?? 0) / 100),
        forecastExceeded: record.budget > 0 && projectedCost > record.budget * (1 + Number(policy.forecastVariancePercent ?? 0) / 100),
        fundingGap: record.funding > 0 && projectedCost > record.funding,
        negativeMargin: record.revenue > 0 && ((record.revenue - record.actualCost) / record.revenue * 100) < Number(policy.minimumMarginPercent ?? 0),
      },
      thresholdPolicy: { id: policy.id ?? null, name: policy.name ?? 'Default zero-tolerance policy' },
    };
  });

  return { asOfDate, financialPerformance, forecasts, levelingRecommendations, scenarios, skillMatches, weekly };
}
