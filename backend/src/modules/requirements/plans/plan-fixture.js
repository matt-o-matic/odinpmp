import { trackLabel } from './plan-content.js';

// Deterministic track plans for local work without an OpenAI key
// (REQUIREMENTS_AI_PROVIDER=local-fixture). Output is built from the model input alone and
// is structurally valid. It never runs in production: env.js refuses the setting there, and
// createRequirementsAiService refuses it again.

const DELIVERED = new Set(['agreed', 'decided']);

function shorten(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A plan from the decisions: agreed and decided decisions become scope items and one
 * criterion each, deferred ones become non-goals. The objective is the brief's objective
 * line when there is one.
 */
export function draftPlanWithLocalFixture(modelInput) {
  const content = modelInput?.untrustedContent ?? {};
  const decisions = content.decisions ?? [];
  const delivered = decisions.filter((decision) => DELIVERED.has(decision.outcome));
  const objectiveLine = (content.brief ?? []).find((line) => /objective/i.test(line.label ?? ''));
  const objective = objectiveLine?.text
    || `Deliver the ${trackLabel(modelInput?.track).toLowerCase()} decisions recorded for ${content.projectName || 'this project'}.`;

  return {
    criteria: delivered.map((decision) => ({
      decisionIds: [decision.ref],
      id: '',
      scenario: shorten(`The delivered work meets ${decision.ref}: ${decision.statement}`, 1000),
    })),
    nonGoals: decisions
      .filter((decision) => decision.outcome === 'deferred')
      .map((decision) => ({ decisionIds: [decision.ref], text: shorten(decision.statement, 600) })),
    objective: shorten(objective, 1000),
    scope: delivered.map((decision) => ({ decisionIds: [decision.ref], text: shorten(decision.statement, 600) })),
  };
}

/**
 * One epic per scope item, holding one story per criterion that shares a decision with the
 * item. Criteria that match no scope item go into one more epic.
 */
export function proposeWorkWithLocalFixture(modelInput) {
  const content = modelInput?.untrustedContent ?? {};
  const allowed = new Set(modelInput?.criteriaIds ?? []);
  const remaining = (content.criteria ?? []).filter((criterion) => allowed.has(criterion.id));
  const story = (criterion) => ({
    criteriaIds: [criterion.id],
    description: shorten(criterion.scenario, 2000),
    title: shorten(criterion.scenario, 120),
  });
  const epics = [];

  for (const item of content.scope ?? []) {
    const refs = new Set(item.decisionIds ?? []);
    const group = remaining.filter((criterion) => (criterion.decisionIds ?? []).some((ref) => refs.has(ref)));
    if (group.length === 0) continue;
    for (const criterion of group) remaining.splice(remaining.indexOf(criterion), 1);
    epics.push({ description: shorten(item.text, 2000), existingEpicRef: '', stories: group.map(story), title: shorten(item.text, 120) });
  }
  if (remaining.length > 0) {
    epics.push({
      description: `Acceptance criteria from the ${trackLabel(modelInput?.track)} plan that no scope item covers.`,
      existingEpicRef: '',
      stories: remaining.map(story),
      title: `${trackLabel(modelInput?.track)} acceptance criteria`,
    });
  }
  return { epics };
}

export function createLocalFixturePlanAi() {
  return {
    async draftPlan({ modelInput }) {
      return { model: 'local-fixture', output: draftPlanWithLocalFixture(modelInput) };
    },
    async proposeWork({ modelInput }) {
      return { model: 'local-fixture', output: proposeWorkWithLocalFixture(modelInput) };
    },
  };
}
