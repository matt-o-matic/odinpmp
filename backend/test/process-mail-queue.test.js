import assert from 'node:assert/strict';
import test from 'node:test';

import { CLARIFICATION_INVITATION_TEMPLATE_ID } from '../src/modules/mail/mail.templates.js';
import { processMailQueueBatch } from '../src/jobs/process-mail-queue.lib.js';

function createMailRepository(rows = []) {
  const calls = {
    failSoftBouncesOverAttempts: [],
    logBounce: [],
    markFailed: [],
    markProcessing: [],
    markSent: [],
    optOutEmail: [],
    retrySoftBounce: [],
  };

  return {
    calls,
    async failSoftBouncesOverAttempts({ maxAttempts } = {}) {
      calls.failSoftBouncesOverAttempts.push({ maxAttempts });
      return { updated: 0 };
    },
    async listPendingEmails() {
      return rows;
    },
    async logBounce(value) {
      calls.logBounce.push(value);
      return true;
    },
    async markFailed({ id }) {
      calls.markFailed.push({ id });
      return true;
    },
    async markProcessing({ id }) {
      calls.markProcessing.push({ id });
      return true;
    },
    async markSent({ id }) {
      calls.markSent.push({ id });
      return true;
    },
    async optOutEmail({ email }) {
      calls.optOutEmail.push({ email });
      return true;
    },
    async retrySoftBounce({ id }) {
      calls.retrySoftBounce.push({ id });
      return true;
    },
  };
}

function createAssistantRepository(invitation = null) {
  const calls = {
    findClarificationInvitationById: [],
    markClarificationInvitationDelivery: [],
  };

  return {
    calls,
    async findClarificationInvitationById({ invitationId }) {
      calls.findClarificationInvitationById.push({ invitationId });
      return invitation && invitation.id === invitationId ? invitation : null;
    },
    async markClarificationInvitationDelivery(value) {
      calls.markClarificationInvitationDelivery.push(value);
      return value;
    },
  };
}

function createLogger() {
  return {
    errors: [],
    events: [],
    logError(value) {
      this.errors.push(value);
    },
    logEvent(value) {
      this.events.push(value);
    },
  };
}

test('processMailQueueBatch records clarification invitation delivery metadata after a successful send', async () => {
  const row = {
    attempts: 0,
    body: '<p>Please reply</p>',
    id: 'mail-1',
    recipientEmail: 'stakeholder@example.com',
    replyTo: 'clarification+reply-token@reply.odinpmp.com',
    subject: 'Clarification needed',
    targetId: 'invitation-1',
    templateId: CLARIFICATION_INVITATION_TEMPLATE_ID,
  };
  const mailRepository = createMailRepository([row]);
  const assistantRepository = createAssistantRepository({
    id: 'invitation-1',
    projectId: 'project-1',
    tenantId: 'tenant-1',
  });
  const logger = createLogger();
  const transport = {
    sent: [],
    async sendMail(message) {
      this.sent.push(message);
      return { messageId: '<ses-message-1@us-east-2.amazonses.com>' };
    },
  };

  const result = await processMailQueueBatch({
    assistantRepository,
    env: {
      mailFromAddress: 'noreply@odinpmp.com',
      mailFromName: 'OdinPMP',
    },
    logger,
    mailRepository,
    transport,
  });

  assert.equal(result.processed, 1);
  assert.equal(result.sent, 1);
  assert.deepEqual(mailRepository.calls.markProcessing, [{ id: 'mail-1' }]);
  assert.deepEqual(mailRepository.calls.markSent, [{ id: 'mail-1' }]);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].replyTo, 'clarification+reply-token@reply.odinpmp.com');
  assert.deepEqual(assistantRepository.calls.findClarificationInvitationById, [{ invitationId: 'invitation-1' }]);
  assert.deepEqual(assistantRepository.calls.markClarificationInvitationDelivery, [{
    invitationId: 'invitation-1',
    lastError: '',
    mailStatus: 'sent',
    projectId: 'project-1',
    providerMessageId: '<ses-message-1@us-east-2.amazonses.com>',
    tenantId: 'tenant-1',
  }]);
  assert.equal(logger.errors.length, 0);
});

test('processMailQueueBatch marks clarification invitations failed when delivery throws, even if the queue retries the email', async () => {
  const row = {
    attempts: 1,
    body: '<p>Please reply</p>',
    id: 'mail-2',
    recipientEmail: 'stakeholder@example.com',
    replyTo: 'clarification+reply-token@reply.odinpmp.com',
    subject: 'Clarification needed',
    targetId: 'invitation-2',
    templateId: CLARIFICATION_INVITATION_TEMPLATE_ID,
  };
  const mailRepository = createMailRepository([row]);
  const assistantRepository = createAssistantRepository({
    id: 'invitation-2',
    projectId: 'project-2',
    tenantId: 'tenant-2',
  });
  const logger = createLogger();
  const transport = {
    async sendMail() {
      throw new Error('451 Requested action aborted: mailbox busy');
    },
  };

  const result = await processMailQueueBatch({
    assistantRepository,
    env: {
      mailFromAddress: 'noreply@odinpmp.com',
      mailFromName: 'OdinPMP',
    },
    logger,
    mailRepository,
    transport,
  });

  assert.equal(result.processed, 1);
  assert.equal(result.retried, 1);
  assert.deepEqual(mailRepository.calls.retrySoftBounce, [{ id: 'mail-2' }]);
  assert.deepEqual(mailRepository.calls.markFailed, []);
  assert.deepEqual(mailRepository.calls.logBounce, [{
    bounceType: 'soft',
    email: 'stakeholder@example.com',
    reason: '451 Requested action aborted: mailbox busy',
  }]);
  assert.deepEqual(assistantRepository.calls.markClarificationInvitationDelivery, [{
    invitationId: 'invitation-2',
    lastError: '451 Requested action aborted: mailbox busy',
    mailStatus: 'failed',
    projectId: 'project-2',
    providerMessageId: '',
    tenantId: 'tenant-2',
  }]);
  assert.equal(logger.errors.length, 1);
});
