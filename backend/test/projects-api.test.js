import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import request from 'supertest';
import JSZip from 'jszip';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const activeTestServers = new Set();

async function listenForTest(app) {
  const server = http.createServer(app);
  server.locals = app.locals;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  activeTestServers.add(server);
  return server;
}

test.afterEach(async () => {
  const servers = [...activeTestServers]; activeTestServers.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(resolve); server.closeAllConnections?.();
  })));
});

async function createProjectsTestApp({ projects } = {}) {
  const storedFiles = new Map();
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [
      {
        domains: ['acme.com'],
        id: 'tenant-acme',
        name: 'Acme Delivery',
      },
    ],
    users: [
      {
        authMethod: 'basic',
        email: 'grace@acme.com',
        id: 'user-grace',
        memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
        name: 'Grace Hopper',
        password: 'Secret123!',
        preferences: { twoFactorEnabled: false },
      },
      {
        authMethod: 'basic',
        email: 'alan@acme.com',
        id: 'user-alan',
        memberships: [{ role: 'user', tenantId: 'tenant-acme' }],
        name: 'Alan Turing',
        password: 'Secret123!',
        preferences: { twoFactorEnabled: false },
      },
    ],
  });
  const projectsRepository = createInMemoryProjectsRepository({
    authRepository,
    fileStorage: {
      async delete(fileId) {
        storedFiles.delete(fileId);
      },
      async read(fileId) {
        const bytes = storedFiles.get(fileId) ?? Buffer.alloc(0);
        return {
          bytes,
          size: bytes.length,
        };
      },
      async write(fileId, bytes) {
        storedFiles.set(fileId, bytes);
      },
    },
    seed: {
      projects: projects ?? [
        {
          createdAt: '2026-05-01T10:00:00.000Z',
          description: 'Rebuild the onboarding and activation funnel.',
          endDate: '2026-07-15',
          id: 'project-launch',
          name: 'Launch Readiness',
          rank: 1,
          role: 'admin',
          startDate: '2026-05-10',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          updatedAt: '2026-05-12T08:30:00.000Z',
          epics: [
            {
              description: 'Stabilize intake and ownership.',
              id: 'epic-intake',
              name: 'Intake Workflow',
              points: 13,
              priority: 1,
              progress: 62.5,
              status: 'In Progress',
              stories: [
                {
                  assigneeId: 'user-grace',
                  assigneeName: 'Grace Hopper',
                  description: 'Create assignment automation.',
                  id: 'story-routing',
                  name: 'Routing Rules',
                  progress: 50,
                  status: 'In Progress',
                  tasks: [
                    {
                      assigneeId: 'user-grace',
                      assigneeName: 'Grace Hopper',
                      description: 'Document assignment conditions.',
                      id: 'task-rules',
                      name: 'Define routing logic',
                      progress: 100,
                      status: 'Completed',
                    },
                    {
                      assigneeId: 'user-grace',
                      assigneeName: 'Grace Hopper',
                      description: 'Add fallback owner selection.',
                      id: 'task-owner',
                      name: 'Fallback ownership',
                      progress: 0,
                      status: 'Not Started',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          createdAt: '2026-04-01T10:00:00.000Z',
          description: 'Prepare backlog cleanup for the following quarter.',
          endDate: '2026-08-01',
          id: 'project-backlog',
          name: 'Backlog Reset',
          rank: 2,
          role: 'admin',
          startDate: '2026-06-01',
          status: 'Planned',
          tenantId: 'tenant-acme',
          updatedAt: '2026-05-11T08:30:00.000Z',
          epics: [],
        },
      ],
    },
  });
  const tokenService = createTokenService({
    issuer: 'odinpmp-test',
    secret: 'test-secret',
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const assistantRepository = createInMemoryAssistantRepository();
  const complianceRepository = createInMemoryComplianceRepository();
  const app = await listenForTest(createApp({
    assistantRepository,
    authRepository,
    complianceRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    googleOAuthClient: {
      getAuthorizationUrl() {
        return 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client';
      },
      async getUserInfoFromCode() {
        return {
          email: 'google.user@example.com',
          name: 'Google User',
        };
      },
    },
    projectAiService: {
      async analyzeProject({ project }) {
        return {
          analysis: `Analysis for ${project.name}`,
          provider: 'fallback',
        };
      },
      async generateStructure({ project }) {
        return {
          epics: [
            {
              description: `Generated epic for ${project.name}`,
              name: 'Generated Execution Plan',
              stories: [
                {
                  description: 'Generated story',
                  name: 'Generated Story',
                  tasks: [
                    {
                      description: 'Generated task',
                      name: 'Generated Task',
                    },
                  ],
                },
              ],
            },
          ],
          provider: 'fallback',
        };
      },
      async enhanceDescription({ description, project }) {
        return {
          provider: 'fallback',
          suggestions: [
            `Sharper version of ${project.name}: ${description}`,
          ],
        };
      },
    },
    projectRepository: projectsRepository,
    sessionsRepository,
    tokenService,
  }));
  const token = tokenService.signSessionToken({
    email: 'grace@acme.com',
    id: 'user-grace',
    name: 'Grace Hopper',
    preferences: { twoFactorEnabled: false },
    role: 'admin',
    scopes: ['Ttenant-acme-admin'],
    tenantId: 'tenant-acme',
  });
  const memberToken = tokenService.signSessionToken({
    email: 'alan@acme.com',
    id: 'user-alan',
    name: 'Alan Turing',
    preferences: { twoFactorEnabled: false },
    role: 'user',
    scopes: ['Ttenant-acme-user'],
    tenantId: 'tenant-acme',
  });

  const tokenExpiry = tokenService.verifySessionToken(token);
  await sessionsRepository.createSession({
    expiryDate: new Date(tokenExpiry.exp * 1000),
    ipAddr: '127.0.0.1',
    locationName: 'Localhost',
    token,
    userAgent: 'test-agent',
    userId: 'user-grace',
  });

  const memberExpiry = tokenService.verifySessionToken(memberToken);
  await sessionsRepository.createSession({
    expiryDate: new Date(memberExpiry.exp * 1000),
    ipAddr: '127.0.0.1',
    locationName: 'Localhost',
    token: memberToken,
    userAgent: 'test-agent',
    userId: 'user-alan',
  });

  return {
    assistantRepository,
    app,
    memberToken,
    projectsRepository,
    storedFiles,
    token,
  };
}

test('GET /api/projects returns the tenant project list for the signed-in user', async () => {
  const { app, token } = await createProjectsTestApp();

  const response = await request(app)
    .get('/api/projects')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.projects.length, 2);
  assert.equal(response.body.projects[0].name, 'Launch Readiness');
  assert.equal(response.body.projects[0].role, 'admin');
});

test('GET /api/projects/:projectId returns the nested project detail tree', async () => {
  const { app, token } = await createProjectsTestApp();

  const response = await request(app)
    .get('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.project.name, 'Launch Readiness');
  assert.equal(response.body.project.epics.length, 1);
  assert.equal(response.body.project.epics[0].stories[0].tasks.length, 2);
  assert.equal(response.body.project.epics[0].stories[0].tasks[0].status, 'Completed');
});

test('PUT /api/projects/:projectId/assistant-brief updates the stored rich brief without clobbering other assistant state', async () => {
  const { app, assistantRepository, token } = await createProjectsTestApp();

  await assistantRepository.saveProjectAssistantState({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
    value: {
      artifacts: [{ id: 'artifact-1', name: 'Discovery Notes', type: 'brief' }],
      brief: {
        committedAt: '2026-05-20T10:00:00.000Z',
        name: 'Launch Readiness',
        narrative: 'Legacy short brief.',
        objective: 'Legacy objective.',
        sourceSessionId: 'session-123',
      },
      updatedAt: '2026-05-20T10:00:00.000Z',
    },
  });
  await assistantRepository.createProjectStakeholder({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
    value: {
      email: 'sponsor@example.com',
      name: 'Executive Sponsor',
      roleTitle: 'Sponsor',
    },
  });
  await assistantRepository.syncProjectClarifications({
    clarifications: [{
      assignments: [],
      blockingArea: 'scope',
      currentAnswer: '',
      id: 'clar-1',
      linkedSection: 'brief',
      prompt: 'Confirm the launch owner.',
      status: 'open',
      updatedAt: '2026-05-20T10:00:00.000Z',
    }],
    projectId: 'project-launch',
    stakeholderContacts: [],
    tenantId: 'tenant-acme',
  });

  const response = await request(app)
    .put('/api/projects/project-launch/assistant-brief')
    .set('Authorization', `Bearer ${token}`)
    .send({
      assumptions: ['Launch sequencing stays manual in v1.'],
      benefits: 'Keeps the committed brief editable without touching the short description.',
      constraints: ['Do not overwrite the short project description.'],
      currentState: 'Launch planning exists, but the stored brief needs a richer editable surface.',
      dependencies: ['Stakeholder sign-off'],
      implementationEffort: 'Medium',
      name: 'Launch Readiness Rich Brief',
      objective: 'Separate the rich brief from the short project description.',
      proposedSolution: 'Persist and edit the structured brief in assistant project state.',
      requirements: ['Render the rich brief across project and assistant surfaces.'],
      stakeholders: ['Executive Sponsor'],
      successMetrics: ['Committed rich brief stays visible after reload.'],
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.project.assistantState.brief.name, 'Launch Readiness Rich Brief');
  assert.equal(response.body.project.assistantState.brief.objective, 'Separate the rich brief from the short project description.');
  assert.equal(response.body.project.assistantState.brief.sourceSessionId, 'session-123');
  assert.equal(response.body.project.assistantState.brief.committedAt, '2026-05-20T10:00:00.000Z');
  assert.equal(response.body.project.assistantState.artifacts.length, 1);
  assert.equal(response.body.project.assistantState.clarifications.length, 1);
  assert.equal(response.body.project.assistantState.stakeholders.length, 1);
  assert.equal(response.body.project.description, 'Rebuild the onboarding and activation funnel.');
});

test('POST /api/projects creates a new project for the signed-in tenant', async () => {
  const { app, token } = await createProjectsTestApp();

  const response = await request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({
      description: 'Replace the legacy admin dashboard.',
      endDate: '2026-09-15',
      name: 'Admin Rebuild',
      startDate: '2026-06-01',
      status: 'Planned',
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.project.name, 'Admin Rebuild');
  assert.equal(response.body.project.tenantId, 'tenant-acme');
  assert.equal(response.body.project.role, 'admin');
  assert.deepEqual(response.body.project.epics, []);
});

test('PUT /api/projects/:projectId updates project metadata', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();

  const response = await request(app)
    .put('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`)
    .send({
      description: 'Rebuild the onboarding and activation funnel with clearer ownership.',
      endDate: '2026-08-01',
      name: 'Launch Readiness Revamp',
      startDate: '2026-05-15',
      status: 'At Risk',
      expectedUpdatedAt: '2026-05-12T08:30:00.000Z',
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.project.name, 'Launch Readiness Revamp');
  assert.equal(response.body.project.status, 'At Risk');
  assert.equal(response.body.project.description, 'Rebuild the onboarding and activation funnel with clearer ownership.');
  const savedProject = await projectsRepository.getProjectDetail({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
  });
  assert.equal(savedProject.name, 'Launch Readiness Revamp');
  assert.equal(savedProject.endDate, '2026-08-01');
});

test('PUT /api/projects/:projectId normalizes rich html descriptions into markdown storage', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();

  const response = await request(app)
    .put('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`)
    .send({
      description: '<h2>Summary</h2><p>Hello <strong>world</strong>.</p><ul><li>One</li><li>Two</li></ul>',
      endDate: '2026-08-01',
      name: 'Launch Readiness Revamp',
      startDate: '2026-05-15',
      status: 'At Risk',
      expectedUpdatedAt: '2026-05-12T08:30:00.000Z',
    });

  assert.equal(response.status, 200);
  assert.match(response.body.project.description, /^## Summary/m);
  assert.match(response.body.project.description, /Hello \*\*world\*\*\./);
  assert.match(response.body.project.description, /^-\s+One/m);
  assert.doesNotMatch(response.body.project.description, /<p>|<h2>|<ul>|<li>/);

  const savedProject = await projectsRepository.getProjectDetail({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
  });

  assert.match(savedProject.description, /^## Summary/m);
  assert.doesNotMatch(savedProject.description, /<p>|<h2>|<ul>|<li>/);
});

test('project metadata and tree writes reject stale optimistic-concurrency versions', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();
  const staleVersion = '2026-05-11T08:30:00.000Z';
  const metadataResponse = await request(app)
    .put('/api/projects/project-launch')
    .set('Authorization', `Bearer ${token}`)
    .send({
      description: 'Stale edit', endDate: '2026-08-01', expectedUpdatedAt: staleVersion,
      name: 'Stale name', startDate: '2026-05-15', status: 'At Risk',
    });
  assert.equal(metadataResponse.status, 409);
  assert.equal(metadataResponse.body.details.code, 'project_version_conflict');

  const treeResponse = await request(app)
    .put('/api/projects/project-launch/tree')
    .set('Authorization', `Bearer ${token}`)
    .send({ epics: [], expectedUpdatedAt: staleVersion });
  assert.equal(treeResponse.status, 409);
  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.equal(project.name, 'Launch Readiness');
  assert.equal(project.epics.length, 1);
});

test('PUT /api/projects/:projectId/tree replaces the nested project tree and returns the refreshed detail', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();

  const response = await request(app)
    .put('/api/projects/project-launch/tree')
    .set('Authorization', `Bearer ${token}`)
    .send({
      expectedUpdatedAt: '2026-05-12T08:30:00.000Z',
      epics: [
        {
          description: 'Lock down onboarding and reporting.',
          name: 'Execution',
          points: 21,
          priority: 1,
          status: 'In Progress',
          stories: [
            {
              assigneeId: 'user-grace',
              assigneeName: 'Grace Hopper',
              description: 'Route work through the new workflow.',
              name: 'Workflow Routing',
              status: 'In Progress',
              tasks: [
                {
                  assigneeId: 'user-grace',
                  assigneeName: 'Grace Hopper',
                  description: 'Define the migration checklist.',
                  name: 'Checklist',
                  status: 'Completed',
                },
                {
                  description: 'Verify the dashboard handoff.',
                  name: 'Handoff review',
                  status: 'Not Started',
                },
              ],
            },
          ],
        },
      ],
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.project.epics.length, 1);
  assert.equal(response.body.project.epics[0].name, 'Execution');
  assert.equal(response.body.project.epics[0].stories[0].tasks.length, 2);
  assert.match(response.body.project.epics[0].stories[0].tasks[1].id, /[a-f0-9-]{8,}/i);

  const savedProject = await projectsRepository.getProjectDetail({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
  });
  assert.equal(savedProject.epics[0].stories[0].tasks[0].name, 'Checklist');
  assert.equal(savedProject.epics[0].stories[0].tasks[1].name, 'Handoff review');
});

test('PUT /api/projects/:projectId/tree normalizes nested rich html descriptions into markdown storage', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();

  const response = await request(app)
    .put('/api/projects/project-launch/tree')
    .set('Authorization', `Bearer ${token}`)
    .send({
      expectedUpdatedAt: '2026-05-12T08:30:00.000Z',
      epics: [
        {
          description: '<h2>Epic Summary</h2><p>Lock down onboarding and reporting.</p>',
          name: 'Execution',
          priority: 1,
          status: 'In Progress',
          stories: [
            {
              description: '<h3>Story Summary</h3><p>Route work through the new workflow.</p>',
              name: 'Workflow Routing',
              status: 'In Progress',
              tasks: [
                {
                  description: '<p><strong>Checklist</strong> for migration.</p>',
                  name: 'Checklist',
                  status: 'Completed',
                },
              ],
            },
          ],
        },
      ],
    });

  assert.equal(response.status, 200);
  assert.match(response.body.project.epics[0].description, /^## Epic Summary/m);
  assert.match(response.body.project.epics[0].stories[0].description, /^### Story Summary/m);
  assert.match(response.body.project.epics[0].stories[0].tasks[0].description, /\*\*Checklist\*\* for migration\./);

  const savedProject = await projectsRepository.getProjectDetail({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
  });

  assert.match(savedProject.epics[0].description, /^## Epic Summary/m);
  assert.match(savedProject.epics[0].stories[0].description, /^### Story Summary/m);
  assert.match(savedProject.epics[0].stories[0].tasks[0].description, /\*\*Checklist\*\* for migration\./);
});

test('POST /api/projects/:projectId/ai/enhance-description returns suggestions for the project description', async () => {
  const { app, token } = await createProjectsTestApp();

  const response = await request(app)
    .post('/api/projects/project-launch/ai/enhance-description')
    .set('Authorization', `Bearer ${token}`)
    .send({
      description: 'Rebuild the onboarding and activation funnel.',
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.provider, 'fallback');
  assert.equal(response.body.suggestions.length, 1);
  assert.match(response.body.suggestions[0], /Launch Readiness/i);
});

test('POST /api/projects/:projectId/ai/analyze returns a project analysis summary', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();
  const project = await projectsRepository.getProjectDetail({
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
  });

  const response = await request(app)
    .post('/api/projects/project-launch/ai/analyze')
    .set('Authorization', `Bearer ${token}`)
    .send({
      project,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.provider, 'fallback');
  assert.equal(response.body.analysis, 'Analysis for Launch Readiness');
});

test('POST /api/projects/:projectId/ai/generate-structure returns generated starter structure', async () => {
  const { app, token, projectsRepository } = await createProjectsTestApp();
  const project = await projectsRepository.getProjectDetail({
    projectId: 'project-backlog',
    tenantId: 'tenant-acme',
  });

  const response = await request(app)
    .post('/api/projects/project-backlog/ai/generate-structure')
    .set('Authorization', `Bearer ${token}`)
    .send({
      project,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.provider, 'fallback');
  assert.equal(response.body.epics.length, 1);
  assert.equal(response.body.epics[0].stories[0].tasks[0].name, 'Generated Task');
});

test('GET /api/projects/:projectId/mentionables returns tenant users for mentions', async () => {
  const { app, token } = await createProjectsTestApp();

  const response = await request(app)
    .get('/api/projects/project-launch/mentionables?query=alan')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.users.length, 1);
  assert.equal(response.body.users[0].name, 'Alan Turing');
});

test('comments support rich HTML, mentions, replies, and owner/admin rules', async () => {
  const { app, memberToken, token } = await createProjectsTestApp();

  const createResponse = await request(app)
    .post('/api/projects/project-launch/comments')
    .set('Authorization', `Bearer ${memberToken}`)
    .send({
      comment: '<p>Hello <span class="mention" data-userid="user-grace">@Grace Hopper</span><script>alert(1)</script></p>',
      targetId: 'story-routing',
      targetType: 'story',
    });

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.ok, true);
  assert.match(createResponse.body.comment.comment, /data-user-id="user-grace"/);
  assert.doesNotMatch(createResponse.body.comment.comment, /script/i);

  const replyResponse = await request(app)
    .post('/api/projects/project-launch/comments')
    .set('Authorization', `Bearer ${token}`)
    .send({
      comment: '<p>Reply received.</p>',
      parentId: createResponse.body.comment.id,
      targetId: 'story-routing',
      targetType: 'story',
    });

  assert.equal(replyResponse.status, 201);

  const listResponse = await request(app)
    .get('/api/projects/project-launch/comments?targetId=story-routing&targetType=story')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(listResponse.status, 200, JSON.stringify(listResponse.body));
  assert.equal(listResponse.body.comments.length, 1);
  assert.equal(listResponse.body.comments[0].children.length, 1);

  const forbiddenEditResponse = await request(app)
    .put(`/api/projects/project-launch/comments/${createResponse.body.comment.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      comment: '<p>Admin should not edit another user comment.</p>',
    });

  assert.equal(forbiddenEditResponse.status, 403);

  const ownerEditResponse = await request(app)
    .put(`/api/projects/project-launch/comments/${createResponse.body.comment.id}`)
    .set('Authorization', `Bearer ${memberToken}`)
    .send({
      comment: '<p>Edited by owner.</p>',
    });

  assert.equal(ownerEditResponse.status, 200);
  assert.match(ownerEditResponse.body.comment.comment, /Edited by owner/);

  const ownerDeleteResponse = await request(app)
    .delete(`/api/projects/project-launch/comments/${createResponse.body.comment.id}`)
    .set('Authorization', `Bearer ${memberToken}`);

  assert.equal(ownerDeleteResponse.status, 403);

  const adminDeleteResponse = await request(app)
    .delete(`/api/projects/project-launch/comments/${createResponse.body.comment.id}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(adminDeleteResponse.status, 200);

  const afterDeleteResponse = await request(app)
    .get('/api/projects/project-launch/comments?targetId=story-routing&targetType=story')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(afterDeleteResponse.status, 200);
  assert.equal(afterDeleteResponse.body.comments.length, 0);
});

test('comment votes can be toggled and switched between up/down', async () => {
  const { app, memberToken, token } = await createProjectsTestApp();

  const createResponse = await request(app)
    .post('/api/projects/project-launch/comments')
    .set('Authorization', `Bearer ${memberToken}`)
    .send({
      comment: '<p>Vote on this.</p>',
      targetId: 'story-routing',
      targetType: 'story',
    });

  assert.equal(createResponse.status, 201);

  const commentId = createResponse.body.comment.id;

  const upvoteResponse = await request(app)
    .post(`/api/projects/project-launch/comments/${commentId}/vote`)
    .set('Authorization', `Bearer ${token}`)
    .send({ vote: 'up' });

  assert.equal(upvoteResponse.status, 200);
  assert.equal(upvoteResponse.body.ok, true);
  assert.equal(upvoteResponse.body.vote.upvotes, 1);
  assert.equal(upvoteResponse.body.vote.downvotes, 0);

  const toggleResponse = await request(app)
    .post(`/api/projects/project-launch/comments/${commentId}/vote`)
    .set('Authorization', `Bearer ${token}`)
    .send({ vote: 'up' });

  assert.equal(toggleResponse.status, 200);
  assert.equal(toggleResponse.body.vote.upvotes, 0);
  assert.equal(toggleResponse.body.vote.downvotes, 0);

  const downvoteResponse = await request(app)
    .post(`/api/projects/project-launch/comments/${commentId}/vote`)
    .set('Authorization', `Bearer ${token}`)
    .send({ vote: 'down' });

  assert.equal(downvoteResponse.status, 200);
  assert.equal(downvoteResponse.body.vote.upvotes, 0);
  assert.equal(downvoteResponse.body.vote.downvotes, 1);

  const switchResponse = await request(app)
    .post(`/api/projects/project-launch/comments/${commentId}/vote`)
    .set('Authorization', `Bearer ${token}`)
    .send({ vote: 'up' });

  assert.equal(switchResponse.status, 200);
  assert.equal(switchResponse.body.vote.upvotes, 1);
  assert.equal(switchResponse.body.vote.downvotes, 0);
});

test('project valid users payload returns tenant and project member data', async () => {
  const { app, token } = await createProjectsTestApp();

  const initialResponse = await request(app)
    .get('/api/projects/project-launch/valid-users')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(initialResponse.status, 200);
  assert.equal(initialResponse.body.ok, true);
  assert.equal(initialResponse.body.tenant_users.length, 2);
  assert.equal(Array.isArray(initialResponse.body.project_users), true);

  const updateResponse = await request(app)
    .put('/api/projects/project-launch/permissions')
    .set('Authorization', `Bearer ${token}`)
    .send({
      validUsers: [
        {
          id: 'user-alan',
          role: 'manager',
          project_allocation: 0.5,
          project_bill_rate: 150,
        },
      ],
    });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.ok, true);

  const afterResponse = await request(app)
    .get('/api/projects/project-launch/valid-users')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(afterResponse.status, 200);
  assert.equal(afterResponse.body.project_users.length, 1);
  assert.equal(afterResponse.body.project_users[0].id, 'user-alan');
  assert.equal(afterResponse.body.project_users[0].role, 'manager');
});

test('vault routes store, list, retrieve, and delete binary files', async () => {
  const { app, storedFiles, token } = await createProjectsTestApp();
  const fileContents = Buffer.from('inline-image-bytes');

  const uploadResponse = await request(app)
    .post('/api/projects/project-launch/files')
    .set('Authorization', `Bearer ${token}`)
    .send({
      fileContentsBase64: fileContents.toString('base64'),
      fileDescription: 'Embedded screenshot',
      fileName: 'screenshot.png',
      fileType: 'image/png',
      inlineImage: true,
      targetId: 'story-routing',
      targetType: 'story',
    });

  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadResponse.body.ok, true);
  assert.equal(uploadResponse.body.file.fileName, 'screenshot.png');
  assert.equal(uploadResponse.body.file.inlineImage, true);
  assert.equal(storedFiles.size, 1);

  const listResponse = await request(app)
    .get('/api/projects/project-launch/files?targetId=story-routing&targetType=story')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(listResponse.status, 200, JSON.stringify(listResponse.body));
  assert.equal(listResponse.body.files.length, 1);
  assert.equal(listResponse.body.files[0].description, 'Embedded screenshot');

  const projectListResponse = await request(app)
    .get('/api/projects/project-launch/files?targetId=project-launch&targetType=project')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(projectListResponse.status, 200);
  assert.equal(projectListResponse.body.files.length, 1);
  assert.equal(projectListResponse.body.files[0].targetId, 'story-routing');

  const contentResponse = await request(app)
    .get(`/api/files/${uploadResponse.body.file.id}/content`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers['content-type'], 'image/png');
  assert.deepEqual(contentResponse.body, fileContents);

  const deleteResponse = await request(app)
    .delete(`/api/files/${uploadResponse.body.file.id}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(deleteResponse.status, 200);
  assert.equal(storedFiles.size, 0);
});

test('vault deletion preserves files under file or project legal hold', async () => {
  const { app, storedFiles, token } = await createProjectsTestApp();
  const uploadResponse = await request(app)
    .post('/api/projects/project-launch/files')
    .set('Authorization', `Bearer ${token}`)
    .send({
      fileContentsBase64: Buffer.from('held-file').toString('base64'),
      fileDescription: 'Held evidence',
      fileName: 'evidence.txt',
      fileType: 'text/plain',
      targetId: 'project-launch',
      targetType: 'project',
    });
  const hold = await request(app).post('/api/compliance/legal-holds').set('Authorization', `Bearer ${token}`).send({ reason: 'Preserve this file as legal evidence.', resourceId: uploadResponse.body.file.id, resourceType: 'file' });
  assert.equal(hold.status, 201);

  const blocked = await request(app)
    .delete(`/api/files/${uploadResponse.body.file.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(blocked.status, 423); assert.equal(storedFiles.size, 1);
  await request(app).post(`/api/compliance/legal-holds/${hold.body.value.id}/release`).set('Authorization', `Bearer ${token}`).send({ expectedVersion: 1, reason: 'The legal preservation duty has ended.' });
  assert.equal((await request(app).delete(`/api/files/${uploadResponse.body.file.id}`).set('Authorization', `Bearer ${token}`)).status, 200);
  assert.equal(storedFiles.size, 0);
});

test('project item APIs enforce optimistic versions and support immutable revision restoration', async () => {
  const { app, token } = await createProjectsTestApp();

  const created = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send({
      item: { description: 'New execution task.', name: 'Execute routing test', status: 'Not Started' },
      itemType: 'task',
      parentId: 'story-routing',
    });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.item.version, 1);
  const itemId = created.body.item.id;

  const updated = await request(app)
    .patch(`/api/projects/project-launch/items/${itemId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 1, patch: { name: 'Execute routing integration test', status: 'In Progress' } });

  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.item.name, 'Execute routing integration test');
  assert.equal(updated.body.item.version, 2);

  const stale = await request(app)
    .patch(`/api/projects/project-launch/items/${itemId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 1, patch: { name: 'Stale overwrite' } });

  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'project_item_version_conflict');

  const history = await request(app)
    .get(`/api/projects/project-launch/items/${itemId}/revisions`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(history.status, 200);
  assert.equal(history.body.revisions.length, 2);
  const updateRevision = history.body.revisions.find((revision) => revision.action === 'update');
  assert.equal(updateRevision.before.node.name, 'Execute routing test');
  assert.equal(updateRevision.after.node.name, 'Execute routing integration test');

  const undone = await request(app)
    .post(`/api/projects/project-launch/items/${itemId}/restore`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 2, revisionId: updateRevision.id, state: 'before' });

  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.item.name, 'Execute routing test');
  assert.equal(undone.body.item.version, 3);

  const deleted = await request(app)
    .delete(`/api/projects/project-launch/items/${itemId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 3 });

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.revision.versionAfter, 4);

  const afterDeleteHistory = await request(app)
    .get(`/api/projects/project-launch/items/${itemId}/revisions`)
    .set('Authorization', `Bearer ${token}`);
  const deleteRevision = afterDeleteHistory.body.revisions.find((revision) => revision.action === 'delete');

  const restored = await request(app)
    .post(`/api/projects/project-launch/items/${itemId}/restore`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 4, revisionId: deleteRevision.id, state: 'before' });

  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.item.id, itemId);
  assert.equal(restored.body.item.version, 5);
  assert.equal(restored.body.revision.action, 'restore');
});

test('completing a story through the item API completes its open tasks with their own revisions', async () => {
  const { app, token } = await createProjectsTestApp();
  const before = await request(app).get('/api/projects/project-launch').set('Authorization', `Bearer ${token}`);
  const story = before.body.project.epics[0].stories[0];

  const completed = await request(app)
    .patch(`/api/projects/project-launch/items/${story.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: story.version, patch: { status: 'Completed' } });

  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const tasks = completed.body.project.epics[0].stories[0].tasks;
  assert.deepEqual(tasks.map((task) => task.status), ['Completed', 'Completed']);
  const reopenedTask = tasks.find((task) => task.id === 'task-owner');
  assert.equal(reopenedTask.version, 2);
  assert.equal(completed.body.project.epics[0].stories[0].progress, 100);

  const history = await request(app)
    .get('/api/projects/project-launch/items/task-owner/revisions')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(history.body.revisions[0].before.node.status, 'Not Started');
  assert.equal(history.body.revisions[0].after.node.status, 'Completed');

  // Reopening a task under the completed story does not re-trigger the cascade.
  const reopened = await request(app)
    .patch('/api/projects/project-launch/items/task-owner')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 2, patch: { status: 'In Progress' } });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.item.status, 'In Progress');
});

test('percent complete and actual hours persist on items', async () => {
  const { app, token } = await createProjectsTestApp();

  const updated = await request(app)
    .patch('/api/projects/project-launch/items/task-owner')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 1, patch: { actualHours: 3.25, percentComplete: 25, status: 'In Progress', targetHourEstimate: 8 } });

  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.item.percentComplete, 25);
  assert.equal(updated.body.item.actualHours, 3.25);
  assert.equal(updated.body.item.progress, 25);

  const invalid = await request(app)
    .patch('/api/projects/project-launch/items/task-owner')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 2, patch: { percentComplete: 120 } });
  assert.equal(invalid.status, 400);

  const negativeHours = await request(app)
    .patch('/api/projects/project-launch/items/task-owner')
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 2, patch: { actualHours: -1 } });
  assert.equal(negativeHours.status, 400);
});

test('items with children roll up their children estimates until overridden', async () => {
  const { app, token } = await createProjectsTestApp();
  const auth = (call) => call.set('Authorization', `Bearer ${token}`);
  const load = async () => (await auth(request(app).get('/api/projects/project-launch'))).body.project;
  const estimate = (node) => [node.points, node.targetHourEstimate];

  // The seeded epic stores 13 points, but it has children, so it rolls up instead.
  let project = await load();
  assert.deepEqual(estimate(project.epics[0]), [null, null]);

  const task = project.epics[0].stories[0].tasks[0];
  await auth(request(app).patch(`/api/projects/project-launch/items/${task.id}`))
    .send({ expectedVersion: task.version, patch: { points: 3, targetHourEstimate: 24 } });
  project = await load();
  assert.deepEqual(estimate(project.epics[0].stories[0]), [3, 24]);
  assert.deepEqual(estimate(project.epics[0]), [3, 24]);
  assert.equal(project.epics[0].stories[0].estimateOverride, false);

  const story = project.epics[0].stories[0];
  const overridden = await auth(request(app).patch(`/api/projects/project-launch/items/${story.id}`))
    .send({ expectedVersion: story.version, patch: { estimateOverride: true, points: 8, targetHourEstimate: 64 } });
  assert.equal(overridden.status, 200, JSON.stringify(overridden.body));
  project = await load();
  assert.deepEqual(estimate(project.epics[0].stories[0]), [8, 64]);
  assert.deepEqual(estimate(project.epics[0]), [8, 64]);

  const restored = await auth(request(app).patch(`/api/projects/project-launch/items/${story.id}`))
    .send({ expectedVersion: project.epics[0].stories[0].version, patch: { estimateOverride: false } });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  project = await load();
  assert.deepEqual(estimate(project.epics[0].stories[0]), [3, 24]);
  assert.deepEqual(estimate(project.epics[0]), [3, 24]);
});

test('tree saves complete the open tasks of a story that becomes completed', async () => {
  const { app, token } = await createProjectsTestApp();
  const before = await request(app).get('/api/projects/project-launch').set('Authorization', `Bearer ${token}`);
  const epics = structuredClone(before.body.project.epics);
  epics[0].stories[0].status = 'Completed';

  const saved = await request(app)
    .put('/api/projects/project-launch/tree')
    .set('Authorization', `Bearer ${token}`)
    .send({ epics, expectedUpdatedAt: before.body.project.updatedAt });

  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.project.epics[0].stories[0].tasks.map((task) => task.status), ['Completed', 'Completed']);
});

test('project legal hold blocks destructive item changes until release', async () => {
  const { app, token } = await createProjectsTestApp();
  const created = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ item: { description: 'Preserved task.', name: 'Preserve me', status: 'Not Started' }, itemType: 'task', parentId: 'story-routing' });
  assert.equal(created.status, 201);
  const hold = await request(app).post('/api/compliance/legal-holds').set('Authorization', `Bearer ${token}`).send({ reason: 'Preserve the project record for litigation.', resourceId: 'project-launch', resourceType: 'project' });
  assert.equal(hold.status, 201);
  assert.equal((await request(app).delete(`/api/projects/project-launch/items/${created.body.item.id}`).set('Authorization', `Bearer ${token}`).send({ expectedVersion: 1 })).status, 423);
  await request(app).post(`/api/compliance/legal-holds/${hold.body.value.id}/release`).set('Authorization', `Bearer ${token}`).send({ expectedVersion: 1, reason: 'The project preservation duty has ended.' });
  assert.equal((await request(app).delete(`/api/projects/project-launch/items/${created.body.item.id}`).set('Authorization', `Bearer ${token}`).send({ expectedVersion: 1 })).status, 200);
});

