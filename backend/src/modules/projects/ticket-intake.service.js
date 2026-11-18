// External ticket intake (D-011, D-021, D-028).
//
// The invite token is project-scoped exactly as clarification invitations are, so the
// project comes from the token and a reporter never selects one. A submitted ticket is
// always created with externalReviewState 'pending' (D-027) and carries the reporter's
// invitation id, so it is invisible to the assistant until a human validates it.
//
// Every failure path returns the same generic not-found so a caller cannot distinguish
// an unknown token from a revoked or expired one, or learn whether the project exists.

import { randomUUID } from 'node:crypto';

import { markdownToSafeHtml } from '../../lib/content/email-markdown.js';
import { normalizeInboundReplyBody } from '../../lib/content/email-replies.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { isProjectSoftDeleted } from './project-deletion.service.js';
import {
  PUBLIC_ATTACHMENT_ALLOWED_TYPES,
  PUBLIC_ATTACHMENT_MAX_BYTES,
  PUBLIC_ATTACHMENT_MAX_COUNT,
  PUBLIC_ATTACHMENT_MAX_TOTAL_BYTES,
} from './projects.schema.js';
import {
  extractTicketReplyToken,
  queueTicketAcknowledgement,
  ticketFromReplySubject,
  ticketReference,
  ticketStatusLabel,
} from './ticket-intake-mail.js';

export const DEFAULT_INTAKE_RATE_LIMIT = { maxSubmissions: 20, windowMs: 60 * 60 * 1000 };

function intakeNotFound() {
  return new HttpError(404, 'This submission link is not available.');
}

async function findLiveInvitation(projectRepository, intakeToken) {
  const invitation = await projectRepository.getTicketIntakeInvitationByToken({ intakeToken });
  if (!invitation || await isProjectSoftDeleted(projectRepository, invitation)) return null;
  return invitation;
}

/**
 * Per-token sliding-window limiter (AC6.8). One token exhausting its allowance never
 * affects another token.
 */
