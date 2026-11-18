import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { createInMemoryIdentityRepository } from '../src/modules/identity/identity.repository.js';
import { createInMemoryMetricsRepository, metricDateFor } from '../src/modules/metrics/metrics.repository.js';
import { createInMemoryPlatformRepository } from '../src/modules/platform/platform.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
import { createInMemoryUsersRepository } from '../src/modules/users/users.repository.js';

const TENANT = 'tenant-acme';
const PORTAL = 'project-portal';
// Monday 2026-10-12. Sprint 14 runs Monday 2026-10-05 to Friday 2026-10-16, so five of its
// ten working days are gone: exactly halfway.
const HALFWAY = new Date('2026-10-12T15:00:00.000Z');

function person(id, name, role, { twoFactorEnabled = false } = {}) {
  return {
    authMethod: 'basic',
    email: `${id.replace('user-', '')}@acme.com`,
    id,
    memberships: [{ role, tenantId: TENANT }],
    name,
    passwordHash: 'unused',
    preferences: { twoFactorEnabled },
  };
}

const story = (id, name, assigneeId, points, status, extra = {}) => ({ assigneeId, id, name, points, priority: 4, sprintId: 'sprint-14', status, ...extra });

// Sam has 30 points in Sprint 14 and has closed 7: under the line of 15, so behind. Dana has
// closed 15 of 20. Lee has closed none of 4. The sprint has closed 22 of 54 (line 27).
function seedPortal() {
  return {
    description: 'Customer portal.',
    endDate: '2026-12-04',
    epics: [{
      id: 'epic-portal',
      name: 'Portal',
      status: 'In Progress',
      stories: [
        story('story-sso', 'Finish SSO discovery', 'user-sam', 5, 'Not Started', { targetEndDate: '2026-10-07' }),
        {
          assigneeId: 'user-sam',
          id: 'story-kanban',
          name: 'Saved kanban views',
          sprintId: 'sprint-14',
          status: 'In Progress',
          tasks: [
            story('task-kv1', 'Per-user storage', 'user-sam', 7, 'Completed'),
            story('task-kv2', 'Share views', 'user-sam', 2, 'Not Started'),
            story('task-kv3', 'View picker', 'user-sam', 3, 'Not Started'),
          ],
        },
        story('story-netsuite', 'Map NetSuite cost centers', 'user-sam', 8, 'Not Started', { priority: 6, targetEndDate: '2026-10-13' }),
        story('story-export', 'CSV export', 'user-sam', 5, 'Not Started', { priority: 7 }),
        story('story-redirect', 'Redirect fix', 'user-dana', 15, 'Completed'),
        story('story-audit', 'Audit log', 'user-dana', 5, 'In Progress'),
        story('story-theme', 'Theme tokens', 'user-lee', 4, 'Not Started'),
      ],
    }],
    id: PORTAL,
    name: 'Customer Portal Rebuild',
    rank: 1,
    startDate: '2026-09-01',
    status: 'In Progress',
    tenantId: TENANT,
    tickets: [
      { assigneeId: 'user-sam', id: 'ticket-crash', name: 'Checkout crash', severity: 'S1', status: 'open' },
      { assigneeId: 'user-sam', id: 'ticket-typo', name: 'Typo', severity: 'S3', status: 'closed' },
    ],
    updatedAt: '2026-10-01T08:30:00.000Z',
  };
}

async function signIn({ sessionsRepository, tokenService }, user) {
  const role = user.memberships[0].role;
  const token = tokenService.signSessionToken({ email: user.email, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role, scopes: [`T${TENANT}-${role}`], tenantId: TENANT });
  const expiry = tokenService.verifySessionToken(token);
  await sessionsRepository.createSession({ expiryDate: new Date(expiry.exp * 1000), ipAddr: '127.0.0.1', locationName: 'Localhost', token, userAgent: 'test-agent', userId: user.id });
  return token;
}

