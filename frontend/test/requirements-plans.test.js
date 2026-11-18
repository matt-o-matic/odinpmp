import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiClient } from '../src/lib/api/client.js';
import { AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS } from '../src/lib/assistant/assistant-capabilities.js';
import {
  REQUIREMENTS_EVENT_TYPES,
  batchNeedsSharedRefresh,
  batchTouchesPlans,
  batchTouchesTopic,
  batchTouchesTopicList,
  mergeRequirementsEvent,
} from '../src/lib/requirements/requirements-live-updates.js';
import { canEditPlans, requirementsAbilities } from '../src/lib/requirements/requirements-permissions.js';
import {
  approvedPlan,
  citationChips,
  citationText,
  decisionLabelMap,
  decisionRows,
  describeApproveError,
  describeDraftError,
  describeEditError,
  describeProposeError,
  droppedNote,
  historyRows,
  latestPlan,
  ownerLine,
  parseDecisionRefs,
  planActions,
  planEditErrors,
  planEditForm,
  planEditPayload,
  planHeading,
  planStatusChip,
  planTitle,
  proposedWorkGroups,
  reviewLinkLocation,
  selectPlan,
  staleNotice,
  workCountsText,
} from '../src/lib/requirements/requirements-plans.js';

const now = new Date(2026, 9, 7, 12, 0);

function decision(id, decidedAt, extra = {}) {
  return { decidedAt: new Date(2026, 9, decidedAt).toISOString(), decidedBy: { name: 'Morgan Lee' }, id, kind: 'topic', outcome: 'agreed', sources: [], status: 'active', statement: id, track: 'experience', ...extra };
}

const decisions = [
  decision('old', 1, { status: 'superseded', supersededById: 'new' }),
  decision('pref', 2, { kind: 'preference', preference: { dimension: 'hierarchy', stance: 'keep' } }),
  decision('round', 3, { kind: 'round' }),
  decision('new', 4, { supersedesId: 'old' }),
  decision('defer', 5, { outcome: 'deferred' }),
];

const approved = {
  approvedAt: new Date(2026, 9, 7, 9).toISOString(),
  basedOn: null,
  createdAt: new Date(2026, 9, 6).toISOString(),
  criteria: [{ decisionIds: ['new'], id: 'AC-E1', scenario: 'Book in two minutes.' }],
  decisions: [{ id: 'new', label: 'D-04', status: 'active' }, { id: 'pref', label: 'D-02', status: 'active' }],
  id: 'p2',
  nonGoals: [],
  objective: 'Fast booking.',
  owner: { id: 'u1', name: 'Morgan Lee' },
  revision: 3,
  scope: [{ decisionIds: ['new', 'pref'], text: 'Home screen.' }],
  staleDecisionIds: [],
  status: 'approved',
  track: 'experience',
  version: 2,
};
const draft = {
  ...approved,
  approvedAt: null,
  basedOn: { id: 'p2', version: 2 },
  criteria: [{ decisionIds: ['old'], id: 'AC-E1', scenario: 'x' }],
  decisions: [{ id: 'old', label: 'D-01', status: 'superseded' }],
  id: 'p3',
  owner: null,
  revision: 1,
  staleDecisionIds: ['old'],
  status: 'draft',
  version: 3,
};
const superseded = { ...approved, id: 'p1', status: 'superseded', version: 1 };
const plans = [superseded, draft, approved];

function apiError(status, data) {
  return Object.assign(new Error(data.error ?? 'x'), { data, status });
}

test('versions: newest first, the latest shown unless one is asked for, and the approved one', () => {
  assert.equal(latestPlan(plans).id, 'p3');
  assert.equal(approvedPlan(plans).id, 'p2');
  assert.equal(selectPlan(plans, '').id, 'p3');
  assert.equal(selectPlan(plans, 'p1').id, 'p1');
  assert.equal(selectPlan(plans, 'missing').id, 'p3');
  assert.equal(selectPlan([], ''), null);
  assert.equal(planHeading(approved), 'Experience plan · v2');
  assert.equal(planTitle(approved), 'Experience plan v2');
  assert.deepEqual(planStatusChip('approved'), { label: 'Approved', tone: 'ok' });
  assert.deepEqual(planStatusChip('superseded'), { label: 'Superseded', tone: 'outline' });
  assert.deepEqual(historyRows(plans, { locale: 'en-US', selectedId: 'p3' }).map((row) => [row.version, row.chip.label, row.meta, row.selected]), [
    [3, 'Draft', 'created Oct 6 · edited from v2', true],
    [2, 'Approved', 'Morgan Lee · approved Oct 7', false],
    [1, 'Superseded', 'Morgan Lee · approved Oct 7', false],
  ]);
});

