import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../../lib/errors/http-error.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { channelAccess } from '../channels/channels.service.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { NOTIFICATION_LEVELS } from './notification-levels.js';
import { openPrincipalEventStream } from './notification-events.js';
import { memberPrincipal } from './notifications.service.js';

// Notification routes.
//
// createPrincipalNotificationsRouter serves one signed-in person's notifications, stream, focus
// and push subscriptions. Members get it at /api/me (createMemberNotificationsRouter). The guest
// view mounts the same router behind its guest session at /api/guest/me, passing the guest's
// principal ({ tenantId, principalType: 'stakeholder', principalId }).
//
// createChannelNotificationLevelRouter reads and sets a member's level for one channel, under
// /api/projects/:projectId, with the channel permission checks.

export const FOCUS_TTL_MS = 60_000;

const clientId = z.string().trim().min(1).max(120);
const readSchema = z.object({ all: z.boolean().optional().default(false), ids: z.array(z.string().trim().min(1).max(64)).max(200).optional() }).strict()
  .refine((value) => value.all || value.ids?.length, { message: 'Name the notifications to mark read, or all.' });
const focusSchema = z.object({ clientId, focused: z.boolean() }).strict();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional().default(50) });
const subscriptionSchema = z.object({
  endpoint: z.string().trim().url().max(2000),
  keys: z.object({ auth: z.string().trim().min(8).max(200), p256dh: z.string().trim().min(40).max(200) }).strict(),
}).strict();
const unsubscribeSchema = z.object({ endpoint: z.string().trim().url().max(2000) }).strict();
const levelSchema = z.object({ level: z.enum(NOTIFICATION_LEVELS).nullable() }).strict();

function send(status, run) {
  return async (request, response, next) => {
    try {
      const result = await run(request, response);
      response.setHeader('Cache-Control', 'no-store');
      response.status(status).json(result);
    } catch (error) {
      next(error);
    }
  };
}

export function createPrincipalNotificationsRouter({ authenticate, heartbeatMs = 25_000, liveEventBus, notifications, notificationsRepository, now = () => new Date(), principalOf, pushSender = null, listLevels = null }) {
  const router = Router();
  router.use(authenticate);
  const principal = (request) => {
    const value = principalOf(request);
    if (!value) throw new HttpError(403, 'This account is not assigned to a workspace.');
    return value;
  };

  router.get('/events', (request, response, next) => {
    try {
      const who = principal(request);
      const tab = clientId.safeParse(request.query.clientId).data ?? null;
      openPrincipalEventStream({
        heartbeatMs,
        liveEventBus,
        // A tab that goes away is no longer focused.
        onClose: () => { if (tab) void notificationsRepository.clearFocus({ ...who, clientId: tab }).catch(() => {}); },
        principal: who,
        request,
        response,
      });
    } catch (error) {
      next(error);
    }
  });

  // The focus heartbeat: a focused tab sends it every half minute, and once when it blurs.
  router.post('/focus', send(200, async (request) => {
    const input = focusSchema.parse(request.body ?? {});
    const who = principal(request);
    if (input.focused) await notificationsRepository.setFocus({ ...who, clientId: input.clientId, focusedUntil: new Date(now().getTime() + FOCUS_TTL_MS) });
    else await notificationsRepository.clearFocus({ ...who, clientId: input.clientId });
    return { focusedForMs: input.focused ? FOCUS_TTL_MS : 0, ok: true };
  }));

  router.get('/notifications', send(200, async (request) => ({ ok: true, ...await notifications.list(principal(request), listSchema.parse(request.query)) })));
  router.get('/notifications/:notificationId', send(200, async (request) => {
    const notification = await notifications.get(principal(request), request.params.notificationId);
    if (!notification) throw new HttpError(404, 'Notification not found.');
    return { notification, ok: true };
  }));
  router.post('/notifications/read', send(200, async (request) => {
    const input = readSchema.parse(request.body ?? {});
    return { ok: true, ...await notifications.markRead(principal(request), { all: input.all, ids: input.all ? null : input.ids }) };
  }));

  if (listLevels) router.get('/notification-levels', send(200, async (request) => ({ ok: true, ...await listLevels(request) })));

  router.get('/push', send(200, () => ({ available: Boolean(pushSender?.enabled), ok: true, publicKey: pushSender?.publicKey ?? '' })));
  router.post('/push-subscriptions', send(201, async (request) => {
    if (!pushSender?.enabled) throw new HttpError(409, 'Device notifications are not set up on this server.', { details: { code: 'push_unavailable' } });
    const input = subscriptionSchema.parse(request.body ?? {});
    if (!pushSender.endpointAllowed(input.endpoint)) throw new HttpError(400, 'That is not a browser push service address.', { details: { code: 'push_endpoint_not_allowed' } });
    const saved = await notificationsRepository.savePushSubscription({ ...principal(request), endpoint: input.endpoint, keys: input.keys, now: now(), userAgent: request.get('user-agent') ?? '' });
    return { ok: true, subscription: { createdAt: saved.createdAt, id: saved.id } };
  }));
  router.delete('/push-subscriptions', send(200, async (request) => {
    const input = unsubscribeSchema.parse(request.body ?? {});
    return { ok: true, removed: await notificationsRepository.removePushSubscription({ ...principal(request), endpoint: input.endpoint }) };
  }));

  return router;
}

