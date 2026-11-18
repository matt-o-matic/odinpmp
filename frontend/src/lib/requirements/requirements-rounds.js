// Review rounds for the team: the rounds list, the publish form,
// the round header, reviewer progress, the verdict grid, direction preferences, summary
// sources, and proposed preferences. Pure helpers over the shapes the rounds API returns
// (backend/src/modules/requirements/rounds/rounds.service.js).
//
// Silence is never agreement: a reviewer who gave no verdict on a screen is "Not reviewed"
// and is never counted toward any verdict.

import { commentPlainText } from '../rich-content/comment-markdown.js';
import { formatShortDate, isPast } from './requirements-time.js';
import { avatarColor, initials } from './requirements-topics.js';
import { plural, trackLabel } from './requirements-tracks.js';

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export const VERDICT_VALUES = Object.freeze(['keep', 'keep-with-changes', 'change', 'undecided']);

export const VERDICT_META = Object.freeze({
  change: { className: 'rq-vcell--change', label: 'Change', short: 'CHANGE' },
  keep: { className: 'rq-vcell--keep', label: 'Keep', short: 'KEEP' },
  'keep-with-changes': { className: 'rq-vcell--keepchg', label: 'Keep with changes', short: 'KEEP+' },
  undecided: { className: 'rq-vcell--undecided', label: 'Undecided', short: 'UNSURE' },
});

export const NOT_REVIEWED = Object.freeze({ className: 'rq-vcell--none', label: 'Not reviewed', short: '—' });

/** Legend entries in display order, ending with Not reviewed. */
export const VERDICT_LEGEND = Object.freeze([
  ...VERDICT_VALUES.map((value) => ({ key: value, ...VERDICT_META[value] })),
  { key: 'none', ...NOT_REVIEWED },
]);

export function verdictMeta(value) {
  return VERDICT_META[value] ?? NOT_REVIEWED;
}

function emptyTally() {
  return { change: 0, keep: 0, 'keep-with-changes': 0, notReviewed: 0, reviewed: 0, undecided: 0 };
}

/**
 * "3 keep · 1 change · 1 not reviewed". Not reviewed is listed on its own and never folded
 * into a verdict.
 */
export function describeTally(tally = emptyTally()) {
  const parts = VERDICT_VALUES
    .filter((value) => Number(tally[value]) > 0)
    .map((value) => `${tally[value]} ${VERDICT_META[value].label.toLowerCase()}`);
  if (Number(tally.notReviewed) > 0) parts.push(`${tally.notReviewed} not reviewed`);
  return parts.length ? parts.join(' · ') : 'No reviewers';
}

/**
 * The verdict a screen's reviewers agree on, or null. Agreement needs every reviewer in the
 * grid to have given the same verdict: anyone who has not reviewed the screen blocks it.
 */
export function screenAgreement(tally = emptyTally()) {
  if (Number(tally.notReviewed) > 0 || Number(tally.reviewed) === 0) return null;
  return VERDICT_VALUES.find((value) => Number(tally[value]) === Number(tally.reviewed)) ?? null;
}

/**
 * Reviewers × screens from `GET /rounds/:id/results`. Rows follow the API's grid (every
 * active reviewer plus anyone removed who left verdicts); columns follow the manifest. A
 * missing verdict is a Not reviewed cell, never a default.
 */
