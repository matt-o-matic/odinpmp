// Guests' notifications.
//
// A guest has one stakeholder record per project they are a guest in, and one access link per
// workspace, which their sign-in codes and sessions hang on (0098). Channel posts name the
// stakeholder; notifications are kept for the access link (principal type 'guest'), so a guest
// in two engagements has one bell, one stream, one set of devices and one rolled-up email
// across both. The notifications service asks principalFor() for each stakeholder it notifies.
//
// This is the guest directory modules/notifications reads (guest-directory.js has the
// interface): principalFor, describe, canOpen and linkFor.
import { normalizeAccessEmail } from '../access/access-links.js';
import { guestChannelPath } from '../channels/channel-links.js';
import { guestMemberships } from './guests.service.js';

export const GUEST_PRINCIPAL_TYPE = 'guest';

/** A signed-in guest's notification principal (request.guest from the guest session). */
export function guestPrincipal(guest) {
  return guest?.accessLinkId && guest.tenantId ? { principalId: String(guest.accessLinkId), principalType: GUEST_PRINCIPAL_TYPE, tenantId: guest.tenantId } : null;
}

/**
 * `deps` are the guests module's (accessRepository, assistantRepository, projectRepository,
 * workspaceModulesRepository), or a function that returns them when they are built later.
 */
export function createGuestNotificationDirectory(deps) {
  const read = () => (typeof deps === 'function' ? deps() : deps);

  // The access link's email, and the channels it reaches now (guestMemberships checks the
  // project, the module and removal on every call).
  async function linkOf({ principalId, tenantId }) {
    const link = await read().accessRepository?.findLinkById?.({ linkId: principalId });
    if (!link || link.tenantId !== tenantId || link.revokedAt) return null;
    return link;
  }

  return {
    // The guest a channel stakeholder is: their workspace access link, or null for a stakeholder
    // who never became a guest (they can open nothing that notifies).
    async principalFor({ projectId, stakeholderId, tenantId }) {
      const stakeholder = await read().assistantRepository?.findProjectStakeholderById?.({ projectId, stakeholderId, tenantId });
      const email = normalizeAccessEmail(stakeholder?.email ?? '');
      if (!email) return null;
      const link = await read().accessRepository?.findLinkByEmail?.({ email, tenantId });
      return link ? { principalId: String(link.id), principalType: GUEST_PRINCIPAL_TYPE, tenantId } : null;
    },
    async describe(principal) {
      const link = await linkOf(principal);
      if (!link?.email) return null;
      const memberships = await guestMemberships(read(), { email: link.email, tenantId: principal.tenantId });
      return { email: String(link.email).trim(), name: String(memberships[0]?.stakeholder?.name ?? '').trim() };
    },
    async canOpen(principal, item) {
      const link = await linkOf(principal);
      if (!link?.email || !item?.channelId) return false;
      return (await guestMemberships(read(), { email: link.email, tenantId: principal.tenantId })).some((membership) => membership.channelId === item.channelId);
    },
    linkFor(notification) {
      // The post itself, a reply too (notifications.service.js memberNotificationPath).
      return guestChannelPath({ channelId: notification.channelId, postId: notification.postId ?? notification.threadId, projectId: notification.projectId });
    },
  };
}
