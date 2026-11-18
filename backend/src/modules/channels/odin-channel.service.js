// Odin in channels (docs/engagements/plan.md, Odin in channels; qna.md Q-09, E-16, E-17; AC-23
// to AC-25). A new post that tags @odin, in any project's channel (delivery or engagement), with
// the project's "Let Odin answer when tagged" setting on, gets one answer from Odin in that
// post's thread, posted as the author "Odin".
//
// A tag is an entry point into the one assistant, not a second agent. Each tag runs one AI
// Workspace turn (agent-chat.service.js: startOriginTurn, then executeTurn, the turn queue and
// the durable worker) with the same instructions, catalog, checks, confirmations and Undo. Only
// two things differ: the turn starts with the channel's notes (odin-context.js), and its replies
// become posts in the thread (the origin hooks below).
// - A member's turn runs as that member, through Odin's routes, so it does what their role
//   allows: a project manager can have it move cards, plan sprints or raise risks. Deletes and
//   emails wait for that member's confirm button. Its chat is kept out of the chat list.
// - A guest's turn gets a filtered, read-only view of the same catalog (GUEST_TOOL_NAMES) and,
//   in place of a session, an API that answers only the guest's own reads (odin-guest-api.js),
//   so the limit holds below the model. Their post is screened first (odin-screen.js). Its chat
//   lives only for the turn: a guest has no confirmations or Undo.
//
// Every turn is a durable run (ODIN_RUN_TYPE), so a restart is noticed: the durable worker runs
// a reply nobody started and posts a note for one a restart cut off (runDurable). One record per
// tagging post (odin_replies) means each tag is answered once; editing the post never runs it
// again.
import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { publishWorkspaceChanged } from '../../lib/events/project-live-events.js';
import { presentChanges } from '../../lib/agent/agent-changes.js';
import { createOdinToolCatalog } from '../../mcp/catalog.js';
import { createInMemoryAgentChatsRepository } from '../assistant/agent-chats.repository.js';
import { commentPlainText, resolveMentions } from '../requirements/mentions/mention-tokens.js';
import { publishChannelUpdated } from './channel-events.js';
import { channelPeopleFor } from './channels.service.js';
import { channelNotes, readChannelContext, readPollLines } from './odin-context.js';
import { createGuestAgentApi, guestChannels, noGuestTasks } from './odin-guest-api.js';
import { ODIN_REPLY_ACTIVE } from './odin-replies.repository.js';
import { imageNoteLines, pickTurnImages, readImage, screenTurnImages } from './odin-images.js';
import { createPostScreen, SCREEN_LIMITS } from './odin-screen.js';
import { normalizeOdinTags, tagsOdin, withoutOdinToken } from './odin-tag.js';

// The tools a guest's turn may see and run: catalog reads and the assistant's own planning and
// lookup tools. odin_run reaches only these too; every one of them reads (checked below).
export const GUEST_TOOL_NAMES = Object.freeze([
  'odin_find_items', 'odin_get_item', 'odin_list_items',
  'odin_list_channels', 'odin_list_channel_posts', 'odin_list_project_files', 'odin_read_project_file', 'odin_list_file_folders',
  'update_plan', 'odin_operations', 'odin_describe', 'odin_run',
]);
const GUEST_LOCAL_TOOLS = new Set(['update_plan', 'odin_operations', 'odin_describe', 'odin_run']);
{
  const catalog = new Map(createOdinToolCatalog({ api: null, extended: true }).map((entry) => [entry.name, entry]));
  for (const name of GUEST_TOOL_NAMES) {
    if (GUEST_LOCAL_TOOLS.has(name)) continue;
    if (!catalog.has(name) || catalog.get(name).write) throw new TypeError(`A guest's turn may only read: ${name} is not a catalog read.`);
  }
}

export const ODIN_RUN_TYPE = 'odin_channel_reply';
export const ODIN_ORIGIN = 'channel';
export const DEFAULT_ODIN_TURN_TIMEOUT_MS = 10 * 60 * 1000;

