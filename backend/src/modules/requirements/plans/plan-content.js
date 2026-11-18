import { z } from 'zod';

import { HttpError } from '../../../lib/errors/http-error.js';

// Track plans (plan.md journey 9, AC-13): the plan's structure, decision labels, the
// citation checks every drafted or edited plan passes, the work breakdown checks, and the
// Markdown the plan and its proposed work items carry.
//
// A plan cites decisions by id. The model sees decisions by their display label (D-07),
// the same label the team workspace shows (frontend buildDecisionLog: every decision in the
// track, in decision-time order). Labels are mapped back to ids before anything is stored.

export const PLAN_STATUSES = Object.freeze(['draft', 'approved', 'superseded']);
export const PLAN_INPUT_DECISION_KINDS = Object.freeze(['topic', 'preference']);
export const CRITERION_LETTER = Object.freeze({ architecture: 'A', experience: 'E' });

export const PLAN_LIMITS = Object.freeze({
  criteria: 40,
  decisionIdsPerItem: 20,
  epics: 15,
  items: 20,
  objective: 1000,
  scenario: 1000,
  storiesPerEpic: 20,
  text: 600,
  title: 200,
  workDescription: 2000,
});

const ref = z.string().trim().min(1).max(80);
const refs = z.array(ref).max(PLAN_LIMITS.decisionIdsPerItem);

// Every field is required so both schemas work with strict structured outputs.
export const planDraftOutputSchema = z.object({
  criteria: z.array(z.object({
    decisionIds: refs,
    id: z.string().trim().max(20),
    scenario: z.string().trim().min(1).max(PLAN_LIMITS.scenario),
  })).max(PLAN_LIMITS.criteria),
  nonGoals: z.array(z.object({
    decisionIds: refs,
    text: z.string().trim().min(1).max(PLAN_LIMITS.text),
  })).max(PLAN_LIMITS.items),
  objective: z.string().trim().max(PLAN_LIMITS.objective),
  scope: z.array(z.object({
    decisionIds: refs,
    text: z.string().trim().min(1).max(PLAN_LIMITS.text),
  })).max(PLAN_LIMITS.items),
});

export const workBreakdownOutputSchema = z.object({
  epics: z.array(z.object({
    description: z.string().trim().max(PLAN_LIMITS.workDescription),
    existingEpicRef: z.string().trim().max(20),
    stories: z.array(z.object({
      criteriaIds: z.array(z.string().trim().min(1).max(20)).max(PLAN_LIMITS.criteria),
      description: z.string().trim().max(PLAN_LIMITS.workDescription),
      title: z.string().trim().min(1).max(PLAN_LIMITS.title),
    })).max(PLAN_LIMITS.storiesPerEpic),
    title: z.string().trim().min(1).max(PLAN_LIMITS.title),
  })).max(PLAN_LIMITS.epics),
});

function clean(value, max = Infinity) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function trackLabel(track) {
  return track === 'architecture' ? 'Functional' : 'Experience';
}

export function planTitle(track, version) {
  return `${trackLabel(track)} plan v${version}`;
}

// ---------------------------------------------------------------------------
// Decisions and labels
// ---------------------------------------------------------------------------

export function isActiveDecision(decision) {
  return Boolean(decision) && !decision.supersededById && decision.outcome !== 'superseded';
}

/** D-NN per decision id, over every decision in the track, oldest first. */
export function decisionLabels(decisions = []) {
  const chronological = [...(decisions ?? [])].sort((left, right) => (
    String(left.decidedAt ?? '').localeCompare(String(right.decidedAt ?? ''))
      || String(left.id ?? '').localeCompare(String(right.id ?? ''))
  ));
  return new Map(chronological.map((decision, index) => [decision.id, `D-${String(index + 1).padStart(2, '0')}`]));
}

function canonicalLabel(value) {
  const match = /^D-?0*(\d{1,4})$/i.exec(String(value ?? '').trim());
  return match ? `D-${match[1].padStart(2, '0')}` : '';
}

/**
 * Everything the plan checks need about one track's decisions. `inputIds` are the decisions
 * a drafted plan may cite: active topic decisions and accepted preferences.
 */
