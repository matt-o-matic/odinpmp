// Source numbering and citation mapping for a topic's discussion and its Odin summary.
// Comments are numbered C1, C2, ... in thread order so summary citations can link to them.

import { briefRefLabel } from './requirements-tracks.js';
import { avatarColor, initials, resolveProposedAnswerStatus } from './requirements-topics.js';

/**
 * Numbers a topic's comments C1, C2, ... in the order they were posted, so a reply to an
 * early comment never renumbers later ones. `entries` keeps thread order (depth-first, as
 * rendered). Odin's own notes are not sources and get no number. Removed comments keep
 * theirs, so a deletion does not shift the numbers people are quoting.
 */
export function numberComments(comments = []) {
  const entries = [];
  const visit = (list, depth) => {
    for (const comment of list ?? []) {
      if (!comment?.id) continue;
      entries.push({ comment, depth, label: '' });
      visit(comment.children, depth + 1);
    }
  };
  visit(comments, 0);

  const labelById = new Map();
  const idByLabel = new Map();
  entries
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => entry.comment.actorType !== 'assistant')
    .sort((left, right) => {
      const leftTime = Date.parse(left.entry.comment.createdAt ?? '');
      const rightTime = Date.parse(right.entry.comment.createdAt ?? '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
      return left.position - right.position;
    })
    .forEach(({ entry }, index) => {
      entry.label = `C${index + 1}`;
      labelById.set(entry.comment.id, entry.label);
      idByLabel.set(entry.label, entry.comment.id);
    });

  return { entries, idByLabel, labelById };
}

export function flattenComments(comments = []) {
  return numberComments(comments).entries.map((entry) => entry.comment);
}

const EMPTY_NUMBERING = Object.freeze({ entries: [], idByLabel: new Map(), labelById: new Map() });

/**
 * Maps one summary source reference to something the UI can show. Accepts the forms the
 * summary engine may cite: `comment:<id>`, a bare comment id, a `C3` label, brief refs,
 * and annotation refs. Only comments in this thread are linkable.
 */
export function resolveSourceRef(ref, numbering = EMPTY_NUMBERING) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const { idByLabel, labelById } = numbering ?? EMPTY_NUMBERING;

  const commentMatch = /^(?:comment|clarification-comment):(.+)$/i.exec(value);
  const commentId = commentMatch ? commentMatch[1] : value;
  if (labelById.has(commentId)) {
    return { commentId, kind: 'comment', label: labelById.get(commentId), linkable: true, ref: value };
  }

  const label = value.toUpperCase();
  if (/^C\d+$/.test(label) && idByLabel.has(label)) {
    return { commentId: idByLabel.get(label), kind: 'comment', label, linkable: true, ref: value };
  }

  if (commentMatch) return { commentId: null, kind: 'comment', label: 'Earlier comment', linkable: false, ref: value };
  if (value.startsWith('brief:')) return { commentId: null, kind: 'brief', label: briefRefLabel(value) || 'Brief', linkable: false, ref: value };
  if (/^annotation:/i.test(value)) return { commentId: null, kind: 'annotation', label: 'Annotation', linkable: false, ref: value };
  return { commentId: null, kind: 'other', label: value.length > 24 ? `${value.slice(0, 23)}…` : value, linkable: false, ref: value };
}