export function buildVerdictGrid(results = {}) {
  const screens = list(results?.screens);
  const reviewers = list(results?.reviewers);
  const byRef = new Map(reviewers.map((reviewer) => [reviewer.actorRef, reviewer]));
  const counts = results?.annotationCounts ?? {};

  let gridRows = list(results?.grid);
  if (gridRows.length === 0) {
    gridRows = reviewers.filter((reviewer) => !reviewer.removedAt).map((reviewer) => ({ actorRef: reviewer.actorRef, name: reviewer.name, verdicts: {} }));
  }

  const rows = gridRows.map((row) => {
    const reviewer = byRef.get(row.actorRef) ?? null;
    const name = text(row.name) || text(reviewer?.name) || (String(row.actorRef ?? '').startsWith('stakeholder:') ? 'Stakeholder' : 'Team member');
    const cells = screens.map((screen) => {
      const verdict = row.verdicts?.[screen.screenId] ?? null;
      const value = verdict && VERDICT_META[verdict.overall] ? verdict.overall : null;
      return {
        notReviewed: value === null,
        screenId: screen.screenId,
        value,
        verdict: value ? verdict : null,
        ...verdictMeta(value),
      };
    });
    return {
      actorRef: row.actorRef,
      cells,
      external: String(row.actorRef ?? '').startsWith('stakeholder:'),
      name,
      person: { color: avatarColor(row.actorRef), initials: initials(name), name, ref: row.actorRef },
      removed: Boolean(reviewer?.removedAt),
      required: Boolean(reviewer?.required),
      submitted: Boolean(reviewer?.submittedAt),
    };
  });

  const columns = screens.map((screen, index) => {
    const tally = emptyTally();
    for (const row of rows) {
      const cell = row.cells[index];
      if (cell.notReviewed) tally.notReviewed += 1;
      else {
        tally[cell.value] += 1;
        tally.reviewed += 1;
      }
    }
    const marks = Number(counts?.[screen.screenId]?.total) || 0;
    return {
      agreement: screenAgreement(tally),
      directionId: screen.directionId ?? null,
      kind: screen.kind,
      marks,
      marksText: plural(marks, 'mark'),
      screenId: screen.screenId,
      tally,
      tallyText: describeTally(tally),
      title: text(screen.title) || screen.screenId,
    };
  });

  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

export const STANCE_LABELS = Object.freeze({ acceptable: 'Acceptable', preferred: 'Preferred', rejected: 'Rejected' });

/** "A", "B", ... for direction letters in the preference bar. */
export function directionLetter(index) {
  const value = Number(index) || 0;
  return value < 26 ? String.fromCharCode(65 + value) : String(value + 1);
}

/**
 * Direction preferences for the bar under the grid. Each reviewer counts once per direction
 * they marked preferred. Reviewers who answered but preferred none are "No preference";
 * active reviewers who gave no stance at all are "Not answered" and never counted for a
 * direction.
 */
export function buildDirectionPreference(results = {}) {
  const directions = list(results?.directions);
  const reviewers = list(results?.reviewers).filter((reviewer) => !reviewer.removedAt);
  const people = new Map(reviewers.map((reviewer) => [reviewer.actorRef, reviewer.name]));
  for (const direction of directions) {
    for (const stance of list(direction.stances)) {
      if (!people.has(stance.actorRef)) people.set(stance.actorRef, stance.name);
    }
  }

  const answered = new Set();
  const preferredBy = new Map();
  for (const direction of directions) {
    for (const stance of list(direction.stances)) {
      answered.add(stance.actorRef);
      if (stance.stance === 'preferred') {
        if (!preferredBy.has(stance.actorRef)) preferredBy.set(stance.actorRef, []);
        preferredBy.get(stance.actorRef).push(direction.directionId);
      }
    }
  }

  const total = people.size;
  const noPreference = [...answered].filter((ref) => !preferredBy.has(ref)).length;
  const notAnswered = [...people.keys()].filter((ref) => !answered.has(ref)).length;

  const rows = directions.map((direction, index) => {
    const tallies = {
      acceptable: Number(direction.tallies?.acceptable) || 0,
      preferred: Number(direction.tallies?.preferred) || 0,
      rejected: Number(direction.tallies?.rejected) || 0,
    };
    return {
      directionId: direction.directionId,
      letter: directionLetter(index),
      remixNotes: list(direction.remixNotes).filter((note) => text(note.remix)).map((note) => ({ name: text(note.name) || 'Reviewer', remix: text(note.remix) })),
      tallies,
      talliesText: `${tallies.preferred} preferred · ${tallies.acceptable} acceptable · ${tallies.rejected} rejected`,
      title: text(direction.title) || direction.directionId,
    };
  });

  const segments = [
    ...rows.filter((row) => row.tallies.preferred > 0).map((row) => ({
      count: row.tallies.preferred,
      key: `direction:${row.directionId}`,
      kind: 'direction',
      label: `${row.letter} · ${row.title} · ${row.tallies.preferred}`,
      letter: row.letter,
    })),
    ...(noPreference > 0 ? [{ count: noPreference, key: 'none', kind: 'none', label: `No preference · ${noPreference}` }] : []),
    ...(notAnswered > 0 ? [{ count: notAnswered, key: 'unanswered', kind: 'unanswered', label: `Not answered · ${notAnswered}` }] : []),
  ];
  const segmentTotal = segments.reduce((sum, segment) => sum + segment.count, 0);
  for (const segment of segments) segment.percent = segmentTotal > 0 ? Math.round((segment.count / segmentTotal) * 1000) / 10 : 0;

  return {
    answered: answered.size,
    answeredText: `${answered.size} of ${total} answered`,
    noPreference,
    notAnswered,
    rows,
    segments,
    total,
  };
}

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------

/** Submitted counts over active (not removed) reviewers, plus who still owes a review. */
export function reviewerCounts(reviewers = []) {
  const active = list(reviewers).filter((reviewer) => !reviewer.removedAt);
  const submitted = active.filter((reviewer) => reviewer.submittedAt);
  const required = active.filter((reviewer) => reviewer.required);
  return {
    notSubmitted: active.filter((reviewer) => !reviewer.submittedAt),
    required: required.length,
    requiredSubmitted: required.filter((reviewer) => reviewer.submittedAt).length,
    submitted: submitted.length,
    total: active.length,
  };
}

export function submittedText(counts = {}) {
  return `${Number(counts.submitted) || 0} of ${Number(counts.total) || 0} submitted`;
}

/** One reviewer's review status for the reviewers panel. */
export function reviewerStatus(reviewer = {}) {
  if (reviewer.removedAt) return { key: 'removed', label: 'Removed', tone: 'outline' };
  if (reviewer.submittedAt) return { key: 'submitted', label: 'Submitted', tone: 'ok' };
  const done = Number(reviewer.progress?.done) || 0;
  const total = Number(reviewer.progress?.total) || 0;
  if (done > 0) return { key: 'progress', label: total > 0 ? `In progress · ${done} of ${total}` : 'In progress', tone: 'exp' };
  if (reviewer.lastSeenAt) return { key: 'opened', label: 'Opened, nothing given yet', tone: 'neutral' };
  return { key: 'not-started', label: 'Not started', tone: 'neutral' };
}

const MAIL_REASONS = Object.freeze({
  'delivery-failed': 'the email bounced',
  'link-revoked': 'their link is revoked',
  'mail-not-configured': 'email isn’t set up on this server',
  'no-email': 'no email address on file',
  'queue-error': 'the email couldn’t be queued',
  'reviewer-not-found': 'the person wasn’t found',
});

/** Invitation delivery for one reviewer: `{ label, tone, problem }`. Failed and not-sent offer Resend. */
export function mailStatus(mail = null) {
  const status = mail?.status ?? 'not-sent';
  const reason = MAIL_REASONS[mail?.reason] ?? '';
  if (status === 'sent') return { label: 'Invitation sent', problem: false, tone: 'ok' };
  if (status === 'queued') return { label: 'Invitation queued', problem: false, tone: 'neutral' };
  if (status === 'failed') return { label: reason ? `Email failed: ${reason}` : 'Email failed', problem: true, tone: 'bad' };
  return { label: reason ? `Not sent: ${reason}` : 'Not sent', problem: true, tone: 'warn' };
}

export function reviewerKindLabel(reviewer = {}) {
  if (reviewer.actorType === 'stakeholder') return 'external · link';
  const role = text(reviewer.role).toLowerCase();
  return role && role !== 'user' ? role : 'member';
}

// ---------------------------------------------------------------------------
// Round header and list
// ---------------------------------------------------------------------------

export const ROUND_OUTCOMES = Object.freeze([
  { help: 'One direction goes forward. Name it below.', key: 'direction-chosen', label: 'Direction chosen' },
  { help: 'The screens are good as they are.', key: 'screens-accepted', label: 'Screens accepted' },
  { help: 'The next version needs changes before anyone accepts it.', key: 'changes-requested', label: 'Changes requested' },
  { help: 'The round stops without a result.', key: 'abandoned', label: 'Abandoned' },
]);

export function outcomeLabel(outcome) {
  return ROUND_OUTCOMES.find((entry) => entry.key === outcome)?.label ?? 'Closed';
}

/** Outcomes a round can close with: "direction chosen" only when the package has directions. */
export function availableOutcomes(directions = []) {
  return list(directions).length > 0 ? ROUND_OUTCOMES : ROUND_OUTCOMES.filter((entry) => entry.key !== 'direction-chosen');
}

/** The text a close records when nobody writes a statement (matches the API's default). */
export function defaultCloseStatement({ directionTitle = '', number, outcome }) {
  const body = {
    abandoned: 'Round abandoned.',
    'changes-requested': 'Changes requested.',
    'direction-chosen': `Direction chosen: ${directionTitle || 'a direction'}.`,
    'screens-accepted': 'Screens accepted.',
  }[outcome] ?? 'Closed.';
  return `Round ${number}: ${body}`;
}

/** Validates a close form. Returns '' when it can be sent, else the message to show. */
export function closeFormError({ directionId = '', outcome = '' } = {}) {
  if (!ROUND_OUTCOMES.some((entry) => entry.key === outcome)) return 'Choose how the round ends.';
  if (outcome === 'direction-chosen' && !text(directionId)) return 'Choose the direction that goes forward.';
  return '';
}

export function closePayload({ directionId = '', outcome, statement = '' } = {}) {
  return {
    directionId: outcome === 'direction-chosen' ? text(directionId) : '',
    outcome,
    statement: text(statement),
  };
}

/**
 * What closing did to the round's questions, as a sentence to append to the close message:
 * " 3 questions decided from Odin’s answers, 1 deferred.", or '' when it touched none.
 */
export function closedTopicsText({ decided = 0, deferred = 0 } = {}) {
  const decidedCount = Number(decided) || 0;
  const deferredCount = Number(deferred) || 0;
  if (decidedCount > 0) {
    return ` ${plural(decidedCount, 'question')} decided from Odin’s answers${deferredCount > 0 ? `, ${deferredCount} deferred` : ''}.`;
  }
  return deferredCount > 0 ? ` ${plural(deferredCount, 'question')} deferred.` : '';
}

/** Status chip for a round: "Open · closes Fri, Oct 10", "Open · was due ...", "Closed · Screens accepted". */
export function roundStatusChip(round = {}, { locale, now = new Date() } = {}) {
  if (round.status === 'closed') return { label: `Closed · ${outcomeLabel(round.outcome)}`, tone: 'neutral' };
  if (round.status !== 'open') return { label: 'Draft', tone: 'outline' };
  if (!round.dueAt) return { label: 'Open · no due date', tone: 'solid' };
  const date = formatShortDate(round.dueAt, { locale, weekday: true });
  if (isPast(round.dueAt, { now })) return { label: `Open · was due ${date}`, tone: 'warn' };
  return { label: `Open · closes ${date}`, tone: 'solid' };
}

/** Open rounds first, then newest number first. */
export function sortRounds(rounds = []) {
  return [...list(rounds)].sort((left, right) => {
    const open = (left?.status === 'open' ? 0 : 1) - (right?.status === 'open' ? 0 : 1);
    if (open !== 0) return open;
    return (Number(right?.number) || 0) - (Number(left?.number) || 0);
  });
}

export function nextRoundNumber(rounds = []) {
  return Math.max(0, ...list(rounds).map((round) => Number(round?.number) || 0)) + 1;
}

export function openRoundOf(rounds = []) {
  return list(rounds).find((round) => round?.status === 'open') ?? null;
}

/** "Package v2 · 3 of 5 submitted · due Fri, Oct 10" for a round row. */
export function roundMetaLine(round = {}, { locale } = {}) {
  const parts = [];
  if (round.packageVersion != null) parts.push(`package v${round.packageVersion}`);
  const counts = round.counts ?? {};
  parts.push(submittedText({ submitted: counts.submitted, total: counts.reviewers }));
  if (round.status === 'closed' && round.closedAt) parts.push(`closed ${formatShortDate(round.closedAt, { locale })}`);
  else if (round.dueAt) parts.push(`due ${formatShortDate(round.dueAt, { locale, weekday: true })}`);
  return parts.join(' · ');
}

/** Total marks across screens and comment count, for the round header. */
export function annotationTotals(annotationCounts = {}) {
  return Object.values(annotationCounts ?? {}).reduce((sum, counts) => sum + (Number(counts?.total) || 0), 0);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const REVIEWER_PROJECT_ROLES_EXCLUDED = new Set(['viewer']);

/**
 * People who can review: project members (member and up) and project stakeholders.
 * External stakeholders first, then members, each by name. `links` (optional, decision
 * rights only) marks stakeholders whose link was revoked.
 */
export function buildReviewerCandidates({ links = [], stakeholders = [], users = [] } = {}) {
  const linkByStakeholder = new Map(list(links).map((link) => [link?.stakeholder?.id, link]));
  const external = list(stakeholders)
    .filter((stakeholder) => stakeholder?.id)
    .map((stakeholder) => {
      const name = text(stakeholder.name) || text(stakeholder.email) || 'Stakeholder';
      const link = linkByStakeholder.get(stakeholder.id) ?? null;
      return {
        actorId: String(stakeholder.id),
        actorType: 'stakeholder',
        email: text(stakeholder.email),
        external: true,
        key: `stakeholder:${stakeholder.id}`,
        kindLabel: 'external · link',
        linkRevoked: Boolean(link?.revokedAt) || link?.status === 'revoked',
        name,
        person: { color: avatarColor(`stakeholder:${stakeholder.id}`), initials: initials(name), name, ref: `stakeholder:${stakeholder.id}` },
      };
    });
  const seen = new Set();
  const members = list(users)
    .filter((user) => user?.id && !REVIEWER_PROJECT_ROLES_EXCLUDED.has(text(user.role).toLowerCase()))
    .filter((user) => (seen.has(user.id) ? false : seen.add(user.id)))
    .map((user) => {
      const name = text(user.name) || text(user.email) || 'Team member';
      return {
        actorId: String(user.id),
        actorType: 'user',
        email: text(user.email),
        external: false,
        key: `user:${user.id}`,
        kindLabel: reviewerKindLabel({ actorType: 'user', role: user.role }),
        linkRevoked: false,
        name,
        person: { color: avatarColor(`user:${user.id}`), initials: initials(name), name, ref: `user:${user.id}` },
      };
    });
  const byName = (left, right) => left.name.localeCompare(right.name);
  return [...external.sort(byName), ...members.sort(byName)];
}

/**
 * The line under the Ask section: "Publishing emails 3 external reviewers and notifies 2
 * members." Members are emailed too, but the design calls that a notification.
 */
export function publishSummaryLine({ externalCount = 0, memberCount = 0 } = {}) {
  const external = Number(externalCount) || 0;
  const members = Number(memberCount) || 0;
  if (external === 0 && members === 0) return 'Choose at least one reviewer.';
  const emails = external > 0 ? `emails ${plural(external, 'external reviewer')}` : '';
  const notifies = members > 0 ? `notifies ${plural(members, 'member')}` : '';
  return `Publishing ${[emails, notifies].filter(Boolean).join(' and ')}.`;
}

export const REMINDER_OPTIONS = Object.freeze([
  { label: 'No reminder', value: '' },
  { label: '1 day before, to anyone not submitted', value: '1' },
  { label: '2 days before, to anyone not submitted', value: '2' },
  { label: '3 days before, to anyone not submitted', value: '3' },
  { label: '7 days before, to anyone not submitted', value: '7' },
]);

/** `yyyy-mm-ddThh:mm` for a datetime-local input, in local time. */
export function toDateTimeInputValue(value) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value as an ISO timestamp, or '' when it isn't a date. */
export function fromDateTimeInputValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text(value));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

/** Default due date: a week from now at 5 pm local time. */
export function defaultDueInputValue(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 17, 0, 0, 0);
  return toDateTimeInputValue(date);
}

