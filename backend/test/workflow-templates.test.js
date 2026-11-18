import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { workflowDefinitionFromTemplate } from '../src/modules/workflows/template-application.js';
import { TICKET_WORKFLOW_NAME } from '../src/modules/workflows/ticket-workflow.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import {
  describeTemplatePayload,
  projectTemplateCreateSchema,
  projectTemplatePayloadSchema,
  workflowTemplatePayloadSchema,
  workItemTemplatePayloadSchema,
} from '../src/modules/workflows/workflows.schema.js';

const TENANT = 'tenant-1';

async function fixture({ wrapProjectRepository = (repository) => repository } = {}) {
  const users = [
    { authMethod: 'basic', email: 'manager@example.com', id: 'manager', memberships: [{ role: 'manager', tenantId: TENANT }], name: 'Manager', password: 'Secret123!' },
    { authMethod: 'basic', email: 'contributor@example.com', id: 'contributor', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Contributor', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: TENANT, name: 'Tenant' }], users });
  const baseProjectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'contributor', role: 'contributor' }] },
    projects: [{
      description: '', endDate: null, epics: [{ description: '', id: 'epic-1', name: 'Delivery', status: 'Not Started', stories: [{ description: '', id: 'story-1', name: 'Pilot', status: 'Not Started', tasks: [] }] }],
      id: 'project-1', name: 'Launch', startDate: null, status: 'In Progress', tenantId: TENANT, updatedAt: '2026-07-11T00:00:00.000Z',
    }],
  } });
  const projectRepository = wrapProjectRepository(baseProjectRepository);
  const tokenService = createTokenService({ issuer: 'test', secret: 'workflow-template-secret-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository(); const tokens = new Map();
  for (const user of users) { const token = tokenService.signSessionToken(user); const decoded = tokenService.verifySessionToken(token); await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id }); tokens.set(user.id, token); }
  const workflowRepository = createInMemoryWorkflowRepository();
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0, projectRepository, sessionsRepository, tokenService, workflowRepository });
  return { app, as: (id) => `Bearer ${tokens.get(id)}`, baseProjectRepository, workflowRepository };
}

