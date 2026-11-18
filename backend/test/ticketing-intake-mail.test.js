import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createTicketReporterNotifier } from '../src/modules/projects/ticket-intake-mail.js';
import { extractReplyToken } from '../src/modules/projects/ticket-intake.service.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

const INBOUND_SECRET = 'inbound-secret';
const REPLY_DOMAIN = 'reply.odinpmp.com';

async function createMailTestApp({ inboundMailWebhookSecret = INBOUND_SECRET, mailReplyDomain = REPLY_DOMAIN, optOut = [] } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme Delivery' }],
    users: [{
      authMethod: 'basic',
      email: 'grace@acme.com',
      id: 'user-grace',
      memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
      name: 'Grace Hopper',
      password: 'Secret123!',
      preferences: { twoFactorEnabled: false },
    }],
  });
  const projectsRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projects: [{
        createdAt: '2026-07-01T10:00:00.000Z',
        description: 'Delivery.',
        epics: [],
        id: 'project-launch',
        name: 'Launch Readiness',
        role: 'admin',
        status: 'In Progress',
        tenantId: 'tenant-acme',
        updatedAt: '2026-07-12T08:30:00.000Z',
      }],
    },
  });
  const mailRepository = createInMemoryMailRepository({ optOut });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const app = createApp({
    authRepository,
    frontendAppUrl: 'https://odinpmp.com/app/',
    inboundMailWebhookSecret,
    mailReplyDomain,
    mailRepository,
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

  const authed = (call) => call.set('Authorization', `Bearer ${token}`);
  const createInvitation = (body = {}) => authed(request(app).post('/api/projects/project-launch/ticket-intake-invitations'))
    .send({ reporterEmail: 'Client@Customer.com', reporterName: 'Client Tester', ...body });
  const submit = (invitation, body = {}) => request(app)
    .post(`/api/public/ticket-intake/${invitation.intakeToken}`)
    .send({ name: 'Checkout fails', ...body });
  const setStatus = async (ticketId, status) => {
    const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
    const ticket = project.tickets.find((entry) => entry.id === ticketId);
    return authed(request(app).patch(`/api/projects/project-launch/items/${ticketId}`))
      .send({ expectedVersion: ticket.version, patch: { status } });
  };
  const queued = (templateId) => mailRepository.state.queue.filter((row) => !templateId || row.templateId === templateId);

  return { app, authed, createInvitation, mailRepository, projectsRepository, queued, setStatus, submit };
}

function reply(overrides = {}) {
  return {
    fromEmail: 'client@customer.com',
    messageId: `message-${Math.random().toString(36).slice(2)}`,
    provider: 'aws-ses',
    subject: 'Re: We received your report',
    textBody: 'It also happens on Safari.',
    ...overrides,
  };
}

async function ticketComments(app, authed, ticketId) {
  const response = await authed(request(app).get(`/api/projects/project-launch/comments?targetType=ticket&targetId=${ticketId}`));
  return response.body.comments ?? [];
}

test('creating an intake link returns its URL and emails it to the reporter', async () => {
  const { authed, app, createInvitation, queued } = await createMailTestApp();

  const response = await createInvitation({ expiresAt: '2099-01-01T12:00:00.000Z' });

  assert.equal(response.status, 201);
  const { invitation } = response.body;
  assert.equal(response.body.url, `https://odinpmp.com/app/report/${invitation.intakeToken}`);
  assert.equal(invitation.url, response.body.url);
  assert.deepEqual(response.body.email, { recipient: 'Client@Customer.com', sent: true });

  const [mail] = queued('ticket-intake-invitation-v1');
  assert.equal(mail.recipientEmail, 'client@customer.com');
  assert.equal(mail.targetId, invitation.id);
  assert.equal(mail.subject, 'Report issues for Launch Readiness');
  assert.ok(mail.body.includes(`href="${response.body.url}"`));
  assert.match(mail.body, /Hello Client Tester/);
  assert.match(mail.body, /It works until/);
  assert.equal(mail.replyTo, '', 'the invitation itself has no reply route');

  const list = await authed(request(app).get('/api/projects/project-launch/ticket-intake-invitations'));
  assert.equal(list.body.invitations[0].url, response.body.url);
});

test('a revoked or expired link is listed without a URL', async () => {
  const { app, authed, createInvitation } = await createMailTestApp();
  const revoked = (await createInvitation()).body.invitation;
  await createInvitation({ expiresAt: '2020-01-01T00:00:00.000Z', reporterEmail: 'late@customer.com' });
  await authed(request(app).delete(`/api/projects/project-launch/ticket-intake-invitations/${revoked.id}`));

  const list = await authed(request(app).get('/api/projects/project-launch/ticket-intake-invitations'));

  assert.deepEqual(list.body.invitations.map((entry) => entry.url), [null, null]);
});

test('the creator is told when the link could not be emailed, and still gets the URL', async () => {
  const { createInvitation, mailRepository } = await createMailTestApp();
  mailRepository.queueMail = async () => { throw new Error('queue down'); };

  const response = await createInvitation();

  assert.equal(response.status, 201);
  assert.deepEqual(response.body.email, { reason: 'queue-failed', recipient: 'Client@Customer.com', sent: false });
  assert.ok(response.body.url);
});

test('the acknowledgement is an HTML template with the reporter link and a ticket+ Reply-To', async () => {
  const { createInvitation, queued, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;

  const submitted = await submit(invitation);

  const [ack] = queued('ticket-intake-acknowledgement-v1');
  assert.equal(ack.replyTo, `ticket+${invitation.replyToken}@${REPLY_DOMAIN}`);
  assert.equal(ack.targetId, submitted.body.ticket.id);
  assert.equal(ack.subject, `We received your report: Checkout fails [Ref ${submitted.body.ticket.reference}]`);
  assert.ok(ack.body.includes(`href="https://odinpmp.com/app/report/${invitation.intakeToken}#ticket-${submitted.body.ticket.reference}"`));
  assert.ok(ack.body.includes(`ticket+${invitation.replyToken}@${REPLY_DOMAIN}`), 'the reply instructions name the address');
  assert.equal(ack.body.includes('\\n'), false);
  assert.match(ack.body, /Status: New/);
});

test('without a reply domain the acknowledgement has no Reply-To and no reply instructions', async () => {
  const { createInvitation, queued, submit } = await createMailTestApp({ mailReplyDomain: '' });
  const { invitation } = (await createInvitation()).body;

  await submit(invitation);

  const [ack] = queued('ticket-intake-acknowledgement-v1');
  assert.equal(ack.replyTo, '');
  assert.equal(ack.body.includes('Reply address'), false);
});

test('a status change emails the intake reporter the old and new client-facing labels', async () => {
  const { createInvitation, queued, setStatus, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;

  assert.equal((await setStatus(ticket.id, 'triage')).status, 200);
  assert.equal((await setStatus(ticket.id, 'in_progress')).status, 200);

  const updates = queued('ticket-intake-status-v1');
  assert.equal(updates.length, 2, 'each transition gets its own email');
  assert.notEqual(updates[0].targetId, updates[1].targetId);
  for (const update of updates) assert.ok(update.targetId.length <= 36, 'fits mail_queue.mail_target_id');
  assert.equal(updates[1].recipientEmail, 'client@customer.com');
  assert.equal(updates[1].replyTo, `ticket+${invitation.replyToken}@${REPLY_DOMAIN}`);
  assert.equal(updates[1].subject, `Update on your report: Checkout fails [Ref ${ticket.reference}]`);
  assert.match(updates[1].body, /moved from <strong>Triage<\/strong> to <strong>In Progress<\/strong>/);
  assert.ok(updates[1].body.includes(`https://odinpmp.com/app/report/${invitation.intakeToken}#ticket-${ticket.reference}`));
});

test('edits that leave the status alone send no status email', async () => {
  const { app, authed, createInvitation, queued, projectsRepository, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;
  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });

  await authed(request(app).patch(`/api/projects/project-launch/items/${ticket.id}`))
    .send({ expectedVersion: project.tickets[0].version, patch: { severity: 'S1' } });

  assert.equal(queued('ticket-intake-status-v1').length, 0);
});

test('internal and Bug Reporter tickets never trigger intake status email', async () => {
  const { app, authed, queued, setStatus } = await createMailTestApp();
  const created = [];
  for (const reporterExternalId of [null, 'bug-reporter:stakeholder-1', 'not-an-invitation']) {
    const response = await authed(request(app).post('/api/projects/project-launch/items'))
      .send({ item: { name: `Ticket ${reporterExternalId}`, reporterExternalId, status: 'new' }, itemType: 'ticket', parentId: null });
    assert.equal(response.status, 201);
    created.push(response.body.item.id);
  }

  for (const id of created) assert.equal((await setStatus(id, 'triage')).status, 200);

  assert.equal(queued('ticket-intake-status-v1').length, 0);
});

test('status email for a revoked link is not sent', async () => {
  const { app, authed, createInvitation, queued, setStatus, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;
  await authed(request(app).delete(`/api/projects/project-launch/ticket-intake-invitations/${invitation.id}`));

  await setStatus(ticket.id, 'triage');

  assert.equal(queued('ticket-intake-status-v1').length, 0);
});

test('an opted-out reporter has status email queued but never picked up for sending', async () => {
  const { createInvitation, mailRepository, queued, setStatus, submit } = await createMailTestApp({ optOut: ['client@customer.com'] });
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;

  await setStatus(ticket.id, 'triage');

  assert.equal(queued('ticket-intake-status-v1').length, 1);
  assert.deepEqual(await mailRepository.listPendingEmails({ limit: 50 }), []);
});

test('the clarification inbound webhook routes ticket+ replies to the reporter ticket', async () => {
  const { app, authed, createInvitation, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;

  const response = await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ attachments: [], toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` }));

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { matched: true, ok: true, ticketId: ticket.id });
  const comments = await ticketComments(app, authed, ticket.id);
  assert.equal(comments.length, 1);
  assert.match(comments[0].comment, /Safari/);
});

test('a ticket reply keeps its formatting and drops its quoted history', async () => {
  const { app, authed, createInvitation, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;

  const response = await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({
      attachments: [],
      htmlBody: '<div>It also fails on <b>Safari</b>:<ul><li>open the form</li><li>attach a file</li></ul></div><div class="gmail_quote">On Mon, Odin wrote:<blockquote>We received your report</blockquote></div>',
      textBody: 'It also fails on Safari',
      toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}`,
    }));
  assert.equal(response.status, 201);
  const [stored] = await ticketComments(app, authed, ticket.id);
  assert.match(stored.comment, /<strong>Safari<\/strong>/);
  assert.match(stored.comment, /<li>open the form<\/li>/);
  assert.equal(stored.comment.includes('We received your report'), false, 'quoted history is removed');

  // A plain reply keeps its line breaks.
  await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ attachments: [], textBody: ['Line one', 'Line two'].join(String.fromCharCode(10)), toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` }));
  const comments = await ticketComments(app, authed, ticket.id);
  assert.ok(comments.some((comment) => comment.comment.includes('Line one<br')), JSON.stringify(comments.map((comment) => comment.comment)));
});

test('ticket replies through the clarification webhook still need the shared secret', async () => {
  const { app, createInvitation } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const payload = reply({ toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` });

  const wrong = await request(app).post('/api/public/clarification-mail/inbound').set('x-inbound-mail-secret', 'nope').send(payload);
  assert.equal(wrong.status, 401);

  const unconfigured = await createMailTestApp({ inboundMailWebhookSecret: '' });
  const { invitation: other } = (await unconfigured.createInvitation()).body;
  for (const path of ['/api/public/clarification-mail/inbound', '/api/public/ticket-mail/inbound']) {
    const response = await request(unconfigured.app).post(path)
      .send(reply({ toEmail: `ticket+${other.replyToken}@${REPLY_DOMAIN}` }));
    assert.equal(response.status, 401, `${path} refuses when no secret is configured`);
  }
});

