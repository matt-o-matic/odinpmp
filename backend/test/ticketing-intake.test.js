import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
import { createIntakeRateLimiter } from '../src/modules/projects/ticket-intake.service.js';

async function createIntakeTestApp() {
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
          epics: [{ description: '', id: 'epic-secret', name: 'Internal Epic', status: 'In Progress', stories: [] }],
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
  const queued = [];
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  const app = createApp({
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    tenantsRepository,
    mailRepository: {
      async queueMail(payload) {
        queued.push(payload);
        return { id: 'mail-1' };
      },
    },
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

  async function createInvitation(body = {}) {
    const response = await request(app)
      .post('/api/projects/project-launch/ticket-intake-invitations')
      .set('Authorization', `Bearer ${token}`)
      .send({ reporterEmail: 'client@customer.com', reporterName: 'Client Tester', ...body });
    return response;
  }

  return { app, createInvitation, projectsRepository, queued, tenantsRepository, token };
}

test('an intake invitation is project-scoped and returns a token', async () => {
  const { createInvitation } = await createIntakeTestApp();

  const response = await createInvitation();

  assert.equal(response.status, 201);
  assert.equal(response.body.invitation.projectId, 'project-launch');
  assert.equal(response.body.invitation.reporterEmail, 'client@customer.com');
  assert.ok(response.body.invitation.intakeToken);
  assert.notEqual(response.body.invitation.intakeToken, response.body.invitation.replyToken);
});

test('a valid token creates a ticket in exactly the token project', async () => {
  const { app, createInvitation } = await createIntakeTestApp();
  const invitation = await createInvitation();

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Checkout fails on empty cart', reproSteps: '1. Empty cart\n2. Submit', severity: 'S1' });

  assert.equal(response.status, 201);
  assert.equal(response.body.ticket.name, 'Checkout fails on empty cart');
  assert.equal(response.body.ticket.severity, 'S1');
});

test('the request body cannot override the project', async () => {
  const { app, createInvitation, projectsRepository } = await createIntakeTestApp();
  const invitation = await createInvitation();

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Injected project', projectId: 'project-other' });

  // Unknown fields are rejected outright rather than silently ignored.
  assert.equal(response.status, 400);

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.equal(project.tickets.length, 0);
});

test('every externally created ticket is pending with a reporter', async () => {
  const { app, createInvitation, projectsRepository } = await createIntakeTestApp();
  const invitation = await createInvitation();

  await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Reported defect' });

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.equal(project.tickets.length, 1);
  assert.equal(project.tickets[0].externalReviewState, 'pending');
  assert.equal(project.tickets[0].reporterExternalId, invitation.body.invitation.id);
  assert.equal(project.tickets[0].status, 'new');
});

test('an unknown token is rejected without creating anything', async () => {
  const { app, projectsRepository } = await createIntakeTestApp();

  const response = await request(app)
    .post('/api/public/ticket-intake/not-a-real-token')
    .send({ name: 'Ghost' });

  assert.equal(response.status, 404);
  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.equal(project.tickets.length, 0);
});

test('a revoked token behaves exactly like an unknown one', async () => {
  const { app, createInvitation, token } = await createIntakeTestApp();
  const invitation = await createInvitation();

  const revoked = await request(app)
    .delete(`/api/projects/project-launch/ticket-intake-invitations/${invitation.body.invitation.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(revoked.status, 200);

  const submission = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'After revoke' });
  const unknown = await request(app)
    .post('/api/public/ticket-intake/not-a-real-token')
    .send({ name: 'Ghost' });

  assert.equal(submission.status, 404);
  assert.deepEqual(submission.body, unknown.body, 'revoked and unknown are indistinguishable');
});

test('an expired token behaves exactly like an unknown one', async () => {
  const { app, createInvitation } = await createIntakeTestApp();
  const invitation = await createInvitation({ expiresAt: '2020-01-01T00:00:00.000Z' });

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Too late' });

  assert.equal(response.status, 404);
});

test('the public context discloses no internal identities or project structure', async () => {
  const { app, createInvitation } = await createIntakeTestApp();
  const invitation = await createInvitation();

  const response = await request(app).get(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.intake).sort(), [
    'attachmentLimits', 'environments', 'expiresAt', 'projectName', 'releases', 'reporterName', 'tickets',
  ]);
  assert.equal(response.body.intake.projectName, 'Launch Readiness');
  assert.deepEqual(response.body.intake.tickets, []);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(invitation.body.invitation.intakeToken), false, 'the token is never echoed');
  assert.equal(serialized.includes(invitation.body.invitation.replyToken), false);
  assert.equal(serialized.includes('client@customer.com'), false);
  assert.equal(serialized.includes('epic-secret'), false);
  assert.equal(serialized.includes('user-grace'), false);
  assert.equal(serialized.includes('tenant-acme'), false);
});

test('the submission response returns only the reporter own ticket reference', async () => {
  const { app, createInvitation } = await createIntakeTestApp();
  const invitation = await createInvitation();

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Scoped response' });

  assert.deepEqual(Object.keys(response.body.ticket).sort(), ['category', 'id', 'name', 'reference', 'severity', 'status', 'statusLabel', 'updatedAt']);
  assert.equal(response.body.ticket.statusLabel, 'New');
  assert.equal(response.body.ticket.reference, response.body.ticket.id.replace(/-/g, '').slice(0, 8).toUpperCase());
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes('epic-secret'), false);
  assert.equal(serialized.includes('project-launch'), false);
});

test('the reporter receives an acknowledgement referencing their ticket', async () => {
  const { app, createInvitation, queued } = await createIntakeTestApp();
  const invitation = await createInvitation();

  queued.length = 0;

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Acknowledged defect' });

  assert.equal(queued.length, 1);
  assert.equal(queued[0].recipientEmail, 'client@customer.com');
  assert.equal(queued[0].templateId, 'ticket-intake-acknowledgement-v1');
  assert.equal(queued[0].targetId, response.body.ticket.id);
  assert.match(queued[0].subject, /Acknowledged defect/);
  assert.match(queued[0].subject, new RegExp(`\\[Ref ${response.body.ticket.reference}\\]`));
  assert.ok(queued[0].body.includes(response.body.ticket.reference));
  // The link opens the reporter's own page, scrolled to this ticket.
  assert.ok(queued[0].body.includes(
    `href="http://localhost:5173/app/report/${invitation.body.invitation.intakeToken}#ticket-${response.body.ticket.reference}"`,
  ));
  assert.match(queued[0].body, /^<!DOCTYPE html>/);
});

test('the reporter page lists only the tickets filed through that link, with client-facing status', async () => {
  const { app, createInvitation, token } = await createIntakeTestApp();
  const mine = await createInvitation();
  const theirs = await createInvitation({ reporterEmail: 'other@customer.com' });

  const filed = await request(app).post(`/api/public/ticket-intake/${mine.body.invitation.intakeToken}`).send({ name: 'Mine' });
  await request(app).post(`/api/public/ticket-intake/${theirs.body.invitation.intakeToken}`).send({ name: 'Theirs' });
  await request(app)
    .patch(`/api/projects/project-launch/items/${filed.body.ticket.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expectedVersion: 1, patch: { status: 'in_progress' } });

  const context = await request(app).get(`/api/public/ticket-intake/${mine.body.invitation.intakeToken}`);

  assert.equal(context.status, 200);
  assert.deepEqual(context.body.intake.tickets.map((ticket) => [ticket.name, ticket.status, ticket.statusLabel]), [['Mine', 'in_progress', 'In Progress']]);
  assert.equal(JSON.stringify(context.body).includes('Theirs'), false);
});

test('the public context offers the active environments and this project releases', async () => {
  const { app, createInvitation, tenantsRepository } = await createIntakeTestApp();
  await tenantsRepository.saveTicketConfigList({
    entries: [
      { id: 'rel-1', name: '1.0.0', projectId: 'project-launch', status: 'active' },
      { id: 'rel-2', name: '0.9.0', projectId: 'project-launch', status: 'inactive' },
      { id: 'rel-3', name: 'Other project', projectId: 'project-other', status: 'active' },
    ],
    kind: 'releases',
    tenantId: 'tenant-acme',
  });
  const invitation = await createInvitation();

  const context = await request(app).get(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`);

  assert.deepEqual(context.body.intake.releases, [{ id: 'rel-1', name: '1.0.0' }]);
  assert.ok(context.body.intake.environments.some((entry) => entry.name === 'Production'));
  assert.deepEqual(Object.keys(context.body.intake.environments[0]).sort(), ['id', 'name']);
  assert.equal(context.body.intake.attachmentLimits.maxCount, 5);
});

test('a submission whose attachments exceed the combined budget is rejected before anything is stored', async () => {
  const { app, createInvitation, projectsRepository } = await createIntakeTestApp();
  const invitation = await createInvitation();
  // 20.4 MiB decoded: over the 20 MiB budget, but small enough as base64 to pass the body limit.
  const sevenMegabytes = Buffer.alloc(Math.floor(6.8 * 1024 * 1024), 0x41).toString('base64');

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({
      attachments: [1, 2, 3].map((index) => ({ contentBase64: sevenMegabytes, contentType: 'text/plain', fileName: `log-${index}.txt` })),
      name: 'Three large logs',
    });

  // The body parser accepts the payload (well over the 1 MB global limit); the service
  // refuses the combined size.
  assert.equal(response.status, 413);
  assert.match(response.body.error, /combined size/);
  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.deepEqual(project.tickets, []);
});

test('rate limiting is per token and does not affect other tokens', () => {
  const limiter = createIntakeRateLimiter({ maxSubmissions: 2, windowMs: 60_000 });

  assert.equal(limiter.check('token-a'), true);
  assert.equal(limiter.check('token-a'), true);
  assert.equal(limiter.check('token-a'), false, 'the third submission is refused');
  assert.equal(limiter.check('token-b'), true, 'another token is unaffected');
});

test('the window slides so a token recovers', () => {
  const limiter = createIntakeRateLimiter({ maxSubmissions: 1, windowMs: 1000 });
  const start = 1_000_000;

  assert.equal(limiter.check('token-a', start), true);
  assert.equal(limiter.check('token-a', start + 500), false);
  assert.equal(limiter.check('token-a', start + 1500), true);
});

test('a malformed submission is a validation error, not a server error', async () => {
  const { app, createInvitation } = await createIntakeTestApp();
  const invitation = await createInvitation();

  const missingName = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ severity: 'S1' });
  assert.equal(missingName.status, 400);

  const badSeverity = await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Bad severity', severity: 'S9' });
  assert.equal(badSeverity.status, 400);
});

test('intake invitations require project edit authority', async () => {
  const { app } = await createIntakeTestApp();

  const response = await request(app)
    .post('/api/projects/project-launch/ticket-intake-invitations')
    .send({ reporterEmail: 'anon@example.com' });

  assert.equal(response.status, 401);
});

test('submitted tickets appear in the review queue and are invisible to the assistant', async () => {
  const { app, createInvitation, token } = await createIntakeTestApp();
  const invitation = await createInvitation();

  await request(app)
    .post(`/api/public/ticket-intake/${invitation.body.invitation.intakeToken}`)
    .send({ name: 'Needs review' });

  const queue = await request(app)
    .get('/api/projects/ticket-review-queue')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(queue.status, 200);
  assert.equal(queue.body.tickets.length, 1);
  assert.equal(queue.body.tickets[0].name, 'Needs review');
  assert.equal(queue.body.tickets[0].externalReviewState, 'pending');
});
