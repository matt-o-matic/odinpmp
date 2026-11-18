import { Router } from 'express';

import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { WORKSPACE_CHANGED_EVENT } from '../../lib/events/project-live-events.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';

function openEventStream(response) {
  response.status(200);
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.flushHeaders?.();
}

function writeSseEvent(response, type, data = {}) {
  if (response.writableEnded) return;
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Mounted at /api/workspace/events: the signed-in person's workspace channel, for screens that
 * span projects. Each event says only which area changed (see project-live-events.js). MCP
 * credentials are refused, as on every route that does not allow them.
 */
export function createWorkspaceEventsRouter({ authRepository, heartbeatMs = 25_000, liveEventBus, tokenService }) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService }));

  router.get('/', (request, response) => {
    const tenantId = request.auth.user.memberships?.[0]?.tenantId ?? '';
    openEventStream(response);
    writeSseEvent(response, 'connected', {});

    // Only the area and the originating tab go out, whatever else a publisher adds.
    const unsubscribe = tenantId && liveEventBus
      ? liveEventBus.subscribe(LIVE_EVENT_CHANNELS.workspace(tenantId), (event) => {
        writeSseEvent(response, WORKSPACE_CHANGED_EVENT, { area: event.area, originClientId: event.originClientId ?? null });
      })
      : () => {};
    const heartbeat = setInterval(() => writeSseEvent(response, 'heartbeat', {}), heartbeatMs);

    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
