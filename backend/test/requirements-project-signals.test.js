import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { loadProjectTopics, pickProjectReviewSignal } from '../src/modules/requirements/requirements.service.js';
import {
  createRequirementsTestApp,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  ROLE_USERS,
  TENANT_ID,
} from './helpers/requirements-test-app.js';

function signalsAs(harness, role) {
  return request(harness.app).get('/api/requirements/project-signals').set('Authorization', `Bearer ${harness.tokens[role]}`);
}

function byProject(response) {
  return new Map(response.body.projects.map((entry) => [entry.projectId, entry]));
}

test('project signals match the Requirements tab counts and lead with the review the caller owes', async () => {
  const harness = await createRequirementsTestApp();
  const member = ROLE_USERS.member;
  const topic = await harness.createTopic({ prompt: 'Who approves refunds?' });
  await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: member.id, actorType: 'user', role: 'primary' }] });
  await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    reviewers: [{ actorId: ROLE_USERS.projectManager.id, actorType: 'user' }],
    round: { dueAt: '2026-10-11T17:00:00.000Z', number: 1, packageId: 'pkg-0', status: 'open', track: 'architecture' },
    tenantId: TENANT_ID,
  });
  await harness.requirementsRepository.insertRound({
    projectId: PROJECT_ID,
    reviewers: [{ actorId: member.id, actorType: 'user', required: true }],
    round: { dueAt: '2026-10-14T17:00:00.000Z', id: 'round-owed', number: 2, packageId: 'pkg-1', status: 'open', track: 'experience' },
    tenantId: TENANT_ID,
  });

  const response = await signalsAs(harness, 'member');
  assert.equal(response.status, 200);
  const signals = byProject(response);
  assert.deepEqual([...signals.keys()].sort(), [OTHER_PROJECT_ID, PROJECT_ID].sort());

  const myItems = await harness.as('member').get('/my-items');
  const project = signals.get(PROJECT_ID);
  assert.deepEqual(project.waiting, myItems.body.counts);
  assert.equal(project.waiting.total, 2);
  assert.deepEqual(project.review, {
    awaitingYou: true,
    dueAt: '2026-10-14T17:00:00.000Z',
    id: 'round-owed',
    number: 2,
    openCount: 2,
    required: true,
    reviewer: true,
    submitted: false,
    track: 'experience',
  });
  assert.equal(signals.get(OTHER_PROJECT_ID).review, null);
  assert.equal(signals.get(OTHER_PROJECT_ID).waiting.total, 0);
});

test('project signals skip archived projects and projects the caller cannot see', async () => {
  const harness = await createRequirementsTestApp();
  await harness.projectRepository.updateProject({
    input: { description: '', endDate: null, name: 'Other project', startDate: null, status: 'Archived' },
    projectId: OTHER_PROJECT_ID,
    tenantId: TENANT_ID,
    user: { id: ROLE_USERS.tenantAdmin.id },
  });

  const member = await signalsAs(harness, 'member');
  assert.equal(member.status, 200);
  assert.deepEqual(member.body.projects.map((entry) => entry.projectId), [PROJECT_ID]);

  const outsider = await signalsAs(harness, 'outsider');
  assert.equal(outsider.status, 200);
  assert.deepEqual(outsider.body.projects, []);

  const anonymous = await request(harness.app).get('/api/requirements/project-signals');
  assert.equal(anonymous.status, 401);
});

test('a project whose requirements fail to load comes back unavailable instead of failing the list', async () => {
  const harness = await createRequirementsTestApp();
  const listRounds = harness.requirementsRepository.listRounds.bind(harness.requirementsRepository);
  harness.requirementsRepository.listRounds = async (input) => {
    if (input.projectId === OTHER_PROJECT_ID) throw new Error('rounds table missing');
    return listRounds(input);
  };

  const response = await signalsAs(harness, 'member');
  assert.equal(response.status, 200);
  const signals = byProject(response);
  assert.deepEqual(signals.get(OTHER_PROJECT_ID), { projectId: OTHER_PROJECT_ID, review: null, unavailable: true, waiting: null });
  assert.equal(signals.get(PROJECT_ID).waiting.total, 0);
});

test('loading topics for the projects list leaves Odin summary refreshes alone', async () => {
  const harness = await createRequirementsTestApp();
  await harness.createTopic({ prompt: 'Who approves refunds?' });
  const calls = [];
  const deps = {
    assistantRepository: harness.assistantRepository,
    projectRepository: harness.projectRepository,
    requirementsRepository: harness.requirementsRepository,
    requirementsSummaries: { ensureFresh: (input) => calls.push(input.projectId) },
  };
  await loadProjectTopics(deps, { projectId: PROJECT_ID, scheduleSummaries: false, tenantId: TENANT_ID });
  assert.deepEqual(calls, []);
  await loadProjectTopics(deps, { projectId: PROJECT_ID, tenantId: TENANT_ID });
  assert.deepEqual(calls, [PROJECT_ID]);
});

test('the review signal falls back to the open round closing soonest', () => {
  const rounds = [
    { dueAt: null, id: 'r-none', number: 3, reviewers: [], status: 'open', track: 'experience' },
    { dueAt: '2026-10-20T17:00:00.000Z', id: 'r-late', number: 2, reviewers: [], status: 'open', track: 'experience' },
    { dueAt: '2026-10-13T17:00:00.000Z', id: 'r-soon', number: 1, reviewers: [{ actorId: 'u1', actorType: 'user', submittedAt: '2026-10-12T09:00:00.000Z' }], status: 'open', track: 'architecture' },
    { dueAt: '2026-10-01T17:00:00.000Z', id: 'r-closed', number: 0, reviewers: [], status: 'closed', track: 'experience' },
  ];
  const signal = pickProjectReviewSignal(rounds, 'u1');
  assert.equal(signal.id, 'r-soon');
  assert.equal(signal.awaitingYou, false);
  assert.equal(signal.submitted, true);
  assert.equal(signal.openCount, 3);
  assert.equal(pickProjectReviewSignal(rounds.filter((round) => round.status === 'closed'), 'u1'), null);
  // A reviewer removed from the round no longer owes it.
  const removed = pickProjectReviewSignal([{ ...rounds[1], reviewers: [{ actorId: 'u1', actorType: 'user', removedAt: '2026-10-11T00:00:00.000Z' }] }], 'u1');
  assert.equal(removed.reviewer, false);
  assert.equal(removed.awaitingYou, false);
});
