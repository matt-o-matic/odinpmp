// Register rows, topic state, signals, people, and the decision log. Pure helpers over the
// shapes `GET /requirements/tracks/:track/topics` and `/decisions` return.

import { initials } from './annotation-layers.js';
import { plural } from './requirements-tracks.js';

export { initials };

// --- topic state -------------------------------------------------------------

const OUTCOME_LABELS = Object.freeze({
  agreed: 'Agreed',
  decided: 'Decided',
  deferred: 'Deferred',
  superseded: 'Superseded',
});

export function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] ?? 'Decided';
}

/** Chip for a register row or topic header. `long` adds context for the topic header. */
export function topicStateChip(row = {}, { long = false } = {}) {
  switch (row.state) {
    case 'ready':
      return { label: long ? 'Open · ready for a decision' : 'Ready', tone: 'warn' };
    case 'decided':
      return { label: row.decision ? outcomeLabel(row.decision.outcome) : 'Decided', tone: 'ok' };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'outline' };
    default:
      return { label: 'Open', tone: 'neutral' };
  }
}

export function chipToneClass(tone) {
  return {
    bad: 'rq-chip--bad',
    exp: 'rq-chip--exp',
    neutral: 'rq-chip--neutral',
    ok: 'rq-chip--ok',
    outline: 'rq-chip--outline',
    warn: 'rq-chip--warn',
  }[tone] ?? 'rq-chip--neutral';
}

// --- signals -------------------------------------------------------------------

// `blocking` counts the outstanding items that hold the decision up, so it sits beside the
// outstanding total rather than replacing it.
const SIGNALS = Object.freeze([
  { className: 'rq-signal--aligned', key: 'aligned', label: 'aligned', symbol: '✓' },
  { className: 'rq-signal--divergent', key: 'divergent', label: 'diverging', symbol: '⇄' },
  { className: 'rq-signal--under', key: 'underExplored', label: 'under-explored', symbol: '?' },
  { className: 'rq-signal--outstanding', key: 'outstanding', label: 'outstanding', symbol: '!' },
  { className: 'rq-signal--blocking', icon: 'bi-exclamation-octagon-fill', key: 'blocking', label: 'blocking', symbol: '' },
]);

/** Non-zero signal counts in display order, each with an accessible label. */
export function signalBadges(signals = {}) {
  return SIGNALS
    .map((signal) => ({ ...signal, count: Number(signals?.[signal.key]) || 0 }))
    .filter((signal) => signal.count > 0)
    .map((signal) => ({ ...signal, ariaLabel: `${signal.count} ${signal.label}` }));
}

/**
 * True once a topic is decided or dismissed: its summary's outstanding and blocking items no
 * longer hold anything up. A deferred decision keeps the topic open, so it is not settled.
 */
export function topicSettled(row = {}) {
  return row?.state === 'decided' || row?.state === 'dismissed';
}

/** A row's signal counts. Settled rows show no outstanding or blocking count, as the API does. */
export function rowSignals(row = {}) {
  const signals = row?.signals ?? {};
  return topicSettled(row) ? { ...signals, blocking: 0, outstanding: 0 } : signals;
}

export function signalsAriaLabel(signals = {}) {
  const badges = signalBadges(signals);
  return badges.length ? badges.map((badge) => badge.ariaLabel).join(', ') : 'No summary signals yet';
}

/** "9 comments · 4 people" or '' when nobody has contributed. */
export function evidenceLine(evidence = {}) {
  const comments = Number(evidence?.comments) || 0;
  const people = Number(evidence?.contributors) || 0;
  const answers = Number(evidence?.roundAnswers) || 0;
  if (comments === 0 && answers === 0) return '';
  const parts = [plural(comments, 'comment')];
  if (people > 0) parts.push(plural(people, 'person', 'people'));
  if (answers > 0) parts.push(plural(answers, 'round answer'));
  return parts.join(' · ');
}

// --- register filters ------------------------------------------------------------

