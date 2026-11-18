import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { LIVE_EVENT_CHANNELS, createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryProjectsRepository, createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ensureMysqlProjectSoftDeleteSchema } from '../src/modules/projects/project-deletion.repository.js';
import { canDeleteProject } from '../src/modules/projects/project-deletion.service.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const TENANT = 'tenant-acme';
const activeTestServers = new Set();

test.afterEach(async () => {
  const servers = [...activeTestServers];
  activeTestServers.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(resolve);
    server.closeAllConnections?.();
  })));
});

const USERS = [
  { id: 'user-admin', name: 'Ada Admin', role: 'admin' },
  { id: 'user-tenant-manager', name: 'Tim Manager', role: 'manager' },
  { id: 'user-project-manager', name: 'Pat Manager', role: 'user' },
  { id: 'user-editor', name: 'Eddie Editor', role: 'user' },
];

function seedProjects() {
  return [
    {
      createdAt: '2026-05-01T10:00:00.000Z',
      description: 'Rebuild the onboarding funnel.',
      epics: [{ id: 'epic-alpha', name: 'Onboarding epic', status: 'In Progress', stories: [] }],
      id: 'project-alpha',
      name: 'Alpha Launch',
      rank: 1,
      role: 'admin',
      status: 'In Progress',
      tenantId: TENANT,
      tickets: [{ category: 'defect', id: 'ticket-alpha', name: 'Alpha login fails', severity: 'S2', status: 'Not Started' }],
      updatedAt: '2026-05-12T08:30:00.000Z',
    },
    {
      createdAt: '2026-04-01T10:00:00.000Z',
      description: 'Backlog cleanup.',
      epics: [],
      id: 'project-beta',
      name: 'Beta Cleanup',
      rank: 2,
      role: 'admin',
      status: 'Planned',
      tenantId: TENANT,
      tickets: [{ category: 'defect', id: 'ticket-beta', name: 'Beta login fails', severity: 'S3', status: 'Not Started' }],
      updatedAt: '2026-05-11T08:30:00.000Z',
    },
  ];
}

async function createDeletionTestApp() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme Delivery' }],
    users: USERS.map((user) => ({
      authMethod: 'basic',
      email: `${user.id}@acme.com`,
      id: user.id,
      memberships: [{ role: user.role, tenantId: TENANT }],
      name: user.name,
      password: 'Secret123!',
      preferences: { twoFactorEnabled: false },
    })),
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        'project-alpha': [
          { id: 'user-project-manager', role: 'manager' },
          { id: 'user-editor', role: 'editor' },
        ],
        'project-beta': [{ id: 'user-editor', role: 'editor' }],
      },
      projects: seedProjects(),
    },
  });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const complianceRepository = createInMemoryComplianceRepository();
  const liveEventBus = createLiveEventBus();
  const auditEvents = [];
  const app = createApp({
    auditWriter: { async append(event) { auditEvents.push(event); } },
    authRepository,
    complianceRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    liveEventBus,
    projectRepository,
    sessionsRepository,
    tokenService,
  });
  const server = http.createServer(app);
  server.locals = app.locals;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  activeTestServers.add(server);

  const auth = {};
  for (const user of USERS) {
    const token = tokenService.signSessionToken({
      email: `${user.id}@acme.com`,
      id: user.id,
      name: user.name,
      preferences: { twoFactorEnabled: false },
      role: user.role,
      scopes: [`T${TENANT}-${user.role}`],
      tenantId: TENANT,
    });
    const { exp } = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({
      expiryDate: new Date(exp * 1000),
      ipAddr: '127.0.0.1',
      locationName: 'Localhost',
      token,
      userAgent: 'test-agent',
      userId: user.id,
    });
    auth[user.id] = `Bearer ${token}`;
  }

  return { app: server, auditEvents, auth, liveEventBus, projectRepository };
}

async function listProjectIds(app, authorization) {
  const response = await request(app).get('/api/projects').set('Authorization', authorization);
  assert.equal(response.status, 200);
  return response.body.projects.map((project) => project.id);
}

