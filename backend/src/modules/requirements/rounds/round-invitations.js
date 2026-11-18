import { randomUUID } from 'node:crypto';

import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { REVIEW_ROUND_INVITATION_TEMPLATE_ID, REVIEW_ROUND_REMINDER_TEMPLATE_ID } from '../../mail/mail.templates.js';
import { queueReviewRoundEmail } from '../../mail/mail.service.js';
import { buildRequirementsPortalUrl, generateAccessToken, hashAccessToken } from '../requirements-access-links.js';

// Round invitations and reminders (AC-06). Stakeholders get a fresh requirements portal
// token in every email, deep-linked to the round; members get the app URL. Each email has
// its own mail_queue target id, recorded on the reviewer row, so the round can show that
// email's delivery status and Resend can queue another.

export const MAIL_STATUSES = Object.freeze(['queued', 'sent', 'failed', 'not-sent']);

function normalizeString(value) {
  return String(value ?? '').trim();
}

/** App URL for members: the project's Review tab with the round selected. Review is project-wide. */
export function memberReviewUrl({ frontendAppUrl = '', projectId, roundId }) {
  const base = normalizeString(frontendAppUrl).replace(/\/+$/, '');
  return `${base}/projects/${encodeURIComponent(projectId)}/requirements/review?round=${encodeURIComponent(roundId)}`;
}

/** Portal URL for a stakeholder token, deep-linked to one round. */
export function stakeholderReviewUrl({ frontendAppUrl = '', roundId, token }) {
  return `${buildRequirementsPortalUrl({ frontendAppUrl, token })}/rounds/${encodeURIComponent(roundId)}`;
}

function formatDue(dueAt) {
  if (!dueAt) return 'There is no due date.';
  const date = new Date(dueAt);
  const formatted = new Intl.DateTimeFormat('en-US', {
    day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'long', timeZone: 'UTC', timeZoneName: 'short', weekday: 'long', year: 'numeric',
  }).format(date);
  return `Please review by ${formatted}.`;
}

/**
 * Issues a token for one email. Uses the requirements bridge when it is attached (the same
 * path topic invitations take) and the link repository directly otherwise. Returns null
 * when an admin or manager revoked the stakeholder's link.
 */
async function issueStakeholderToken(deps, { createdBy, projectId, purpose, stakeholderId, tenantId }) {
  const bridge = deps.assistantRepository?.requirementsBridge;
  if (bridge?.issueInvitationUrl) {
    const issued = await bridge.issueInvitationUrl({ createdBy, projectId, purpose, stakeholderId, tenantId });
    if (!issued) return null;
    const token = issued.url.slice(issued.url.lastIndexOf('/') + 1);
    return { linkId: issued.linkId, token };
  }
  const token = generateAccessToken();
  try {
    const issued = await deps.requirementsRepository.issueAccessToken({
      createdBy,
      now: deps.clock ? deps.clock() : new Date(),
      projectId,
      purpose,
      stakeholderId,
      tenantId,
      tokenHash: hashAccessToken(token),
    });
    return { linkId: issued.link.id, token };
  } catch (error) {
    if (error?.details?.code === 'link_revoked') return null;
    throw error;
  }
}

/** Email address and display name of a reviewer, or null when the person is not found. */
export async function resolveReviewerContact(deps, { actorId, actorType, projectId, tenantId, validUsers = null }) {
  if (actorType === 'stakeholder') {
    const stakeholder = await deps.assistantRepository.findProjectStakeholderById({ projectId, stakeholderId: actorId, tenantId });
    return stakeholder ? { email: normalizeString(stakeholder.email), name: normalizeString(stakeholder.name) } : null;
  }
  const valid = validUsers ?? await deps.projectRepository.getValidUsers({ projectId, tenantId });
  const entry = [...(valid?.project_users ?? []), ...(valid?.tenant_users ?? [])].find((user) => user.id === actorId);
  return entry ? { email: normalizeString(entry.email), name: normalizeString(entry.name) } : null;
}

/**
 * Queues one invitation (or reminder) and returns the reviewer fields to store:
 * `{ mailStatus, mailReason, mailTargetId, mailQueuedAt }`. Never throws for mail problems;
 * those become a 'failed' or 'not-sent' status the round shows with Resend.
 */
