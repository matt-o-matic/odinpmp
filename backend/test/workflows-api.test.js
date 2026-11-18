import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'manager@example.com', id: 'manager', memberships: [{ role: 'manager', tenantId: 'tenant-1' }], name: 'Manager', password: 'Secret123!' },
    { authMethod: 'basic', email: 'contributor@example.com', id: 'contributor', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Contributor', password: 'Secret123!' },
    { authMethod: 'basic', email: 'outsider@example.com', id: 'outsider', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Outsider', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'contributor', role: 'contributor' }], 'project-2': [] },
    projects: [{
      description: 'Launch safely', endDate: null, epics: [{ description: '', id: 'epic-1', name: 'Delivery', status: 'Backlog', stories: [] }],
      id: 'project-1', name: 'Launch', startDate: null, status: 'In Progress', tenantId: 'tenant-1', updatedAt: '2026-07-11T00:00:00.000Z',
    }, { epics: [], id: 'project-2', name: 'Hidden', status: 'In Progress', tenantId: 'tenant-1' }],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'workflow-test-secret-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository(); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const workflowRepository = createInMemoryWorkflowRepository();
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0, projectRepository, sessionsRepository, tokenService, workflowRepository });
  return { app, authorization: (id) => `Bearer ${tokens.get(id)}` };
}

const projectWorkflow = {
  description: 'Controlled project lifecycle', itemTypes: ['project'], name: 'Project delivery',
  states: [
    { category: 'active', initial: true, key: 'In Progress', label: 'In progress' },
    { category: 'done', key: 'Completed', label: 'Completed', requiredFields: ['description'], terminal: true },
  ],
  transitions: [{ allowedRoles: ['manager', 'admin'], approvalRequired: true, approverRoles: ['admin'], fromState: 'In Progress', key: 'complete', toState: 'Completed' }],
};

test('workflow API enforces approved transitions and records immutable history', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager'); const admin = authorization('admin');
  const definition = await request(app).post('/api/workflows/definitions').set('Authorization', manager).send(projectWorkflow);
  assert.equal(definition.status, 201);
  assert.equal((await request(app).post('/api/workflows/bindings').set('Authorization', manager).send({ itemType: 'project', projectId: 'project-1', workflowId: definition.body.value.id })).status, 201);

  const project = (await request(app).get('/api/projects/project-1').set('Authorization', manager)).body.project;
  const update = { description: project.description, endDate: project.endDate, expectedUpdatedAt: project.updatedAt, name: project.name, startDate: project.startDate, status: 'Completed' };
  const denied = await request(app).put('/api/projects/project-1').set('Authorization', manager).send(update);
  assert.equal(denied.status, 409);
  assert.equal(denied.body.details.code, 'workflow_approval_required');

  const approval = await request(app).post('/api/workflows/approvals').set('Authorization', manager).send({
    fromState: 'In Progress', itemId: 'project-1', itemType: 'project', note: 'Ready for closure', projectId: 'project-1', toState: 'Completed', transitionKey: 'complete',
  });
  assert.equal(approval.status, 201);
  assert.equal((await request(app).post(`/api/workflows/approvals/${approval.body.value.id}/decision`).set('Authorization', manager).send({ expectedVersion: 1, status: 'approved' })).status, 403);
  assert.equal((await request(app).post(`/api/workflows/approvals/${approval.body.value.id}/decision`).set('Authorization', admin).send({ decisionNote: 'Accepted', expectedVersion: 1, status: 'approved' })).status, 200);

  const completed = await request(app).put('/api/projects/project-1').set('Authorization', manager).send(update);
  assert.equal(completed.status, 200);
  const workspace = await request(app).get('/api/workflows?projectId=project-1').set('Authorization', manager);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.histories.length, 1);
  assert.equal(workspace.body.histories[0].transitionKey, 'complete');
  assert.equal(workspace.body.approvals[0].status, 'consumed');
  assert.equal((await request(app).post('/api/workflows/baselines').set('Authorization', manager).send({ name: 'Closure baseline', projectId: 'project-1' })).status, 201);
  assert.equal((await request(app).get('/api/workflows?projectId=project-1').set('Authorization', manager)).body.baselines[0].snapshot.status, 'Completed');
});

