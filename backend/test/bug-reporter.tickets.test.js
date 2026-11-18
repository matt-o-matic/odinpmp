import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { handleGoogleCallback } from '../src/modules/auth/auth.service.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
import { createInMemoryPlatformRepository } from '../src/modules/platform/platform.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { ensureTicketWorkflowBinding } from '../src/modules/workflows/ticket-workflow.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reportId = '22222222-2222-4222-8222-222222222222';
const reportUrl = `http://127.0.0.1:4320/?projectId=aca&reportId=${reportId}`;

async function fixture(scopes = ['projects.read', 'projects.write'], { stakeholders = [] } = {}) {
  const users = [
    { id: 'admin', name: 'Tenant admin', email: 'admin@example.test', password: 'Fixture-pass-123!', authMethod: 'basic', memberships: [{ tenantId, role: 'admin' }] },
    { id: 'member', name: 'Project member', email: 'member@example.test', password: 'Fixture-pass-123!', authMethod: 'basic', memberships: [{ tenantId, role: 'user' }] },
    { id: 'outsider', name: 'Other user', email: 'outsider@example.test', password: 'Fixture-pass-123!', authMethod: 'basic', memberships: [{ tenantId, role: 'user' }] },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ id: tenantId, name: 'Fixture tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [{ id: 'project-a', tenantId, name: 'Project A', epics: [] }, { id: 'project-b', tenantId, name: 'Project B', epics: [] }] } });
  projectRepository.state.projectMemberships.set('project-a', [{ id: 'member', role: 'editor' }]);
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'bugreporter-fixture', secret: 'only-a-local-fixture-signing-key-12345' });
  const token = tokenService.signSessionToken({ ...users[0], tenantId });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: 'admin' });
  const platformRepository = createInMemoryPlatformRepository();
  // Odin binds the default ticket lifecycle to every new project.
  const workflowRepository = createInMemoryWorkflowRepository();
  await ensureTicketWorkflowBinding({ projectId: 'project-a', repository: workflowRepository, tenantId });
  const assistantRepository = createInMemoryAssistantRepository();
  for (const { projectId = 'project-a', tenantId: stakeholderTenantId = tenantId, ...value } of stakeholders)
    await assistantRepository.createProjectStakeholder({ projectId, tenantId: stakeholderTenantId, value });
  const metricsRepository = createInMemoryMetricsRepository();
  const app = createApp({ assistantRepository, authRepository, metricsRepository, projectRepository, platformRepository, sessionsRepository, tokenService, workflowRepository, webhookSweepIntervalMs: 0 });
  const created = await request(app).post('/api/integrations/oauth-applications').set('Authorization', `Bearer ${token}`).send({ name: 'Bug Reporter fixture', projectIds: ['project-a'], redirectUris: ['http://127.0.0.1:4320/api/auth/odin/callback'], scopes });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const basic = `Basic ${Buffer.from(created.body.value.clientId + ':' + created.body.clientSecret).toString('base64')}`;
  const issued = await request(app).post('/api/v1/oauth/token').set('Authorization', basic).type('form').send({ grant_type: 'client_credentials', scope: scopes.join(' ') });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { app, applicationId: created.body.value.id, authRepository, metricsRepository, platformRepository, projectRepository, sessionsRepository, tokenService, workflowRepository, auth: `Bearer ${issued.body.access_token}`, session: `Bearer ${token}` };
}
const body = (fields = {}, extra = {}) => ({ title: 'Checkout total is wrong', description: 'Steps: add two items. Expected $20; saw $10.', reportUrl, reporter: { kind: 'collaborator', id: 'stakeholder-1', name: 'External tester' }, fields, ...extra });

