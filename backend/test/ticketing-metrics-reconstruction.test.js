// Prove that reopen rate and defect density can be reconstructed from stored
// history alone. Computing these metrics is deferred, but the schema must retain enough
// to compute them retroactively rather than only from the day reporting is built.
//
// This test deliberately reads only durable records — item revisions and relations — and
// never a purpose-built metric field.

import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const CLOSED_STATES = new Set(['closed', 'rejected', 'deferred']);

async function createMetricsTestApp() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme Delivery' }],
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
    ],
  });
  const projectsRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projects: [
        {
          createdAt: '2026-07-01T10:00:00.000Z',
          description: 'Delivery.',
          epics: [
            {
              description: '',
              id: 'epic-1',
              name: 'Checkout',
              status: 'In Progress',
              stories: [
                { description: '', id: 'story-1', name: 'Cart', status: 'In Progress', tasks: [] },
                { description: '', id: 'story-2', name: 'Payment', status: 'In Progress', tasks: [] },
              ],
            },
          ],
          id: 'project-launch',
          name: 'Launch Readiness',
          role: 'admin',
          status: 'In Progress',
          tenantId: 'tenant-acme',
          updatedAt: '2026-07-12T08:30:00.000Z',
        },
      ],
    },
  });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    projectRepository: projectsRepository,
    sessionsRepository,
    tokenService,
  });
  const token = tokenService.signSessionToken({
    email: 'grace@acme.com',
    id: 'user-grace',
    name: 'Grace Hopper',
    preferences: { twoFactorEnabled: false },
    role: 'admin',
    scopes: ['Ttenant-acme-admin'],
    tenantId: 'tenant-acme',
  });
  const expiry = tokenService.verifySessionToken(token);
  await sessionsRepository.createSession({
    expiryDate: new Date(expiry.exp * 1000),
    ipAddr: '127.0.0.1',
    locationName: 'Localhost',
    token,
    userAgent: 'test-agent',
    userId: 'user-grace',
  });

  return { app, projectsRepository, token };
}

/** Reopen count derived purely from closed -> open status transitions in item revisions. */
function reconstructReopenCount(revisions) {
  let reopens = 0;

  for (const revision of revisions) {
    const before = revision.before?.node?.status;
    const after = revision.after?.node?.status;
    if (!before || !after) continue;
    if (CLOSED_STATES.has(before) && !CLOSED_STATES.has(after)) reopens += 1;
  }

  return reopens;
}

/** Defect density derived purely from stored caused_by relations. */
function reconstructDefectDensity(relations) {
  const density = new Map();

  for (const relation of relations) {
    if (relation.relationType !== 'caused_by') continue;
    density.set(relation.toItemId, (density.get(relation.toItemId) ?? 0) + 1);
  }

  return density;
}

test('reopen count is reconstructable from stored item revisions alone', async () => {
  const { app, token } = await createMetricsTestApp();

  const created = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ item: { name: 'Reopened defect', severity: 'S1' }, itemType: 'ticket', parentId: null });
  assert.equal(created.status, 201);

  const ticketId = created.body.item.id;
  let version = created.body.item.version;

  // Walk the lifecycle twice, closing and reopening in between.
  for (const status of ['triage', 'open', 'in_progress', 'resolved', 'closed', 'open', 'in_progress', 'resolved', 'closed', 'open']) {
    const response = await request(app)
      .patch(`/api/projects/project-launch/items/${ticketId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: version, patch: { status } });
    assert.equal(response.status, 200, `transition to ${status} should persist`);
    version = response.body.item.version;
  }

  const revisions = await request(app)
    .get(`/api/projects/project-launch/items/${ticketId}/revisions?limit=100`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(revisions.status, 200);
  assert.equal(
    reconstructReopenCount(revisions.body.revisions),
    2,
    'both reopens are recoverable from history with no purpose-built counter',
  );
});

test('every status transition carries an actor and a timestamp', async () => {
  const { app, token } = await createMetricsTestApp();

  const created = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ item: { name: 'Audited defect' }, itemType: 'ticket', parentId: null });

  await request(app)
    .patch(`/api/projects/project-launch/items/${created.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: created.body.item.version, patch: { status: 'triage' } });

  const revisions = await request(app)
    .get(`/api/projects/project-launch/items/${created.body.item.id}/revisions?limit=100`)
    .set('Authorization', `Bearer ${token}`);

  assert.ok(revisions.body.revisions.length >= 2);
  for (const revision of revisions.body.revisions) {
    assert.equal(revision.actorUserId, 'user-grace');
    assert.ok(revision.createdAt, 'each revision is timestamped');
    assert.ok(Number.isInteger(revision.versionAfter));
  }
});

test('defect density per work item is reconstructable from stored relations', async () => {
  const { app, token } = await createMetricsTestApp();
  const relations = [];

  for (const [index, storyId] of ['story-1', 'story-1', 'story-2'].entries()) {
    const ticket = await request(app)
      .post('/api/projects/project-launch/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ item: { name: `Defect ${index}` }, itemType: 'ticket', parentId: null });

    const relation = await request(app)
      .post(`/api/projects/project-launch/items/${ticket.body.item.id}/relations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ relationType: 'caused_by', toItemId: storyId });

    assert.equal(relation.status, 201);
    relations.push(relation.body.relation);
  }

  // A non-causal relation must not inflate density.
  const extra = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ item: { name: 'Merely affects' }, itemType: 'ticket', parentId: null });
  const affects = await request(app)
    .post(`/api/projects/project-launch/items/${extra.body.item.id}/relations`)
    .set('Authorization', `Bearer ${token}`)
    .send({ relationType: 'affects', toItemId: 'story-1' });
  relations.push(affects.body.relation);

  const density = reconstructDefectDensity(relations);

  assert.equal(density.get('story-1'), 2);
  assert.equal(density.get('story-2'), 1);
});

test('review decisions are recoverable from history', async () => {
  const { app, projectsRepository, token } = await createMetricsTestApp();

  const created = await request(app)
    .post('/api/projects/project-launch/items')
    .set('Authorization', `Bearer ${token}`)
    .send({
      item: { externalReviewState: 'pending', name: 'External report', reporterExternalId: 'reporter-1' },
      itemType: 'ticket',
      parentId: null,
    });

  await request(app)
    .post(`/api/projects/project-launch/items/${created.body.item.id}/review`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: created.body.item.version, state: 'validated' });

  const revisions = await projectsRepository.listProjectItemRevisions({
    itemId: created.body.item.id,
    limit: 100,
    projectId: 'project-launch',
    tenantId: 'tenant-acme',
  });

  const decision = revisions.find(
    (revision) => revision.before?.node?.externalReviewState === 'pending'
      && revision.after?.node?.externalReviewState === 'validated',
  );

  assert.ok(decision, 'the validate decision is recoverable from before/after state');
  assert.equal(decision.actorUserId, 'user-grace');
});

test('the reconstruction helpers do not count non-reopen transitions', () => {
  assert.equal(reconstructReopenCount([]), 0);
  assert.equal(
    reconstructReopenCount([
      { after: { node: { status: 'in_progress' } }, before: { node: { status: 'open' } } },
      { after: { node: { status: 'closed' } }, before: { node: { status: 'resolved' } } },
      { after: { node: { status: 'rejected' } }, before: { node: { status: 'closed' } } },
    ]),
    0,
    'forward progress and closed-to-cancelled are not reopens',
  );
  assert.equal(
    reconstructReopenCount([{ after: { node: { status: 'open' } }, before: { node: { status: 'deferred' } } }]),
    1,
    'a deferred ticket returning to open counts as rework',
  );
});