test('project delete permission: tenant admins and project admins or managers only', () => {
  assert.equal(canDeleteProject({ projectRole: null, tenantRole: 'admin' }), true);
  assert.equal(canDeleteProject({ projectRole: 'manager', tenantRole: 'user' }), true);
  assert.equal(canDeleteProject({ projectRole: 'Admin', tenantRole: 'user' }), true);
  assert.equal(canDeleteProject({ projectRole: null, tenantRole: 'manager' }), false);
  assert.equal(canDeleteProject({ projectRole: 'editor', tenantRole: 'manager' }), false);
  assert.equal(canDeleteProject({ projectRole: 'contributor', tenantRole: 'user' }), false);
});

test('project detail reports whether the viewer may delete the project', async () => {
  const { app, auth } = await createDeletionTestApp();
  const asManager = await request(app).get('/api/projects/project-alpha').set('Authorization', auth['user-project-manager']);
  const asEditor = await request(app).get('/api/projects/project-alpha').set('Authorization', auth['user-editor']);
  const asTenantManager = await request(app).get('/api/projects/project-alpha').set('Authorization', auth['user-tenant-manager']);
  assert.equal(asManager.body.permissions.canDelete, true);
  assert.equal(asEditor.body.permissions.canDelete, false);
  assert.equal(asTenantManager.body.permissions.canDelete, false);
  // What else each may change, for the assistant and MCP clients (project-standing.js).
  const standing = ({ body }) => { const { canDelete, ...rest } = body.permissions; return rest; };
  assert.deepEqual(standing(asManager), { canEditPlan: true, canManage: true, canManageMembers: false, projectRole: 'manager', workspaceRole: 'user' });
  assert.deepEqual(standing(asEditor), { canEditPlan: true, canManage: false, canManageMembers: false, projectRole: 'editor', workspaceRole: 'user' });
  assert.deepEqual(standing(asTenantManager), { canEditPlan: true, canManage: true, canManageMembers: false, projectRole: null, workspaceRole: 'manager' });
});

test('editors and tenant managers without a project role cannot delete; outsiders get 404', async () => {
  const { app, auth } = await createDeletionTestApp();
  const editor = await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-editor']);
  assert.equal(editor.status, 403);
  const tenantManager = await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-tenant-manager']);
  assert.equal(tenantManager.status, 403);
  // The project manager has no role on project-beta, so it does not exist for them.
  const outsider = await request(app).delete('/api/projects/project-beta').set('Authorization', auth['user-project-manager']);
  assert.equal(outsider.status, 404);
  assert.deepEqual(await listProjectIds(app, auth['user-admin']), ['project-alpha', 'project-beta']);
});