// Projects whose channels the settings list: engagements only with the module on, never lost ones.
function listedProjects(projects, { consultingEnabled }) {
  return projects.filter((project) => project.kind !== PROJECT_KIND_ENGAGEMENT || (consultingEnabled && project.engagementStatus !== 'lost'));
}

export function createMemberNotificationsRouter(deps) {
  const { authRepository, notifications, projectRepository, tokenService, workspaceModulesRepository } = deps;

  // Every channel in the member's projects with their level, grouped by project, for settings.
  async function listLevels(request) {
    const principal = memberPrincipal(request.auth.user);
    const rows = await projectRepository.listMemberChannels?.({ tenantId: principal.tenantId, userId: principal.principalId }) ?? [];
    const consultingEnabled = await isModuleEnabled(workspaceModulesRepository, principal.tenantId, CONSULTING_MODULE);
    const projects = new Map(listedProjects([...new Map(rows.map((row) => [row.project.id, row.project])).values()], { consultingEnabled }).map((project) => [project.id, { channels: [], ...project }]));
    for (const project of projects.values()) {
      const inProject = rows.filter((row) => row.project.id === project.id);
      const levels = await notifications.channelLevels(principal, { channelIds: inProject.map((row) => row.channel.id), project, projectRole: inProject[0].projectRole });
      project.channels = inProject.map((row) => ({ id: row.channel.id, name: row.channel.name, ...levels.get(row.channel.id) }));
    }
    return {
      projects: [...projects.values()]
        .map(({ channels, id, kind, name }) => ({ channels: channels.sort((left, right) => left.name.localeCompare(right.name)), id, kind, name }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  return createPrincipalNotificationsRouter({
    ...deps,
    authenticate: createAuthMiddleware({ authRepository, tokenService }),
    listLevels,
    principalOf: (request) => memberPrincipal(request.auth?.user),
  });
}

export function createChannelNotificationLevelRouter(deps) {
  const { authRepository, notifications, projectRepository, tokenService } = deps;
  const router = Router({ mergeParams: true });
  router.use('/channels/:channelId/notification-level', createAuthMiddleware({ authRepository, tokenService }));

  async function current(request) {
    const ctx = await channelAccess(deps, request.auth.user, request.params.projectId);
    const channel = await projectRepository.getChannel({ channelId: request.params.channelId, projectId: ctx.projectId, tenantId: ctx.tenantId });
    if (!channel) throw new HttpError(404, 'Channel not found.');
    const principal = memberPrincipal(request.auth.user);
    const read = async () => (await notifications.channelLevels(principal, { channelIds: [channel.id], project: ctx.project, projectRole: ctx.projectRole })).get(channel.id);
    return { channel, principal, read };
  }

  router.get('/channels/:channelId/notification-level', send(200, async (request) => {
    const { read } = await current(request);
    return { ok: true, ...await read() };
  }));
  router.put('/channels/:channelId/notification-level', send(200, async (request) => {
    const input = levelSchema.parse(request.body ?? {});
    const { channel, principal, read } = await current(request);
    await notifications.setChannelLevel(principal, { channelId: channel.id, level: input.level });
    return { ok: true, ...await read() };
  }));
  return router;
}
