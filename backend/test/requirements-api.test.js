import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import {
  createRequirementsTestApp,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  ROLE_USERS,
  TENANT_ID,
} from './helpers/requirements-test-app.js';

const MEMBER_ROLES = ['member', 'user', 'contributor', 'editor'];
const DECIDER_ROLES = ['projectManager', 'projectAdmin', 'tenantManager', 'tenantAdmin'];
const NO_WRITE_ROLES = ['viewer', 'outsider'];

function stubAi(questions = []) {
  return {
    calls: [],
    provider: 'stub',
    async draftQuestions(input) {
      this.calls.push(input);
      return { questions };
    },
  };
}

async function readySummary(harness, topicId, { proposedAnswer = 'Show the estimate before the time is picked.', track = 'experience' } = {}) {
  return harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: {
      output: {
        aligned: [{ sources: ['comment:1'], statement: 'People want an estimate.', supporters: ['user:a', 'user:b'] }],
        divergent: [],
        insufficientInput: false,
        outstanding: [{ blocking: true, item: 'Refund wording', suggestedOwnerRole: 'Finance' }],
        proposedAnswer,
        proposedPreferences: [],
        underExplored: [],
      },
      scopeId: topicId,
      scopeType: 'topic',
      track,
    },
    tenantId: TENANT_ID,
  });
}

test('every requirements read route returns 200 to viewers and members and 404 to outsiders', async () => {
  const harness = await createRequirementsTestApp();
  const topic = await harness.createTopic({ prompt: 'Should clients see a price estimate?' });
  const routes = ['/', '/my-items', '/tracks/experience/topics', '/tracks/architecture/topics', '/tracks/experience/decisions', '/tracks/experience/preferences', `/topics/${topic.id}`];

  for (const route of routes) {
    for (const role of ['viewer', ...MEMBER_ROLES, ...DECIDER_ROLES]) {
      const response = await harness.as(role).get(route);
      assert.equal(response.status, 200, `${role} GET ${route}: ${JSON.stringify(response.body)}`);
    }
    const outsider = await harness.as('outsider').get(route);
    assert.equal(outsider.status, 404, `outsider GET ${route}`);
  }

  const unknownTrack = await harness.as('member').get('/tracks/backend/topics');
  assert.equal(unknownTrack.status, 404);
});

test('the overview and my open items tell the workspace what the caller may do, so viewers get read-only controls', async () => {
  // The project detail API has no caller role; without these flags the workspace treated a
  // viewer as a member and showed Assign, Edit, Delete and the comment box (U8 finding).
  const harness = await createRequirementsTestApp();
  const expected = {
    member: { canCollaborate: true, canDecide: false, canEditPlans: false, projectRole: 'member' },
    projectManager: { canCollaborate: true, canDecide: true, canEditPlans: true, projectRole: 'manager' },
    tenantAdmin: { canCollaborate: true, canDecide: true, canEditPlans: true, projectRole: null },
    user: { canCollaborate: true, canDecide: false, canEditPlans: false, projectRole: 'user' },
    viewer: { canCollaborate: false, canDecide: false, canEditPlans: false, projectRole: 'viewer' },
  };
  for (const [role, flags] of Object.entries(expected)) {
    for (const route of ['/', '/my-items']) {
      const response = await harness.as(role).get(route);
      assert.equal(response.status, 200, `${role} GET ${route}`);
      const { canCollaborate, canDecide, canEditPlans, projectRole } = response.body;
      assert.deepEqual({ canCollaborate, canDecide, canEditPlans, projectRole }, flags, `${role} GET ${route}`);
    }
  }
});

test('the overview lists project members for the assign and reviewer pickers to members, not viewers', async () => {
  // valid-users needs project.plan.edit, so a member's Assign dialog and reviewer picker
  // were empty of teammates (U8 finding).
  const harness = await createRequirementsTestApp();
  const response = await harness.as('member').get('/');
  assert.equal(response.status, 200);
  const members = response.body.members;
  assert.ok(Array.isArray(members) && members.length > 0);
  const byId = new Map(members.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get(ROLE_USERS.projectManager.id), { email: byId.get(ROLE_USERS.projectManager.id).email, id: ROLE_USERS.projectManager.id, name: 'Pia Manager', role: 'manager' });
  assert.equal(byId.get(ROLE_USERS.viewer.id)?.role, 'viewer');
  assert.equal(byId.has(ROLE_USERS.outsider.id), false, 'people outside the project are not listed');
  for (const entry of members) assert.deepEqual(Object.keys(entry).sort(), ['email', 'id', 'name', 'role']);
  // Viewers can't assign or invite, so they don't get the list or its email addresses.
  const asViewer = await harness.as('viewer').get('/');
  assert.equal(asViewer.status, 200);
  assert.deepEqual(asViewer.body.members, []);
});

