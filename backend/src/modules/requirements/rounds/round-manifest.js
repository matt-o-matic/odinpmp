// Reads what a round needs from a package manifest (package-spec.md sections 3 and 4):
// directions, screens, questions, and feedback dimensions, plus answer validation and the
// text an answer posts into its topic's thread.

export const BUILT_IN_DIMENSIONS = Object.freeze({
  behavior: 'Behavior',
  branding: 'Branding',
  color: 'Color',
  cost: 'Cost',
  density: 'Density & spacing',
  feasibility: 'Feasibility',
  hierarchy: 'Hierarchy & navigation',
  operability: 'Operability',
  risk: 'Risk',
  security: 'Security',
  type: 'Type & size',
});

export const DEFAULT_DIMENSIONS = Object.freeze({
  architecture: Object.freeze(['feasibility', 'risk', 'cost', 'operability', 'security']),
  experience: Object.freeze(['type', 'density', 'hierarchy', 'color', 'branding', 'behavior']),
});

export const VERDICT_OVERALL_VALUES = Object.freeze(['keep', 'keep-with-changes', 'change', 'undecided']);
export const VERDICT_DIMENSION_VALUES = Object.freeze(['keep', 'change', 'undecided']);
export const DIRECTION_STANCES = Object.freeze(['preferred', 'acceptable', 'rejected']);

export const VERDICT_LABELS = Object.freeze({
  change: 'Change',
  keep: 'Keep',
  'keep-with-changes': 'Keep with changes',
  undecided: 'Undecided',
});

export const STANCE_LABELS = Object.freeze({ acceptable: 'Acceptable', preferred: 'Preferred', rejected: 'Rejected' });

export const MAX_TEXT_ANSWER_LENGTH = 4000;

export function manifestSection(manifest, type) {
  return (manifest?.sections ?? []).find((section) => section?.type === type) ?? null;
}

function items(manifest, type) {
  const section = manifestSection(manifest, type);
  return Array.isArray(section?.items) ? section.items : [];
}

export function manifestDirections(manifest) {
  return items(manifest, 'directions');
}

export function manifestScreens(manifest) {
  return items(manifest, 'screens');
}

export function manifestQuestions(manifest) {
  return items(manifest, 'questions');
}

/** `[{ key, label, help }]` in manifest order, or the track's defaults. */
export function feedbackDimensions(manifest, track) {
  const declared = Array.isArray(manifest?.feedbackDimensions) && manifest.feedbackDimensions.length > 0
    ? manifest.feedbackDimensions
    : DEFAULT_DIMENSIONS[track] ?? DEFAULT_DIMENSIONS.experience;
  return declared.flatMap((entry) => {
    if (typeof entry === 'string') return [{ help: '', key: entry, label: BUILT_IN_DIMENSIONS[entry] ?? entry }];
    if (entry && typeof entry === 'object' && entry.id) return [{ help: entry.help ?? '', key: entry.id, label: entry.label ?? entry.id }];
    return [];
  });
}

export function dimensionLabels(manifest, track) {
  return new Map(feedbackDimensions(manifest, track).map((dimension) => [dimension.key, dimension.label]));
}

function optionLabel(question, optionId) {
  return (question.options ?? []).find((option) => option.id === optionId)?.label ?? optionId;
}

/**
 * Checks an answer against its question. Returns `{ ok: true, value }` with the normalized
 * value, or `{ ok: false, message }`.
 *   single: an option id; multi: one or more distinct option ids; text: 1-4000 characters;
 *   scale: an integer from min to max.
 */
export function validateAnswerValue(question, value) {
  const optionIds = new Set((question.options ?? []).map((option) => option.id));
  switch (question.kind) {
    case 'single':
      if (typeof value !== 'string' || !optionIds.has(value)) return { message: 'Choose one of the question\'s options.', ok: false };
      return { ok: true, value };
    case 'multi': {
      if (!Array.isArray(value) || value.length === 0) return { message: 'Choose at least one option.', ok: false };
      if (value.some((entry) => typeof entry !== 'string' || !optionIds.has(entry))) return { message: 'Choose only the question\'s options.', ok: false };
      if (new Set(value).size !== value.length) return { message: 'Choose each option once.', ok: false };
      const order = [...optionIds];
      return { ok: true, value: [...value].sort((left, right) => order.indexOf(left) - order.indexOf(right)) };
    }
    case 'text': {
      if (typeof value !== 'string' || !value.trim()) return { message: 'Write an answer.', ok: false };
      if (value.length > MAX_TEXT_ANSWER_LENGTH) return { message: `Keep the answer under ${MAX_TEXT_ANSWER_LENGTH} characters.`, ok: false };
      return { ok: true, value: value.trim() };
    }
    case 'scale': {
      const { max, min } = question.scale ?? {};
      if (!Number.isInteger(value) || value < min || value > max) return { message: `Choose a whole number from ${min} to ${max}.`, ok: false };
      return { ok: true, value };
    }
    default:
      return { message: 'This question cannot be answered.', ok: false };
  }
}

/** Plain text for an answer, as people read it in the topic thread. */
export function answerText(question, value) {
  switch (question.kind) {
    case 'single':
      return optionLabel(question, value);
    case 'multi':
      return (Array.isArray(value) ? value : []).map((entry) => optionLabel(question, entry)).join(', ');
    case 'scale': {
      const scale = question.scale ?? {};
      const ends = scale.minLabel || scale.maxLabel
        ? ` (${scale.min} = ${scale.minLabel || scale.min}, ${scale.max} = ${scale.maxLabel || scale.max})`
        : '';
      return `${value} on a ${scale.min}-${scale.max} scale${ends}`;
    }
    default:
      return String(value ?? '');
  }
}

/** The comment an answer posts into its topic: the answer, then a short reference to its source. */
export function answerCommentBody({ question, roundNumber, value }) {
  return `${answerText(question, value)}\n\nAnswered in review round ${roundNumber}: "${question.prompt}"`;
}