/** Problems with the publish form, in field order. Empty when it can be sent. */
export function publishFormErrors({ due = '', now = new Date(), reminder = '', selected = [] } = {}) {
  const errors = {};
  if (list(selected).length === 0) errors.reviewers = 'Choose at least one reviewer.';
  const dueAt = fromDateTimeInputValue(due);
  if (text(due) && !dueAt) errors.due = 'Enter a due date and time.';
  else if (dueAt && Date.parse(dueAt) <= now.valueOf()) errors.due = 'Choose a due date in the future.';
  if (text(reminder) && !dueAt) errors.reminder = 'A reminder needs a due date.';
  return errors;
}

export function publishPayload({ closePrevious = null, due = '', note = '', packageId, reminder = '', selected = [] } = {}) {
  const dueAt = fromDateTimeInputValue(due) || null;
  const days = Number(reminder);
  return {
    ...(closePrevious ? { closePrevious } : {}),
    dueAt,
    note: text(note),
    packageId,
    reminder: dueAt && Number.isInteger(days) && days > 0 ? { daysBefore: days } : null,
    reviewers: list(selected).map((entry) => ({ actorId: entry.actorId, actorType: entry.actorType, required: Boolean(entry.required) })),
  };
}

/**
 * `PATCH /rounds/:id` body from the edit form, with only what changed. Returns
 * `{ errors, payload }`; `payload` is null when nothing changed.
 * `original`: { dueAt, reminder: { daysBefore } | null, note, reviewers: [{ id, required, removedAt }] }.
 * `form`: { due, reminder, note, reviewers: [{ id, required, remove }], added: [{ actorId, actorType, required }] }.
 */
