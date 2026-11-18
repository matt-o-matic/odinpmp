// Pure helpers for requirements topics: brief lines, readiness, register state, duplicate
// detection, and the shapes the API returns. Nothing here touches storage.

import { READY_TO_RECORD_STATUSES, resolveProposedAnswerStatus } from './summary/summary-output.js';

export const BRIEF_LIST_SECTIONS = Object.freeze([
  ['requirements', 'Requirement'],
  ['constraints', 'Constraint'],
  ['assumptions', 'Assumption'],
  ['dependencies', 'Dependency'],
  ['successMetrics', 'Success metric'],
]);

export const BRIEF_TEXT_SECTIONS = Object.freeze([
  ['objective', 'Objective'],
  ['currentState', 'Current state'],
  ['proposedSolution', 'Proposed solution'],
  ['benefits', 'Benefits'],
]);

const OPEN_STATUSES = new Set(['open', 'answered']);
const DECIDED_STATUSES = new Set(['resolved', 'closed']);

function normalizeString(value) {
  return String(value ?? '').trim();
}

function briefItemText(item) {
  if (typeof item === 'string') return normalizeString(item);
  if (item && typeof item === 'object') {
    return normalizeString(item.text ?? item.description ?? item.name ?? item.title ?? '');
  }
  return '';
}

/**
 * Splits the committed brief into citable lines. List sections cite a zero-based index
 * (`brief:requirements:0` is the first requirement); text sections cite the field
 * (`brief:objective`).
 */
export function extractBriefLines(brief = {}) {
  const lines = [];
  for (const [section, label] of BRIEF_LIST_SECTIONS) {
    const items = Array.isArray(brief?.[section]) ? brief[section] : [];
    items.forEach((item, index) => {
      const text = briefItemText(item);
      if (!text) return;
      lines.push({ index, label: `${label} ${index + 1}`, ref: `brief:${section}:${index}`, section, text });
    });
  }
  for (const [section, label] of BRIEF_TEXT_SECTIONS) {
    const text = normalizeString(brief?.[section]);
    if (!text) continue;
    lines.push({ index: null, label, ref: `brief:${section}`, section, text });
  }
  return lines;
}

export function isTopicOpenStatus(status) {
  return OPEN_STATUSES.has(normalizeString(status) || 'open');
}

/**
 * Requirements topics take comments while open, and stay open for comments after a
 * decision so people can disagree with it. Dismissed topics, and topics closed without a
 * recorded decision, are closed.
 */
export function topicCommentsOpen({ hasActiveDecision = false, status }) {
  const normalized = normalizeString(status) || 'open';
  if (OPEN_STATUSES.has(normalized)) return true;
  return DECIDED_STATUSES.has(normalized) && Boolean(hasActiveDecision);
}

/**
 * The one place that decides whether a topic is ready for a decision. An open topic is
 * ready when its current Odin summary (the newest 'ok' run; failed runs never count) has
 * enough input and proposes an answer, or when the clarification flow already marked it
 * answered. Blocking outstanding items do not hold a topic back: the decision box warns
 * about them instead.
 */
export function isTopicReadyForDecision({ status, summary = null }) {
  const normalized = normalizeString(status) || 'open';
  if (!OPEN_STATUSES.has(normalized)) return false;
  if (normalized === 'answered') return true;
  if (summary && (summary.status ?? 'ok') !== 'ok') return false;
  const output = summary?.output ?? null;
  return Boolean(output && output.insufficientInput !== true && normalizeString(output.proposedAnswer));
}

export function topicState({ status, summary = null }) {
  const normalized = normalizeString(status) || 'open';
  if (normalized === 'dismissed') return 'dismissed';
  if (DECIDED_STATUSES.has(normalized)) return 'decided';
  return isTopicReadyForDecision({ status: normalized, summary }) ? 'ready' : 'open';
}

/**
 * Summary signal counts for a register row. A decided or dismissed topic shows no
 * outstanding or blocking count: its summary panel still lists them, but they no longer
 * hold anything up.
 */