test('workflow API validates bindings, custom fields, initial states, visibility, and optimistic versions', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager');
  const contributorCreate = await request(app).post('/api/workflows/definitions').set('Authorization', authorization('contributor')).send(structuredClone(projectWorkflow));
  assert.equal(contributorCreate.status, 404, JSON.stringify(contributorCreate.body));
  const taskDefinition = await request(app).post('/api/workflows/definitions').set('Authorization', manager).send({
    itemTypes: ['epic'], name: 'Epic delivery',
    states: [{ initial: true, key: 'Backlog', label: 'Backlog' }, { category: 'done', key: 'Done', label: 'Done', requiredFields: ['Acceptance evidence'] }],
    transitions: [{ allowedRoles: ['contributor', 'manager'], fromState: 'Backlog', key: 'finish', toState: 'Done' }],
  });
  assert.equal(taskDefinition.status, 201);
  assert.equal((await request(app).post('/api/workflows/bindings').set('Authorization', authorization('contributor')).send({ itemType: 'epic', projectId: 'project-1', workflowId: taskDefinition.body.value.id })).status, 201);
  const beforeDelete = (await request(app).get('/api/projects/project-1').set('Authorization', manager)).body.project;
  const blockedDelete = await request(app).put('/api/projects/project-1/tree').set('Authorization', authorization('contributor')).send({ epics: [], expectedUpdatedAt: beforeDelete.updatedAt });
  assert.equal(blockedDelete.status, 409);
  assert.equal(blockedDelete.body.details.code, 'workflow_item_delete_not_terminal');
  const field = await request(app).post('/api/workflows/custom-fields').set('Authorization', manager).send({ fieldType: 'string', name: 'Acceptance evidence', required: true, scope: 'epic' });
  assert.equal(field.status, 201);
  assert.equal((await request(app).put('/api/workflows/custom-values').set('Authorization', authorization('contributor')).send({ fieldId: field.body.value.id, itemId: 'epic-1', itemType: 'epic', projectId: 'project-1', value: 'Verified in staging' })).status, 200);

  const project = (await request(app).get('/api/projects/project-1').set('Authorization', manager)).body.project;
  const saved = await request(app).put('/api/projects/project-1/tree').set('Authorization', authorization('contributor')).send({
    epics: [{ ...project.epics[0], status: 'Done' }], expectedUpdatedAt: project.updatedAt,
  });
  assert.equal(saved.status, 200);
  assert.equal((await request(app).patch(`/api/workflows/definitions/${taskDefinition.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 99, name: 'Changed' })).status, 409);
  assert.equal((await request(app).patch(`/api/workflows/definitions/${taskDefinition.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 1, status: 'inactive' })).status, 409);
  assert.equal((await request(app).get('/api/workflows?projectId=project-2').set('Authorization', authorization('outsider'))).status, 404);
});

test('an approval decision or custom-value delete that names a project reaches only that project\'s records', async () => {
  const { app, authorization } = await fixture(); const manager = authorization('manager'); const admin = authorization('admin');
  const definition = await request(app).post('/api/workflows/definitions').set('Authorization', manager).send(projectWorkflow);
  await request(app).post('/api/workflows/bindings').set('Authorization', manager).send({ itemType: 'project', projectId: 'project-1', workflowId: definition.body.value.id });
  const approval = await request(app).post('/api/workflows/approvals').set('Authorization', manager).send({
    fromState: 'In Progress', itemId: 'project-1', itemType: 'project', projectId: 'project-1', toState: 'Completed', transitionKey: 'complete',
  });
  const decide = (projectId) => request(app).post(`/api/workflows/approvals/${approval.body.value.id}/decision`).set('Authorization', admin).send({ expectedVersion: 1, projectId, status: 'approved' });
  assert.equal((await decide('project-2')).status, 404);
  const decided = await decide('project-1');
  assert.equal(decided.status, 200);
  assert.deepEqual([decided.body.value.status, decided.body.value.projectId, decided.body.value.version], ['approved', 'project-1', 2]);

  const field = await request(app).post('/api/workflows/custom-fields').set('Authorization', manager).send({ fieldType: 'string', name: 'Owner note', scope: 'epic' });
  const value = await request(app).put('/api/workflows/custom-values').set('Authorization', manager).send({ fieldId: field.body.value.id, itemId: 'epic-1', itemType: 'epic', projectId: 'project-1', value: 'Ready' });
  assert.equal(value.status, 200);
  const remove = (projectId) => request(app).delete(`/api/workflows/custom-values/${value.body.value.id}`).set('Authorization', manager).send({ expectedVersion: 1, projectId });
  assert.equal((await remove('project-2')).status, 404);
  assert.equal((await remove('project-1')).status, 200);
  assert.deepEqual((await request(app).get('/api/workflows?projectId=project-1').set('Authorization', manager)).body.customValues, []);
});