async function createHomeTestApp({ governanceRepository = null, now = HALFWAY, projectRepositoryOverrides = {} } = {}) {
  const users = [
    person('user-priya', 'Priya Natarajan', 'user', { twoFactorEnabled: true }),
    person('user-sam', 'Sam Ortiz', 'user', { twoFactorEnabled: true }),
    person('user-dana', 'Dana Reyes', 'user'),
    person('user-lee', 'Lee Park', 'user'),
    person('user-morgan', 'Morgan Admin', 'admin', { twoFactorEnabled: true }),
    person('user-avery', 'Avery Second', 'admin', { twoFactorEnabled: true }),
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }], users });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        [PORTAL]: [
          { id: 'user-priya', role: 'manager' },
          { id: 'user-sam', role: 'contributor' },
          { id: 'user-dana', role: 'contributor' },
          { id: 'user-lee', role: 'member' },
        ],
      },
      projects: [seedPortal()],
      sprints: [
        { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', projectId: PORTAL, sortOrder: 1, startDate: '2026-10-05', status: 'active' },
        { endDate: '2026-10-30', id: 'sprint-15', name: 'Sprint 15', projectId: PORTAL, sortOrder: 2, startDate: '2026-10-19', status: 'planned' },
      ],
    },
  });
  for (const toItemId of ['story-audit', 'story-theme']) {
    await projectRepository.createWorkItemRelation({ input: { relationType: 'blocks', toItemId }, itemId: 'story-sso', projectId: PORTAL, tenantId: TENANT, user: { id: 'user-priya' } });
  }
  await projectRepository.saveSprintStaffing({ projectId: PORTAL, sprintId: 'sprint-14', staffing: [{ capacityHours: 240, userId: 'user-dana' }], tenantId: TENANT });
  Object.assign(projectRepository, projectRepositoryOverrides);

  const governance = governanceRepository ?? createInMemoryGovernanceRepository();
  await governance.createItem({ input: { description: '', dueDate: null, impact: 'critical', kind: 'risk', ownerId: 'user-priya', probability: 'medium', responsePlan: '', status: 'open', title: 'Vendor capacity' }, projectId: PORTAL, tenantId: TENANT });

  const identityRepository = createInMemoryIdentityRepository();
  await identityRepository.createImpersonationGrant({ input: { expiresAt: new Date(now.valueOf() + 4 * 3_600_000).toISOString(), reason: 'Support case', targetUserId: 'user-lee' }, requesterUserId: 'user-avery', tenantId: TENANT });
  const platformRepository = createInMemoryPlatformRepository();
  const subscription = await platformRepository.createWebhookSubscription({ createdBy: 'user-morgan', input: { description: '', eventTypes: ['workflow.transitioned'], name: 'Delivery receiver', url: 'https://hooks.example.com/odin' }, tenantId: TENANT });
  for (const id of ['delivery-1', 'delivery-2']) {
    platformRepository.state.deliveries.set(id, { attempts: 8, createdAt: '2026-10-07T09:00:00.000Z', id, status: 'dead', subscriptionId: subscription.id, tenantId: TENANT, version: 2 });
  }

  const today = metricDateFor(new Date());
  const metricsRepository = createInMemoryMetricsRepository([
    { metricDate: today, pointsCompleted: 34, projectId: PORTAL, tasksCompleted: 9, tenantId: TENANT, userId: 'user-sam' },
    { metricDate: today, pointsCompleted: 28, projectId: PORTAL, tasksCompleted: 7, tenantId: TENANT, userId: 'user-lee' },
    { metricDate: today, pointsCompleted: 21, projectId: PORTAL, tasksCompleted: 6, tenantId: TENANT, userId: 'user-dana' },
    { metricDate: today, pointsCompleted: 6, projectId: PORTAL, tasksCompleted: 2, tenantId: TENANT, userId: 'user-priya' },
  ]);

  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const assistantRepository = createInMemoryAssistantRepository();
  const clock = { now };
  const app = createApp({
    assistantRepository,
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    governanceRepository: governance,
    homeClock: () => clock.now,
    identityRepository,
    metricsRepository,
    platformRepository,
    projectRepository,
    sessionsRepository,
    tenantsRepository: createInMemoryTenantsRepository({ authRepository }),
    tokenService,
    usersRepository: createInMemoryUsersRepository({ authRepository }),
  });
  const tokens = {};
  for (const user of users) tokens[user.id] = await signIn({ sessionsRepository, tokenService }, user);
  return { app, assistantRepository, clock, governanceRepository: governance, projectRepository, tokens };
}

