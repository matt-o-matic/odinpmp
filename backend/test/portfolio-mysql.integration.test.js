import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlPortfolioRepository } from '../src/modules/portfolio/portfolio.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL portfolio repository persists hierarchy, strategy, alignments, and optimistic versions', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await applyMysqlMigrations(pool, ['0014_portfolio_strategy', '0029_portfolio_scenario_planning']);
    const repository = createMysqlPortfolioRepository({ pool });
    const portfolio = await repository.createNode({ input: { description: '', governanceStage: 'funded', kind: 'portfolio', name: 'Growth', ownerId: null, parentId: null, scoring: { costWeight: 0.2, riskWeight: 0.2, strategicWeight: 0.6 }, sponsorId: 'sponsor-1', status: 'active' }, tenantId: 'tenant-portfolio' });
    const program = await repository.createNode({ input: { description: '', governanceStage: 'delivery', kind: 'program', name: 'Launch', ownerId: 'owner-1', parentId: portfolio.id, scoring: { costWeight: 0.2, riskWeight: 0.2, strategicWeight: 0.6 }, sponsorId: null, status: 'active' }, tenantId: 'tenant-portfolio' });
    const objective = await repository.createObjective({ input: { currentValue: 25, description: '', kind: 'objective', parentId: null, status: 'active', targetValue: 100, title: 'Activation', unit: 'percent', weight: 1 }, tenantId: 'tenant-portfolio' });
    const alignment = await repository.createAlignment({ input: { benefitUnit: 'USD', benefitValue: 500000, costScore: 30, demandStatus: 'active', objectiveId: objective.id, portfolioNodeId: program.id, projectId: 'project-1', riskScore: 20, scenario: 'baseline', strategicScore: 90 }, tenantId: 'tenant-portfolio' });
    const plan = await repository.createPlan({ input: { decidedAt: null, decidedBy: null, decisionNote: '', fundingCurrency: 'USD', fundingLimit: 250000, name: 'Baseline plan', portfolioNodeId: portfolio.id, resourceHoursLimit: 5000, scenario: 'baseline', status: 'submitted' }, tenantId: 'tenant-portfolio' });
    await repository.createBaseline({ input: { capturedAt: '2026-07-11T12:00:00.000Z', capturedBy: 'manager', name: 'Approval baseline', portfolioNodeId: portfolio.id, scenario: 'baseline', snapshot: { alignments: [{ id: alignment.id }] } }, tenantId: 'tenant-portfolio' });
    const snapshot = await repository.listSnapshot({ tenantId: 'tenant-portfolio' });
    assert.equal(snapshot.alignments.length, 1);
    assert.equal(snapshot.plans[0].name, 'Baseline plan');
    assert.equal(snapshot.baselines[0].snapshot.alignments[0].id, alignment.id);
    assert.equal((await repository.updatePlan({ input: { decidedAt: '2026-07-11T13:00:00.000Z', decidedBy: 'admin', decisionNote: 'Approved', expectedVersion: 1, status: 'approved' }, planId: plan.id, tenantId: 'tenant-portfolio' })).version, 2);
    const updated = await repository.updateAlignment({ alignmentId: alignment.id, input: { benefitValue: 600000, expectedVersion: 1 }, tenantId: 'tenant-portfolio' });
    assert.equal(updated.version, 2);
    await assert.rejects(repository.updateAlignment({ alignmentId: alignment.id, input: { expectedVersion: 1, riskScore: 10 }, tenantId: 'tenant-portfolio' }), (error) => error.statusCode === 409 && error.details.code === 'portfolio_version_conflict');
    await assert.rejects(repository.deleteNode({ expectedVersion: 1, nodeId: portfolio.id, tenantId: 'tenant-portfolio' }), (error) => error.statusCode === 409);
  } finally { await pool.end(); }
});
