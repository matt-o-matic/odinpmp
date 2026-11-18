import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import request from 'supertest';

import { computeLinkStatus, hashAccessToken, INVOLVEMENT_GRACE_DAYS } from '../src/modules/requirements/requirements-access-links.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { createRequirementsTestApp, PROJECT_ID, ROLE_USERS, TENANT_ID } from './helpers/requirements-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('computeLinkStatus applies the link lifetime rule from data', () => {
  const issuedAt = '2026-10-01T00:00:00.000Z';
  const link = { extendedUntil: null, issuedAt, revokedAt: null };
  const at = (days) => new Date(Date.parse(issuedAt) + days * DAY_MS);

  assert.equal(INVOLVEMENT_GRACE_DAYS, 14);
  assert.equal(computeLinkStatus({ link, now: at(13) }).status, 'active');
  assert.equal(computeLinkStatus({ link, now: at(14) }).status, 'expired');

  const openTopic = { topics: [{ deactivatedAt: null, invitedAt: issuedAt, status: 'open', topicUpdatedAt: issuedAt }] };
  const active = computeLinkStatus({ involvement: openTopic, link, now: at(90) });
  assert.deepEqual({ expiresAt: active.expiresAt, involvementActive: active.involvementActive, status: active.status }, { expiresAt: null, involvementActive: true, status: 'active' });

  const resolvedAtDay20 = { topics: [{ deactivatedAt: null, invitedAt: issuedAt, status: 'resolved', topicUpdatedAt: at(20).toISOString() }] };
  assert.equal(computeLinkStatus({ involvement: resolvedAtDay20, link, now: at(33) }).status, 'active');
  assert.equal(computeLinkStatus({ involvement: resolvedAtDay20, link, now: at(34) }).status, 'expired');
  assert.equal(computeLinkStatus({ involvement: resolvedAtDay20, link, now: at(33) }).expiresAt, at(34).toISOString());

  const unassignedAtDay5 = { topics: [{ deactivatedAt: at(5).toISOString(), invitedAt: issuedAt, status: 'open', topicUpdatedAt: issuedAt }] };
  assert.equal(computeLinkStatus({ involvement: unassignedAtDay5, link, now: at(18) }).status, 'active');
  assert.equal(computeLinkStatus({ involvement: unassignedAtDay5, link, now: at(19) }).status, 'expired');

  const openRound = { rounds: [{ closedAt: null, invitedAt: issuedAt, removedAt: null, status: 'open' }] };
  assert.equal(computeLinkStatus({ involvement: openRound, link, now: at(60) }).status, 'active');
  const draftRound = { rounds: [{ closedAt: null, invitedAt: issuedAt, removedAt: null, status: 'draft' }] };
  assert.equal(computeLinkStatus({ involvement: draftRound, link, now: at(15) }).status, 'expired');
  const closedRound = { rounds: [{ closedAt: at(30).toISOString(), invitedAt: issuedAt, removedAt: null, status: 'closed' }] };
  assert.equal(computeLinkStatus({ involvement: closedRound, link, now: at(43) }).status, 'active');
  assert.equal(computeLinkStatus({ involvement: closedRound, link, now: at(45) }).status, 'expired');

  const extended = { ...link, extendedUntil: at(40).toISOString() };
  assert.equal(computeLinkStatus({ link: extended, now: at(39) }).status, 'active');
  assert.equal(computeLinkStatus({ link: extended, now: at(41) }).status, 'expired');

  assert.equal(computeLinkStatus({ involvement: openTopic, link: { ...link, revokedAt: at(1).toISOString() }, now: at(2) }).status, 'revoked');
  assert.equal(hashAccessToken('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('links are shown once, stored only as a hash, and listed without the token', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const linkEvents = harness.recordEvents(`project:${PROJECT_ID}`);

  const created = await harness.as('projectManager').post('/links', { stakeholderId: stakeholder.id });
  assert.equal(created.status, 201);
  assert.equal(created.headers['cache-control'], 'no-store');
  assert.match(created.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.url, `http://localhost:5173/app/requirements/${created.body.token}`);
  assert.equal(created.body.regenerated, false);
  assert.equal(created.body.link.status, 'active');
  assert.equal(created.body.link.stakeholder.name, 'Jamie Ortiz');
  assert.ok(linkEvents.events.some((event) => event.type === 'requirements.links.invalidated'));

  const { links: storedLinks, tokens: storedTokens } = harness.requirementsRepository.state;
  assert.equal(storedLinks.length, 1);
  assert.equal(storedTokens.length, 1);
  assert.equal('tokenHash' in storedLinks[0], false, 'the link row holds no token');
  assert.equal(storedTokens[0].tokenHash, createHash('sha256').update(created.body.token).digest('hex'));
  assert.equal(storedTokens[0].purpose, 'manual');
  assert.equal(JSON.stringify(harness.requirementsRepository.state).includes(created.body.token), false);

  const listed = await harness.as('tenantManager').get('/links');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.links.length, 1);
  assert.deepEqual(listed.body.links[0].tokens.map((token) => [token.id, token.purpose, token.revokedAt]), [[created.body.tokenId, 'manual', null]]);
  assert.equal(JSON.stringify(listed.body).includes(created.body.token), false);
  assert.equal(JSON.stringify(listed.body).includes(storedTokens[0].tokenHash), false);

  assert.equal((await harness.as('projectManager').post('/links', { stakeholderId: 'missing' })).status, 404);
});

test('a link expires 14 days after the last involvement ends and stays valid while involved', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const portal = harness.portal(token);

  // No involvement yet: issuing the link starts the 14-day window.
  harness.clock.offsetMs = 13 * DAY_MS;
  assert.equal((await portal.get()).status, 200);
  harness.clock.offsetMs = 15 * DAY_MS;
  const expired = await portal.get();
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error, 'link_expired');

  // An assigned open topic keeps the link alive however long it takes.
  harness.clock.offsetMs = 0;
  const topic = await harness.createTopic({ prompt: 'Which reminder channels do clients want?' });
  await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: stakeholder.id, actorType: 'stakeholder', role: 'primary' }] });
  harness.clock.offsetMs = 60 * DAY_MS;
  const involved = await portal.get();
  assert.equal(involved.status, 200);
  assert.equal(involved.body.link.involvementActive, true);
  assert.equal(involved.body.link.expiresAt, null);

  // Recording the decision ends the involvement; the grace period starts then.
  harness.clock.offsetMs = 0;
  await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'Email and text.', topicId: topic.id });
  harness.clock.offsetMs = 13 * DAY_MS;
  const grace = await portal.get();
  assert.equal(grace.status, 200);
  assert.equal(grace.body.link.involvementActive, false);
  assert.ok(Date.parse(grace.body.link.expiresAt) > Date.now() + 13 * DAY_MS);
  harness.clock.offsetMs = 15 * DAY_MS;
  assert.equal((await portal.get()).status, 410);

  // An invitation to an open round is an involvement too.
  harness.clock.offsetMs = 0;
  await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    reviewers: [{ actorId: stakeholder.id, actorType: 'stakeholder', required: true }],
    round: { number: 1, packageId: 'pkg-1', status: 'open', track: 'experience' },
    tenantId: TENANT_ID,
  });
  harness.clock.offsetMs = 45 * DAY_MS;
  assert.equal((await portal.get()).status, 200);
  harness.requirementsRepository.state.rounds[0].status = 'closed';
  harness.requirementsRepository.state.rounds[0].closedAt = new Date().toISOString();
  assert.equal((await portal.get()).status, 410);
});

