// Track plans for the Plan & work stage: which plan version to show, its
// owner line, the decisions it builds on with their D-labels, citation chips with stale
// flags, the edit form and its payload, every error the stage explains, and proposed work
// grouped by the person who proposed it. Pure helpers over the shapes
// backend/src/modules/requirements/plans/plans.service.js returns.
//
// Accepted work shows its owner and never an AI-drafted tag: a draft has no owner
// line, an approved plan names its approver.

import { buildDecisionLog } from './requirements-topics.js';
import { formatRelativeDay, formatShortDate } from './requirements-time.js';
import { plural, trackLabel } from './requirements-tracks.js';

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const STATUS_CHIPS = Object.freeze({
  approved: { label: 'Approved', tone: 'ok' },
  draft: { label: 'Draft', tone: 'exp' },
  superseded: { label: 'Superseded', tone: 'outline' },
});

export function planStatusChip(status) {
  return STATUS_CHIPS[status] ?? { label: 'Draft', tone: 'exp' };
}

/** "Experience plan · v2". */
export function planHeading(plan = {}) {
  return `${trackLabel(plan.track)} plan · v${plan.version ?? '?'}`;
}

/** "Experience plan v2", for sentences. */
export function planTitle(plan = {}) {
  return `${trackLabel(plan.track)} plan v${plan.version ?? '?'}`;
}

/** Newest version first. */
export function sortPlans(plans = []) {
  return [...list(plans)].sort((left, right) => (Number(right?.version) || 0) - (Number(left?.version) || 0));
}

export function latestPlan(plans = []) {
  return sortPlans(plans)[0] ?? null;
}

export function approvedPlan(plans = []) {
  return sortPlans(plans).find((plan) => plan.status === 'approved') ?? null;
}

/** The plan to show: the requested version when it exists, else the latest. */
export function selectPlan(plans = [], requestedId = '') {
  const id = text(requestedId);
  return (id && list(plans).find((plan) => plan.id === id)) || latestPlan(plans);
}

/**
 * The owner line. An approved (or superseded, once approved) plan names its approver: the
 * person who accepted it owns it. A draft has no owner yet.
 */
export function ownerLine(plan = {}, { locale, now = new Date() } = {}) {
  if (plan.owner?.name && plan.approvedAt) {
    const approvedText = `approved ${formatRelativeDay(plan.approvedAt, { locale, now })}`;
    return { approvedText, name: plan.owner.name, text: `Owner: ${plan.owner.name} · ${approvedText}` };
  }
  if (plan.status === 'draft') return { approvedText: '', name: '', text: 'Draft · not approved yet' };
  return { approvedText: '', name: '', text: '' };
}