export function roundPatch({ form = {}, now = new Date(), original = {} } = {}) {
  const errors = {};
  const payload = {};
  const originalDue = toDateTimeInputValue(original.dueAt);
  const due = text(form.due);
  const dueAt = fromDateTimeInputValue(due);
  if (due !== originalDue) {
    if (due && !dueAt) errors.due = 'Enter a due date and time.';
    else if (dueAt && Date.parse(dueAt) <= now.valueOf()) errors.due = 'Choose a due date in the future.';
    else payload.dueAt = dueAt || null;
  }
  const originalReminder = original.reminder?.daysBefore ? String(original.reminder.daysBefore) : '';
  const reminder = text(form.reminder);
  const dueAfter = due ? dueAt : '';
  if (reminder && !dueAfter) errors.reminder = 'A reminder needs a due date.';
  else if (reminder !== originalReminder) payload.reminder = reminder ? { daysBefore: Number(reminder) } : null;
  if (form.note !== undefined && text(form.note) !== text(original.note)) payload.note = text(form.note);

  const before = new Map(list(original.reviewers).map((reviewer) => [reviewer.id, reviewer]));
  const remove = list(form.reviewers).filter((reviewer) => reviewer.remove && before.has(reviewer.id) && !before.get(reviewer.id).removedAt).map((reviewer) => reviewer.id);
  const update = list(form.reviewers)
    .filter((reviewer) => !reviewer.remove && before.has(reviewer.id) && Boolean(before.get(reviewer.id).required) !== Boolean(reviewer.required))
    .map((reviewer) => ({ id: reviewer.id, required: Boolean(reviewer.required) }));
  const add = list(form.added).map((entry) => ({ actorId: entry.actorId, actorType: entry.actorType, required: Boolean(entry.required) }));
  if (remove.length) payload.removeReviewerIds = remove;
  if (update.length) payload.updateReviewers = update;
  if (add.length) payload.addReviewers = add;

  const remaining = list(original.reviewers).filter((reviewer) => !reviewer.removedAt && !remove.includes(reviewer.id)).length + add.length;
  if (remaining === 0) errors.reviewers = 'Keep at least one reviewer on the round.';

  return { errors, payload: Object.keys(payload).length > 0 ? payload : null };
}

