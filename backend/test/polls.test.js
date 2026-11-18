import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createPost, getPoll, votePollIn } from '../src/modules/channels/channels.service.js';
import { normalizeAnswer, normalizePollInput, pollIsClosed, pollSummaryLine, tallyPoll } from '../src/modules/channels/polls.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// Polls on posts (docs/engagements/plan.md, Polls): the rules and tallies in polls.js, then the
// routes for channels and direct messages on in-memory repositories, and a guest's rights
// through the service with a guest's context. polls-mysql.integration.test.js runs 0108.

const vote = (answer, voterName = '') => ({ answer, voterName });

test('a new poll is checked and tidied: kinds, options, scales, choices and closing time', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const poll = normalizePollInput({ kind: 'single', options: [' Monday ', 'Tuesday', ''], question: '  Which   day? ' }, { now });
  assert.deepEqual(poll, { closesAt: null, kind: 'single', options: [{ id: 'o1', label: 'Monday' }, { id: 'o2', label: 'Tuesday' }], question: 'Which day?', settings: { anonymous: false, maxChoices: null, scaleMax: null, showResults: 'always' } });
  const fails = (input, code) => assert.throws(() => normalizePollInput(input, { now }), (error) => error.details.code === code);
  fails({ kind: 'single', options: ['Only one'], question: 'Q' }, 'poll_options_required');
  fails({ kind: 'single', options: ['A', 'a'], question: 'Q' }, 'poll_option_duplicate');
  fails({ kind: 'single', options: ['A', 'B'], question: '   ' }, 'poll_question_required');
  fails({ kind: 'single', options: Array.from({ length: 21 }, (_, index) => `Option ${index}`), question: 'Q' }, 'poll_invalid');
  fails({ kind: 'poll', question: 'Q' }, 'poll_invalid');
  fails({ kind: 'multiple', options: ['A', 'B'], question: 'Q', settings: { maxChoices: 3 } }, 'poll_invalid');
  fails({ kind: 'rating', question: 'Q', settings: { scaleMax: 7 } }, 'poll_invalid');
  fails({ closesAt: '2026-11-15T11:00:00Z', kind: 'text', question: 'Q' }, 'poll_invalid');
  assert.deepEqual(normalizePollInput({ kind: 'text', options: ['ignored'], question: 'Name it' }, { now }).options, []);
  assert.equal(normalizePollInput({ kind: 'rating', question: 'How was it?' }, { now }).settings.scaleMax, 5);
  const closing = normalizePollInput({ closesAt: '2026-11-16T12:00:00Z', kind: 'text', question: 'Q' }, { now });
  assert.equal(closing.closesAt, '2026-11-16T12:00:00.000Z');
  assert.equal(pollIsClosed(closing, now), false);
  assert.equal(pollIsClosed(closing, new Date('2026-11-17T00:00:00Z')), true);
  assert.equal(pollIsClosed({ ...closing, closedAt: '2026-11-15T12:30:00Z' }, now), true);
});

