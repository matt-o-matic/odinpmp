import { HttpError } from '../../lib/errors/http-error.js';

/**
 * Stakeholders an assignment save will invite (scheduleClarificationInvitationDigests puts
 * them into their digest): everyone in the new list without an active invitation on the
 * clarification, plus anyone whose active invitation was never sent and is not already
 * waiting in a digest. Shared by the save's expected-recipients precondition and the MCP
 * preview so both apply the same rule.
 */
export function invitationRecipientIds({ activeInvitations = [], stakeholderIds = [] }) {
  const active = new Map(activeInvitations.map((invitation) => [String(invitation.stakeholderId ?? '').trim(), invitation]));
  return [...new Set(stakeholderIds.map((value) => String(value ?? '').trim()).filter(Boolean))].filter((stakeholderId) => {
    const invitation = active.get(stakeholderId);
    return !invitation || (invitation.mailStatus === 'pending' && !invitation.queuedAt && !invitation.scheduledAt);
  });
}

/** Throws 409, before anything is written, unless exactly the expected stakeholders would be invited. */
export function requireExpectedInvitationRecipients({ expected, recipients }) {
  const expectedIds = new Set(expected.map((value) => String(value ?? '').trim()));
  if (expectedIds.size === recipients.length && recipients.every((stakeholderId) => expectedIds.has(stakeholderId))) return;
  throw new HttpError(409, 'invitation_recipients_changed', {
    details: {
      code: 'invitation_recipients_changed',
      message: 'The stakeholders this save would email do not match the expected recipients. Nothing was saved.',
      recipients,
    },
  });
}