function getHome(app, token, query = '') {
  return request(app).get(`/api/home${query}`).set('Authorization', `Bearer ${token}`);
}

function stage(app, token, proposalId) {
  return request(app).post(`/api/home/recovery/${proposalId}/stage`).set('Authorization', `Bearer ${token}`);
}

function sprintOf(project, itemId) {
  for (const epic of project.epics) {
    for (const entry of epic.stories) {
      if (entry.id === itemId) return entry.sprintId;
      for (const task of entry.tasks ?? []) if (task.id === itemId) return task.sprintId;
    }
  }
  return undefined;
}

test('Home needs a signed-in person, a known view, and one the person has', async () => {
  const { app, tokens } = await createHomeTestApp();
  assert.equal((await request(app).get('/api/home')).status, 401);
  assert.equal((await getHome(app, tokens['user-sam'], '?lens=boss')).status, 400);
  const team = await getHome(app, tokens['user-sam'], '?lens=team');
  assert.equal(team.status, 403);
  assert.equal(team.body.details.code, 'home_lens_unavailable');
  assert.equal((await getHome(app, tokens['user-sam'], '?lens=workspace')).status, 403);
});

test('a member under half of their points at halfway is behind, with ranked focus and proposals', async () => {
  const { app, tokens } = await createHomeTestApp();
  const response = await getHome(app, tokens['user-sam']);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;

  assert.deepEqual(body.viewer.lenses, ['my-work']);
  assert.equal(body.viewer.lens, 'my-work');
  assert.equal(body.viewer.projectCount, 1);
  assert.equal(body.viewer.twoFactorEnabled, true);

  // 30 points assigned, 7 closed at the halfway point: behind, with a line of 15.
  assert.equal(body.status.kind, 'behind');
  assert.equal(body.status.scope, 'person');
  assert.equal(body.status.headline, "You're behind in Sprint 14");
  assert.equal(body.status.sprint.committedPoints, 30);
  assert.equal(body.status.sprint.donePoints, 7);
  assert.equal(body.status.sprint.threshold, 15);
  assert.equal(body.status.sprint.elapsedPct, 50);
  assert.ok(body.status.evidence.some((entry) => entry.label === 'You closed 7 of the 30 points assigned to you; half is 15.'));

  // Tier 1 sorts the blocker (2 people) ahead of the S1 ticket; tier 2 adds what is due tomorrow.
  assert.deepEqual(body.focus.items.map((item) => [item.rank, item.tier, item.title, item.reasons.map((reason) => reason.label)]), [
    [1, 1, 'Finish SSO discovery', ['Blocks 2 people', 'Overdue 5d']],
    [2, 1, 'Checkout crash', ['S1 ticket']],
    [3, 2, 'Map NetSuite cost centers', ['Due tomorrow']],
  ]);
  assert.deepEqual(body.focus.items[0].link, { name: 'project-detail', params: { projectId: PORTAL }, query: { item: 'story-sso' } });
  assert.deepEqual(body.focus.items[1].link, { name: 'tickets', query: { ticket: 'ticket-crash' } });
  assert.deepEqual(body.tabs, [
    { count: 3, key: 'focus', label: 'Focus now' },
    { count: 6, key: 'assigned', label: 'Assigned' },
    { count: 0, key: 'requirements', label: 'Requirements' },
    { count: 6, key: 'all', label: 'All' },
  ]);

  assert.equal(body.recovery.mode, 'hybrid');
  assert.deepEqual(body.recovery.subject, { personId: 'user-sam', projectId: PORTAL, scope: 'person', sprintId: 'sprint-14' });
  assert.deepEqual(body.recovery.proposals.map((proposal) => [proposal.type, proposal.summary, proposal.permitted]), [
    ['move-scope', 'Move 3 stories (18 pts) to Sprint 15', true],
    ['reassign', 'Reassign “Map NetSuite cost centers” to Dana Reyes', true],
    ['split-story', 'Split “Saved kanban views” and finish the started part', true],
  ]);
  assert.equal(body.recovery.proposals[1].detail, 'Dana has 80 free hours this sprint.');
  assert.equal(body.recovery.proposals[2].detail, 'Move 2 of 3 tasks to a new story in Sprint 15.');
  for (const proposal of body.recovery.proposals) {
    assert.match(proposal.id, /^rp_[a-f0-9]{16}$/);
    assert.equal(proposal.applyVia, 'ai-workspace');
    assert.equal(proposal.stage, undefined, 'the staged action stays on the server');
  }

  assert.deepEqual(body.rail.counts.map((entry) => [entry.key, entry.value, entry.note]), [
    ['due-week', 2, '1 overdue'],
    ['waiting', 0, 'nothing waiting'],
    ['in-review', 0, 'none in review'],
    ['alerts', 0, 'none critical'],
  ]);
  assert.equal(body.rail.sprints.length, 1);
  assert.deepEqual(body.rail.sprints[0].myItems, { done: 1, total: 6 });
  assert.equal(body.rail.sprints[0].idealPct, 50);
  assert.equal(body.rail.sprints[0].status, 'behind');
  assert.deepEqual(body.rail.leaderboard.top.map((row) => [row.rank, row.name, row.isCurrentUser]), [[1, 'Sam Ortiz', true], [2, 'Lee Park', false], [3, 'Dana Reyes', false]]);
  assert.equal(body.rail.leaderboard.me, null);
  assert.equal(body.rail.changeTrends.series.length, 30);
  assert.ok(body.sources.every((source) => source.status === 'ok'), JSON.stringify(body.sources));

  // The same data gives the same proposal ids.
  const again = await getHome(app, tokens['user-sam']);
  assert.deepEqual(again.body.recovery.proposals.map((proposal) => proposal.id), body.recovery.proposals.map((proposal) => proposal.id));
});

