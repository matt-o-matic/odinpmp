import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus, LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { generateAccessToken, hashAccessToken } from '../src/modules/access/access-links.js';
import { createInMemoryAccessRepository } from '../src/modules/access/access.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

// Task access without a login: a manager gives someone without an
// Odin login task access on a project and sends them a link; the link opens a hub, the project's
// board and list, and lets them change only their own tasks.

const TENANT = 'tenant-acme';
const OTHER_TENANT = 'tenant-other';
const DAY_MS = 24 * 60 * 60 * 1000;
const dateIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
const today = dateIn(0);

function profile(name, extra = {}) {
  return { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', minBillRate: null, name, poolId: null, roles: [], skills: [], status: 'active', userId: null, ...extra };
}

function allocation(resourceId, projectId, extra = {}) {
  return { allocationPercent: 50, billRate: null, endDate: dateIn(60), hoursPerWeek: 20, origin: 'manual', projectId, resourceId, role: '', scenario: 'baseline', startDate: dateIn(-30), status: 'active', ...extra };
}

async function createAccessFixture() {
  const users = [
    { email: 'admin@acme.com', id: 'admin', name: 'Ada Admin', role: 'admin', tenantId: TENANT },
    { email: 'manager@acme.com', id: 'manager', name: 'Manny Manager', role: 'manager', tenantId: TENANT },
    { email: 'member@acme.com', id: 'member', name: 'Mona Member', role: 'user', tenantId: TENANT },
    { email: 'olga@other.com', id: 'olga', name: 'Olga Other', role: 'manager', tenantId: OTHER_TENANT },
  ].map(({ role, tenantId, ...user }) => ({ ...user, authMethod: 'basic', memberships: [{ role, tenantId }], password: 'Secret123!' }));
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }, { domains: ['other.com'], id: OTHER_TENANT, name: 'Other Co' }],
    users,
  });

  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  const create = (input, tenantId = TENANT) => resourceFinanceRepository.createResource({ input, tenantId });
  const casey = await create(profile('Casey Contractor', { email: 'casey@vendor.example' }));
  const dana = await create(profile('Dana Vendor', { email: 'dana@vendor.example' }));
  const erin = await create(profile('Erin Engineer'));
  for (const [resource, projectId] of [[casey, 'project-1'], [casey, 'project-2'], [dana, 'project-1']]) {
    await resourceFinanceRepository.createAllocation({ input: allocation(resource.id, projectId), tenantId: TENANT });
  }
  const caseyId = `resource:${casey.id}`;

  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: { 'project-1': [{ id: 'member', role: 'member' }] },
      projects: [
        {
          epics: [{
            id: 'epic-1', name: 'Storefront', status: 'In Progress', stories: [
              {
                id: 'story-checkout', name: 'Checkout', sprintId: 'sprint-1', status: 'In Progress', tasks: [
                  { assigneeId: caseyId, assigneeName: 'Casey Contractor', description: 'Ask <span class="mention" data-mention-label="Mona Member" data-user-id="member">@Mona Member</span> about the layout.', id: 'task-casey', name: 'Card form', sprintId: 'sprint-1', status: 'Not Started' },
                  { assigneeId: `resource:${dana.id}`, assigneeName: 'Dana Vendor', id: 'task-dana', name: 'Receipts', status: 'In Progress' },
                ],
              },
              { id: 'story-reports', name: 'Reports', status: 'Not Started', tasks: [{ assigneeId: 'member', id: 'task-member', name: 'Export', status: 'Not Started' }] },
              { assigneeId: caseyId, assigneeName: 'Casey Contractor', id: 'story-onboarding', name: 'Onboarding', status: 'Not Started', tasks: [] },
              { id: 'story-archive', name: 'Archive', status: 'Completed', tasks: [] },
            ],
          }],
          id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: TENANT,
          tickets: [{ assigneeId: caseyId, id: 'ticket-1', name: 'Broken link', status: 'new' }],
        },
        {
          epics: [{ assigneeId: caseyId, assigneeName: 'Casey Contractor', id: 'epic-2', name: 'Invoices', status: 'Not Started', stories: [{ id: 'story-2', name: 'Ledger', status: 'Not Started', tasks: [{ assigneeId: caseyId, id: 'task-2', name: 'Import', status: 'Not Started' }] }] }],
          id: 'project-2', name: 'Billing', status: 'In Progress', tenantId: TENANT,
        },
        { epics: [], id: 'project-3', name: 'Elsewhere', status: 'In Progress', tenantId: OTHER_TENANT },
      ],
      sprints: [{ endDate: dateIn(7), id: 'sprint-1', name: 'Sprint 1', projectId: 'project-1', sortOrder: 0, startDate: dateIn(-7), status: 'active' }],
    },
  });

  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const accessRepository = createInMemoryAccessRepository();
  const mailRepository = createInMemoryMailRepository();
  const workflowRepository = createInMemoryWorkflowRepository();
  const liveEventBus = createLiveEventBus();
  const clock = { offsetMs: 0 };
  const tokenService = createTokenService({ issuer: 'test', secret: 'task-access-api-test-secret-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const sessions = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: user.id });
    sessions.set(user.id, `Bearer ${token}`);
  }

  const app = createApp({
    accessRateLimiter: createRequirementsPublicRateLimiter({ ip: { capacity: 10_000, refillPerSecond: 1_000 }, link: { capacity: 10_000, refillPerSecond: 1_000 } }),
    accessRepository,
    accessReviewCampaignSweepIntervalMs: 0,
    agentMonitorSweepIntervalMs: 0,
    assistantRepository,
    assistantStaleRunSweepIntervalMs: 0,
    authRepository,
    domainEventSweepIntervalMs: 0,
    frontendAppUrl: 'http://localhost:5173/app',
    liveEventBus,
    mailRepository,
    projectRepository,
    reportSubscriptionSweepIntervalMs: 0,
    reportingWarehouseSweepIntervalMs: 0,
    requirementsClock: () => new Date(Date.now() + clock.offsetMs),
    requirementsRepository,
    resourceFinanceRepository,
    sessionsRepository,
    tokenService,
    webhookSweepIntervalMs: 0,
    workflowAutomationSweepIntervalMs: 0,
    workflowRepository,
  });

  const call = (base) => (method, path, as, body) => {
    const pending = request(app)[method](`${base}${path}`).set('Authorization', sessions.get(as));
    return body === undefined ? pending : pending.send(body);
  };
  const planning = call('/api/resource-planning');
  const projects = call('/api/projects');
  const guest = (token) => ({
    del: (path) => request(app).delete(`/api/public/access/${token}${path}`),
    get: (path = '') => request(app).get(`/api/public/access/${token}${path}`),
    patch: (path, body) => request(app).patch(`/api/public/access/${token}${path}`).send(body),
    post: (path, body = {}) => request(app).post(`/api/public/access/${token}${path}`).send(body),
  });

  // Turns task access on for a resource and copies their link, returning its token.
  async function grant(resource, { projectId = 'project-1', scope = 'own' } = {}) {
    const set = await planning('put', `/projects/${projectId}/task-access/${resource.id}`, 'manager', { scope });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const link = await planning('post', `/projects/${projectId}/task-access/${resource.id}/link`, 'manager', { delivery: 'manual' });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    return link.body.url.split('/access/')[1];
  }

  async function stakeholderLink({ email = 'casey@vendor.example', projectId = 'project-2' } = {}) {
    const stakeholder = await assistantRepository.createProjectStakeholder({ projectId, tenantId: TENANT, value: { email, name: 'Casey C.', roleTitle: 'Vendor lead' } });
    const token = generateAccessToken();
    const issued = await requirementsRepository.issueAccessToken({
      createdBy: 'user:manager', now: new Date(Date.now() + clock.offsetMs), projectId, purpose: 'manual', stakeholderId: stakeholder.id, tenantId: TENANT, tokenHash: hashAccessToken(token),
    });
    return { link: issued.link, stakeholder, token };
  }

  return {
    accessRepository, app, assistantRepository, authRepository, casey, caseyId, clock, dana, erin, grant, guest, liveEventBus, mailRepository,
    planning, projectRepository, projects, requirementsRepository, resourceFinanceRepository, stakeholderLink, workflowRepository,
  };
}