const storyFlow = {
  description: 'Story delivery',
  itemTypes: ['story', 'task'],
  states: [
    { category: 'backlog', initial: true, key: 'ready', label: 'Ready' },
    { category: 'active', key: 'doing', label: 'Doing', slaHours: 8 },
    { category: 'done', key: 'done', label: 'Done', terminal: true },
  ],
  transitions: [
    { fromState: 'ready', key: 'start', toState: 'doing' },
    { allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'], fromState: 'doing', key: 'finish', toState: 'done' },
  ],
};

const projectFlow = {
  description: 'Project lifecycle', itemTypes: ['project'], name: 'Project lifecycle',
  states: [{ category: 'backlog', initial: true, key: 'Planned', label: 'Planned' }, { category: 'active', key: 'In Progress', label: 'In progress' }],
  transitions: [{ fromState: 'Planned', key: 'start', toState: 'In Progress' }],
};

const outline = { epics: [{ description: 'Discovery work', name: 'Discovery', points: null, stories: [{ name: 'Interview users', points: 3, tasks: [{ name: 'Book sessions', points: 1 }] }] }] };

async function createTemplate(app, auth, body) {
  const response = await request(app).post('/api/workflows/templates').set('Authorization', auth).send(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.value;
}

test('template payload schemas are typed per kind and flag legacy payloads', () => {
  assert.equal(workflowTemplatePayloadSchema.safeParse(storyFlow).success, true);
  assert.equal(workflowTemplatePayloadSchema.safeParse({ ...storyFlow, states: storyFlow.states.map((state) => ({ ...state, initial: true })) }).success, false);
  assert.equal(workflowTemplatePayloadSchema.safeParse({ ...storyFlow, transitions: [{ fromState: 'ready', key: 'x', toState: 'missing' }] }).success, false);
  assert.equal(projectTemplatePayloadSchema.safeParse({}).success, false, 'an empty project template does nothing');
  assert.equal(projectTemplatePayloadSchema.safeParse({ outline }).success, true);
  assert.equal(projectTemplatePayloadSchema.safeParse({ workflowBindings: [{ itemType: 'story', sourceId: 'a', sourceKind: 'workflow_template' }, { itemType: 'story', sourceId: 'b', sourceKind: 'workflow_definition' }] }).success, false);
  assert.equal(workItemTemplatePayloadSchema.safeParse({ itemType: 'ticket', category: 'support', severity: 'S2' }).success, true);
  assert.equal(workItemTemplatePayloadSchema.safeParse({ itemType: 'story', severity: 'S2' }).success, false);

  const invalid = projectTemplateCreateSchema.safeParse({ kind: 'work_item', name: 'Bad', payload: { itemType: 'project' } });
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.issues[0].path[0], 'payload');

  const legacy = describeTemplatePayload({ kind: 'project', payload: { status: 'In Progress' } });
  assert.equal(legacy.payloadStatus, 'needs_update');
  assert.ok(legacy.payloadIssues.length > 0);
  assert.deepEqual(describeTemplatePayload({ kind: 'workflow', payload: storyFlow }), { payloadIssues: [], payloadStatus: 'valid' });
});

test('a workflow template converts into a definition that the definition schema accepts', () => {
  const parsed = workflowTemplatePayloadSchema.parse(storyFlow);
  const definition = workflowDefinitionFromTemplate({ description: 'fallback', name: 'Story flow' }, parsed);
  assert.equal(definition.name, 'Story flow');
  assert.equal(definition.status, 'active');
  assert.deepEqual(definition.itemTypes, ['story', 'task']);
  assert.equal(definition.states.find((state) => state.initial).key, 'ready');
  assert.equal(definition.transitions[1].approvalRequired, true);
});

test('template writes require a workflow manager, validate per kind, and tolerate legacy rows', async () => {
  const { app, as, workflowRepository } = await fixture();
  const payload = { kind: 'workflow', name: 'Story flow', payload: storyFlow };
  assert.equal((await request(app).post('/api/workflows/templates').set('Authorization', as('contributor')).send(payload)).status, 404);
  const invalid = await request(app).post('/api/workflows/templates').set('Authorization', as('manager')).send({ kind: 'workflow', name: 'Broken', payload: { states: [] } });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.details.some((issue) => issue.path.startsWith('payload')));

  const created = await createTemplate(app, as('manager'), payload);
  assert.equal(created.payloadStatus, 'valid');
  const badUpdate = await request(app).patch(`/api/workflows/templates/${created.id}`).set('Authorization', as('manager')).send({ expectedVersion: 1, payload: { itemType: 'story' } });
  assert.equal(badUpdate.status, 400, 'a payload-only update is checked against the stored kind');
  assert.equal((await request(app).patch(`/api/workflows/templates/${created.id}`).set('Authorization', as('contributor')).send({ expectedVersion: 1, name: 'Renamed' })).status, 404);

  const legacy = await workflowRepository.createTemplate({ input: { description: '', kind: 'project', name: 'Old starter', payload: { status: 'In Progress' }, status: 'active' }, tenantId: TENANT });
  const renamed = await request(app).patch(`/api/workflows/templates/${legacy.id}`).set('Authorization', as('manager')).send({ expectedVersion: 1, name: 'Old starter (legacy)' });
  assert.equal(renamed.status, 200, 'renaming a legacy row keeps its payload');
  assert.equal(renamed.body.value.payloadStatus, 'needs_update');
  assert.equal((await request(app).patch(`/api/workflows/templates/${legacy.id}`).set('Authorization', as('manager')).send({ expectedVersion: 2, kind: 'work_item' })).status, 400, 'changing kind revalidates the payload');

  const listed = await request(app).get('/api/workflows/templates?status=active').set('Authorization', as('contributor'));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.templates.map((template) => [template.name, template.payloadStatus]), [['Old starter (legacy)', 'needs_update'], ['Story flow', 'valid']]);
  const workspace = await request(app).get('/api/workflows').set('Authorization', as('manager'));
  assert.equal(workspace.body.templates.find((template) => template.id === legacy.id).payloadStatus, 'needs_update');
  assert.equal((await request(app).get('/api/workflows/templates?kind=workflow').set('Authorization', as('contributor'))).body.templates.length, 1);
});