/**
 * Publish failures the form handles itself. `round_open` offers "Close round N first" to
 * people with decision rights; the rest explain what to fix.
 */
export function describePublishError(error, { canDecide = false, candidates = [] } = {}) {
  const data = error?.data ?? {};
  const details = data.details && !Array.isArray(data.details) ? data.details : {};
  const code = typeof details.code === 'string' ? details.code : '';
  if (code === 'round_open') {
    const number = details.openRoundNumber ?? null;
    const label = number ? `Round ${number}` : 'Another round';
    return {
      code,
      message: canDecide
        ? `${label} is still open for this track. Close it first, then this package is published as the next round.`
        : `${label} is still open for this track. An admin or manager has to close it before another round can be published.`,
      openRound: { id: details.openRoundId ?? null, number },
    };
  }
  if (code === 'question_topic_missing') {
    const ids = list(details.questionIds);
    return {
      code,
      message: `${ids.length === 1 ? 'A question in this package links' : 'Some questions in this package link'} to a topic that was deleted or belongs to the other track${ids.length ? ` (${ids.join(', ')})` : ''}. Upload a corrected package, or ask the package author to fix the topic links.`,
      questionIds: ids,
    };
  }
  if (code === 'reviewer_invalid') {
    const candidate = list(candidates).find((entry) => entry.actorId === details.actorId) ?? null;
    return {
      actorId: details.actorId ?? null,
      code,
      message: candidate
        ? `${candidate.name} can’t review this round: ${candidate.external ? 'they are no longer a stakeholder of this project' : 'they need member access or above on this project'}. Remove them and publish again.`
        : 'One of the reviewers can’t review this round. Reload the page and choose again.',
    };
  }
  if (code === 'package_not_draft') {
    return { code, message: 'This package was already published or withdrawn, so it can’t be published again. Upload a new version instead.' };
  }
  return null;
}