const codeOf = (response) => response.body?.details?.code;

test('a profile without a login takes an email; a member\'s address and one already in use are refused', async () => {
  const f = await createAccessFixture();
  const setEmail = (email) => f.planning('patch', `/resources/${f.erin.id}`, 'manager', { email, expectedVersion: f.erin.version });

  const member = await setEmail('Member@Acme.com');
  assert.deepEqual([member.status, codeOf(member)], [409, 'email_has_login']);
  const taken = await setEmail('CASEY@vendor.example');
  assert.deepEqual([taken.status, codeOf(taken)], [409, 'email_in_use']);
  const saved = await setEmail('  Erin@Vendor.Example ');
  assert.deepEqual([saved.status, saved.body.value.email], [200, 'erin@vendor.example']);
  assert.equal((await setEmail('not-an-email')).status, 400);

  // Creating one checks the same, and a profile with a login has no email of its own.
  const created = await f.planning('post', '/resources', 'manager', { email: 'frank@vendor.example', name: 'Frank Freelancer' });
  assert.deepEqual([created.status, created.body.value.email], [201, 'frank@vendor.example']);
  const duplicate = await f.planning('post', '/resources', 'manager', { email: 'frank@vendor.example', name: 'Frank Again' });
  assert.deepEqual([duplicate.status, codeOf(duplicate)], [409, 'email_in_use']);
  const withLogin = await f.planning('post', '/resources', 'manager', { email: 'mona@vendor.example', name: 'Mona Member', userId: 'member' });
  assert.deepEqual([withLogin.status, codeOf(withLogin)], [400, 'resource_has_login']);
  // An inactive profile's address is free to use again.
  await f.resourceFinanceRepository.updateResource({ input: { expectedVersion: 1, status: 'inactive' }, resourceId: f.dana.id, tenantId: TENANT });
  assert.equal((await f.planning('post', '/resources', 'manager', { email: 'dana@vendor.example', name: 'Dana Again' })).status, 201);

  // Only resource managers see the addresses.
  const asMember = await f.planning('get', '/', 'member');
  assert.equal(asMember.body.resources.find((resource) => resource.id === f.erin.id).email, null);
  const asManager = await f.planning('get', '/', 'manager');
  assert.equal(asManager.body.resources.find((resource) => resource.id === f.erin.id).email, 'erin@vendor.example');
  const team = await f.planning('get', '/projects/project-1/team', 'manager');
  assert.equal(team.body.people.find((person) => person.resource.id === f.casey.id).resource.email, 'casey@vendor.example');
});

