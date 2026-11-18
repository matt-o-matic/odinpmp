// Reporter-facing mail for external ticket intake: the intake link, the
// acknowledgement, and status-change notices, plus the reply-by-email address they carry.
//
// A reporter's page lives at <FRONTEND_APP_URL>/report/<intakeToken>. Replies go to
// ticket+<replyToken>@<MAIL_REPLY_DOMAIN>; the SES Lambda posts every inbound message to the
// clarification webhook, which hands ticket+ recipients to ingestTicketMailReply.

import { createHash } from 'node:crypto';

import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { queueTicketIntakeInvitationEmail, queueTicketReporterEmail } from '../mail/mail.service.js';
import { isProjectSoftDeleted } from './project-deletion.service.js';
import { TICKET_WORKFLOW_STATES } from '../workflows/ticket-workflow.js';

const TICKET_REPLY_ADDRESS = /^ticket\+([a-z0-9]+)@([^@\s]+)$/i;
const TICKET_REFERENCE = /\[Ref ([A-Z0-9]{8})\]/i;

export function buildTicketIntakeUrl({ frontendAppUrl = '', intakeToken }) {
  const base = String(frontendAppUrl ?? '').trim().replace(/\/+$/, '');
  return `${base}/report/${intakeToken}`;
}

export function buildTicketReplyAddress({ mailReplyDomain = '', replyToken = '' } = {}) {
  const domain = String(mailReplyDomain ?? '').trim().toLowerCase();
  const token = String(replyToken ?? '').trim();
  return domain && token ? `ticket+${token}@${domain}` : '';
}

/**
 * The reply token from a `ticket+<token>@<domain>` recipient, or ''. When a reply domain is
 * configured the recipient must be on it, exactly as clarification replies are checked.
 */
export function extractTicketReplyToken({ mailReplyDomain = '', toEmail = '' } = {}) {
  const match = String(toEmail ?? '').trim().match(TICKET_REPLY_ADDRESS);
  if (!match) return '';
  const expectedDomain = String(mailReplyDomain ?? '').trim().toLowerCase();
  if (expectedDomain && match[2].toLowerCase() !== expectedDomain) return '';
  return match[1];
}

export function isTicketReplyAddress(options) {
  return Boolean(extractTicketReplyToken(options));
}

/** Client-facing label for a ticket state; custom states fall back to their key. */
export function ticketStatusLabel(status) {
  const key = String(status ?? '').trim();
  const state = TICKET_WORKFLOW_STATES.find((entry) => entry.key === key);
  if (state) return state.label;
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New';
}

