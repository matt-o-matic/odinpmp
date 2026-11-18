import { classifyBounce } from '../modules/mail/mail-bounce.js';
import { CLARIFICATION_INVITATION_TEMPLATE_ID } from '../modules/mail/mail.templates.js';

export { classifyBounce };

const SOFT_BOUNCE_MAX_ATTEMPTS = 3;

function isClarificationInvitationEmail(row = {}) {
  return String(row.templateId ?? '').trim() === CLARIFICATION_INVITATION_TEMPLATE_ID
    && String(row.targetId ?? '').trim().length > 0;
}

function extractProviderMessageId(value) {
  return String(
    value?.messageId
      ?? value?.message?.messageId
      ?? value?.envelope?.messageId
      ?? '',
  ).trim();
}

async function syncClarificationInvitationDelivery({
  assistantRepository,
  logger,
  row,
  lastError = '',
  mailStatus = 'sent',
  providerMessageId = '',
} = {}) {
  if (!isClarificationInvitationEmail(row)) {
    return null;
  }

  if (!assistantRepository?.findClarificationInvitationById || !assistantRepository?.markClarificationInvitationDelivery) {
    return null;
  }

  try {
    const invitationId = String(row.targetId ?? '').trim();
    const invitation = await assistantRepository.findClarificationInvitationById({ invitationId });

    if (!invitation?.projectId || !invitation?.tenantId) {
      return null;
    }

    return await assistantRepository.markClarificationInvitationDelivery({
      invitationId,
      lastError,
      mailStatus,
      projectId: invitation.projectId,
      providerMessageId,
      tenantId: invitation.tenantId,
    });
  } catch (error) {
    logger?.logError?.({
      context: {
        emailId: row?.id ?? null,
        targetId: row?.targetId ?? null,
        templateId: row?.templateId ?? null,
      },
      error,
      level: 'warn',
      message: 'Clarification invitation delivery metadata update failed.',
    });
    return null;
  }
}

export async function processMailQueueBatch({
  assistantRepository,
  env,
  logger,
  mailRepository,
  transport,
  limit = 10,
} = {}) {
  if (!mailRepository?.listPendingEmails) {
    throw new Error('A mail repository with listPendingEmails is required.');
  }

  if (!transport?.sendMail) {
    throw new Error('A transport with sendMail is required.');
  }

  const summary = {
    hardFailed: 0,
    processed: 0,
    retried: 0,
    sent: 0,
  };
  const pending = await mailRepository.listPendingEmails({ limit });

  if (!pending.length) {
    await mailRepository.failSoftBouncesOverAttempts?.({ maxAttempts: SOFT_BOUNCE_MAX_ATTEMPTS });
    return summary;
  }

  for (const row of pending) {
    const emailId = row.id;
    await mailRepository.markProcessing?.({ id: emailId });

    try {
      const sendResult = await transport.sendMail({
        from: {
          address: env?.mailFromAddress,
          name: env?.mailFromName,
        },
        html: row.body,
        replyTo: row.replyTo || undefined,
        subject: row.subject,
        to: row.recipientEmail,
      });

      await mailRepository.markSent?.({ id: emailId });
      await syncClarificationInvitationDelivery({
        assistantRepository,
        lastError: '',
        logger,
        mailStatus: 'sent',
        providerMessageId: extractProviderMessageId(sendResult),
        row,
      });
      summary.processed += 1;
      summary.sent += 1;
    } catch (error) {
      const reason = error?.message ?? String(error);
      const bounceType = classifyBounce(reason);

      await mailRepository.logBounce?.({
        bounceType,
        email: row.recipientEmail,
        reason,
      });

      if (bounceType === 'hard') {
        await mailRepository.optOutEmail?.({ email: row.recipientEmail });
        await mailRepository.markFailed?.({ id: emailId });
        summary.hardFailed += 1;
      } else {
        await mailRepository.retrySoftBounce?.({ id: emailId });
        summary.retried += 1;
      }

      await syncClarificationInvitationDelivery({
        assistantRepository,
        lastError: reason,
        logger,
        mailStatus: 'failed',
        providerMessageId: '',
        row,
      });

      summary.processed += 1;
      logger?.logError?.({
        context: {
          attempt: Number(row.attempts ?? 0) + 1,
          bounceType,
          emailId,
          recipientEmail: row.recipientEmail,
          targetId: row.targetId ?? null,
          templateId: row.templateId ?? null,
        },
        error,
        level: 'warn',
        message: 'Queued email delivery failed.',
      });
    }
  }

  await mailRepository.failSoftBouncesOverAttempts?.({ maxAttempts: SOFT_BOUNCE_MAX_ATTEMPTS });
  logger?.logEvent?.({
    context: summary,
    message: 'Mail queue run completed.',
  });

  return summary;
}