test('before the halfway point nobody is behind', async () => {
  const { app, tokens } = await createHomeTestApp({ now: new Date('2026-10-09T15:00:00.000Z') });
  const body = (await getHome(app, tokens['user-sam'])).body;
  assert.equal(body.status.kind, 'on-track');
  assert.equal(body.status.say, 'Sprint 14 is 41% done with 40% of the time gone.');
  assert.deepEqual(body.recovery.proposals, []);
  assert.equal(body.rail.sprints[0].status, 'on-track');
});

test('a project manager sees the team view: the sprint, who is behind, and team blockers', async () => {
  const { app, tokens } = await createHomeTestApp();
  const body = (await getHome(app, tokens['user-priya'])).body;
  assert.deepEqual(body.viewer.lenses, ['my-work', 'team']);
  assert.equal(body.viewer.lens, 'team');
  assert.equal(body.viewer.managedProjectCount, 1);

  assert.equal(body.status.scope, 'sprint');
  assert.equal(body.status.headline, 'Sprint 14 is behind');
  assert.deepEqual(body.status.people.map((entry) => [entry.name, entry.closed, entry.assigned, entry.threshold]), [['Sam Ortiz', 7, 30, 15], ['Lee Park', 0, 4, 2]]);
  assert.match(body.status.say, /Behind: Sam Ortiz \(7 of 30 pts\), Lee Park \(0 of 4 pts\)\./);
  assert.deepEqual(body.recovery.proposals.map((proposal) => proposal.summary), [
    'Move 2 stories (13 pts) to Sprint 15',
    'Reassign “Map NetSuite cost centers” to Dana Reyes',
    'Split “Saved kanban views” and finish the started part',
  ]);

  assert.deepEqual(body.focus.items.map((item) => [item.title, item.reasons.map((reason) => reason.label)]), [
    ['Unblock Sam on “Finish SSO discovery”', ['Blocks 2 people', 'Overdue 5d']],
    ['Respond to critical risk: Vendor capacity', ['Critical risk']],
  ]);
  assert.deepEqual(body.tabs.map((tab) => tab.key), ['focus', 'decide', 'team', 'assigned', 'all']);
  assert.deepEqual(body.rail.counts.map((entry) => [entry.key, entry.value, entry.note]), [
    ['active-sprints', 1, '1 at risk'],
    ['approvals', 0, 'none past SLA'],
    ['critical-risks', 1, 'of 1 open'],
    ['overallocated', 0, 'people this sprint'],
  ]);
  assert.deepEqual(body.rail.leaderboard.me, { id: 'user-priya', isCurrentUser: true, name: 'Priya Natarajan', picture: '/images/avatar_default.jpg', points: 6, rank: 4, tasks: 2 });

  // Her own view: nothing assigned to her in the sprint, so no behind panel.
  const own = (await getHome(app, tokens['user-priya'], '?lens=my-work')).body;
  assert.equal(own.viewer.lens, 'my-work');
  assert.equal(own.status.kind, 'none');
});