test('managers turn task access on and off for people without a login and email or copy their link', async () => {
  const f = await createAccessFixture();
  const list = async () => (await f.planning('get', '/projects/project-1/task-access', 'manager')).body.entries;

  assert.deepEqual(await list(), [
    { email: 'casey@vendor.example', link: null, name: 'Casey Contractor', resourceId: f.casey.id, scope: 'off' },
    { email: 'dana@vendor.example', link: null, name: 'Dana Vendor', resourceId: f.dana.id, scope: 'off' },
  ]);
  const own = await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'own' });
  assert.deepEqual([own.status, own.body.entry.scope], [200, 'own']);
  assert.equal((await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'everyone' })).status, 400);

  const copied = await f.planning('post', `/projects/project-1/task-access/${f.casey.id}/link`, 'manager', { delivery: 'manual' });
  assert.equal(copied.status, 200);
  assert.equal(copied.headers['cache-control'], 'no-store');
  assert.equal(copied.body.emailed, false);
  assert.match(copied.body.url, /^http:\/\/localhost:5173\/app\/access\/[A-Za-z0-9_-]{43}$/);
  assert.deepEqual((await list())[0].link, { expiresAt: null, lastUsedAt: null, status: 'active' });
  // Tokens are stored only as hashes.
  assert.ok(!JSON.stringify(f.accessRepository.state).includes(copied.body.url.split('/access/')[1]));

  const emailed = await f.planning('post', `/projects/project-1/task-access/${f.casey.id}/link`, 'manager', { delivery: 'email' });
  assert.deepEqual([emailed.status, emailed.body.emailed, emailed.body.url], [200, true, undefined]);
  const [mail] = f.mailRepository.state.queue;
  assert.deepEqual([mail.templateId, mail.recipientEmail, mail.subject], ['task-access-link-v1', 'casey@vendor.example', 'Manny Manager sent you a link to your work in Acme']);
  assert.match(mail.body, /Hello Casey Contractor/);
  assert.match(mail.body, /<li>Launch<\/li>/);
  assert.match(mail.body, /href="http:\/\/localhost:5173\/app\/access\/[A-Za-z0-9_-]{43}"/);

  // The same permission as managing the project's resources.
  assert.equal((await f.planning('get', '/projects/project-1/task-access', 'member')).status, 404);
  assert.equal((await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'member', { scope: 'all' })).status, 404);
  assert.equal((await f.planning('post', `/projects/project-1/task-access/${f.casey.id}/link`, 'member', { delivery: 'manual' })).status, 404);

  const refused = async (resource, code, body = { scope: 'own' }) => {
    const response = await f.planning('put', `/projects/project-1/task-access/${resource.id}`, 'manager', body);
    assert.deepEqual([response.status, codeOf(response)], [409, code]);
  };
  await refused(f.erin, 'resource_needs_email');
  await f.resourceFinanceRepository.updateResource({ input: { email: 'erin@vendor.example', expectedVersion: 1 }, resourceId: f.erin.id, tenantId: TENANT });
  await refused(f.erin, 'resource_not_on_project');
  const linked = await f.resourceFinanceRepository.createResource({ input: profile('Mona Member', { userId: 'member' }), tenantId: TENANT });
  await f.resourceFinanceRepository.createAllocation({ input: allocation(linked.id, 'project-1'), tenantId: TENANT });
  await refused(linked, 'resource_has_login');
  const offLink = await f.planning('post', `/projects/project-1/task-access/${f.dana.id}/link`, 'manager', { delivery: 'manual' });
  assert.deepEqual([offLink.status, codeOf(offLink)], [409, 'task_access_off']);

  const off = await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'off' });
  assert.deepEqual([off.status, off.body.entry.scope], [200, 'off']);
});

