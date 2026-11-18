import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { extractReplyToken } from '../src/modules/projects/ticket-intake.service.js';

const INBOUND_SECRET = 'inbound-secret';

async function createAttachmentTestApp({ fileScanner } = {}) {
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
    fileScanner,
    seed: {
      projects: [
        {
          createdAt: '2026-07-01T10:00:00.000Z',
          description: 'Delivery.',
          epics: [],
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
    inboundMailWebhookSecret: INBOUND_SECRET,
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

  const invitation = await request(app)
    .post('/api/projects/project-launch/ticket-intake-invitations')
    .set('Authorization', `Bearer ${token}`)
    .send({ reporterEmail: 'client@customer.com', reporterName: 'Client Tester' });

  return { app, invitation: invitation.body.invitation, projectsRepository, token };
}

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

test('AC6.4 an attachment is stored against the submitted ticket', async () => {
  const { app, invitation, projectsRepository, token } = await createAttachmentTestApp();

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({
      attachments: [{ contentBase64: PNG_BASE64, contentType: 'image/png', fileName: 'screenshot.png' }],
      name: 'Defect with evidence',
    });

  assert.equal(response.status, 201);

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const ticketId = project.tickets[0].id;
  const files = await request(app)
    .get(`/api/projects/project-launch/files?targetType=ticket&targetId=${ticketId}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(files.status, 200);
  assert.equal(files.body.files.length, 1);
  assert.equal(files.body.files[0].fileName, 'screenshot.png');
});

test('AC6.4 an infected attachment rejects the submission and leaves no ticket', async () => {
  const { app, invitation, projectsRepository } = await createAttachmentTestApp({
    fileScanner: { enabled: true, async scanBytes() { return { clean: false, scanner: 'test' }; } },
  });

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({
      attachments: [{ contentBase64: PNG_BASE64, contentType: 'image/png', fileName: 'virus.png' }],
      name: 'Infected submission',
    });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.body), /virus scan/i);

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.deepEqual(project.tickets, [], 'no ticket record survives a failed scan');
});

test('AC6.5 a disallowed content type is rejected', async () => {
  const { app, invitation } = await createAttachmentTestApp();

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({
      attachments: [{ contentBase64: PNG_BASE64, contentType: 'application/x-msdownload', fileName: 'payload.exe' }],
      name: 'Executable attachment',
    });

  assert.equal(response.status, 400);
});

test('AC6.5 an oversized attachment is rejected on decoded bytes, not base64 length', async () => {
  const { app, invitation, projectsRepository } = await createAttachmentTestApp();
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x41).toString('base64');

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({
      attachments: [{ contentBase64: oversized, contentType: 'image/png', fileName: 'huge.png' }],
      name: 'Oversized attachment',
    });

  assert.ok([400, 413].includes(response.status), `expected a rejection, got ${response.status}`);

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.deepEqual(project.tickets, []);
});

test('AC6.5 more than five attachments are rejected', async () => {
  const { app, invitation } = await createAttachmentTestApp();
  const attachment = { contentBase64: PNG_BASE64, contentType: 'image/png', fileName: 'shot.png' };

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({ attachments: Array.from({ length: 6 }, () => ({ ...attachment })), name: 'Too many' });

  assert.equal(response.status, 400);
});

test('a submission with no attachments still succeeds', async () => {
  const { app, invitation } = await createAttachmentTestApp();

  const response = await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({ name: 'No evidence' });

  assert.equal(response.status, 201);
});

test('the reply token is parsed from the recipient address', () => {
  assert.equal(extractReplyToken('ticket+abc123@reply.odinpmp.com'), 'abc123');
  assert.equal(extractReplyToken('TICKET+ABC@reply.odinpmp.com'), 'ABC');
  assert.equal(extractReplyToken('clarification+abc@reply.odinpmp.com'), '');
  assert.equal(extractReplyToken('nobody@reply.odinpmp.com'), '');
  assert.equal(extractReplyToken(''), '');
  assert.equal(extractReplyToken(undefined), '');
});

test('AC6.7 an inbound reply is appended to the reporter ticket as a comment', async () => {
  const { app, invitation, projectsRepository, token } = await createAttachmentTestApp();

  await request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({ name: 'Original report' });

  const response = await request(app)
    .post('/api/public/ticket-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send({
      fromEmail: 'client@customer.com',
      messageId: 'message-1',
      provider: 'ses',
      subject: 'Re: We received your report',
      textBody: 'It also happens on Safari.',
      toEmail: `ticket+${invitation.replyToken}@reply.odinpmp.com`,
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.matched, true);

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const ticketId = project.tickets[0].id;
  const comments = await request(app)
    .get(`/api/projects/project-launch/comments?targetType=ticket&targetId=${ticketId}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(comments.status, 200);
  assert.equal(comments.body.comments.length, 1);
  assert.match(comments.body.comments[0].comment, /Safari/);
});

test('AC6.7 a reply to an unknown token never creates a ticket', async () => {
  const { app, projectsRepository } = await createAttachmentTestApp();

  const response = await request(app)
    .post('/api/public/ticket-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send({
      fromEmail: 'stranger@example.com',
      messageId: 'message-2',
      provider: 'ses',
      textBody: 'Hello?',
      toEmail: 'ticket+doesnotexist@reply.odinpmp.com',
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.matched, false);

  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.deepEqual(project.tickets, []);
});

test('the inbound webhook rejects a wrong shared secret', async () => {
  const { app } = await createAttachmentTestApp();

  const response = await request(app)
    .post('/api/public/ticket-mail/inbound')
    .set('x-inbound-mail-secret', 'wrong-secret')
    .send({
      fromEmail: 'client@customer.com',
      messageId: 'message-3',
      provider: 'ses',
      textBody: 'Body',
      toEmail: 'ticket+whatever@reply.odinpmp.com',
    });

  assert.equal(response.status, 401);
});