/** "v3 · Draft · edited from v2 · Oct 7" rows for the version list. */
export function historyRows(plans = [], { locale, selectedId = '' } = {}) {
  return sortPlans(plans).map((plan) => {
    const parts = [];
    if (plan.status === 'approved' || (plan.status === 'superseded' && plan.owner?.name)) {
      parts.push(`${plan.owner?.name || 'Approved'} · approved ${formatShortDate(plan.approvedAt, { locale })}`);
    } else {
      parts.push(`created ${formatShortDate(plan.createdAt, { locale })}`);
    }
    if (plan.basedOn?.version) parts.push(`edited from v${plan.basedOn.version}`);
    return {
      chip: planStatusChip(plan.status),
      id: plan.id,
      meta: parts.join(' · '),
      selected: plan.id === selectedId,
      version: plan.version,
    };
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const PLAN_INPUT_KINDS = new Set(['topic', 'preference']);

/** Map(decisionId -> D-label) over every decision in the track, as the API labels them. */
export function decisionLabelMap(decisions = []) {
  return new Map(buildDecisionLog(decisions).map((entry) => [entry.id, entry.label]));
}

/**
 * "Decisions this plan builds on": the track's topic decisions and accepted preferences,
 * active ones first (newest first), then superseded ones with what replaced them. Each row
 * says whether the plan cites it; a cited superseded decision is a stale citation.
 */
export function decisionRows(decisions = [], plan = null) {
  const cited = new Set(list(plan?.decisions).map((entry) => entry.id));
  const stale = new Set(list(plan?.staleDecisionIds));
  const log = buildDecisionLog(decisions).filter((entry) => PLAN_INPUT_KINDS.has(entry.kind));
  const active = log.filter((entry) => entry.status !== 'superseded' && !entry.supersededById);
  const superseded = log.filter((entry) => entry.status === 'superseded' || entry.supersededById);
  const row = (entry) => ({
    ...entry,
    cited: cited.has(entry.id),
    stale: stale.has(entry.id),
    superseded: entry.status === 'superseded' || Boolean(entry.supersededById),
  });
  const rows = [...active.map(row), ...superseded.map(row)];
  return {
    counts: {
      decisions: active.filter((entry) => entry.kind === 'topic').length,
      preferences: active.filter((entry) => entry.kind === 'preference').length,
    },
    countsText: `${plural(active.filter((entry) => entry.kind === 'topic').length, 'decision')} · ${plural(active.filter((entry) => entry.kind === 'preference').length, 'preference')}`,
    rows,
  };
}

/**
 * Chips for the decisions one plan item cites. Labels come from the plan's own decision
 * refs first, then the track's log; a superseded or missing decision is flagged.
 */
export function citationChips(ids = [], { labels = new Map(), plan = null } = {}) {
  const refs = new Map(list(plan?.decisions).map((entry) => [entry.id, entry]));
  const stale = new Set(list(plan?.staleDecisionIds));
  return list(ids).map((id) => {
    const ref = refs.get(id) ?? null;
    const label = ref?.label || labels.get(id) || 'Decision';
    const flagged = stale.has(id) || ref?.status === 'superseded' || ref?.status === 'missing';
    const state = ref?.status === 'missing' ? 'missing' : flagged ? 'superseded' : 'active';
    return {
      ariaLabel: state === 'active' ? `Decision ${label}` : `Decision ${label}, ${state === 'missing' ? 'no longer exists' : 'superseded'}`,
      id,
      label,
      state,
    };
  });
}

/** "D-07, D-11" for an item's citations. */
export function citationText(ids = [], options = {}) {
  return citationChips(ids, options).map((chip) => chip.label).join(', ');
}

/** The note above the criteria when the plan cites superseded decisions, or ''. */
export function staleNotice(plan = null, { labels = new Map() } = {}) {
  const ids = list(plan?.staleDecisionIds);
  if (ids.length === 0) return '';
  const names = citationChips(ids, { labels, plan }).map((chip) => chip.label).join(', ');
  return `This plan cites ${ids.length === 1 ? 'a decision that was' : 'decisions that were'} superseded (${names}). Update ${ids.length === 1 ? 'that citation' : 'those citations'} before approving.`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Which plan actions to offer for the shown version. Only the latest version can be edited
 * or approved; editing an approved plan creates the next draft. `reason` explains a
 * disabled Approve.
 */
export function planActions({ abilities = {}, plan = null, plans = [] } = {}) {
  const latest = latestPlan(plans);
  const isLatest = Boolean(plan && latest && plan.id === latest.id);
  const canEdit = Boolean(abilities.editPlans);
  const actions = {
    approve: null,
    draft: canEdit ? { label: list(plans).length > 0 ? 'Redraft from decisions' : 'Draft plan' } : null,
    edit: null,
    proposeWork: null,
  };
  if (!plan) return actions;
  if (canEdit && isLatest && plan.status !== 'superseded') {
    actions.edit = plan.status === 'approved'
      ? { createsVersion: plan.version + 1, label: 'Edit as new draft' }
      : { createsVersion: null, label: 'Edit' };
  }
  if (abilities.approvePlans && isLatest && plan.status === 'draft') {
    let reason = '';
    if (list(plan.criteria).length === 0) reason = 'Add at least one acceptance criterion before approving.';
    else if (list(plan.staleDecisionIds).length > 0) reason = 'Update the citations to superseded decisions before approving.';
    actions.approve = { disabled: Boolean(reason), label: 'Approve', reason };
  }
  if (abilities.proposeWork && plan.status === 'approved') actions.proposeWork = { label: 'Propose work' };
  return actions;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function errorParts(error) {
  const data = error?.data ?? {};
  const details = data.details && !Array.isArray(data.details) ? data.details : {};
  const code = typeof details.code === 'string' && details.code
    ? details.code
    : (typeof data.error === 'string' && /^[a-z]+(?:_[a-z]+)+$/.test(data.error) ? data.error : '');
  return { code, details, status: Number(error?.status) || 0 };
}

const AI_NOT_CONFIGURED = 'Odin can’t draft plans because no AI provider is set up for this workspace. A workspace admin can add one in the AI settings.';

/** Draft and redraft failures. `retryable` shows Try again; `decideLink` points at the Decide stage. */
export function describeDraftError(error) {
  const { code, details, status } = errorParts(error);
  if (code === 'ai_not_configured' || (status === 503 && !code)) return { code: 'ai_not_configured', message: AI_NOT_CONFIGURED, retryable: false };
  if (code === 'no_decisions') {
    return { code, decideLink: true, message: 'This track has no recorded decisions or accepted preferences yet. Record some in the Decide stage, then draft the plan.', retryable: false };
  }
  if (code === 'plan_output_uncited') {
    return { code, message: 'Odin’s draft had no acceptance criteria that cite a recorded decision, so nothing was saved. Try again.', retryable: true };
  }
  if (code === 'ai_output_invalid' || code === 'ai_request_failed' || status === 502 || details.retryable === true) {
    return { code: code || 'ai_request_failed', message: 'Odin couldn’t draft the plan, so nothing changed. Try again.', retryable: true };
  }
  if (code === 'plan_not_latest') return { code, message: 'Someone added a newer version while Odin was drafting. The latest version is shown now.', reload: true, retryable: false };
  if (status === 404) return { code: 'not_found', message: 'You can’t draft plans on this project.', retryable: false };
  return { code, message: 'Unable to draft the plan. Try again.', retryable: true };
}

const SECTION_NAMES = Object.freeze({ criteria: 'Acceptance criterion', nonGoals: 'Not in scope item', scope: 'Scope item' });

function issueMessage(issue) {
  const where = `${SECTION_NAMES[issue.section] ?? 'Item'} ${Number(issue.index) + 1}`;
  switch (issue.reason) {
    case 'unknown-decision': return `${where}: ${issue.ref} isn’t a decision in this track.`;
    case 'inactive-decision': return `${where}: ${issue.ref} was superseded. Cite the decision that replaced it.`;
    case 'invalid-criterion-id': return `${where}: ${issue.ref} isn’t a valid criterion id for this track.`;
    case 'duplicate-criterion-id': return `${where}: ${issue.ref} is used twice.`;
    default: return `${where}: ${issue.ref || 'this item'} can’t be saved.`;
  }
}

/** Save failures for the edit form: per-field issues, a revision conflict, or a stale version. */
export function describeEditError(error) {
  const { code, details, status } = errorParts(error);
  if (code === 'invalid_plan_edit') {
    const issues = list(details.issues).map((issue) => ({ ...issue, message: issueMessage(issue) }));
    return { code, issues, message: 'Some citations or criterion ids aren’t valid. Fix them and save again.' };
  }
  if (code === 'plan_revision_conflict') {
    return { code, conflict: true, message: 'This plan changed while you were editing, so your changes weren’t saved. The latest version is shown. Reapply your edits to review them on top of it.', reload: true };
  }
  if (code === 'plan_not_latest') return { code, message: 'A newer version of this plan exists, so this one can’t change. The latest version is shown now.', reload: true };
  if (code === 'plan_superseded') return { code, message: 'This version was superseded by a newer approved version, so it can’t change.', reload: true };
  if (code === 'plan_already_approved') return { code, message: 'This version was approved while you were editing. Edit it again to start the next draft.', reload: true };
  if (status === 404) return { code: 'not_found', message: 'This plan no longer exists, or you can’t edit plans on this project.', reload: true };
  if (Array.isArray(error?.data?.details) && error.data.details.length > 0) {
    return { code: 'invalid_request', message: 'Some fields are empty or too long. Check them and save again.' };
  }
  return { code, message: 'Unable to save the plan. Try again.' };
}

/** Approve failures (decision rights only). */
export function describeApproveError(error, { labels = new Map(), plan = null } = {}) {
  const { code, details, status } = errorParts(error);
  if (code === 'plan_incomplete') return { code, message: 'This plan has no acceptance criteria. Add at least one before approving.' };
  if (code === 'plan_cites_superseded_decisions') {
    const names = citationChips(list(details.staleDecisionIds), { labels, plan }).map((chip) => chip.label).join(', ');
    return { code, message: `This plan cites decisions that were superseded${names ? ` (${names})` : ''}. Edit those citations, then approve.`, reload: true };
  }
  if (code === 'plan_already_approved') return { code, message: 'This version is already approved.', reload: true };
  if (code === 'plan_superseded') return { code, message: 'This version was superseded by a newer approved version.', reload: true };
  if (code === 'plan_not_latest') return { code, message: 'A newer version of this plan exists. Approve the latest version instead.', reload: true };
  if (code === 'plan_revision_conflict') return { code, message: 'This plan changed since you opened it. Check the latest version, then approve.', reload: true };
  if (status === 404) return { code: 'not_found', message: 'Only project or workspace admins and managers can approve plans.' };
  return { code, message: 'Unable to approve the plan. Try again.' };
}

/** Propose work failures. */
export function describeProposeError(error) {
  const { code, details, status } = errorParts(error);
  if (code === 'ai_not_configured' || (status === 503 && !code)) {
    return { code: 'ai_not_configured', message: 'Odin can’t propose work because no AI provider is set up for this workspace. A workspace admin can add one in the AI settings.', retryable: false };
  }
  if (code === 'plan_not_approved') return { code, message: 'Approve this plan before proposing work from it.', retryable: false };
  if (code === 'plan_work_applied') return { code, message: 'Every acceptance criterion in this plan already has applied work, so there is nothing left to propose.', retryable: false };
  if (code === 'work_output_uncited') return { code, message: 'None of Odin’s proposed stories implemented an acceptance criterion, so nothing was proposed. Try again.', retryable: true };
  if (code === 'ai_output_invalid' || code === 'ai_request_failed' || status === 502 || details.retryable === true) {
    return { code: code || 'ai_request_failed', message: 'Odin couldn’t propose work, so nothing changed. Try again.', retryable: true };
  }
  if (status === 404) return { code: 'not_found', message: 'You can’t propose work from plans on this project.', retryable: false };
  return { code, message: 'Unable to propose work. Try again.', retryable: true };
}

/**
 * A quiet note about what a draft left out: items without a valid citation, and citations
 * that pointed at unknown, superseded, or non-plan decisions. '' when nothing was dropped.
 */
export function droppedNote(dropped = []) {
  const items = list(dropped).filter((entry) => entry.what === 'item');
  const citations = list(dropped).filter((entry) => entry.what === 'citation');
  if (items.length === 0 && citations.length === 0) return '';
  const parts = [];
  if (items.length) parts.push(`left out ${plural(items.length, 'item')} that didn’t cite a recorded decision`);
  if (citations.length) parts.push(`removed ${plural(citations.length, 'citation')} to decisions a plan can’t build on`);
  return `Odin ${parts.join(' and ')}.`;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** "D-07, d11, D-7" -> ['D-07', 'd11', 'D-7'] (the API canonicalizes labels and accepts ids). */
export function parseDecisionRefs(value) {
  return [...new Set(String(value ?? '').split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))];
}

/** The edit form for one plan version; citations shown as D-labels. */
export function planEditForm(plan = {}, { labels = new Map() } = {}) {
  const refs = (ids) => citationText(ids, { labels, plan });
  return {
    criteria: list(plan.criteria).map((criterion) => ({ decisions: refs(criterion.decisionIds), id: criterion.id, scenario: criterion.scenario })),
    nonGoals: list(plan.nonGoals).map((item) => ({ decisions: refs(item.decisionIds), text: item.text })),
    objective: plan.objective ?? '',
    revision: plan.revision,
    scope: list(plan.scope).map((item) => ({ decisions: refs(item.decisionIds), text: item.text })),
  };
}

/** Client-side checks before saving: every item needs text. */
export function planEditErrors(form = {}) {
  const errors = [];
  for (const [section, field] of [['scope', 'text'], ['nonGoals', 'text'], ['criteria', 'scenario']]) {
    list(form[section]).forEach((item, index) => {
      if (!text(item[field])) errors.push({ index, message: `${SECTION_NAMES[section]} ${index + 1}: write it or remove it.`, section });
    });
  }
  return errors;
}

/** `PATCH /plans/:id` body from the edit form. */
export function planEditPayload(form = {}) {
  const items = (entries) => list(entries).map((item) => ({ decisionIds: parseDecisionRefs(item.decisions), text: text(item.text) }));
  return {
    criteria: list(form.criteria).map((criterion) => ({ decisionIds: parseDecisionRefs(criterion.decisions), id: text(criterion.id), scenario: text(criterion.scenario) })),
    nonGoals: items(form.nonGoals),
    objective: text(form.objective),
    revision: form.revision,
    scope: items(form.scope),
  };
}

// ---------------------------------------------------------------------------
// Proposed work
// ---------------------------------------------------------------------------

const ITEM_STATUS = Object.freeze({
  applied: { label: 'Applied', tone: 'ok' },
  dismissed: { label: 'Dismissed', tone: 'outline' },
  pending: { label: 'Pending review', tone: 'warn' },
});

export function workStatusChip(status) {
  return ITEM_STATUS[status] ?? ITEM_STATUS.pending;
}

/** "2 applied · 1 pending · 0 dismissed". */
export function workCountsText(counts = {}) {
  return `${Number(counts.applied) || 0} applied · ${Number(counts.pending) || 0} pending · ${Number(counts.dismissed) || 0} dismissed`;
}

/**
 * Proposed work per proposer, the signed-in person's first. Each row is an epic or story
 * with the criteria it implements and the decisions behind it. Only the proposer gets the
 * AI Workspace review link; everyone else sees status.
 */
export function proposedWorkGroups(proposedWork = [], { labels = new Map(), locale, now = new Date(), plan = null } = {}) {
  return [...list(proposedWork)]
    .sort((left, right) => Number(Boolean(right.mine)) - Number(Boolean(left.mine)) || String(right.proposedAt).localeCompare(String(left.proposedAt)))
    .map((record) => {
      const newEpicIds = new Set(list(record.items).filter((item) => item.kind === 'epic').map((item) => item.itemId));
      const items = list(record.items).map((item) => {
        const parts = [];
        if (item.kind === 'epic') parts.push(plural(item.storyCount, 'story', 'stories'));
        if (item.kind === 'story' && item.parent && !newEpicIds.has(item.parent.itemId)) parts.push(`under ${item.parent.title}`);
        if (list(item.criteriaIds).length) parts.push(item.criteriaIds.join(', '));
        const decisions = citationText(item.sourceDecisionIds, { labels, plan });
        if (decisions) parts.push(decisions);
        return {
          ...item,
          chip: workStatusChip(item.status),
          kindLabel: item.kind === 'epic' ? 'Epic' : 'Story',
          meta: parts.join(' · '),
          nested: item.kind === 'story' && Boolean(item.parent) && newEpicIds.has(item.parent.itemId),
        };
      });
      const name = record.proposedBy?.name || 'A team member';
      return {
        counts: record.counts ?? { applied: 0, dismissed: 0, pending: 0 },
        countsText: workCountsText(record.counts),
        heading: record.mine ? `Proposed by you · ${formatRelativeDay(record.proposedAt, { locale, now })}` : `Proposed by ${name} · ${formatRelativeDay(record.proposedAt, { locale, now })}`,
        items,
        key: record.proposedBy?.id ?? name,
        mine: Boolean(record.mine),
        name,
        reviewLink: record.mine ? record.reviewLink ?? null : null,
      };
    });
}

/** The route to the AI Workspace review for a review link, on the current page. */
export function reviewLinkLocation(reviewLink, route = {}) {
  if (!reviewLink?.query) return null;
  return { name: route.name, params: { ...(route.params ?? {}) }, query: { ...(route.query ?? {}), ...reviewLink.query } };
}
