// The guided review's model: what a round contains, its steps, the reviewer's progress,
// answer checks by question kind, and the submit summary. Silence is never agreement:
// anything the reviewer did not touch stays "Not reviewed" or "Not answered".

export const NOT_REVIEWED = 'Not reviewed';
export const NOT_ANSWERED = 'Not answered';

export const VERDICT_OPTIONS = Object.freeze([
  { label: 'Keep', short: 'Keep', value: 'keep' },
  { label: 'Keep with changes', short: 'Keep, with changes', value: 'keep-with-changes' },
  { label: 'Change', short: 'Change', value: 'change' },
  { label: 'Undecided', short: 'Undecided', value: 'undecided' },
]);

export const ASPECT_OPTIONS = Object.freeze([
  { label: 'Keep', value: 'keep' },
  { label: 'Change', value: 'change' },
  { label: 'Undecided', value: 'undecided' },
]);

export const STANCE_OPTIONS = Object.freeze([
  { label: 'Preferred', value: 'preferred' },
  { label: 'Acceptable', value: 'acceptable' },
  { label: 'Rejected', value: 'rejected' },
]);

export const MAX_TEXT_ANSWER = 4000;
export const MAX_NOTE = 4000;
export const MAX_REMIX = 2000;

const STEP_LABELS = Object.freeze({
  directions: 'Directions',
  overview: 'Overview',
  questions: 'Questions',
  screens: 'Screens',
  submit: 'Submit',
});

const VERDICT_TONES = Object.freeze({ change: 'warn', keep: 'ok', 'keep-with-changes': 'keepchg', undecided: 'neutral' });
const STANCE_TONES = Object.freeze({ acceptable: 'neutral', preferred: 'ok', rejected: 'bad' });

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function manifestSection(manifest, type) {
  return list(manifest?.sections).find((section) => section?.type === type) ?? null;
}

/** Everything the review shows, from the review state API. */
export function reviewContent(state) {
  const manifest = state?.package?.manifest ?? {};
  const directions = list(manifestSection(manifest, 'directions')?.items).map((direction, index) => ({
    ...direction,
    letter: String.fromCharCode(65 + index),
  }));
  const directionById = new Map(directions.map((direction) => [direction.id, direction]));
  const screens = list(state?.screens).map((screen, index) => ({
    ...screen,
    direction: screen.directionId ? directionById.get(screen.directionId) ?? null : null,
    id: screen.screenId,
    index,
  }));
  return {
    boundaries: manifestSection(manifest, 'boundaries')?.body ?? '',
    context: manifestSection(manifest, 'context'),
    dimensions: list(state?.package?.feedbackDimensions),
    directions,
    flows: list(manifestSection(manifest, 'flows')?.items),
    questions: list(state?.questions),
    references: list(manifestSection(manifest, 'references')?.items),
    screens,
    summary: manifest.summary ?? '',
    title: state?.round?.title ?? state?.package?.title ?? manifest.title ?? '',
  };
}

/** Overview, Directions (when there are any), Screens, Questions (when there are any), Submit. */
export function reviewSteps(content) {
  const steps = [{ id: 'overview' }];
  if (list(content?.directions).length) steps.push({ id: 'directions' });
  if (list(content?.screens).length) steps.push({ id: 'screens' });
  if (list(content?.questions).length) steps.push({ id: 'questions' });
  steps.push({ id: 'submit' });
  return steps.map((step, index) => ({ ...step, label: STEP_LABELS[step.id], number: index + 1 }));
}

/** A saved position, checked against what the round contains now. */
export function normalizePosition(position, content) {
  const steps = reviewSteps(content);
  const step = steps.some((entry) => entry.id === position?.step) ? position.step : 'overview';
  const screens = list(content?.screens);
  const screenId = screens.some((screen) => screen.id === position?.screenId) ? position.screenId : screens[0]?.id ?? null;
  const questions = list(content?.questions);
  const questionId = questions.some((question) => question.id === position?.questionId) ? position.questionId : null;
  const directions = list(content?.directions);
  const directionId = directions.some((direction) => direction.id === position?.directionId) ? position.directionId : null;
  return { directionId, questionId, screenId, stateKey: typeof position?.stateKey === 'string' ? position.stateKey : null, step };
}

/** What PUT /position takes for a place in the review. */
export function positionPayload({ directionId = null, questionId = null, screenId = null, stateKey = null, step }) {
  const payload = { step };
  if (step === 'screens' && screenId) payload.screenId = screenId;
  if (step === 'screens' && stateKey) payload.stateKey = stateKey;
  if (step === 'directions' && directionId) payload.directionId = directionId;
  if (step === 'questions' && questionId) payload.questionId = questionId;
  return payload;
}

/** Questions still asked: one whose topic the team deleted or dismissed is shown as removed and counts nowhere. */
export function answerableQuestions(content) {
  return list(content?.questions).filter((question) => !question?.removed);
}