test('project archive export includes project json and vault bytes', async () => {
  const { app, memberToken, token } = await createProjectsTestApp();
  const fileContents = Buffer.from('archive-file-bytes');

  const uploadResponse = await request(app)
    .post('/api/projects/project-launch/files')
    .set('Authorization', `Bearer ${token}`)
    .send({
      fileContentsBase64: fileContents.toString('base64'),
      fileDescription: 'Project attachment',
      fileName: 'archive.txt',
      fileType: 'text/plain',
      targetId: 'project-launch',
      targetType: 'project',
    });

  assert.equal(uploadResponse.status, 201);

  const forbiddenResponse = await request(app)
    .get('/api/projects/project-launch/export')
    .set('Authorization', `Bearer ${memberToken}`);

  assert.equal(forbiddenResponse.status, 403);

  const exportResponse = await request(app)
    .get('/api/projects/project-launch/export')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.body.ok, true);
  assert.match(exportResponse.body.filename, /\.odin-project$/);

  const zip = await JSZip.loadAsync(Buffer.from(exportResponse.body.base64OdinProject, 'base64'));
  const archive = JSON.parse(await zip.file('project.json').async('string'));
  const archivedFile = archive.files.find((file) => file.id === uploadResponse.body.file.id);

  assert.equal(archive.project.id, 'project-launch');
  assert.equal(archivedFile.fileName ?? archivedFile.file_name, 'archive.txt');
  assert.equal(await zip.file(`vault/${uploadResponse.body.file.id}`).async('string'), 'archive-file-bytes');
});

