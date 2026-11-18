// Polls on posts: the kinds, what a new poll and an answer must
// look like, and how votes add up. No storage and no rights here (polls.service.js).
//
// Kinds and how they tally:
// - single: one option each; a count per option.
// - multiple: one or more options each, up to maxChoices; a count per option.
// - ranking: everyone orders every option. Borda count: with n options, first place scores n-1
//   points, last scores 0. Results list points and the average rank, best first.
// - text (fill in the blank): free text. Answers that match after trimming, collapsing spaces and
//   ignoring case are grouped and counted, the most common first.
// - rating: a whole number from 1 to scaleMax (5 or 10); the average and how many gave each value.
import { HttpError } from '../../lib/errors/http-error.js';

export const POLL_KINDS = Object.freeze(['single', 'multiple', 'ranking', 'text', 'rating']);
export const POLL_SHOW_RESULTS = Object.freeze(['always', 'after_vote']);
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 200;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 20;
export const POLL_TEXT_ANSWER_MAX = 500;
export const POLL_SCALES = Object.freeze([5, 10]);

const invalid = (message, code = 'poll_invalid') => new HttpError(400, message, { details: { code } });
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const hasOptions = (kind) => kind !== 'text' && kind !== 'rating';

/**
 * A new poll from what the composer (or a tool) sent, checked and tidied:
 * { kind, question, options: [{ id, label }], settings: { anonymous, showResults, maxChoices, scaleMax }, closesAt }.
 */
export function normalizePollInput(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object') throw invalid('Describe the poll.');
  const kind = String(input.kind ?? '');
  if (!POLL_KINDS.includes(kind)) throw invalid(`A poll is one of: ${POLL_KINDS.join(', ')}.`);
  const question = oneLine(input.question);
  if (!question) throw invalid('Write the poll\'s question.', 'poll_question_required');
  if (question.length > POLL_QUESTION_MAX) throw invalid(`Keep the question to ${POLL_QUESTION_MAX} characters.`);

  let options = [];
  if (hasOptions(kind)) {
    const labels = (Array.isArray(input.options) ? input.options : []).map((option) => oneLine(typeof option === 'string' ? option : option?.label)).filter(Boolean);
    if (labels.length < POLL_OPTIONS_MIN) throw invalid(`Give at least ${POLL_OPTIONS_MIN} options.`, 'poll_options_required');
    if (labels.length > POLL_OPTIONS_MAX) throw invalid(`A poll takes up to ${POLL_OPTIONS_MAX} options.`);
    if (labels.some((label) => label.length > POLL_OPTION_MAX)) throw invalid(`Keep each option to ${POLL_OPTION_MAX} characters.`);
    const seen = new Set();
    for (const label of labels) {
      const key = label.toLowerCase();
      if (seen.has(key)) throw invalid(`"${label}" is listed twice.`, 'poll_option_duplicate');
      seen.add(key);
    }
    options = labels.map((label, index) => ({ id: `o${index + 1}`, label }));
  }

  const settings = input.settings ?? {};
  const showResults = settings.showResults ?? 'always';
  if (!POLL_SHOW_RESULTS.includes(showResults)) throw invalid('Show results "always" or "after_vote".');
  let maxChoices = null;
  if (kind === 'multiple' && settings.maxChoices != null) {
    maxChoices = Number(settings.maxChoices);
    if (!Number.isInteger(maxChoices) || maxChoices < 1 || maxChoices > options.length) throw invalid(`Allow from 1 to ${options.length} choices.`);
  }
  let scaleMax = null;
  if (kind === 'rating') {
    scaleMax = Number(settings.scaleMax ?? 5);
    if (!POLL_SCALES.includes(scaleMax)) throw invalid('A rating runs from 1 to 5 or from 1 to 10.');
  }

  let closesAt = null;
  if (input.closesAt) {
    const date = new Date(input.closesAt);
    if (Number.isNaN(date.getTime())) throw invalid('That closing time is not a date.');
    if (date <= now) throw invalid('Pick a closing time in the future.');
    closesAt = date.toISOString();
  }

  return { closesAt, kind, options, question, settings: { anonymous: Boolean(settings.anonymous), maxChoices, scaleMax, showResults } };
}

/** Whether a poll takes votes at `now`: not closed by hand and not past its closing time. */
export function pollIsClosed(poll, now = new Date()) {
  return Boolean(poll.closedAt) || (poll.closesAt ? new Date(poll.closesAt) <= now : false);
}