test('Bug Reporter tickets sync fields, comments and files through the application token', async () => {
  const { app, projectRepository, workflowRepository, auth } = await fixture();
  const put = (payload, id = reportId, project = 'project-a') => request(app).put(`/api/v1/bug-reporter/projects/${project}/tickets/${id}`).set('Authorization', auth).send(payload);

  assert.equal((await put(body({ status: 'New', priority: 'Normal', assigneeId: null }), reportId, 'project-b')).status, 404);
  assert.equal((await put(body({ status: 'New' }), 'not-a-uuid')).status, 404);
  assert.equal((await put(body({ status: 'Waiting' }))).status, 400);
  assert.equal((await put(body({ status: 'toString' }))).status, 400);
  assert.equal((await put(body({ assigneeId: ' ' }))).status, 400);
  assert.equal((await put(body({ priority: '__proto__' }))).status, 400);
  assert.equal((await put({ ...body(), reportUrl: `${reportUrl}&pad=${'x'.repeat(3000)}` })).status, 400);
  assert.equal((await put(body({ title: 'Two\nlines' }))).status, 400);
  assert.equal((await put({ ...body(), reportUrl: `https://evil.example/?reportId=${reportId}` })).status, 403);

  const created = await put(body({ status: 'New', priority: 'High', assigneeId: null }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual({ ...created.body.ticket, updatedAt: undefined, version: undefined }, { ticketId: reportId, status: 'New', odinStatus: 'new', priority: 'High', odinPriority: 2, assigneeId: null, title: 'Checkout total is wrong', updatedAt: undefined, version: undefined, reopenCount: 0 });
  const stored = (await projectRepository.getProjectDetail({ projectId: 'project-a', tenantId })).tickets.find(ticket => ticket.id === reportId);
  assert.equal(stored.category, 'defect');
  assert.equal(stored.externalReviewState, 'pending');
  assert.match(stored.description, /Reported by External tester in Bug Reporter/);

  const replay = await put(body({ status: 'New', priority: 'High', assigneeId: null }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ticket.version, created.body.ticket.version);

  assert.equal((await put(body({ assigneeId: 'outsider' }))).status, 409);
  const renamedInBody = await put(body({}, { title: 'Ignored after creation' }));
  assert.equal(renamedInBody.body.ticket.title, 'Checkout total is wrong');
  const updated = await put(body({ status: 'In progress', assigneeId: 'member', priority: 'Urgent', title: 'Checkout total halves' }, { actorId: 'member' }));
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.ticket.status, 'In progress');
  assert.equal(updated.body.ticket.assigneeId, 'member');
  assert.equal(updated.body.ticket.odinPriority, 1);
  assert.equal(updated.body.ticket.title, 'Checkout total halves');
  // In progress is reached through the workflow, one recorded transition at a time.
  const history = (await workflowRepository.listSnapshot({ tenantId })).histories.filter(item => item.itemId === reportId);
  assert.deepEqual(history.map(item => item.toState), ['triage', 'open', 'in_progress']);
  assert.equal(history[0].userId, 'member');
  const blocked = await put(body({ status: 'New' }));
  assert.equal(blocked.body.ticket.statusBlocked, true);
  assert.equal(blocked.body.ticket.status, 'In progress');
  // Work in progress was never resolved, so asking for New is not a reopen.
  assert.equal(blocked.body.ticket.reopenCount, 0);

  const listed = await request(app).get(`/api/v1/bug-reporter/projects/project-a/tickets?reportIds=${reportId}`).set('Authorization', auth);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.tickets[0].status, 'In progress');

  const comments = `/api/v1/bug-reporter/projects/project-a/tickets/${reportId}/comments`;
  assert.equal((await request(app).post(comments).set('Authorization', auth).send({ authorId: 'outsider', body: 'Nope' })).status, 409);
  const comment = await request(app).post(comments).set('Authorization', auth).send({ authorId: 'member', body: 'Reproduced <b>locally</b>.\nSecond line.' });
  assert.equal(comment.status, 201, JSON.stringify(comment.body));
  const read = await request(app).get(comments).set('Authorization', auth);
  assert.deepEqual(read.body.comments.map(item => [item.id, item.authorId, item.authorName, item.body]), [[comment.body.comment.id, 'member', 'Project member', 'Reproduced <b>locally</b>.\nSecond line.']]);

  assert.equal((await request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${reportId}/files/notes.pdf`).set('Authorization', auth).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'))).status, 400);
  const file = `/api/v1/bug-reporter/projects/project-a/tickets/${reportId}/files/bug-reporter-1-notes.pdf`;
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  assert.equal((await request(app).put(file).set('Authorization', auth).set('Content-Type', 'image/svg+xml').send(Buffer.from('<svg/>'))).status, 400);
  const saved = await request(app).put(file).set('Authorization', auth).set('Content-Type', 'application/pdf').send(pdf);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await request(app).put(file).set('Authorization', auth).set('Content-Type', 'application/pdf').send(pdf);
  const files = await projectRepository.listFiles({ projectId: 'project-a', targetId: reportId, targetType: 'ticket', tenantId });
  assert.deepEqual(files.map(item => item.fileName), ['bug-reporter-1-notes.pdf']);
  assert.equal(files[0].uploadedBy?.id ?? files[0].userId, 'admin');

  // One file can be nearly Bug Reporter's 25 MiB limit; a body past 26 MiB is refused.
  const large = Buffer.alloc(25 * 1024 * 1024 - 1, 1);
  large.write('%PDF-1.7');
  const largeSaved = await request(app).put(file.replace('-1-notes', '-2-forms')).set('Authorization', auth).set('Content-Type', 'application/pdf').send(large);
  assert.equal(largeSaved.status, 200, JSON.stringify(largeSaved.body));
  const tooLarge = await request(app).put(file.replace('-1-notes', '-3-huge')).set('Authorization', auth).set('Content-Type', 'application/pdf').send(Buffer.alloc(26 * 1024 * 1024 + 1, 1));
  assert.equal(tooLarge.status, 413);
});

test('ticket synchronization requires projects.write', async () => {
  const { app, auth } = await fixture(['projects.read']);
  assert.equal((await request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${reportId}`).set('Authorization', auth).send(body({ status: 'New' }))).status, 403);
});