export function buildDecisionCatalog(decisions = []) {
  const labelById = decisionLabels(decisions);
  const byId = new Map((decisions ?? []).map((decision) => [decision.id, decision]));
  const idByLabel = new Map([...labelById.entries()].map(([id, label]) => [label, id]));
  const inputIds = new Set((decisions ?? [])
    .filter((decision) => isActiveDecision(decision) && PLAN_INPUT_DECISION_KINDS.includes(decision.kind))
    .map((decision) => decision.id));
  return { byId, idByLabel, inputIds, labelById };
}

/** The decision a cited ref points at (an id or a D-NN label), or null. */
export function resolveDecisionRef(value, catalog) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (catalog.byId.has(raw)) return raw;
  const label = canonicalLabel(raw);
  return label ? catalog.idByLabel.get(label) ?? null : null;
}

/**
 * Splits cited refs into decision ids that pass `accept(id)` and rejected refs with a
 * reason. Duplicates collapse.
 */
function resolveCitations(values = [], catalog, accept) {
  const ids = [];
  const rejected = [];
  for (const value of values ?? []) {
    const id = resolveDecisionRef(value, catalog);
    if (!id) {
      rejected.push({ reason: 'unknown-decision', ref: String(value ?? '').trim() });
      continue;
    }
    const verdict = accept(id);
    if (verdict !== true) {
      rejected.push({ decisionId: id, reason: verdict, ref: String(value ?? '').trim() });
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, rejected };
}

function acceptPlanInput(catalog) {
  return (id) => {
    if (catalog.inputIds.has(id)) return true;
    return isActiveDecision(catalog.byId.get(id)) ? 'not-plan-input' : 'inactive-decision';
  };
}

// ---------------------------------------------------------------------------
// Drafted plans
// ---------------------------------------------------------------------------

export function criterionId(track, number) {
  return `AC-${CRITERION_LETTER[track] ?? 'E'}${number}`;
}

/**
 * Checks a drafted plan against the track's decisions. Citations to unknown, superseded,
 * or non-input decisions are removed; scope items, non-goals, and criteria left without a
 * valid citation are dropped. Every removal is recorded. Criteria are numbered AC-E1,
 * AC-E2, ... (AC-A1 for the Functional track, stored as architecture) in order.
 */
export function validatePlanDraftOutput(output, { catalog, track }) {
  const dropped = [];
  const accept = acceptPlanInput(catalog);

  function section(name, entries, textField) {
    const kept = [];
    (entries ?? []).forEach((entry, index) => {
      const text = clean(entry?.[textField], textField === 'scenario' ? PLAN_LIMITS.scenario : PLAN_LIMITS.text);
      const { ids, rejected } = resolveCitations(entry?.decisionIds, catalog, accept);
      for (const item of rejected) {
        dropped.push({ ...item, index, section: name, text, what: 'citation' });
      }
      if (ids.length === 0) {
        dropped.push({ index, reason: 'uncited', section: name, text, what: 'item' });
        return;
      }
      kept.push({ decisionIds: ids, [textField]: text });
    });
    return kept;
  }

  const scope = section('scope', output?.scope, 'text');
  const nonGoals = section('nonGoals', output?.nonGoals, 'text');
  const criteria = section('criteria', output?.criteria, 'scenario')
    .map((criterion, index) => ({ decisionIds: criterion.decisionIds, id: criterionId(track, index + 1), scenario: criterion.scenario }));

  return {
    content: { nonGoals, objective: clean(output?.objective, PLAN_LIMITS.objective), scope },
    criteria,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Edits by people
// ---------------------------------------------------------------------------

function editError(issues) {
  return new HttpError(400, 'invalid_plan_edit', {
    details: {
      code: 'invalid_plan_edit',
      issues,
      message: 'Some citations or criterion ids in this plan are not valid. Fix them and save again.',
    },
  });
}

/**
 * Applies a person's edit on top of `base`. Items may cite nothing. A new citation must be
 * an active decision of the track; a citation the base version already carried stays even
 * if its decision has since been superseded, so it shows as stale instead of blocking the
 * save. Criterion ids must look like AC-E3 for this track and be unique; criteria without
 * an id get the next free number.
 */
export function applyPlanEdit(input, { base, catalog, track }) {
  const issues = [];
  const grandfathered = new Set([
    ...(base.content?.scope ?? []),
    ...(base.content?.nonGoals ?? []),
    ...(base.criteria ?? []),
  ].flatMap((item) => item.decisionIds ?? []));
  const accept = (id) => (isActiveDecision(catalog.byId.get(id)) || grandfathered.has(id) ? true : 'inactive-decision');

  function items(name, entries, textField) {
    return entries.map((entry, index) => {
      const { ids, rejected } = resolveCitations(entry.decisionIds, catalog, accept);
      for (const item of rejected) issues.push({ ...item, index, section: name });
      return { decisionIds: ids, [textField]: clean(entry[textField], textField === 'scenario' ? PLAN_LIMITS.scenario : PLAN_LIMITS.text) };
    });
  }

  const content = {
    nonGoals: input.nonGoals !== undefined ? items('nonGoals', input.nonGoals, 'text') : base.content.nonGoals,
    objective: input.objective !== undefined ? clean(input.objective, PLAN_LIMITS.objective) : base.content.objective,
    scope: input.scope !== undefined ? items('scope', input.scope, 'text') : base.content.scope,
  };

  let criteria = base.criteria;
  if (input.criteria !== undefined) {
    const pattern = new RegExp(`^AC-${CRITERION_LETTER[track]}([1-9]\\d{0,3})$`);
    const seen = new Set();
    const drafted = items('criteria', input.criteria, 'scenario').map((criterion, index) => {
      const given = String(input.criteria[index].id ?? '').trim().toUpperCase();
      if (!given) return { ...criterion, id: '' };
      if (!pattern.test(given)) {
        issues.push({ index, reason: 'invalid-criterion-id', ref: given, section: 'criteria' });
      } else if (seen.has(given)) {
        issues.push({ index, reason: 'duplicate-criterion-id', ref: given, section: 'criteria' });
      }
      seen.add(given);
      return { ...criterion, id: given };
    });
    let next = Math.max(0, ...[...seen].map((id) => Number(pattern.exec(id)?.[1] ?? 0))) + 1;
    criteria = drafted.map((criterion) => (criterion.id ? criterion : { ...criterion, id: criterionId(track, next++) }));
  }

  if (issues.length > 0) throw editError(issues);
  return { content, criteria };
}

/** Every decision id the plan cites, in first-cited order. */
export function citedDecisionIds({ content, criteria }) {
  const ids = [];
  for (const item of [...(content?.scope ?? []), ...(content?.nonGoals ?? []), ...(criteria ?? [])]) {
    for (const id of item.decisionIds ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function labelsFor(ids = [], labelById) {
  return ids.map((id) => labelById.get(id) ?? 'decision').join(', ');
}

function tableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** The plan as Markdown: objective, scope, non-goals, and the acceptance criteria table. */
export function renderPlanMarkdown({ content, criteria, labelById, track, version }) {
  const lines = [`# ${planTitle(track, version)}`, '', '## Objective', '', content.objective || 'Not set yet.'];
  if ((content.scope ?? []).length > 0) {
    lines.push('', '## Scope', '', ...content.scope.map((item) => `- ${item.text}${item.decisionIds.length ? ` (${labelsFor(item.decisionIds, labelById)})` : ''}`));
  }
  if ((content.nonGoals ?? []).length > 0) {
    lines.push('', '## Not in scope', '', ...content.nonGoals.map((item) => `- ${item.text}${item.decisionIds.length ? ` (${labelsFor(item.decisionIds, labelById)})` : ''}`));
  }
  lines.push('', '## Acceptance criteria', '');
  if ((criteria ?? []).length === 0) {
    lines.push('None yet.');
  } else {
    lines.push('| ID | Scenario and expected result | Decisions |', '| --- | --- | --- |');
    for (const criterion of criteria) {
      lines.push(`| ${criterion.id} | ${tableCell(criterion.scenario)} | ${labelsFor(criterion.decisionIds, labelById) || '—'} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Proposed work
// ---------------------------------------------------------------------------

function nameKey(value) {
  return clean(value).toLowerCase();
}

/**
 * Checks a work breakdown against the approved plan. Stories keep only criterion ids the
 * plan has (and that are not already covered by applied work); a story left with none is
 * dropped. An epic maps onto an existing epic by its ref or by an identical name. Each
 * story's source decisions are the decisions its criteria cite.
 */
export function validateWorkBreakdown(output, { criteria = [], excludeCriteriaIds = [], existingEpics = [] }) {
  const dropped = [];
  const excluded = new Set(excludeCriteriaIds);
  const criteriaById = new Map(criteria.filter((criterion) => !excluded.has(criterion.id)).map((criterion) => [criterion.id, criterion]));
  const existingByRef = new Map(existingEpics.map((epic) => [epic.ref, epic]));
  const existingByName = new Map(existingEpics.map((epic) => [nameKey(epic.name), epic]));
  const groups = new Map();

  (output?.epics ?? []).forEach((epic, epicIndex) => {
    const title = clean(epic?.title, PLAN_LIMITS.title);
    const existing = existingByRef.get(String(epic?.existingEpicRef ?? '').trim()) ?? existingByName.get(nameKey(title)) ?? null;
    const stories = [];
    (epic?.stories ?? []).forEach((story, storyIndex) => {
      const storyTitle = clean(story?.title, PLAN_LIMITS.title);
      const criteriaIds = [];
      for (const value of story?.criteriaIds ?? []) {
        const id = String(value ?? '').trim().toUpperCase();
        if (criteriaById.has(id)) {
          if (!criteriaIds.includes(id)) criteriaIds.push(id);
        } else {
          dropped.push({ epicIndex, reason: excluded.has(id) ? 'criterion-already-applied' : 'unknown-criterion', ref: id, storyIndex, what: 'citation' });
        }
      }
      if (!storyTitle || criteriaIds.length === 0) {
        dropped.push({ epicIndex, reason: 'uncited', storyIndex, text: storyTitle, what: 'story' });
        return;
      }
      const decisionIds = [];
      for (const id of criteriaIds) {
        for (const decisionId of criteriaById.get(id).decisionIds ?? []) {
          if (!decisionIds.includes(decisionId)) decisionIds.push(decisionId);
        }
      }
      stories.push({ criteriaIds, decisionIds, description: String(story?.description ?? '').trim().slice(0, PLAN_LIMITS.workDescription), title: storyTitle });
    });
    if (stories.length === 0) {
      dropped.push({ epicIndex, reason: 'empty', text: title, what: 'epic' });
      return;
    }
    const key = existing ? `existing:${existing.id}` : `new:${nameKey(title)}`;
    const group = groups.get(key) ?? {
      description: String(epic?.description ?? '').trim().slice(0, PLAN_LIMITS.workDescription),
      existingEpicId: existing?.id ?? null,
      stories: [],
      title: existing?.name ?? title,
    };
    group.stories.push(...stories);
    groups.set(key, group);
  });

  const epics = [...groups.values()];
  const covered = new Set(epics.flatMap((epic) => epic.stories.flatMap((story) => story.criteriaIds)));
  return {
    dropped,
    epics,
    uncoveredCriteriaIds: [...criteriaById.keys()].filter((id) => !covered.has(id)),
  };
}

function union(lists) {
  const values = [];
  for (const list of lists) {
    for (const value of list ?? []) {
      if (!values.includes(value)) values.push(value);
    }
  }
  return values;
}

export function epicCriteriaIds(epic) {
  return union(epic.stories.map((story) => story.criteriaIds));
}

export function epicDecisionIds(epic) {
  return union(epic.stories.map((story) => story.decisionIds));
}

/**
 * A proposed story's description: what it delivers, the acceptance criteria it implements,
 * and the decisions behind them with their ids, so the applied work item keeps its trail.
 */
export function renderStoryDescription({ catalog, criteriaById, plan, story }) {
  const parts = [];
  if (story.description) parts.push(story.description);
  parts.push(['Acceptance criteria:', ...story.criteriaIds.map((id) => `- ${id}: ${criteriaById.get(id)?.scenario ?? ''}`)].join('\n'));
  parts.push(['Source decisions:', ...story.decisionIds.map((id) => {
    const decision = catalog.byId.get(id);
    return `- ${catalog.labelById.get(id) ?? 'Decision'}: ${clean(decision?.statement, 300)} (decision ${id})`;
  })].join('\n'));
  parts.push(`From the ${planTitle(plan.track, plan.version)}.`);
  return parts.join('\n\n');
}

export function renderEpicDescription({ catalog, epic, plan }) {
  const parts = [];
  if (epic.description) parts.push(epic.description);
  parts.push([
    `From the ${planTitle(plan.track, plan.version)}.`,
    `Acceptance criteria: ${epicCriteriaIds(epic).join(', ')}.`,
    `Source decisions: ${epicDecisionIds(epic).map((id) => `${catalog.labelById.get(id) ?? 'Decision'} (decision ${id})`).join(', ')}.`,
  ].join(' '));
  return parts.join('\n\n');
}
