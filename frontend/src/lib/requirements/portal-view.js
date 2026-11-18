// The client portal's display rules: link problems, link validity, the ask for each
// open round, and the question cards. Stakeholders see "questions" where the team sees
// "topics", and the Odin summary carries names only.

import { requirementsErrorCode } from './requirements-errors.js';
import { hasSummaryFindings, normalizeSummaryOutput } from './requirements-sources.js';
import { dueDateText, pluralize, progressPercent } from './review-progress.js';

function list(value) {
  return Array.isArray(value) ? value : [];
}

function shortDate(value, { locale } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

/**
 * What went wrong with a portal request: `not-found` (404), `expired` or `revoked` (410),
 * `rate-limited` (429), or `failed` (anything else, worth a retry).
 */
export function classifyPortalError(error) {
  const status = Number(error?.status) || 0;
  const code = requirementsErrorCode(error);
  const details = error?.data?.details && !Array.isArray(error.data.details) ? error.data.details : {};
  if (status === 410 || code === 'link_expired' || code === 'link_revoked') {
    if (code === 'link_revoked') return { kind: 'revoked' };
    return { expiredAt: details.expiredAt ?? null, kind: 'expired' };
  }
  if (status === 404 && (code === 'link_not_found' || !code)) return { kind: 'not-found' };
  if (status === 429 || code === 'rate_limited') return { kind: 'rate-limited', retryAfterSeconds: Number(details.retryAfterSeconds) || 0 };
  return { kind: 'failed', status };
}

/** True for errors that mean the link itself no longer works, from any portal request. */
export function isLinkProblem(error) {
  return Number(error?.status) === 410 || requirementsErrorCode(error) === 'link_not_found';
}

/** "Link valid until Oct 31", or "Active while you have open requests". */
export function linkValidityText(link, { locale } = {}) {
  if (!link) return '';
  if (link.involvementActive || !link.expiresAt) return 'Active while you have open requests';
  return `Link valid until ${shortDate(link.expiresAt, { locale })}`;
}

export function personLine(stakeholder) {
  if (!stakeholder) return '';
  return stakeholder.roleTitle ? `${stakeholder.name} · ${stakeholder.roleTitle}` : stakeholder.name ?? '';
}

/** Who asked for a round. The portal may not say; then it is the project team. */
export function roundAsker(round, projectName = '') {
  const name = round?.publishedBy?.name || round?.requestedBy?.name || round?.publishedByName || '';
  if (name) return { name, known: true };
  return { name: projectName ? `The ${projectName} team` : 'The project team', known: false };
}

/** The round's one clear ask: who, what, and by when. */
export function roundAsk(round, { locale, projectName = '' } = {}) {
  const asker = roundAsker(round, projectName);
  const title = round?.title ? round.title : `round ${round?.number ?? ''}`.trim();
  const due = dueDateText(round?.dueAt, { locale });
  const headline = `${asker.name} asked you to review ${title}${due ? ` by ${due}` : ''}`;
  return { asker, due, headline, title };
}

/** "2 directions to compare", "4 screens to mark up", "4 questions to answer". */
export function roundContents(progress) {
  const items = [];
  const directions = Number(progress?.directions?.total) || 0;
  const screens = Number(progress?.screens?.total) || 0;
  const questions = Number(progress?.questions?.total) || 0;
  if (directions) items.push({ count: directions, label: directions === 1 ? 'direction to compare' : 'directions to compare' });
  if (screens) items.push({ count: screens, label: screens === 1 ? 'screen to mark up' : 'screens to mark up' });
  if (questions) items.push({ count: questions, label: questions === 1 ? 'question to answer' : 'questions to answer' });
  return items;
}

/** The progress panel and its button: Start review, Continue review, or after submitting. */
export function roundProgress(round) {
  const done = Number(round?.progress?.done) || 0;
  const total = Number(round?.progress?.total) || 0;
  const submitted = Boolean(round?.submittedAt);
  const closed = round?.status === 'closed';
  let action = done > 0 ? 'Continue review' : 'Start review';
  if (submitted) action = 'Open your review';
  if (closed) action = 'View your review';
  return { action, closed, done, percent: progressPercent(round?.progress), submitted, text: `${done} of ${pluralize(total, 'step')}`, total };
}

export function openRounds(rounds = []) {
  return list(rounds).filter((round) => round.status === 'open');
}

export function closedRounds(rounds = []) {
  return list(rounds).filter((round) => round.status === 'closed');
}

/** Assigned and unassigned open questions, assigned first. */
export function waitingQuestions(topics) {
  const assigned = list(topics?.assigned).filter((topic) => topic.state !== 'decided');
  return [...assigned, ...list(topics?.open)];
}

const ASSIGNED_ROLE_LABELS = Object.freeze({ primary: 'You own this', required: 'Your answer is required' });

/** "You own this", "Your answer is required", "Assigned to you", or "Open question", plus the reply count. */
export function questionMeta(topic) {
  let role = 'Open question';
  if (topic?.isAssignedToMe) role = ASSIGNED_ROLE_LABELS[topic.assignmentRole] ?? 'Assigned to you';
  const count = Number(topic?.commentCount) || 0;
  return { comments: count ? pluralize(count, 'comment') : 'No comments yet', role };
}

/**
 * One line of the Odin summary for a question card, in plain words and names only. A
 * proposed answer that rests on one person's word leads, as it asks others to confirm it;
 * an open item that blocks the decision is named before one that doesn't.
 */
export function summaryLine(summary) {
  if (!summary?.output) return 'Not enough input yet.';
  const output = normalizeSummaryOutput(summary.output);
  if (output.insufficientInput) return 'Not enough input yet.';
  if (!hasSummaryFindings(output) && !output.proposedAnswer) return 'Nothing to report yet.';
  const parts = [];
  if (output.proposedAnswerStatus === 'awaiting-confirmation') parts.push(`Awaiting confirmation: ${sentence(output.proposedAnswer)}`);
  else if (output.proposedAnswerStatus === 'owner-answered') parts.push(`Owner’s answer: ${sentence(output.proposedAnswer)}`);
  else if (output.proposedAnswerStatus === 'authority-answered') parts.push(`Required answer: ${sentence(output.proposedAnswer)}`);
  else if (output.aligned[0]) parts.push(`Agreed: ${sentence(output.aligned[0].statement)}`);
  const open = output.outstanding.find((entry) => entry.blocking) ?? output.outstanding[0];
  if (output.divergent[0]) parts.push(`Still split: ${sentence(output.divergent[0].issue)}`);
  else if (open) parts.push(`Open: ${sentence(open.item)}`);
  if (!parts.length && output.proposedAnswer) parts.push(`Agreed: ${sentence(output.proposedAnswer)}`);
  return parts.join(' ');
}

function sentence(text) {
  const value = String(text ?? '').trim();
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/** "Decided by Sam Patel · Oct 2". */
export function decisionLine(decision, { locale } = {}) {
  const verb = decision?.outcome === 'agreed' ? 'Agreed' : decision?.outcome === 'deferred' ? 'Deferred' : 'Decided';
  const who = decision?.decidedBy?.name ? ` by ${decision.decidedBy.name}` : '';
  const when = shortDate(decision?.decidedAt, { locale });
  return `${verb}${who}${when ? ` · ${when}` : ''}`;
}

export function questionStateLabel(topic) {
  if (topic?.decision || topic?.state === 'decided') return 'Decided';
  return 'Open';
}