test('project archive import inspects mappings, rejects conflicts, and imports vault files', async () => {
  const source = await createProjectsTestApp();
  const fileContents = Buffer.from('portable-vault-bytes');

  const uploadResponse = await request(source.app)
    .post('/api/projects/project-launch/files')
    .set('Authorization', `Bearer ${source.token}`)
    .send({
      fileContentsBase64: fileContents.toString('base64'),
      fileDescription: 'Portable attachment',
      fileName: 'portable.txt',
      fileType: 'text/plain',
      targetId: 'project-launch',
      targetType: 'project',
    });
  assert.equal(uploadResponse.status, 201);

  const exportResponse = await request(source.app)
    .get('/api/projects/project-launch/export')
    .set('Authorization', `Bearer ${source.token}`);
  assert.equal(exportResponse.status, 200);

  const conflictInspect = await request(source.app)
    .post('/api/projects/import/inspect')
    .set('Authorization', `Bearer ${source.token}`)
    .send({ base64OdinProject: exportResponse.body.base64OdinProject });

  assert.equal(conflictInspect.status, 200);
  assert.ok(conflictInspect.body.conflicts.some((conflict) => conflict.type === 'project' && conflict.id === 'project-launch'));
  assert.ok(conflictInspect.body.conflictGroups.some((group) => group.type === 'project' && group.count >= 1));

  const rejectedImportResponse = await request(source.app)
    .post('/api/projects/import')
    .set('Authorization', `Bearer ${source.token}`)
    .send({
      base64OdinProject: exportResponse.body.base64OdinProject,
      userMappings: [],
    });

  assert.equal(rejectedImportResponse.status, 409);

  const staleUploadResponse = await request(source.app)
    .post('/api/projects/project-launch/files')
    .set('Authorization', `Bearer ${source.token}`)
    .send({
      fileContentsBase64: Buffer.from('stale-project-file').toString('base64'),
      fileDescription: 'Stale attachment',
      fileName: 'stale.txt',
      fileType: 'text/plain',
      targetId: 'project-launch',
      targetType: 'project',
    });

  assert.equal(staleUploadResponse.status, 201);

  const overwriteResponse = await request(source.app)
    .post('/api/projects/import')
    .set('Authorization', `Bearer ${source.token}`)
    .send({
      base64OdinProject: exportResponse.body.base64OdinProject,
      overwriteMode: 'project',
      userMappings: [],
    });

  assert.equal(overwriteResponse.status, 201);

  const staleContentResponse = await request(source.app)
    .get(`/api/files/${staleUploadResponse.body.file.id}/content`)
    .set('Authorization', `Bearer ${source.token}`);

  assert.equal(staleContentResponse.status, 404);

  const target = await createProjectsTestApp({ projects: [] });
  const inspectResponse = await request(target.app)
    .post('/api/projects/import/inspect')
    .set('Authorization', `Bearer ${target.token}`)
    .send({ base64OdinProject: exportResponse.body.base64OdinProject });

  assert.equal(inspectResponse.status, 200);
  assert.equal(inspectResponse.body.conflicts.length, 0);
  assert.ok(inspectResponse.body.sourceUsers.some((user) => user.email === 'grace@acme.com' && user.suggestedTargetUserId === 'user-grace'));

  const importResponse = await request(target.app)
    .post('/api/projects/import')
    .set('Authorization', `Bearer ${target.token}`)
    .send({
      base64OdinProject: exportResponse.body.base64OdinProject,
      userMappings: [],
    });

  assert.equal(importResponse.status, 201);
  assert.equal(importResponse.body.importedProjectId, 'project-launch');

  const projectResponse = await request(target.app)
    .get('/api/projects/project-launch')
    .set('Authorization', `Bearer ${target.token}`);

  assert.equal(projectResponse.status, 200);
  assert.equal(projectResponse.body.project.epics[0].stories[0].assigneeId, null);

  const contentResponse = await request(target.app)
    .get(`/api/files/${uploadResponse.body.file.id}/content`)
    .set('Authorization', `Bearer ${target.token}`)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

  assert.equal(contentResponse.status, 200);
  assert.deepEqual(contentResponse.body, fileContents);
});