/**
 * What publishing did: who was invited, whose invitation didn't go out, then what happened
 * to earlier annotations and package questions.
 */
export function publishResultLines(result = {}) {
  const lines = [];
  const reviewers = list(result.round?.reviewers).filter((reviewer) => !reviewer.removedAt);
  if (reviewers.length > 0) {
    const external = reviewers.filter((reviewer) => reviewer.actorType === 'stakeholder').length;
    const members = reviewers.length - external;
    const who = [external ? plural(external, 'external reviewer') : '', members ? plural(members, 'member') : ''].filter(Boolean).join(' and ');
    lines.push(`Invited ${who}.`);
    const problems = reviewers.filter((reviewer) => mailStatus(reviewer.mail).problem);
    if (problems.length > 0) {
      lines.push(`Not emailed: ${problems.map((reviewer) => `${reviewer.name} (${mailStatus(reviewer.mail).label.replace(/^(Not sent|Email failed): /, '')})`).join(', ')}. Resend from the round once it’s fixed.`);
    }
  }
  const carry = result.carryForward ?? {};
  const carried = Number(carry.carried) || 0;
  const outdated = Number(carry.outdated) || 0;
  const superseded = Number(carry.superseded) || 0;
  if (carried + outdated + superseded > 0) {
    lines.push(`From the previous round: ${plural(carried, 'annotation')} carried forward, ${outdated} outdated, ${superseded} superseded.`);
  } else {
    lines.push('No annotations from a previous round to carry forward.');
  }
  const created = list(result.createdTopicIds).length;
  if (created > 0) lines.push(`${plural(created, 'new topic')} created for package questions.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function initialsOf(name) {
  return initials(name || '?');
}

/**
 * Display chips for one summary entry's sources, using the `current.sources` lookup the
 * results API resolves. Annotations show their number, comments their label, and verdicts,
 * direction stances, and answers the person who gave them.
 */
export function roundSourceChips(refs = [], { lookup = [], people = new Map(), screenTitles = {}, showScreen = false } = {}) {
  const byRef = new Map(list(lookup).map((source) => [source.ref, source]));
  const chips = [];
  const seen = new Set();
  for (const ref of list(refs)) {
    const key = text(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const source = byRef.get(key) ?? null;
    if (!source || source.available === false) {
      chips.push({ ariaLabel: 'Source no longer available', label: 'Removed', ref: key, removed: true });
      continue;
    }
    const screen = source.screenId ? text(screenTitles[source.screenId]) : '';
    const name = source.actorRef ? text(people.get(source.actorRef)) || 'a reviewer' : '';
    switch (source.kind) {
      case 'annotation': {
        const number = text(source.label).replace(/^#/, '');
        chips.push({
          ariaLabel: `Annotation ${number}${screen ? ` on ${screen}` : ''}`,
          label: showScreen && screen ? `${screen} #${number}` : `#${number}`,
          ref: key,
        });
        break;
      }
      case 'comment':
        chips.push({ ariaLabel: `Annotation comment ${text(source.label)}${screen ? ` on ${screen}` : ''}`, label: text(source.label) || 'Comment', ref: key });
        break;
      case 'verdict':
        chips.push({ ariaLabel: `Verdict by ${name}${screen ? ` on ${screen}` : ''}`, label: `V-${initialsOf(name)}`, name, ref: key });
        break;
      case 'direction':
        chips.push({ ariaLabel: `Direction choice by ${name}`, label: `D-${initialsOf(name)}`, name, ref: key });
        break;
      case 'answer':
        chips.push({ ariaLabel: `Answer by ${name}`, label: `Q-${initialsOf(name)}`, name, ref: key });
        break;
      default:
        chips.push({ ariaLabel: `Source ${text(source.label) || key}`, label: text(source.label) || 'Source', ref: key });
    }
  }
  return chips;
}