test('the hub lists task and requirements projects; requirements open in the unchanged portal', async () => {
  const f = await createAccessFixture();
  const requirements = await f.stakeholderLink();
  const token = await f.grant(f.casey);

  const hub = await f.guest(token).get();
  assert.equal(hub.status, 200);
  assert.equal(hub.headers['cache-control'], 'no-store');
  assert.deepEqual(hub.body, {
    link: { expiresAt: null, status: 'active' },
    ok: true,
    person: { email: 'casey@vendor.example', name: 'Casey Contractor' },
    projects: [
      { id: 'project-2', name: 'Billing', requirements: true, tasks: null },
      { id: 'project-1', name: 'Launch', requirements: false, tasks: { scope: 'own' } },
    ],
  });

  // Opening requirements mints a token on the stakeholder's own link and leaves the link as it was.
  const before = await f.requirementsRepository.getAccessLink({ linkId: requirements.link.id, projectId: 'project-2', tenantId: TENANT });
  const opened = await f.guest(token).post('/projects/project-2/requirements');
  assert.equal(opened.status, 201);
  const portal = await request(f.app).get(`/api/public/requirements/${opened.body.token}`);
  assert.deepEqual([portal.status, portal.body.project.name], [200, 'Billing']);
  const after = await f.requirementsRepository.getAccessLink({ linkId: requirements.link.id, projectId: 'project-2', tenantId: TENANT });
  assert.equal(after.issuedAt, before.issuedAt);
  assert.deepEqual(after.tokens.at(-1).purpose, 'access');
  assert.match(after.tokens.at(-1).createdBy, /^access-link:/);
  const noRequirements = await f.guest(token).post('/projects/project-1/requirements');
  assert.deepEqual([noRequirements.status, codeOf(noRequirements)], [404, 'no_project_access']);

  // A requirements token never opens the access link.
  const sideways = await f.guest(requirements.token).get();
  assert.deepEqual([sideways.status, codeOf(sideways)], [404, 'link_not_found']);

  // Turning the access link off turns off what it minted, and nothing else.
  const revoked = await f.planning('post', `/resources/${f.casey.id}/access-link/revoke`, 'manager');
  assert.deepEqual(revoked.body, { ok: true, revoked: true });
  assert.equal((await request(f.app).get(`/api/public/requirements/${opened.body.token}`)).status, 410);
  assert.equal((await request(f.app).get(`/api/public/requirements/${requirements.token}`)).status, 200);
  const gone = await f.guest(token).get();
  assert.deepEqual([gone.status, codeOf(gone)], [410, 'link_revoked']);
  assert.deepEqual((await f.planning('get', `/resources/${f.casey.id}/access-link`, 'manager')).body.link.status, 'revoked');

  // A new link starts afresh; the old token stays off.
  const fresh = await f.planning('post', `/projects/project-1/task-access/${f.casey.id}/link`, 'manager', { delivery: 'manual' });
  assert.equal((await f.guest(fresh.body.url.split('/access/')[1]).get()).status, 200);
  assert.equal((await f.guest(token).get()).status, 410);
});

test('the board and list show the project\'s columns and the scope\'s work, by name only', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey);

  const own = await f.guest(token).get('/projects/project-1/tasks');
  assert.equal(own.status, 200);
  assert.deepEqual([own.body.scope, own.body.project, own.body.me], ['own', { id: 'project-1', name: 'Launch' }, { assigneeId: f.caseyId, name: 'Casey Contractor' }]);
  assert.deepEqual(own.body.columns.map((column) => [column.key, column.name, column.defaultStatus, column.statuses]), [
    ['not-started', 'Not Started', 'Not Started', ['Not Started']],
    ['in-progress', 'In Progress', 'In Progress', ['In Progress']],
    ['at-risk', 'At Risk', 'At Risk', ['At Risk']],
    ['review', 'Review', 'Review', ['Review']],
    ['completed', 'Completed', 'Completed', ['Completed']],
  ]);
  assert.deepEqual(own.body.sprints.map((sprint) => [sprint.id, sprint.name, sprint.status]), [['sprint-1', 'Sprint 1', 'active']]);
  assert.deepEqual(own.body.stories.map((story) => [story.id, story.epicName, story.canAddTask]), [['story-checkout', 'Storefront', true], ['story-onboarding', 'Storefront', true]]);
  // Their task, and the story assigned to them, as cards.
  assert.deepEqual(own.body.items, [{
    actualHours: null, assigneeName: 'Casey Contractor', boardColumn: 'not-started', description: 'Ask @Mona Member about the layout.', epicId: 'epic-1', epicName: 'Storefront',
    id: 'task-casey', itemType: 'task', mine: true, name: 'Card form', parentName: 'Checkout', priority: 4, remainingHours: null, sprintId: 'sprint-1', status: 'Not Started',
    storyId: 'story-checkout', targetEndDate: null, targetHourEstimate: null, targetStartDate: null, updatedAt: own.body.items[0].updatedAt, version: 1,
  }, {
    actualHours: null, assigneeName: 'Casey Contractor', boardColumn: 'not-started', description: '', epicId: 'epic-1', epicName: 'Storefront',
    id: 'story-onboarding', itemType: 'story', mine: true, name: 'Onboarding', parentName: 'Storefront', priority: 4, remainingHours: null, sprintId: null, status: 'Not Started',
    storyId: 'story-onboarding', targetEndDate: null, targetHourEstimate: null, targetStartDate: null, updatedAt: own.body.items[1].updatedAt, version: 1,
  }]);

  await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'all' });
  const all = await f.guest(token).get('/projects/project-1/tasks');
  assert.equal(all.body.scope, 'all');
  // Every story and task, as on the app's board.
  assert.deepEqual(all.body.items.map((item) => [item.id, item.itemType, item.assigneeName, item.mine]), [
    ['story-checkout', 'story', '', false], ['task-casey', 'task', 'Casey Contractor', true], ['task-dana', 'task', 'Dana Vendor', false],
    ['story-reports', 'story', '', false], ['task-member', 'task', 'Mona Member', false],
    ['story-onboarding', 'story', 'Casey Contractor', true], ['story-archive', 'story', '', false],
  ]);
  assert.deepEqual(all.body.stories.map((story) => [story.id, story.canAddTask]), [
    ['story-checkout', true], ['story-reports', true], ['story-onboarding', true], ['story-archive', false],
  ]);
  // Names only: no emails, no user ids, no tickets.
  const text = JSON.stringify(all.body);
  for (const leak of ['@acme.com', '@vendor.example', '"member"', 'data-user-id', 'ticket-1', 'assigneeId":"member']) assert.ok(!text.includes(leak), leak);
});

