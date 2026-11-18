// Polls on posts: what the composer offers and sends, and how a
// post's poll reads. The server checks every poll and vote again (backend polls.js).

export const POLL_KINDS = Object.freeze([
  { hint: 'Everyone picks one option.', id: 'single', label: 'Single choice' },
  { hint: 'Everyone picks one or more options.', id: 'multiple', label: 'Multiple choice' },
  { hint: 'Everyone puts the options in order. The winner has the most points: first place scores most.', id: 'ranking', label: 'Ranking' },
  { hint: 'Everyone writes a short answer. Matching answers are grouped and counted.', id: 'text', label: 'Fill in the blank' },
  { hint: 'Everyone gives a number on a scale.', id: 'rating', label: 'Rating scale' },
]);

export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 20;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 200;
export const POLL_TEXT_ANSWER_MAX = 500;

/** Options a quick start fills in. */
export const POLL_PRESETS = Object.freeze({ yesNoMaybe: ['Yes', 'No', 'Maybe'] });

export const kindLabel = (kind) => POLL_KINDS.find((entry) => entry.id === kind)?.label ?? 'Poll';
export const kindHint = (kind) => POLL_KINDS.find((entry) => entry.id === kind)?.hint ?? '';
export const takesOptions = (kind) => kind === 'single' || kind === 'multiple' || kind === 'ranking';

let nextKey = 0;
const optionDraft = (label = '') => ({ key: `option-${(nextKey += 1)}`, label });

/** An empty poll for the composer. */
export function newPollDraft() {
  return { anonymous: false, closesAt: '', kind: 'single', maxChoices: '', options: [optionDraft(), optionDraft()], question: '', scaleMax: 5, showResults: 'always' };
}

export function withOption(draft, label = '') {
  return draft.options.length >= POLL_OPTIONS_MAX ? draft : { ...draft, options: [...draft.options, optionDraft(label)] };
}

export function withoutOption(draft, key) {
  return draft.options.length <= POLL_OPTIONS_MIN ? draft : { ...draft, options: draft.options.filter((option) => option.key !== key) };
}

/** Moves the entry at `index` by `step` (-1 up, 1 down) in a copy of `list`. */
export function moveEntry(list, index, step) {
  const to = index + step;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const copy = [...list];
  const [entry] = copy.splice(index, 1);
  copy.splice(to, 0, entry);
  return copy;
}

export function withPreset(draft, labels) {
  return { ...draft, kind: 'single', options: labels.map((label) => optionDraft(label)) };
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * The poll the composer sends, or the first thing to fix: { poll } or { error }. `now` is for the
 * closing time, which must be in the future.
 */
export function pollPayload(draft, { now = new Date() } = {}) {
  const question = oneLine(draft.question);
  if (!question) return { error: 'Write the question.' };
  if (question.length > POLL_QUESTION_MAX) return { error: `Keep the question to ${POLL_QUESTION_MAX} characters.` };
  const options = takesOptions(draft.kind) ? draft.options.map((option) => oneLine(option.label)).filter(Boolean) : [];
  if (takesOptions(draft.kind)) {
    if (options.length < POLL_OPTIONS_MIN) return { error: `Give at least ${POLL_OPTIONS_MIN} options.` };
    if (options.some((option) => option.length > POLL_OPTION_MAX)) return { error: `Keep each option to ${POLL_OPTION_MAX} characters.` };
    const seen = new Set();
    for (const option of options) {
      if (seen.has(option.toLowerCase())) return { error: `"${option}" is listed twice.` };
      seen.add(option.toLowerCase());
    }
  }
  const settings = { anonymous: Boolean(draft.anonymous), showResults: draft.showResults === 'after_vote' ? 'after_vote' : 'always' };
  if (draft.kind === 'multiple' && String(draft.maxChoices ?? '') !== '') {
    const max = Number(draft.maxChoices);
    if (!Number.isInteger(max) || max < 1 || max > options.length) return { error: `Allow from 1 to ${options.length} choices.` };
    settings.maxChoices = max;
  }
  if (draft.kind === 'rating') settings.scaleMax = Number(draft.scaleMax) === 10 ? 10 : 5;
  let closesAt = null;
  if (draft.closesAt) {
    const date = new Date(draft.closesAt);
    if (Number.isNaN(date.getTime())) return { error: 'That closing time is not a date.' };
    if (date <= now) return { error: 'Pick a closing time in the future.' };
    closesAt = date.toISOString();
  }
  return { poll: { kind: draft.kind, options, question, settings, ...(closesAt ? { closesAt } : {}) } };
}

/** The voting form's starting state: the person's answer, or nothing chosen yet. */
export function answerDraft(poll) {
  const mine = poll?.myAnswer ?? null;
  if (poll?.kind === 'ranking') return { order: mine?.order ?? poll.options.map((option) => option.id) };
  if (poll?.kind === 'text') return { text: mine?.text ?? '' };
  if (poll?.kind === 'rating') return { value: mine?.value ?? null };
  return { optionIds: mine?.optionIds ? [...mine.optionIds] : [] };
}

/** The answer to send, or null when the form isn't complete. */
export function answerPayload(poll, draft) {
  if (poll.kind === 'single') return draft.optionIds.length === 1 ? { optionIds: [...draft.optionIds] } : null;
  if (poll.kind === 'multiple') {
    if (!draft.optionIds.length) return null;
    const max = poll.settings?.maxChoices;
    return max && draft.optionIds.length > max ? null : { optionIds: [...draft.optionIds] };
  }
  if (poll.kind === 'ranking') return draft.order.length === poll.options.length ? { order: [...draft.order] } : null;
  if (poll.kind === 'text') {
    const text = oneLine(draft.text);
    return text && text.length <= POLL_TEXT_ANSWER_MAX ? { text } : null;
  }
  if (poll.kind === 'rating') return Number.isInteger(draft.value) ? { value: draft.value } : null;
  return null;
}

export const percent = (share) => `${Math.round((Number(share) || 0) * 100)}%`;

export function votesLabel(count) {
  return count === 1 ? '1 person voted' : `${count ?? 0} people voted`;
}

/** "Closes Nov 16, 3:00 PM", "Closed", or '' for a poll with no closing time. */
export function closingLabel(poll, { now = new Date(), locale } = {}) {
  if (poll?.closed) return 'Closed';
  if (!poll?.closesAt) return '';
  const date = new Date(poll.closesAt);
  if (date <= now) return 'Closed';
  return `Closes ${new Intl.DateTimeFormat(locale, { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' }).format(date)}`;
}

/** Each option's label by id, for a ranking ballot's order. */
export function optionLabels(poll) {
  return new Map((poll?.options ?? []).map((option) => [option.id, option.label]));
}