test('closing a ticket from Bug Reporter credits its assignee on the contributor leaderboard', async () => {
  const { app, metricsRepository, auth } = await fixture();
  const put = (payload) => request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${reportId}`).set('Authorization', auth).send(payload);
  assert.equal((await put(body({ status: 'New', assigneeId: 'member' }))).status, 201);
  assert.equal((await put(body({ status: 'Resolved' }, { actorId: 'member' }))).status, 200);
  assert.deepEqual(metricsRepository.rows, []);

  const closed = await put(body({ status: 'Closed' }, { actorId: 'member' }));
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual(metricsRepository.rows.map((row) => [row.userId, row.tasksCompleted, row.pointsCompleted]), [['member', 1, 0]]);
});

test('long descriptions fit the Odin item limit and keep the report link', async () => {
  const { app, projectRepository, auth } = await fixture();
  const created = await request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${reportId}`).set('Authorization', auth).send(body({ status: 'New' }, { description: 'x'.repeat(20000) }));
  assert.equal(created.status, 201);
  const stored = (await projectRepository.getProjectDetail({ projectId: 'project-a', tenantId })).tickets.find(ticket => ticket.id === reportId);
  assert.ok(stored.description.length <= 5000);
  assert.ok(stored.description.includes(reportUrl));
});

