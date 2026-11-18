// Synthetic track-plans API for browser acceptance (U6d). Install it after
// installRequirementsApi(): these handlers answer /requirements/plans and everything else
// falls back to the shared fixture, whose decisions this one reads and writes. Response
// shapes follow backend/src/modules/requirements/plans/plans.service.js (presentPlan,
// proposed work, conflicts). All people, plans, and work items here are synthetic.

import { defaultRequirementsScenario } from './requirements-api.js';
import { syntheticProject, syntheticUser } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';
const BASE = `/api/projects/${syntheticProject.id}/requirements`;
const PLAN_EDIT_ROLES = new Set(['admin', 'contributor', 'editor', 'manager']);

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

const MORGAN = { id: 'user-morgan', name: 'Morgan Lee', ref: 'user:user-morgan', type: 'user' };

function decision(overrides) {
  return {
    chain: [], decidedBy: MORGAN, kind: 'topic', outcome: 'agreed', preference: null, sources: [], status: 'active',
    supersededById: null, supersedesId: null, topic: null, topicId: null, track: 'experience', version: 1, ...overrides,
  };
}

/**
 * The Experience track's decisions, oldest first (labels D-01 ... D-07 follow decision time):
 * D-01 superseded by D-04; D-02, D-03 preferences; D-05 deferred; D-06 a round decision.
 */
function planDecisions() {
  return [
    decision({ decidedAt: minutesAgo(9000), id: 'dec-home-1', outcome: 'decided', statement: 'Booking sits second, after the visit history.', status: 'superseded', supersededById: 'dec-home-2', topic: { id: 'topic-home', prompt: 'Is booking the first task on the home screen?' }, topicId: 'topic-home' }),
    decision({ decidedAt: minutesAgo(8000), id: 'dec-pref-action', kind: 'preference', preference: { dimension: 'hierarchy', stance: 'keep' }, sources: ['annotation:a1', 'verdict:v1'], statement: 'One primary "Book a visit" action on the home screen.' }),
    decision({ decidedAt: minutesAgo(7000), id: 'dec-pref-slots', kind: 'preference', preference: { dimension: 'behavior', stance: 'change' }, statement: 'Unavailable slots read as "fully booked", not as buttons.' }),
    decision({ chain: ['dec-home-1'], decidedAt: minutesAgo(6000), id: 'dec-home-2', sources: ['comment:a', 'comment:b'], statement: 'Booking is the first task on the home screen.', supersedesId: 'dec-home-1', topic: { id: 'topic-home', prompt: 'Is booking the first task on the home screen?' }, topicId: 'topic-home' }),
    decision({ decidedAt: minutesAgo(5000), decidedBy: { id: 'user-sam', name: 'Sam Patel', ref: 'user:user-sam', type: 'user' }, id: 'dec-sms', outcome: 'deferred', statement: 'SMS reminders wait for phase 2; email only in phase 1.', topic: { id: 'topic-reminder', prompt: 'Do clients want reminders by email, text, or both?' }, topicId: 'topic-reminder' }),
    decision({ decidedAt: minutesAgo(4000), id: 'dec-round-1', kind: 'round', outcome: 'decided', statement: 'Round 1: Changes requested.' }),
    decision({ decidedAt: minutesAgo(600), id: 'dec-price', sources: ['comment:comment-price-2', 'comment:comment-price-3', 'comment:comment-price-4', 'comment:x'], statement: 'Show a price range before tax on home; confirm the exact price with tax before payment.', topic: { id: 'topic-price', prompt: 'Should clients see an estimated price before they pick a time?' }, topicId: 'topic-price' }),
  ];
}

function planContent() {
  return {
    criteria: [
      { decisionIds: ['dec-home-2'], id: 'AC-E1', scenario: 'A new client books a standard visit from the home screen in under 2 minutes in moderated testing (5 of 5 participants).' },
      { decisionIds: ['dec-price'], id: 'AC-E2', scenario: 'The home screen shows a price range labeled "before tax" for every bookable service.' },
      { decisionIds: ['dec-pref-slots'], id: 'AC-E3', scenario: 'Fully booked slots cannot receive focus or clicks and are announced as "fully booked".' },
    ],
    nonGoals: [{ decisionIds: ['dec-sms'], text: 'SMS reminders.' }],
    objective: 'Clients book a home visit in under two minutes and always know the price range before they commit.',
    scope: [
      { decisionIds: ['dec-home-2', 'dec-pref-action'], text: 'Home screen with one primary booking action and the next visit.' },
      { decisionIds: ['dec-pref-slots'], text: 'One-screen day and time picker; unavailable slots marked "fully booked".' },
      { decisionIds: ['dec-price'], text: 'Price range before tax on home; exact price with tax before payment.' },
    ],
  };
}