/** Names behind a list of chips, for the visible "from Jamie Ortiz, Sam Patel" text. */
export function chipPeople(chips = []) {
  const names = [];
  for (const chip of list(chips)) if (chip.name && !names.includes(chip.name)) names.push(chip.name);
  return names;
}

/** Map(actorRef -> name) from round reviewers, grid rows, and direction stances. */
export function roundPeople(results = {}) {
  const people = new Map();
  for (const reviewer of list(results?.reviewers)) if (reviewer.actorRef) people.set(reviewer.actorRef, reviewer.name);
  for (const row of list(results?.grid)) if (row.actorRef && !people.has(row.actorRef)) people.set(row.actorRef, row.name);
  for (const direction of list(results?.directions)) {
    for (const stance of list(direction.stances)) if (stance.actorRef && !people.has(stance.actorRef)) people.set(stance.actorRef, stance.name);
  }
  for (const question of list(results?.questions)) {
    for (const answer of list(question.answers)) if (answer.actorRef && !people.has(answer.actorRef)) people.set(answer.actorRef, answer.name);
  }
  return people;
}

// ---------------------------------------------------------------------------
// Questions and proposed preferences
// ---------------------------------------------------------------------------

/** One question's answers plus the active reviewers who have not answered it. */
export function questionRows(results = {}) {
  const active = list(results?.reviewers).filter((reviewer) => !reviewer.removedAt);
  return list(results?.questions).map((question) => {
    const answers = list(question.answers).map((answer) => ({ ...answer, name: text(answer.name) || 'Reviewer' }));
    const answeredRefs = new Set(answers.map((answer) => answer.actorRef));
    const missing = active.filter((reviewer) => !answeredRefs.has(reviewer.actorRef)).map((reviewer) => reviewer.name);
    return {
      answers,
      answersText: `${answers.length} of ${active.length} answered`,
      kind: question.kind,
      missing,
      prompt: text(question.prompt),
      questionId: question.questionId,
      topicId: question.topicId ?? null,
    };
  });
}

/** Proposed preferences that came from this round's summary or one of its screens. */
export function proposalsForRound(proposed = [], roundId = '', { screenTitles = {} } = {}) {
  const id = text(roundId);
  if (!id) return [];
  return list(proposed)
    .filter((item) => (item.scopeType === 'round' && item.scopeId === id) || (item.scopeType === 'screen' && String(item.scopeId ?? '').startsWith(`${id}:`)))
    .map((item) => {
      const screenId = item.scopeType === 'screen' ? String(item.scopeId).slice(id.length + 1) : null;
      return {
        ...item,
        origin: screenId ? `from ${text(screenTitles[screenId]) || 'a screen'}` : 'from the round summary',
        screenId,
      };
    });
}

/**
 * "Ask in next round" has no draft-round store in the API, so it builds text to paste into
 * the next package's questions or the next round's note.
 */
export function askInNextRoundText({ item = {}, nextNumber, round = {}, track = '' } = {}) {
  const statement = text(item.statement);
  const lines = [
    `Ask in round ${nextNumber} (${trackLabel(track || round.track)}): ${statement}${/[?.!]$/.test(statement) ? '' : '?'}`,
  ];
  const context = [];
  if (item.dimension) context.push(`dimension: ${item.dimension}`);
  context.push(`round ${round.number ?? '?'} ${item.screenId ? `screen "${item.screenTitle || item.screenId}"` : 'summary'} left it undecided`);
  lines.push(`Context: ${context.join('; ')}.`);
  return lines.join('\n');
}

// Marks and comments ------------------------------------------------------------

const CLOSED_MARK_STATUSES = new Set(['resolved', 'superseded', 'outdated']);

function feedbackHaystack(parts) {
  return parts.map((part) => text(part).toLowerCase()).join('\n');
}

/**
 * The round's annotations, their comments, and the written screen notes, grouped by screen in
 * package order for the "Marks and comments" view. Filters apply together: `screenId`,
 * `reviewer` (an actor ref: their marks, marks they commented on, and their notes), `query`
 * (any text in a mark, its thread, or a note), and `showResolved` (resolved, superseded,
 * and outdated marks). Screens with nothing left are dropped.
 * Returns { groups: [{ screenId, title, annotations, notes }], counts: { marks, comments, notes } }.
 */