test('the owner is the approver; a draft has no owner and no AI tag', () => {
  assert.deepEqual(ownerLine(approved, { now }), { approvedText: 'approved today', name: 'Morgan Lee', text: 'Owner: Morgan Lee · approved today' });
  assert.deepEqual(ownerLine(draft, { now }), { approvedText: '', name: '', text: 'Draft · not approved yet' });
  for (const value of [ownerLine(approved, { now }).text, ownerLine(draft, { now }).text]) assert.doesNotMatch(value, /\bAI\b|Odin/);
});

test('decision rows: plan inputs only, active first, superseded with what replaced them, stale citations flagged', () => {
  const labels = decisionLabelMap(decisions);
  assert.equal(labels.get('old'), 'D-01');
  assert.equal(labels.get('round'), 'D-03', 'round decisions take a label, as the API counts them');
  assert.equal(labels.get('defer'), 'D-05');
  const model = decisionRows(decisions, draft);
  assert.deepEqual(model.rows.map((row) => [row.label, row.chip.label, row.superseded, row.cited, row.stale]), [
    ['D-05', 'Deferred', false, false, false],
    ['D-04', 'Agreed', false, false, false],
    ['D-02', 'Preference · keep', false, false, false],
    ['D-01', 'Superseded', true, true, true],
  ]);
  assert.equal(model.rows[1].supersedesLabel, 'D-01');
  assert.equal(model.rows[3].supersededByLabel, 'D-04');
  assert.equal(model.countsText, '2 decisions · 1 preference');
});

test('citation chips use the plan’s labels and flag superseded or missing decisions', () => {
  const labels = decisionLabelMap(decisions);
  assert.deepEqual(citationChips(['new', 'pref'], { labels, plan: approved }).map((chip) => [chip.label, chip.state]), [['D-04', 'active'], ['D-02', 'active']]);
  assert.deepEqual(citationChips(['old'], { labels, plan: draft }), [{ ariaLabel: 'Decision D-01, superseded', id: 'old', label: 'D-01', state: 'superseded' }]);
  assert.equal(citationChips(['gone'], { labels, plan: { decisions: [{ id: 'gone', label: null, status: 'missing' }] } })[0].ariaLabel, 'Decision Decision, no longer exists');
  assert.equal(citationText(['defer', 'new'], { labels }), 'D-05, D-04');
  assert.equal(staleNotice(draft, { labels }), 'This plan cites a decision that was superseded (D-01). Update that citation before approving.');
  assert.equal(staleNotice(approved, { labels }), '');
});

test('actions follow capabilities and plan state: edit the latest, approve the latest draft, propose from approved', () => {
  const manager = requirementsAbilities({ canDecide: true, projectRole: 'manager' });
  const contributor = requirementsAbilities({ canDecide: false, projectRole: 'contributor' });
  const member = requirementsAbilities({ canDecide: false, projectRole: 'member' });

  const onDraft = planActions({ abilities: manager, plan: draft, plans });
  assert.deepEqual(onDraft.edit, { createsVersion: null, label: 'Edit' });
  assert.deepEqual(onDraft.approve, { disabled: true, label: 'Approve', reason: 'Update the citations to superseded decisions before approving.' });
  assert.equal(onDraft.proposeWork, null);
  assert.deepEqual(onDraft.draft, { label: 'Redraft from decisions' });

  const fresh = { ...draft, staleDecisionIds: [] };
  assert.equal(planActions({ abilities: manager, plan: fresh, plans: [superseded, fresh, approved] }).approve.disabled, false);
  assert.equal(planActions({ abilities: manager, plan: { ...fresh, criteria: [] }, plans: [{ ...fresh, criteria: [] }] }).approve.reason, 'Add at least one acceptance criterion before approving.');

  const onApprovedNotLatest = planActions({ abilities: manager, plan: approved, plans });
  assert.equal(onApprovedNotLatest.edit, null, 'only the latest version is edited');
  assert.deepEqual(onApprovedNotLatest.proposeWork, { label: 'Propose work' });
  assert.deepEqual(planActions({ abilities: manager, plan: approved, plans: [approved] }).edit, { createsVersion: 3, label: 'Edit as new draft' });
  assert.equal(planActions({ abilities: manager, plan: superseded, plans }).edit, null);

  assert.equal(planActions({ abilities: contributor, plan: draft, plans }).approve, null);
  assert.ok(planActions({ abilities: contributor, plan: draft, plans }).edit);
  assert.deepEqual(planActions({ abilities: member, plan: draft, plans }), { approve: null, draft: null, edit: null, proposeWork: null });
  assert.deepEqual(planActions({ abilities: manager, plan: null, plans: [] }).draft, { label: 'Draft plan' });
});

