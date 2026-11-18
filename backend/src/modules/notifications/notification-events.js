import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';

// Live notification events (docs/odin-chat/plan.md, Delivery: Live). Each person has a channel
// on the live event bus per workspace (LIVE_EVENT_CHANNELS.person). Events carry only ids; the
// client fetches the notification, and every fetch checks who is asking.
//
// - notification.created { id }: a new notification, or a collapsed one that changed.
// - notification.read { ids } or { all: true }: notifications read, in this tab or another.
//
// openPrincipalEventStream serves one person's stream over server-sent events. Members get it
// at GET /api/me/events (notifications.routes.js). The guest stream (GET /api/guest/events,
// engagements workstream 6) calls subscribePrincipalNotifications with the guest's principal
// and writes the same events next to its channel.updated ones.

export const NOTIFICATION_CREATED_EVENT = 'notification.created';
export const NOTIFICATION_READ_EVENT = 'notification.read';
const EVENT_TYPES = new Set([NOTIFICATION_CREATED_EVENT, NOTIFICATION_READ_EVENT]);

export function principalChannel({ principalId, principalType, tenantId }) {
  return LIVE_EVENT_CHANNELS.person(tenantId, principalType, principalId);
}

export function publishNotificationCreated(liveEventBus, principal, notificationId) {
  liveEventBus?.publish(principalChannel(principal), { id: notificationId, type: NOTIFICATION_CREATED_EVENT });
}

export function publishNotificationsRead(liveEventBus, principal, { all = false, ids = [] } = {}) {
  if (!all && !ids.length) return;
  liveEventBus?.publish(principalChannel(principal), { ...(all ? { all: true } : { ids }), type: NOTIFICATION_READ_EVENT });
}

/**
 * Calls `write(type, data)` for each notification event of one principal, with only the ids
 * whatever a publisher added. Returns the unsubscribe function.
 */
export function subscribePrincipalNotifications(liveEventBus, principal, write) {
  if (!liveEventBus) return () => {};
  return liveEventBus.subscribe(principalChannel(principal), (event) => {
    if (!EVENT_TYPES.has(event.type)) return;
    write(event.type, event.type === NOTIFICATION_CREATED_EVENT ? { id: event.id } : (event.all ? { all: true } : { ids: event.ids ?? [] }));
  });
}

function writeSseEvent(response, type, data = {}) {
  if (response.writableEnded) return;
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Serves a principal's notification stream on `response`. `onClose` runs when the client goes
 * (the routes clear that tab's focus then).
 */
export function openPrincipalEventStream({ heartbeatMs = 25_000, liveEventBus, onClose = () => {}, principal, request, response }) {
  response.status(200);
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.flushHeaders?.();
  writeSseEvent(response, 'connected', {});
  const unsubscribe = subscribePrincipalNotifications(liveEventBus, principal, (type, data) => writeSseEvent(response, type, data));
  const heartbeat = setInterval(() => writeSseEvent(response, 'heartbeat', {}), heartbeatMs);
  heartbeat.unref?.();
  request.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    onClose();
  });
}
