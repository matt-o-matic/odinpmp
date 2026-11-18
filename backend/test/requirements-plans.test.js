import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '../src/lib/errors/http-error.js';
import { REQUIREMENTS_PLAN_EVENT } from '../src/modules/requirements/plans/plans.service.js';
import {
  assertNoAiAttribution,
  createPlansTestApp,
  PROJECT_ID,
  ROLE_USERS,
  STATEMENTS,
  stubPlanAi,
  TENANT_ID,
} from './helpers/requirements-plans-app.js';

// Track plans through the API: drafting from decisions, citation checks,
// failure recovery, edits, approval and ownership, permissions, and live events. Proposed
// work is covered in requirements-plans-work.test.js.

function planEvents(recorder) {
  return recorder.events.filter((event) => event.type === REQUIREMENTS_PLAN_EVENT);
}

test('drafting builds the plan from active decisions only, validates citations, and records what it dropped', async () => {
  const ai = stubPlanAi({
    draft: {
      criteria: [
        { decisionIds: ['D-01'], id: '', scenario: 'A new client books a standard visit from the home screen in under 2 minutes.' },
        { decisionIds: ['D-4', 'D-02'], id: 'AC-X9', scenario: 'The home screen shows a price range labelled "before tax" | for every service.' },
        { decisionIds: ['D-02'], id: '', scenario: 'The price shows only after a time is picked.' },
      ],
      nonGoals: [{ decisionIds: ['D-03'], text: 'SMS reminders' }],
      objective: 'Clients book a home visit in under two minutes and always know the price range before they commit.',
      scope: [
        { decisionIds: ['D-01', 'D-05'], text: 'Home screen with one primary booking action' },
        { decisionIds: ['D-04', 'D-02'], text: 'Price range before tax on home' },
        { decisionIds: ['D-99'], text: 'Loyalty points' },
      ],
    },
  });
  const harness = await createPlansTestApp({ requirementsAiService: ai });
  await harness.seedBrief();
  const { decisions, topics } = await harness.seedDecisions();
  const recorder = harness.recordEvents(`project:${PROJECT_ID}`);

  const body = await harness.draft();
  const { plan } = body;
  assert.equal(plan.version, 1);
  assert.equal(plan.status, 'draft');
  assert.equal(plan.revision, 1);
  assert.equal(plan.title, 'Experience plan v1');
  assert.equal(plan.owner, null, 'a draft has no owner until someone approves it');
  assert.equal(plan.objective, 'Clients book a home visit in under two minutes and always know the price range before they commit.');

  // Citations map to decision ids; superseded and unknown refs are removed, uncited items dropped.
  assert.deepEqual(plan.scope, [
    { decisionIds: [decisions.first.id, decisions.preference.id], text: 'Home screen with one primary booking action' },
    { decisionIds: [decisions.price.id], text: 'Price range before tax on home' },
  ]);
  assert.deepEqual(plan.nonGoals, [{ decisionIds: [decisions.deferred.id], text: 'SMS reminders' }]);
  assert.deepEqual(plan.criteria.map((criterion) => [criterion.id, criterion.decisionIds]), [
    ['AC-E1', [decisions.first.id]],
    ['AC-E2', [decisions.price.id]],
  ]);
  assert.deepEqual(body.dropped.map((entry) => [entry.section, entry.what, entry.reason, entry.ref ?? null]), [
    ['scope', 'citation', 'inactive-decision', 'D-02'],
    ['scope', 'citation', 'unknown-decision', 'D-99'],
    ['scope', 'item', 'uncited', null],
    ['criteria', 'citation', 'inactive-decision', 'D-02'],
    ['criteria', 'citation', 'inactive-decision', 'D-02'],
    ['criteria', 'item', 'uncited', null],
  ]);
  assert.deepEqual(plan.decisions.map((decision) => [decision.label, decision.status, decision.kind]), [
    ['D-01', 'active', 'topic'],
    ['D-05', 'active', 'preference'],
    ['D-04', 'active', 'topic'],
    ['D-03', 'active', 'topic'],
  ]);
  assert.deepEqual(plan.staleDecisionIds, []);

  // The Markdown body is rendered from the structure, with labels and an escaped table.
  assert.match(plan.body, /^# Experience plan v1\n/);
  assert.match(plan.body, /- Home screen with one primary booking action \(D-01, D-05\)/);
  assert.match(plan.body, /## Not in scope\n\n- SMS reminders \(D-03\)/);
  assert.match(plan.body, /\| AC-E2 \| The home screen shows a price range labelled "before tax" \\\| for every service\. \| D-04 \|/);

  // The model saw only active topic decisions and accepted preferences of this track.
  const [call] = ai.calls.draftPlan;
  assert.equal(call.track, 'experience');
  assert.deepEqual(call.modelInput.citableDecisionRefs, ['D-01', 'D-03', 'D-04', 'D-05']);
  assert.equal(call.modelInput.untrustedContent.trust, 'untrusted');
  const statements = call.modelInput.untrustedContent.decisions.map((decision) => decision.statement);
  assert.equal(statements.includes(STATEMENTS.oldPrice), false, 'superseded decisions are not input');
  assert.equal(statements.includes(STATEMENTS.architecture), false, 'other tracks are not input');
  assert.equal(call.modelInput.untrustedContent.decisions.find((decision) => decision.ref === 'D-01').topic, topics.home.prompt);
  assert.deepEqual(call.modelInput.untrustedContent.decisions.find((decision) => decision.ref === 'D-05').preference, { dimension: 'hierarchy', stance: 'keep' });
  assert.ok(call.modelInput.untrustedContent.brief.some((line) => line.text === 'Clients can book a visit online'));
  assert.equal(call.modelInput.untrustedContent.previousPlan, null);

  assertNoAiAttribution(assert, body);
  const overview = await harness.as('viewer').get('/');
  assert.deepEqual(overview.body.tracks.experience.stages.plan.latestPlan, { approvedAt: null, id: plan.id, status: 'draft', version: 1 });
  assert.equal(overview.body.tracks.experience.stages.plan.state, 'draft');
  assert.deepEqual(planEvents(recorder).map((event) => [event.reason, event.track, event.planId, event.version]), [
    ['plan-drafted', 'experience', plan.id, 1],
  ]);

  // The next draft is version 2 and carries the previous version to the model.
  await harness.draft();
  assert.equal(ai.calls.draftPlan[1].modelInput.untrustedContent.previousPlan.version, 1);
  assert.deepEqual(ai.calls.draftPlan[1].modelInput.untrustedContent.previousPlan.criteria.map((criterion) => criterion.decisionIds), [['D-01'], ['D-04']]);
  const listed = await harness.as('viewer').get('/plans?track=experience');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.plans.map((entry) => [entry.version, entry.status]), [[2, 'draft'], [1, 'draft']]);
  assertNoAiAttribution(assert, listed.body);
});

test('a failed or uncited draft keeps the previous version and returns a retryable error', async () => {
  const ai = stubPlanAi();
  const harness = await createPlansTestApp({ requirementsAiService: ai });
  await harness.seedDecisions();
  const { plan: first } = await harness.draft();

  ai.draft = new Error('upstream timeout');
  const failed = await harness.as('editor').post('/plans/experience/draft');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.details.code, 'ai_request_failed');
  assert.equal(failed.body.details.retryable, true);

  ai.draft = { criteria: [{ decisionIds: ['D-02'], id: '', scenario: 'Cites only a superseded decision.' }], nonGoals: [], objective: 'x', scope: [] };
  const uncited = await harness.as('editor').post('/plans/experience/draft');
  assert.equal(uncited.status, 502);
  assert.equal(uncited.body.details.code, 'plan_output_uncited');
  assert.equal(uncited.body.details.retryable, true);

  ai.draft = { criteria: 'not a list' };
  const malformed = await harness.as('editor').post('/plans/experience/draft');
  assert.equal(malformed.status, 502);
  assert.equal(malformed.body.details.code, 'ai_output_invalid');

  ai.draft = new HttpError(503, 'ai_not_configured');
  const keyless = await harness.as('editor').post('/plans/experience/draft');
  assert.equal(keyless.status, 503);
  assert.equal(keyless.body.details.code, 'ai_not_configured');

  const listed = await harness.as('editor').get('/plans?track=experience');
  assert.deepEqual(listed.body.plans.map((plan) => [plan.id, plan.version, plan.status]), [[first.id, 1, 'draft']]);

  const unconfigured = await createPlansTestApp({ requirementsAiService: null });
  await unconfigured.seedDecisions();
  const missing = await unconfigured.as('editor').post('/plans/experience/draft');
  assert.equal(missing.status, 503);
  assert.equal(missing.body.details.code, 'ai_not_configured');

  const empty = await createPlansTestApp();
  const noDecisions = await empty.as('editor').post('/plans/architecture/draft');
  assert.equal(noDecisions.status, 409);
  assert.equal(noDecisions.body.details.code, 'no_decisions');
  assert.equal((await empty.as('editor').post('/plans/strategy/draft')).status, 404);
});