export function signalCounts(summary = null, { state = 'open' } = {}) {
  const output = summary?.output ?? null;
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  const settled = state === 'decided' || state === 'dismissed';
  const outstanding = Array.isArray(output?.outstanding) ? output.outstanding : [];
  return {
    aligned: count(output?.aligned),
    blocking: settled ? 0 : outstanding.filter((entry) => entry?.blocking === true).length,
    divergent: count(output?.divergent),
    outstanding: settled ? 0 : outstanding.length,
    underExplored: count(output?.underExplored),
  };
}

// --- duplicate detection --------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'in', 'is', 'it',
  'of', 'on', 'or', 'should', 'that', 'the', 'their', 'there', 'they', 'this', 'to', 'we', 'what', 'when',
  'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

export function normalizePromptText(value) {
  return normalizeString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function contentTokens(text) {
  return new Set(normalizePromptText(text)
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token))
    .map(stem));
}

function bigrams(text) {
  const compact = normalizePromptText(text).replace(/\s+/g, ' ');
  const grams = new Map();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function diceCoefficient(left, right) {
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  const leftSize = [...leftGrams.values()].reduce((sum, count) => sum + count, 0);
  const rightSize = [...rightGrams.values()].reduce((sum, count) => sum + count, 0);
  if (leftSize === 0 || rightSize === 0) return 0;
  let overlap = 0;
  for (const [gram, count] of leftGrams) {
    overlap += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  return (2 * overlap) / (leftSize + rightSize);
}

function jaccard(left, right) {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

/**
 * True when two prompts ask the same thing. Content words decide (case, punctuation,
 * filler words, and plurals are ignored); character similarity only catches typos, because
 * on its own it rates "Who approves refunds?" and "Who approves discounts?" as near-equal.
 */
export function isDuplicatePrompt(left, right) {
  const normalizedLeft = normalizePromptText(left);
  const normalizedRight = normalizePromptText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const wordOverlap = jaccard(normalizedLeft, normalizedRight);
  if (wordOverlap >= 0.7) return true;
  return wordOverlap >= 0.5 && diceCoefficient(normalizedLeft, normalizedRight) >= 0.9;
}

// --- presentation -----------------------------------------------------------

export function userActorRef(userId) {
  return `user:${userId}`;
}

export function parseActorRef(ref) {
  const value = normalizeString(ref);
  const separator = value.indexOf(':');
  if (separator <= 0) return { actorId: value, actorType: 'user' };
  return { actorId: value.slice(separator + 1), actorType: value.slice(0, separator) };
}

export function describeActorRef(ref, userNames = new Map()) {
  if (!normalizeString(ref)) return null;
  const { actorId, actorType } = parseActorRef(ref);
  return {
    id: actorId,
    name: actorType === 'user' ? (userNames.get(actorId) ?? '') : '',
    ref: normalizeString(ref),
    type: actorType,
  };
}

function flattenComments(comments = []) {
  const flat = [];
  for (const comment of comments ?? []) {
    flat.push(comment);
    if (Array.isArray(comment.children)) flat.push(...flattenComments(comment.children));
  }
  return flat;
}

export function topicComments(clarification = {}) {
  if (Array.isArray(clarification.answerThread) && clarification.answerThread.length > 0) {
    return clarification.answerThread;
  }
  return flattenComments(clarification.comments ?? []);
}

export function findTopicComment(clarification, commentId) {
  const id = normalizeString(commentId);
  return id ? topicComments(clarification).find((comment) => comment.id === id) ?? null : null;
}

export function topicEvidence(clarification = {}) {
  const comments = topicComments(clarification).filter((comment) => !comment.isDeleted && !comment.deletedAt);
  const human = comments.filter((comment) => comment.actorType !== 'assistant');
  const contributors = new Set(human.map((comment) => `${comment.actorType}:${comment.actorId}`));
  const votes = comments.reduce((sum, comment) => sum + Number(comment.upvotes ?? 0) + Number(comment.downvotes ?? 0), 0);
  return {
    comments: human.length,
    contributors: contributors.size,
    roundAnswers: comments.filter((comment) => comment.source === 'round-answer').length,
    votes,
  };
}

function presentAssignment(assignment) {
  return {
    actorId: assignment.actorId,
    actorType: assignment.actorType,
    id: assignment.id,
    label: assignment.label,
    mailStatus: assignment.actorType === 'stakeholder' ? (assignment.mailStatus || '') : '',
    role: assignment.role,
    // Set while a never-sent invitation waits in the stakeholder's digest.
    scheduledAt: assignment.actorType === 'stakeholder' && !assignment.queuedAt ? (assignment.scheduledAt ?? null) : null,
  };
}

function presentComment(comment, actor) {
  const reaction = (comment.reactionVotes ?? []).find((vote) => actor
    && vote.actorId === actor.actorId
    && vote.actorType === actor.actorType)?.reaction ?? null;
  const presented = {
    actorId: comment.actorId,
    actorType: comment.actorType,
    authorName: comment.authorName,
    body: comment.body,
    createdAt: comment.createdAt,
    currentReaction: reaction,
    deletedAt: comment.deletedAt ?? null,
    downvotes: Number(comment.downvotes ?? 0),
    editedAt: comment.editedAt ?? null,
    id: comment.id,
    isDeleted: Boolean(comment.deletedAt),
    isMine: Boolean(actor && comment.actorType === actor.actorType && comment.actorId === actor.actorId),
    parentCommentId: comment.parentCommentId ?? null,
    source: comment.source,
    updatedAt: comment.updatedAt,
    upvotes: Number(comment.upvotes ?? 0),
  };
  if (Array.isArray(comment.children)) {
    presented.children = comment.children.map((child) => presentComment(child, actor));
  }
  return presented;
}

/**
 * `hideActorIds` (the portal) drops actor ids; `presentBody` rewrites each body, which the
 * portal uses to replace the ids inside mention tags.
 */
export function presentCommentTree(clarification = {}, actor = null, { hideActorIds = false, presentBody = null } = {}) {
  const strip = (comment) => {
    if (!hideActorIds && !presentBody) return comment;
    const { actorId: _actorId, ...rest } = comment;
    return {
      ...(hideActorIds ? rest : comment),
      ...(presentBody ? { body: presentBody(comment.body ?? '') } : {}),
      children: Array.isArray(comment.children) ? comment.children.map(strip) : undefined,
    };
  };
  return (clarification.comments ?? []).map((comment) => strip(presentComment(comment, actor)));
}

function presentDecisionBrief(decision) {
  if (!decision) return null;
  return {
    decidedAt: decision.decidedAt,
    decidedBy: { name: decision.decidedByName ?? '' },
    id: decision.id,
    outcome: decision.outcome,
    statement: decision.statement,
  };
}

/**
 * Joins clarification views with track metadata, the current topic summaries, the latest
 * summary attempts (any status), and active decisions into register rows.
 */
export function buildTopicRows({
  attempts = [],
  clarifications = [],
  decisions = [],
  meta = [],
  summaries = [],
  track = '',
  userNames = new Map(),
}) {
  const metaById = new Map(meta.map((entry) => [entry.id, entry]));
  const summaryByTopic = new Map(summaries
    .filter((summary) => summary.scopeType === 'topic')
    .map((summary) => [summary.scopeId, summary]));
  const attemptByTopic = new Map(attempts
    .filter((attempt) => attempt.scopeType === 'topic')
    .map((attempt) => [attempt.scopeId, attempt]));
  const activeDecisionByTopic = new Map();
  for (const decision of decisions) {
    if (decision.kind !== 'topic' || !decision.topicId || decision.supersededById) continue;
    activeDecisionByTopic.set(decision.topicId, decision);
  }

  return clarifications
    .filter((clarification) => {
      const entry = metaById.get(clarification.id);
      return entry?.track && (!track || entry.track === track);
    })
    .map((clarification) => {
      const entry = metaById.get(clarification.id);
      const summary = summaryByTopic.get(clarification.id) ?? null;
      const attempt = attemptByTopic.get(clarification.id) ?? null;
      const decision = activeDecisionByTopic.get(clarification.id) ?? null;
      const state = topicState({ status: clarification.status, summary });
      const owner = clarification.primaryAssignment
        ? {
            actorId: clarification.primaryAssignment.actorId,
            actorType: clarification.primaryAssignment.actorType,
            label: clarification.primaryAssignment.label,
          }
        : null;
      return {
        assignments: (clarification.assignments ?? []).map(presentAssignment),
        commentsOpen: topicCommentsOpen({ hasActiveDecision: Boolean(decision), status: clarification.status }),
        createdAt: clarification.createdAt,
        createdBy: describeActorRef(entry.createdBy, userNames),
        decision: presentDecisionBrief(decision),
        decisionId: decision?.id ?? null,
        evidence: topicEvidence(clarification),
        id: clarification.id,
        lastActivityAt: clarification.lastActivityAt ?? null,
        origin: entry.topicOrigin,
        owner,
        prompt: clarification.prompt,
        rationale: clarification.rationale,
        settles: clarification.blockingArea,
        signals: signalCounts(summary, { state }),
        sourceRef: entry.sourceRef,
        state,
        status: clarification.status,
        suggestedOwnerRole: entry.suggestedOwnerRole ?? '',
        summary: summary
          ? {
              createdAt: summary.createdAt,
              id: summary.id,
              insufficientInput: Boolean(summary.output?.insufficientInput),
              proposedAnswer: normalizeString(summary.output?.proposedAnswer),
              proposedAnswerStatus: resolveProposedAnswerStatus({
                proposedAnswer: summary.output?.proposedAnswer,
                status: summary.output?.proposedAnswerStatus,
              }),
            }
          : null,
        summaryStatus: {
          lastAttemptAt: attempt?.createdAt ?? summary?.createdAt ?? null,
          lastAttemptStatus: attempt?.status ?? (summary ? 'ok' : null),
        },
        track: entry.track,
        updatedAt: clarification.updatedAt,
      };
    });
}

const STATE_ORDER = { ready: 0, open: 1, decided: 2, dismissed: 3 };
const READY_TO_RECORD = new Set(READY_TO_RECORD_STATUSES);

/**
 * Among ready topics: agreed or answered by the owner with nothing blocking first, then
 * awaiting confirmation with nothing blocking, then anything with blocking items.
 */
export function readyRank(row) {
  if (row?.state !== 'ready') return 0;
  if ((Number(row.signals?.blocking) || 0) > 0) return 2;
  return READY_TO_RECORD.has(row.summary?.proposedAnswerStatus) ? 0 : 1;
}

export function sortTopicRows(rows = []) {
  return [...rows].sort((left, right) => {
    const stateDifference = (STATE_ORDER[left.state] ?? 9) - (STATE_ORDER[right.state] ?? 9);
    if (stateDifference !== 0) return stateDifference;
    const readyDifference = readyRank(left) - readyRank(right);
    if (readyDifference !== 0) return readyDifference;
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
      || String(left.id).localeCompare(String(right.id));
  });
}

export function filterTopicRows(rows = [], { q = '', view = 'all' } = {}) {
  const needle = normalizePromptText(q);
  return rows.filter((row) => {
    if (view === 'needs-decision' && row.state !== 'ready') return false;
    if (view === 'open' && !['open', 'ready'].includes(row.state)) return false;
    if (view === 'decided' && row.state !== 'decided') return false;
    if (view === 'dismissed' && row.state !== 'dismissed') return false;
    if (view === 'all' && row.state === 'dismissed') return false;
    if (needle) {
      const haystack = normalizePromptText(`${row.prompt} ${row.rationale} ${row.settles} ${row.sourceRef ?? ''}`);
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function countTopicStates(rows = []) {
  const counts = { decided: 0, dismissed: 0, open: 0, ready: 0, total: 0 };
  for (const row of rows) {
    counts[row.state] = (counts[row.state] ?? 0) + 1;
    if (row.state !== 'dismissed') counts.total += 1;
  }
  return counts;
}

/**
 * Source refs a summary cites in its aligned entries and divergent positions, once each, in
 * order. Recording a decision from a summary attaches these, as the Record a decision form does.
 */
export function summarySourceRefs(output) {
  const refs = [];
  const add = (sources) => {
    for (const source of Array.isArray(sources) ? sources : []) {
      const value = String(source ?? '').trim();
      if (value && !refs.includes(value)) refs.push(value);
    }
  };
  for (const entry of Array.isArray(output?.aligned) ? output.aligned : []) add(entry?.sources);
  for (const entry of Array.isArray(output?.divergent) ? output.divergent : []) {
    for (const position of Array.isArray(entry?.positions) ? entry.positions : []) add(position?.sources);
  }
  return refs;
}
