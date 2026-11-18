function sumByCurrency(records) {
  return records.reduce((result, record) => {
    result[record.currency] = Math.round(((result[record.currency] ?? 0) + Number(record.amount ?? 0)) * 10_000) / 10_000;
    return result;
  }, {});
}
function valuesWithin(actual, ceilings) {
  return Object.entries(actual).every(([currency, value]) => value <= Number(ceilings[currency] ?? 0));
}

export function verifyResourceFinance({ now = new Date(), projectId, snapshot }) {
  const today = now.toISOString().slice(0, 10);
  const resources = new Map(snapshot.resources.map((record) => [record.id, record]));
  const allocations = snapshot.allocations.filter((record) => record.projectId === projectId && record.startDate <= today && record.endDate >= today && ['approved', 'active'].includes(record.status));
  const allocatedByResource = allocations.reduce((result, record) => ({ ...result, [record.resourceId]: (result[record.resourceId] ?? 0) + Number(record.hoursPerWeek ?? 0) }), {});
  const overallocatedResourceIds = Object.entries(allocatedByResource).filter(([resourceId, hours]) => hours > Number(resources.get(resourceId)?.capacityHoursPerWeek ?? 0)).map(([resourceId]) => resourceId);
  const financialEntries = snapshot.financialEntries.filter((record) => record.projectId === projectId && record.status !== 'void');
  const budgets = sumByCurrency(financialEntries.filter((record) => record.entryKind === 'budget' && ['approved', 'posted'].includes(record.status)));
  const actuals = sumByCurrency(financialEntries.filter((record) => ['actual_cost', 'capitalized_cost'].includes(record.entryKind) && ['approved', 'posted'].includes(record.status)));
  const approvedExpenses = sumByCurrency(snapshot.expenses.filter((record) => record.projectId === projectId && record.status === 'approved'));
  for (const [currency, amount] of Object.entries(approvedExpenses)) actuals[currency] = Math.round(((actuals[currency] ?? 0) + amount) * 10_000) / 10_000;
  const forecasts = sumByCurrency(financialEntries.filter((record) => record.entryKind === 'forecast' && ['approved', 'posted'].includes(record.status)));
  const submittedTimeEntryIds = snapshot.timeEntries.filter((record) => record.projectId === projectId && record.status === 'submitted').map((record) => record.id);
  const submittedExpenseIds = snapshot.expenses.filter((record) => record.projectId === projectId && record.status === 'submitted').map((record) => record.id);
  const checks = [
    { evidence: { overallocatedResourceIds }, id: 'resources.no_overallocation', passed: overallocatedResourceIds.length === 0 },
    { evidence: { submittedTimeEntryIds }, id: 'time.no_submitted_entries', passed: submittedTimeEntryIds.length === 0 },
    { evidence: { budgets }, id: 'finance.budget_exists', passed: Object.keys(budgets).length > 0 },
    { evidence: { actuals, budgets }, id: 'finance.actual_within_budget', passed: Object.keys(budgets).length > 0 && valuesWithin(actuals, budgets) },
    { evidence: { budgets, forecasts }, id: 'finance.forecast_within_budget', passed: Object.keys(budgets).length > 0 && valuesWithin(forecasts, budgets) },
    { evidence: { submittedExpenseIds }, id: 'expenses.no_submitted_entries', passed: submittedExpenseIds.length === 0 },
  ];
  return { checks, evaluatedAt: now.toISOString(), passed: checks.every((check) => check.passed), projectId };
}