/** The short reference a reporter sees and quotes in subjects: the ticket id's first 8 characters. */
export function ticketReference(ticketId) {
  return String(ticketId ?? '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** The ticket a reply subject names with `[Ref XXXXXXXX]`, if it is one of `tickets`. */
export function ticketFromReplySubject(subject, tickets) {
  const reference = String(subject ?? '').match(TICKET_REFERENCE)?.[1]?.toUpperCase();
  return reference ? tickets.find((ticket) => ticketReference(ticket.id) === reference) ?? null : null;
}

function invitationLinkUsable(invitation, now = Date.now()) {
  if (!invitation || invitation.revokedAt) return false;
  return !invitation.expiresAt || Date.parse(invitation.expiresAt) > now;
}

/** An invitation for the team's Intake links tab, with its page URL while the link works. */
export function presentTicketIntakeInvitation(invitation, frontendAppUrl = '') {
  return {
    ...invitation,
    url: invitationLinkUsable(invitation) ? buildTicketIntakeUrl({ frontendAppUrl, intakeToken: invitation.intakeToken }) : null,
  };
}

function logMailFailure(operation, error, extra) {
  logBackendError({
    context: buildOperationLogContext(operation, extra),
    error,
    level: 'warn',
    message: 'Ticket intake email could not be queued.',
  });
}

/**
 * Emails a reporter their new intake link. The link exists whether or not this works, so
 * the result is reported to the caller (who can still copy the link) rather than thrown.
 */
export async function emailTicketIntakeLink({ frontendAppUrl, invitation, mailRepository, projectName, user }) {
  if (!mailRepository?.queueMail) return { reason: 'mail-not-configured', sent: false };
  const recipient = String(invitation.reporterEmail ?? '').trim();
  try {
    await queueTicketIntakeInvitationEmail({
      expiryLine: invitation.expiresAt ? `It works until ${new Date(invitation.expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC')}.` : '',
      mailRepository,
      projectName,
      recipientEmail: recipient,
      reportUrl: buildTicketIntakeUrl({ frontendAppUrl, intakeToken: invitation.intakeToken }),
      reporterName: invitation.reporterName,
      senderName: user?.name ?? '',
      targetId: invitation.id,
    });
    return { recipient, sent: true };
  } catch (error) {
    logMailFailure('tickets.emailIntakeLink', error, { invitationId: invitation.id, projectId: invitation.projectId });
    return { reason: 'queue-failed', recipient, sent: false };
  }
}

export async function queueTicketAcknowledgement({ frontendAppUrl, invitation, mailReplyDomain, mailRepository, projectName, ticket }) {
  if (!mailRepository?.queueMail) return;
  try {
    await queueTicketReporterEmail({
      mailRepository,
      projectName,
      recipientEmail: invitation.reporterEmail,
      replyTo: buildTicketReplyAddress({ mailReplyDomain, replyToken: invitation.replyToken }),
      reportUrl: `${buildTicketIntakeUrl({ frontendAppUrl, intakeToken: invitation.intakeToken })}#ticket-${ticketReference(ticket.id)}`,
      reporterName: invitation.reporterName,
      statusLabel: ticketStatusLabel(ticket.status),
      targetId: ticket.id,
      ticketName: ticket.name,
      ticketReference: ticketReference(ticket.id),
    });
  } catch (error) {
    // Acknowledgement failure must not lose a genuine submission.
    logMailFailure('tickets.acknowledge', error, { invitationId: invitation.id, projectId: invitation.projectId });
  }
}

// mail_queue dedupes on (recipient, template, target) and mail_target_id is VARCHAR(36), so
// each transition gets its own 36-character target: stable for one ticket version, so a
// retried request does not send twice.
function statusChangeTargetId(ticket) {
  return createHash('sha256').update(`ticket-status:${ticket.id}:${ticket.version ?? ''}:${ticket.status}`).digest('hex').slice(0, 36);
}

/**
 * Tells intake-link reporters when their ticket's status changes, whatever path changed it.
 * Tickets whose reporter is not an intake invitation (internal tickets, Bug Reporter's
 * `bug-reporter:` reporters, which send their own updates) are skipped.
 */
export function createTicketReporterNotifier({ frontendAppUrl = '', mailReplyDomain = '', mailRepository = null, projectRepository }) {
  return async function notifyTicketStatusChange({ after, before, projectId, projectName = '', tenantId }) {
    if (!mailRepository?.queueMail || !after || !before) return false;
    if (String(after.status ?? '') === String(before.status ?? '')) return false;
    const reporterId = String(after.reporterExternalId ?? '').trim();
    if (!reporterId || reporterId.startsWith('bug-reporter:')) return false;

    try {
      if (await isProjectSoftDeleted(projectRepository, { projectId, tenantId })) return false;
      const invitation = await projectRepository.getTicketIntakeInvitationById?.({ invitationId: reporterId, projectId, tenantId });
      if (!invitation || invitation.revokedAt) return false;
      const linkUsable = invitationLinkUsable(invitation);
      return await queueTicketReporterEmail({
        mailRepository,
        previousStatusLabel: ticketStatusLabel(before.status),
        projectName,
        recipientEmail: invitation.reporterEmail,
        replyTo: buildTicketReplyAddress({ mailReplyDomain, replyToken: invitation.replyToken }),
        reportUrl: linkUsable ? `${buildTicketIntakeUrl({ frontendAppUrl, intakeToken: invitation.intakeToken })}#ticket-${ticketReference(after.id)}` : '',
        reporterName: invitation.reporterName,
        statusLabel: ticketStatusLabel(after.status),
        targetId: statusChangeTargetId(after),
        ticketName: after.name,
        ticketReference: ticketReference(after.id),
      });
    } catch (error) {
      // The status change already happened; a mail failure must not undo or fail it.
      logMailFailure('tickets.notifyStatusChange', error, { itemId: after.id, projectId });
      return false;
    }
  };
}