test('people edit a draft in place with revision checks; editing the approved plan starts a new draft version', async () => {
  const harness = await createPlansTestApp();
  const { decisions } = await harness.seedDecisions();
  const { plan } = await harness.draft();

  const edited = await harness.as('contributor').patch(`/plans/${plan.id}`, {
    criteria: [
      { decisionIds: [decisions.first.id], id: 'AC-E2', scenario: 'Booking starts from the home screen.' },
      { decisionIds: ['D-04'], scenario: 'A price range shows before tax.' },
      { scenario: 'Uncited criteria are fine when a person writes them.' },
    ],
    objective: 'Clients book a visit without calling.',
    revision: 1,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.createdVersion, false);
  assert.equal(edited.body.plan.id, plan.id);
  assert.equal(edited.body.plan.revision, 2);
  assert.equal(edited.body.plan.objective, 'Clients book a visit without calling.');
  assert.deepEqual(edited.body.plan.criteria.map((criterion) => [criterion.id, criterion.decisionIds]), [
    ['AC-E2', [decisions.first.id]],
    ['AC-E3', [decisions.price.id]],
    ['AC-E4', []],
  ]);
  assert.match(edited.body.plan.body, /Clients book a visit without calling\./);
  assert.deepEqual(edited.body.plan.scope, plan.scope, 'fields left out stay as they were');
  assertNoAiAttribution(assert, edited.body);

  const stale = await harness.as('editor').patch(`/plans/${plan.id}`, { objective: 'Stale write', revision: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'plan_revision_conflict');
  assert.equal(stale.body.details.currentRevision, 2);

  const superseded = await harness.as('editor').patch(`/plans/${plan.id}`, { revision: 2, scope: [{ decisionIds: ['D-02'], text: 'Cites the old price decision' }] });
  assert.equal(superseded.status, 400);
  assert.equal(superseded.body.details.code, 'invalid_plan_edit');
  assert.deepEqual(superseded.body.details.issues.map((issue) => [issue.section, issue.reason, issue.ref]), [['scope', 'inactive-decision', 'D-02']]);
  const unknown = await harness.as('editor').patch(`/plans/${plan.id}`, { criteria: [{ decisionIds: ['D-77'], id: 'AC-A1', scenario: 'x' }], revision: 2 });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body.details.issues.map((issue) => issue.reason), ['unknown-decision', 'invalid-criterion-id']);
  const empty = await harness.as('editor').patch(`/plans/${plan.id}`, { revision: 2 });
  assert.equal(empty.status, 400);

  const { plan: approved } = await harness.approve(edited.body.plan);
  const fork = await harness.as('editor').patch(`/plans/${approved.id}`, {
    revision: approved.revision,
    scope: [{ decisionIds: [decisions.first.id], text: 'Booking from the home screen only' }],
  });
  assert.equal(fork.status, 200, JSON.stringify(fork.body));
  assert.equal(fork.body.createdVersion, true);
  assert.notEqual(fork.body.plan.id, approved.id);
  assert.equal(fork.body.plan.version, 2);
  assert.equal(fork.body.plan.status, 'draft');
  assert.equal(fork.body.plan.owner, null);
  assert.deepEqual(fork.body.plan.basedOn, { id: approved.id, version: 1 });
  assert.deepEqual(fork.body.plan.criteria, approved.criteria);
  assert.match(fork.body.plan.body, /^# Experience plan v2\n/);

  const unchanged = await harness.as('viewer').get(`/plans/${approved.id}`);
  assert.equal(unchanged.body.plan.status, 'approved');
  assert.deepEqual(unchanged.body.plan.scope, approved.scope, 'the approved plan never changes underneath its owner');
  assert.equal(unchanged.body.plan.owner.name, ROLE_USERS.projectManager.name);

  const behind = await harness.as('editor').patch(`/plans/${approved.id}`, { objective: 'Again', revision: unchanged.body.plan.revision });
  assert.equal(behind.status, 409);
  assert.equal(behind.body.details.code, 'plan_not_latest');
  assert.equal(behind.body.details.latestPlanId, fork.body.plan.id);
});

test('approval needs decision rights, makes the approver the owner, and supersedes earlier versions', async () => {
  const harness = await createPlansTestApp();
  const { decisions, topics } = await harness.seedDecisions();
  const { plan: first } = await harness.draft();

  for (const role of ['viewer', 'member', 'user', 'editor', 'contributor', 'outsider']) {
    const denied = await harness.as(role).post(`/plans/${first.id}/approve`, {});
    assert.equal(denied.status, 404, `${role} cannot approve`);
  }
  const conflict = await harness.as('tenantManager').post(`/plans/${first.id}/approve`, { revision: 9 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.details.code, 'plan_revision_conflict');

  const approved = await harness.as('tenantManager').post(`/plans/${first.id}/approve`, { revision: first.revision });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.plan.status, 'approved');
  assert.deepEqual(approved.body.plan.owner, { id: ROLE_USERS.tenantManager.id, name: ROLE_USERS.tenantManager.name });
  assert.ok(approved.body.plan.approvedAt);
  assert.deepEqual(approved.body.supersededPlanIds, []);
  assertNoAiAttribution(assert, approved.body);

  const { plan: second } = await harness.draft();
  const { plan: third } = await harness.draft();
  const notLatest = await harness.as('projectAdmin').post(`/plans/${second.id}/approve`, { revision: second.revision });
  assert.equal(notLatest.status, 409);
  assert.equal(notLatest.body.details.code, 'plan_not_latest');

  const latest = await harness.approve(third, { role: 'projectAdmin' });
  assert.deepEqual(latest.supersededPlanIds.sort(), [first.id, second.id].sort());
  assert.equal(latest.plan.owner.name, ROLE_USERS.projectAdmin.name);
  const listed = await harness.as('viewer').get('/plans?track=experience');
  assert.deepEqual(listed.body.plans.map((plan) => [plan.version, plan.status, plan.owner?.name ?? null]), [
    [3, 'approved', ROLE_USERS.projectAdmin.name],
    [2, 'superseded', null],
    [1, 'superseded', ROLE_USERS.tenantManager.name],
  ]);
  const overview = await harness.as('viewer').get('/');
  assert.equal(overview.body.tracks.experience.stages.plan.state, 'approved');
  assert.equal(overview.body.tracks.experience.stages.plan.latestPlan.version, 3);

  assert.equal((await harness.as('projectAdmin').post(`/plans/${first.id}/approve`, { revision: 1 })).body.details.code, 'plan_superseded');
  assert.equal((await harness.as('projectAdmin').post(`/plans/${third.id}/approve`, { revision: 1 })).body.details.code, 'plan_already_approved');
  assert.equal((await harness.as('projectAdmin').post('/plans/missing-plan/approve', { revision: 1 })).status, 404);

  // A draft that cites a decision superseded after drafting cannot be approved.
  const { plan: fourth } = await harness.draft();
  await harness.decide(topics.home.id, { statement: 'Booking and rescheduling share the home screen.', supersedesId: decisions.first.id });
  const refreshed = await harness.as('viewer').get(`/plans/${fourth.id}`);
  assert.deepEqual(refreshed.body.plan.staleDecisionIds, [decisions.first.id]);
  assert.equal(refreshed.body.plan.decisions.find((decision) => decision.id === decisions.first.id).status, 'superseded');
  const blocked = await harness.as('projectManager').post(`/plans/${fourth.id}/approve`, { revision: refreshed.body.plan.revision });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.code, 'plan_cites_superseded_decisions');
  assert.deepEqual(blocked.body.details.staleDecisionIds, [decisions.first.id]);

  // People may keep a stale citation while editing; it stays flagged instead of blocking the save.
  const kept = await harness.as('editor').patch(`/plans/${fourth.id}`, { objective: 'Still editing', revision: refreshed.body.plan.revision });
  assert.equal(kept.status, 200);
  const resent = await harness.as('editor').patch(`/plans/${fourth.id}`, { criteria: refreshed.body.plan.criteria, revision: kept.body.plan.revision });
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  assert.deepEqual(resent.body.plan.staleDecisionIds, [decisions.first.id]);
});

test('permissions: viewers read, plan.edit drafts and edits, only admins and managers approve', async () => {
  const harness = await createPlansTestApp();
  await harness.seedDecisions();
  const { plan } = await harness.draft();
  const routes = [
    ['get', '/plans'],
    ['get', `/plans/${plan.id}`],
    ['post', '/plans/experience/draft'],
    ['patch', `/plans/${plan.id}`, { objective: 'Edit', revision: 1 }],
    ['post', `/plans/${plan.id}/approve`, {}],
    ['post', `/plans/${plan.id}/propose-work`],
  ];
  const expect = {
    outsider: [404, 404, 404, 404, 404, 404],
    viewer: [200, 200, 404, 404, 404, 404],
    member: [200, 200, 404, 404, 404, 404],
    user: [200, 200, 404, 404, 404, 404],
  };
  for (const [role, statuses] of Object.entries(expect)) {
    for (const [index, [method, path, body]] of routes.entries()) {
      const response = await harness.as(role)[method](path, body);
      assert.equal(response.status, statuses[index], `${role} ${method.toUpperCase()} ${path}`);
    }
  }

  const drafted = await harness.as('editor').post('/plans/experience/draft');
  assert.equal(drafted.status, 201);
  const latest = drafted.body.plan;
  const contributed = await harness.as('contributor').patch(`/plans/${latest.id}`, { objective: 'Contributor edit', revision: 1 });
  assert.equal(contributed.status, 200);
  assert.equal((await harness.as('editor').post(`/plans/${latest.id}/approve`, {})).status, 404);
  assert.equal((await harness.as('tenantAdmin').post(`/plans/${latest.id}/approve`, { revision: contributed.body.plan.revision })).status, 200);
  assert.equal((await harness.as('viewer').get('/plans/not-a-plan')).status, 404);
});

test('plan changes publish requirements.plans.invalidated on the project channel only', async () => {
  const harness = await createPlansTestApp();
  await harness.seedDecisions();
  const stakeholder = await harness.seedStakeholder();
  const link = await harness.createLink(stakeholder.id);
  const project = harness.recordEvents(`project:${PROJECT_ID}`);
  const portal = harness.recordEvents(`public-requirements:${link.link.id}`);

  const { plan } = await harness.draft();
  const edited = (await harness.as('editor').patch(`/plans/${plan.id}`, { objective: 'Edited', revision: 1 })).body.plan;
  const { plan: approved } = await harness.approve(edited);
  await harness.proposeWork(approved);

  assert.deepEqual(planEvents(project).map((event) => [event.reason, event.planId, event.track]), [
    ['plan-drafted', plan.id, 'experience'],
    ['plan-edited', plan.id, 'experience'],
    ['plan-approved', plan.id, 'experience'],
    ['work-proposed', plan.id, 'experience'],
  ]);
  assert.equal(planEvents(project)[0].actor.id, ROLE_USERS.editor.id);
  assert.deepEqual(portal.events.filter((event) => event.type === REQUIREMENTS_PLAN_EVENT), [], 'client portals never get plan events');
});

test('approval approves only the revision it checked: an edit or a supersede landing after the checks is a conflict', async () => {
  const harness = await createPlansTestApp();
  const { decisions, topics } = await harness.seedDecisions();
  const { plan } = await harness.draft();

  const unnamed = await harness.as('projectManager').post(`/plans/${plan.id}/approve`, {});
  assert.equal(unnamed.status, 400, 'the approver names the revision they reviewed');

  // A legitimate edit that removes every criterion lands between the service's checks and
  // the repository's approval.
  const plans = harness.app.locals.plansRepository;
  const approvePlan = plans.approvePlan;
  plans.approvePlan = async (args) => {
    plans.approvePlan = approvePlan;
    await plans.updateDraft({
      expectedRevision: plan.revision, now: new Date(), patch: { criteria: [] }, planId: plan.id, projectId: PROJECT_ID, tenantId: TENANT_ID, updatedBy: `user:${ROLE_USERS.editor.id}`,
    });
    return approvePlan(args);
  };
  const edited = await harness.as('projectManager').post(`/plans/${plan.id}/approve`, { revision: plan.revision });
  assert.equal(edited.status, 409, JSON.stringify(edited.body));
  assert.equal(edited.body.details.code, 'plan_revision_conflict');
  const afterEdit = (await harness.as('viewer').get(`/plans/${plan.id}`)).body.plan;
  assert.deepEqual([afterEdit.status, afterEdit.criteria.length, afterEdit.owner], ['draft', 0, null]);

  // A cited decision is superseded in the same gap.
  const { plan: next } = await harness.draft();
  assert.ok(next.decisions.some((decision) => decision.id === decisions.first.id), 'the draft cites the decision');
  plans.approvePlan = async (args) => {
    plans.approvePlan = approvePlan;
    await harness.decide(topics.home.id, { statement: 'Booking and rescheduling share the home screen.', supersedesId: decisions.first.id });
    return approvePlan(args);
  };
  const superseded = await harness.as('projectManager').post(`/plans/${next.id}/approve`, { revision: next.revision });
  assert.equal(superseded.status, 409, JSON.stringify(superseded.body));
  assert.equal(superseded.body.details.code, 'plan_cites_superseded_decisions');
  assert.deepEqual(superseded.body.details.staleDecisionIds, [decisions.first.id]);
  assert.equal((await harness.as('viewer').get(`/plans/${next.id}`)).body.plan.status, 'draft');
});