test('plan permissions: project.plan.edit roles and decision rights', () => {
  assert.equal(canEditPlans({ projectRole: 'member' }), false);
  assert.equal(canEditPlans({ projectRole: 'user' }), false);
  assert.equal(canEditPlans({ projectRole: '' }), false);
  assert.equal(canEditPlans({ projectRole: 'editor' }), true);
  assert.equal(canEditPlans({ projectRole: 'viewer', tenantRole: 'manager' }), true);
  assert.equal(canEditPlans({ canDecide: true }), true);
  const viewer = requirementsAbilities({ projectRole: 'viewer' });
  assert.deepEqual([viewer.editPlans, viewer.approvePlans, viewer.proposeWork], [false, false, false]);
});

test('draft errors: not configured, no decisions, uncited, retryable failures', () => {
  assert.deepEqual(
    describeDraftError(apiError(503, { details: { code: 'ai_not_configured' }, error: 'ai_not_configured' })),
    { code: 'ai_not_configured', message: 'Odin can’t draft plans because no AI provider is set up for this workspace. A workspace admin can add one in the AI settings.', retryable: false },
  );
  const none = describeDraftError(apiError(409, { details: { code: 'no_decisions', message: 'x' }, error: 'no_decisions' }));
  assert.equal(none.decideLink, true);
  assert.equal(none.retryable, false);
  assert.equal(describeDraftError(apiError(502, { details: { code: 'plan_output_uncited', retryable: true }, error: 'plan_output_uncited' })).retryable, true);
  assert.equal(describeDraftError(apiError(502, { details: { code: 'ai_output_invalid', retryable: true }, error: 'ai_output_invalid' })).message, 'Odin couldn’t draft the plan, so nothing changed. Try again.');
  assert.equal(describeDraftError(apiError(409, { details: { code: 'plan_not_latest' }, error: 'plan_not_latest' })).reload, true);
});

test('edit errors: per-item citation issues, revision conflicts, and stale versions', () => {
  const invalid = describeEditError(apiError(400, {
    details: { code: 'invalid_plan_edit', issues: [
      { index: 0, reason: 'unknown-decision', ref: 'D-99', section: 'scope' },
      { index: 1, reason: 'inactive-decision', ref: 'D-01', section: 'criteria' },
      { index: 2, reason: 'duplicate-criterion-id', ref: 'AC-E1', section: 'criteria' },
      { index: 0, reason: 'invalid-criterion-id', ref: 'AC-X', section: 'criteria' },
    ] },
    error: 'invalid_plan_edit',
  }));
  assert.deepEqual(invalid.issues.map((issue) => issue.message), [
    'Scope item 1: D-99 isn’t a decision in this track.',
    'Acceptance criterion 2: D-01 was superseded. Cite the decision that replaced it.',
    'Acceptance criterion 3: AC-E1 is used twice.',
    'Acceptance criterion 1: AC-X isn’t a valid criterion id for this track.',
  ]);
  const conflict = describeEditError(apiError(409, { details: { code: 'plan_revision_conflict', currentRevision: 4 }, error: 'plan_revision_conflict' }));
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reload, true);
  assert.equal(describeEditError(apiError(409, { details: { code: 'plan_not_latest' }, error: 'plan_not_latest' })).reload, true);
  assert.equal(describeEditError(apiError(409, { details: { code: 'plan_superseded' }, error: 'plan_superseded' })).reload, true);
  assert.equal(describeEditError(apiError(400, { details: [{ message: 'Too small', path: 'scope.0.text' }], error: 'Invalid request.' })).code, 'invalid_request');
});

test('approve and propose errors are explained', () => {
  const labels = decisionLabelMap(decisions);
  assert.equal(
    describeApproveError(apiError(409, { details: { code: 'plan_cites_superseded_decisions', staleDecisionIds: ['old'] }, error: 'plan_cites_superseded_decisions' }), { labels, plan: draft }).message,
    'This plan cites decisions that were superseded (D-01). Edit those citations, then approve.',
  );
  assert.equal(describeApproveError(apiError(409, { details: { code: 'plan_incomplete' }, error: 'plan_incomplete' })).message, 'This plan has no acceptance criteria. Add at least one before approving.');
  assert.equal(describeApproveError(apiError(404, { error: 'Project not found.' })).message, 'Only project or workspace admins and managers can approve plans.');
  assert.equal(describeProposeError(apiError(409, { details: { code: 'plan_work_applied' }, error: 'plan_work_applied' })).retryable, false);
  assert.equal(describeProposeError(apiError(409, { details: { code: 'plan_not_approved' }, error: 'plan_not_approved' })).message, 'Approve this plan before proposing work from it.');
  assert.equal(describeProposeError(apiError(502, { details: { code: 'work_output_uncited', retryable: true }, error: 'work_output_uncited' })).retryable, true);
  assert.equal(describeProposeError(apiError(503, { details: { code: 'ai_not_configured' }, error: 'ai_not_configured' })).code, 'ai_not_configured');
});