export function createIntakeRateLimiter({ maxSubmissions, windowMs } = DEFAULT_INTAKE_RATE_LIMIT) {
  const hits = new Map();

  return {
    check(token, now = Date.now()) {
      const recent = (hits.get(token) ?? []).filter((timestamp) => now - timestamp < windowMs);

      if (recent.length >= maxSubmissions) {
        hits.set(token, recent);
        return false;
      }

      recent.push(now);
      hits.set(token, recent);
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}

// Only the reporter's own tickets, and only what a reporter needs to follow them (AC6.9).
function presentReporterTicket(ticket) {
  return {
    category: ticket.category ?? 'defect',
    id: ticket.id,
    name: ticket.name,
    reference: ticketReference(ticket.id),
    severity: ticket.severity ?? 'S3',
    status: ticket.status,
    statusLabel: ticketStatusLabel(ticket.status),
    updatedAt: ticket.updatedAt ?? null,
  };
}

async function activeConfigEntries({ invitation, kind, ticketConfigRepository }) {
  if (!ticketConfigRepository?.listTicketConfigList) return [];
  try {
    const entries = await ticketConfigRepository.listTicketConfigList({ kind, tenantId: invitation.tenantId });
    return entries
      .filter((entry) => entry.status === 'active' && (!entry.projectId || entry.projectId === invitation.projectId))
      .map((entry) => ({ id: entry.id, name: entry.name }));
  } catch (_error) {
    // The form still works without the optional pickers.
    return [];
  }
}

export async function getPublicTicketIntakeContext({ intakeToken, projectRepository, ticketConfigRepository = null }) {
  const invitation = await findLiveInvitation(projectRepository, intakeToken);
  if (!invitation) throw intakeNotFound();

  const project = await projectRepository.getProjectDetail({
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });
  const [environments, releases] = await Promise.all([
    activeConfigEntries({ invitation, kind: 'environments', ticketConfigRepository }),
    activeConfigEntries({ invitation, kind: 'releases', ticketConfigRepository }),
  ]);

  return {
    intake: {
      // Deliberately minimal: no internal identities, no other reporters' tickets, no
      // project structure (AC6.9).
      attachmentLimits: {
        allowedTypes: [...PUBLIC_ATTACHMENT_ALLOWED_TYPES],
        maxBytes: PUBLIC_ATTACHMENT_MAX_BYTES,
        maxCount: PUBLIC_ATTACHMENT_MAX_COUNT,
        maxTotalBytes: PUBLIC_ATTACHMENT_MAX_TOTAL_BYTES,
      },
      environments,
      expiresAt: invitation.expiresAt ?? null,
      projectName: project?.name ?? '',
      releases,
      reporterName: invitation.reporterName ?? '',
      tickets: (project?.tickets ?? [])
        .filter((ticket) => ticket.reporterExternalId === invitation.id)
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
        .map(presentReporterTicket),
    },
    ok: true,
  };
}

export async function submitPublicTicket({
  frontendAppUrl = '',
  input,
  intakeToken,
  mailReplyDomain = '',
  mailRepository = null,
  onProjectChanged = null,
  projectRepository,
  rateLimiter = null,
}) {
  const invitation = await findLiveInvitation(projectRepository, intakeToken);
  if (!invitation) throw intakeNotFound();

  if (rateLimiter && !rateLimiter.check(intakeToken)) {
    throw new HttpError(429, 'Too many submissions. Try again later.');
  }

  const attachments = decodeAttachments(input.attachments ?? []);

  const created = await projectRepository.createProjectItem({
    input: {
      item: {
        actualResult: input.actualResult ?? '',
        buildVersion: input.buildVersion ?? '',
        category: input.category ?? 'defect',
        description: input.description ?? '',
        environmentId: input.environmentId ?? null,
        expectedResult: input.expectedResult ?? '',
        foundInReleaseId: input.foundInReleaseId ?? null,
        id: randomUUID(),
        name: input.name,
        // AC6.3: externally created tickets are always pending and always carry a reporter.
        externalReviewState: 'pending',
        reporterExternalId: invitation.id,
        reproSteps: input.reproSteps ?? '',
        severity: input.severity ?? 'S3',
        status: 'new',
      },
      itemType: 'ticket',
      // AC6.1: the project comes from the token; the request body cannot override it.
      parentId: null,
    },
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
    user: { id: `external:${invitation.id}` },
  });

  if (!created) throw intakeNotFound();

  // Attachments are stored after the ticket exists so a rejected file cannot leave an
  // orphan record, and a scan failure rolls the whole submission back (AC6.4).
  try {
    await storeAttachments({ attachments, invitation, projectRepository, ticket: created.item });
  } catch (error) {
    await projectRepository.deleteProjectItem({
      expectedVersion: created.item.version,
      itemId: created.item.id,
      projectId: invitation.projectId,
      tenantId: invitation.tenantId,
      user: { id: `external:${invitation.id}` },
    }).catch(() => {});
    throw error;
  }

  await projectRepository.recordTicketIntakeSubmission({ invitationId: invitation.id });
  await queueTicketAcknowledgement({
    frontendAppUrl,
    invitation,
    mailReplyDomain,
    mailRepository,
    projectName: created.project?.name ?? '',
    ticket: created.item,
  });
  onProjectChanged?.(invitation.projectId, {
    actor: { id: `external:${invitation.id}`, name: invitation.reporterName || invitation.reporterEmail || 'External reporter' },
    itemId: created.item.id,
    reason: 'ticket-intake-submitted',
  });

  return {
    ok: true,
    // AC6.9: the reporter gets their own ticket reference and nothing else.
    ticket: presentReporterTicket(created.item),
  };
}

/**
 * Decodes and size-checks attachments before anything is written. Size is checked against
 * the decoded bytes rather than the base64 length, so padding cannot smuggle an oversized
 * file past the limit (AC6.5).
 */
function decodeAttachments(attachments) {
  let totalBytes = 0;
  return attachments.map((attachment) => {
    const bytes = Buffer.from(attachment.contentBase64, 'base64');

    if (bytes.length === 0) {
      throw new HttpError(400, 'Attachment content is empty or not valid base64.');
    }
    if (bytes.length > PUBLIC_ATTACHMENT_MAX_BYTES) {
      throw new HttpError(413, 'Attachment exceeds the maximum allowed size.');
    }
    totalBytes += bytes.length;
    if (totalBytes > PUBLIC_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new HttpError(413, 'Attachments exceed the maximum combined size.');
    }
    return attachment;
  });
}

/**
 * Stores reporter attachments through the existing vault and ClamAV path. A scan failure
 * throws so the caller can roll the submission back (AC6.4).
 */
async function storeAttachments({ attachments, invitation, projectRepository, ticket }) {
  for (const attachment of attachments) {
    try {
      await projectRepository.saveFile({
        fileContentsBase64: attachment.contentBase64,
        fileDescription: `Reporter attachment for ${ticket.name}`,
        fileName: attachment.fileName,
        fileType: attachment.contentType,
        inlineImage: false,
        projectId: invitation.projectId,
        targetId: ticket.id,
        targetType: 'ticket',
        tenantId: invitation.tenantId,
        user: { id: `external:${invitation.id}`, name: invitation.reporterName || invitation.reporterEmail },
      });
    } catch (error) {
      // Virus-scan and storage failures must reject the submission, not pass silently.
      throw new HttpError(400, error?.message === 'File failed virus scan.'
        ? 'Attachment failed virus scan.'
        : 'Attachment could not be stored.');
    }
  }
}

/**
 * Appends an inbound email reply to the reporter's ticket (AC6.7). The reply goes to the
 * ticket its subject names (`[Ref XXXXXXXX]`), else the reporter's most recently updated
 * one. Unknown tokens and senders other than the invited reporter are ignored rather than
 * creating anything, so a stray or forged reply can never become new work.
 */
export async function ingestTicketMailReply({
  inboundMailWebhookSecret = '',
  input,
  mailReplyDomain = '',
  onProjectChanged = null,
  projectRepository,
  requestSecret = '',
}) {
  const expectedSecret = String(inboundMailWebhookSecret ?? '').trim();
  if (!expectedSecret || String(requestSecret ?? '').trim() !== expectedSecret) {
    throw new HttpError(401, 'Invalid inbound mail secret.');
  }

  const replyToken = extractReplyToken(input.toEmail, mailReplyDomain);
  const invitation = replyToken
    ? await projectRepository.getTicketIntakeInvitationByReplyToken?.({ replyToken })
    : null;

  // Silently accepted and dropped: a reply to an unknown address is not an error the
  // sending provider can act on, and it must never create a ticket.
  if (!invitation) return { matched: false, ok: true };

  const fromEmail = String(input.fromEmail ?? '').trim().toLowerCase();
  if (!fromEmail || fromEmail !== String(invitation.reporterEmail ?? '').trim().toLowerCase()) {
    return { matched: false, ok: true };
  }

  const project = await projectRepository.getProjectDetail({
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });
  const tickets = (project?.tickets ?? [])
    .filter((entry) => entry.reporterExternalId === invitation.id)
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  const ticket = ticketFromReplySubject(input.subject, tickets) ?? tickets[0] ?? null;

  // Ticket comments are stored as HTML: the reply, without its quoted history and with its
  // formatting kept (lib/content/email-replies.js), rendered from Markdown.
  const comment = markdownToSafeHtml(normalizeInboundReplyBody({ htmlBody: input.htmlBody, textBody: input.textBody }).slice(0, 20_000));
  if (!ticket || !comment) return { matched: false, ok: true };

  await projectRepository.addComment({
    comment,
    parentId: null,
    projectId: invitation.projectId,
    targetId: ticket.id,
    targetType: 'ticket',
    tenantId: invitation.tenantId,
    user: { id: `external:${invitation.id}`, name: invitation.reporterName || invitation.reporterEmail },
  });
  onProjectChanged?.(invitation.projectId, {
    actor: { id: `external:${invitation.id}`, name: invitation.reporterName || invitation.reporterEmail || 'External reporter' },
    itemId: ticket.id,
    reason: 'ticket-mail-reply',
  });

  return { matched: true, ok: true, ticketId: ticket.id };
}

export function extractReplyToken(toEmail, mailReplyDomain = '') {
  return extractTicketReplyToken({ mailReplyDomain, toEmail });
}