test('a project manager soft-deletes a project; it disappears from lists, detail, tickets and search', async () => {
  const { app, auditEvents, auth, liveEventBus, projectRepository } = await createDeletionTestApp();
  const refreshed = await request(app).post('/api/reporting/search/refresh').set('Authorization', auth['user-admin']);
  assert.equal(refreshed.status, 200);
  const searchBefore = await request(app).get('/api/reporting/search?query=onboarding').set('Authorization', auth['user-admin']);
  assert.ok(searchBefore.body.records.some((record) => record.projectId === 'project-alpha'));

  const events = [];
  liveEventBus.subscribe(LIVE_EVENT_CHANNELS.project('project-alpha'), (event) => events.push(event));

  const deleted = await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-project-manager']);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.project.id, 'project-alpha');
  assert.equal(deleted.body.project.deletedBy, 'user-project-manager');
  assert.ok(deleted.body.project.deletedAt);

  assert.deepEqual(await listProjectIds(app, auth['user-admin']), ['project-beta']);
  assert.deepEqual(await listProjectIds(app, auth['user-editor']), ['project-beta']);
  assert.equal((await request(app).get('/api/projects/project-alpha').set('Authorization', auth['user-admin'])).status, 404);
  assert.equal((await request(app).get('/api/projects/project-alpha/tickets').set('Authorization', auth['user-admin'])).status, 404);
  assert.equal((await request(app).get('/api/projects/project-alpha/export').set('Authorization', auth['user-admin'])).status, 404);
  const edit = { description: 'Edited after delete.', endDate: null, expectedUpdatedAt: '2026-05-12T08:30:00.000Z', name: 'Alpha Launch', startDate: null, status: 'In Progress' };
  assert.equal((await request(app).put('/api/projects/project-alpha').set('Authorization', auth['user-admin']).send(edit)).status, 404);
  assert.equal((await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-admin'])).status, 404);

  const tickets = await request(app).get('/api/projects/tickets').set('Authorization', auth['user-admin']);
  assert.equal(tickets.status, 200);
  assert.deepEqual(tickets.body.tickets.map((ticket) => ticket.id), ['ticket-beta']);
  const scopedTickets = await request(app).get('/api/projects/tickets?projectIds=project-alpha').set('Authorization', auth['user-admin']);
  assert.deepEqual(scopedTickets.body.tickets, []);

  const searchScoped = await request(app).get('/api/reporting/search?query=onboarding&projectId=project-alpha').set('Authorization', auth['user-admin']);
  assert.equal(searchScoped.status, 404);
  const searchAfter = await request(app).get('/api/reporting/search?query=onboarding').set('Authorization', auth['user-admin']);
  assert.equal(searchAfter.body.records.some((record) => record.projectId === 'project-alpha'), false);
  await request(app).post('/api/reporting/search/refresh').set('Authorization', auth['user-admin']);
  const reindexed = await request(app).get('/api/reporting/search?query=onboarding').set('Authorization', auth['user-admin']);
  assert.equal(reindexed.body.records.some((record) => record.projectId === 'project-alpha'), false);

  // Nothing is hard-deleted: the project and its items are kept for restore.
  assert.equal(projectRepository.state.deletedProjects[0].project.tickets[0].id, 'ticket-alpha');

  const audit = auditEvents.find((event) => event.action === 'http.delete./api/projects/:projectId');
  assert.ok(audit, 'delete is audited');
  assert.equal(audit.projectId, 'project-alpha');
  assert.equal(audit.result, 'success:200');
  assert.deepEqual(audit.detail.after, { deleted: true, deletedAt: deleted.body.project.deletedAt, projectName: 'Alpha Launch' });

  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'project-deleted');
  assert.equal(events[0].actor.id, 'user-project-manager');
});

test('a project under legal hold cannot be deleted (423) until the hold is released', async () => {
  const { app, auth } = await createDeletionTestApp();
  const hold = await request(app)
    .post('/api/compliance/legal-holds')
    .set('Authorization', auth['user-admin'])
    .send({ reason: 'Preserve the project record for litigation.', resourceId: 'project-alpha', resourceType: 'project' });
  assert.equal(hold.status, 201);

  const blocked = await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-admin']);
  assert.equal(blocked.status, 423);
  assert.deepEqual(await listProjectIds(app, auth['user-admin']), ['project-alpha', 'project-beta']);

  await request(app)
    .post(`/api/compliance/legal-holds/${hold.body.value.id}/release`)
    .set('Authorization', auth['user-admin'])
    .send({ expectedVersion: 1, reason: 'The project preservation duty has ended.' });
  assert.equal((await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-admin'])).status, 200);
});

test('tenant admins list and restore deleted projects; others cannot', async () => {
  const { app, auditEvents, auth } = await createDeletionTestApp();
  assert.equal((await request(app).delete('/api/projects/project-alpha').set('Authorization', auth['user-admin'])).status, 200);

  for (const userId of ['user-tenant-manager', 'user-project-manager', 'user-editor']) {
    assert.equal((await request(app).get('/api/projects/deleted').set('Authorization', auth[userId])).status, 403);
    assert.equal((await request(app).post('/api/projects/project-alpha/restore').set('Authorization', auth[userId])).status, 403);
  }

  const listed = await request(app).get('/api/projects/deleted').set('Authorization', auth['user-admin']);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.projects.length, 1);
  assert.equal(listed.body.projects[0].id, 'project-alpha');
  assert.equal(listed.body.projects[0].name, 'Alpha Launch');
  assert.equal(listed.body.projects[0].deletedByName, 'Ada Admin');

  const restored = await request(app).post('/api/projects/project-alpha/restore').set('Authorization', auth['user-admin']);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.project.name, 'Alpha Launch');
  assert.ok(auditEvents.some((event) => event.action === 'http.post./api/projects/:projectId/restore' && event.result === 'success:200'));

  assert.deepEqual(await listProjectIds(app, auth['user-editor']), ['project-alpha', 'project-beta']);
  const detail = await request(app).get('/api/projects/project-alpha').set('Authorization', auth['user-editor']);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.project.tickets[0].id, 'ticket-alpha');
  assert.deepEqual((await request(app).get('/api/projects/deleted').set('Authorization', auth['user-admin'])).body.projects, []);
  assert.equal((await request(app).post('/api/projects/project-alpha/restore').set('Authorization', auth['user-admin'])).status, 404);
  assert.equal((await request(app).post('/api/projects/project-beta/restore').set('Authorization', auth['user-admin'])).status, 404);
});