test('removing the stakeholder from a topic ends that involvement', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const topic = await harness.createTopic({ prompt: 'Do technicians see client notes?' });
  await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: stakeholder.id, actorType: 'stakeholder' }] });
  harness.clock.offsetMs = 20 * DAY_MS;
  assert.equal((await harness.portal(token).get()).status, 200);

  harness.clock.offsetMs = 0;
  await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [] });
  harness.clock.offsetMs = 13 * DAY_MS;
  assert.equal((await harness.portal(token).get()).status, 200);
  harness.clock.offsetMs = 15 * DAY_MS;
  assert.equal((await harness.portal(token).get()).status, 410);
});

test('admins and managers extend, revoke, and regenerate links', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const first = await harness.createLink(stakeholder.id);
  const portal = harness.portal(first.token);

  harness.clock.offsetMs = 15 * DAY_MS;
  assert.equal((await portal.get()).status, 410);

  const tooSoon = await harness.as('projectManager').post(`/links/${first.link.id}/extend`, { until: new Date(Date.now() + 2 * DAY_MS).toISOString() });
  assert.equal(tooSoon.status, 400, 'an extension must be in the future relative to now');
  const tooFar = await harness.as('projectManager').post(`/links/${first.link.id}/extend`, { until: new Date(Date.now() + 400 * DAY_MS).toISOString() });
  assert.equal(tooFar.status, 400);

  const extended = await harness.as('projectManager').post(`/links/${first.link.id}/extend`, { until: new Date(Date.now() + 20 * DAY_MS).toISOString() });
  assert.equal(extended.status, 200);
  assert.equal(extended.body.link.status, 'active');
  assert.equal((await portal.get()).status, 200);
  harness.clock.offsetMs = 21 * DAY_MS;
  assert.equal((await portal.get()).status, 410);

  // Issuing another token keeps earlier tokens working: each email carries its own.
  harness.clock.offsetMs = 0;
  const second = await harness.createLink(stakeholder.id);
  assert.equal(second.regenerated, true);
  assert.equal(second.reactivated, false);
  assert.equal(second.link.id, first.link.id, 'one link per project and stakeholder');
  assert.notEqual(second.token, first.token);
  assert.equal((await portal.get()).status, 200);
  assert.equal((await harness.portal(second.token).get()).status, 200);
  assert.equal(second.link.tokens.length, 2);

  const revoked = await harness.as('projectAdmin').post(`/links/${first.link.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.link.status, 'revoked');
  assert.ok(revoked.body.link.tokens.every((token) => token.revokedAt), 'revoking the link revokes every token');
  for (const token of [first.token, second.token]) {
    const afterRevoke = await harness.portal(token).get();
    assert.equal(afterRevoke.status, 410);
    assert.equal(afterRevoke.body.error, 'link_revoked');
  }
  assert.equal((await harness.as('projectManager').post(`/links/${first.link.id}/extend`, { until: new Date(Date.now() + 5 * DAY_MS).toISOString() })).status, 409);

  // An admin or manager can turn the link back on with a new token; the old tokens stay off.
  const reactivated = await harness.createLink(stakeholder.id);
  assert.equal(reactivated.reactivated, true);
  assert.equal(reactivated.link.id, first.link.id);
  assert.equal(reactivated.link.status, 'active');
  assert.equal((await harness.portal(reactivated.token).get()).status, 200);
  assert.equal((await portal.get()).status, 410, 'tokens revoked with the link stay revoked');
  assert.equal((await harness.portal(second.token).get()).status, 410);
  assert.equal((await harness.portal('not-a-real-token').get()).status, 404);
});

test('every token of a link expires with the link', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const first = await harness.createLink(stakeholder.id);
  harness.clock.offsetMs = 10 * DAY_MS;
  const second = await harness.createLink(stakeholder.id);

  // The second token restarted the 14-day window, for every token of the link.
  harness.clock.offsetMs = 20 * DAY_MS;
  assert.equal((await harness.portal(first.token).get()).status, 200);
  assert.equal((await harness.portal(second.token).get()).status, 200);
  harness.clock.offsetMs = 25 * DAY_MS;
  for (const token of [first.token, second.token]) {
    const expired = await harness.portal(token).get();
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error, 'link_expired');
  }
});

test('portal: a stakeholder sees assigned topics and unassigned open topics, comments, and votes, but never changes status', async () => {
  const harness = await createRequirementsTestApp();
  const jamie = await harness.seedStakeholder();
  const ravi = await harness.seedStakeholder({ email: 'ravi@client.example', name: 'Ravi Shah', roleTitle: 'Finance' });
  const { token } = await harness.createLink(jamie.id);
  const portalEvents = harness.recordEvents(`public-requirements:${harness.requirementsRepository.state.links[0].id}`);

  const assigned = await harness.createTopic({ prompt: 'When does the price first appear?' });
  await harness.as('member').patch(`/topics/${assigned.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder', role: 'primary' }] });
  const unassigned = await harness.createTopic({ prompt: 'Do clients want reminders by email, text, or both?' }, { track: 'architecture' });
  const ravisTopic = await harness.createTopic({ prompt: 'Which refund policy applies?' });
  await harness.as('member').patch(`/topics/${ravisTopic.id}`, { assignments: [{ actorId: ravi.id, actorType: 'stakeholder' }] });
  const teamTopic = await harness.createTopic({ prompt: 'Which service owns pricing?' });
  await harness.as('member').patch(`/topics/${teamTopic.id}`, { assignments: [{ actorId: ROLE_USERS.member.id, actorType: 'user' }] });
  const dismissed = await harness.createTopic({ prompt: 'Dismissed question' });
  await harness.as('projectManager').patch(`/topics/${dismissed.id}`, { status: 'dismissed' });
  const decidedUnassigned = await harness.createTopic({ prompt: 'Decided question' });
  const firstDecision = (await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'Done.', topicId: decidedUnassigned.id })).body.decision;
  const decidedAssigned = await harness.createTopic({ prompt: 'Decided question for Jamie' });
  await harness.as('member').patch(`/topics/${decidedAssigned.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  const secondDecision = (await harness.as('tenantAdmin').post('/decisions', { outcome: 'agreed', statement: 'Agreed.', topicId: decidedAssigned.id })).body.decision;
  const closedWithoutDecision = await harness.createTopic({ prompt: 'Closed without a decision' });
  await harness.as('projectManager').patch(`/topics/${closedWithoutDecision.id}`, { status: 'resolved' });
  // A clarification the assistant saved is an Experience topic, so Jamie sees it as assigned.
  await harness.assistantRepository.syncProjectClarifications({
    clarifications: [{
      assignments: [{ actorId: jamie.id, actorType: 'stakeholder', label: 'Jamie Ortiz', role: 'primary' }],
      blockingArea: 'Assistant', id: 'assistant-clarification', linkedSection: 'brief', prompt: 'Assistant clarification', proposedDraftImpact: '', rationale: '',
    }],
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
  });
  await harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: { output: { aligned: [], divergent: [], insufficientInput: true, outstanding: [], proposedAnswer: '', proposedPreferences: [], underExplored: [] }, scopeId: unassigned.id, scopeType: 'topic', track: 'architecture' },
    tenantId: TENANT_ID,
  });

  const portal = harness.portal(token);
  const view = await portal.get();
  assert.equal(view.status, 200);
  assert.equal(view.headers['cache-control'], 'no-store');
  assert.deepEqual(view.body.stakeholder, { id: jamie.id, name: 'Jamie Ortiz', roleTitle: 'Operations lead' });
  assert.deepEqual(view.body.project, { id: PROJECT_ID, name: 'Client booking' });
  assert.equal(view.body.link.involvementActive, true);
  assert.deepEqual(view.body.topics.assigned.map((topic) => topic.id), [assigned.id, decidedAssigned.id, 'assistant-clarification']);
  assert.deepEqual(view.body.topics.open.map((topic) => topic.id), [unassigned.id]);
  assert.deepEqual(view.body.topics.decided.map((topic) => topic.id), [decidedUnassigned.id, closedWithoutDecision.id]);
  assert.equal(view.body.topics.assigned[0].isAssignedToMe, true);
  assert.equal(view.body.topics.assigned[0].assignmentRole, 'primary');
  assert.equal(view.body.topics.assigned[0].decision, null);
  assert.equal(view.body.topics.assigned[1].commentsOpen, true, 'decided topics stay open for comments');
  assert.deepEqual(view.body.topics.assigned[1].decision, {
    decidedAt: secondDecision.decidedAt,
    decidedBy: { name: ROLE_USERS.tenantAdmin.name },
    id: secondDecision.id,
    outcome: 'agreed',
    statement: 'Agreed.',
  });
  assert.equal(view.body.topics.decided[1].commentsOpen, false, 'closed without a decision stays closed');

  // "Recently decided": active decisions on topics this link can see, newest first.
  assert.deepEqual(view.body.decisions, [
    {
      decidedAt: secondDecision.decidedAt,
      decidedBy: { name: ROLE_USERS.tenantAdmin.name },
      id: secondDecision.id,
      outcome: 'agreed',
      statement: 'Agreed.',
      topicId: decidedAssigned.id,
      topicPrompt: 'Decided question for Jamie',
      track: 'experience',
    },
    {
      decidedAt: firstDecision.decidedAt,
      decidedBy: { name: ROLE_USERS.projectManager.name },
      id: firstDecision.id,
      outcome: 'decided',
      statement: 'Done.',
      topicId: decidedUnassigned.id,
      topicPrompt: 'Decided question',
      track: 'experience',
    },
  ]);
  assert.equal(view.body.topics.open[0].track, 'architecture');
  assert.equal(view.body.topics.open[0].summary.output.insufficientInput, true);
  for (const leaked of ['accessToken', 'invitationToken', 'replyToken', 'tokenHash', ravi.email, ROLE_USERS.member.id]) {
    assert.equal(JSON.stringify(view.body).includes(leaked), false, `${leaked} must not leak`);
  }

  // Comment on an unassigned open topic; the status stays open.
  const teamComment = await harness.as('member').post(`/topics/${unassigned.id}/comments`, { body: 'Email is cheapest.' });
  const posted = await portal.post(`/topics/${unassigned.id}/comments`, { body: 'Text, please.' });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.comment.isMine, true);
  assert.equal('actorId' in posted.body.comment, false);
  assert.equal(posted.body.topic.status, 'open');
  assert.ok(portalEvents.events.some((event) => event.type === 'requirements.topics.invalidated'));
  const reply = await portal.post(`/topics/${unassigned.id}/comments`, { body: 'Both would be best.', parentCommentId: teamComment.body.comment.id });
  assert.equal(reply.status, 201);

  const detail = await portal.get(`/topics/${unassigned.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.topic.comments.length, 2);
  assert.equal(detail.body.topic.comments.find((comment) => comment.body === 'Text, please.').isMine, true);
  assert.equal(detail.body.topic.comments.find((comment) => comment.body === 'Email is cheapest.').isMine, false);

  assert.equal((await portal.patch(`/topics/${unassigned.id}/comments/${posted.body.comment.id}`, { body: 'Text messages, please.' })).status, 200);
  assert.equal((await portal.patch(`/topics/${unassigned.id}/comments/${teamComment.body.comment.id}`, { body: 'Hijack' })).status, 404);
  assert.equal((await portal.del(`/topics/${unassigned.id}/comments/${teamComment.body.comment.id}`)).status, 404);
  const vote = await portal.post(`/topics/${unassigned.id}/comments/${teamComment.body.comment.id}/vote`, { vote: 'down' });
  assert.equal(vote.status, 200);
  assert.equal(vote.body.vote.downvotes, 1);
  const deleted = await portal.del(`/topics/${unassigned.id}/comments/${reply.body.comment.id}`);
  assert.equal(deleted.status, 200);

  // Topics the link cannot see.
  for (const hidden of [ravisTopic.id, teamTopic.id, dismissed.id]) {
    assert.equal((await portal.get(`/topics/${hidden}`)).status, 404, hidden);
    assert.equal((await portal.post(`/topics/${hidden}/comments`, { body: 'Can I see this?' })).status, 404, hidden);
  }

  // A stakeholder can disagree with a decision by commenting; the status stays resolved.
  for (const decided of [decidedAssigned, decidedUnassigned]) {
    const disagree = await portal.post(`/topics/${decided.id}/comments`, { body: 'I disagree with this decision.' });
    assert.equal(disagree.status, 201, decided.prompt);
    assert.equal(disagree.body.topic.status, 'resolved');
    assert.equal(disagree.body.topic.decision.id, decided.id === decidedAssigned.id ? secondDecision.id : firstDecision.id);
  }
  const teamReply = await harness.as('member').post(`/topics/${decidedUnassigned.id}/comments`, { body: 'Noted, we will revisit.' });
  assert.equal(teamReply.status, 201, 'the team can reply after a decision too');
  assert.equal(teamReply.body.topic.status, 'resolved');
  assert.equal((await portal.post(`/topics/${closedWithoutDecision.id}/comments`, { body: 'Late reply' })).status, 409);
  assert.equal((await harness.as('member').post(`/topics/${closedWithoutDecision.id}/comments`, { body: 'Late reply' })).status, 409);
  assert.equal((await harness.as('member').post(`/topics/${dismissed.id}/comments`, { body: 'Late reply' })).status, 409);

  // No status or decision path exists on the portal.
  for (const [method, path, body] of [
    ['patch', `/topics/${assigned.id}`, { status: 'resolved' }],
    ['post', `/topics/${assigned.id}/status`, { status: 'resolved' }],
    ['patch', `/topics/${unassigned.id}`, { status: 'dismissed' }],
    ['post', '/decisions', { outcome: 'decided', statement: 'Stakeholder decision', topicId: assigned.id }],
    ['post', '/preferences/accept', { dimension: 'type', stance: 'keep', statement: 'x', track: 'experience' }],
  ]) {
    assert.equal((await portal[method](path, body)).status, 404, `${method} ${path}`);
  }
  const unchanged = await harness.as('viewer').get(`/topics/${assigned.id}`);
  assert.equal(unchanged.body.topic.status, 'open');
  assert.equal(unchanged.body.topic.decisionId, null);
});

