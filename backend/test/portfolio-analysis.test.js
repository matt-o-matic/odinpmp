import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzePortfolioPlans } from '../src/modules/portfolio/portfolio-analysis.js';

test('portfolio optimizer respects visible projects, hierarchy, funding, resource, and currency constraints', () => {
  const result = analyzePortfolioPlans({
    nodes: [{ id: 'portfolio', parentId: null, scoring: { costWeight: 0.2, riskWeight: 0.2, strategicWeight: 0.6 } }, { id: 'program', parentId: 'portfolio' }],
    plans: [{ fundingCurrency: 'USD', fundingLimit: 100, id: 'plan', portfolioNodeId: 'portfolio', resourceHoursLimit: 80, scenario: 'baseline' }],
    visibleProjectIds: ['p1', 'p2', 'p3'],
    alignments: [
      { benefitUnit: 'USD', benefitValue: 200, costScore: 10, demandStatus: 'candidate', fundingCurrency: 'USD', id: 'a1', portfolioNodeId: 'program', projectId: 'p1', requestedFunding: 60, requestedHours: 40, riskScore: 10, scenario: 'baseline', strategicScore: 90 },
      { benefitUnit: 'USD', benefitValue: 100, costScore: 20, demandStatus: 'candidate', fundingCurrency: 'USD', id: 'a2', portfolioNodeId: 'program', projectId: 'p2', requestedFunding: 50, requestedHours: 20, riskScore: 20, scenario: 'baseline', strategicScore: 70 },
      { benefitUnit: 'USD', benefitValue: 500, costScore: 5, demandStatus: 'candidate', fundingCurrency: 'EUR', id: 'a3', portfolioNodeId: 'program', projectId: 'p3', requestedFunding: 10, requestedHours: 5, riskScore: 5, scenario: 'baseline', strategicScore: 95 },
      { benefitUnit: 'USD', benefitValue: 999, costScore: 0, demandStatus: 'candidate', fundingCurrency: 'USD', id: 'hidden', portfolioNodeId: 'program', projectId: 'p4', requestedFunding: 1, requestedHours: 1, riskScore: 0, scenario: 'baseline', strategicScore: 100 },
    ],
  });
  assert.deepEqual(result.comparisons[0].selected.map((item) => item.alignmentId), ['a1']);
  assert.deepEqual(result.comparisons[0].deferred, [{ alignmentId: 'a3', reason: 'currency_mismatch' }, { alignmentId: 'a2', reason: 'funding_limit' }]);
  assert.deepEqual(result.comparisons[0].benefitByUnit, { USD: 200 });
});