function createFakeMysqlPool({ affectedRows = 1, columns = true } = {}) {
  const statements = [];
  const execute = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push({ params, sql: text });
    if (/information_schema/i.test(text)) return [[{ count: columns ? 1 : 0 }]];
    if (/^UPDATE projects/i.test(text)) return [{ affectedRows }];
    return [[]];
  };
  return { execute, getConnection: async () => ({ execute, query: execute, release() {} }), query: execute, statements };
}

test('MySQL soft-delete schema adds metadata columns and normalizes the legacy flag', async () => {
  const fresh = createFakeMysqlPool({ columns: false });
  await ensureMysqlProjectSoftDeleteSchema(fresh);
  const ddl = fresh.statements.map((statement) => statement.sql).filter((sql) => !/information_schema/i.test(sql));
  assert.deepEqual(ddl, [
    'ALTER TABLE projects ADD COLUMN deleted INT NULL DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN deleted_at DATETIME(3) NULL',
    'ALTER TABLE projects ADD COLUMN deleted_by VARCHAR(100) NULL',
    'CREATE INDEX idx_projects_deleted ON projects (deleted)',
    'ALTER TABLE projects ALTER COLUMN deleted SET DEFAULT 0',
    'UPDATE projects SET deleted = 0 WHERE deleted IS NULL',
    'UPDATE projects SET deleted = 1 WHERE deleted NOT IN (0, 1)',
  ]);

  const existing = createFakeMysqlPool({ columns: true });
  await ensureMysqlProjectSoftDeleteSchema(existing);
  assert.equal(existing.statements.some((statement) => /ADD COLUMN|CREATE INDEX/.test(statement.sql)), false);
});

test('MySQL project reads filter deleted projects and delete only marks the row', async () => {
  const pool = createFakeMysqlPool();
  const repository = createMysqlProjectsRepository({ pool });
  const user = { id: 'user-admin', memberships: [{ role: 'admin', tenantId: TENANT }] };

  await repository.listProjectsForTenant({ tenantId: TENANT, user });
  await repository.getProjectAccess({ projectId: 'project-alpha', tenantId: TENANT, userId: user.id });
  await repository.getProjectDetail({ projectId: 'project-alpha', tenantId: TENANT });
  const projectReads = pool.statements.filter((statement) => /FROM projects p\b/.test(statement.sql));
  assert.equal(projectReads.length, 3);
  assert.ok(projectReads.every((statement) => statement.sql.includes('COALESCE(p.deleted, 0) = 0')));

  pool.statements.length = 0;
  await repository.softDeleteProject({ projectId: 'project-alpha', tenantId: TENANT, user });
  const writes = pool.statements.filter((statement) => /^(UPDATE|DELETE|INSERT)/i.test(statement.sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /^UPDATE projects SET deleted = 1, deleted_at = NOW\(3\), deleted_by = \?/);
  assert.match(writes[0].sql, /COALESCE\(deleted, 0\) = 0$/);
  assert.deepEqual(writes[0].params, ['user-admin', 'project-alpha', TENANT]);

  const missing = createMysqlProjectsRepository({ pool: createFakeMysqlPool({ affectedRows: 0 }) });
  assert.equal(await missing.softDeleteProject({ projectId: 'project-alpha', tenantId: TENANT, user }), null);
  assert.equal(await missing.restoreDeletedProject({ projectId: 'project-alpha', tenantId: TENANT, user }), null);
});