test('the dropped note counts left-out items and removed citations', () => {
  assert.equal(droppedNote([]), '');
  assert.equal(droppedNote([
    { reason: 'uncited', what: 'item' },
    { reason: 'uncited', what: 'item' },
    { reason: 'inactive-decision', what: 'citation' },
  ]), 'Odin left out 2 items that didn’t cite a recorded decision and removed 1 citation to decisions a plan can’t build on.');
  assert.equal(droppedNote([{ what: 'citation' }]), 'Odin removed 1 citation to decisions a plan can’t build on.');
});

test('the edit form round-trips citations as labels and checks blank items', () => {
  const labels = decisionLabelMap(decisions);
  const form = planEditForm(approved, { labels });
  assert.deepEqual(form.scope, [{ decisions: 'D-04, D-02', text: 'Home screen.' }]);
  assert.deepEqual(form.criteria, [{ decisions: 'D-04', id: 'AC-E1', scenario: 'Book in two minutes.' }]);
  assert.equal(form.revision, 3);
  assert.deepEqual(parseDecisionRefs(' D-04,d-2; D-04  D-7 '), ['D-04', 'd-2', 'D-7']);
  form.criteria.push({ decisions: 'D-05', id: '', scenario: '  New criterion. ' });
  form.nonGoals.push({ decisions: '', text: '' });
  assert.deepEqual(planEditErrors(form), [{ index: 0, message: 'Not in scope item 1: write it or remove it.', section: 'nonGoals' }]);
  form.nonGoals = [];
  assert.deepEqual(planEditPayload(form), {
    criteria: [{ decisionIds: ['D-04'], id: 'AC-E1', scenario: 'Book in two minutes.' }, { decisionIds: ['D-05'], id: '', scenario: 'New criterion.' }],
    nonGoals: [],
    objective: 'Fast booking.',
    revision: 3,
    scope: [{ decisionIds: ['D-04', 'D-02'], text: 'Home screen.' }],
  });
});

test('proposed work: mine first with the review link, others with status only', () => {
  const labels = decisionLabelMap(decisions);
  const groups = proposedWorkGroups([
    {
      counts: { applied: 1, dismissed: 0, pending: 1 },
      items: [
        { criteriaIds: ['AC-E1'], itemId: 'e1', kind: 'epic', parent: null, sourceDecisionIds: ['new', 'pref'], status: 'applied', storyCount: 2, title: 'Booking' },
        { criteriaIds: ['AC-E1'], itemId: 's1', kind: 'story', parent: { itemId: 'e1', title: 'Booking' }, sourceDecisionIds: ['new'], status: 'pending', storyCount: 0, title: 'Book' },
      ],
      mine: false,
      proposedAt: new Date(2026, 9, 7, 8).toISOString(),
      proposedBy: { id: 'u1', name: 'Morgan Lee' },
      reviewLink: { query: { assistant: '1', assistantSessionId: 'leaked' } },
    },
    {
      counts: { applied: 0, dismissed: 1, pending: 0 },
      items: [{ criteriaIds: ['AC-E2'], itemId: 's2', kind: 'story', parent: { itemId: 'existing', title: 'Pricing' }, sourceDecisionIds: ['defer'], status: 'dismissed', storyCount: 0, title: 'Price card' }],
      mine: true,
      proposedAt: new Date(2026, 9, 6).toISOString(),
      proposedBy: { id: 'me', name: 'Synthetic Demo' },
      reviewLink: { query: { assistant: '1', assistantSessionId: 'session-mine' } },
    },
  ], { labels, now, plan: approved });
  assert.deepEqual(groups.map((group) => [group.heading, group.countsText, Boolean(group.reviewLink)]), [
    ['Proposed by you · yesterday', '0 applied · 0 pending · 1 dismissed', true],
    ['Proposed by Morgan Lee · today', '1 applied · 1 pending · 0 dismissed', false],
  ]);
  assert.deepEqual(groups[1].items.map((item) => [item.kindLabel, item.meta, item.nested, item.chip.label]), [
    ['Epic', '2 stories · AC-E1 · D-04, D-02', false, 'Applied'],
    ['Story', 'AC-E1 · D-04', true, 'Pending review'],
  ]);
  assert.equal(groups[0].items[0].meta, 'under Pricing · AC-E2 · D-05');
  assert.equal(workCountsText({}), '0 applied · 0 pending · 0 dismissed');
  assert.deepEqual(
    reviewLinkLocation(groups[0].reviewLink, { name: 'project-requirements-track', params: { projectId: 'p', stage: 'plan', track: 'experience' }, query: { plan: 'p2' } }),
    { name: 'project-requirements-track', params: { projectId: 'p', stage: 'plan', track: 'experience' }, query: { assistant: '1', assistantSessionId: 'session-mine', plan: 'p2' } },
  );
  assert.equal(reviewLinkLocation(null, {}), null);
});

