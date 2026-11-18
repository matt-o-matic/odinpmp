import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryPortfolioRepository } from '../src/modules/portfolio/portfolio.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'manager@example.com', id: 'manager', memberships: [{ role: 'manager', tenantId: 'tenant-1' }], name: 'Manager', password: 'Secret123!' },
    { authMethod: 'basic', email: 'viewer@example.com', id: 'viewer', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Viewer', password: 'Secret123!' },
    { authMethod: 'basic', email: 'outsider@example.com', id: 'outsider', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Outsider', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'viewer', role: 'viewer' }], 'project-2': [] },
    projects: [
      { epics: [], id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-1' },
      { epics: [], id: 'project-2', name: 'ERP', status: 'At Risk', tenantId: 'tenant-1' },
    ],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'portfolio-test-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository(); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const portfolioRepository = createInMemoryPortfolioRepository();
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0, portfolioRepository, projectRepository, sessionsRepository, tokenService });
  return { app, authorization: (id) => `Bearer ${tokens.get(id)}` };
}

test('portfolio API manages hierarchy, OKRs, demand scenarios, benefits, scoring, and version conflicts', async () => {
  const { app, authorization } = await fixture(); const auth = authorization('manager');
  const portfolio = await request(app).post('/api/portfolio/nodes').set('Authorization', auth).send({ kind: 'portfolio', name: 'Growth portfolio', scoring: { costWeight: 0.2, riskWeight: 0.2, strategicWeight: 0.6 }, sponsorId: 'sponsor-1' });
  assert.equal(portfolio.status, 201);
  const program = await request(app).post('/api/portfolio/nodes').set('Authorization', auth).send({ kind: 'program', name: 'Launch program', parentId: portfolio.body.value.id });
  assert.equal(program.status, 201);
  const objective = await request(app).post('/api/portfolio/objectives').set('Authorization', auth).send({ currentValue: 40, targetValue: 100, title: 'Increase activation', unit: 'percent' });
  assert.equal(objective.status, 201);
  assert.equal((await request(app).post('/api/portfolio/objectives').set('Authorization', auth).send({ kind: 'key_result', parentId: objective.body.value.id, targetValue: 90, title: 'Reach onboarding completion', unit: 'percent' })).status, 201);
  const firstAlignment = await request(app).post('/api/portfolio/alignments').set('Authorization', auth).send({ benefitUnit: 'USD', benefitValue: 500000, demandStatus: 'active', fundingCurrency: 'USD', objectiveId: objective.body.value.id, portfolioNodeId: program.body.value.id, projectId: 'project-1', requestedFunding: 200000, requestedHours: 4000, riskScore: 20, scenario: 'baseline', strategicScore: 90 });
  assert.equal(firstAlignment.status, 201);
  assert.equal((await request(app).post('/api/portfolio/alignments').set('Authorization', auth).send({ benefitUnit: 'USD', benefitValue: 250000, demandStatus: 'candidate', portfolioNodeId: portfolio.body.value.id, projectId: 'project-2', riskScore: 80, scenario: 'constrained', strategicScore: 50 })).status, 201);

  const workspace = await request(app).get('/api/portfolio?sort=score&limit=10').set('Authorization', auth);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.total, 2);
  const root = workspace.body.nodes.find((node) => node.id === portfolio.body.value.id);
  assert.equal(root.rollup.projectCount, 2);
  assert.equal(root.rollup.benefits.USD, 750000);
  assert.deepEqual(root.rollup.projectStatuses, { 'At Risk': 1, 'In Progress': 1 });
  assert.equal(workspace.body.objectives.find((item) => item.id === objective.body.value.id).progressPercent, 40);
  const plan = await request(app).post('/api/portfolio/plans').set('Authorization', auth).send({ fundingCurrency: 'USD', fundingLimit: 250000, name: 'Funded baseline', portfolioNodeId: portfolio.body.value.id, resourceHoursLimit: 5000, scenario: 'baseline', status: 'submitted' });
  assert.equal(plan.status, 201);
  const optimized = await request(app).get('/api/portfolio').set('Authorization', auth);
  assert.deepEqual(optimized.body.analysis.comparisons[0].selected.map((item) => item.alignmentId), [firstAlignment.body.value.id]);
  assert.equal((await request(app).patch(`/api/portfolio/plans/${plan.body.value.id}`).set('Authorization', auth).send({ expectedVersion: 1, status: 'approved' })).status, 403);
  const approved = await request(app).patch(`/api/portfolio/plans/${plan.body.value.id}`).set('Authorization', authorization('admin')).send({ decisionNote: 'Approved by steering committee.', expectedVersion: 1, status: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.value.decidedBy, 'admin');
  assert.equal((await request(app).patch(`/api/portfolio/plans/${plan.body.value.id}`).set('Authorization', authorization('admin')).send({ expectedVersion: 2, fundingLimit: 300000 })).status, 409);
  const baseline = await request(app).post('/api/portfolio/baselines').set('Authorization', auth).send({ name: 'Steering approval', portfolioNodeId: portfolio.body.value.id, scenario: 'baseline' });
  assert.equal(baseline.status, 201);
  assert.match(baseline.body.value.snapshot.contentHash, /^[a-f0-9]{64}$/);

  const updated = await request(app).patch(`/api/portfolio/alignments/${firstAlignment.body.value.id}`).set('Authorization', auth).send({ benefitValue: 600000, expectedVersion: 1, scenario: 'optimistic' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.value.version, 2);
  assert.equal((await request(app).patch(`/api/portfolio/alignments/${firstAlignment.body.value.id}`).set('Authorization', auth).send({ expectedVersion: 1, riskScore: 10 })).status, 409);
  assert.equal((await request(app).patch(`/api/portfolio/nodes/${program.body.value.id}`).set('Authorization', auth).send({ expectedVersion: 1, parentId: program.body.value.id })).status, 409);
  assert.equal((await request(app).delete(`/api/portfolio/nodes/${portfolio.body.value.id}`).set('Authorization', auth).send({ expectedVersion: 1 })).status, 409);
});

test('portfolio reads filter inaccessible projects and writes require manager authority', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager');
  const node = await request(app).post('/api/portfolio/nodes').set('Authorization', manager).send({ kind: 'portfolio', name: 'Enterprise portfolio' });
  await request(app).post('/api/portfolio/alignments').set('Authorization', manager).send({ portfolioNodeId: node.body.value.id, projectId: 'project-1', strategicScore: 90 });
  await request(app).post('/api/portfolio/alignments').set('Authorization', manager).send({ portfolioNodeId: node.body.value.id, projectId: 'project-2', strategicScore: 50 });
  await request(app).post('/api/portfolio/baselines').set('Authorization', manager).send({ name: 'Visibility baseline', portfolioNodeId: node.body.value.id, scenario: 'baseline' });
  const viewer = await request(app).get('/api/portfolio?query=enterprise').set('Authorization', authorization('viewer'));
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.canManage, false);
  assert.equal(viewer.body.alignments.length, 1);
  assert.equal(viewer.body.nodes[0].rollup.projectCount, 1);
  assert.equal(viewer.body.baselines[0].snapshot.alignments.length, 1);
  assert.equal((await request(app).post('/api/portfolio/nodes').set('Authorization', authorization('viewer')).send({ kind: 'portfolio', name: 'No write' })).status, 404);
  const outsider = await request(app).get('/api/portfolio').set('Authorization', authorization('outsider'));
  assert.equal(outsider.body.alignments.length, 0);
  assert.equal(outsider.body.nodes[0].rollup.projectCount, 0);
});