test('the last view chosen is remembered, and only views the person has can be saved', async () => {
  const { app, tokens } = await createHomeTestApp();
  const save = (token, lens) => request(app).put('/api/home/lens').set('Authorization', `Bearer ${token}`).send({ lens });
  assert.equal((await save(tokens['user-priya'], 'workspace')).status, 403);
  assert.equal((await save(tokens['user-priya'], 'nonsense')).status, 400);
  const saved = await save(tokens['user-priya'], 'my-work');
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { lens: 'my-work', ok: true });
  const body = (await getHome(app, tokens['user-priya'])).body;
  assert.equal(body.viewer.lens, 'my-work');
  assert.equal(body.viewer.defaultLens, 'my-work');
});

test('a member without edit rights sees what could be done but cannot stage it', async () => {
  const { app, tokens } = await createHomeTestApp();
  const body = (await getHome(app, tokens['user-lee'])).body;
  assert.equal(body.status.kind, 'behind');
  assert.equal(body.status.sprint.threshold, 2);
  assert.equal(body.recovery.proposals.length, 1);
  const [proposal] = body.recovery.proposals;
  assert.equal(proposal.permitted, false);
  assert.equal(proposal.blockedReason, 'Needs edit rights on Customer Portal Rebuild.');
  const refused = await stage(app, tokens['user-lee'], proposal.id);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.details.code, 'home_proposal_not_permitted');
});