test('plan events refresh the plan stage, not topic pages; review-only batches skip the shared reload', () => {
  const { plans: plansType, review, rounds, decisions: decisionsType, topics } = REQUIREMENTS_EVENT_TYPES;
  assert.equal(plansType, 'requirements.plans.invalidated');
  const planBatch = mergeRequirementsEvent(null, { data: { planId: 'p3', reason: 'plan-approved', track: 'experience', version: 3 }, type: plansType });
  assert.equal(batchTouchesPlans(planBatch, 'experience'), true);
  assert.equal(batchTouchesPlans(planBatch, 'architecture'), false);
  assert.equal(batchTouchesTopic(planBatch, 't1'), false);
  assert.equal(batchTouchesTopicList(planBatch, 'experience'), false);
  assert.equal(batchTouchesPlans(mergeRequirementsEvent(null, { data: { track: 'experience' }, type: decisionsType }), 'experience'), true, 'a superseded decision can make citations stale');
  assert.equal(batchTouchesPlans(mergeRequirementsEvent(null, { data: { track: 'experience' }, type: topics }), 'experience'), false);
  assert.equal(batchTouchesPlans({ reconnected: true, topicIds: [], tracks: [], types: [] }, 'experience'), true);

  let saves = null;
  for (let index = 0; index < 3; index += 1) saves = mergeRequirementsEvent(saves, { data: { roundId: 'r2', track: 'experience' }, type: review });
  assert.equal(batchNeedsSharedRefresh(saves), false);
  assert.equal(batchNeedsSharedRefresh(mergeRequirementsEvent(saves, { data: { roundId: 'r2', track: 'experience' }, type: rounds })), true);
  for (const type of [topics, decisionsType, plansType, REQUIREMENTS_EVENT_TYPES.packages, REQUIREMENTS_EVENT_TYPES.links, REQUIREMENTS_EVENT_TYPES.summary]) {
    assert.equal(batchNeedsSharedRefresh(mergeRequirementsEvent(null, { data: {}, type })), true, type);
  }
  assert.equal(batchNeedsSharedRefresh({ reconnected: true, topicIds: [], tracks: [], types: [] }), true);
  assert.equal(batchNeedsSharedRefresh(null), false);
});

test('plans API methods follow the plans routes, and the plan model appears in the admin AI settings', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : undefined, method: options.method, url: String(url).replace('http://localhost:3001', '') });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  try {
    const client = createApiClient({ baseUrl: 'http://localhost:3001' });
    await client.listRequirementsPlans('p1', 'experience', 'token');
    await client.getRequirementsPlan('p1', 'plan/3', 'token');
    await client.draftRequirementsPlan('p1', 'architecture', 'token');
    await client.updateRequirementsPlan('p1', 'plan-3', { revision: 2 }, 'token');
    await client.approveRequirementsPlan('p1', 'plan-3', { revision: 2 }, 'token');
    await client.proposeRequirementsPlanWork('p1', 'plan-3', 'token');
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/projects/p1/requirements/plans?track=experience',
    'GET /api/projects/p1/requirements/plans/plan%2F3',
    'POST /api/projects/p1/requirements/plans/architecture/draft',
    'PATCH /api/projects/p1/requirements/plans/plan-3',
    'POST /api/projects/p1/requirements/plans/plan-3/approve',
    'POST /api/projects/p1/requirements/plans/plan-3/propose-work',
  ]);
  assert.deepEqual(calls[4].body, { revision: 2 });
  const plan = AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS.find((definition) => definition.id === 'requirementsPlan');
  assert.equal(plan.label, 'Requirements Plan');
  assert.deepEqual(plan.tools, ['project_context']);
});