test('a ticket binding to a workflow that no longer supports tickets is rejected', async () => {
  const { app, workflowRepository, auth } = await fixture();
  const workflow = (await workflowRepository.listSnapshot({ tenantId })).workflows[0];
  await workflowRepository.updateWorkflow({ tenantId, workflowId: workflow.id, input: { itemTypes: ['task'], expectedVersion: workflow.version } });
  const response = await request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${reportId}`).set('Authorization', auth).send(body({ status: 'New' }));
  assert.equal(response.status, 409);
});

const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
const ticketFor = (app, auth, id, reporter, fields = { status: 'New' }) => request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${id}`).set('Authorization', auth)
  .send({ ...body(fields), reportUrl: `http://127.0.0.1:4320/?projectId=aca&reportId=${id}`, reporter });
const upload = (app, auth, id, name, uploader) => {
  const call = request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${id}/files/${name}`).set('Authorization', auth).set('Content-Type', 'application/pdf');
  return (uploader ? call.set('X-Bug-Reporter-Uploader', uploader) : call).send(pdf);
};
const ticketFiles = (projectRepository, id) => projectRepository.listFiles({ projectId: 'project-a', targetId: id, targetType: 'ticket', tenantId });

test('a collaborator owns their attachments through an account that cannot sign in', async () => {
  const { app, auth, authRepository, projectRepository, sessionsRepository, tokenService } = await fixture(undefined, { stakeholders: [{ id: 'stakeholder-1', name: 'External tester', email: 'Tester@Client.example' }] });
  const reporter = { kind: 'collaborator', id: 'stakeholder-1', name: 'External tester' };
  assert.equal((await ticketFor(app, auth, reportId, reporter)).status, 201);
  assert.equal((await upload(app, auth, reportId, 'bug-reporter-1-first.pdf')).status, 200);
  assert.equal((await upload(app, auth, reportId, 'bug-reporter-2-second.pdf')).status, 200);
  // A retried upload and a replayed ticket add nothing.
  assert.equal((await upload(app, auth, reportId, 'bug-reporter-1-first.pdf')).status, 200);
  assert.equal((await ticketFor(app, auth, reportId, reporter)).status, 200);
  const files = await ticketFiles(projectRepository, reportId);
  assert.deepEqual(files.map(file => file.fileName).sort(), ['bug-reporter-1-first.pdf', 'bug-reporter-2-second.pdf']);
  assert.equal((await projectRepository.getProjectDetail({ projectId: 'project-a', tenantId })).tickets.filter(ticket => ticket.id === reportId).length, 1);

  // One account per stakeholder email owns both files; it has no membership and cannot sign in.
  assert.equal(new Set(files.map(file => file.uploadedBy.id)).size, 1);
  const owner = await authRepository.findUserById(files[0].uploadedBy.id);
  assert.equal(owner.email, 'tester@client.example');
  assert.equal(owner.name, 'External tester');
  assert.deepEqual(owner.memberships, []);
  assert.equal(owner.loginDisabled, true);
  assert.equal(authRepository.state.users.filter(user => user.email === 'tester@client.example').length, 1);

  assert.equal((await request(app).post('/api/auth/login').send({ email: 'tester@client.example', password: 'Anything-123!' })).status, 401);
  const google = { getUserInfoFromCode: async () => ({ email: 'tester@client.example', emailVerified: true, name: 'Tester' }) };
  await assert.rejects(handleGoogleCallback({ code: 'code', frontendAppUrl: 'http://127.0.0.1:5173', googleOAuthClient: google, repository: authRepository, sessionsRepository, sessionMeta: {}, tokenService }), { statusCode: 401 });
  // A session made for it some other way is still refused on use.
  const forged = tokenService.signSessionToken({ ...owner, tenantId: undefined });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(forged).exp * 1000), token: forged, userId: owner.id });
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status, 401);

  // It is not a project member, so it cannot be an assignee or comment author either.
  assert.equal((await ticketFor(app, auth, reportId, reporter, { assigneeId: owner.id })).status, 409);
  assert.equal((await request(app).post(`/api/v1/bug-reporter/projects/project-a/tickets/${reportId}/comments`).set('Authorization', auth).send({ authorId: owner.id, body: 'Hello' })).status, 409);

  // An invitation to that address lets the person claim the account; their files stay theirs.
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  const { invitation } = await tenantsRepository.inviteUser({ tenantId, email: 'tester@client.example', role: 'user' });
  const accepted = await tenantsRepository.acceptInvite({ inviteToken: invitation.inviteToken, registration: { name: 'Tess Tester', passwordHash: await bcrypt.hash('Claimed-pass-123!', 4) } });
  assert.equal(accepted.userId, owner.id);
  assert.equal((await authRepository.findUserById(owner.id)).loginDisabled, false);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'tester@client.example', password: 'Claimed-pass-123!' })).status, 200);
  assert.ok((await ticketFiles(projectRepository, reportId)).every(file => file.uploadedBy.id === owner.id));
  // An ordinary account is still not claimable by invitation.
  const { invitation: other } = await tenantsRepository.inviteUser({ tenantId, email: 'outsider@example.test', role: 'user' });
  await assert.rejects(tenantsRepository.acceptInvite({ inviteToken: other.inviteToken, registration: { name: 'Someone', passwordHash: 'x' } }), { statusCode: 409 });
});

test('attachment ownership stays inside the project and tenant and falls back only to members', async () => {
  const otherTenantId = '33333333-3333-4333-8333-333333333333';
  const { app, applicationId, auth, authRepository, platformRepository, projectRepository } = await fixture(undefined, { stakeholders: [
    { id: 'stakeholder-b', projectId: 'project-b', name: 'Project B tester', email: 'b@client.example' },
    { id: 'stakeholder-t', tenantId: otherTenantId, name: 'Other tenant tester', email: 't@client.example' },
    { id: 'stakeholder-m', name: 'Member listed as stakeholder', email: 'member@example.test' },
  ] });
  // As in production, the application's creator is not an Odin user, so nothing else can own the file.
  platformRepository.state.applications.get(applicationId).createdBy = 'deployment:fixture';
  const usersBefore = authRepository.state.users.length;

  for (const stakeholderId of ['stakeholder-b', 'stakeholder-t', 'stakeholder-missing']) {
    const id = randomUUID();
    assert.equal((await ticketFor(app, auth, id, { kind: 'collaborator', id: stakeholderId, name: 'Someone' })).status, 201);
    const response = await upload(app, auth, id, 'bug-reporter-1-shot.pdf');
    assert.equal(response.status, 409, stakeholderId);
    assert.equal((await ticketFiles(projectRepository, id)).length, 0);
  }
  assert.equal(authRepository.state.users.length, usersBefore);

  // An internal reporter who is a project member owns their file; one who is not cannot.
  const internal = randomUUID();
  assert.equal((await ticketFor(app, auth, internal, { kind: 'internal', id: 'member', name: 'Project member' })).status, 201);
  assert.equal((await upload(app, auth, internal, 'bug-reporter-1-shot.pdf', 'member')).status, 200);
  assert.equal((await ticketFiles(projectRepository, internal))[0].uploadedBy.id, 'member');
  const outsider = randomUUID();
  assert.equal((await ticketFor(app, auth, outsider, { kind: 'internal', id: 'outsider', name: 'Other user' })).status, 201);
  assert.equal((await upload(app, auth, outsider, 'bug-reporter-1-shot.pdf', 'outsider')).status, 409);

  // A stakeholder whose email is already an Odin account is that person: the account owns the file unchanged.
  const listed = randomUUID();
  assert.equal((await ticketFor(app, auth, listed, { kind: 'collaborator', id: 'stakeholder-m', name: 'Member listed as stakeholder' })).status, 201);
  assert.equal((await upload(app, auth, listed, 'bug-reporter-1-shot.pdf')).status, 200);
  assert.equal((await ticketFiles(projectRepository, listed))[0].uploadedBy.id, 'member');
  const member = await authRepository.findUserById('member');
  assert.equal(member.name, 'Project member');
  assert.equal(member.loginDisabled, false);
  assert.equal(authRepository.state.users.length, usersBefore);
});

const syncTicket = (app, auth, id = reportId) => fields => request(app).put(`/api/v1/bug-reporter/projects/project-a/tickets/${id}`).set('Authorization', auth)
  .send({ ...body(fields), reportUrl: `http://127.0.0.1:4320/?projectId=aca&reportId=${id}` });

test('a reopened report returns its ticket to New and counts each reopen once', async () => {
  const { app, auth, session, workflowRepository } = await fixture();
  const put = syncTicket(app, auth);
  const created = await put({ status: 'New' });
  assert.equal(created.status, 201);
  assert.equal(created.body.ticket.reopenCount, 0);
  assert.equal((await put({ status: 'Resolved' })).body.ticket.status, 'Resolved');

  // The default workflow has no path from resolved back to new; a reopen still lands there.
  const reopened = await put({ status: 'New' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.deepEqual([reopened.body.ticket.status, reopened.body.ticket.odinStatus, reopened.body.ticket.reopenCount, reopened.body.ticket.statusBlocked], ['New', 'new', 1, undefined]);
  const history = (await workflowRepository.listSnapshot({ tenantId })).histories.filter(item => item.itemId === reportId);
  assert.deepEqual([history.at(-1).fromState, history.at(-1).toState, history.at(-1).transitionKey], ['resolved', 'new', 'bug_reporter_reopen']);

  // The same reopen delivered again changes nothing.
  const replay = await put({ status: 'New' });
  assert.equal(replay.body.ticket.reopenCount, 1);
  assert.equal(replay.body.ticket.version, reopened.body.ticket.version);

  assert.equal((await put({ status: 'Closed' })).body.ticket.status, 'Closed');
  assert.equal((await put({ status: 'New' })).body.ticket.reopenCount, 2);

  const polled = await request(app).get(`/api/v1/bug-reporter/projects/project-a/tickets?reportIds=${reportId}`).set('Authorization', auth);
  assert.equal(polled.body.tickets[0].reopenCount, 2);

  // Odin's ticket list carries the count and can show only reopened tickets.
  assert.equal((await syncTicket(app, auth, randomUUID())({ status: 'New' })).status, 201);
  const all = await request(app).get('/api/projects/tickets').set('Authorization', session);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.tickets.map(ticket => ticket.reopenCount).sort(), [0, 2]);
  const reopenedOnly = await request(app).get('/api/projects/tickets?reopened=true').set('Authorization', session);
  assert.deepEqual(reopenedOnly.body.tickets.map(ticket => [ticket.id, ticket.reopenCount]), [[reportId, 2]]);
  assert.ok(Date.parse(reopenedOnly.body.tickets[0].lastReopenedAt) > Date.parse(created.body.ticket.updatedAt));
});

test('only a Bug Reporter sync from Resolved or Closed counts as a reopen', async () => {
  const { app, auth, session, projectRepository, workflowRepository } = await fixture();
  // Without a ticket workflow every status is reachable, so In progress can go straight back to New.
  const binding = (await workflowRepository.listSnapshot({ tenantId })).bindings[0];
  await workflowRepository.deleteBinding({ bindingId: binding.id, expectedVersion: binding.version, tenantId });
  const put = syncTicket(app, auth);
  assert.equal((await put({ status: 'New' })).status, 201);
  assert.equal((await put({ status: 'In progress' })).body.ticket.status, 'In progress');
  const backToNew = await put({ status: 'New' });
  assert.deepEqual([backToNew.body.ticket.status, backToNew.body.ticket.reopenCount], ['New', 0]);
  assert.equal((await put({ status: 'Closed' })).body.ticket.status, 'Closed');
  assert.equal((await put({ status: 'New' })).body.ticket.reopenCount, 1);

  // A member moving the ticket inside Odin is not a reporter reopen, and the count cannot be edited.
  assert.equal((await put({ status: 'Resolved' })).body.ticket.status, 'Resolved');
  const ticket = (await projectRepository.getProjectDetail({ projectId: 'project-a', tenantId })).tickets.find(item => item.id === reportId);
  const moved = await request(app).patch(`/api/projects/project-a/items/${reportId}`).set('Authorization', session)
    .send({ expectedVersion: ticket.version, patch: { status: 'new', reopenCount: 9 } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.item.status, moved.body.item.reopenCount], ['new', 1]);
});