test('answers are checked against their poll', () => {
  const single = normalizePollInput({ kind: 'single', options: ['A', 'B', 'C'], question: 'Q' });
  assert.deepEqual(normalizeAnswer(single, { optionIds: ['o2'] }), { optionIds: ['o2'] });
  assert.throws(() => normalizeAnswer(single, { optionIds: ['o1', 'o2'] }), /Pick one/);
  assert.throws(() => normalizeAnswer(single, { optionIds: ['o9'] }), /Pick one/);
  const multiple = normalizePollInput({ kind: 'multiple', options: ['A', 'B', 'C'], question: 'Q', settings: { maxChoices: 2 } });
  assert.deepEqual(normalizeAnswer(multiple, { optionIds: ['o3', 'o1', 'o3'] }), { optionIds: ['o1', 'o3'] });
  assert.throws(() => normalizeAnswer(multiple, { optionIds: ['o1', 'o2', 'o3'] }), /up to 2/);
  assert.throws(() => normalizeAnswer(multiple, { optionIds: [] }), /at least one/);
  const ranking = normalizePollInput({ kind: 'ranking', options: ['A', 'B', 'C'], question: 'Q' });
  assert.deepEqual(normalizeAnswer(ranking, { order: ['o3', 'o1', 'o2'] }), { order: ['o3', 'o1', 'o2'] });
  assert.throws(() => normalizeAnswer(ranking, { order: ['o3', 'o1'] }), /every option/);
  assert.throws(() => normalizeAnswer(ranking, { order: ['o3', 'o3', 'o1'] }), /every option/);
  const text = normalizePollInput({ kind: 'text', question: 'Q' });
  assert.deepEqual(normalizeAnswer(text, { text: '  Blue   sky ' }), { text: 'Blue sky' });
  assert.throws(() => normalizeAnswer(text, { text: '   ' }), /Write an answer/);
  assert.throws(() => normalizeAnswer(text, { text: 'x'.repeat(501) }), /500/);
  const rating = normalizePollInput({ kind: 'rating', question: 'Q', settings: { scaleMax: 10 } });
  assert.deepEqual(normalizeAnswer(rating, { value: 10 }), { value: 10 });
  assert.throws(() => normalizeAnswer(rating, { value: 11 }), /1 to 10/);
  assert.throws(() => normalizeAnswer(rating, { value: 2.5 }), /whole number/);
});

test('choice polls count per option, with names only when asked', () => {
  const poll = normalizePollInput({ kind: 'multiple', options: ['A', 'B', 'C'], question: 'Q' });
  const votes = [vote({ optionIds: ['o1', 'o2'] }, 'Ann'), vote({ optionIds: ['o2'] }, 'Bo'), vote({ optionIds: ['o2', 'o3'] }, 'Cy'), vote({ optionIds: ['o1'] }, 'Di')];
  const anonymous = tallyPoll(poll, votes);
  assert.equal(anonymous.voterCount, 4);
  assert.deepEqual(anonymous.options.map(({ count, label, share }) => [label, count, share]), [['A', 2, 0.5], ['B', 3, 0.75], ['C', 1, 0.25]]);
  assert.ok(!JSON.stringify(anonymous).includes('Ann'));
  assert.deepEqual(tallyPoll(poll, votes, { named: true }).options[1].voters, ['Ann', 'Bo', 'Cy']);
});

test('ranking polls use the Borda count and give each option its average rank', () => {
  const poll = normalizePollInput({ kind: 'ranking', options: ['Mon', 'Tue', 'Wed'], question: 'Q' });
  // 3 options: first place 2 points, second 1, last 0.
  const votes = [vote({ order: ['o2', 'o1', 'o3'] }), vote({ order: ['o2', 'o3', 'o1'] }), vote({ order: ['o1', 'o2', 'o3'] })];
  const results = tallyPoll(poll, votes);
  assert.equal(results.maxPoints, 6);
  assert.deepEqual(results.options.map(({ averageRank, label, place, points }) => [place, label, points, averageRank]), [[1, 'Tue', 5, 1.33], [2, 'Mon', 3, 2], [3, 'Wed', 1, 2.67]]);
  assert.equal(results.ballots, undefined);
  assert.deepEqual(tallyPoll(poll, [vote({ order: ['o3', 'o2', 'o1'] }, 'Ann')], { named: true }).ballots, [{ order: ['o3', 'o2', 'o1'], voter: 'Ann' }]);
});

test('fill-in-the-blank answers group by text, ignoring case and spacing, most common first', () => {
  const poll = normalizePollInput({ kind: 'text', question: 'Project code name?' });
  const votes = [vote({ text: 'Falcon' }, 'Ann'), vote({ text: 'falcon' }, 'Bo'), vote({ text: 'Heron' }, 'Cy'), vote({ text: 'FALCON' }, 'Di')];
  const results = tallyPoll(poll, votes);
  assert.deepEqual(results.answers.map(({ count, text }) => [text, count]), [['Falcon', 3], ['Heron', 1]]);
  assert.equal(results.answers[0].voters, undefined);
  assert.deepEqual(tallyPoll(poll, votes, { named: true }).answers[0].voters, ['Ann', 'Bo', 'Di']);
});