test('a reply from anyone but the invited reporter is ignored', async () => {
  const { app, authed, createInvitation, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;

  const response = await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ fromEmail: 'attacker@example.com', toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` }));

  assert.equal(response.status, 201);
  assert.equal(response.body.matched, false);
  assert.deepEqual(await ticketComments(app, authed, ticket.id), []);
});

test('a reply naming a ticket reference lands on that ticket rather than the latest one', async () => {
  const { app, authed, createInvitation, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const first = (await submit(invitation, { name: 'First' })).body.ticket;
  const second = (await submit(invitation, { name: 'Second' })).body.ticket;

  const response = await request(app)
    .post('/api/public/ticket-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ subject: `RE: We received your report: First [Ref ${first.reference}]`, toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` }));

  assert.equal(response.body.ticketId, first.id);
  assert.equal((await ticketComments(app, authed, second.id)).length, 0);
});

test('a ticket+ address on another domain is not a ticket reply', async () => {
  const { app, createInvitation } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;

  const viaTicketRoute = await request(app)
    .post('/api/public/ticket-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ toEmail: `ticket+${invitation.replyToken}@evil.example.com` }));
  assert.equal(viaTicketRoute.body.matched, false);

  // On the clarification webhook it is neither a ticket nor a clarification address.
  const viaClarificationRoute = await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ toEmail: `ticket+${invitation.replyToken}@evil.example.com` }));
  assert.equal(viaClarificationRoute.status, 400);
});

