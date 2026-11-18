import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyCommunicationDelivery } from '../src/modules/mail/communication-verifier.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';

test('communication verifier proves acknowledged attention and completed email delivery without recipient content', async () => {
  const mail = createInMemoryMailRepository();
  await mail.queueMail({ body: 'secret body', recipientEmail: 'person@example.com', subject: 'Attention', targetId: 'notification-1', templateId: 'goal-attention' });
  const [pending] = await mail.listEmailsByTargetIds({ targetIds: ['notification-1'] });
  assert.equal(pending.recipientEmail, undefined);
  assert.equal(pending.body, undefined);
  await mail.markSent({ id: pending.id });
  const verification = verifyCommunicationDelivery({
    criteria: { requireEmail: true, requireNotification: true },
    deliveries: await mail.listEmailsByTargetIds({ targetIds: ['notification-1'] }),
    notifications: [{ id: 'notification-1', status: 'read' }],
  });
  assert.equal(verification.passed, true);
  assert.deepEqual(verification.failedCheckIds, []);
});

test('communication verifier fails closed for unread attention, failed mail, missing required evidence, and duplicates', () => {
  const verification = verifyCommunicationDelivery({
    criteria: { requireEmail: true, requireNotification: true },
    deliveries: [
      { id: 'mail-1', status: 'failed', targetId: 'notification-1', templateId: 'goal-attention' },
      { id: 'mail-2', status: 'sent', targetId: 'notification-1', templateId: 'goal-attention' },
    ],
    notifications: [{ id: 'notification-1', status: 'unread' }],
  });
  assert.equal(verification.passed, false);
  assert.deepEqual(new Set(verification.failedCheckIds), new Set([
    'communication.no_unread_attention', 'communication.email_delivery_complete',
    'communication.no_failed_delivery', 'communication.no_duplicate_delivery',
  ]));
  assert.equal(verifyCommunicationDelivery({ criteria: { requireEmail: true, requireNotification: true } }).passed, false);
});