/** One person's answer, checked against the poll and tidied for storage. */
export function normalizeAnswer(poll, answer) {
  const optionIds = new Set(poll.options.map((option) => option.id));
  switch (poll.kind) {
    case 'single': {
      const picked = Array.isArray(answer?.optionIds) ? answer.optionIds : [];
      if (picked.length !== 1 || !optionIds.has(picked[0])) throw invalid('Pick one option.', 'poll_answer_invalid');
      return { optionIds: [picked[0]] };
    }
    case 'multiple': {
      const picked = [...new Set(Array.isArray(answer?.optionIds) ? answer.optionIds : [])];
      if (!picked.length || picked.some((id) => !optionIds.has(id))) throw invalid('Pick at least one option.', 'poll_answer_invalid');
      const max = poll.settings.maxChoices;
      if (max && picked.length > max) throw invalid(`Pick up to ${max}.`, 'poll_answer_invalid');
      return { optionIds: poll.options.map((option) => option.id).filter((id) => picked.includes(id)) };
    }
    case 'ranking': {
      const order = Array.isArray(answer?.order) ? answer.order : [];
      if (order.length !== optionIds.size || new Set(order).size !== order.length || order.some((id) => !optionIds.has(id))) {
        throw invalid('Put every option in order, each once.', 'poll_answer_invalid');
      }
      return { order: [...order] };
    }
    case 'text': {
      const text = oneLine(answer?.text);
      if (!text) throw invalid('Write an answer.', 'poll_answer_invalid');
      if (text.length > POLL_TEXT_ANSWER_MAX) throw invalid(`Keep the answer to ${POLL_TEXT_ANSWER_MAX} characters.`, 'poll_answer_invalid');
      return { text };
    }
    case 'rating': {
      const value = Number(answer?.value);
      if (!Number.isInteger(value) || value < 1 || value > poll.settings.scaleMax) throw invalid(`Pick a whole number from 1 to ${poll.settings.scaleMax}.`, 'poll_answer_invalid');
      return { value };
    }
    default:
      throw invalid('This poll takes no answers.');
  }
}

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The results of a poll from its votes ({ answer, voterName }). `named` adds who answered what;
 * leave it false for anonymous polls, so no name ever leaves the server.
 */
export function tallyPoll(poll, votes, { named = false } = {}) {
  const voterCount = votes.length;
  const who = (vote) => vote.voterName || 'Someone';
  if (poll.kind === 'single' || poll.kind === 'multiple') {
    const options = poll.options.map((option) => {
      const chose = votes.filter((vote) => vote.answer.optionIds?.includes(option.id));
      return { count: chose.length, id: option.id, label: option.label, share: voterCount ? round(chose.length / voterCount, 4) : 0, ...(named ? { voters: chose.map(who) } : {}) };
    });
    return { kind: poll.kind, options, voterCount };
  }
  if (poll.kind === 'ranking') {
    const n = poll.options.length;
    const options = poll.options.map((option) => {
      const ranks = votes.map((vote) => vote.answer.order.indexOf(option.id) + 1).filter((rank) => rank > 0);
      const points = ranks.reduce((sum, rank) => sum + (n - rank), 0);
      return { averageRank: ranks.length ? round(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length) : null, id: option.id, label: option.label, points };
    });
    options.sort((left, right) => right.points - left.points || (left.averageRank ?? n) - (right.averageRank ?? n));
    const best = Math.max(0, (n - 1) * voterCount);
    return {
      kind: 'ranking',
      maxPoints: best,
      options: options.map((option, index) => ({ ...option, place: index + 1, share: best ? round(option.points / best, 4) : 0 })),
      voterCount,
      ...(named ? { ballots: votes.map((vote) => ({ order: vote.answer.order, voter: who(vote) })) } : {}),
    };
  }
  if (poll.kind === 'text') {
    const groups = new Map();
    for (const vote of votes) {
      const key = vote.answer.text.toLowerCase();
      const group = groups.get(key) ?? { count: 0, text: vote.answer.text, voters: [] };
      group.count += 1;
      group.voters.push(who(vote));
      groups.set(key, group);
    }
    const answers = [...groups.values()]
      .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text))
      .map(({ count, text, voters }) => ({ count, share: voterCount ? round(count / voterCount, 4) : 0, text, ...(named ? { voters } : {}) }));
    return { answers, kind: 'text', voterCount };
  }
  if (poll.kind === 'rating') {
    const max = poll.settings.scaleMax;
    const values = votes.map((vote) => vote.answer.value);
    const distribution = Array.from({ length: max }, (_, index) => {
      const value = index + 1;
      const gave = votes.filter((vote) => vote.answer.value === value);
      return { count: gave.length, share: voterCount ? round(gave.length / voterCount, 4) : 0, value, ...(named ? { voters: gave.map(who) } : {}) };
    });
    return { average: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null, distribution, kind: 'rating', scaleMax: max, voterCount };
  }
  return { kind: poll.kind, voterCount };
}

/** The results in one line, for Odin's notes and tools: no names. */
export function pollSummaryLine(poll, votes, { now = new Date() } = {}) {
  const results = tallyPoll(poll, votes);
  const state = pollIsClosed(poll, now) ? 'closed' : 'open';
  const head = `Poll (${poll.kind}, ${state}, ${results.voterCount} ${results.voterCount === 1 ? 'vote' : 'votes'}): "${poll.question}"`;
  if (!results.voterCount) return `${head}. No votes yet.`;
  if (results.kind === 'single' || results.kind === 'multiple') return `${head}. ${results.options.map((option) => `${option.label}: ${option.count}`).join('; ')}.`;
  if (results.kind === 'ranking') return `${head}. By Borda points: ${results.options.map((option) => `${option.place}. ${option.label} (${option.points} pts, average rank ${option.averageRank})`).join('; ')}.`;
  if (results.kind === 'text') return `${head}. Answers: ${results.answers.slice(0, 10).map((answer) => `"${answer.text}"${answer.count > 1 ? ` ×${answer.count}` : ''}`).join('; ')}${results.answers.length > 10 ? `; and ${results.answers.length - 10} more` : ''}.`;
  if (results.kind === 'rating') return `${head}. Average ${results.average} of ${results.scaleMax}.`;
  return head;
}