test('AC-15 viewers get 404 on every write route, before body validation', async () => {
  const harness = await createRequirementsTestApp({ requirementsAiService: stubAi() });
  await harness.seedBrief();
  const stakeholder = await harness.seedStakeholder();
  const topic = await harness.createTopic({ prompt: 'Which reminder channels do clients want?' });
  const comment = (await harness.as('member').post(`/topics/${topic.id}/comments`, { body: 'Email first.' })).body.comment;
  const decision = (await harness.as('projectManager').post('/decisions', {
    outcome: 'decided', sources: [], statement: 'Email reminders only.', topicId: topic.id,
  })).body.decision;
  const link = await harness.createLink(stakeholder.id);

  const writes = [
    ['post', '/tracks/experience/topics', { prompt: 'Viewer topic' }],
    ['post', '/tracks/experience/topics', {}],
    ['post', '/tracks/experience/draft-questions', {}],
    ['patch', `/topics/${topic.id}`, { prompt: 'Edited by viewer' }],
    ['patch', `/topics/${topic.id}`, { status: 'resolved' }],
    ['del', `/topics/${topic.id}`],
    ['post', `/topics/${topic.id}/comments`, { body: 'Viewer comment' }],
    ['patch', `/topics/${topic.id}/comments/${comment.id}`, { body: 'Edit' }],
    ['del', `/topics/${topic.id}/comments/${comment.id}`],
    ['post', `/topics/${topic.id}/comments/${comment.id}/vote`, { vote: 'up' }],
    ['post', '/decisions', {}],
    ['post', '/decisions', { outcome: 'decided', statement: 'Viewer decision', topicId: topic.id }],
    ['patch', `/decisions/${decision.id}`, { statement: 'Changed', version: decision.version }],
    ['post', '/preferences/accept', { dimension: 'type', stance: 'keep', statement: 'Keep it.', track: 'experience' }],
    ['get', '/links'],
    ['post', '/links', { stakeholderId: stakeholder.id }],
    ['post', `/links/${link.link.id}/revoke`, {}],
    ['post', `/links/${link.link.id}/extend`, { until: new Date(Date.now() + 86_400_000).toISOString() }],
  ];

  for (const role of NO_WRITE_ROLES) {
    for (const [method, path, body] of writes) {
      const response = method === 'get' || method === 'del'
        ? await harness.as(role)[method](path)
        : await harness.as(role)[method](path, body);
      assert.equal(response.status, 404, `${role} ${method.toUpperCase()} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    }
  }

  const unchanged = await harness.as('member').get(`/topics/${topic.id}`);
  assert.equal(unchanged.body.topic.prompt, 'Which reminder channels do clients want?');
});

test('AC-11 and AC-15 members collaborate but cannot decide; admins and managers can', async () => {
  const harness = await createRequirementsTestApp({ requirementsAiService: stubAi() });
  await harness.seedBrief();
  const stakeholder = await harness.seedStakeholder();

  for (const role of MEMBER_ROLES) {
    const created = await harness.as(role).post('/tracks/architecture/topics', { prompt: `Which service owns pricing for ${role}?` });
    assert.equal(created.status, 201, role);
    const topicId = created.body.topic.id;
    assert.equal((await harness.as(role).patch(`/topics/${topicId}`, { prompt: `Which service owns price estimates for ${role}?` })).status, 200, role);
    const commented = await harness.as(role).post(`/topics/${topicId}/comments`, { body: 'The quoting service.' });
    assert.equal(commented.status, 201, role);
    assert.equal((await harness.as(role).post(`/topics/${topicId}/comments/${commented.body.comment.id}/vote`, { vote: 'up' })).status, 200, role);
    assert.equal((await harness.as(role).post('/tracks/architecture/draft-questions')).status, 201, role);

    // Decision rights only: every one of these is a 404 for members.
    assert.equal((await harness.as(role).patch(`/topics/${topicId}`, { status: 'resolved' })).status, 404, role);
    assert.equal((await harness.as(role).patch(`/topics/${topicId}`, { status: 'dismissed' })).status, 404, role);
    assert.equal((await harness.as(role).post('/decisions', { outcome: 'decided', statement: 'Quoting service.', topicId })).status, 404, role);
    assert.equal((await harness.as(role).post('/preferences/accept', { dimension: 'type', stance: 'keep', statement: 'Keep it.', track: 'experience' })).status, 404, role);
    assert.equal((await harness.as(role).get('/links')).status, 404, role);
    assert.equal((await harness.as(role).post('/links', { stakeholderId: stakeholder.id })).status, 404, role);

    const after = await harness.as(role).get(`/topics/${topicId}`);
    assert.equal(after.body.topic.status, 'open', `${role} left status unchanged`);
    assert.equal(after.body.topic.decisionId, null);
  }

  for (const role of DECIDER_ROLES) {
    const topic = await harness.createTopic({ prompt: `Who signs off on accessibility for ${role}?` });
    const decided = await harness.as(role).post('/decisions', {
      outcome: 'decided',
      sources: ['comment:abc'],
      statement: 'WCAG 2.2 AA, signed off by the operations lead.',
      topicId: topic.id,
    });
    assert.equal(decided.status, 201, `${role}: ${JSON.stringify(decided.body)}`);
    assert.equal(decided.body.decision.decidedBy.id, ROLE_USERS[role].id);
    assert.equal(decided.body.decision.decidedBy.name, ROLE_USERS[role].name);
    assert.deepEqual(decided.body.decision.sources, ['comment:abc']);
    assert.equal(decided.body.decision.outcome, 'decided');
    assert.equal(decided.body.topic.state, 'decided');

    const updated = await harness.as(role).patch(`/decisions/${decided.body.decision.id}`, { statement: 'WCAG 2.2 AA.', version: 1 });
    assert.equal(updated.status, 200, role);
    assert.equal((await harness.as(role).post('/preferences/accept', { dimension: 'type', stance: 'keep', statement: `Keep 14px body text (${role}).`, track: 'experience' })).status, 201, role);
    assert.equal((await harness.as(role).get('/links')).status, 200, role);
    const linkResponse = await harness.as(role).post('/links', { stakeholderId: stakeholder.id });
    assert.equal(linkResponse.status, 201, role);
    assert.equal((await harness.as(role).post(`/links/${linkResponse.body.link.id}/extend`, { until: new Date(Date.now() + 5 * 86_400_000).toISOString() })).status, 200, role);
    assert.equal((await harness.as(role).post(`/links/${linkResponse.body.link.id}/revoke`)).status, 200, role);
    assert.equal((await harness.as(role).patch(`/topics/${topic.id}`, { status: 'open' })).status, 200, role);
  }
});

test('topics are created by hand with a track, a creator, and no AI label; the register filters and searches', async () => {
  const harness = await createRequirementsTestApp();
  const topicEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.project(PROJECT_ID));

  const created = await harness.as('member').post('/tracks/experience/topics', {
    prompt: 'Should clients see an estimated price before they pick a time?',
    rationale: 'Pricing transparency drives booking.',
    settles: 'Price display',
    sourceRef: 'brief:requirements:0',
    suggestedOwnerRole: 'Finance',
  });
  assert.equal(created.status, 201);
  const topic = created.body.topic;
  assert.equal(topic.track, 'experience');
  assert.equal(topic.origin, 'manual');
  assert.equal(topic.sourceRef, 'brief:requirements:0');
  assert.equal(topic.settles, 'Price display');
  assert.equal(topic.suggestedOwnerRole, 'Finance');
  assert.deepEqual(topic.createdBy, { id: ROLE_USERS.member.id, name: ROLE_USERS.member.name, ref: `user:${ROLE_USERS.member.id}`, type: 'user' });
  assert.equal(topic.state, 'open');
  assert.equal(topic.owner, null);
  assert.deepEqual(topic.signals, { aligned: 0, blocking: 0, divergent: 0, outstanding: 0, underExplored: 0 });
  assert.deepEqual(topic.evidence, { comments: 0, contributors: 0, roundAnswers: 0, votes: 0 });
  assert.equal(Object.keys(topic).some((key) => /ai/i.test(key) && key !== 'rationale'), false, 'no AI label fields');
  assert.ok(topicEvents.events.some((event) => event.type === 'requirements.topics.invalidated' && event.topicIds.includes(topic.id)));

  await harness.createTopic({ prompt: 'How do clients cancel a booking?' });
  await harness.createTopic({ prompt: 'Which payment provider do we integrate?' }, { track: 'architecture' });

  const experience = await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(experience.body.topics.length, 2);
  assert.ok(experience.body.topics.every((row) => row.track === 'experience'));
  const search = await harness.as('viewer').get('/tracks/experience/topics?q=cancel');
  assert.deepEqual(search.body.topics.map((row) => row.prompt), ['How do clients cancel a booking?']);

  // Clarifications the AI Workspace saves are Experience topics too.
  await harness.assistantRepository.syncProjectClarifications({
    clarifications: [{ blockingArea: 'Assistant', id: 'assistant-clarification', linkedSection: 'brief', prompt: 'Assistant clarification', proposedDraftImpact: '', rationale: '' }],
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
  });
  const afterAssistant = await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(afterAssistant.body.topics.find((row) => row.id === 'assistant-clarification')?.origin, 'assistant');
  assert.equal((await harness.as('viewer').get('/topics/assistant-clarification')).status, 200);

  // A topic is only reachable through its own project, even for a member of both.
  const otherProject = await request(harness.app)
    .get(`/api/projects/${OTHER_PROJECT_ID}/requirements/topics/${topic.id}`)
    .set('Authorization', `Bearer ${harness.tokens.member}`);
  assert.equal(otherProject.status, 404);
  const otherRegister = await request(harness.app)
    .get(`/api/projects/${OTHER_PROJECT_ID}/requirements/tracks/experience/topics`)
    .set('Authorization', `Bearer ${harness.tokens.member}`);
  assert.equal(otherRegister.status, 200);
  assert.deepEqual(otherRegister.body.topics, []);
});

test('comments do not change topic status; readiness comes from the summary or the answered status', async () => {
  const harness = await createRequirementsTestApp();
  const topic = await harness.createTopic({ prompt: 'Do technicians see client notes before the visit?' });
  const ready = await harness.createTopic({ prompt: 'Should clients see a price estimate?' });
  const thin = await harness.createTopic({ prompt: 'Is booking the first task on the home screen?' });

  const comment = await harness.as('member').post(`/topics/${topic.id}/comments`, { body: 'Yes, the morning before.' });
  assert.equal(comment.status, 201);
  const reply = await harness.as('editor').post(`/topics/${topic.id}/comments`, { body: 'Agreed.', parentCommentId: comment.body.comment.id });
  assert.equal(reply.status, 201);
  const vote = await harness.as('editor').post(`/topics/${topic.id}/comments/${comment.body.comment.id}/vote`, { vote: 'up' });
  assert.deepEqual({ downvotes: vote.body.vote.downvotes, upvotes: vote.body.vote.upvotes }, { downvotes: 0, upvotes: 1 });
  const edited = await harness.as('member').patch(`/topics/${topic.id}/comments/${comment.body.comment.id}`, { body: 'Yes, the evening before.' });
  assert.equal(edited.status, 200);
  assert.equal((await harness.as('editor').patch(`/topics/${topic.id}/comments/${comment.body.comment.id}`, { body: 'Hijack' })).status, 404);
  assert.equal((await harness.as('editor').del(`/topics/${topic.id}/comments/${comment.body.comment.id}`)).status, 404);

  const detail = await harness.as('viewer').get(`/topics/${topic.id}`);
  assert.equal(detail.body.topic.status, 'open');
  assert.equal(detail.body.topic.state, 'open');
  assert.equal(detail.body.topic.evidence.comments, 2);
  assert.equal(detail.body.topic.evidence.contributors, 2);
  assert.equal(detail.body.topic.evidence.votes, 1);
  assert.equal(detail.body.topic.comments[0].children[0].body, 'Agreed.');
  assert.equal(JSON.stringify(detail.body).includes('accessToken'), false);

  const removed = await harness.as('editor').del(`/topics/${topic.id}/comments/${reply.body.comment.id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleteMode, 'hard');
  assert.equal(removed.body.topic.status, 'open');

  await readySummary(harness, ready.id);
  await harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: { output: { insufficientInput: true, proposedAnswer: 'Too early' }, scopeId: thin.id, scopeType: 'topic', track: 'experience' },
    tenantId: TENANT_ID,
  });

  const register = await harness.as('viewer').get('/tracks/experience/topics');
  const byId = new Map(register.body.topics.map((row) => [row.id, row]));
  assert.equal(byId.get(ready.id).state, 'ready');
  assert.deepEqual(byId.get(ready.id).signals, { aligned: 1, blocking: 1, divergent: 0, outstanding: 1, underExplored: 0 });
  assert.equal(byId.get(thin.id).state, 'open');
  assert.equal(register.body.topics[0].id, ready.id, 'ready topics sort first');
  assert.deepEqual(register.body.counts, { decided: 0, dismissed: 0, open: 2, ready: 1, total: 3 });

  const needsDecision = await harness.as('viewer').get('/tracks/experience/topics?view=needs-decision');
  assert.deepEqual(needsDecision.body.topics.map((row) => row.id), [ready.id]);

  // A clarification the older flow marked answered counts as ready.
  await harness.assistantRepository.updateProjectClarification({ clarificationId: thin.id, patch: { status: 'answered' }, projectId: PROJECT_ID, tenantId: TENANT_ID });
  const afterAnswered = await harness.as('viewer').get('/tracks/experience/topics?view=needs-decision');
  assert.deepEqual(new Set(afterAnswered.body.topics.map((row) => row.id)), new Set([ready.id, thin.id]));

  // Dismissed topics leave the default view.
  assert.equal((await harness.as('projectManager').patch(`/topics/${topic.id}`, { status: 'dismissed' })).status, 200);
  const defaultView = await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(defaultView.body.topics.some((row) => row.id === topic.id), false);
  const dismissedView = await harness.as('viewer').get('/tracks/experience/topics?view=dismissed');
  assert.deepEqual(dismissedView.body.topics.map((row) => row.id), [topic.id]);
  assert.equal((await harness.as('member').post(`/topics/${topic.id}/comments`, { body: 'Too late' })).status, 409);
});

test('comment threads: a deleted comment with replies stays as a placeholder until its last reply goes, and votes toggle and switch', async () => {
  const harness = await createRequirementsTestApp();
  const topic = await harness.createTopic({ prompt: 'Do technicians see client notes before the visit?' });
  const parent = (await harness.as('member').post(`/topics/${topic.id}/comments`, { body: 'Yes, the morning before.' })).body.comment;
  const child = (await harness.as('editor').post(`/topics/${topic.id}/comments`, { body: 'Agreed.', parentCommentId: parent.id })).body.comment;

  const vote = (value) => harness.as('editor').post(`/topics/${topic.id}/comments/${parent.id}/vote`, { vote: value });
  const counts = (response) => [response.body.vote.upvotes, response.body.vote.downvotes, response.body.vote.currentReaction];
  assert.deepEqual(counts(await vote('up')), [1, 0, 'up']);
  assert.deepEqual(counts(await vote('up')), [0, 0, null], 'the same vote again removes it');
  assert.deepEqual(counts(await vote('up')), [1, 0, 'up']);
  assert.deepEqual(counts(await vote('down')), [0, 1, 'down'], 'the other vote switches it');
  // A deleted comment with votes is kept, so clear the vote before the deletes below.
  assert.deepEqual(counts(await vote('down')), [0, 0, null]);

  const softDeleted = await harness.as('member').del(`/topics/${topic.id}/comments/${parent.id}`);
  assert.equal(softDeleted.status, 200);
  assert.equal(softDeleted.body.deleteMode, 'soft');
  assert.equal(softDeleted.body.comment.body, '');
  assert.equal(typeof softDeleted.body.comment.deletedAt, 'string');
  let comments = (await harness.as('viewer').get(`/topics/${topic.id}`)).body.topic.comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, parent.id);
  assert.equal(typeof comments[0].deletedAt, 'string');
  assert.deepEqual(comments[0].children.map((reply) => reply.body), ['Agreed.']);

  const hardDeleted = await harness.as('editor').del(`/topics/${topic.id}/comments/${child.id}`);
  assert.equal(hardDeleted.status, 200);
  assert.equal(hardDeleted.body.deleteMode, 'hard');
  comments = (await harness.as('viewer').get(`/topics/${topic.id}`)).body.topic.comments;
  assert.deepEqual(comments, [], 'the placeholder goes with its last reply');
});