test('staging recomputes the proposal, waits for approval in an assistant chat, and retires once applied', async () => {
  const { app, projectRepository, tokens } = await createHomeTestApp();
  const token = tokens['user-sam'];
  const { proposals } = (await getHome(app, token)).body.recovery;
  const move = proposals.find((proposal) => proposal.type === 'move-scope');

  assert.equal((await stage(app, token, 'not-a-proposal')).status, 400);
  const unknown = await stage(app, token, 'rp_0000000000000000');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.details.code, 'home_proposal_stale');
  // Another person's proposal id is not theirs to stage.
  const priyaMove = (await getHome(app, tokens['user-priya'])).body.recovery.proposals[0];
  assert.equal((await stage(app, tokens['user-dana'], priyaMove.id)).status, 404);

  const staged = await stage(app, token, move.id);
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.reused, false);
  const sessionId = staged.body.assistantSessionId;

  // Nothing has changed yet.
  let project = await projectRepository.getProjectDetail({ projectId: PORTAL, tenantId: TENANT });
  assert.equal(sprintOf(project, 'story-export'), 'sprint-14');

  const chat = (await request(app).get(`/api/assistant/chats/${sessionId}`).set('Authorization', `Bearer ${token}`)).body.chat;
  assert.equal(chat.projectId, PORTAL);
  const { proposal } = chat.messages.at(-1);
  assert.equal(proposal.source, 'home-recovery');
  assert.equal(proposal.items.length, 1);
  const [item] = proposal.items;
  assert.equal(item.kind, 'recovery');
  assert.equal(item.label, 'Move 3 stories to Sprint 15');
  assert.equal(item.payload.type, 'sprint_items_move');
  assert.deepEqual(item.payload.origin, { homeProposalId: move.id, kind: 'home-recovery', type: 'move-scope' });
  assert.match(chat.messages.at(-1).content, /Nothing has changed yet\./);

  // Staging again reopens the same chat while the change waits.
  const again = await stage(app, token, move.id);
  assert.deepEqual(again.body, { assistantSessionId: sessionId, ok: true, reused: true });

  const applied = await request(app).post(`/api/assistant/chats/${sessionId}/proposals`).set('Authorization', `Bearer ${token}`).send({ decision: 'apply', proposalId: proposal.id });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.chat.messages.at(-1).proposal.items[0].status, 'applied');
  project = await projectRepository.getProjectDetail({ projectId: PORTAL, tenantId: TENANT });
  assert.deepEqual(['story-export', 'story-netsuite', 'story-sso'].map((id) => sprintOf(project, id)), ['sprint-15', 'sprint-15', 'sprint-15']);

  // Sam now has 12 points with 7 closed: back over the line, and the old id is gone.
  const after = (await getHome(app, token)).body;
  assert.equal(after.status.kind, 'on-track');
  assert.equal((await stage(app, token, move.id)).status, 404);
});

test('a staged risk is created when applied, and Home stops offering it', async () => {
  const { app, governanceRepository, tokens } = await createHomeTestApp();
  const token = tokens['user-sam'];
  // Home shows three proposals; Raise a risk is the fifth, so its id is worked out the way
  // home-recovery.js does. Sam has 7 of 30 points closed at halfway: about 16 short.
  const title = 'Sprint 14 may not finish about 16 points';
  const riskId = `rp_${createHash('sha256').update(JSON.stringify(['raise-risk', PORTAL, 'sprint-14', 'user-sam', title])).digest('hex').slice(0, 16)}`;

  const staged = await stage(app, token, riskId);
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const sessionId = staged.body.assistantSessionId;
  const chat = (await request(app).get(`/api/assistant/chats/${sessionId}`).set('Authorization', `Bearer ${token}`)).body.chat;
  const { proposal } = chat.messages.at(-1);
  assert.equal(proposal.items[0].payload.type, 'governance_item_create');

  const applied = await request(app).post(`/api/assistant/chats/${sessionId}/proposals`).set('Authorization', `Bearer ${token}`).send({ decision: 'apply', proposalId: proposal.id });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.chat.messages.at(-1).proposal.items[0].status, 'applied');
  const risks = (await governanceRepository.listSnapshot({ projectId: PORTAL, tenantId: TENANT })).items.filter((item) => item.title === title);
  assert.deepEqual(risks.map((risk) => [risk.kind, risk.status, risk.ownerId]), [['risk', 'open', 'user-sam']]);

  // The risk is open now, so the proposal is gone.
  assert.equal((await stage(app, token, riskId)).status, 404);
});