test('a single workflow definition can be read by tenant members', async () => {
  const { app, as } = await fixture();
  const created = await request(app).post('/api/workflows/definitions').set('Authorization', as('manager')).send({ ...storyFlow, name: 'Story flow' });
  const read = await request(app).get(`/api/workflows/definitions/${created.body.value.id}`).set('Authorization', as('contributor'));
  assert.equal(read.status, 200);
  assert.equal(read.body.value.name, 'Story flow');
  assert.equal(read.body.canManage, false);
  assert.equal((await request(app).get('/api/workflows/definitions/missing').set('Authorization', as('manager'))).status, 404);
});

test('creating a project from a template binds workflows, adds custom fields, and seeds the outline', async () => {
  const { app, as, workflowRepository } = await fixture();
  const manager = as('manager');
  const workflowTemplate = await createTemplate(app, manager, { kind: 'workflow', name: 'Story flow', payload: storyFlow });
  const projectDefinition = (await request(app).post('/api/workflows/definitions').set('Authorization', manager).send(projectFlow)).body.value;
  const projectTemplate = await createTemplate(app, manager, {
    kind: 'project', name: 'Discovery project',
    payload: {
      customFields: [{ fieldType: 'enum', name: 'Risk level', options: ['Low', 'High'], scope: 'story' }],
      outline,
      workflowBindings: [
        { itemType: 'story', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' },
        { itemType: 'task', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' },
        { itemType: 'project', sourceId: projectDefinition.id, sourceKind: 'workflow_definition' },
      ],
    },
  });

  // A contributor can use a template a manager published.
  const created = await request(app).post('/api/projects').set('Authorization', as('contributor')).send({ name: 'Research', status: 'Planned', templateId: projectTemplate.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body.project;
  assert.equal(project.role, 'admin');
  assert.equal(project.epics[0].name, 'Discovery');
  assert.equal(project.epics[0].status, 'Not Started', 'epics have no bound workflow');
  assert.equal(project.epics[0].stories[0].status, 'ready');
  assert.equal(project.epics[0].stories[0].tasks[0].status, 'ready');
  assert.equal(project.epics[0].stories[0].tasks[0].points, 1);

  const snapshot = await workflowRepository.listSnapshot({ tenantId: TENANT });
  const bindings = snapshot.bindings.filter((binding) => binding.projectId === project.id);
  assert.deepEqual(bindings.map((binding) => binding.itemType).sort(), ['project', 'story', 'task', 'ticket']);
  const storyWorkflow = snapshot.workflows.find((workflow) => workflow.name === 'Story flow');
  assert.ok(storyWorkflow, 'the workflow template becomes a definition');
  assert.equal(bindings.find((binding) => binding.itemType === 'task').workflowId, storyWorkflow.id, 'one definition per workflow template');
  assert.equal(snapshot.workflows.find((workflow) => workflow.id === bindings.find((binding) => binding.itemType === 'ticket').workflowId).name, TICKET_WORKFLOW_NAME);
  assert.equal(snapshot.customFields.filter((field) => field.name === 'Risk level').length, 1);

  // A second project reuses the definition and field instead of duplicating them.
  const second = await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'Research 2', status: 'Planned', templateId: projectTemplate.id });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const after = await workflowRepository.listSnapshot({ tenantId: TENANT });
  assert.equal(after.workflows.filter((workflow) => workflow.name.startsWith('Story flow')).length, 1);
  assert.equal(after.customFields.length, 1);

  // Seeded items follow the bound workflow afterwards.
  const story = second.body.project.epics[0].stories[0];
  const moved = await request(app).patch(`/api/projects/${second.body.project.id}/items/${story.id}`).set('Authorization', manager).send({ expectedVersion: story.version, patch: { status: 'done' } });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.details.code, 'workflow_transition_not_allowed');
});

test('a template ticket binding replaces the default ticket lifecycle', async () => {
  const { app, as, workflowRepository } = await fixture();
  const manager = as('manager');
  const ticketFlow = await createTemplate(app, manager, { kind: 'workflow', name: 'Support desk', payload: {
    itemTypes: ['ticket'],
    states: [{ initial: true, key: 'new', label: 'New' }, { category: 'done', key: 'closed', label: 'Closed', terminal: true }],
    transitions: [{ fromState: 'new', key: 'close', toState: 'closed' }],
  } });
  const template = await createTemplate(app, manager, { kind: 'project', name: 'Support project', payload: { workflowBindings: [{ itemType: 'ticket', sourceId: ticketFlow.id, sourceKind: 'workflow_template' }] } });
  const created = await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'Helpdesk', status: 'Planned', templateId: template.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const snapshot = await workflowRepository.listSnapshot({ tenantId: TENANT });
  const ticketBinding = snapshot.bindings.find((binding) => binding.projectId === created.body.project.id && binding.itemType === 'ticket');
  assert.equal(snapshot.workflows.find((workflow) => workflow.id === ticketBinding.workflowId).name, 'Support desk');
  assert.equal(snapshot.bindings.filter((binding) => binding.projectId === created.body.project.id).length, 1);
});

test('project templates that cannot apply are rejected before anything is created', async () => {
  const { app, as, baseProjectRepository, workflowRepository } = await fixture();
  const manager = as('manager');
  const projectCount = async () => (await request(app).get('/api/projects').set('Authorization', manager)).body.projects.length;
  const before = await projectCount();

  const legacy = await workflowRepository.createTemplate({ input: { description: '', kind: 'project', name: 'Legacy', payload: { status: 'In Progress' }, status: 'active' }, tenantId: TENANT });
  const legacyResponse = await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'X', status: 'Planned', templateId: legacy.id });
  assert.equal(legacyResponse.status, 409);
  assert.equal(legacyResponse.body.details.code, 'template_needs_update');

  const inactive = await createTemplate(app, manager, { kind: 'project', name: 'Inactive', payload: { outline }, status: 'inactive' });
  assert.equal((await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'X', status: 'Planned', templateId: inactive.id })).status, 404);

  const projectDefinition = (await request(app).post('/api/workflows/definitions').set('Authorization', manager).send(projectFlow)).body.value;
  const statusTemplate = await createTemplate(app, manager, { kind: 'project', name: 'Status', payload: { workflowBindings: [{ itemType: 'project', sourceId: projectDefinition.id, sourceKind: 'workflow_definition' }] } });
  const mismatch = await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'X', status: 'At Risk', templateId: statusTemplate.id });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.details.code, 'template_project_status_mismatch');

  const strictFlow = await createTemplate(app, manager, { kind: 'workflow', name: 'Strict', payload: {
    itemTypes: ['epic'], states: [{ initial: true, key: 'draft', label: 'Draft', requiredFields: ['Owner'] }], transitions: [],
  } });
  const strictTemplate = await createTemplate(app, manager, { kind: 'project', name: 'Strict project', payload: { outline, workflowBindings: [{ itemType: 'epic', sourceId: strictFlow.id, sourceKind: 'workflow_template' }] } });
  const required = await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'X', status: 'Planned', templateId: strictTemplate.id });
  assert.equal(required.status, 409);
  assert.equal(required.body.details.code, 'template_outline_required_fields');

  assert.equal(await projectCount(), before);
  const snapshot = await workflowRepository.listSnapshot({ tenantId: TENANT });
  assert.equal(snapshot.workflows.some((workflow) => workflow.name === 'Strict'), false, 'no definition is created for a rejected template');
  assert.equal(snapshot.bindings.length, 0);
  assert.equal((await baseProjectRepository.listProjectsForTenant({ tenantId: TENANT, user: { id: 'manager', memberships: [{ role: 'manager', tenantId: TENANT }] } })).length, before);
});