test('members delete topics nobody has engaged with; anything with activity needs dismissal instead', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const events = harness.recordEvents(LIVE_EVENT_CHANNELS.project(PROJECT_ID));

  const untouched = await harness.createTopic({ prompt: 'Drafted question that missed' });
  await harness.as('member').patch(`/topics/${untouched.id}`, { assignments: [{ actorId: ROLE_USERS.editor.id, actorType: 'user', role: 'primary' }] });
  await harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: { output: { insufficientInput: true }, scopeId: untouched.id, scopeType: 'topic', track: 'experience' },
    tenantId: TENANT_ID,
  });
  const deleted = await harness.as('contributor').del(`/topics/${untouched.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { deleted: { id: untouched.id, track: 'experience' }, ok: true });
  assert.equal((await harness.as('viewer').get(`/topics/${untouched.id}`)).status, 404);
  assert.equal((await harness.as('viewer').get('/tracks/experience/topics')).body.topics.length, 0);
  assert.equal(harness.assistantRepository.state.projectClarificationAssignments.some((item) => item.clarificationId === untouched.id), false);
  assert.equal(harness.requirementsRepository.state.summaries.length, 0);
  assert.ok(events.events.some((event) => event.type === 'requirements.topics.invalidated' && event.reason === 'topic-deleted'));
  assert.equal((await harness.as('member').del(`/topics/${untouched.id}`)).status, 404);

  const commented = await harness.createTopic({ prompt: 'Commented question' });
  await harness.as('member').post(`/topics/${commented.id}/comments`, { body: 'A thought.' });
  const decided = await harness.createTopic({ prompt: 'Decided question' });
  await harness.as('projectManager').post('/decisions', { outcome: 'deferred', statement: 'Later.', topicId: decided.id });
  const withStakeholder = await harness.createTopic({ prompt: 'Question for a client' });
  await harness.as('member').patch(`/topics/${withStakeholder.id}`, { assignments: [{ actorId: stakeholder.id, actorType: 'stakeholder' }] });
  const withFile = await harness.createTopic({ prompt: 'Question with an attachment' });
  await harness.projectRepository.saveFile({
    fileContentsBase64: Buffer.from('notes').toString('base64'),
    fileDescription: 'Notes',
    fileName: 'notes.txt',
    fileType: 'text/plain',
    inlineImage: false,
    projectId: PROJECT_ID,
    targetId: withFile.id,
    targetType: 'clarification',
    tenantId: TENANT_ID,
    user: { id: ROLE_USERS.member.id, memberships: [{ role: 'user', tenantId: TENANT_ID }], name: ROLE_USERS.member.name },
  });

  for (const [topic, activityKey] of [[commented, 'comments'], [decided, 'decisions'], [withStakeholder, 'stakeholderAssignments'], [withFile, 'files']]) {
    const refused = await harness.as('member').del(`/topics/${topic.id}`);
    assert.equal(refused.status, 409, topic.prompt);
    assert.equal(refused.body.details.code, 'topic_has_activity');
    assert.ok(refused.body.details.activity[activityKey] > 0, `${topic.prompt}: ${JSON.stringify(refused.body.details.activity)}`);
    assert.equal((await harness.as('viewer').get(`/topics/${topic.id}`)).status, 200, 'the topic is still there');
  }
  assert.equal((await harness.as('member').del('/topics/legacy-or-missing')).status, 404);
});

test('topic assignments are validated and drive the owner column', async () => {
  const harness = await createRequirementsTestApp();
  const stakeholder = await harness.seedStakeholder();
  const topic = await harness.createTopic({ prompt: 'How do price estimates get calculated?' });

  const assigned = await harness.as('member').patch(`/topics/${topic.id}`, {
    assignments: [
      { actorId: ROLE_USERS.projectManager.id, actorType: 'user', role: 'primary' },
      { actorId: stakeholder.id, actorType: 'stakeholder' },
    ],
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.topic.owner, { actorId: ROLE_USERS.projectManager.id, actorType: 'user', label: ROLE_USERS.projectManager.name });
  assert.equal(assigned.body.topic.assignments.length, 2);
  assert.equal(JSON.stringify(assigned.body).includes('invitationToken'), false);

  assert.equal((await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: 'nobody', actorType: 'stakeholder' }] })).status, 400);
  assert.equal((await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: 'ghost', actorType: 'user' }] })).status, 400);
  assert.equal((await harness.as('member').patch(`/topics/${topic.id}`, {
    assignments: [
      { actorId: ROLE_USERS.member.id, actorType: 'user', role: 'primary' },
      { actorId: ROLE_USERS.editor.id, actorType: 'user', role: 'primary' },
    ],
  })).status, 400);
});

test('topics move between tracks with their decisions and summaries; decided topics need decision rights', async () => {
  const harness = await createRequirementsTestApp();
  const events = harness.recordEvents(LIVE_EVENT_CHANNELS.project(PROJECT_ID));
  const plain = await harness.createTopic({ prompt: 'Where do API keys live?' });
  await readySummary(harness, plain.id);

  const moved = await harness.as('member').post(`/topics/${plain.id}/move`, { track: 'architecture' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.moved, true);
  assert.equal(moved.body.from, 'experience');
  assert.equal(moved.body.topic.track, 'architecture');
  assert.equal((await harness.as('viewer').get('/tracks/experience/topics')).body.topics.length, 0);
  assert.deepEqual((await harness.as('viewer').get('/tracks/architecture/topics')).body.topics.map((topic) => topic.id), [plain.id]);
  assert.ok(harness.requirementsRepository.state.summaries.every((summary) => summary.track === 'architecture'));
  const moveTracks = events.events.filter((event) => event.reason === 'topic-moved').map((event) => event.track);
  assert.deepEqual([...new Set(moveTracks)].sort(), ['architecture', 'experience']);

  const again = await harness.as('member').post(`/topics/${plain.id}/move`, { track: 'architecture' });
  assert.equal(again.status, 200);
  assert.equal(again.body.moved, false);
  assert.equal((await harness.as('member').post(`/topics/${plain.id}/move`, { track: 'elsewhere' })).status, 400);
  assert.equal((await harness.as('viewer').post(`/topics/${plain.id}/move`, { track: 'experience' })).status, 404);
  assert.equal((await harness.as('member').post('/topics/missing/move', { track: 'experience' })).status, 404);

  const decided = await harness.createTopic({ prompt: 'Which booking flow?' });
  const decision = await harness.as('projectManager').post('/decisions', { outcome: 'deferred', statement: 'Later.', topicId: decided.id });
  assert.equal(decision.status, 201);
  assert.equal((await harness.as('member').post(`/topics/${decided.id}/move`, { track: 'architecture' })).status, 404);
  assert.equal((await harness.as('viewer').get(`/topics/${decided.id}`)).body.topic.track, 'experience', 'a refused move changes nothing');
  const managerMove = await harness.as('projectManager').post(`/topics/${decided.id}/move`, { track: 'architecture' });
  assert.equal(managerMove.status, 200, JSON.stringify(managerMove.body));
  assert.equal((await harness.as('viewer').get('/tracks/experience/decisions')).body.decisions.length, 0);
  assert.deepEqual((await harness.as('viewer').get('/tracks/architecture/decisions')).body.decisions.map((item) => item.id), [decision.body.decision.id]);
  const replaced = await harness.as('projectManager').post('/decisions', {
    outcome: 'decided', statement: 'Single page.', supersedesId: decision.body.decision.id, topicId: decided.id,
  });
  assert.equal(replaced.status, 201, 'a moved decision can still be replaced');
  assert.ok(events.events.some((event) => event.reason === 'topic-moved' && event.type === 'requirements.decisions.invalidated'));
});

test('decisions resolve topics, keep deferred topics open, supersede, and reject stale versions', async () => {
  const harness = await createRequirementsTestApp();
  const decisionEvents = harness.recordEvents(LIVE_EVENT_CHANNELS.project(PROJECT_ID));
  const topic = await harness.createTopic({ prompt: 'When does the price first appear?' });
  const other = await harness.createTopic({ prompt: 'Which reminder channel?' });

  const deferred = await harness.as('projectManager').post('/decisions', { outcome: 'deferred', statement: 'Wait for finance.', topicId: topic.id });
  assert.equal(deferred.status, 201);
  assert.equal(deferred.body.topic.status, 'open');
  assert.equal(deferred.body.topic.decisionId, deferred.body.decision.id);

  const duplicate = await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'After a time is picked.', topicId: topic.id });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.details.code, 'decision_exists');
  assert.equal(duplicate.body.details.activeDecisionId, deferred.body.decision.id);

  const decided = await harness.as('projectManager').post('/decisions', {
    outcome: 'decided',
    sourceSummaryId: 'summary-1',
    sources: ['comment:c1', 'comment:c2'],
    statement: 'Show the estimate after a time is picked.',
    supersedesId: deferred.body.decision.id,
    topicId: topic.id,
  });
  assert.equal(decided.status, 201);
  assert.equal(decided.body.topic.status, 'resolved');
  assert.equal(decided.body.topic.state, 'decided');
  assert.equal(decided.body.decision.supersedesId, deferred.body.decision.id);
  assert.deepEqual(decided.body.decision.chain, [deferred.body.decision.id]);
  assert.equal('sourceSummaryId' in decided.body.decision, false, 'the audit summary id is not presented');
  assert.ok(decisionEvents.events.some((event) => event.type === 'requirements.decisions.invalidated'));

  const stored = await harness.requirementsRepository.getDecision({ decisionId: decided.body.decision.id, projectId: PROJECT_ID, tenantId: TENANT_ID });
  assert.equal(stored.sourceSummaryId, 'summary-1');
  assert.equal(stored.decidedBy, `user:${ROLE_USERS.projectManager.id}`);

  const supersededAgain = await harness.as('projectManager').post('/decisions', {
    outcome: 'decided', statement: 'Again.', supersedesId: deferred.body.decision.id, topicId: topic.id,
  });
  assert.equal(supersededAgain.status, 409);
  assert.equal(supersededAgain.body.details.code, 'decision_superseded');

  const editSuperseded = await harness.as('projectManager').patch(`/decisions/${deferred.body.decision.id}`, { statement: 'x', version: 2 });
  assert.equal(editSuperseded.status, 409);

  const stale = await harness.as('projectManager').patch(`/decisions/${decided.body.decision.id}`, { statement: 'Stale edit', version: 7 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'decision_version_conflict');
  assert.equal(stale.body.details.currentVersion, 1);

  const edited = await harness.as('tenantAdmin').patch(`/decisions/${decided.body.decision.id}`, { statement: 'Show the estimate once a time is picked.', version: 1 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.decision.version, 2);
  const concurrent = await harness.as('projectManager').patch(`/decisions/${decided.body.decision.id}`, { statement: 'Lost update', version: 1 });
  assert.equal(concurrent.status, 409);

  const reopened = await harness.as('projectManager').patch(`/decisions/${decided.body.decision.id}`, { outcome: 'deferred', version: 2 });
  assert.equal(reopened.status, 200);
  assert.equal((await harness.as('viewer').get(`/topics/${topic.id}`)).body.topic.status, 'open');

  const outcomeSuperseded = await harness.as('projectManager').post('/decisions', { outcome: 'superseded', statement: 'Covered by the price topic.', topicId: other.id });
  assert.equal(outcomeSuperseded.status, 201);
  assert.equal(outcomeSuperseded.body.topic.status, 'resolved');

  const log = await harness.as('viewer').get('/tracks/experience/decisions');
  assert.equal(log.status, 200);
  assert.equal(log.body.decisions.length, 3);
  const byId = new Map(log.body.decisions.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(deferred.body.decision.id).status, 'superseded');
  assert.equal(byId.get(deferred.body.decision.id).supersededById, decided.body.decision.id);
  assert.equal(byId.get(decided.body.decision.id).status, 'active');
  assert.equal(byId.get(decided.body.decision.id).topic.prompt, 'When does the price first appear?');
  assert.equal(log.body.decisions.some((entry) => Object.keys(entry).some((key) => /^ai|drafted/i.test(key))), false);

  assert.equal((await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'x', topicId: 'missing' })).status, 404);
  assert.equal((await harness.as('projectManager').patch('/decisions/missing', { statement: 'x', version: 1 })).status, 404);
});

test('preferences list proposals from summaries and accept them as decisions owned by the person', async () => {
  const harness = await createRequirementsTestApp();
  const topic = await harness.createTopic({ prompt: 'Keep the serif headings?' });
  const summary = await harness.requirementsRepository.createSummary({
    projectId: PROJECT_ID,
    summary: {
      output: {
        aligned: [],
        divergent: [],
        insufficientInput: false,
        outstanding: [],
        proposedAnswer: '',
        proposedPreferences: [
          { dimension: 'type', sources: ['comment:1'], stance: 'keep', statement: 'Keep the 14px body text.' },
          { dimension: 'color', sources: ['comment:2'], stance: 'change', statement: 'Use a warmer accent.' },
        ],
        underExplored: [],
      },
      scopeId: topic.id,
      scopeType: 'topic',
      track: 'experience',
    },
    tenantId: TENANT_ID,
  });

  const listed = await harness.as('viewer').get('/tracks/experience/preferences');
  assert.equal(listed.body.proposed.length, 2);
  assert.equal(listed.body.proposed[0].summaryId, summary.id);
  const keepItem = listed.body.proposed.find((item) => item.dimension === 'type');
  assert.equal(keepItem.key, `${summary.id}:0`);
  assert.equal((await harness.as('viewer').get('/tracks/architecture/preferences')).body.proposed.length, 0);

  const accepted = await harness.as('projectManager').post('/preferences/accept', {
    dimension: keepItem.dimension,
    key: keepItem.key,
    sources: keepItem.sources,
    stance: keepItem.stance,
    statement: 'Keep the 14px body text for readability.',
    track: 'experience',
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.decision.kind, 'preference');
  assert.deepEqual(accepted.body.decision.preference, { dimension: 'type', origin: 'topic', stance: 'keep' });
  assert.equal(accepted.body.decision.decidedBy.name, ROLE_USERS.projectManager.name);

  const stored = await harness.requirementsRepository.getDecision({ decisionId: accepted.body.decision.id, projectId: PROJECT_ID, tenantId: TENANT_ID });
  assert.equal(stored.sourceSummaryId, summary.id);

  const after = await harness.as('viewer').get('/tracks/experience/preferences');
  assert.deepEqual(after.body.proposed.map((item) => item.dimension), ['color']);
  assert.equal(after.body.accepted.length, 1);
});

test('AC-19 my open items lists exactly the manager\'s four items with tracks; viewers get no decision group', async () => {
  const harness = await createRequirementsTestApp();
  const manager = ROLE_USERS.projectManager;

  const owned = await harness.createTopic({ prompt: 'How do price estimates get calculated?' }, { track: 'architecture' });
  await harness.as('member').patch(`/topics/${owned.id}`, { assignments: [{ actorId: manager.id, actorType: 'user', role: 'primary' }] });
  const readyA = await harness.createTopic({ prompt: 'Should clients see an estimated price?' });
  const readyB = await harness.createTopic({ prompt: 'Keep the palette and serif headings?' });
  await readySummary(harness, readyA.id);
  await readySummary(harness, readyB.id);
  await harness.createTopic({ prompt: 'Unrelated open topic' });

  await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    reviewers: [
      { actorId: manager.id, actorType: 'user', required: true },
      { actorId: ROLE_USERS.member.id, actorType: 'user' },
    ],
    round: { dueAt: '2026-10-10T17:00:00.000Z', number: 2, packageId: 'pkg-1', publishedAt: new Date().toISOString(), status: 'open', track: 'experience' },
    tenantId: TENANT_ID,
  });
  await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    reviewers: [{ actorId: manager.id, actorType: 'user', submittedAt: new Date().toISOString() }],
    round: { number: 1, packageId: 'pkg-0', status: 'open', track: 'architecture' },
    tenantId: TENANT_ID,
  });

  const items = await harness.as('projectManager').get('/my-items');
  assert.equal(items.status, 200);
  assert.equal(items.body.canDecide, true);
  assert.deepEqual(items.body.counts, { answer: 1, decide: 2, drafts: 0, review: 1, total: 4 });
  assert.deepEqual(new Set(items.body.groups.decide.map((item) => item.id)), new Set([readyA.id, readyB.id]));
  assert.ok(items.body.groups.decide.every((item) => item.kind === 'topic' && item.track === 'experience' && item.action === 'decide'));
  assert.deepEqual(items.body.groups.answer.map((item) => [item.id, item.track, item.action]), [[owned.id, 'architecture', 'reply']]);
  assert.equal(items.body.groups.review[0].track, 'experience');
  assert.equal(items.body.groups.review[0].meta.number, 2);
  assert.equal(items.body.groups.review[0].meta.required, true);
  for (const group of Object.values(items.body.groups)) {
    for (const item of group) {
      for (const key of ['track', 'kind', 'id', 'title', 'meta', 'createdAt', 'updatedAt', 'action']) {
        assert.ok(key in item, `${key} present`);
      }
    }
  }

  const viewer = await harness.as('viewer').get('/my-items');
  assert.equal(viewer.body.canDecide, false);
  assert.deepEqual(viewer.body.groups.decide, []);

  const member = await harness.as('member').get('/my-items');
  assert.equal(member.body.canDecide, false);
  assert.equal(member.body.groups.review.length, 1);

  await harness.requirementsRepository.insertPackage({
    pkg: { title: 'Scheduling options', track: 'architecture', uploadedBy: `user:${ROLE_USERS.member.id}`, version: 1 },
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
  });
  const withDraft = await harness.as('member').get('/my-items');
  assert.deepEqual(withDraft.body.groups.drafts.map((item) => [item.kind, item.title, item.track]), [['package', 'Scheduling options', 'architecture']]);
});

test('the overview reports brief coverage, topic counts, the latest round, decisions, and plan status per track', async () => {
  const harness = await createRequirementsTestApp();
  await harness.seedBrief();
  const covered = await harness.createTopic({ prompt: 'How should online booking look?', sourceRef: 'brief:requirements:0' });
  const ready = await harness.createTopic({ prompt: 'Should clients see a price?' });
  await readySummary(harness, ready.id);
  await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'Yes.', topicId: covered.id });
  await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    reviewers: [{ actorId: 'user-member', actorType: 'user', submittedAt: new Date().toISOString() }, { actorId: 'user-editor', actorType: 'user' }],
    round: { number: 1, packageId: 'pkg', status: 'open', track: 'experience' },
    tenantId: TENANT_ID,
  });
  await harness.requirementsRepository.insertPlan({ plan: { createdBy: 'user:user-padmin', status: 'draft', track: 'architecture', version: 1 }, projectId: PROJECT_ID, tenantId: TENANT_ID });

  const overview = await harness.as('viewer').get('/');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.canDecide, false);
  const experience = overview.body.tracks.experience.stages;
  assert.equal(experience.brief.totalLines, 4);
  assert.equal(experience.brief.coveredLines, 1);
  assert.equal(experience.brief.state, 'partial');
  assert.equal(experience.brief.lines.find((line) => line.ref === 'brief:requirements:0').topicCount, 1);
  assert.deepEqual(
    { decided: experience.discuss.decided, open: experience.discuss.open, ready: experience.discuss.ready, total: experience.discuss.total },
    { decided: 1, open: 0, ready: 1, total: 2 },
  );
  assert.equal(experience.review.state, 'open');
  assert.equal(experience.review.latestRound.reviewersTotal, 2);
  assert.equal(experience.review.latestRound.reviewersSubmitted, 1);
  assert.deepEqual({ decided: experience.decide.decided, waiting: experience.decide.waiting }, { decided: 1, waiting: 1 });
  assert.equal(experience.plan.state, 'not-started');

  const architecture = overview.body.tracks.architecture.stages;
  assert.equal(architecture.brief.coveredLines, 0);
  assert.equal(architecture.discuss.state, 'empty');
  // Review is project-wide: every track reports the project's round, and so does `review`.
  assert.equal(architecture.review.state, 'open');
  assert.deepEqual(overview.body.review, experience.review);
  assert.equal(architecture.plan.state, 'draft');

  assert.equal((await harness.as('projectManager').get('/')).body.canDecide, true);
});