test('a failing source is reported per project while the rest still rank', async () => {
  const governanceRepository = createInMemoryGovernanceRepository();
  const listSnapshot = governanceRepository.listSnapshot;
  governanceRepository.listSnapshot = async (args) => {
    if (args.projectId === PORTAL) throw new Error('governance store offline');
    return listSnapshot(args);
  };
  const { app, tokens } = await createHomeTestApp({
    governanceRepository,
    projectRepositoryOverrides: { listWorkItemRelations: async () => { throw new Error('relations offline'); } },
  });
  const response = await getHome(app, tokens['user-sam']);
  assert.equal(response.status, 200);
  const sources = Object.fromEntries(response.body.sources.map((source) => [source.key, source]));
  assert.deepEqual(sources.governance, { failedProjectIds: [PORTAL], key: 'governance', status: 'error' });
  assert.deepEqual(sources.relations, { failedProjectIds: [PORTAL], key: 'relations', status: 'error' });
  assert.equal(sources.sprints.status, 'ok');
  // Without relations the blocker reason is gone, and the work still ranks.
  assert.deepEqual(response.body.focus.items.map((item) => item.title), ['Checkout crash', 'Finish SSO discovery', 'Map NetSuite cost centers']);
  assert.equal(response.body.status.kind, 'behind');
});

test('a tenant admin sees the workspace view: identity, integrations and behind sprints', async () => {
  const { app, tokens } = await createHomeTestApp();
  const body = (await getHome(app, tokens['user-morgan'])).body;
  assert.deepEqual(body.viewer.lenses, ['my-work', 'workspace']);
  assert.equal(body.viewer.lens, 'workspace');
  assert.equal(body.status.kind, 'behind');
  assert.equal(body.status.headline, '1 sprint is behind across the workspace.');
  assert.deepEqual(body.recovery.proposals, []);
  assert.deepEqual(body.focus.items.map((item) => [item.title, item.reasons.map((reason) => reason.label)]), [
    ['Approve impersonation request: Avery Second → Lee Park', ['Expires in 4h', 'Needs a second admin']],
    ['Fix the dead webhook “Delivery receiver”', ['2 events not delivered']],
  ]);
  assert.deepEqual(body.tabs.map((tab) => [tab.key, tab.count]), [['focus', 2], ['approvals', 1], ['integrations', 1], ['identity', 1], ['all', 2]]);
  assert.deepEqual(body.rail.counts.map((entry) => [entry.key, entry.value, entry.note]), [
    ['dead-webhooks', 1, '2 failed deliveries'],
    ['sync-conflicts', 0, 'none open'],
    ['access-review', null, 'no review open'],
    ['without-2fa', 2, 'of 6 members'],
  ]);
  assert.deepEqual(body.rail.sprints.map((row) => [row.name, row.status, row.peopleBehind]), [['Sprint 14', 'behind', 2]]);
});

test('a soft-deleted project drops out of Home, and its leaderboard credit with it', async () => {
  const { app, projectRepository, tokens } = await createHomeTestApp();
  await projectRepository.softDeleteProject({ projectId: PORTAL, tenantId: TENANT, user: { id: 'user-priya' } });
  const body = (await getHome(app, tokens['user-sam'])).body;
  assert.equal(body.viewer.projectCount, 0);
  assert.deepEqual(body.focus.items, []);
  assert.equal(body.status.kind, 'none');
  assert.deepEqual(body.rail.sprints, []);
  assert.deepEqual(body.recovery.proposals, []);
  assert.deepEqual(body.rail.leaderboard.top, []);
});

test('the agent view leaves out the leaderboard and change trends, which count hidden tickets', async () => {
  const { app, tokens } = await createHomeTestApp();
  const person = (await getHome(app, tokens['user-sam'])).body;
  assert.ok(person.rail.leaderboard);
  assert.ok(person.rail.changeTrends);
  const agent = await getHome(app, tokens['user-sam'], '?agentView=1');
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal(agent.body.rail.leaderboard, null);
  assert.equal(agent.body.rail.changeTrends, null);
  assert.equal(agent.body.status.kind, person.status.kind);
});
