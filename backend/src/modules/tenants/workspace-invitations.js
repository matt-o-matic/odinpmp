import { HttpError } from '../../lib/errors/http-error.js';

export const INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export function invitationExpired(invitation, now = Date.now()) {
  const invitedAt = new Date(invitation?.invitedAt).getTime();
  return !Number.isFinite(invitedAt) || invitedAt + INVITATION_LIFETIME_MS <= now;
}
export function requireOpenInvitation(invitation) {
  if (!invitation || invitation.accepted || invitationExpired(invitation)) {
    throw new HttpError(410, 'This invitation is no longer available. Ask your workspace administrator for a new invite.');
  }
  return invitation;
}
export function invitationMailTarget(invitation) {
  return `${invitation.id}:${invitation.inviteToken ?? invitation.invite_token}`;
}