test('project archive import overwrite all removes unrelated file conflicts', async () => {
  const storedBytes = new Map([['file-conflict', Buffer.from('old-file')]]);
  const deletedFileIds = [];
  const repository = createInMemoryProjectsRepository({
    fileStorage: {
      async delete(fileId) {
        deletedFileIds.push(fileId);
        storedBytes.delete(fileId);
      },
      async read(fileId) {
        const bytes = storedBytes.get(fileId) ?? Buffer.alloc(0);
        return { bytes, size: bytes.length };
      },
      async write(fileId, bytes) {
        storedBytes.set(fileId, Buffer.from(bytes));
      },
    },
    seed: {
      files: [{
        contentType: 'text/plain',
        createdAt: '2026-05-20T10:00:00.000Z',
        fileName: 'old.txt',
        fileSize: 8,
        id: 'file-conflict',
        projectId: 'project-existing',
        targetId: 'project-existing',
        targetType: 'project',
        tenantId: 'tenant-acme',
        updatedAt: '2026-05-20T10:00:00.000Z',
        uploadedBy: { id: 'user-grace', name: 'Grace Hopper' },
      }],
      projects: [{
        epics: [],
        id: 'project-existing',
        name: 'Existing Project',
        role: 'admin',
        status: 'Planned',
        tenantId: 'tenant-acme',
      }],
    },
  });
  const archiveData = {
    files: [{
      contentType: 'text/plain',
      fileName: 'new.txt',
      id: 'file-conflict',
      targetId: 'project-new',
      targetType: 'project',
    }],
    project: {
      epics: [],
      id: 'project-new',
      name: 'Imported Project',
      status: 'Planned',
    },
    projectUsers: [],
  };
  const vaultFiles = new Map([['file-conflict', Buffer.from('new-file')]]);

  await assert.rejects(
    () => repository.importProjectArchiveData({
      archiveData,
      overwriteMode: 'none',
      tenantId: 'tenant-acme',
      user: { email: 'grace@acme.com', id: 'user-grace', name: 'Grace Hopper' },
      userMappings: [],
      vaultFiles,
    }),
    /Project archive conflicts/,
  );

  const result = await repository.importProjectArchiveData({
    archiveData,
    overwriteMode: 'all',
    tenantId: 'tenant-acme',
    user: { email: 'grace@acme.com', id: 'user-grace', name: 'Grace Hopper' },
    userMappings: [],
    vaultFiles,
  });

  assert.equal(result.importedProjectId, 'project-new');
  assert.deepEqual(deletedFileIds, ['file-conflict']);
  // Stored under a key of Odin's own, never one the archive names.
  assert.equal(storedBytes.has('file-conflict'), false);
  assert.equal((await repository.getFileAsset({ fileId: 'file-conflict', tenantId: 'tenant-acme' })).bytes.toString(), 'new-file');
  const files = await repository.listFiles({
    projectId: 'project-new',
    targetId: 'project-new',
    targetType: 'project',
    tenantId: 'tenant-acme',
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].fileName, 'new.txt');
});