/** Answered in this round and saved; a text answer still being typed does not count yet. */
export function isAnswered(answers, questionId) {
  const answer = answers?.[questionId];
  return Boolean(answer) && !answer.draft;
}

/**
 * The reviewer's progress, computed the way the server does: a direction counts once it has
 * a stance, a screen once it has an overall verdict (Undecided included, since it is a
 * choice), a question once it is answered in this round. Earlier-version answers and removed
 * questions do not count.
 */
export function computeProgress({ answers = {}, content, stances = {}, verdicts = {} }) {
  const part = (items, done) => ({ done: items.filter(done).length, total: items.length });
  const progress = {
    directions: part(list(content?.directions), (direction) => Boolean(stances[direction.id]?.stance)),
    questions: part(answerableQuestions(content), (question) => isAnswered(answers, question.id)),
    screens: part(list(content?.screens), (screen) => Boolean(verdicts[screen.id]?.overall)),
  };
  progress.done = progress.directions.done + progress.screens.done + progress.questions.done;
  progress.total = progress.directions.total + progress.screens.total + progress.questions.total;
  return progress;
}

export function progressPercent(progress) {
  const total = Number(progress?.total) || 0;
  if (total === 0) return 0;
  return Math.round(((Number(progress?.done) || 0) / total) * 100);
}

/** A step counts as done when everything in it has a response; Overview once left. */
export function stepDone(stepId, { progress, submittedAt = null, visited = [] } = {}) {
  if (stepId === 'overview') return visited.some((id) => id !== 'overview');
  if (stepId === 'submit') return Boolean(submittedAt);
  const part = progress?.[stepId];
  return Boolean(part && part.total > 0 && part.done === part.total);
}

// ---------------------------------------------------------------------------
// Answers by question kind (mirrors the server's validateAnswerValue)
// ---------------------------------------------------------------------------

function optionLabel(question, optionId) {
  return list(question?.options).find((option) => option.id === optionId)?.label ?? String(optionId ?? '');
}

/** `{ ok: true, value }` with the normalized value, or `{ ok: false, message }`. */
export function validateAnswer(question, value) {
  const optionIds = list(question?.options).map((option) => option.id);
  switch (question?.kind) {
    case 'single':
      if (typeof value !== 'string' || !optionIds.includes(value)) return { message: 'Choose one of the options.', ok: false };
      return { ok: true, value };
    case 'multi': {
      if (!Array.isArray(value) || value.length === 0) return { message: 'Choose at least one option.', ok: false };
      if (value.some((entry) => typeof entry !== 'string' || !optionIds.includes(entry))) return { message: 'Choose only the listed options.', ok: false };
      if (new Set(value).size !== value.length) return { message: 'Choose each option once.', ok: false };
      return { ok: true, value: [...value].sort((left, right) => optionIds.indexOf(left) - optionIds.indexOf(right)) };
    }
    case 'text': {
      if (typeof value !== 'string' || !value.trim()) return { message: 'Write an answer.', ok: false };
      if (value.trim().length > MAX_TEXT_ANSWER) return { message: `Keep the answer under ${MAX_TEXT_ANSWER} characters.`, ok: false };
      return { ok: true, value: value.trim() };
    }
    case 'scale': {
      const min = Number(question?.scale?.min);
      const max = Number(question?.scale?.max);
      if (!Number.isInteger(value) || value < min || value > max) return { message: `Choose a whole number from ${min} to ${max}.`, ok: false };
      return { ok: true, value };
    }
    default:
      return { message: 'This question can’t be answered here.', ok: false };
  }
}

/** Plain text for an answer, as the reviewer reads it back. */
export function answerText(question, value) {
  if (value == null || value === '') return '';
  switch (question?.kind) {
    case 'single':
      return optionLabel(question, value);
    case 'multi':
      return list(value).map((entry) => optionLabel(question, entry)).join(', ');
    case 'scale': {
      const scale = question.scale ?? {};
      const end = value === scale.min ? scale.minLabel : value === scale.max ? scale.maxLabel : '';
      return end ? `${value} of ${scale.max} (${end})` : `${value} of ${scale.max}`;
    }
    default:
      return String(value);
  }
}

/** The scale's whole numbers, each with its end label when it has one. */
export function scaleSteps(scale) {
  const min = Number(scale?.min);
  const max = Number(scale?.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min || max - min > 10) return [];
  const steps = [];
  for (let value = min; value <= max; value += 1) {
    steps.push({ label: value === min ? scale.minLabel ?? '' : value === max ? scale.maxLabel ?? '' : '', value });
  }
  return steps;
}