export const ODIN_NOTES = Object.freeze({
  cancelled: 'I stopped before I finished answering.',
  failed: 'I couldn\'t finish answering this.',
  interrupted: 'I was interrupted when Odin restarted, so I didn\'t finish. Tag @Odin again to ask again.',
  needsConfirmation: 'This needs your go-ahead first.',
  notGuest: 'I can\'t answer this: the person who asked is no longer in this channel.',
  screened: 'I can\'t act on this post: it reads as instructions aimed at an AI rather than a question for me.',
  unscreened: 'I couldn\'t check this post, so I can\'t answer it right now. Try again in a little while.',
});

// What the tagging post shows about Odin's answer.
const TAG_STATUS = { awaiting_confirmation: 'waiting', failed: 'failed', queued: 'replying', replied: 'replied', running: 'replying', screened: 'screened' };

const clip = (value, max = 240) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
const tenantOf = (user) => {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
};
/** A post's text as Odin reads it. */
export const postPlainText = (body) => commentPlainText(withoutOdinToken(body)).trim();

export function createOdinChannelService({
  agentChatService,
  agentConfig = {},
  authRepository = null,
  guestTasks = noGuestTasks,
  liveEventBus = null,
  modelResolver,
  // modules/notifications: Odin's posts notify as people's do (odin_reply to the post it answers).
  notifications = null,
  projectRepository,
  screen = null,
  // The linked SOW's state in words, or null. The app passes billing's (pursuit/sow-link.js).
  sowState = async () => null,
  timeoutMs = DEFAULT_ODIN_TURN_TIMEOUT_MS,
}) {
  const decisionsModel = agentConfig.decisionsModel ?? 'gpt-6-luna';
  const decisionsTimeoutMs = agentConfig.decisionsTimeoutMs ?? 4000;
  const postScreen = screen ?? createPostScreen({ enabled: agentConfig.decisionsEnabled !== false, model: decisionsModel, modelResolver, timeoutMs: decisionsTimeoutMs });
  const screenFor = (reach, tenantId) => (post) => postScreen.passes({ body: post.body, reach, tenantId });
  // A guest's turn keeps its chat only while it runs: guests have no account to keep it under,
  // and nothing in it waits for them (no confirmations, no Undo).
  const guestChats = createInMemoryAgentChatsRepository();
  const isGuestChat = (chat) => chat?.origin?.audience === 'guest';
  // Who a guest's turn runs as: their stakeholder id, never a user's.
  const guestPerson = ({ name, stakeholderId, tenantId }) => ({ email: '', id: `guest:${stakeholderId}`, memberships: [{ role: 'guest', tenantId }], name: name || 'A guest' });

  function publish(reply) {
    publishChannelUpdated(liveEventBus, { actor: { id: null, name: 'Odin' }, area: 'posts', channelId: reply.channelId, projectId: reply.projectId });
    publishWorkspaceChanged(liveEventBus, reply.tenantId, { area: 'projects' });
  }

  async function update(reply, changes) {
    const saved = await projectRepository.updateOdinReply({ changes, replyId: reply.id, tenantId: reply.tenantId });
    publish(saved ?? reply);
    return saved ?? reply;
  }

  // Odin's post in the thread. A post that already exists (the same reply settling twice) is kept.
  // Its text can't tag anyone: every tag becomes plain text, so it sends no mention email.
  async function postAsOdin(reply, { body, id = null }) {
    const existing = id ? await projectRepository.getPost({ postId: id, tenantId: reply.tenantId }) : null;
    if (existing) return existing;
    const text = resolveMentions(normalizeOdinTags(body, { enabled: false }), { people: [] }).body.trim() || ODIN_NOTES.failed;
    const post = await projectRepository.createPost({
      post: { authorId: reply.id, authorType: 'odin', body: text, ...(id ? { id } : {}), parentId: reply.threadId, projectId: reply.projectId, targetId: reply.channelId, targetType: 'channel', tenantId: reply.tenantId },
    });
    await projectRepository.updateOdinReply({ changes: { replyPostId: post.id }, replyId: reply.id, tenantId: reply.tenantId });
    await notifyOdinPost(reply, post);
    return post;
  }

  // The author of the post Odin answers gets odin_reply; others in the thread thread_reply; and
  // people who watch the channel a channel post, as for any reply. Never fails the post.
  async function notifyOdinPost(reply, post) {
    if (!notifications) return;
    try {
      const [channel, parent, people] = await Promise.all([
        projectRepository.getChannel({ channelId: reply.channelId, projectId: reply.projectId, tenantId: reply.tenantId }),
        reply.threadId ? projectRepository.getPost({ postId: reply.threadId, tenantId: reply.tenantId }) : null,
        channelPeopleFor({ projectRepository }, { channelId: reply.channelId, projectId: reply.projectId, tenantId: reply.tenantId }),
      ]);
      if (!channel) return;
      await notifications.notifyPost({ author: { id: 'odin', name: 'Odin', type: 'odin' }, channel, mentioned: [], parent, people, post, projectId: reply.projectId, tenantId: reply.tenantId });
    } catch {
      // notifyPost logs its own failures; a missing channel or post just means nobody to tell.
    }
  }

  async function finish(reply, { body, error = null, id = null, status }) {
    await postAsOdin(reply, { body, id });
    return update(reply, { error: error ? clip(error, 480) : null, status });
  }

  async function projectFacts(projectId, tenantId) {
    const [detail, kind] = await Promise.all([
      projectRepository.getProjectDetail?.({ projectId, tenantId }).catch(() => null),
      projectRepository.getProjectKind?.({ projectId }).catch(() => null),
    ]);
    return { id: projectId, kind: kind?.kind ?? 'delivery', name: detail?.name ?? 'this project' };
  }

  // The turn's starting context: the thread, the channel and its files, for either audience.
  // Guests' posts are screened to the bar of the turn that reads them.
  // Also picks the images the turn looks at (odin-images.js): file ids only, read per request.
  async function turnNotes({ asker, audience, channel, post, tenantId }) {
    const [project, context, guests, files, sow] = await Promise.all([
      projectFacts(channel.projectId, tenantId),
      readChannelContext(projectRepository, { channel, post, tenantId }),
      projectRepository.listChannelGuests?.({ channelId: channel.id, tenantId }) ?? [],
      projectRepository.listFiles({ projectId: channel.projectId, targetId: channel.id, targetType: 'channel', tenantId, user: null }),
      audience === 'member' ? sowState({ projectId: channel.projectId, tenantId }) : null,
    ]);
    const links = await projectRepository.listPostFileIds({ postIds: [...new Set([post.id, ...context.thread.map((entry) => entry.id)])] });
    const attached = new Set(links.filter((link) => link.postId === post.id).map((link) => link.fileId));
    const picked = pickTurnImages({ files, links, post, thread: context.thread });
    const reach = audience === 'member' ? 'memberTurn' : 'guestTurn';
    const screened = await screenTurnImages({ chosen: picked.chosen, projectRepository, screenImage: async ({ dataUrl }) => Boolean(await postScreen.passesImage?.({ dataUrl, reach, tenantId })), tenantId });
    const polls = await readPollLines(projectRepository, { posts: [...context.thread, ...context.others], tenantId });
    const notes = await channelNotes({
      asker,
      attachments: files.filter((file) => attached.has(file.id)),
      audience,
      channel,
      files: files.filter((file) => !attached.has(file.id)),
      guestCount: audience === 'member' ? guests.length : 0,
      others: context.others,
      polls,
      project,
      screenPost: screenFor(audience === 'member' ? 'memberTurn' : 'guestTurn', tenantId),
      sow,
      thread: context.thread,
    });
    const images = screened.kept.map(({ contentType, fileId, fileName, version }) => ({ contentType, fileId, fileName, version }));
    return { images, notes: [notes, ...imageNoteLines({ included: screened.kept, leftOut: [...screened.leftOut, ...picked.leftOut] })].join('\n') };
  }

  const durableFor = (reply, userId = null) => ({
    budgets: {},
    idempotencyKey: `odin-reply:${reply.id}`,
    // One try here; the second is the durable worker's, which runs a reply nobody started or
    // posts a note for one a restart cut off.
    maxAttempts: 2,
    payload: { replyId: reply.id },
    projectId: reply.projectId,
    runType: ODIN_RUN_TYPE,
    tenantId: reply.tenantId,
    userId,
  });

  // --- the assistant's turn tells this service when it starts and settles --------------------

  async function replyForChat(chat) {
    return chat?.origin?.replyId ? projectRepository.getOdinReply({ replyId: chat.origin.replyId, tenantId: chat.tenantId }) : null;
  }
  const forgetGuestChat = async (chat) => {
    if (isGuestChat(chat)) await guestChats.remove({ chatId: chat.id, tenantId: chat.tenantId, userId: chat.userId });
  };

  agentChatService.registerOrigin?.(ODIN_ORIGIN, {
    // A guest's turn: its chat kept only for the turn, the guest's API in place of a session, and
    // the read-only view of the catalog. A member's turn takes the assistant's own (null).
    store: (chat) => (isGuestChat(chat) ? guestChats : null),
    openSession(chat) {
      if (!isGuestChat(chat)) return null;
      const api = createGuestAgentApi({ guestTasks, projectId: chat.projectId, projectRepository, screenPost: screenFor('guestTurn', chat.tenantId), stakeholderId: chat.origin.stakeholderId, tenantId: chat.tenantId });
      return { api, close: async () => {} };
    },
    allowedTools: (chat) => (isGuestChat(chat) ? GUEST_TOOL_NAMES : null),
    // The images picked when the turn started, read again for each request (a durable retry too).
    async inputImages(chat) {
      const images = await Promise.all((chat.origin?.images ?? []).map(async (image) => {
        const dataUrl = await readImage(projectRepository, { image, tenantId: chat.tenantId });
        return dataUrl ? { dataUrl, mimeType: image.contentType, name: image.fileName } : null;
      }));
      return images.filter(Boolean);
    },
    async onStart(chat) {
      const reply = await replyForChat(chat);
      if (reply && reply.status !== 'running') await update(reply, { status: 'running' });
    },
    async onSettled(chat) {
      const reply = await replyForChat(chat);
      if (!reply) return;
      const last = chat.messages.at(-1);
      const status = chat.run?.status;
      if (status === 'failed' || status === 'cancelled') {
        const reason = status === 'cancelled' ? ODIN_NOTES.cancelled : `${ODIN_NOTES.failed} ${clip(chat.run?.error, 200)}`;
        await finish(reply, { body: reason, error: chat.run?.error ?? status, id: last?.role === 'assistant' && last.error ? last.id : null, status: 'failed' });
        await forgetGuestChat(chat);
        return;
      }
      if (last?.role !== 'assistant') return;
      const body = last.content || (last.confirmation ? ODIN_NOTES.needsConfirmation : 'Done.');
      await finish(reply, { body, id: last.id, status: status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'replied' });
      await forgetGuestChat(chat);
    },
    async onChanged(chat) {
      const reply = await replyForChat(chat);
      if (reply) publish(reply);
    },
  });

  // --- what posts show ---------------------------------------------------------------------

  // A reply still marked as working long after any turn could run was cut off by a restart the
  // durable worker hasn't caught up with yet (or a resumed turn, which isn't durable).
  const stale = (reply) => ODIN_REPLY_ACTIVE.has(reply.status) && Date.now() - Date.parse(reply.updatedAt ?? 0) > timeoutMs + 60_000;

  async function requireOdinPost({ postId, projectId, user }) {
    const tenantId = tenantOf(user);
    const post = await projectRepository.getPost({ postId, projectId, tenantId });
    const reply = post?.authorType === 'odin' ? await projectRepository.getOdinReply({ replyId: post.authorId, tenantId }) : null;
    if (!reply || reply.projectId !== projectId) throw new HttpError(404, 'That reply from Odin is not here.');
    if (reply.requesterType !== 'user' || reply.requesterId !== user.id || !reply.chatId) {
      throw new HttpError(403, 'Only the person who tagged Odin can answer this.', { details: { code: 'not_requester' } });
    }
    return { post, reply };
  }

  return {
    ODIN_RUN_TYPE,

    /**
     * Called once a new post is saved (never for an edit). `principal` is
     * { type: 'user', user } for a member or { type: 'stakeholder', stakeholderId } for a guest.
     * Returns the reply record, or null when the post doesn't tag Odin or the channel's "Let Odin
     * answer when tagged" is off.
     */
    async afterPostCreated({ channel, post, principal }) {
      if (!tagsOdin(post.body) || post.targetType !== 'channel') return null;
      if (channel?.odinEnabled === false) return null;
      const member = principal?.type === 'user';
      const requesterId = member ? principal.user.id : principal?.stakeholderId;
      if (!requesterId) return null;
      const { created, reply } = await projectRepository.createOdinReply({
        reply: { channelId: channel.id, chatId: member ? randomUUID() : null, postId: post.id, projectId: post.projectId, requesterId, requesterType: member ? 'user' : 'stakeholder', status: 'queued', tenantId: post.tenantId, threadId: post.parentId ?? post.id },
      });
      if (!created) return reply;
      publish(reply);
      // The post is saved and shows "Odin is replying"; reading the channel for the turn's notes
      // (and screening guests' posts) happens after the response, so the writer never waits on it.
      void this.startReply({ channel, post, principal, reply });
      return reply;
    },

    /**
     * Starts the assistant turn for a new reply record, as the member or the guest who tagged
     * Odin. `durable: false` is the durable worker's own restart, which already holds the run.
     */
    async startReply({ channel, durable = true, post, principal, reply }) {
      const member = principal?.type === 'user';
      const tenantId = post.tenantId;
      try {
        let user = principal.user;
        if (!member) {
          // A guest: still in this channel, and their post screened, before anything reads it.
          const inChannel = (await guestChannels(projectRepository, { projectId: post.projectId, stakeholderId: reply.requesterId, tenantId })).some((entry) => entry.id === channel.id);
          if (!inChannel) return void await finish(reply, { body: ODIN_NOTES.notGuest, error: 'not_in_channel', status: 'failed' });
          const risk = await postScreen.score({ body: post.body, tenantId });
          if (risk === null) return void await finish(reply, { body: ODIN_NOTES.unscreened, error: 'screen_unavailable', status: 'screened' });
          if (risk >= SCREEN_LIMITS.guestTurn) return void await finish(reply, { body: ODIN_NOTES.screened, error: 'screened', status: 'screened' });
          user = guestPerson({ name: post.authorName, stakeholderId: reply.requesterId, tenantId });
        }
        const audience = member ? 'member' : 'guest';
        await agentChatService.startOriginTurn({
          chatId: reply.chatId ?? `odin-guest-${reply.id}`,
          durable: durable ? durableFor(reply, member ? user.id : null) : null,
          message: postPlainText(post.body) || 'You were tagged in this post.',
          origin: {
            audience,
            ...await turnNotes({ asker: user.name || (member ? 'A team member' : 'A guest'), audience, channel, post, tenantId }),
            ...(member ? {} : { readOnly: true, stakeholderId: reply.requesterId }),
            replyId: reply.id,
            timeoutMs,
            type: ODIN_ORIGIN,
          },
          projectId: post.projectId,
          title: `#${channel.name}`,
          user,
        });
      } catch (error) {
        console.error('Odin reply could not start.', { error: error?.message, odinReplyId: reply.id });
        await finish(reply, { body: `${ODIN_NOTES.failed} ${clip(error?.message, 200)}`, error: error?.message ?? 'start_failed', status: 'failed' }).catch(() => {});
      }
    },

    /**
     * What each post shows about Odin, by post id: `odin` on a post that tagged it (its status),
     * `odinReply` on Odin's own posts (a confirmation and the changes, with buttons for the
     * person who tagged it). `viewer` is the member reading; guests get neither card.
     */
    async describePosts({ posts, tenantId, viewer = null }) {
      const extras = new Map();
      const tagging = posts.filter((post) => post.authorType !== 'odin' && tagsOdin(post.body));
      const odinPosts = posts.filter((post) => post.authorType === 'odin');
      if (!tagging.length && !odinPosts.length) return extras;
      const replies = await projectRepository.listOdinReplies({ postIds: tagging.map((post) => post.id), replyIds: [...new Set(odinPosts.map((post) => post.authorId))], tenantId });
      const byPost = new Map(replies.map((reply) => [reply.postId, reply]));
      const byId = new Map(replies.map((reply) => [reply.id, reply]));
      for (const post of tagging) {
        const reply = byPost.get(post.id);
        if (reply) extras.set(post.id, { odin: { status: stale(reply) ? 'failed' : TAG_STATUS[reply.status] ?? 'replied' } });
      }
      if (!viewer) return extras;
      const chats = new Map();
      for (const reply of new Set(odinPosts.map((post) => byId.get(post.authorId)).filter((reply) => reply?.chatId))) {
        chats.set(reply.id, await agentChatService.getOriginChat({ chatId: reply.chatId, tenantId, userId: reply.requesterId }).catch(() => null));
      }
      for (const post of odinPosts) {
        const reply = byId.get(post.authorId);
        const chat = reply ? chats.get(reply.id) : null;
        const message = chat?.messages.find((entry) => entry.id === post.id);
        if (!message) continue;
        const mine = reply.requesterType === 'user' && reply.requesterId === viewer.id;
        const extra = {};
        const asked = message.confirmation;
        if (asked) {
          const waiting = asked.status === 'pending' && chat.pending?.callId === asked.callId;
          extra.confirmation = { callId: asked.callId, canResolve: mine && waiting, label: asked.label, status: waiting ? 'pending' : asked.status === 'pending' ? 'expired' : asked.status, target: asked.target ?? '' };
        }
        const changes = presentChanges(message.changes);
        if (changes) extra.changes = { ...changes, canUndo: mine };
        if (Object.keys(extra).length) extras.set(post.id, { odinReply: { ...extra, forYou: mine } });
      }
      return extras;
    },

    /** The person who tagged Odin confirms or cancels the action its reply waits on. */
    async resolveConfirmation({ input, postId, projectId, user }) {
      const { reply } = await requireOdinPost({ postId, projectId, user });
      await agentChatService.resolveConfirmation({ chatId: reply.chatId, input: { callId: input.callId, decision: input.decision }, user });
      return { channelId: reply.channelId, ok: true };
    },

    /** The person who tagged Odin undoes what one of its replies changed. */
    async undo({ postId, projectId, user }) {
      const { reply } = await requireOdinPost({ postId, projectId, user });
      await agentChatService.undoChanges({ chatId: reply.chatId, messageId: postId, user });
      return { channelId: reply.channelId, ok: true };
    },

    /**
     * The durable worker's handler for ODIN_RUN_TYPE: runs a reply that no process started, and
     * posts a note for one that a restart cut off. Anything else is left alone.
     */
    async runDurable({ abortSignal = null, executionRun, payload }) {
      const reply = await projectRepository.getOdinReply({ replyId: String(payload?.replyId ?? ''), tenantId: executionRun?.tenantId });
      if (!reply) return { skipped: 'missing' };
      if (reply.status === 'queued') {
        const [post, channel] = await Promise.all([
          projectRepository.getPost({ postId: reply.postId, tenantId: reply.tenantId }),
          projectRepository.getChannel({ channelId: reply.channelId, projectId: reply.projectId, tenantId: reply.tenantId }),
        ]);
        const user = reply.requesterType === 'user' ? await authRepository?.findUserById?.(reply.requesterId) : null;
        if (!post || !channel || (reply.requesterType === 'user' && !user)) {
          await finish(reply, { body: ODIN_NOTES.failed, error: 'missing', status: 'failed' });
          return { failed: 'missing' };
        }
        const principal = user ? { type: 'user', user } : { stakeholderId: reply.requesterId, type: 'stakeholder' };
        await this.startReply({ channel, durable: false, post, principal, reply });
        return { ran: true };
      }
      if (ODIN_REPLY_ACTIVE.has(reply.status)) {
        await finish(reply, { body: ODIN_NOTES.interrupted, error: 'interrupted', status: 'failed' });
        return { interrupted: true };
      }
      return { skipped: reply.status };
    },

    /**
     * The agent view of a channel's posts (odin_list_channel_posts): the ids of guests' posts an
     * agent may not read, because the check didn't find them clearly free of instructions aimed
     * at an AI. A member's turn can change things, so its bar is the stricter one.
     */
    async hiddenForAgents({ posts, reach = 'memberTurn', tenantId }) {
      const hidden = new Set();
      await Promise.all(posts.filter((post) => post.authorType === 'stakeholder' && !post.deletedAt).map(async (post) => {
        if (!(await postScreen.passes({ body: post.body, reach, tenantId }))) hidden.add(post.id);
      }));
      return hidden;
    },
  };
}
