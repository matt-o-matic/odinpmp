// Reviewer layers and the accessible mark list ("1. Pin · Ravi Shah · Hierarchy").

import { DEFAULT_LAYER_COLOR, normalizeColor, primaryShape, shapeTypeLabel } from './annotation-shapes.js';

// Built-in feedback dimensions from package-spec.md section 4. Packages can add custom ones.
export const FEEDBACK_DIMENSION_LABELS = Object.freeze({
  type: 'Type & size',
  density: 'Density & spacing',
  hierarchy: 'Hierarchy & navigation',
  color: 'Color',
  branding: 'Branding',
  behavior: 'Behavior',
  feasibility: 'Feasibility',
  risk: 'Risk',
  cost: 'Cost',
  operability: 'Operability',
  security: 'Security',
});

const STATUS_LABELS = { resolved: 'Resolved', carried: 'Carried forward', outdated: 'Outdated', superseded: 'Superseded' };
const FADED_STATUSES = new Set(['resolved', 'outdated', 'superseded']);

export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words.at(-1)[0]}`;
  return letters.toUpperCase();
}

// One layer per author, the current reviewer first, then in order of first mark.
export function buildLayers(marks, currentActor) {
  const layers = new Map();
  if (currentActor?.ref) {
    layers.set(currentActor.ref, { ref: currentActor.ref, name: currentActor.name || 'You', color: normalizeColor(currentActor.color) || DEFAULT_LAYER_COLOR, count: 0, self: true });
  }
  for (const mark of marks || []) {
    if (!mark?.authorRef) continue;
    if (!layers.has(mark.authorRef)) {
      layers.set(mark.authorRef, { ref: mark.authorRef, name: mark.authorName || 'Reviewer', color: normalizeColor(mark.color) || DEFAULT_LAYER_COLOR, count: 0, self: false });
    }
    layers.get(mark.authorRef).count += 1;
  }
  return [...layers.values()];
}

export function isMarkVisible(mark, { hiddenAuthors = [], showResolved = true } = {}) {
  if (!mark) return false;
  if (hiddenAuthors.includes(mark.authorRef)) return false;
  if (!showResolved && mark.status === 'resolved') return false;
  return true;
}

export function visibleMarks(marks, options) {
  return (marks || []).filter((mark) => isMarkVisible(mark, options));
}

export function isMarkFaded(mark) {
  return FADED_STATUSES.has(mark?.status);
}

export function categoryLabel(category, labels = {}) {
  if (!category) return '';
  return labels[category] || FEEDBACK_DIMENSION_LABELS[category] || String(category).replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function markTypeLabel(mark) {
  const shapes = mark?.shapes || [];
  const label = shapeTypeLabel(primaryShape(mark)?.type);
  const extra = shapes.length - 1;
  return extra > 0 ? `${label} + ${extra} ${extra === 1 ? 'mark' : 'marks'}` : label;
}

// "Pin · Ravi Shah · Hierarchy", plus the status when it is not open.
export function markDescription(mark, { categoryLabels } = {}) {
  const parts = [markTypeLabel(mark), mark?.authorName || 'Reviewer'];
  const category = categoryLabel(mark?.category, categoryLabels);
  if (category) parts.push(category);
  if (STATUS_LABELS[mark?.status]) parts.push(STATUS_LABELS[mark.status]);
  return parts.join(' · ');
}

export function markLabel(mark, { number, categoryLabels } = {}) {
  return `${number ?? '?'}. ${markDescription(mark, { categoryLabels })}`;
}