/** "Given on version 2" for an answer carried from an earlier round. */
export function previousAnswerLine(previous) {
  if (!previous) return '';
  const version = previous.packageVersion != null ? `version ${previous.packageVersion}` : `round ${previous.roundNumber}`;
  return `You answered “${previous.text}” on ${version}.`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function verdictLabel(value) {
  return VERDICT_OPTIONS.find((option) => option.value === value)?.label ?? NOT_REVIEWED;
}

export function verdictChipClass(value) {
  const tone = VERDICT_TONES[value];
  if (!tone) return 'rq-chip--outline';
  return tone === 'keepchg' ? 'rq-chip--keepchg' : `rq-chip--${tone}`;
}

export function stanceLabel(value) {
  return STANCE_OPTIONS.find((option) => option.value === value)?.label ?? NOT_REVIEWED;
}

export function stanceChipClass(value) {
  const tone = STANCE_TONES[value];
  return tone ? `rq-chip--${tone}` : 'rq-chip--outline';
}

export function aspectLabel(value) {
  return ASPECT_OPTIONS.find((option) => option.value === value)?.label ?? NOT_REVIEWED;
}

/** "hierarchy: change, color: change" for the aspects the reviewer rated Change, else the rated ones. */
export function aspectSummary(verdict, dimensions = []) {
  const rated = Object.entries(verdict?.dimensions ?? {}).filter(([, value]) => value);
  if (!rated.length) return '';
  const labelFor = (key) => (list(dimensions).find((dimension) => dimension.key === key)?.label ?? key).toLowerCase();
  const changes = rated.filter(([, value]) => value === 'change');
  const shown = (changes.length ? changes : rated).slice(0, 3);
  return shown.map(([key, value]) => `${labelFor(key)}: ${aspectLabel(value).toLowerCase()}`).join(', ');
}

export function pluralize(count, singular, plural = `${singular}s`) {
  const value = Number(count) || 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

/** "Friday, Oct 10", or '' without a date. */
export function dueDateText(value, { locale } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', weekday: 'long' }).format(date);
}

// ---------------------------------------------------------------------------
// Submit summary
// ---------------------------------------------------------------------------

/** The reviewer's direction stances in one plain sentence. */
export function directionSentence(directions = []) {
  const titled = (entry) => `${entry.letter} · ${entry.title}`;
  const by = (stance) => directions.filter((entry) => entry.stance === stance).map(titled);
  const join = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
  const parts = [];
  const preferred = by('preferred');
  const acceptable = by('acceptable');
  const rejected = by('rejected');
  if (preferred.length) parts.push(`you prefer ${join(preferred)}`);
  if (acceptable.length) parts.push(`${join(acceptable)} ${acceptable.length === 1 ? 'is' : 'are'} acceptable`);
  if (rejected.length) parts.push(`you rejected ${join(rejected)}`);
  const untouched = directions.filter((entry) => !entry.stance).map(titled);
  if (untouched.length) parts.push(`${join(untouched)} ${untouched.length === 1 ? 'is' : 'are'} not reviewed`);
  if (!parts.length) return '';
  const sentence = parts.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * What the reviewer is telling the team. `marksByScreen` counts the reviewer's own marks per
 * screen. Screens without an overall verdict are "Not reviewed"; unanswered questions are
 * "Not answered". Removed questions are left out.
 */
export function buildSubmitSummary({ answers = {}, content, marksByScreen = {}, stances = {}, verdicts = {} }) {
  const directions = list(content?.directions).map((direction) => ({
    id: direction.id,
    letter: direction.letter,
    remix: stances[direction.id]?.remix ?? '',
    stance: stances[direction.id]?.stance ?? null,
    title: direction.title,
  }));
  const screens = list(content?.screens).map((screen) => {
    const verdict = verdicts[screen.id] ?? null;
    const marks = Number(marksByScreen[screen.id]) || 0;
    const aspects = aspectSummary(verdict, content?.dimensions);
    const details = [];
    if (verdict?.overall) {
      details.push(marks ? pluralize(marks, 'mark') : 'No marks');
      if (aspects) details.push(aspects);
    } else {
      details.push(marks ? `${pluralize(marks, 'mark')}, no verdict yet` : 'You haven’t looked at this screen');
    }
    return {
      detail: details.join(' · '),
      id: screen.id,
      kind: screen.kind,
      label: verdictLabel(verdict?.overall),
      marks,
      notReviewed: !verdict?.overall,
      overall: verdict?.overall ?? null,
      title: screen.title,
    };
  });
  const questions = answerableQuestions(content).map((question) => {
    const answer = isAnswered(answers, question.id) ? answers[question.id] : null;
    return {
      answered: Boolean(answer),
      id: question.id,
      prompt: question.prompt,
      text: answer ? answer.text || answerText(question, answer.value) : '',
    };
  });
  return {
    answeredCount: questions.filter((question) => question.answered).length,
    directionLine: directionSentence(directions),
    directions,
    notReviewedScreens: screens.filter((screen) => screen.notReviewed).length,
    questions,
    remixes: directions.filter((direction) => direction.remix),
    screens,
  };
}
