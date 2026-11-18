import { guestChannelPath } from '../channels/channel-links.js';

// What notifications need to know about guests (principal type 'stakeholder'), behind one small
// interface so the guests module can supply its own:
//
// - principalFor({ projectId, stakeholderId, tenantId }), optional: the principal a channel
//   stakeholder's notifications are kept under. Without it, the stakeholder's own.
// - describe(principal, items): the guest's { email, name } for their digest, or null.
// - canOpen(principal, item): whether the guest may still open the item's channel.
// - linkFor(notification): the path in the guest view that opens it.
//
// This default reads the channel guest list (project_channel_guests, not removed), keyed by
// stakeholder. The app passes the guests module's directory (guests/guest-notifications.js),
// which keys a guest by their workspace access link, as `notificationGuestDirectory`.

export function createChannelGuestDirectory({ projectRepository }) {
  async function guestIn(channelId, { principalId, tenantId }) {
    if (!channelId) return null;
    const guests = await projectRepository?.listChannelGuests?.({ channelId, tenantId }) ?? [];
    return guests.find((guest) => String(guest.stakeholderId) === String(principalId)) ?? null;
  }

  return {
    async describe(principal, items = []) {
      for (const channelId of new Set(items.map((item) => item.channelId).filter(Boolean))) {
        const guest = await guestIn(channelId, principal);
        if (guest) return { email: String(guest.email ?? '').trim(), name: String(guest.name ?? '').trim() };
      }
      return null;
    },
    async canOpen(principal, item) {
      return Boolean(await guestIn(item.channelId, principal));
    },
    linkFor(notification) {
      // The post itself, a reply too (notifications.service.js memberNotificationPath).
      return guestChannelPath({ channelId: notification.channelId, postId: notification.postId ?? notification.threadId, projectId: notification.projectId });
    },
  };
}