test('on their own task they change status by control or drag, set remaining hours, comment, and log and delete time', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey);
  const link = f.guest(token);

  const moved = await link.patch('/projects/project-1/tasks/task-casey', { expectedVersion: 1, status: 'In Progress' });
  assert.deepEqual([moved.status, moved.body.task.status, moved.body.task.boardColumn, moved.body.task.version], [200, 'In Progress', 'in-progress', 2]);
  const dragged = await link.patch('/projects/project-1/tasks/task-casey', { boardColumn: 'review', expectedVersion: 2 });
  assert.deepEqual([dragged.body.task.status, dragged.body.task.boardColumn], ['Review', 'review']);
  const remaining = await link.patch('/projects/project-1/tasks/task-casey', { expectedVersion: 3, remainingHours: 4.5 });
  assert.equal(remaining.body.task.remainingHours, 4.5);
  for (const [body, code] of [[{ expectedVersion: 4, status: 'Blocked' }, 'status_not_allowed'], [{ boardColumn: 'nowhere', expectedVersion: 4 }, 'column_not_found']]) {
    const refused = await link.patch('/projects/project-1/tasks/task-casey', body);
    assert.deepEqual([refused.status, codeOf(refused)], [400, code]);
  }

  const comment = await link.post('/projects/project-1/tasks/task-casey/comments', { text: 'Done with the **layout**' });
  assert.equal(comment.status, 201);
  assert.deepEqual([comment.body.comment.authorName, comment.body.comment.mine, comment.body.comment.html.trim()], ['Casey Contractor', true, '<p>Done with the <strong>layout</strong></p>']);
  const comments = await link.get('/projects/project-1/tasks/task-casey/comments');
  assert.deepEqual(comments.body.comments.map((entry) => [entry.authorName, entry.mine]), [['Casey Contractor', true]]);

  const logged = await link.post('/projects/project-1/tasks/task-casey/time', { hours: 2, note: 'Wired it up', remainingHours: 3, workDate: today });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  assert.deepEqual([logged.body.entry.hours, logged.body.entry.status, logged.body.entry.note, logged.body.entry.workDate], [2, 'submitted', 'Wired it up', today]);
  assert.equal(logged.body.task.remainingHours, 3);
  const [stored] = (await f.resourceFinanceRepository.listSnapshot({ tenantId: TENANT })).timeEntries;
  assert.deepEqual([stored.resourceId, stored.projectId, stored.workItemId, stored.billable], [f.casey.id, 'project-1', 'task-casey', false]);
  const time = await link.get('/projects/project-1/tasks/task-casey/time');
  assert.deepEqual(time.body.entries.map((entry) => entry.id), [logged.body.entry.id]);

  const stale = await link.del(`/projects/project-1/time/${logged.body.entry.id}?expectedVersion=9`);
  assert.deepEqual([stale.status, codeOf(stale)], [409, 'version_conflict']);
  const deleted = await link.del(`/projects/project-1/time/${logged.body.entry.id}?expectedVersion=${logged.body.entry.version}`);
  assert.deepEqual([deleted.status, deleted.body], [200, { ok: true }]);
  assert.deepEqual((await link.get('/projects/project-1/tasks/task-casey/time')).body.entries, []);

  // Existing time rules hold: a locked period keeps its time, and approved time stays.
  await f.resourceFinanceRepository.createTimesheetPeriod({ input: { approvalDueDate: null, endDate: '2001-01-31', name: 'January 2001', startDate: '2001-01-01', status: 'locked' }, tenantId: TENANT });
  assert.equal((await link.post('/projects/project-1/tasks/task-casey/time', { hours: 1, workDate: '2001-01-15' })).status, 423);
  const approved = await f.resourceFinanceRepository.createTimeEntry({ input: { billable: false, hours: 1, note: '', periodId: null, projectId: 'project-1', resourceId: f.casey.id, status: 'approved', workDate: today, workItemId: 'task-casey' }, tenantId: TENANT });
  assert.equal((await link.del(`/projects/project-1/time/${approved.id}?expectedVersion=1`)).status, 404);
});

test('they add a task under an allowed story, assigned to them, in the story\'s sprint and the first column\'s status', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey);
  const link = f.guest(token);

  const created = await link.post('/projects/project-1/stories/story-checkout/tasks', { description: 'Check the <b>Luhn</b> digit', name: 'Card validation', targetHourEstimate: 3 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    [created.body.task.assigneeName, created.body.task.mine, created.body.task.status, created.body.task.sprintId, created.body.task.storyId, created.body.task.targetHourEstimate, created.body.task.description],
    ['Casey Contractor', true, 'Not Started', 'sprint-1', 'story-checkout', 3, 'Check the Luhn digit'],
  );
  const project = await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT });
  const saved = project.epics[0].stories[0].tasks.find((task) => task.id === created.body.task.id);
  assert.deepEqual([saved.assigneeId, saved.sprintId], [f.caseyId, 'sprint-1']);
  assert.equal((await link.post('/projects/project-1/stories/story-onboarding/tasks', { name: 'Welcome email' })).status, 201);

  const elsewhere = await link.post('/projects/project-1/stories/story-reports/tasks', { name: 'Not mine' });
  assert.deepEqual([elsewhere.status, codeOf(elsewhere)], [403, 'story_not_available']);
  assert.equal((await link.post('/projects/project-1/stories/story-checkout/tasks', { assigneeId: 'member', name: 'Sneaky' })).status, 400);

  await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'all' });
  assert.equal((await link.post('/projects/project-1/stories/story-reports/tasks', { name: 'Totals row' })).status, 201);
  const done = await link.post('/projects/project-1/stories/story-archive/tasks', { name: 'Too late' });
  assert.deepEqual([done.status, codeOf(done)], [403, 'story_not_available']);
});