function storedPlan({ approvedAt = null, basedOnId = null, content = planContent(), id, owner = null, status, version }) {
  return {
    approvedAt, basedOnId, content, createdAt: minutesAgo(10_000 - version * 1000), id, owner, revision: 1, status,
    supersededAt: status === 'superseded' ? minutesAgo(3000) : null, track: 'experience', updatedAt: minutesAgo(10_000 - version * 1000), version,
  };
}

/**
 * Plans for the Experience track. `latest`: 'draft' (v3 draft edited from approved v2, the
 * default), 'approved' (v2 approved is the latest), or 'none'.
 */
export function plansScenario({ latest = 'draft' } = {}) {
  const scenario = defaultRequirementsScenario();
  scenario.decisions = planDecisions();
  scenario.proposedPreferences = [];
  const v1Content = planContent();
  v1Content.criteria = v1Content.criteria.slice(0, 1).map((criterion) => ({ ...criterion, decisionIds: ['dec-home-1'] }));
  const plans = [
    storedPlan({ approvedAt: minutesAgo(8500), content: v1Content, id: 'plan-1', owner: MORGAN, status: 'superseded', version: 1 }),
    storedPlan({ approvedAt: minutesAgo(5), id: 'plan-2', owner: MORGAN, status: 'approved', version: 2 }),
  ];
  if (latest === 'draft') {
    const draft = planContent();
    draft.criteria.push({ decisionIds: ['dec-pref-action'], id: 'AC-E4', scenario: 'The home screen has exactly one primary button, "Book a visit".' });
    plans.push(storedPlan({ basedOnId: 'plan-2', content: draft, id: 'plan-3', status: 'draft', version: 3 }));
  }
  scenario.plansState = {
    draftMode: 'ok',
    plans: latest === 'none' ? [] : plans,
    proposals: latest === 'none' ? [] : [{
      items: [
        { acceptanceCriteria: [], actionId: 'action-m1', criteriaIds: ['AC-E1'], itemId: 'epic-m1', kind: 'epic', parent: null, sourceDecisionIds: ['dec-home-2', 'dec-pref-action'], status: 'applied', storyCount: 2, title: 'Booking from home' },
        { acceptanceCriteria: [], actionId: 'action-m1', criteriaIds: ['AC-E1'], itemId: 'story-m1', kind: 'story', parent: { existing: false, itemId: 'epic-m1', kind: 'epic', title: 'Booking from home' }, sourceDecisionIds: ['dec-home-2'], status: 'applied', storyCount: 0, title: 'Book from the home screen' },
        { acceptanceCriteria: [], actionId: 'action-m2', criteriaIds: ['AC-E3'], itemId: 'story-m2', kind: 'story', parent: { existing: true, itemId: 'epic-existing', kind: 'epic', title: 'Scheduling' }, sourceDecisionIds: ['dec-pref-slots'], status: 'pending', storyCount: 0, title: 'Fully booked slot state' },
        { acceptanceCriteria: [], actionId: 'action-m3', criteriaIds: ['AC-E2'], itemId: 'story-m3', kind: 'story', parent: { existing: true, itemId: 'epic-existing-2', kind: 'epic', title: 'Pricing' }, sourceDecisionIds: ['dec-price'], status: 'dismissed', storyCount: 0, title: 'Price range card' },
      ],
      planId: 'plan-2',
      proposedAt: minutesAgo(3),
      proposedBy: { id: 'user-morgan', name: 'Morgan Lee' },
      sessionId: 'session-morgan',
    }],
    proposeMode: 'ok',
  };
  scenario.plans = [];
  return scenario;
}

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function conflict(route, code, message, details = {}) {
  return json(route, { details: { code, message, ...details }, error: code, ok: false }, 409);
}

