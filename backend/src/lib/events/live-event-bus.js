import { buildOperationLogContext, logBackendError } from '../logging/backend-logger.js';

function nowIso() {
  return new Date().toISOString();
}

export const LIVE_EVENT_CHANNELS = {
  assistantSessions(tenantId, userId) {
    return `assistant-sessions:${tenantId}:${userId}`;
  },
  // A direct message conversation's stream: its members only (docs/odin-chat/plan.md).
  directConversation(conversationId) {
    return `direct-conversation:${conversationId}`;
  },
  // A channel guest's streams, by access link (docs/engagements/plan.md, Live updates).
  guest(accessLinkId) {
    return `guest:${accessLinkId}`;
  },
  // One person's notifications in one workspace: a member (principalType 'user') or a guest
  // ('stakeholder'), for GET /api/me/events and the guest stream (modules/notifications).
  person(tenantId, principalType, principalId) {
    return `person:${tenantId}:${principalType}:${principalId}`;
  },
  project(projectId) {
    return `project:${projectId}`;
  },
  publicClarification(accessToken) {
    return `public-clarification:${accessToken}`;
  },
  publicRequirements(linkId) {
    return `public-requirements:${linkId}`;
  },
  session(sessionId) {
    return `assistant-session:${sessionId}`;
  },
  workspace(tenantId) {
    return `workspace:${tenantId}`;
  },
};

export function createLiveEventBus() {
  const listenersByChannel = new Map();
  let nextEventId = 1;

  function listenersFor(channel) {
    if (!listenersByChannel.has(channel)) {
      listenersByChannel.set(channel, new Set());
    }

    return listenersByChannel.get(channel);
  }

  return {
    publish(channel, event = {}) {
      const listeners = listenersByChannel.get(channel);
      if (!listeners || listeners.size === 0) {
        return;
      }

      const payload = {
        at: nowIso(),
        id: nextEventId++,
        type: String(event.type ?? 'invalidate').trim() || 'invalidate',
        ...event,
      };

      for (const listener of listeners) {
        try {
          listener(payload);
        } catch (error) {
          logBackendError({
            context: buildOperationLogContext('live-event-bus.publish', {
              channel,
              eventId: payload.id,
              eventType: payload.type,
            }),
            error,
            level: 'warn',
            message: 'Live event listener failed.',
          });
        }
      }
    },
    subscribe(channel, listener) {
      const listeners = listenersFor(channel);
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByChannel.delete(channel);
        }
      };
    },
  };
}