test('the reply token is checked against the configured reply domain', () => {
  assert.equal(extractReplyToken(`ticket+abc123@${REPLY_DOMAIN}`, REPLY_DOMAIN), 'abc123');
  assert.equal(extractReplyToken(`Ticket+ABC123@Reply.OdinPMP.com`, REPLY_DOMAIN), 'ABC123');
  assert.equal(extractReplyToken('ticket+abc123@elsewhere.com', REPLY_DOMAIN), '');
  assert.equal(extractReplyToken(`clarification+abc@${REPLY_DOMAIN}`, REPLY_DOMAIN), '');
  assert.equal(extractReplyToken('ticket+abc123', REPLY_DOMAIN), '');
});

test('inbound reply webhooks accept bodies the SES Lambda can send', async () => {
  const { app, createInvitation } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  // The Lambda forwards up to 10 MiB of attachments; this is well over the 1 MB global limit.
  const attachment = { contentBase64: Buffer.alloc(3 * 1024 * 1024, 0x41).toString('base64'), contentType: 'image/png', fileName: 'shot.png' };

  const response = await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ attachments: [attachment], toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` }));

  assert.equal(response.status, 201);
});

test('a deleted project closes its intake links and replies until it is restored', async () => {
  const { app, authed, createInvitation, projectsRepository, queued, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;
  const queuedBefore = queued().length;

  assert.equal((await authed(request(app).delete('/api/projects/project-launch'))).status, 200);
  const page = await request(app).get(`/api/public/ticket-intake/${invitation.intakeToken}`);
  assert.equal(page.status, 404);
  assert.equal(page.body.error, 'This submission link is not available.');
  const blocked = await submit(invitation, { name: 'Another failure' });
  assert.equal(blocked.status, 404);
  assert.equal(blocked.body.error, 'This submission link is not available.');
  const replied = await request(app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_SECRET)
    .send(reply({ attachments: [], toEmail: `ticket+${invitation.replyToken}@${REPLY_DOMAIN}` }));
  assert.equal(replied.body.matched, false);
  assert.equal(queued().length, queuedBefore, 'no acknowledgement or status mail for a deleted project');
  assert.equal(projectsRepository.state.deletedProjects[0].project.tickets.length, 1);

  assert.equal((await authed(request(app).post('/api/projects/project-launch/restore'))).status, 200);
  const reopened = await request(app).get(`/api/public/ticket-intake/${invitation.intakeToken}`);
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.intake.tickets.map((entry) => entry.id), [ticket.id]);
});

test('reporter status email is not sent for a deleted project', async () => {
  const { createInvitation, mailRepository, projectsRepository, submit } = await createMailTestApp();
  const { invitation } = (await createInvitation()).body;
  const { ticket } = (await submit(invitation)).body;
  const project = await projectsRepository.getProjectDetail({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  const stored = project.tickets.find((entry) => entry.id === ticket.id);
  const notify = createTicketReporterNotifier({ frontendAppUrl: 'https://odinpmp.com/app/', mailReplyDomain: REPLY_DOMAIN, mailRepository, projectRepository: projectsRepository });
  const change = { after: { ...stored, status: 'triage' }, before: stored, projectId: 'project-launch', projectName: 'Launch Readiness', tenantId: 'tenant-acme' };
  const statusMail = () => mailRepository.state.queue.filter((row) => row.templateId === 'ticket-intake-status-v1');

  await projectsRepository.softDeleteProject({ projectId: 'project-launch', tenantId: 'tenant-acme', user: { id: 'user-grace' } });
  assert.equal(await notify(change), false);
  assert.equal(statusMail().length, 0);

  await projectsRepository.restoreDeletedProject({ projectId: 'project-launch', tenantId: 'tenant-acme' });
  assert.notEqual(await notify(change), false);
  assert.equal(statusMail().length, 1);
});