function notFound(route) {
  return json(route, { error: 'Project not found.', ok: false }, 404);
}

/** Same labels as the API: every decision in the track, by decision time. */
function labelMap(decisions, track) {
  const sorted = decisions
    .filter((entry) => entry.track === track)
    .sort((left, right) => String(left.decidedAt).localeCompare(String(right.decidedAt)) || String(left.id).localeCompare(String(right.id)));
  return new Map(sorted.map((entry, index) => [entry.id, `D-${String(index + 1).padStart(2, '0')}`]));
}

const isActive = (entry) => Boolean(entry) && entry.status !== 'superseded' && !entry.supersededById && entry.outcome !== 'superseded';

export async function installRequirementsPlansApi(page, requirements) {
  const base = requirements.state;
  const state = base.plansState ?? { draftMode: 'ok', plans: [], proposals: [], proposeMode: 'ok' };
  base.plansState = state;
  const calls = [];
  let counter = 0;

  const canEdit = () => base.canDecide || PLAN_EDIT_ROLES.has(base.projectRole);
  const decisionsOf = (track) => base.decisions.filter((entry) => entry.track === track);

  function cited(plan) {
    const ids = [];
    for (const item of [...plan.content.scope, ...plan.content.nonGoals, ...plan.criteria]) {
      for (const id of item.decisionIds) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  function present(plan, { withWork = false } = {}) {
    const labels = labelMap(base.decisions, plan.track);
    const byId = new Map(base.decisions.map((entry) => [entry.id, entry]));
    const ids = cited({ content: plan.content, criteria: plan.content.criteria });
    const basedOn = plan.basedOnId ? state.plans.find((entry) => entry.id === plan.basedOnId) : null;
    const result = {
      approvedAt: plan.approvedAt,
      basedOn: basedOn ? { id: basedOn.id, version: basedOn.version } : null,
      body: '',
      createdAt: plan.createdAt,
      criteria: structuredClone(plan.content.criteria),
      decisions: ids.map((id) => {
        const entry = byId.get(id) ?? null;
        return { id, kind: entry?.kind ?? null, label: labels.get(id) ?? null, outcome: entry?.outcome ?? null, statement: entry?.statement ?? '', status: !entry ? 'missing' : isActive(entry) ? 'active' : 'superseded', topicId: entry?.topicId ?? null };
      }),
      id: plan.id,
      nonGoals: structuredClone(plan.content.nonGoals),
      objective: plan.content.objective,
      owner: plan.owner ? { id: plan.owner.id, name: plan.owner.name } : null,
      revision: plan.revision,
      scope: structuredClone(plan.content.scope),
      staleDecisionIds: ids.filter((id) => !isActive(byId.get(id))),
      status: plan.status,
      supersededAt: plan.supersededAt,
      title: `${plan.track === 'architecture' ? 'Functional' : 'Experience'} plan v${plan.version}`,
      track: plan.track,
      updatedAt: plan.updatedAt,
      version: plan.version,
    };
    if (withWork) {
      result.proposedWork = state.proposals.filter((record) => record.planId === plan.id).map((record) => {
        const counts = { applied: 0, dismissed: 0, pending: 0 };
        for (const item of record.items) counts[item.status] += 1;
        const mine = record.proposedBy.id === syntheticUser.id;
        return {
          counts,
          items: structuredClone(record.items),
          mine,
          proposedAt: record.proposedAt,
          proposedBy: { ...record.proposedBy },
          reviewLink: mine
            ? { actionIds: record.items.filter((item) => item.status === 'pending').map((item) => item.actionId), projectId: syntheticProject.id, query: { assistant: '1', assistantSessionId: record.sessionId }, sessionId: record.sessionId, surface: 'ai-workspace' }
            : null,
        };
      });
    }
    return result;
  }

  // The shared fixture's overview reads these rows for the Plan & work stage status.
  function syncShared() {
    base.plans = state.plans.map((plan) => ({ approvedAt: plan.approvedAt, id: plan.id, status: plan.status, track: plan.track, version: plan.version }));
  }
  syncShared();

  const latestOf = (track) => state.plans.filter((entry) => entry.track === track).sort((left, right) => right.version - left.version)[0] ?? null;

  function resolveRefs(values, track, { allow }) {
    const labels = labelMap(base.decisions, track);
    const idByLabel = new Map([...labels].map(([id, label]) => [label, id]));
    const ids = [];
    const issues = [];
    for (const value of values ?? []) {
      const raw = String(value).trim();
      const match = /^D-?0*(\d{1,4})$/i.exec(raw);
      const id = decisionsOf(track).some((entry) => entry.id === raw) ? raw : match ? idByLabel.get(`D-${match[1].padStart(2, '0')}`) : null;
      if (!id) {
        issues.push({ reason: 'unknown-decision', ref: raw });
        continue;
      }
      const verdict = allow(id);
      if (verdict !== true) {
        issues.push({ decisionId: id, reason: verdict, ref: raw });
        continue;
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return { ids, issues };
  }

  await page.route(`${API_ORIGIN}${BASE}/plans**`, async (route) => {
    try {
      return await handle(route);
    } catch (error) {
      // A fixture bug should fail loudly in the page, not leave the request hanging.
      return json(route, { error: `Synthetic plans fixture error: ${error.message}`, ok: false }, 500);
    }
  });

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(`${BASE}/plans`.length) || '/';
    const method = request.method();
    let body = null;
    if (['POST', 'PATCH'].includes(method)) {
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
    }
    calls.push({ body, method, path });
    requirements.calls.push({ body, method, path: `/plans${path === '/' ? '' : path}` });

    if (path === '/' && method === 'GET') {
      const track = url.searchParams.get('track');
      const plans = state.plans.filter((plan) => !track || plan.track === track).sort((left, right) => right.version - left.version);
      return json(route, { ok: true, plans: plans.map((plan) => present(plan)), track: track || null });
    }

    const draft = path.match(/^\/(experience|architecture)\/draft$/);
    if (draft && method === 'POST') {
      if (!canEdit()) return notFound(route);
      if (state.draftDelayMs) await new Promise((resolve) => setTimeout(resolve, state.draftDelayMs));
      const track = draft[1];
      if (state.draftMode === 'ai_not_configured') return json(route, { details: { code: 'ai_not_configured', message: 'Requirements AI is not configured.' }, error: 'ai_not_configured', ok: false }, 503);
      if (state.draftMode === 'ai_request_failed') return json(route, { details: { code: 'ai_request_failed', message: 'Odin could not finish this request. Nothing changed. Try again.', retryable: true }, error: 'ai_request_failed', ok: false }, 502);
      if (state.draftMode === 'plan_output_uncited') return json(route, { details: { code: 'plan_output_uncited', dropped: 3, message: 'x', retryable: true }, error: 'plan_output_uncited', ok: false }, 502);
      const inputs = decisionsOf(track).filter((entry) => isActive(entry) && ['topic', 'preference'].includes(entry.kind));
      if (inputs.length === 0 || state.draftMode === 'no_decisions') return conflict(route, 'no_decisions', 'Record decisions or accept preferences in this track before drafting its plan.');
      const latest = latestOf(track);
      const content = {
        criteria: inputs.slice(0, 3).map((entry, index) => ({ decisionIds: [entry.id], id: `AC-${track === 'architecture' ? 'A' : 'E'}${index + 1}`, scenario: `Delivers: ${entry.statement}` })),
        nonGoals: [],
        objective: 'Clients book a home visit in under two minutes and know the price range first.',
        scope: inputs.slice(0, 2).map((entry) => ({ decisionIds: [entry.id], text: entry.statement })),
      };
      const plan = { ...storedPlan({ content, id: `plan-drafted-${(counter += 1)}`, status: 'draft', version: (latest?.version ?? 0) + 1 }), createdAt: new Date().toISOString(), track, updatedAt: new Date().toISOString() };
      state.plans.push(plan);
      syncShared();
      return json(route, {
        dropped: state.draftDropped ?? [
          { index: 3, reason: 'uncited', section: 'scope', text: 'A loyalty program.', what: 'item' },
          { decisionId: 'dec-home-1', index: 0, reason: 'inactive-decision', ref: 'D-01', section: 'criteria', text: 'x', what: 'citation' },
        ],
        ok: true,
        plan: { ...present(plan), proposedWork: [] },
      }, 201);
    }

    const match = path.match(/^\/([^/]+)(\/approve|\/propose-work)?$/);
    const plan = match ? state.plans.find((entry) => entry.id === match[1]) : null;
    if (!plan) return json(route, { details: null, error: 'Plan not found.', ok: false }, 404);
    const action = match[2] ?? '';

    if (!action && method === 'GET') return json(route, { ok: true, plan: present(plan, { withWork: true }) });

    if (!action && method === 'PATCH') {
      if (!canEdit()) return notFound(route);
      if (state.editConflict) {
        state.editConflict = false;
        plan.revision += 1;
        plan.content.objective = 'Clients book a visit fast and know the price first. (edited by Morgan Lee)';
      }
      if (plan.status === 'superseded') return conflict(route, 'plan_superseded', 'This plan version was superseded by a newer approved version.');
      if (plan.revision !== body.revision) return conflict(route, 'plan_revision_conflict', 'This plan changed since you loaded it. Reload and try again.', { currentRevision: plan.revision });
      const grandfathered = new Set(cited({ content: plan.content, criteria: plan.content.criteria }));
      const byId = new Map(base.decisions.map((entry) => [entry.id, entry]));
      const allow = (id) => (isActive(byId.get(id)) || grandfathered.has(id) ? true : 'inactive-decision');
      const issues = [];
      const items = (section, entries, field) => (entries ?? []).map((entry, index) => {
        const resolved = resolveRefs(entry.decisionIds, plan.track, { allow });
        for (const issue of resolved.issues) issues.push({ ...issue, index, section });
        return { decisionIds: resolved.ids, [field]: String(entry[field]).trim() };
      });
      const content = {
        criteria: body.criteria !== undefined ? items('criteria', body.criteria, 'scenario') : plan.content.criteria,
        nonGoals: body.nonGoals !== undefined ? items('nonGoals', body.nonGoals, 'text') : plan.content.nonGoals,
        objective: body.objective !== undefined ? String(body.objective).trim() : plan.content.objective,
        scope: body.scope !== undefined ? items('scope', body.scope, 'text') : plan.content.scope,
      };
      if (body.criteria !== undefined) {
        const given = body.criteria.map((entry) => String(entry.id ?? '').trim().toUpperCase());
        let next = Math.max(0, ...given.map((id) => Number(/^AC-E(\d+)$/.exec(id)?.[1] ?? 0))) + 1;
        content.criteria = content.criteria.map((criterion, index) => ({ ...criterion, id: given[index] || `AC-E${next++}` }));
      }
      if (issues.length > 0) {
        return json(route, { details: { code: 'invalid_plan_edit', issues, message: 'Some citations or criterion ids in this plan are not valid. Fix them and save again.' }, error: 'invalid_plan_edit', ok: false }, 400);
      }
      const latest = latestOf(plan.track);
      if (plan.status === 'draft') {
        if (latest.id !== plan.id) return conflict(route, 'plan_not_latest', 'A newer version of this plan exists.', { latestPlanId: latest.id, latestVersion: latest.version });
        plan.content = content;
        plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        return json(route, { createdVersion: false, ok: true, plan: present(plan) });
      }
      if (latest.id !== plan.id) return conflict(route, 'plan_not_latest', 'A newer version of this plan exists.', { latestPlanId: latest.id, latestVersion: latest.version });
      const created = { ...storedPlan({ basedOnId: plan.id, content, id: `plan-edited-${(counter += 1)}`, status: 'draft', version: plan.version + 1 }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.plans.push(created);
      syncShared();
      return json(route, { createdVersion: true, ok: true, plan: present(created) });
    }

    if (action === '/approve' && method === 'POST') {
      if (!base.canDecide) return notFound(route);
      if (state.approveRace) {
        // Someone superseded a cited decision after the page loaded.
        state.approveRace = false;
        const target = base.decisions.find((entry) => entry.id === 'dec-pref-action');
        Object.assign(target, { status: 'superseded', supersededById: 'dec-price' });
      }
      if (plan.status !== 'draft') return plan.status === 'approved' ? conflict(route, 'plan_already_approved', 'This plan version is already approved.') : conflict(route, 'plan_superseded', 'This plan version was superseded.');
      if (plan.content.criteria.length === 0) return conflict(route, 'plan_incomplete', 'Add at least one acceptance criterion before approving the plan.');
      const byId = new Map(base.decisions.map((entry) => [entry.id, entry]));
      const stale = cited({ content: plan.content, criteria: plan.content.criteria }).filter((id) => !isActive(byId.get(id)));
      if (stale.length > 0) return conflict(route, 'plan_cites_superseded_decisions', 'The plan cites decisions that were superseded.', { staleDecisionIds: stale });
      if (body?.revision !== undefined && body.revision !== plan.revision) return conflict(route, 'plan_revision_conflict', 'This plan changed since you loaded it.', { currentRevision: plan.revision });
      const at = new Date().toISOString();
      const superseded = [];
      for (const other of state.plans) {
        if (other.id === plan.id || other.track !== plan.track) continue;
        if (other.status === 'approved' || (other.status === 'draft' && other.version < plan.version)) {
          Object.assign(other, { revision: other.revision + 1, status: 'superseded', supersededAt: at });
          superseded.push(other.id);
        }
      }
      Object.assign(plan, { approvedAt: at, owner: { id: syntheticUser.id, name: syntheticUser.name }, revision: plan.revision + 1, status: 'approved', updatedAt: at });
      syncShared();
      return json(route, { ok: true, plan: present(plan), supersededPlanIds: superseded });
    }

    if (action === '/propose-work' && method === 'POST') {
      if (!canEdit()) return notFound(route);
      if (plan.status !== 'approved') return conflict(route, 'plan_not_approved', 'Approve this plan before proposing work from it.');
      if (state.proposeMode === 'ai_not_configured') return json(route, { details: { code: 'ai_not_configured', message: 'Requirements AI is not configured.' }, error: 'ai_not_configured', ok: false }, 503);
      if (state.proposeMode === 'work_output_uncited') return json(route, { details: { code: 'work_output_uncited', message: 'x', retryable: true }, error: 'work_output_uncited', ok: false }, 502);
      if (state.proposeMode === 'plan_work_applied') return conflict(route, 'plan_work_applied', 'Every acceptance criterion in this plan already has applied work.', { coveredCriteriaIds: ['AC-E1'] });
      const sessionId = 'session-mine';
      const items = [
        { acceptanceCriteria: [], actionId: 'action-x1', criteriaIds: ['AC-E2', 'AC-E3'], itemId: 'epic-x1', kind: 'epic', parent: null, sourceDecisionIds: ['dec-price', 'dec-pref-slots'], status: 'pending', storyCount: 2, title: 'Price and availability' },
        { acceptanceCriteria: [], actionId: 'action-x1', criteriaIds: ['AC-E2'], itemId: 'story-x1', kind: 'story', parent: { existing: false, itemId: 'epic-x1', kind: 'epic', title: 'Price and availability' }, sourceDecisionIds: ['dec-price'], status: 'pending', storyCount: 0, title: 'Price range before tax' },
        { acceptanceCriteria: [], actionId: 'action-x1', criteriaIds: ['AC-E3'], itemId: 'story-x2', kind: 'story', parent: { existing: false, itemId: 'epic-x1', kind: 'epic', title: 'Price and availability' }, sourceDecisionIds: ['dec-pref-slots'], status: 'pending', storyCount: 0, title: 'Fully booked slots' },
      ];
      state.proposals = state.proposals.filter((record) => !(record.planId === plan.id && record.proposedBy.id === syntheticUser.id));
      state.proposals.push({ items, planId: plan.id, proposedAt: new Date().toISOString(), proposedBy: { id: syntheticUser.id, name: syntheticUser.name }, sessionId });
      return json(route, {
        alreadyAppliedCriteriaIds: ['AC-E1'], dropped: [], ok: true, planId: plan.id,
        proposals: items, reviewLink: { actionIds: ['action-x1'], projectId: syntheticProject.id, query: { assistant: '1', assistantSessionId: sessionId }, sessionId, surface: 'ai-workspace' },
        uncoveredCriteriaIds: [],
      }, 201);
    }

    return json(route, { error: `Unhandled synthetic plans request: ${method} ${path}`, ok: false }, 501);
  }

  return { calls, state, syncShared };
}