export async function sendRoundEmail(deps, {
  createdBy,
  inviterName = '',
  kind = 'invitation',
  now,
  pkg,
  projectName = '',
  projectId,
  reviewer,
  round,
  targetId = null,
  tenantId,
  validUsers = null,
}) {
  const result = (mailStatus, mailReason = null, extra = {}) => ({ mailQueuedAt: null, mailReason, mailStatus, mailTargetId: null, ...extra });
  try {
    const contact = await resolveReviewerContact(deps, { actorId: reviewer.actorId, actorType: reviewer.actorType, projectId, tenantId, validUsers });
    if (!contact) return result('not-sent', 'reviewer-not-found');
    if (!contact.email) return result('not-sent', 'no-email');
    if (!deps.mailRepository?.queueMail) return result('not-sent', 'mail-not-configured');

    let reviewUrl;
    let accessLine;
    if (reviewer.actorType === 'stakeholder') {
      const issued = await issueStakeholderToken(deps, {
        createdBy,
        projectId,
        purpose: kind === 'reminder' ? 'reminder' : 'invitation',
        stakeholderId: reviewer.actorId,
        tenantId,
      });
      if (!issued) return result('not-sent', 'link-revoked');
      reviewUrl = stakeholderReviewUrl({ frontendAppUrl: deps.frontendAppUrl, roundId: round.id, token: issued.token });
      accessLine = 'This link is for you alone, so please do not forward it. No account or password is needed.';
    } else {
      reviewUrl = memberReviewUrl({ frontendAppUrl: deps.frontendAppUrl, projectId, roundId: round.id, track: round.track });
      accessLine = 'Sign in to OdinPMP to open the review.';
    }

    // mail_queue.mail_target_id is VARCHAR(36) in production, so every target id is a UUID.
    const mailTargetId = targetId ?? randomUUID();
    await queueReviewRoundEmail({
      accessLine,
      dueLine: formatDue(round.dueAt),
      inviterName,
      mailRepository: deps.mailRepository,
      note: kind === 'reminder' ? '' : round.note,
      packageTitle: pkg?.title ?? '',
      projectName,
      recipientEmail: contact.email,
      reviewerName: contact.name,
      reviewUrl,
      roundNumber: round.number,
      targetId: mailTargetId,
      templateId: kind === 'reminder' ? REVIEW_ROUND_REMINDER_TEMPLATE_ID : REVIEW_ROUND_INVITATION_TEMPLATE_ID,
    });
    return result('queued', null, { mailQueuedAt: new Date(now ?? Date.now()).toISOString(), mailTargetId });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.rounds.queueEmail', { kind, projectId, reviewerId: reviewer.id, roundId: round.id, tenantId }),
      error,
      level: 'warn',
      message: 'Review round email could not be queued.',
    });
    return result('failed', 'queue-error');
  }
}

const QUEUE_STATUS = Object.freeze({ failed: 'failed', pending: 'queued', processing: 'queued', sent: 'sent' });

/**
 * Delivery status per reviewer: the mail_queue row of the latest invitation when there is
 * one (queued, sent, failed), otherwise what was recorded when queuing was attempted.
 * Returns Map(reviewerId -> { status, reason, queuedAt }).
 */
export async function loadReviewerMailStates(deps, reviewers = []) {
  const targets = reviewers.map((reviewer) => reviewer.mailTargetId).filter(Boolean);
  let rows = [];
  if (targets.length > 0 && deps.mailRepository?.listEmailsByTargetIds) {
    try {
      rows = await deps.mailRepository.listEmailsByTargetIds({ limit: 500, targetIds: targets });
    } catch (error) {
      logBackendError({
        context: buildOperationLogContext('requirements.rounds.mailStates', { count: targets.length }),
        error,
        level: 'warn',
        message: 'Review round mail status could not be read.',
      });
    }
  }
  const rowByTarget = new Map((rows ?? []).map((row) => [String(row.targetId ?? ''), row]));
  const states = new Map();
  for (const reviewer of reviewers) {
    const row = reviewer.mailTargetId ? rowByTarget.get(reviewer.mailTargetId) : null;
    const status = row ? (QUEUE_STATUS[row.status] ?? 'queued') : (reviewer.mailStatus ?? 'not-sent');
    states.set(reviewer.id, {
      queuedAt: reviewer.mailQueuedAt ?? null,
      reason: status === 'failed' && row ? 'delivery-failed' : (reviewer.mailReason ?? null),
      status,
    });
  }
  return states;
}
