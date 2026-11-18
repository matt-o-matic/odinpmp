import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const PROJECT = '/api/projects/project-alpha';

async function createRelationsTestApp() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme Delivery' }],
    users: [
      { authMethod: 'basic', email: 'grace@acme.com', id: 'user-grace', memberships: [{ role: 'admin', tenantId: 'tenant-acme' }], name: 'Grace Hopper', password: 'Secret123!', preferences: { twoFactorEnabled: false } },
      { authMethod: 'basic', email: 'ada@acme.com', id: 'user-ada', memberships: [{ role: 'user', tenantId: 'tenant-acme' }], name: 'Ada Lovelace', password: 'Secret123!', preferences: { twoFactorEnabled: false } },
      { authMethod: 'basic', email: 'lin@acme.com', id: 'user-lin', memberships: [{ role: 'user', tenantId: 'tenant-acme' }], name: 'Lin Editor', password: 'Secret123!', preferences: { twoFactorEnabled: false } },
    ],
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        'project-alpha': [{ id: 'user-ada', role: 'user' }, { id: 'user-grace', role: 'admin' }, { id: 'user-lin', role: 'editor' }],
      },
      projects: [{
        createdAt: '2026-07-01T10:00:00.000Z',
        description: 'Alpha.',
        epics: [{
          description: '', id: 'epic-a', name: 'Checkout', status: 'In Progress',
          stories: [{ description: '', id: 'story-a', name: 'Pay by card', status: 'In Progress', tasks: [{ description: '', id: 'task-a', name: 'Card form', status: 'Not Started' }] }],
        }],
        id: 'project-alpha',
        name: 'Alpha',
        role: 'admin',
        status: 'In Progress',
        tenantId: 'tenant-acme',
        tickets: [
          { category: 'defect', externalReviewState: 'not_external', id: 't-1', issueType: 'ticket', name: 'Card declined twice', parentId: null, severity: 'S2', status: 'open', version: 1 },
          { category: 'defect', externalReviewState: 'not_external', id: 't-2', issueType: 'ticket', name: 'Double charge', parentId: null, severity: 'S2', status: 'new', version: 1 },
        ],
        updatedAt: '2026-07-12T08:30:00.000Z',
      }],
    },
  });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({ authRepository, frontendAppUrl: 'http://localhost:5173/app', projectRepository, sessionsRepository, tokenService });

  async function tokenFor(id, email, name, role) {
    const token = tokenService.signSessionToken({ email, id, name, preferences: { twoFactorEnabled: false }, role, scopes: [`Ttenant-acme-${role}`], tenantId: 'tenant-acme' });
    const expiry = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(expiry.exp * 1000), ipAddr: '127.0.0.1', locationName: 'Localhost', token, userAgent: 'test-agent', userId: id });
    return token;
  }

  return {
    adminToken: await tokenFor('user-grace', 'grace@acme.com', 'Grace Hopper', 'admin'),
    app,
    editorToken: await tokenFor('user-lin', 'lin@acme.com', 'Lin Editor', 'user'),
    memberToken: await tokenFor('user-ada', 'ada@acme.com', 'Ada Lovelace', 'user'),
  };
}

function link(app, token, fromItemId, relationType, toItemId) {
  return request(app).post(`${PROJECT}/items/${fromItemId}/relations`).set('Authorization', `Bearer ${token}`).send({ relationType, toItemId });
}

function list(app, token, itemId) {
  return request(app).get(`${PROJECT}/items/${itemId}/relations`).set('Authorization', `Bearer ${token}`);
}

test('the relation list describes the item at the other end in both directions', async () => {
  const { adminToken, app } = await createRelationsTestApp();
  assert.equal((await link(app, adminToken, 't-1', 'caused_by', 'story-a')).status, 201);
  assert.equal((await link(app, adminToken, 't-2', 'duplicate_of', 't-1')).status, 201);
  assert.equal((await link(app, adminToken, 'task-a', 'blocks', 't-1')).status, 201);

  const response = await list(app, adminToken, 't-1');
  assert.equal(response.status, 200);
  assert.equal(response.body.canEdit, true);
  const byType = Object.fromEntries(response.body.relations.map((relation) => [relation.relationType, relation]));

  assert.equal(byType.caused_by.direction, 'outgoing');
  assert.deepEqual(byType.caused_by.relatedItem, { available: true, epicId: 'epic-a', id: 'story-a', itemType: 'story', name: 'Pay by card', status: 'In Progress' });

  assert.equal(byType.duplicate_of.direction, 'incoming');
  assert.deepEqual(byType.duplicate_of.relatedItem, { available: true, id: 't-2', itemType: 'ticket', name: 'Double charge', status: 'new' });

  assert.equal(byType.blocks.direction, 'incoming');
  assert.deepEqual(byType.blocks.relatedItem, { available: true, epicId: 'epic-a', id: 'task-a', itemType: 'task', name: 'Card form', status: 'Not Started', storyId: 'story-a' });
  // The stored fields are still there for existing callers.
  assert.equal(byType.blocks.fromItemId, 'task-a');
  assert.equal(byType.blocks.toItemId, 't-1');
});

test('canEdit follows project.plan.edit: members read relations but cannot add or remove them', async () => {
  const { adminToken, app, editorToken, memberToken } = await createRelationsTestApp();
  const created = await link(app, adminToken, 'story-a', 'blocks', 'task-a');

  const asMember = await list(app, memberToken, 'story-a');
  assert.equal(asMember.status, 200);
  assert.equal(asMember.body.canEdit, false);
  assert.equal(asMember.body.relations.length, 1);
  assert.equal((await link(app, memberToken, 'story-a', 'affects', 'epic-a')).status, 404);
  const memberDelete = await request(app).delete(`${PROJECT}/relations/${created.body.relation.id}`).set('Authorization', `Bearer ${memberToken}`);
  assert.equal(memberDelete.status, 404);

  const asEditor = await list(app, editorToken, 'story-a');
  assert.equal(asEditor.body.canEdit, true);
  assert.equal((await link(app, editorToken, 'story-a', 'affects', 'epic-a')).status, 201);
});

test('an item with no relations lists none', async () => {
  const { adminToken, app } = await createRelationsTestApp();
  const response = await list(app, adminToken, 'epic-a');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.relations, []);
});
