import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import {
  agentChatConfirmationSchema,
  agentChatCreateSchema,
  agentChatMessageSchema,
  agentChatProposalSchema,
  agentChatUpdateSchema,
} from './agent-chat.schema.js';
import { primaryTenantId } from './agent-chat.service.js';

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

function streamChannel(request, response, channel, hello) {
  openEventStream(response);
  writeSseEvent(response, 'connected', hello);
  const unsubscribe = request.app.locals.liveEventBus?.subscribe(channel, (event) => writeSseEvent(response, event.type ?? 'assistant.session.invalidated', event.payload ?? event)) ?? (() => {});
  const heartbeat = setInterval(() => writeSseEvent(response, 'heartbeat', hello), 25000);
  request.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// The assistant's chats: list, create, read, rename, delete, send a message (the turn streams
// over the chat's event channel), cancel, confirm a paused action, and apply staged proposals.
export function registerAgentChatRoutes(router, { agentChatService }) {
  const handle = (work, status = 200) => async (request, response, next) => {
    try {
      response.status(status).json(await work(request));
    } catch (error) {
      next(error);
    }
  };
  const withoutJob = ({ job: _job, ...result }) => result;

  router.get('/chats', handle((request) => agentChatService.listChats({ user: request.auth.user })));
  router.post('/chats', handle((request) => agentChatService.createChat({ ...agentChatCreateSchema.parse(request.body ?? {}), user: request.auth.user }), 201));

  router.get('/chats/events', (request, response, next) => {
    try {
      const tenantId = primaryTenantId(request.auth.user);
      streamChannel(request, response, LIVE_EVENT_CHANNELS.assistantSessions(tenantId, request.auth.user.id), { tenantId, userId: request.auth.user.id });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chats/:chatId', handle((request) => agentChatService.getChat({ chatId: request.params.chatId, user: request.auth.user })));
  router.patch('/chats/:chatId', handle((request) => agentChatService.updateChat({ chatId: request.params.chatId, input: agentChatUpdateSchema.parse(request.body ?? {}), user: request.auth.user })));
  router.delete('/chats/:chatId', handle((request) => agentChatService.deleteChat({ chatId: request.params.chatId, user: request.auth.user })));

  router.get('/chats/:chatId/events', async (request, response, next) => {
    try {
      await agentChatService.getChat({ chatId: request.params.chatId, user: request.auth.user });
      streamChannel(request, response, LIVE_EVENT_CHANNELS.session(request.params.chatId), { chatId: request.params.chatId });
    } catch (error) {
      next(error);
    }
  });

  router.post('/chats/:chatId/messages', handle(async (request) => withoutJob(await agentChatService.sendMessage({
    chatId: request.params.chatId,
    input: agentChatMessageSchema.parse(request.body ?? {}),
    user: request.auth.user,
  })), 202));
  router.post('/chats/:chatId/messages/:messageId/undo', handle((request) => agentChatService.undoChanges({ chatId: request.params.chatId, messageId: request.params.messageId, user: request.auth.user })));
  router.post('/chats/:chatId/cancel', handle((request) => agentChatService.cancelTurn({ chatId: request.params.chatId, user: request.auth.user })));
  router.post('/chats/:chatId/confirmation', handle(async (request) => withoutJob(await agentChatService.resolveConfirmation({
    chatId: request.params.chatId,
    input: agentChatConfirmationSchema.parse(request.body ?? {}),
    user: request.auth.user,
  })), 202));
  router.post('/chats/:chatId/proposals', handle((request) => agentChatService.resolveProposal({
    chatId: request.params.chatId,
    input: agentChatProposalSchema.parse(request.body ?? {}),
    user: request.auth.user,
  })));
}