test('a failure while seeding rolls back the project, bindings, workflows and fields', async () => {
  const { app, as, workflowRepository } = await fixture({
    wrapProjectRepository: (repository) => ({ ...repository, replaceProjectTree: async () => { throw new Error('Outline write failed.'); } }),
  });
  const manager = as('manager');
  const workflowTemplate = await createTemplate(app, manager, { kind: 'workflow', name: 'Story flow', payload: storyFlow });
  const template = await createTemplate(app, manager, { kind: 'project', name: 'Discovery', payload: {
    customFields: [{ fieldType: 'string', name: 'Evidence', scope: 'story' }],
    outline,
    workflowBindings: [{ itemType: 'story', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' }],
  } });
  const before = (await request(app).get('/api/projects').set('Authorization', manager)).body.projects.length;
  const failed = await request(app).post('/api/projects').set('Authorization', manager).send({ name: 'Doomed', status: 'Planned', templateId: template.id });
  assert.equal(failed.status, 500);
  const projects = (await request(app).get('/api/projects').set('Authorization', manager)).body.projects;
  assert.equal(projects.length, before);
  assert.equal(projects.some((project) => project.name === 'Doomed'), false);
  const snapshot = await workflowRepository.listSnapshot({ tenantId: TENANT });
  assert.deepEqual(snapshot.bindings, []);
  assert.deepEqual(snapshot.customFields, []);
  assert.equal(snapshot.workflows.length, 0);
});

test('work-item templates record custom-field defaults on the created item', async () => {
  const { app, as, workflowRepository } = await fixture();
  const manager = as('manager');
  const field = (await request(app).post('/api/workflows/custom-fields').set('Authorization', manager).send({ fieldType: 'enum', name: 'Impact', options: ['Low', 'High'], scope: 'task' })).body.value;
  const template = await createTemplate(app, manager, { kind: 'work_item', name: 'Spike task', payload: {
    acceptanceCriteria: 'Findings are written up.', customFieldDefaults: [{ fieldId: field.id, value: 'High' }], description: 'Time-boxed research.', itemType: 'task', points: 2, priority: 3,
  } });

  const created = await request(app).post('/api/projects/project-1/items').set('Authorization', as('contributor')).send({
    item: { description: 'Time-boxed research.', name: 'Spike: caching', points: 2, priority: 3 }, itemType: 'task', parentId: 'story-1', templateId: template.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.templateApplied.templateId, template.id);
  assert.deepEqual(created.body.templateApplied.templateWarnings, []);
  const values = (await workflowRepository.listSnapshot({ tenantId: TENANT })).customValues;
  assert.deepEqual(values.map((value) => [value.itemId, value.fieldId, value.value]), [[created.body.item.id, field.id, 'High']]);

  const mismatch = await request(app).post('/api/projects/project-1/items').set('Authorization', manager).send({ item: { name: 'Story' }, itemType: 'story', parentId: 'epic-1', templateId: template.id });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.details.code, 'template_item_type_mismatch');
  assert.equal((await request(app).post('/api/projects/project-1/items').set('Authorization', manager).send({ item: { name: 'Task' }, itemType: 'task', parentId: 'story-1', templateId: 'missing' })).status, 404);

  await request(app).patch(`/api/workflows/custom-fields/${field.id}`).set('Authorization', manager).send({ expectedVersion: 1, status: 'inactive' });
  const unavailable = await request(app).post('/api/projects/project-1/items').set('Authorization', manager).send({ item: { name: 'Task 2' }, itemType: 'task', parentId: 'story-1', templateId: template.id });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.details.code, 'template_custom_field_unavailable');
  const project = (await request(app).get('/api/projects/project-1').set('Authorization', manager)).body.project;
  assert.equal(project.epics[0].stories[0].tasks.length, 1, 'a rejected template creates no item');
});