export const REGISTER_FILTERS = Object.freeze([
  { id: 'all', label: 'Needs a decision first' },
  { id: 'open', label: 'Open' },
  { id: 'decided', label: 'Decided' },
  { id: 'dismissed', label: 'Dismissed' },
]);

const STATE_ORDER = Object.freeze({ dismissed: 3, decided: 2, open: 1, ready: 0 });
const READY_TO_RECORD_STATUSES = new Set(['agreed', 'owner-answered', 'authority-answered']);

function normalizeText(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}

/**
 * Among ready topics, as the API orders them: agreed or answered by the owner with nothing
 * blocking first, then awaiting confirmation with nothing blocking, then anything with
 * blocking items.
 */
export function readyRank(row = {}) {
  if (row?.state !== 'ready') return 0;
  if ((Number(row.signals?.blocking) || 0) > 0) return 2;
  return READY_TO_RECORD_STATUSES.has(row.summary?.proposedAnswerStatus) ? 0 : 1;
}

/**
 * Ready topics first (in `readyRank` order), then open, decided, dismissed; oldest first
 * within a state.
 */
export function sortRegisterRows(rows = []) {
  return [...(rows ?? [])].sort((left, right) => {
    const difference = (STATE_ORDER[left.state] ?? 9) - (STATE_ORDER[right.state] ?? 9);
    if (difference !== 0) return difference;
    const readyDifference = readyRank(left) - readyRank(right);
    if (readyDifference !== 0) return readyDifference;
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
      || String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

/**
 * Client-side register filter over `view=every` rows, mirroring the API's views: `all` hides
 * dismissed topics, `open` keeps open and ready, `decided` keeps decided. `sourceRef` keeps
 * the topics citing one brief line.
 */
export function filterRegisterRows(rows = [], { q = '', sourceRef = '', view = 'all' } = {}) {
  const needle = normalizeText(q);
  return sortRegisterRows((rows ?? []).filter((row) => {
    if (view === 'all' && row.state === 'dismissed') return false;
    if (view === 'open' && !['open', 'ready'].includes(row.state)) return false;
    if (view === 'decided' && row.state !== 'decided') return false;
    if (view === 'needs-decision' && row.state !== 'ready') return false;
    if (view === 'dismissed' && row.state !== 'dismissed') return false;
    if (sourceRef && row.sourceRef !== sourceRef) return false;
    if (needle) {
      const haystack = normalizeText(`${row.prompt} ${row.rationale ?? ''} ${row.settles ?? ''}`);
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }));
}

export function registerFilterCounts(rows = []) {
  const counts = { all: 0, decided: 0, dismissed: 0, open: 0 };
  for (const row of rows ?? []) {
    if (row.state !== 'dismissed') counts.all += 1;
    if (row.state === 'dismissed') counts.dismissed += 1;
    if (row.state === 'open' || row.state === 'ready') counts.open += 1;
    if (row.state === 'decided') counts.decided += 1;
  }
  return counts;
}

/** Message for a "Draft questions from brief" result: what was added and what was skipped. */
export function draftQuestionsSummary(result = {}) {
  const created = Array.isArray(result?.created) ? result.created.length : 0;
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const duplicates = skipped.filter((entry) => entry?.reason === 'duplicate').length;
  const others = skipped.length - duplicates;

  const parts = [created === 0
    ? 'No new questions were added.'
    : `Added ${plural(created, 'question')} from the brief.`];
  if (duplicates > 0) parts.push(`Skipped ${duplicates} that ${duplicates === 1 ? 'repeats an existing topic' : 'repeat existing topics'}.`);
  if (others > 0) parts.push(`Skipped ${plural(others, 'other question')}.`);
  return parts.join(' ');
}

// --- people ------------------------------------------------------------------------

// Each keeps 4.5:1 or better against its own 14% tint (the avatar background).
const AVATAR_COLORS = Object.freeze(['#6d28d9', '#9a3412', '#0369a1', '#3f6212', '#be185d', '#115e59', '#854d0e', '#4338ca']);

export function avatarColor(key) {
  const text = String(key ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function personFromAssignment(assignment = {}) {
  const name = String(assignment.label ?? '').trim() || (assignment.actorType === 'stakeholder' ? 'Stakeholder' : 'Member');
  const ref = `${assignment.actorType}:${assignment.actorId}`;
  return {
    actorId: assignment.actorId,
    actorType: assignment.actorType,
    color: avatarColor(ref),
    initials: initials(name),
    name,
    ref,
    role: assignment.role,
  };
}

/** The topic owner (primary assignment) and everyone else involved. */
export function topicPeople(row = {}) {
  const assignments = Array.isArray(row.assignments) ? row.assignments : [];
  const ownerSource = row.owner
    ? { ...row.owner, role: 'primary' }
    : assignments.find((assignment) => assignment.role === 'primary') ?? null;
  const primary = ownerSource ? personFromAssignment(ownerSource) : null;
  const others = assignments
    .filter((assignment) => !primary || `${assignment.actorType}:${assignment.actorId}` !== primary.ref)
    .map(personFromAssignment);
  return { others, owner: primary };
}

/** People a topic can be assigned to: project members, then the project's stakeholders. */
export function peopleOptions({ stakeholders = [], users = [] } = {}) {
  return [
    ...(users ?? []).filter((user) => user?.id).map((user) => ({
      actorId: String(user.id),
      actorType: 'user',
      detail: user.email ?? '',
      group: 'members',
      key: `user:${user.id}`,
      label: user.name || user.email || 'Member',
    })),
    ...(stakeholders ?? []).filter((stakeholder) => stakeholder?.id).map((stakeholder) => ({
      actorId: String(stakeholder.id),
      actorType: 'stakeholder',
      detail: [stakeholder.roleTitle, stakeholder.email].filter(Boolean).join(' · '),
      group: 'stakeholders',
      key: `stakeholder:${stakeholder.id}`,
      label: stakeholder.name || stakeholder.email || 'Stakeholder',
    })),
  ];
}

/**
 * A topic's people as picker keys: `{ owner: 'user:1' | '', involved: ['stakeholder:2'],
 * required: ['stakeholder:2'] }`. `involved` is everyone but the owner; `required` is the
 * part of it whose answer is required.
 */
export function assignmentKeys(assignments = []) {
  const primary = (assignments ?? []).find((assignment) => assignment.role === 'primary') ?? null;
  const others = (assignments ?? []).filter((assignment) => assignment.role !== 'primary');
  const keyOf = (assignment) => `${assignment.actorType}:${assignment.actorId}`;
  return {
    involved: others.map(keyOf),
    owner: primary ? keyOf(primary) : '',
    required: others.filter((assignment) => assignment.role === 'required').map(keyOf),
  };
}

/** True when two `assignmentKeys` values name the same owner, required people and other people. */
export function sameAssignmentKeys(left, right) {
  const sorted = (keys) => [...new Set(keys ?? [])].sort().join('|');
  return (left?.owner ?? '') === (right?.owner ?? '')
    && sorted(left?.involved) === sorted(right?.involved)
    && sorted(left?.required) === sorted(right?.required);
}

/**
 * The assignments payload for picker keys. Labels come from the options, else from the
 * topic's current assignments (for people no longer offered), else are left blank.
 */
export function assignmentsFromKeys({ current = [], involved = [], options = [], owner = '', required = [] } = {}) {
  const choice = (key) => {
    const option = options.find((entry) => entry.key === key);
    if (option) return { actorId: option.actorId, actorType: option.actorType, label: option.label };
    const assignment = (current ?? []).find((entry) => `${entry.actorType}:${entry.actorId}` === key);
    if (assignment) return { actorId: assignment.actorId, actorType: assignment.actorType, label: assignment.label };
    const [actorType, ...rest] = String(key).split(':');
    return actorType && rest.length ? { actorId: rest.join(':'), actorType, label: '' } : null;
  };
  const requiredKeys = new Set(required ?? []);
  return buildAssignmentsPayload({
    collaborators: involved.filter((key) => !requiredKeys.has(key)).map(choice).filter(Boolean),
    owner: owner ? choice(owner) : null,
    required: involved.filter((key) => requiredKeys.has(key)).map(choice).filter(Boolean),
  });
}

/**
 * Assignment payload for `PATCH /topics/:id` from an owner choice, the people whose answer
 * is required, and other people asked for input. Each choice is `{ actorType, actorId,
 * label }`; nobody is listed twice, and the higher role wins.
 */
export function buildAssignmentsPayload({ collaborators = [], owner = null, required = [] } = {}) {
  const payload = [];
  const seen = new Set();
  const add = (person, role) => {
    const key = `${person?.actorType}:${person?.actorId}`;
    if (!person?.actorId || seen.has(key)) return;
    seen.add(key);
    payload.push({ actorId: person.actorId, actorType: person.actorType, label: person.label ?? '', role });
  };
  if (owner) add(owner, 'primary');
  for (const person of required ?? []) add(person, 'required');
  for (const person of collaborators ?? []) add(person, 'collaborator');
  return payload;
}

// --- decisions -------------------------------------------------------------------------

const STANCE_LABELS = Object.freeze({ change: 'change', keep: 'keep', undecided: 'undecided' });

export function stanceLabel(stance) {
  return STANCE_LABELS[stance] ?? 'undecided';
}

/** Chip for a decision in the log: outcome, or "Preference · keep" for preferences. */
export function decisionChip(decision = {}) {
  if (decision.status === 'superseded') return { label: 'Superseded', tone: 'outline' };
  if (decision.kind === 'preference') {
    const stance = decision.preference?.stance;
    return {
      label: `Preference · ${stanceLabel(stance)}`,
      tone: stance === 'keep' ? 'ok' : stance === 'change' ? 'warn' : 'neutral',
    };
  }
  if (decision.outcome === 'deferred') return { label: 'Deferred', tone: 'neutral' };
  if (decision.outcome === 'superseded') return { label: 'Superseded', tone: 'outline' };
  return { label: outcomeLabel(decision.outcome), tone: 'ok' };
}

/**
 * A proposed preference (by its summary's `scopeType`) or an accepted one (by
 * `preference.origin`) from a review round's screen or round summaries. It stays with its
 * round, which settles it on closing, and is left out of Decide.
 */
export function isRoundPreference(item = {}) {
  if (item?.kind === 'preference') return item.preference?.origin === 'round';
  return item?.scopeType === 'round' || item?.scopeType === 'screen';
}

/**
 * Decision log entries, newest first. The API has no short ids, so each decision gets a
 * display label (D-01, D-02, ...) from its position in the track's full log by decision
 * time. Decisions are superseded rather than deleted, so labels stay stable.
 */
export function buildDecisionLog(decisions = []) {
  const chronological = [...(decisions ?? [])].sort((left, right) => (
    String(left.decidedAt ?? '').localeCompare(String(right.decidedAt ?? ''))
      || String(left.id ?? '').localeCompare(String(right.id ?? ''))
  ));
  const labels = new Map(chronological.map((decision, index) => [decision.id, `D-${String(index + 1).padStart(2, '0')}`]));
  return chronological
    .map((decision) => ({
      ...decision,
      chip: decisionChip(decision),
      label: labels.get(decision.id),
      sourceCount: Array.isArray(decision.sources) ? decision.sources.length : 0,
      supersededByLabel: decision.supersededById ? labels.get(decision.supersededById) ?? '' : '',
      supersedesLabel: decision.supersedesId ? labels.get(decision.supersedesId) ?? '' : '',
    }))
    .reverse();
}

/**
 * Folds a write response into the loaded topic page. Comment writes return the register
 * row plus comments; topic patches return the row alone. Both carry the short summary
 * form, so the full summary and decision history stay unless the summary changed, in
 * which case `stale` asks the caller to refetch.
 */
export function mergeTopicUpdate(current = null, updated = null) {
  if (!updated) return { stale: false, topic: current };
  if (!current) return { stale: true, topic: updated };
  const fullSummary = updated.summary && Object.prototype.hasOwnProperty.call(updated.summary, 'output');
  const summaryChanged = (updated.summary?.id ?? null) !== (current.summary?.id ?? null);
  return {
    stale: !fullSummary && summaryChanged,
    topic: {
      ...current,
      ...updated,
      comments: Array.isArray(updated.comments) ? updated.comments : current.comments,
      decisions: Array.isArray(updated.decisions) ? updated.decisions : current.decisions,
      summary: fullSummary ? updated.summary : current.summary,
    },
  };
}

/** The topic's current decision: the newest one that nothing superseded. */
export function activeTopicDecision(decisions = []) {
  return [...(decisions ?? [])]
    .filter((decision) => decision.status !== 'superseded' && !decision.supersededById)
    .sort((left, right) => String(right.decidedAt ?? '').localeCompare(String(left.decidedAt ?? '')))[0] ?? null;
}

// --- bulk actions -----------------------------------------------------------------

const BULK_DONE_VERBS = Object.freeze({
  agree: 'Agreed on',
  assign: 'Changed people on',
  defer: 'Deferred',
  delete: 'Deleted',
  dismiss: 'Dismissed',
  reopen: 'Reopened',
});

const topicCount = (count) => `${count} ${count === 1 ? 'topic' : 'topics'}`;

/**
 * One line for a bulk result: what was done, then what was skipped or failed, grouped by
 * reason. `{ text, tone }`, tone 'error' when nothing was done.
 */
export function bulkResultMessage(result = {}) {
  const results = Array.isArray(result.results) ? result.results : [];
  const done = results.filter((entry) => entry.status === 'done').length;
  const reasons = new Map();
  for (const entry of results.filter((item) => item.status !== 'done')) {
    const reason = String(entry.message ?? '').replace(/\.$/, '') || 'Could not be changed';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const parts = [done ? `${BULK_DONE_VERBS[result.action] ?? 'Changed'} ${topicCount(done)}.` : 'No topics were changed.'];
  if (reasons.size) {
    const left = results.length - done;
    parts.push(`${topicCount(left)} left as they were: ${[...reasons].map(([reason, count]) => (reasons.size > 1 || count > 1 ? `${reason.toLowerCase()} (${count})` : reason.toLowerCase())).join('; ')}.`);
  }
  return { text: parts.join(' '), tone: done ? 'success' : 'error' };
}

/** A register row's Odin proposed answer, from the list row or its summary output. */
export function rowProposedAnswer(row = {}) {
  return String(row.summary?.proposedAnswer || row.summary?.output?.proposedAnswer || '').trim();
}

const PROPOSED_ANSWER_STATUSES = new Set(['agreed', 'owner-answered', 'authority-answered', 'awaiting-confirmation']);

/**
 * How settled a proposed answer is: 'none' without an answer, else the stored status.
 * Summaries stored before the status existed carry none and read as 'agreed', as the API
 * reads them.
 */
export function resolveProposedAnswerStatus({ proposedAnswer = '', status } = {}) {
  if (!String(proposedAnswer ?? '').trim()) return 'none';
  if (PROPOSED_ANSWER_STATUSES.has(status)) return status;
  return status == null ? 'agreed' : 'awaiting-confirmation';
}

/** A register row's proposed-answer status, from the list row or its summary output. */
export function rowProposedAnswerStatus(row = {}) {
  return resolveProposedAnswerStatus({
    proposedAnswer: rowProposedAnswer(row),
    status: row.summary?.proposedAnswerStatus ?? row.summary?.output?.proposedAnswerStatus,
  });
}