test('the server refuses edits outside their own work and fields, and projects without a grant, whatever is sent', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey, { scope: 'all' });
  const link = f.guest(token);
  const patch = (itemId, body = { expectedVersion: 1, status: 'In Progress' }, projectId = 'project-1') => link.patch(`/projects/${projectId}/tasks/${itemId}`, body);

  for (const itemId of ['task-dana', 'task-member', 'story-checkout', 'epic-1', 'ticket-1', 'no-such-item']) {
    const refused = await patch(itemId);
    assert.deepEqual([refused.status, codeOf(refused)], [403, 'not_your_task'], itemId);
  }
  for (const body of [{ expectedVersion: 1, name: 'Renamed' }, { assigneeId: 'member', expectedVersion: 1 }, { expectedVersion: 1 }, { status: 'In Progress' }]) {
    assert.equal((await patch('task-casey', body)).status, 400, JSON.stringify(body));
  }
  const otherProject = await patch('task-2', { expectedVersion: 1, status: 'In Progress' }, 'project-2');
  assert.deepEqual([otherProject.status, codeOf(otherProject)], [404, 'no_project_access']);
  assert.equal(codeOf(await link.get('/projects/project-2/tasks')), 'no_project_access');
  assert.equal(codeOf(await link.post('/projects/project-1/tasks/task-dana/comments', { text: 'Hi' })), 'not_your_task');
  assert.equal(codeOf(await link.post('/projects/project-1/tasks/task-dana/time', { hours: 1, workDate: today })), 'not_your_task');
  const theirs = await f.resourceFinanceRepository.createTimeEntry({ input: { billable: false, hours: 1, note: '', periodId: null, projectId: 'project-1', resourceId: f.dana.id, status: 'submitted', workDate: today, workItemId: 'task-dana' }, tenantId: TENANT });
  assert.equal((await link.del(`/projects/project-1/time/${theirs.id}?expectedVersion=1`)).status, 404);
  const untouched = await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT });
  assert.deepEqual(untouched.epics[0].stories[0].tasks.map((task) => [task.id, task.status, task.version]), [['task-casey', 'Not Started', 1], ['task-dana', 'In Progress', 1]]);

  // A token from another workspace, for the same address, opens only that workspace.
  const otherResource = await f.resourceFinanceRepository.createResource({ input: profile('Casey Contractor', { email: 'casey@vendor.example' }), tenantId: OTHER_TENANT });
  await f.resourceFinanceRepository.createAllocation({ input: allocation(otherResource.id, 'project-3'), tenantId: OTHER_TENANT });
  await f.accessRepository.setTaskAccess({ by: 'olga', now: new Date(), projectId: 'project-3', resourceId: otherResource.id, scope: 'all', tenantId: OTHER_TENANT });
  const otherToken = generateAccessToken();
  await f.accessRepository.issueLinkToken({ createdBy: 'user:olga', email: 'casey@vendor.example', now: new Date(), purpose: 'manual', tenantId: OTHER_TENANT, tokenHash: hashAccessToken(otherToken) });
  assert.deepEqual((await f.guest(otherToken).get()).body.projects.map((project) => project.id), ['project-3']);
  const crossed = await f.guest(otherToken).patch('/projects/project-1/tasks/task-casey', { expectedVersion: 1, status: 'In Progress' });
  assert.deepEqual([crossed.status, codeOf(crossed)], [404, 'no_project_access']);
  assert.equal(codeOf(await f.guest('not-a-real-token').get()), 'link_not_found');
});