test('public requirements routes are rate limited per link and per IP', async () => {
  const harness = await createRequirementsTestApp({
    rateLimiter: createRequirementsPublicRateLimiter({
      ip: { capacity: 1_000, refillPerSecond: 0.001 },
      link: { capacity: 3, refillPerSecond: 0.001 },
      writeCost: 2,
    }),
  });
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await harness.portal(token).get()).status, 200);
  }
  const limited = await harness.portal(token).get();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.details.scope, 'link');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await harness.portal('another-token').get()).status, 404, 'another link has its own bucket');

  const byIp = createRequirementsPublicRateLimiter({ ip: { capacity: 2, refillPerSecond: 0.001 }, link: { capacity: 100, refillPerSecond: 1 } });
  assert.equal(byIp.check({ ipAddress: '10.0.0.1', linkKey: 'a' }).allowed, true);
  assert.equal(byIp.check({ ipAddress: '10.0.0.1', linkKey: 'b' }).allowed, true);
  const ipLimited = byIp.check({ ipAddress: '10.0.0.1', linkKey: 'c' });
  assert.deepEqual({ allowed: ipLimited.allowed, scope: ipLimited.scope }, { allowed: false, scope: 'ip' });
  assert.equal(byIp.check({ ipAddress: '10.0.0.2', linkKey: 'c' }).allowed, true);
});

test('the portal event stream connects, relays topic invalidations, and refuses expired links', async (t) => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const topic = await harness.createTopic({ prompt: 'Which reminder channels?' });
  const server = http.createServer(harness.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const received = [];
  const streamRequest = http.get({ host: '127.0.0.1', path: `/api/public/requirements/${token}/events`, port });
  const response = await new Promise((resolve) => streamRequest.on('response', resolve));
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  response.setEncoding('utf8');
  response.on('data', (chunk) => received.push(chunk));
  await new Promise((resolve) => setTimeout(resolve, 50));

  await harness.as('member').post(`/topics/${topic.id}/comments`, { body: 'Email first.' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  streamRequest.destroy();

  const text = received.join('');
  assert.match(text, /event: connected/);
  assert.match(text, /event: requirements\.topics\.invalidated/);
  assert.equal(text.includes('Email first.'), false, 'events carry ids, not content');

  harness.clock.offsetMs = 15 * DAY_MS;
  const expired = await harness.portal(token).get('/events');
  assert.equal(expired.status, 410);
});
