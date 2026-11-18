function round(value, digits = 2) { const factor = 10 ** digits; return Math.round((Number(value) + Number.EPSILON) * factor) / factor; }

function descendants(nodeId, nodes) {
  const result = new Set([nodeId]); let changed = true;
  while (changed) { changed = false; for (const node of nodes) if (node.parentId && result.has(node.parentId) && !result.has(node.id)) { result.add(node.id); changed = true; } }
  return result;
}

function score(alignment, scoring) {
  const weights = [Number(scoring?.strategicWeight ?? 0.6), Number(scoring?.riskWeight ?? 0.2), Number(scoring?.costWeight ?? 0.2)];
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  return round(((alignment.strategicScore * weights[0]) + ((100 - alignment.riskScore) * weights[1]) + ((100 - alignment.costScore) * weights[2])) / total);
}

export function analyzePortfolioPlans({ alignments = [], nodes = [], plans = [], visibleProjectIds = [] } = {}) {
  const visible = new Set(visibleProjectIds); const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const comparisons = plans.map((plan) => {
    const node = nodeById.get(plan.portfolioNodeId); const includedNodes = descendants(plan.portfolioNodeId, nodes);
    const candidates = alignments.filter((item) => visible.has(item.projectId) && includedNodes.has(item.portfolioNodeId) && item.scenario === plan.scenario && item.demandStatus !== 'rejected')
      .map((item) => ({ ...item, priorityScore: score(item, node?.scoring) }))
      .sort((left, right) => right.priorityScore - left.priorityScore || (right.benefitValue / Math.max(1, right.requestedFunding)) - (left.benefitValue / Math.max(1, left.requestedFunding)) || left.id.localeCompare(right.id));
    const selected = []; const deferred = []; let funding = 0; let hours = 0;
    for (const candidate of candidates) {
      const nextFunding = funding + Number(candidate.requestedFunding ?? 0); const nextHours = hours + Number(candidate.requestedHours ?? 0);
      const currencyMismatch = candidate.requestedFunding > 0 && candidate.fundingCurrency !== plan.fundingCurrency;
      if (currencyMismatch || nextFunding > plan.fundingLimit || nextHours > plan.resourceHoursLimit) deferred.push({ alignmentId: candidate.id, reason: currencyMismatch ? 'currency_mismatch' : nextFunding > plan.fundingLimit ? 'funding_limit' : 'resource_limit' });
      else { funding = nextFunding; hours = nextHours; selected.push({ alignmentId: candidate.id, priorityScore: candidate.priorityScore, projectId: candidate.projectId }); }
    }
    const benefitByUnit = {};
    for (const item of candidates.filter((candidate) => selected.some((selectedItem) => selectedItem.alignmentId === candidate.id))) benefitByUnit[item.benefitUnit || 'unspecified'] = round((benefitByUnit[item.benefitUnit || 'unspecified'] ?? 0) + Number(item.benefitValue ?? 0));
    return {
      benefitByUnit, deferred, fundingCurrency: plan.fundingCurrency, fundingLimit: plan.fundingLimit,
      planId: plan.id, resourceHoursLimit: plan.resourceHoursLimit, scenario: plan.scenario, selected,
      totalFunding: round(funding), totalResourceHours: round(hours), utilization: {
        fundingPercent: plan.fundingLimit ? round(funding / plan.fundingLimit * 100) : funding ? 100 : 0,
        resourcePercent: plan.resourceHoursLimit ? round(hours / plan.resourceHoursLimit * 100) : hours ? 100 : 0,
      },
    };
  });
  return { comparisons };
}