export function resolveSourceRefs(refs = [], numbering = EMPTY_NUMBERING) {
  const seen = new Set();
  const resolved = [];
  for (const ref of refs ?? []) {
    const source = resolveSourceRef(ref, numbering);
    if (!source || seen.has(source.ref)) continue;
    seen.add(source.ref);
    resolved.push(source);
  }
  return resolved;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The summary's sections with empty or malformed entries dropped. Summaries stored before
 * outstanding items carried sources and who they wait on read with empty lists, and one
 * without a proposed-answer status reads as agreed when it has an answer.
 */
export function normalizeSummaryOutput(output = null) {
  const proposedAnswer = String(output?.proposedAnswer ?? '').trim();
  return {
    aligned: list(output?.aligned).filter((entry) => String(entry?.statement ?? '').trim()),
    divergent: list(output?.divergent).filter((entry) => String(entry?.issue ?? '').trim() || list(entry?.positions).length > 0),
    // Round and screen summaries: what the annotations and comments say, by theme.
    feedbackThemes: list(output?.feedbackThemes)
      .filter((entry) => String(entry?.theme ?? '').trim())
      .map((entry) => ({ detail: String(entry.detail ?? '').trim(), sources: list(entry.sources), theme: String(entry.theme).trim() })),
    insufficientInput: output?.insufficientInput === true,
    outstanding: list(output?.outstanding)
      .filter((entry) => String(entry?.item ?? '').trim())
      .map((entry) => ({
        ...entry,
        blocking: entry.blocking === true,
        sources: list(entry.sources),
        suggestedOwnerRole: String(entry.suggestedOwnerRole ?? '').trim(),
        waitingOn: list(entry.waitingOn),
        waitingOnNames: list(entry.waitingOnNames),
      })),
    proposedAnswer,
    proposedAnswerSources: proposedAnswer ? list(output?.proposedAnswerSources) : [],
    proposedAnswerStatus: resolveProposedAnswerStatus({ proposedAnswer, status: output?.proposedAnswerStatus }),
    underExplored: list(output?.underExplored).filter((entry) => String(entry?.area ?? '').trim()),
  };
}

/**
 * Chip for a proposed answer's status, or null without one. An agreed answer, or the
 * owner's, a required person's or an admin's answer nobody has disputed, reads as ready to
 * record only while nothing is blocking; the blocking count says the rest.
 */
export function proposedAnswerStatusChip(status, { blocking = 0 } = {}) {
  if (status === 'agreed') return { label: (Number(blocking) || 0) > 0 ? 'Agreed' : 'Agreed, ready to record', status, tone: 'ok' };
  if (status === 'owner-answered') return { label: (Number(blocking) || 0) > 0 ? 'Owner’s answer' : 'Owner’s answer, ready to record', status, tone: 'ok' };
  if (status === 'authority-answered') return { label: (Number(blocking) || 0) > 0 ? 'Required answer' : 'Required answer, ready to record', status, tone: 'ok' };
  if (status === 'awaiting-confirmation') return { label: 'One person’s answer, awaiting confirmation', status, tone: 'warn' };
  return null;
}

const NAME_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Whose move an outstanding item is: "Waiting on Ravi Shah and Noor", else "for <role>", else ''. */
export function outstandingOwnerText({ names = [], role = '' } = {}) {
  const people = [...new Set(list(names).map((name) => String(name ?? '').trim()).filter(Boolean))];
  if (people.length) return `Waiting on ${NAME_LIST.format(people)}`;
  const owner = String(role ?? '').trim();
  return owner ? `for ${owner}` : '';
}

/**
 * What a register card shows of a topic's Odin summary: the proposed answer with its
 * status and the first `perGroup` aligned, diverging, and outstanding entries, each with
 * how many it left out. `kind` is 'none' without a summary, 'thin' when Odin found too
 * little input, and 'empty' when the summary has no findings. A `settled` (decided or
 * dismissed) topic shows no outstanding items or answer status: nothing is waiting on them.
 * Reads `summary.output`, which the topics list carries with `include=summaries`.
 */
export function summaryCardDigest(summary = null, { perGroup = 2, settled = false } = {}) {
  if (!summary) return { kind: 'none' };
  const output = normalizeSummaryOutput(summary.output ?? null);
  if (output.insufficientInput || summary.insufficientInput === true) return { kind: 'thin' };
  const take = (entries, toText) => ({
    items: entries.slice(0, perGroup).map(toText),
    more: Math.max(0, entries.length - perGroup),
  });
  const groups = [
    { key: 'aligned', label: 'Aligned', ...take(output.aligned, (entry) => ({ text: entry.statement.trim() })) },
    { key: 'divergent', label: 'Diverging', ...take(output.divergent, (entry) => ({ text: String(entry.issue ?? '').trim() || 'Positions differ' })) },
    { key: 'outstanding', label: 'Outstanding', ...take(settled ? [] : output.outstanding, (entry) => ({ blocking: entry.blocking, text: entry.item.trim() })) },
  ].filter((group) => group.items.length > 0);
  const proposedAnswer = output.proposedAnswer || String(summary.proposedAnswer ?? '').trim();
  if (!proposedAnswer && groups.length === 0) return { kind: 'empty' };
  const proposedAnswerStatus = settled
    ? 'none'
    : resolveProposedAnswerStatus({ proposedAnswer, status: summary.proposedAnswerStatus ?? summary.output?.proposedAnswerStatus });
  return { groups, kind: 'summary', proposedAnswer, proposedAnswerStatus };
}

export function hasSummaryFindings(normalized) {
  return Boolean(normalized)
    && (normalized.aligned.length + normalized.divergent.length + normalized.underExplored.length + normalized.outstanding.length
      + (normalized.feedbackThemes?.length ?? 0)) > 0;
}

/** Every source the proposed answer, aligned, and diverging entries cite, in first-cited order. */
export function collectSummarySources(output = null) {
  const normalized = normalizeSummaryOutput(output);
  const refs = [];
  const add = (sources) => {
    for (const source of list(sources)) {
      const value = String(source ?? '').trim();
      if (value && !refs.includes(value)) refs.push(value);
    }
  };
  add(normalized.proposedAnswerSources);
  for (const entry of normalized.aligned) add(entry.sources);
  for (const entry of normalized.divergent) {
    for (const position of list(entry.positions)) add(position?.sources);
  }
  return refs;
}

export function blockingOutstandingCount(output = null) {
  return normalizeSummaryOutput(output).outstanding.filter((entry) => entry.blocking === true).length;
}

/**
 * Warning shown above Record decision, or '' when nothing is known to be open. A topic
 * that is already `decided` gets none: replacing its decision is not held up by them.
 */
export function decisionWarning(output = null, { decided = false } = {}) {
  if (decided) return '';
  const blocking = blockingOutstandingCount(output);
  if (blocking === 0) return '';
  return blocking === 1 ? '1 blocking item still open' : `${blocking} blocking items still open`;
}

/**
 * Resolves an actor reference (`user:<id>`, `stakeholder:<id>`) to a display person,
 * using project members, stakeholders, and comment authors in that order.
 */
export function resolveActorRef(ref, { comments = [], stakeholders = [], users = [] } = {}) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const separator = value.indexOf(':');
  const actorType = separator > 0 ? value.slice(0, separator) : 'user';
  const actorId = separator > 0 ? value.slice(separator + 1) : value;

  let name = '';
  if (actorType === 'user') {
    name = (users ?? []).find((user) => String(user?.id) === actorId)?.name ?? '';
  } else if (actorType === 'stakeholder') {
    const stakeholder = (stakeholders ?? []).find((entry) => String(entry?.id) === actorId);
    name = stakeholder?.name || stakeholder?.email || '';
  }
  if (!name) {
    const authored = flattenComments(comments).find((comment) => comment.actorType === actorType && String(comment.actorId) === actorId);
    name = authored?.authorName ?? '';
  }
  const displayName = name || (actorType === 'stakeholder' ? 'Stakeholder' : 'Team member');
  return { color: avatarColor(value), initials: initials(displayName), name: displayName, ref: value };
}

export function resolveActorRefs(refs = [], context = {}) {
  const seen = new Set();
  return list(refs)
    .map((ref) => resolveActorRef(ref, context))
    .filter((person) => person && !seen.has(person.ref) && seen.add(person.ref));
}

const COMMENT_SOURCE_LABELS = Object.freeze({
  answer: { icon: 'bi-reply', label: 'Answer' },
  'email-reply': { icon: 'bi-envelope', label: 'Email reply' },
  'round-answer': { icon: 'bi-collection-play', label: 'Round answer' },
});

/** Chip for how a comment arrived (email reply, round answer), or null for ordinary ones. */
export function commentSourceChip(source) {
  return COMMENT_SOURCE_LABELS[String(source ?? '').trim()] ?? null;
}

/** Contribution counts for the discussion header. Odin's notes are not contributions. */
export function discussionStats(comments = []) {
  const human = flattenComments(comments).filter((comment) => comment.actorType !== 'assistant' && !comment.deletedAt);
  const people = new Set(human.map((comment) => `${comment.actorType}:${comment.actorId ?? comment.authorName}`));
  return { contributions: human.length, people: people.size };
}
