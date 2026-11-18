import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { convertEngagementForUser } from '../src/modules/engagements/engagements.service.js';
import { createInMemoryMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryRankingRepository } from '../src/modules/ranking/ranking.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

const TENANT = 'tenant-acme';
const today = new Date().toISOString().slice(0, 10);

const users = [
  { authMethod: 'basic', email: 'grace@acme.com', id: 'grace', memberships: [{ role: 'admin', tenantId: TENANT }], name: 'Grace Admin', password: 'Secret123!' },
  { authMethod: 'basic', email: 'mia@acme.com', id: 'mia', memberships: [{ role: 'manager', tenantId: TENANT }], name: 'Mia Manager', password: 'Secret123!' },
  { authMethod: 'basic', email: 'alan@acme.com', id: 'alan', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Alan Seller', password: 'Secret123!' },
  { authMethod: 'basic', email: 'carol@acme.com', id: 'carol', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Carol Member', password: 'Secret123!' },
  { authMethod: 'basic', email: 'oscar@other.com', id: 'oscar', memberships: [{ role: 'admin', tenantId: 'tenant-other' }], name: 'Oscar Outsider', password: 'Secret123!' },
];

const storyFlow = {
  description: 'Story delivery',
  itemTypes: ['story', 'task'],
  states: [
    { category: 'backlog', initial: true, key: 'ready', label: 'Ready' },
    { category: 'done', key: 'done', label: 'Done', terminal: true },
  ],
  transitions: [{ fromState: 'ready', key: 'finish', toState: 'done' }],
};
const outline = { epics: [{ description: 'Kickoff work', name: 'Kickoff', points: null, stories: [{ name: 'Plan the kickoff', points: 3, tasks: [{ name: 'Book the room', points: 1 }] }] }] };

async function fixture({ wrapWorkflowRepository = (repository) => repository } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }, { domains: ['other.com'], id: 'tenant-other', name: 'Other' }],
    users,
  });
  const storedFiles = new Map();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    fileStorage: {
      async delete(fileId) { storedFiles.delete(fileId); },
      async read(fileId) { const bytes = storedFiles.get(fileId) ?? Buffer.alloc(0); return { bytes, size: bytes.length }; },
      async write(fileId, bytes) { storedFiles.set(fileId, bytes); },
    },
    seed: {
      projectMemberships: { 'project-launch': [{ id: 'alan', role: 'admin' }, { id: 'carol', role: 'user' }] },
      projects: [{
        description: 'Delivery work', endDate: null, id: 'project-launch', name: 'Launch', startDate: null, status: 'In Progress', tenantId: TENANT, updatedAt: '2026-07-11T00:00:00.000Z',
        epics: [{ description: '', id: 'epic-1', name: 'Delivery', status: 'Not Started', stories: [{ description: '', id: 'story-1', name: 'Pilot', status: 'Not Started', tasks: [] }] }],
      }],
    },
  });
  const tokenService = createTokenService({ issuer: 'test', secret: 'engagements-test-secret-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken({ ...user, tenantId: user.memberships[0].tenantId });
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  const baseWorkflowRepository = createInMemoryWorkflowRepository();
  const workflowRepository = wrapWorkflowRepository(baseWorkflowRepository);
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  const metricsRepository = createInMemoryMetricsRepository();
  const rankingRepository = createInMemoryRankingRepository({ authRepository, projectRepository });
  const app = createApp({
    agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0,
    metricsRepository, projectRepository, rankingRepository, sessionsRepository, tokenService, workflowRepository, workspaceModulesRepository,
  });
  const as = (id) => `Bearer ${tokens.get(id)}`;
  const api = {
    get: (id, path) => request(app).get(path).set('Authorization', as(id)),
    post: (id, path, body = {}) => request(app).post(path).set('Authorization', as(id)).send(body),
    put: (id, path, body = {}) => request(app).put(path).set('Authorization', as(id)).send(body),
    delete: (id, path, body = {}) => request(app).delete(path).set('Authorization', as(id)).send(body),
  };
  async function switchConsulting(enabled) {
    const current = (await api.get('grace', '/api/workspace/modules')).body.modules.find((entry) => entry.key === 'consulting');
    const response = await api.put('grace', '/api/workspace/modules', { enabled, expectedVersion: current.version, key: 'consulting' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.module;
  }
  async function createEngagement(id = 'alan', body = { customer: 'Northwind', name: 'Northwind data platform' }) {
    const response = await api.post(id, '/api/engagements', body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.project;
  }
  return { api, app, as, baseWorkflowRepository, createEngagement, metricsRepository, projectRepository, storedFiles, switchConsulting, workflowRepository, workspaceModulesRepository };
}

async function engagementChanges(projectRepository, projectId) {
  const { entries } = await projectRepository.listProjectChanges({ afterSeq: 0, projectId, settleMs: 0, tenantId: TENANT });
  return entries.filter((entry) => entry.entityType === 'engagement').map((entry) => [entry.action, entry.detail?.status ?? null, entry.actorId]);
}

const filesPath = (projectId) => `/api/projects/${projectId}/files?targetId=${projectId}&targetType=project`;

async function uploadFile(api, userId, projectId, fileName = 'proposal.txt') {
  return api.post(userId, `/api/projects/${projectId}/files`, {
    fileContentsBase64: Buffer.from(`contents of ${fileName}`).toString('base64'),
    fileDescription: '', fileName, fileType: 'text/plain', targetId: projectId, targetType: 'project',
  });
}

async function createProjectTemplate(api) {
  const workflowTemplate = (await api.post('mia', '/api/workflows/templates', { kind: 'workflow', name: 'Story flow', payload: storyFlow })).body.value;
  const response = await api.post('mia', '/api/workflows/templates', {
    kind: 'project', name: 'Consulting delivery',
    payload: {
      customFields: [{ fieldType: 'enum', name: 'Billing type', options: ['Fixed', 'T&M'], scope: 'story' }],
      outline,
      workflowBindings: [
        { itemType: 'story', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' },
        { itemType: 'task', sourceId: workflowTemplate.id, sourceKind: 'workflow_template' },
      ],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.value;
}

test('the Consulting module is off by default, and only workspace admins can switch it', async () => {
  const { api } = await fixture();
  const asMember = await api.get('alan', '/api/workspace/modules');
  assert.equal(asMember.status, 200);
  assert.deepEqual(asMember.body, { canManage: false, modules: [{ enabled: false, key: 'consulting', label: 'Consulting' }] });

  for (const response of [await api.get('alan', '/api/engagements'), await api.post('alan', '/api/engagements', { customer: 'X', name: 'Y' }), await api.post('grace', '/api/projects/project-launch/convert')]) {
    assert.equal(response.status, 403);
    assert.equal(response.body.details.code, 'module_disabled');
  }

  for (const id of ['alan', 'mia']) {
    const refused = await api.put(id, '/api/workspace/modules', { enabled: true, expectedVersion: 0, key: 'consulting' });
    assert.equal(refused.status, 403, `${id} cannot switch modules`);
  }
  const switched = await api.put('grace', '/api/workspace/modules', { enabled: true, expectedVersion: 0, key: 'consulting' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.module.enabled, true);
  assert.equal(switched.body.module.version, 1);
  assert.equal(switched.body.module.updatedBy, 'grace');
  const stale = await api.put('grace', '/api/workspace/modules', { enabled: false, expectedVersion: 0, key: 'consulting' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'module_version_conflict');
  assert.equal((await api.put('grace', '/api/workspace/modules', { enabled: true, expectedVersion: 1, key: 'billing' })).status, 404);

  assert.equal((await api.get('alan', '/api/workspace/modules')).body.modules[0].enabled, true);
  assert.equal((await api.get('alan', '/api/engagements')).status, 200);
  // Another workspace keeps its own switch.
  assert.equal((await api.get('oscar', '/api/workspace/modules')).body.modules[0].enabled, false);
});

test('a member creates an engagement: they become its project admin, it lists on Engagements, and only its members and workspace moderators see it', async () => {
  const { api, createEngagement, projectRepository, switchConsulting } = await fixture();
  await switchConsulting(true);
  assert.equal((await api.post('alan', '/api/engagements', { name: 'No customer' })).status, 400);
  const engagement = await createEngagement();
  assert.equal(engagement.kind, 'engagement');
  assert.equal(engagement.engagementStatus, 'open');
  assert.equal(engagement.engagementCustomer, 'Northwind');
  assert.equal(engagement.engagementOwnerId, 'alan');
  assert.equal(engagement.role, 'admin');

  const listed = await api.get('alan', '/api/engagements');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.counts, { lost: 0, open: 1, won: 0 });
  assert.deepEqual(listed.body.engagements.map((entry) => [entry.id, entry.name, entry.customer, entry.ownerName, entry.status, entry.role]), [[engagement.id, 'Northwind data platform', 'Northwind', 'Alan Seller', 'open', 'admin']]);
  assert.ok(listed.body.engagements[0].lastActivityAt);

  assert.deepEqual((await api.get('carol', '/api/engagements')).body.engagements, [], 'a user who is not a member sees none');
  assert.equal((await api.get('carol', `/api/projects/${engagement.id}`)).status, 404);
  assert.equal((await api.get('mia', '/api/engagements')).body.engagements.length, 1, 'workspace managers see every engagement');
  assert.equal((await api.get('oscar', `/api/projects/${engagement.id}`)).status, 404);

  const detail = await api.get('alan', `/api/projects/${engagement.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.project.kind, 'engagement');
  assert.equal(detail.body.permissions.projectRole, 'admin');

  assert.deepEqual(await engagementChanges(projectRepository, engagement.id), [['create', 'open', 'alan']]);
});

test('engagements stay out of every delivery view', async (t) => {
  const { api, createEngagement, metricsRepository, switchConsulting } = await fixture();
  await switchConsulting(true);
  const engagement = await createEngagement('alan', { customer: 'Contoso', name: 'Contoso launch pursuit' });
  // Work on the engagement that would show in delivery views if it were not filtered, beside the
  // same work on a delivery project that must show.
  const ticket = await api.post('alan', `/api/projects/${engagement.id}/items`, { item: { assigneeId: 'alan', name: 'Zebra intake question' }, itemType: 'ticket', parentId: null });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
  const deliveryTicket = await api.post('alan', '/api/projects/project-launch/items', { item: { assigneeId: 'alan', name: 'Zebra delivery ticket' }, itemType: 'ticket', parentId: null });
  assert.equal(deliveryTicket.status, 201);
  await metricsRepository.record({ metricDate: today, pointsCompleted: 40, projectId: engagement.id, tasksCompleted: 4, tenantId: TENANT, userId: 'carol' });
  await metricsRepository.record({ metricDate: today, pointsCompleted: 5, projectId: 'project-launch', tasksCompleted: 1, tenantId: TENANT, userId: 'alan' });
  const leaks = (body) => JSON.stringify(body).includes(engagement.id);
  const shows = (body) => JSON.stringify(body).includes('project-launch');
  // Each view: delivery work shows and the engagement does not.
  async function view(userId, path, label) {
    const response = await api.get(userId, path);
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(leaks(response.body), false, `${label} leaves the engagement out`);
    assert.ok(shows(response.body), `${label} shows the delivery project`);
    return response.body;
  }

  await t.test('projects list', async () => {
    for (const id of ['grace', 'alan']) {
      const projects = await api.get(id, '/api/projects');
      assert.deepEqual(projects.body.projects.map((project) => [project.id, project.kind]), [['project-launch', 'delivery']], `projects list for ${id}`);
      const withEngagements = await api.get(id, '/api/projects?include=engagements');
      assert.deepEqual(withEngagements.body.projects.map((project) => project.kind).sort(), ['delivery', 'engagement']);
    }
  });
  await t.test('Home', async () => {
    const home = await view('alan', '/api/home', 'Home');
    assert.equal(home.viewer.projectCount, 1, 'Home counts delivery projects only');
  });
  await t.test('tenant ticket board', async () => {
    const tickets = await api.get('grace', '/api/projects/tickets');
    assert.equal(tickets.status, 200);
    assert.deepEqual(tickets.body.tickets.map((entry) => entry.name), ['Zebra delivery ticket']);
    assert.equal(leaks((await api.get('grace', '/api/projects/ticket-review-queue')).body), false, 'ticket review queue');
  });
  await t.test('ranking', async () => {
    await view('grace', '/api/ranking/leaderboard', 'ranking');
    assert.equal((await api.get('grace', `/api/ranking/head-to-head/${engagement.id}`)).status, 404, 'ranking head-to-head');
  });
  await t.test('portfolio alignment', async () => {
    await view('grace', '/api/portfolio', 'portfolio');
  });
  await t.test('leaderboard', async () => {
    const leaderboard = await api.get('grace', '/api/metrics/leaderboard?days=30');
    assert.equal(leaderboard.status, 200);
    assert.deepEqual(leaderboard.body.leaderboard.map((row) => [row.id, row.points]), [['alan', 5]]);
  });
  await t.test('Insights', async () => {
    assert.equal((await api.get('alan', `/api/projects/${engagement.id}/insights`)).status, 404);
    assert.equal((await api.get('alan', '/api/projects/project-launch/insights')).status, 200);
  });
  await t.test('reporting datasets and BI feeds', async () => {
    for (const dataset of ['executive', 'project', 'work_items']) await view('grace', `/api/reporting/bi/${dataset}`, `BI feed ${dataset}`);
    await view('grace', '/api/reporting', 'reporting workspace');
  });
  await t.test('resource demand', async () => {
    await view('grace', '/api/resource-planning', 'resource planning');
  });
  await t.test('workspace search', async () => {
    assert.equal((await api.post('grace', '/api/reporting/search/refresh')).status, 200);
    await view('grace', '/api/reporting/search?query=launch', 'workspace search');
  });
  await t.test('workflows project list', async () => {
    await view('grace', '/api/workflows', 'workflows');
  });
});

test('converting keeps the id, files and people, applies the template, and moves the project into delivery views', async () => {
  const { api, baseWorkflowRepository, createEngagement, projectRepository, switchConsulting } = await fixture();
  await switchConsulting(true);
  const engagement = await createEngagement();
  const file = await uploadFile(api, 'alan', engagement.id);
  assert.equal(file.status, 201, JSON.stringify(file.body));
  const members = await api.put('alan', `/api/projects/${engagement.id}/permissions`, { validUsers: [{ id: 'alan', role: 'admin' }, { id: 'carol', role: 'user' }] });
  assert.equal(members.status, 200, JSON.stringify(members.body));
  const template = await createProjectTemplate(api);

  // Decision rights: a plain member cannot convert or close it.
  assert.equal((await api.post('carol', `/api/projects/${engagement.id}/convert`, { templateId: template.id })).status, 404);
  assert.equal((await api.post('carol', `/api/projects/${engagement.id}/close`)).status, 404);
  // A delivery project is not an engagement.
  assert.equal((await api.post('alan', '/api/projects/project-launch/convert')).body.details.code, 'not_an_engagement');

  const converted = await api.post('alan', `/api/projects/${engagement.id}/convert`, { templateId: template.id });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  const project = converted.body.project;
  assert.equal(project.id, engagement.id);
  assert.equal(project.kind, 'delivery');
  assert.equal(project.engagementStatus, 'won');
  assert.equal(project.status, 'Planned');
  assert.equal(project.convertedBy, 'alan');
  assert.ok(project.convertedAt);
  assert.equal(project.epics[0].name, 'Kickoff');
  assert.equal(project.epics[0].stories[0].status, 'ready');

  const files = await api.get('alan', filesPath(engagement.id));
  assert.deepEqual(files.body.files.map((entry) => entry.fileName), ['proposal.txt']);
  const people = await api.get('alan', `/api/projects/${engagement.id}/valid-users`);
  assert.deepEqual(people.body.project_users.map((entry) => [entry.id, entry.role]).sort(), [['alan', 'admin'], ['carol', 'user']]);
  const snapshot = await baseWorkflowRepository.listSnapshot({ tenantId: TENANT });
  assert.deepEqual(snapshot.bindings.filter((binding) => binding.projectId === engagement.id).map((binding) => binding.itemType).sort(), ['story', 'task', 'ticket']);
  assert.equal(snapshot.customFields.filter((field) => field.name === 'Billing type').length, 1);

  assert.ok((await api.get('carol', '/api/projects')).body.projects.some((entry) => entry.id === engagement.id), 'now a delivery project');
  const listed = await api.get('alan', '/api/engagements?status=won');
  assert.deepEqual(listed.body.engagements.map((entry) => [entry.id, entry.status, entry.kind]), [[engagement.id, 'won', 'delivery']]);
  assert.equal((await api.post('alan', `/api/projects/${engagement.id}/convert`)).status, 409, 'a converted engagement cannot convert again');

  assert.deepEqual(await engagementChanges(projectRepository, engagement.id), [['create', 'open', 'alan'], ['convert', 'won', 'alan']]);
});

test('a template step that fails leaves the engagement open and unchanged, and removes only what the template added', async () => {
  let failCustomFields = true;
  const { api, baseWorkflowRepository, createEngagement, projectRepository, switchConsulting } = await fixture({
    wrapWorkflowRepository: (repository) => ({
      ...repository,
      async createCustomField(args) {
        if (failCustomFields) throw new Error('forced custom field failure');
        return repository.createCustomField(args);
      },
    }),
  });
  await switchConsulting(true);
  const engagement = await createEngagement();
  assert.equal((await uploadFile(api, 'alan', engagement.id)).status, 201);
  const template = await createProjectTemplate(api);
  const before = await projectRepository.getProjectDetail({ projectId: engagement.id, tenantId: TENANT });
  const workflowsBefore = (await baseWorkflowRepository.listSnapshot({ tenantId: TENANT })).workflows.length;

  const failed = await api.post('alan', `/api/projects/${engagement.id}/convert`, { templateId: template.id });
  assert.equal(failed.status, 500);

  const after = await projectRepository.getProjectDetail({ projectId: engagement.id, tenantId: TENANT });
  assert.deepEqual(after, before, 'the engagement is exactly as it was');
  assert.equal(after.kind, 'engagement');
  assert.equal(after.engagementStatus, 'open');
  const snapshot = await baseWorkflowRepository.listSnapshot({ tenantId: TENANT });
  assert.equal(snapshot.workflows.length, workflowsBefore, 'the workflow the template created is removed');
  assert.deepEqual(snapshot.bindings.filter((binding) => binding.projectId === engagement.id), []);
  assert.deepEqual((await api.get('alan', filesPath(engagement.id))).body.files.map((entry) => entry.fileName), ['proposal.txt']);
  assert.ok((await api.get('alan', '/api/engagements?status=open')).body.engagements.some((entry) => entry.id === engagement.id));

  // The same conversion works once the step does.
  failCustomFields = false;
  assert.equal((await api.post('alan', `/api/projects/${engagement.id}/convert`, { templateId: template.id })).status, 200);
});

test('a conversion that fails after the template applied undoes the template and leaves the engagement open', async () => {
  const { api, baseWorkflowRepository, createEngagement, projectRepository, switchConsulting, workflowRepository, workspaceModulesRepository } = await fixture();
  await switchConsulting(true);
  const engagement = await createEngagement();
  const template = await createProjectTemplate(api);
  const before = await projectRepository.getProjectDetail({ projectId: engagement.id, tenantId: TENANT });
  const alan = users.find((user) => user.id === 'alan');

  await assert.rejects(convertEngagementForUser({
    beforeCommit: async () => { throw new Error('forced guest step failure'); },
    input: { templateId: template.id }, projectId: engagement.id, projectRepository, user: alan, workflowRepository, workspaceModulesRepository,
  }), /forced guest step failure/);

  const after = await projectRepository.getProjectDetail({ projectId: engagement.id, tenantId: TENANT });
  assert.equal(after.kind, 'engagement');
  assert.equal(after.engagementStatus, 'open');
  assert.deepEqual(after.epics, [], 'the seeded outline is removed');
  assert.equal(after.name, before.name);
  const snapshot = await baseWorkflowRepository.listSnapshot({ tenantId: TENANT });
  assert.deepEqual(snapshot.bindings.filter((binding) => binding.projectId === engagement.id), []);
  assert.equal(snapshot.customFields.filter((field) => field.name === 'Billing type').length, 0);
});

test('a lost engagement is read-only and listed under Lost; reopening restores it', async () => {
  const { api, createEngagement, projectRepository, switchConsulting } = await fixture();
  await switchConsulting(true);
  const engagement = await createEngagement();
  const file = (await uploadFile(api, 'alan', engagement.id)).body.file;

  const closed = await api.post('alan', `/api/projects/${engagement.id}/close`);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.project.engagementStatus, 'lost');
  assert.equal(closed.body.project.status, 'Archived');
  assert.ok(closed.body.project.closedAt);
  assert.deepEqual((await api.get('alan', '/api/engagements?status=lost')).body.engagements.map((entry) => entry.id), [engagement.id]);
  assert.deepEqual((await api.get('alan', '/api/engagements?status=open')).body.engagements, []);

  const detail = (await api.get('alan', `/api/projects/${engagement.id}`)).body.project;
  const writes = [
    await api.put('alan', `/api/projects/${engagement.id}`, { description: '', endDate: null, expectedUpdatedAt: detail.updatedAt, name: 'Renamed', startDate: null, status: 'Planned' }),
    await uploadFile(api, 'alan', engagement.id, 'second.txt'),
    await api.post('alan', `/api/projects/${engagement.id}/items`, { item: { name: 'New ticket' }, itemType: 'ticket', parentId: null }),
    await api.delete('alan', `/api/files/${file.id}`),
    await api.put('alan', `/api/projects/${engagement.id}/permissions`, { validUsers: [{ id: 'alan', role: 'admin' }] }),
    await api.post('alan', `/api/projects/${engagement.id}/convert`),
  ];
  for (const response of writes) {
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.details.code, 'engagement_closed');
  }
  assert.equal((await api.put('oscar', `/api/projects/${engagement.id}`, {})).status, 404, 'someone outside the workspace learns nothing');
  assert.equal((await api.get('alan', `/api/projects/${engagement.id}`)).status, 200, 'reads still work');
  assert.equal((await api.get('alan', filesPath(engagement.id))).body.files.length, 1);
  assert.equal((await api.get('alan', `/api/files/${file.id}/content`)).status, 200);
  assert.equal((await api.post('carol', `/api/projects/${engagement.id}/reopen`)).status, 404, 'reopening needs decision rights');

  const reopened = await api.post('alan', `/api/projects/${engagement.id}/reopen`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.project.engagementStatus, 'open');
  assert.equal(reopened.body.project.closedAt, null);
  assert.equal((await uploadFile(api, 'alan', engagement.id, 'second.txt')).status, 201, 'writable again');
  assert.equal((await api.post('alan', `/api/projects/${engagement.id}/reopen`)).body.details.code, 'engagement_not_lost');

  assert.deepEqual(await engagementChanges(projectRepository, engagement.id), [['create', 'open', 'alan'], ['close', 'lost', 'alan'], ['reopen', 'open', 'alan']]);
});

test('with the module off, engagements are hidden and their URLs return 404; delivery projects work as before; switching back shows them unchanged', async () => {
  const { api, createEngagement, switchConsulting } = await fixture();
  await switchConsulting(true);
  const first = await createEngagement('alan', { customer: 'Northwind', name: 'Northwind' });
  const second = await createEngagement('alan', { customer: 'Fabrikam', name: 'Fabrikam' });
  const file = (await uploadFile(api, 'alan', first.id)).body.file;
  const before = (await api.get('alan', '/api/engagements')).body.engagements;

  const off = await switchConsulting(false);
  assert.deepEqual(off.impact, { openEngagements: 2 }, 'the switch says how many open engagements it hides');
  const listedForAdmin = (await api.get('grace', '/api/workspace/modules')).body.modules[0];
  assert.equal(listedForAdmin.impact.openEngagements, 2);

  assert.equal((await api.get('alan', '/api/engagements')).body.details.code, 'module_disabled');
  for (const path of [`/api/projects/${first.id}`, `/api/projects/${first.id}/files`, `/api/projects/${first.id}/events`, `/api/files/${file.id}/content`]) {
    assert.equal((await api.get('alan', path)).status, 404, path);
  }
  assert.equal((await api.delete('alan', `/api/files/${file.id}`)).status, 404);
  for (const action of ['convert', 'close', 'reopen']) {
    const response = await api.post('alan', `/api/projects/${second.id}/${action}`);
    assert.equal(response.status, 403, action);
    assert.equal(response.body.details.code, 'module_disabled');
  }
  assert.deepEqual((await api.get('alan', '/api/projects?include=engagements')).body.projects.map((project) => project.id), ['project-launch']);

  // Delivery projects keep working.
  assert.equal((await api.get('alan', '/api/projects/project-launch')).status, 200);
  assert.equal((await uploadFile(api, 'alan', 'project-launch')).status, 201);
  assert.equal((await api.get('alan', filesPath('project-launch'))).body.files.length, 1);

  await switchConsulting(true);
  assert.deepEqual((await api.get('alan', '/api/engagements')).body.engagements, before, 'every engagement comes back unchanged');
  assert.equal((await api.get('alan', `/api/files/${file.id}/content`)).status, 200);
});
