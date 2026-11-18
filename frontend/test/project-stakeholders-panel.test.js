import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildProjectStakeholderInvitationSummaries } from '../src/lib/assistant/project-stakeholders.js';

const detailViewSource = readFileSync(
  new URL('../src/views/ProjectDetailView.vue', import.meta.url),
  'utf8',
);

const stakeholdersPanelSource = readFileSync(
  new URL('../src/components/projects/ProjectStakeholdersPanel.vue', import.meta.url),
  'utf8',
);

test('stakeholder invitation summaries stay grouped by stakeholder and clarification', () => {
  const summaries = buildProjectStakeholderInvitationSummaries({
    clarifications: [
      {
        assignments: [
          {
            accessToken: 'queue-a',
            actorId: 'stakeholder-a',
            actorType: 'stakeholder',
            invitationToken: 'invite-a-1',
            label: 'Legal Reviewer',
            lastInboundAt: '2026-05-20T10:00:00.000Z',
            mailStatus: 'sent',
            queuedAt: '2026-05-20T09:00:00.000Z',
            replyToken: 'reply-a-1',
            sentAt: '2026-05-20T09:05:00.000Z',
          },
          {
            accessToken: 'queue-b',
            actorId: 'stakeholder-b',
            actorType: 'stakeholder',
            invitationToken: 'invite-b-1',
            label: 'Finance Reviewer',
            lastInboundAt: null,
            mailStatus: 'pending',
            queuedAt: '2026-05-20T09:00:00.000Z',
            replyToken: 'reply-b-1',
            sentAt: null,
          },
        ],
        id: 'clar-1',
        prompt: 'Which reviews are still required before launch?',
      },
      {
        assignments: [
          {
            accessToken: 'queue-a',
            actorId: 'stakeholder-a',
            actorType: 'stakeholder',
            invitationToken: 'invite-a-2',
            label: 'Legal Reviewer',
            lastInboundAt: null,
            mailStatus: 'sent',
            queuedAt: '2026-05-20T11:00:00.000Z',
            replyToken: 'reply-a-2',
            sentAt: '2026-05-20T11:05:00.000Z',
          },
        ],
        id: 'clar-2',
        prompt: 'Do you need legal review on the revised checklist?',
      },
    ],
    stakeholders: [
      { email: 'legal@example.com', id: 'stakeholder-a', name: 'Legal Reviewer', roleTitle: 'Legal' },
      { email: 'finance@example.com', id: 'stakeholder-b', name: 'Finance Reviewer', roleTitle: 'Finance' },
    ],
  });

  assert.deepEqual(
    summaries.map((summary) => ({
      assignedClarificationCount: summary.assignedClarificationCount,
      id: summary.id,
      invitationTokens: summary.invitations.map((invitation) => invitation.invitationToken),
    })),
    [
      {
        assignedClarificationCount: 1,
        id: 'stakeholder-b',
        invitationTokens: ['invite-b-1'],
      },
      {
        assignedClarificationCount: 2,
        id: 'stakeholder-a',
        invitationTokens: ['invite-a-2', 'invite-a-1'],
      },
    ],
  );
});

test('project settings exposes a dedicated stakeholders tab and panel', () => {
  assert.match(detailViewSource, /import ProjectStakeholdersPanel from '\.\.\/components\/projects\/ProjectStakeholdersPanel\.vue';/);
  assert.match(detailViewSource, /projectSettingsTab === 'stakeholders'/);
  assert.match(detailViewSource, /Stakeholders/);
  assert.match(detailViewSource, /<ProjectStakeholdersPanel/);
});

test('stakeholders panel drops the retired clarification links and keeps email stats behind disclosure', () => {
  assert.doesNotMatch(stakeholdersPanelSource, /Copy link/);
  assert.doesNotMatch(stakeholdersPanelSource, /clarifications\//);
  assert.match(stakeholdersPanelSource, /Add stakeholder/);
  assert.match(stakeholdersPanelSource, /Reply-by-email details/);
  assert.match(stakeholdersPanelSource, /<details/);
  assert.match(stakeholdersPanelSource, /buildProjectStakeholderInvitationSummaries/);
});

test('stakeholder summaries list each stakeholder\'s review rounds, open ones first, and ignore team reviewers', () => {
  const reviewer = (actorType, actorId, extra = {}) => ({ actorId, actorType, id: `r-${actorId}`, mailStatus: 'sent', required: false, submittedAt: null, ...extra });
  const [casey, dana] = buildProjectStakeholderInvitationSummaries({
    rounds: [
      { id: 'round-1', number: 1, reviewers: [reviewer('stakeholder', 'casey', { submittedAt: '2030-10-20T12:00:00.000Z' })], status: 'closed', title: 'Booking', track: 'experience' },
      { dueAt: '2030-11-02T17:00:00.000Z', id: 'round-2', number: 2, reviewers: [reviewer('stakeholder', 'casey', { required: true }), reviewer('user', 'user-1')], status: 'open', title: 'Booking', track: 'experience' },
      { id: 'round-x', number: 1, reviewers: [reviewer('stakeholder', 'stranger')], status: 'open', title: 'Unknown contact', track: 'architecture' },
    ],
    stakeholders: [{ email: 'casey@example.com', id: 'casey', name: 'Casey' }, { email: 'dana@example.com', id: 'dana', name: 'Dana' }],
  });
  assert.deepEqual(casey.reviews.map((review) => [review.roundId, review.roundStatus, review.required, Boolean(review.submittedAt)]), [['round-2', 'open', true, false], ['round-1', 'closed', false, true]]);
  assert.equal(casey.reviews[0].dueAt, '2030-11-02T17:00:00.000Z');
  assert.deepEqual(dana.reviews, []);
});
