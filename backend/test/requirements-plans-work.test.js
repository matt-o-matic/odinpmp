import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoAiAttribution,
  createPlansTestApp,
  PROJECT_ID,
  ROLE_USERS,
  STATEMENTS,
  stubPlanAi,
  TENANT_ID,
} from './helpers/requirements-plans-app.js';

// Propose work: an approved plan becomes proposed epics and stories,
// staged as a proposal card in an assistant chat of the proposer's. No work item exists until a
// person applies it there; dismissed items stay out.

async function approvedPlan(harness) {
  const seeded = await harness.seedDecisions();
  const { plan } = await harness.draft();
  const { plan: approved } = await harness.approve(plan);
  return { ...seeded, plan: approved };
}

// The chat a proposal was staged in, and the proposal card holding a given item.
async function stagedProposal(harness, role, chatId, itemId) {
  const response = await harness.assistant(role).get(`/chats/${chatId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { chat } = response.body;
  const proposal = chat.messages.map((message) => message.proposal).filter(Boolean).find((entry) => entry.items.some((item) => item.id === itemId));
  return { chat, proposal };
}

const pendingItemIds = (chat) => chat.messages.flatMap((message) => (message.proposal?.items ?? []).filter((item) => item.status === 'pending').map((item) => item.id));

function storiesOf(epics) {
  return epics.flatMap((epic) => (epic.stories ?? []).map((story) => ({ ...story, epicName: epic.name })));
}

test('propose work needs an approved plan and plan.edit, and places proposals in pending review without creating work items', async () => {
  const harness = await createPlansTestApp();
  const seeded = await harness.seedDecisions();
  const { plan: draft } = await harness.draft();

  const early = await harness.as('editor').post(`/plans/${draft.id}/propose-work`);
  assert.equal(early.status, 409);
  assert.equal(early.body.details.code, 'plan_not_approved');
  const { plan } = await harness.approve(draft);
  for (const role of ['viewer', 'member', 'user', 'outsider']) {
    assert.equal((await harness.as(role).post(`/plans/${plan.id}/propose-work`)).status, 404, `${role} cannot propose work`);
  }

  const body = await harness.proposeWork(plan);
  assertNoAiAttribution(assert, body);
  assert.equal(body.ok, true);
  assert.equal(body.planId, plan.id);
  assert.deepEqual(body.uncoveredCriteriaIds, []);
  assert.deepEqual(body.alreadyAppliedCriteriaIds, []);

  // The local-fixture breakdown: one epic per scope item group, one story per criterion.
  const criteriaById = new Map(plan.criteria.map((criterion) => [criterion.id, criterion]));
  const epics = body.proposals.filter((item) => item.kind === 'epic');
  const stories = body.proposals.filter((item) => item.kind === 'story');
  assert.equal(epics.length, plan.scope.length);
  assert.equal(stories.length, plan.criteria.length);
  assert.deepEqual(stories.map((story) => story.criteriaIds).flat().sort(), plan.criteria.map((criterion) => criterion.id).sort());
  for (const story of stories) {
    assert.equal(story.status, 'pending');
    assert.ok(story.criteriaIds.length > 0);
    assert.deepEqual(story.acceptanceCriteria, story.criteriaIds.map((id) => ({ id, scenario: criteriaById.get(id).scenario })));
    assert.deepEqual(story.sourceDecisionIds, [...new Set(story.criteriaIds.flatMap((id) => criteriaById.get(id).decisionIds))]);
    assert.equal(story.parent.kind, 'epic');
    assert.equal(story.actionId, epics.find((epic) => epic.itemId === story.parent.itemId).actionId);
  }
  for (const epic of epics) {
    assert.equal(epic.parent, null);
    assert.equal(epic.storyCount, stories.filter((story) => story.parent.itemId === epic.itemId).length);
  }
  const decisionIds = new Set(stories.flatMap((story) => story.sourceDecisionIds));
  for (const id of [seeded.decisions.first.id, seeded.decisions.price.id, seeded.decisions.preference.id]) assert.ok(decisionIds.has(id));
  assert.equal(decisionIds.has(seeded.decisions.deferred.id), false, 'non-goals get no work');

  // Nothing becomes a work item until a person applies it.
  assert.deepEqual(await harness.projectEpics(), []);

  const { reviewLink } = body;
  assert.equal(reviewLink.surface, 'ai-workspace');
  assert.equal(reviewLink.projectId, PROJECT_ID);
  assert.deepEqual(reviewLink.query, { assistant: '1', assistantSessionId: reviewLink.sessionId });
  assert.deepEqual(reviewLink.actionIds.sort(), epics.map((epic) => epic.actionId).sort());

  // The proposals are a card in an ordinary assistant chat of the proposer's.
  const { chat, proposal: card } = await stagedProposal(harness, 'editor', reviewLink.sessionId, epics[0].actionId);
  assert.equal(chat.projectId, PROJECT_ID);
  assert.equal(chat.title, 'Experience plan v1 · proposed work');
  assert.equal(card.source, 'requirements-plan');
  assert.equal(card.status, 'pending');
  assert.deepEqual(card.items.map((item) => [item.kind, item.status, item.label]), epics.map((epic) => ['epic', 'pending', epic.title]));
  assert.deepEqual(card.items.flatMap((item) => item.payload.node.stories.map(() => 'story')), stories.map(() => 'story'));
  assert.match(chat.messages.at(-1).content, /^Proposed work from the Experience plan v1: \d+ new epics? and \d+ stor(y|ies)\./);

  const listed = await harness.assistant('editor').get('/chats');
  const group = listed.body.projects.find((entry) => entry.projectId === PROJECT_ID);
  assert.equal(group.chats.find((entry) => entry.id === reviewLink.sessionId).pendingProposalCount, epics.length);
  assert.equal((await harness.assistant('projectManager').get(`/chats/${reviewLink.sessionId}`)).status, 404, 'a chat belongs to its proposer');

  // The plan shows the proposed work: the proposer gets the review link, others see the state.
  const mine = await harness.as('editor').get(`/plans/${plan.id}`);
  assertNoAiAttribution(assert, mine.body);
  const [proposal] = mine.body.plan.proposedWork;
  assert.equal(proposal.mine, true);
  assert.deepEqual(proposal.proposedBy, { id: ROLE_USERS.editor.id, name: ROLE_USERS.editor.name });
  assert.deepEqual(proposal.counts, { applied: 0, dismissed: 0, pending: body.proposals.length });
  assert.equal(proposal.reviewLink.sessionId, reviewLink.sessionId);
  const theirs = await harness.as('projectManager').get(`/plans/${plan.id}`);
  assert.equal(theirs.body.plan.proposedWork[0].mine, false);
  assert.equal(theirs.body.plan.proposedWork[0].reviewLink, null);
  assert.deepEqual(await harness.projectEpics(), []);
});

test('applying the proposal card creates the items with their criteria and decision references', async () => {
  const harness = await createPlansTestApp();
  const { decisions, plan, topics } = await approvedPlan(harness);
  const body = await harness.proposeWork(plan);
  assert.deepEqual(await harness.projectEpics(), []);

  const { proposal: card } = await stagedProposal(harness, 'editor', body.reviewLink.sessionId, body.reviewLink.actionIds[0]);
  const applied = await harness.assistant('editor').post(`/chats/${body.reviewLink.sessionId}/proposals`, { decision: 'apply', proposalId: card.id });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(pendingItemIds(applied.body.chat), []);

  const epics = await harness.projectEpics();
  const stories = storiesOf(epics);
  const proposedStories = body.proposals.filter((item) => item.kind === 'story');
  assert.deepEqual(epics.map((epic) => epic.name).sort(), body.proposals.filter((item) => item.kind === 'epic').map((item) => item.title).sort());
  assert.equal(stories.length, proposedStories.length);
  for (const proposal of proposedStories) {
    const story = stories.find((entry) => entry.id === proposal.itemId);
    assert.ok(story, `story ${proposal.title} exists`);
    for (const criterion of proposal.acceptanceCriteria) assert.ok(story.description.includes(`${criterion.id}: ${criterion.scenario}`));
    for (const decisionId of proposal.sourceDecisionIds) assert.ok(story.description.includes(`(decision ${decisionId})`), 'the story keeps its source decision ids');
    assert.match(story.description, /From the Experience plan v1\./);
    assert.doesNotMatch(story.description, /\b(AI|Odin)\b/, 'no AI attribution on applied work');
  }
  // Topic decisions also link through the existing clarification field.
  const homeStory = stories.find((story) => story.description.includes(`(decision ${decisions.first.id})`));
  assert.deepEqual(homeStory.sourceClarificationIds, [topics.home.id]);
  const preferenceStory = stories.find((story) => story.description.includes(`(decision ${decisions.preference.id})`) && !story.description.includes(decisions.first.id));
  assert.deepEqual(preferenceStory?.sourceClarificationIds ?? [], [], 'preferences have no topic to link');
  assert.ok(stories.every((story) => !story.description.includes(STATEMENTS.oldPrice)));

  const after = await harness.as('editor').get(`/plans/${plan.id}`);
  assert.deepEqual(after.body.plan.proposedWork[0].counts, { applied: body.proposals.length, dismissed: 0, pending: 0 });
  assert.deepEqual(after.body.plan.proposedWork[0].reviewLink.actionIds, []);

  const again = await harness.as('editor').post(`/plans/${plan.id}/propose-work`);
  assert.equal(again.status, 409);
  assert.equal(again.body.details.code, 'plan_work_applied');
});

test('applying one epic and dismissing the rest settles each proposal', async () => {
  const harness = await createPlansTestApp();
  const { plan } = await approvedPlan(harness);
  const body = await harness.proposeWork(plan, { role: 'projectManager' });
  const chatPath = `/chats/${body.reviewLink.sessionId}`;

  const firstEpic = body.proposals.find((item) => item.kind === 'epic');
  const { proposal: card } = await stagedProposal(harness, 'projectManager', body.reviewLink.sessionId, firstEpic.actionId);
  const applied = await harness.assistant('projectManager').post(`${chatPath}/proposals`, { decision: 'apply', itemIds: [firstEpic.actionId], proposalId: card.id });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.chat.messages.at(-1).proposal.status, 'partial');
  const dismissed = await harness.assistant('projectManager').post(`${chatPath}/proposals`, { decision: 'dismiss', proposalId: card.id });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  const epics = await harness.projectEpics();
  assert.deepEqual(epics.map((epic) => epic.id), [firstEpic.itemId]);
  const expected = body.proposals.filter((item) => item.kind === 'story' && item.parent.itemId === firstEpic.itemId);
  assert.deepEqual(storiesOf(epics).map((story) => story.id).sort(), expected.map((item) => item.itemId).sort());
  for (const story of storiesOf(epics)) {
    const proposal = expected.find((item) => item.itemId === story.id);
    for (const decisionId of proposal.sourceDecisionIds) assert.ok(story.description.includes(`(decision ${decisionId})`));
  }

  const state = await harness.as('projectManager').get(`/plans/${plan.id}`);
  const statuses = new Map(state.body.plan.proposedWork[0].items.map((item) => [item.itemId, item.status]));
  assert.equal(statuses.get(firstEpic.itemId), 'applied');
  const others = body.proposals.filter((item) => item.itemId !== firstEpic.itemId && item.parent?.itemId !== firstEpic.itemId);
  for (const item of others) assert.equal(statuses.get(item.itemId), 'dismissed', 'dismissed proposals stay out');
});

test('proposing again reuses the chat, withdraws pending proposals, and skips criteria that already have applied work', async () => {
  const harness = await createPlansTestApp();
  const { plan } = await approvedPlan(harness);
  const first = await harness.proposeWork(plan);
  const second = await harness.proposeWork(plan);
  assert.equal(second.reviewLink.sessionId, first.reviewLink.sessionId);
  const { chat } = await stagedProposal(harness, 'editor', second.reviewLink.sessionId, second.reviewLink.actionIds[0]);
  assert.deepEqual(pendingItemIds(chat).sort(), second.reviewLink.actionIds.sort());

  // Apply one epic, then propose again: its criteria are not proposed a second time.
  const [applyEpic] = second.proposals.filter((item) => item.kind === 'epic');
  const { proposal: secondCard } = await stagedProposal(harness, 'editor', second.reviewLink.sessionId, applyEpic.actionId);
  const applied = await harness.assistant('editor').post(`/chats/${second.reviewLink.sessionId}/proposals`, { decision: 'apply', itemIds: [applyEpic.actionId], proposalId: secondCard.id });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const third = await harness.proposeWork(plan);
  assert.deepEqual(third.alreadyAppliedCriteriaIds.sort(), applyEpic.criteriaIds.sort());
  const proposedCriteria = third.proposals.filter((item) => item.kind === 'story').flatMap((item) => item.criteriaIds);
  assert.equal(proposedCriteria.some((id) => applyEpic.criteriaIds.includes(id)), false);
  assert.ok(proposedCriteria.length > 0);
  assert.equal((await harness.projectEpics()).length, 1, 'the new proposals are still pending');

  // Another person proposing gets a separate review of their own.
  const managers = await harness.proposeWork(plan, { role: 'projectManager' });
  assert.notEqual(managers.reviewLink.sessionId, third.reviewLink.sessionId);
  const state = await harness.as('editor').get(`/plans/${plan.id}`);
  assert.deepEqual(state.body.plan.proposedWork.map((entry) => entry.mine).sort(), [false, true]);
});

test('applied items are recognised by their trace when the tree writer gives them new ids, as MySQL does', async () => {
  const harness = await createPlansTestApp();
  const { plan } = await approvedPlan(harness);
  const body = await harness.proposeWork(plan);
  const { proposal: card } = await stagedProposal(harness, 'editor', body.reviewLink.sessionId, body.reviewLink.actionIds[0]);
  const [action] = card.items;
  const { node } = action.payload;
  await harness.projectRepository.replaceProjectTree({
    input: { epics: [{ ...node, id: 'fresh-epic', stories: node.stories.map((story, index) => ({ ...story, id: `fresh-story-${index}` })) }] },
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    user: { id: ROLE_USERS.editor.id, name: ROLE_USERS.editor.name },
  });

  const state = await harness.as('editor').get(`/plans/${plan.id}`);
  const statuses = new Map(state.body.plan.proposedWork[0].items.map((item) => [item.itemId, item.status]));
  assert.equal(statuses.get(action.targetId), 'applied');
  for (const story of node.stories) assert.equal(statuses.get(story.id), 'applied');
  const again = await harness.proposeWork(plan);
  const appliedCriteria = body.proposals.filter((item) => item.parent?.itemId === action.targetId).flatMap((item) => item.criteriaIds);
  assert.deepEqual(again.alreadyAppliedCriteriaIds.sort(), [...new Set(appliedCriteria)].sort());
});

test('AI output is checked: stories need valid criteria, existing epics are reused, failures change nothing', async () => {
  const ai = stubPlanAi();
  const harness = await createPlansTestApp({ requirementsAiService: ai });
  const { plan } = await approvedPlan(harness);
  await harness.projectRepository.replaceProjectTree({
    input: { epics: [{ id: 'epic-existing', name: 'Price display', status: 'Not Started', stories: [] }] },
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    user: { id: ROLE_USERS.projectAdmin.id, name: ROLE_USERS.projectAdmin.name },
  });

  ai.work = new Error('timeout');
  const failed = await harness.as('editor').post(`/plans/${plan.id}/propose-work`);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.details.retryable, true);
  ai.work = { epics: [{ description: '', existingEpicRef: '', stories: [{ criteriaIds: ['AC-E99'], description: '', title: 'Ghost' }], title: 'Nothing real' }] };
  const uncited = await harness.as('editor').post(`/plans/${plan.id}/propose-work`);
  assert.equal(uncited.status, 502);
  assert.equal(uncited.body.details.code, 'work_output_uncited');
  assert.equal((await harness.as('editor').get(`/plans/${plan.id}`)).body.plan.proposedWork.length, 0);

  ai.work = {
    epics: [
      { description: 'Booking flow', existingEpicRef: '', stories: [{ criteriaIds: ['AC-E1', 'AC-E42'], description: 'Book from home.', title: 'Book from home' }], title: 'Booking from home' },
      { description: '', existingEpicRef: 'EP1', stories: [{ criteriaIds: ['ac-e2'], description: '', title: 'Price range before tax' }], title: 'Ignored title' },
      { description: '', existingEpicRef: '', stories: [{ criteriaIds: [], description: '', title: 'No criteria' }], title: 'Empty' },
    ],
  };
  const body = await harness.proposeWork(plan);
  const call = ai.calls.proposeWork.at(-1);
  assert.deepEqual(call.modelInput.existingEpicRefs, ['EP1']);
  assert.equal(call.modelInput.untrustedContent.existingEpics[0].name, 'Price display');
  assert.deepEqual(call.modelInput.criteriaIds, plan.criteria.map((criterion) => criterion.id));
  assert.equal(call.modelInput.untrustedContent.trust, 'untrusted');

  assert.deepEqual(body.dropped.map((entry) => [entry.what, entry.reason]), [['citation', 'unknown-criterion'], ['story', 'uncited'], ['epic', 'empty']]);
  assert.deepEqual(body.proposals.map((item) => [item.kind, item.title, item.parent?.title ?? null, item.parent?.existing ?? null]), [
    ['epic', 'Booking from home', null, null],
    ['story', 'Book from home', 'Booking from home', false],
    ['story', 'Price range before tax', 'Price display', true],
  ]);
  const uncovered = plan.criteria.map((criterion) => criterion.id).filter((id) => !['AC-E1', 'AC-E2'].includes(id));
  assert.deepEqual(body.uncoveredCriteriaIds, uncovered);

  const existingStory = body.proposals[2];
  assert.notEqual(existingStory.actionId, body.proposals[0].actionId, 'a story under an existing epic is its own proposal');
  const { proposal: card } = await stagedProposal(harness, 'editor', body.reviewLink.sessionId, existingStory.actionId);
  assert.deepEqual(card.items.map((item) => [item.kind, item.parentId ?? '']), [['epic', ''], ['story', 'epic-existing']]);

  const applied = await harness.assistant('editor').post(`/chats/${body.reviewLink.sessionId}/proposals`, { decision: 'apply', itemIds: [existingStory.actionId], proposalId: card.id });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const epics = await harness.projectEpics();
  assert.deepEqual(epics.map((epic) => [epic.id, epic.stories.map((story) => story.name)]), [['epic-existing', ['Price range before tax']]]);
});