test('stories and epics assigned to them show as cards and take the same edits as their tasks', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey, { projectId: 'project-2' });
  const link = f.guest(token);

  // An epic assigned to them shows with no parent; its story only holds their task.
  const board = await link.get('/projects/project-2/tasks');
  assert.deepEqual(board.body.items.map((item) => [item.id, item.itemType, item.storyId, item.parentName]), [['epic-2', 'epic', null, null], ['task-2', 'task', 'story-2', 'Ledger']]);
  const epic = await link.patch('/projects/project-2/tasks/epic-2', { boardColumn: 'in-progress', expectedVersion: 1, remainingHours: 12 });
  assert.deepEqual([epic.status, epic.body.task.itemType, epic.body.task.status, epic.body.task.remainingHours], [200, 'epic', 'In Progress', 12]);
  assert.equal((await link.post('/projects/project-2/tasks/epic-2/comments', { text: 'Started' })).status, 201);
  const comments = await f.projects('get', '/project-2/comments?targetId=epic-2&targetType=epic', 'manager');
  assert.deepEqual(comments.body.comments.map((entry) => entry.author?.name), ['Casey Contractor']);
  const logged = await link.post('/projects/project-2/tasks/epic-2/time', { hours: 1, workDate: today });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  assert.equal(logged.body.task.itemType, 'epic');
  assert.deepEqual((await link.get('/projects/project-2/tasks/epic-2/time')).body.entries.map((entry) => entry.hours), [1]);
  // A story that only holds their task is not theirs to change.
  assert.equal(codeOf(await link.patch('/projects/project-2/tasks/story-2', { expectedVersion: 1, status: 'In Progress' })), 'not_your_task');

  // Completing their story completes their open tasks on it, but not anyone else's.
  const project = await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT });
  const checkout = project.epics[0].stories.find((story) => story.id === 'story-checkout');
  const assigned = await f.projects('patch', '/project-1/items/story-checkout', 'manager', { expectedVersion: checkout.version, patch: { assigneeId: f.caseyId } });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const own = f.guest(await f.grant(f.casey));
  const version = assigned.body.item.version;
  const blocked = await own.patch('/projects/project-1/tasks/story-checkout', { expectedVersion: version, status: 'Completed' });
  assert.deepEqual([blocked.status, codeOf(blocked), blocked.body.error], [409, 'story_has_others_open_tasks', 'Someone else still has an open task on this story, so it can\'t be completed here. Ask the project team.']);
  assert.equal((await own.patch('/projects/project-1/tasks/story-checkout', { expectedVersion: version, status: 'In Progress' })).status, 200);

  const dana = (await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT })).epics[0].stories[0].tasks.find((task) => task.id === 'task-dana');
  assert.equal((await f.projects('patch', '/project-1/items/task-dana', 'manager', { expectedVersion: dana.version, patch: { status: 'Completed' } })).status, 200);
  const completed = await own.patch('/projects/project-1/tasks/story-checkout', { expectedVersion: version + 1, status: 'Completed' });
  assert.deepEqual([completed.status, completed.body.task.status], [200, 'Completed']);
  const after = (await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT })).epics[0].stories[0].tasks;
  assert.deepEqual(after.map((task) => [task.id, task.status]), [['task-casey', 'Completed'], ['task-dana', 'Completed']]);
});

test('workflow rules and version checks apply, and history and comments show the resource\'s name', async () => {
  const f = await createAccessFixture();
  const states = ['Not Started', 'In Progress', 'Completed'].map((key, index) => ({ category: index === 2 ? 'done' : 'active', initial: index === 0, key, label: key, requiredFields: [], slaHours: 0, terminal: index === 2 }));
  const workflow = await f.workflowRepository.createWorkflow({
    input: {
      description: '', itemTypes: ['task'], name: 'Delivery', states, status: 'active',
      transitions: [
        { allowedRoles: [], approvalRequired: false, approverRoles: [], fromState: 'Not Started', key: 'start', requiredFields: [], toState: 'In Progress' },
        { allowedRoles: ['manager'], approvalRequired: false, approverRoles: [], fromState: 'In Progress', key: 'finish', requiredFields: [], toState: 'Completed' },
      ],
    },
    tenantId: TENANT,
  });
  await f.workflowRepository.createBinding({ input: { itemType: 'task', projectId: 'project-1', workflowId: workflow.id }, tenantId: TENANT });
  const token = await f.grant(f.casey);
  const link = f.guest(token);
  const events = [];
  const unsubscribe = f.liveEventBus.subscribe(LIVE_EVENT_CHANNELS.project('project-1'), (event) => events.push(event));

  const board = await link.get('/projects/project-1/tasks');
  assert.deepEqual(board.body.columns.map((column) => column.key), ['not-started', 'in-progress', 'completed']);
  const skipped = await link.patch('/projects/project-1/tasks/task-casey', { expectedVersion: 1, status: 'Completed' });
  assert.deepEqual([skipped.status, codeOf(skipped)], [409, 'workflow_transition_not_allowed']);
  const started = await link.patch('/projects/project-1/tasks/task-casey', { expectedVersion: 1, status: 'In Progress' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // A transition limited to roles is not theirs to make: they have no role on the project.
  const finished = await link.patch('/projects/project-1/tasks/task-casey', { expectedVersion: 2, status: 'Completed' });
  assert.deepEqual([finished.status, codeOf(finished)], [403, 'workflow_transition_role_denied']);
  const stale = await link.patch('/projects/project-1/tasks/task-casey', { expectedVersion: 1, remainingHours: 2 });
  assert.deepEqual([stale.status, codeOf(stale), stale.body.details.actualVersion], [409, 'version_conflict', 2]);

  const { histories } = await f.workflowRepository.listSnapshot({ tenantId: TENANT });
  assert.deepEqual(histories.map((history) => [history.itemId, history.toState, history.userId]), [['task-casey', 'In Progress', f.caseyId]]);
  const created = await link.post('/projects/project-1/stories/story-checkout/tasks', { name: 'Follow-up' });
  assert.deepEqual([created.status, created.body.task.status], [201, 'Not Started']);

  const revisions = await f.projects('get', '/project-1/items/task-casey/revisions', 'manager');
  assert.deepEqual(revisions.body.revisions.map((revision) => [revision.action, revision.actorUserId, revision.actorName]), [['update', f.caseyId, 'Casey Contractor']]);
  await link.post('/projects/project-1/tasks/task-casey/comments', { text: 'Started' });
  const comments = await f.projects('get', '/project-1/comments?targetId=task-casey&targetType=task', 'manager');
  assert.deepEqual(comments.body.comments.map((comment) => comment.author.name), ['Casey Contractor']);
  // Open project screens refresh: every write from the link is published with its actor.
  assert.deepEqual(events.map((event) => [event.actor.id, event.actor.name, event.reason]), [
    [f.caseyId, 'Casey Contractor', 'task-access-task-updated'],
    [f.caseyId, 'Casey Contractor', 'task-access-task-created'],
    [f.caseyId, 'Casey Contractor', 'task-access-commented'],
  ]);
  unsubscribe();
});

test('turning access off removes the project at once, the link lasts 14 days after the last grant, and revoked links stay off', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey);
  const link = f.guest(token);
  assert.equal((await link.get('/projects/project-1/tasks')).status, 200);

  await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'off' });
  const hub = await link.get();
  assert.deepEqual([hub.status, hub.body.projects, hub.body.link.status], [200, [], 'active']);
  assert.ok(Math.abs(Date.parse(hub.body.link.expiresAt) - (Date.now() + 14 * DAY_MS)) < 60_000);
  assert.equal(codeOf(await link.get('/projects/project-1/tasks')), 'no_project_access');

  f.clock.offsetMs = 15 * DAY_MS;
  const expired = await link.get();
  assert.deepEqual([expired.status, codeOf(expired)], [410, 'link_expired']);
  assert.ok(expired.body.details.expiredAt);
  // Turning access back on brings the link back while the grant is active.
  await f.planning('put', `/projects/project-1/task-access/${f.casey.id}`, 'manager', { scope: 'all' });
  assert.deepEqual((await link.get()).body.projects.map((project) => project.tasks), [{ scope: 'all' }]);

  await f.planning('post', `/resources/${f.casey.id}/access-link/revoke`, 'manager');
  assert.equal(codeOf(await link.get()), 'link_revoked');
});