export function groupRoundFeedback(data = {}, { query = '', reviewer = '', screenId = '', showResolved = false } = {}) {
  const needle = text(query).toLowerCase();
  const annotations = list(data.annotations).filter((annotation) => {
    if (screenId && annotation.screenId !== screenId) return false;
    if (!showResolved && CLOSED_MARK_STATUSES.has(annotation.status)) return false;
    if (reviewer && annotation.authorRef !== reviewer && !list(annotation.thread).some((comment) => comment.authorRef === reviewer)) return false;
    if (!needle) return true;
    return feedbackHaystack([
      annotation.authorName, annotation.categoryLabel, annotation.stateLabel, annotation.elementText, annotation.note,
      ...list(annotation.labels), ...list(annotation.thread).flatMap((comment) => [comment.authorName, comment.body]),
    ]).includes(needle);
  });
  const notes = list(data.notes).filter((note) => {
    if (screenId && note.screenId !== screenId) return false;
    if (reviewer && note.actorRef !== reviewer) return false;
    return !needle || feedbackHaystack([note.name, note.stay, note.change, note.mixed]).includes(needle);
  });
  const groups = list(data.screens)
    .map((screen) => ({
      annotations: annotations.filter((annotation) => annotation.screenId === screen.screenId),
      notes: notes.filter((note) => note.screenId === screen.screenId),
      screenId: screen.screenId,
      title: text(screen.title) || 'Untitled screen',
    }))
    .filter((group) => group.annotations.length + group.notes.length > 0);
  return {
    counts: {
      comments: annotations.reduce((total, annotation) => total + list(annotation.thread).length, 0),
      marks: annotations.length,
      notes: notes.length,
    },
    groups,
  };
}

/** Everyone who marked, commented, or wrote a note, by name: [{ ref, name }]. */
export function roundFeedbackPeople(data = {}) {
  const people = new Map();
  const add = (ref, name) => {
    const key = text(ref);
    if (key && !people.has(key)) people.set(key, text(name) || 'A reviewer');
  };
  for (const annotation of list(data.annotations)) {
    add(annotation.authorRef, annotation.authorName);
    for (const comment of list(annotation.thread)) add(comment.authorRef, comment.authorName);
  }
  for (const note of list(data.notes)) add(note.actorRef, note.name);
  return [...people].map(([ref, name]) => ({ name, ref })).sort((left, right) => left.name.localeCompare(right.name));
}

/** Where a summary citation of an annotation or comment opens in the "Marks and comments" view, or ''. */
export function feedbackAnchor(ref = '') {
  const value = text(ref);
  if (value.startsWith('annotation:')) return `#mark-${value.slice('annotation:'.length)}`;
  if (value.startsWith('comment:')) return `#comment-${value.slice('comment:'.length)}`;
  return '';
}

/**
 * The mark and comment a "Marks and comments" address points at: `#mark-<id>`, or
 * `#comment-<id>` for a comment and the mark it is on. Returns { markId, commentId }, with ''
 * for anything the round doesn't have.
 */
export function feedbackTarget(data = {}, hash = '') {
  const value = text(hash).replace(/^#/, '');
  const annotations = list(data.annotations);
  if (value.startsWith('mark-')) {
    const id = value.slice('mark-'.length);
    return { commentId: '', markId: annotations.some((annotation) => annotation.id === id) ? id : '' };
  }
  if (value.startsWith('comment-')) {
    const id = value.slice('comment-'.length);
    const mark = annotations.find((annotation) => list(annotation.thread).some((comment) => comment.id === id));
    return mark ? { commentId: id, markId: mark.id } : { commentId: '', markId: '' };
  }
  return { commentId: '', markId: '' };
}

/** A mark's first words for the marks list: its first comment, else its text labels and note. */
export function markExcerpt(annotation = {}, max = 140) {
  const thread = list(annotation.thread);
  const first = thread.find((comment) => !comment.parentCommentId) ?? thread[0];
  const raw = first
    ? commentPlainText(first.body)
    : [...list(annotation.labels).map((label) => `“${label}”`), annotation.note].filter(Boolean).join(' · ');
  const value = text(raw).replace(/\s+/g, ' ');
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * Everyone involved in a mark, as avatars, by what they did: `posted` (one person),
 * `commented` (everyone who wrote in the thread, the poster too), and `tagged`. Each is
 * [{ ref, name, initials, color }]; `people` lists everyone once, the poster first.
 */
export function markPeople(annotation = {}) {
  const people = list(annotation.participants).map((person) => ({
    color: avatarColor(person.ref),
    initials: initials(person.name),
    name: text(person.name) || 'A reviewer',
    ref: text(person.ref),
    roles: list(person.roles),
  }));
  const withRole = (role) => people.filter((person) => person.roles.includes(role));
  return { commented: withRole('commented'), people, posted: withRole('posted')[0] ?? null, tagged: withRole('tagged') };
}

/**
 * What a mark is drawn on in the "Marks and comments" view: its prototype snapshot
 * (`{ kind: 'snapshot', path }`, loaded through the API), its image screen
 * (`{ kind: 'image', url, width, height }`), or a blank frame of the screen when there is no
 * picture (`{ kind: 'blank', width, height }`). Sizes are what the mark's shapes are measured in.
 */
export function markSurface(annotation = {}, screen = null) {
  if (annotation.snapshotUrl) return { kind: 'snapshot', path: annotation.snapshotUrl };
  if (screen?.kind === 'image' && screen.imageUrl) {
    return { height: Number(screen.height) || 800, kind: 'image', url: screen.imageUrl, width: Number(screen.width) || 1280 };
  }
  const size = screen?.kind === 'image' ? screen : screen?.viewport;
  return { height: Number(size?.height) || 800, kind: 'blank', width: Number(size?.width) || 1280 };
}