test('rating polls give the average and how many gave each value', () => {
  const poll = normalizePollInput({ kind: 'rating', question: 'How did it go?' });
  const results = tallyPoll(poll, [vote({ value: 5 }), vote({ value: 4 }), vote({ value: 4 }), vote({ value: 2 })]);
  assert.equal(results.average, 3.75);
  assert.deepEqual(results.distribution.map(({ count, value }) => [value, count]), [[1, 0], [2, 1], [3, 0], [4, 2], [5, 1]]);
  assert.equal(tallyPoll(poll, []).average, null);
  assert.match(pollSummaryLine(poll, [vote({ value: 5 })]), /Average 5 of 5/);
  assert.match(pollSummaryLine(poll, []), /No votes yet/);
});

// --- routes ------------------------------------------------------------------------------------

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const P = `/api/projects/${PROJECT}`;
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', projectRole: 'admin', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', projectRole: 'user', role: 'user' },
  other: { id: 'user-other', name: 'Olu Other', projectRole: 'user', role: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', role: 'user' },
};

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-polls-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const mailRepository = createInMemoryMailRepository();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog: createInMemoryProjectChangeLog(),
    fileStorage: storage,
    mailRepository,
    seed: {
      projectMemberships: { [PROJECT]: Object.values(USERS).map((user) => ({ email: `${user.id}@acme.example`, id: user.id, name: user.name, role: user.projectRole })) },
      projects: [{ epics: [], id: PROJECT, name: 'Northwind rollout', status: 'In Progress', tenantId: TENANT_ID }],
    },
  });
  const liveEventBus = createLiveEventBus();
  const events = [];
  liveEventBus.subscribe(`project:${PROJECT}`, (event) => events.push(event));
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'polls-fixture', secret: 'disposable-polls-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, liveEventBus, mailRepository, projectRepository, sessionsRepository, tokenService, workspaceModulesRepository: createInMemoryWorkspaceModulesRepository(),
  });
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const tokens = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: {}, role: user.role, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[key] = token;
  }
  async function send(as, method, route, body) {
    const response = await fetch(`${origin}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await send(as, method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const general = async (as = 'member') => (await ok(as, 'GET', `${P}/channels`)).channels.find((channel) => channel.isGeneral);
  return { events, general, ok, projectRepository, send };
}

test('a channel poll is a post: members vote, change their vote, see results, and the author closes it', async (t) => {
  const f = await fixture(t);
  const channel = await f.general();
  const created = await f.ok('member', 'POST', `${P}/channels/${channel.id}/posts`, { body: '', poll: { kind: 'single', options: ['Monday', 'Tuesday'], question: 'Kick-off day?' } }, 201);
  const { post } = created;
  assert.equal(post.body, 'Kick-off day?');
  assert.equal(post.poll.kind, 'single');
  assert.equal(post.poll.voterCount, 0);
  assert.equal(post.poll.canClose, true);
  assert.deepEqual(post.poll.results.options.map((option) => option.count), [0, 0]);

  const voted = await f.ok('other', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o2'] } });
  assert.deepEqual(voted.poll.myAnswer, { optionIds: ['o2'] });
  assert.equal(voted.poll.canClose, false);
  assert.ok(f.events.some((event) => event.type === 'channel.updated' && event.channelId === channel.id));
  // Voting again replaces the vote.
  const changed = await f.ok('other', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o1'] } });
  assert.equal(changed.poll.voterCount, 1);
  assert.deepEqual(changed.poll.results.options.map((option) => [option.label, option.count, option.voters]), [['Monday', 1, ['Olu Other']], ['Tuesday', 0, []]]);
  await f.ok('lead', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o1'] } });

  // The conversation lists the poll on its post, as each viewer sees it.
  const page = await f.ok('lead', 'GET', `${P}/channels/${channel.id}/posts`);
  assert.deepEqual(page.posts[0].poll.myAnswer, { optionIds: ['o1'] });
  assert.equal(page.posts[0].poll.voterCount, 2);

  // Bad answers and viewers are refused.
  assert.equal((await f.send('other', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o1', 'o2'] } })).body.details.code, 'poll_answer_invalid');
  assert.equal((await f.send('viewer', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o1'] } })).body.details.code, 'poll_read_only');
  assert.equal((await f.ok('viewer', 'GET', `${P}/posts/${post.id}/poll`)).poll.canVote, false);
  // Only the author or decision rights close it; then nobody votes.
  assert.equal((await f.send('other', 'POST', `${P}/posts/${post.id}/poll/close`)).body.details.code, 'poll_close_forbidden');
  const closed = await f.ok('member', 'POST', `${P}/posts/${post.id}/poll/close`);
  assert.equal(closed.poll.closed, true);
  assert.equal(closed.poll.canVote, false);
  assert.equal((await f.send('other', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o2'] } })).body.details.code, 'poll_closed');
  // A post without a poll has none.
  const plain = (await f.ok('member', 'POST', `${P}/channels/${channel.id}/posts`, { body: 'No poll here' }, 201)).post;
  assert.equal(plain.poll, undefined);
  assert.equal((await f.send('member', 'GET', `${P}/posts/${plain.id}/poll`)).body.details.code, 'poll_not_found');
});

test('anonymous polls never return who voted, and "after you vote" hides results until then', async (t) => {
  const f = await fixture(t);
  const channel = await f.general();
  const { post } = await f.ok('member', 'POST', `${P}/channels/${channel.id}/posts`, {
    body: 'Be honest.',
    poll: { kind: 'text', question: 'One word for the launch?', settings: { anonymous: true, showResults: 'after_vote' } },
  }, 201);
  assert.equal(post.body, 'Be honest.');
  // The author always sees results.
  assert.ok(post.poll.results);
  const before = await f.ok('other', 'GET', `${P}/posts/${post.id}/poll`);
  assert.equal(before.poll.results, null);
  assert.equal(before.poll.resultsHidden, true);
  await f.ok('lead', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { text: 'Smooth' } });
  const mine = await f.ok('other', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { text: 'smooth ' } });
  assert.deepEqual(mine.poll.results.answers.map(({ count, text }) => [text, count]), [['Smooth', 2]]);
  const everything = JSON.stringify([mine, await f.ok('lead', 'GET', `${P}/channels/${channel.id}/posts`)]);
  for (const user of Object.values(USERS)) {
    if (user.id === USERS.member.id) continue;
    assert.ok(!everything.includes(user.name) && !everything.includes(user.id), `${user.name} is not named`);
  }
});

test('each kind can be posted, a reply cannot be a poll, and a closing time ends voting', async (t) => {
  const f = await fixture(t);
  const channel = await f.general();
  const make = (poll) => f.send('member', 'POST', `${P}/channels/${channel.id}/posts`, { poll });
  for (const poll of [
    { kind: 'multiple', options: ['A', 'B', 'C'], question: 'Pick two', settings: { maxChoices: 2 } },
    { kind: 'ranking', options: ['A', 'B', 'C'], question: 'Order them' },
    { kind: 'rating', question: 'Rate it', settings: { scaleMax: 10 } },
  ]) assert.equal((await make(poll)).status, 201);
  const root = (await f.ok('member', 'POST', `${P}/channels/${channel.id}/posts`, { body: 'Thread' }, 201)).post;
  const reply = await f.send('member', 'POST', `${P}/channels/${channel.id}/posts`, { parentId: root.id, poll: { kind: 'rating', question: 'Rate' } });
  assert.equal(reply.body.details.code, 'poll_in_reply');
  assert.equal((await make({ kind: 'single', options: ['Only'], question: 'Q' })).body.details.code, 'poll_options_required');

  const soon = (await make({ closesAt: new Date(Date.now() + 60_000).toISOString(), kind: 'rating', question: 'Quick one' })).body.post;
  await f.ok('other', 'PUT', `${P}/posts/${soon.id}/poll/vote`, { answer: { value: 4 } });
  // The clock passes the closing time.
  const [stored] = await f.projectRepository.listPolls({ postIds: [soon.id], tenantId: TENANT_ID });
  await f.projectRepository.createPoll({ poll: { ...stored, closesAt: new Date(Date.now() - 1000).toISOString() } });
  const after = await f.ok('other', 'GET', `${P}/posts/${soon.id}/poll`);
  assert.equal(after.poll.closed, true);
  assert.equal(after.poll.results.average, 4);
  assert.equal((await f.send('other', 'PUT', `${P}/posts/${soon.id}/poll/vote`, { answer: { value: 5 } })).body.details.code, 'poll_closed');
});

test('direct messages take polls: everyone in the conversation votes; nobody else sees it', async (t) => {
  const f = await fixture(t);
  const { conversation } = await f.ok('member', 'POST', '/api/chat/conversations', { memberIds: [USERS.other.id] }, 201);
  const C = `/api/chat/conversations/${conversation.id}`;
  const { post } = await f.ok('member', 'POST', `${C}/posts`, { poll: { kind: 'ranking', options: ['Pizza', 'Tacos', 'Sushi'], question: 'Lunch?' } }, 201);
  assert.equal(post.poll.kind, 'ranking');
  const voted = await f.ok('other', 'PUT', `${C}/posts/${post.id}/poll/vote`, { answer: { order: ['o3', 'o1', 'o2'] } });
  assert.equal(voted.poll.results.options[0].label, 'Sushi');
  assert.equal((await f.ok('member', 'GET', `${C}/posts`)).posts[0].poll.voterCount, 1);
  assert.equal((await f.send('lead', 'PUT', `${C}/posts/${post.id}/poll/vote`, { answer: { order: ['o1', 'o2', 'o3'] } })).status, 404);
  assert.equal((await f.send('other', 'POST', `${C}/posts/${post.id}/poll/close`)).body.details.code, 'poll_close_forbidden');
  assert.equal((await f.ok('member', 'POST', `${C}/posts/${post.id}/poll/close`)).poll.closed, true);
});

test('a guest votes in a poll in their channel and never sees names in an anonymous one', async (t) => {
  const f = await fixture(t);
  const channel = await f.general();
  const { post } = await f.ok('member', 'POST', `${P}/channels/${channel.id}/posts`, { poll: { kind: 'single', options: ['Yes', 'No'], question: 'Ship it?', settings: { anonymous: true } } }, 201);
  await f.ok('lead', 'PUT', `${P}/posts/${post.id}/poll/vote`, { answer: { optionIds: ['o1'] } });
  // A guest's context, as guests.routes.js builds it: their channels only, no decision rights.
  const guest = { canCollaborate: true, canDecide: false, channelIds: new Set([channel.id]), fileActor: { id: 'stk-1', name: 'Gina Guest' }, guest: true, principal: { id: 'stk-1', name: 'Gina Guest', type: 'stakeholder' }, projectId: PROJECT, tenantId: TENANT_ID, user: null };
  const deps = { projectRepository: f.projectRepository };
  const voted = await votePollIn(deps, guest, post.id, { answer: { optionIds: ['o2'] } });
  assert.deepEqual(voted.poll.results.options.map((option) => option.count), [1, 1]);
  assert.ok(!JSON.stringify(voted).includes('Lena'));
  assert.equal(voted.poll.canClose, false);
  // Outside their channels the poll is missing.
  const elsewhere = { ...guest, channelIds: new Set(['another-channel']) };
  await assert.rejects(getPoll(deps, elsewhere, post.id), (error) => error.statusCode === 404);
  // A guest can make one too.
  const made = await createPost({ ...deps, notifications: null }, guest, channel.id, { body: '', fileIds: [], poll: { kind: 'rating', question: 'How are we doing?' } });
  assert.equal(made.post.poll.canClose, true);
});