test('grants need an active profile with no login, an allocation that has not ended, and a project that is not deleted', async () => {
  const f = await createAccessFixture();
  const token = await f.grant(f.casey);
  const projectIds = async () => (await f.guest(token).get()).body.projects.map((project) => project.id);
  const snapshot = async () => f.resourceFinanceRepository.listSnapshot({ tenantId: TENANT });
  const caseyAllocation = async () => (await snapshot()).allocations.find((record) => record.resourceId === f.casey.id && record.projectId === 'project-1');
  assert.deepEqual(await projectIds(), ['project-1']);

  const current = await caseyAllocation();
  await f.resourceFinanceRepository.updateAllocation({ allocationId: current.id, input: { endDate: dateIn(-1), expectedVersion: current.version }, tenantId: TENANT });
  assert.deepEqual(await projectIds(), []);
  const ended = await caseyAllocation();
  await f.resourceFinanceRepository.updateAllocation({ allocationId: ended.id, input: { endDate: dateIn(30), expectedVersion: ended.version }, tenantId: TENANT });
  assert.deepEqual(await projectIds(), ['project-1']);

  const resource = (await snapshot()).resources.find((record) => record.id === f.casey.id);
  await f.resourceFinanceRepository.updateResource({ input: { expectedVersion: resource.version, userId: 'member' }, resourceId: f.casey.id, tenantId: TENANT });
  assert.deepEqual(await projectIds(), []);
  await f.resourceFinanceRepository.updateResource({ input: { expectedVersion: resource.version + 1, userId: null }, resourceId: f.casey.id, tenantId: TENANT });
  assert.deepEqual(await projectIds(), ['project-1']);

  await f.projectRepository.softDeleteProject({ projectId: 'project-1', tenantId: TENANT, user: { id: 'admin' } });
  assert.deepEqual(await projectIds(), []);

  // Requirements count only while the stakeholder's requirements link is valid.
  const requirements = await f.stakeholderLink();
  assert.deepEqual(await projectIds(), ['project-2']);
  await f.requirementsRepository.revokeAccessLink({ linkId: requirements.link.id, now: new Date(), projectId: 'project-2', revokedBy: 'user:manager', tenantId: TENANT });
  assert.deepEqual(await projectIds(), []);
});

test('remaining hours round-trip through the app\'s item editor, and a tree save without them keeps them', async () => {
  const f = await createAccessFixture();
  const set = (version, remainingHours) => f.projects('patch', '/project-1/items/task-member', 'manager', { expectedVersion: version, patch: { remainingHours } });

  const saved = await set(1, 6.5);
  assert.deepEqual([saved.status, saved.body.item.remainingHours], [200, 6.5]);
  const detail = await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT });
  const strip = (nodes) => nodes.map(({ remainingHours: _remainingHours, stories, tasks, ...node }) => ({ ...node, ...(stories ? { stories: strip(stories) } : {}), ...(tasks ? { tasks: strip(tasks) } : {}) }));
  const tree = await f.projects('put', '/project-1/tree', 'manager', { epics: strip(detail.epics), expectedUpdatedAt: detail.updatedAt });
  assert.equal(tree.status, 200, JSON.stringify(tree.body));
  const kept = (await f.projectRepository.getProjectDetail({ projectId: 'project-1', tenantId: TENANT })).epics[0].stories[1].tasks[0];
  assert.equal(kept.remainingHours, 6.5);

  const cleared = await set(kept.version, '');
  assert.deepEqual([cleared.status, cleared.body.item.remainingHours], [200, null]);
  assert.equal((await set(cleared.body.item.version, -1)).status, 400);
  assert.equal((await set(cleared.body.item.version, 100001)).status, 400);
});
