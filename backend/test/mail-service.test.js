import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMentionNotification } from '../src/lib/mentions/mention-notifications.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import {
  queueClarificationInvitationEmail,
  queueMentionEmail,
} from '../src/modules/mail/mail.service.js';

test('queued clarification invitation emails use the trimmed email brand mark and inline right-aligned header markup', async () => {
  const mailRepository = createInMemoryMailRepository();

  const queued = await queueClarificationInvitationEmail({
    invitation: {
      clarificationPrompt: 'What filing rules apply?',
      clarificationRationale: 'We need the formal compliance constraints documented.',
      clarificationUrl: 'https://odinpmp.com/app/clarifications/demo',
      projectName: 'ACA Filing',
      replyAddress: 'clarification+demo@reply.odinpmp.com',
      stakeholderEmail: 'reviewer@example.com',
      stakeholderName: 'External Reviewer',
    },
    mailRepository,
    replyTo: 'clarification+demo@reply.odinpmp.com',
    targetId: 'invitation-1',
  });

  assert.equal(queued, true);
  assert.match(mailRepository.state.queue[0].body, /https:\/\/odinpmp\.com\/app\/brand\/odin-mark-email\.png/);
  assert.match(mailRepository.state.queue[0].body, /<table role="presentation"[^>]*style="[^"]*width:\s*100%[^"]*border-collapse:\s*collapse/i);
  assert.match(mailRepository.state.queue[0].body, /<td[^>]*align="right"[^>]*style="[^"]*text-align:\s*right/i);
  assert.match(mailRepository.state.queue[0].body, /<img[^>]*style="[^"]*display:\s*block[^"]*margin-left:\s*auto/i);
});

test('queued mention emails use the trimmed email brand mark and inline right-aligned header markup', async () => {
  const mailRepository = createInMemoryMailRepository();
  const mention = buildMentionNotification({
    commenter: {
      id: 'user-grace',
      name: 'Grace Hopper',
      timezone: 'America/New_York',
    },
    frontendAppUrl: 'https://odinpmp.com/app',
    html: '<p>Please review the <span class="mention" data-user-id="user-reviewer">@Reviewer</span> clarification reply.</p>',
    mentionedUser: {
      email: 'reviewer@example.com',
      id: 'user-reviewer',
      name: 'Reviewer',
    },
    project: {
      id: 'project-aca',
      name: 'ACA Filing',
    },
    target: {
      fullSpan: '<span class="mention" data-user-id="user-reviewer">@Reviewer</span>',
      id: 'comment-1',
      type: 'project',
    },
  });

  const queued = await queueMentionEmail({
    mailRepository,
    mention,
    targetId: 'comment-1',
  });

  assert.equal(queued, true);
  assert.match(mailRepository.state.queue[0].body, /https:\/\/odinpmp\.com\/app\/brand\/odin-mark-email\.png/);
  assert.match(mailRepository.state.queue[0].body, /<table role="presentation"[^>]*style="[^"]*width:\s*100%[^"]*border-collapse:\s*collapse/i);
  assert.match(mailRepository.state.queue[0].body, /<td[^>]*align="right"[^>]*style="[^"]*text-align:\s*right/i);
  assert.match(mailRepository.state.queue[0].body, /<img[^>]*style="[^"]*display:\s*block[^"]*margin-left:\s*auto/i);
});
