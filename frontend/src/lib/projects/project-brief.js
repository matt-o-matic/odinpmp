function normalizeBriefText(value = '') {
  return String(value ?? '').trim();
}

function normalizeBriefList(values = []) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function createEditableProjectBriefState(brief = {}) {
  return {
    ...brief,
    assumptions: normalizeBriefList(brief.assumptions ?? []),
    benefits: normalizeBriefText(brief.benefits),
    committedAt: brief.committedAt ?? null,
    constraints: normalizeBriefList(brief.constraints ?? []),
    currentState: normalizeBriefText(brief.currentState),
    dependencies: normalizeBriefList(brief.dependencies ?? []),
    implementationEffort: normalizeBriefText(brief.implementationEffort),
    name: normalizeBriefText(brief.name),
    narrative: normalizeBriefText(brief.narrative),
    objective: normalizeBriefText(brief.objective),
    proposedSolution: normalizeBriefText(brief.proposedSolution),
    requirements: normalizeBriefList(brief.requirements ?? []),
    sourceSessionId: normalizeBriefText(brief.sourceSessionId),
    stakeholders: normalizeBriefList(brief.stakeholders ?? []),
    successMetrics: normalizeBriefList(brief.successMetrics ?? []),
  };
}

export function serializeEditableProjectBrief(brief = {}) {
  const normalized = createEditableProjectBriefState(brief);
  return {
    assumptions: normalized.assumptions,
    benefits: normalized.benefits,
    constraints: normalized.constraints,
    currentState: normalized.currentState,
    dependencies: normalized.dependencies,
    implementationEffort: normalized.implementationEffort,
    name: normalized.name,
    objective: normalized.objective,
    proposedSolution: normalized.proposedSolution,
    requirements: normalized.requirements,
    stakeholders: normalized.stakeholders,
    successMetrics: normalized.successMetrics,
  };
}

function buildListSection(title, values = []) {
  const items = normalizeBriefList(values);
  return items.length > 0 ? `## ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}` : '';
}

export function buildStructuredProjectBriefMarkdown(brief = {}) {
  const normalized = createEditableProjectBriefState(brief);
  return [
    normalized.objective ? `## Objective\n\n${normalized.objective}` : '',
    normalized.currentState ? `## Current State\n\n${normalized.currentState}` : '',
    normalized.proposedSolution ? `## Proposed Solution and Scope\n\n${normalized.proposedSolution}` : '',
    normalized.benefits ? `## Benefits\n\n${normalized.benefits}` : '',
    normalized.implementationEffort ? `## Implementation Effort\n\n${normalized.implementationEffort}` : '',
    buildListSection('Key Stakeholders', normalized.stakeholders),
    buildListSection('Project Requirements', normalized.requirements),
    buildListSection('Dependencies', normalized.dependencies),
    buildListSection('Constraints', normalized.constraints),
    buildListSection('Success Metrics', normalized.successMetrics),
    buildListSection('Assumptions', normalized.assumptions),
  ].filter(Boolean).join('\n\n');
}

export function buildProjectBriefMarkdown(brief = {}) {
  const structured = buildStructuredProjectBriefMarkdown(brief);
  if (structured) {
    return structured;
  }

  return normalizeBriefText(brief?.narrative);
}

export function projectBriefHasAnyContent(brief = {}) {
  const normalized = createEditableProjectBriefState(brief);
  return Boolean(
    buildProjectBriefMarkdown(normalized)
      || normalized.sourceSessionId
      || normalized.committedAt,
  );
}

function isMarkdownListLine(value = '') {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/.test(String(value ?? ''));
}

function stripMarkdownListMarker(value = '') {
  return String(value ?? '').replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, '').trim();
}

export function formatProjectBriefListMarkdown(values = []) {
  return normalizeBriefList(values).map((item) => `- ${item}`).join('\n');
}

export function parseProjectBriefListMarkdown(value = '') {
  const blocks = String(value ?? '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const items = [];

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      continue;
    }

    if (lines.every((line) => isMarkdownListLine(line))) {
      items.push(...lines.map((line) => stripMarkdownListMarker(line)));
      continue;
    }

    if (isMarkdownListLine(lines[0])) {
      items.push([
        stripMarkdownListMarker(lines[0]),
        ...lines.slice(1).map((line) => stripMarkdownListMarker(line)),
      ].join(' ').trim());
      continue;
    }

    items.push(lines.map((line) => stripMarkdownListMarker(line)).join(' ').trim());
  }

  return normalizeBriefList(items);
}

export const formatProjectBriefListInput = formatProjectBriefListMarkdown;
export const parseProjectBriefListInput = parseProjectBriefListMarkdown;
