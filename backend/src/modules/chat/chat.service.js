// Odin Chat's lists: every channel a person is in across their projects and engagements,
// their direct messages, the posts that tag them (Mentions) and the threads they are in
// (Threads).
//
// A person is in a project's channels when they can read the project, the same rule the
// project's Channels tab uses (channels.service.js). Engagements count only while the Consulting
// module is on; a lost engagement's channels stay listed and read-only. Guests never reach these
// routes: their sessions are refused by the auth middleware.
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { commentPlainText } from '../requirements/mentions/mention-tokens.js';
import { decodePostCursor, encodePostCursor } from '../channels/channels.service.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { DM_TARGET_TYPE, MENTIONS_PAGE_SIZE } from './chat.repository.js';
import { listDirectConversations, tenantIdOf } from './direct-messages.service.js';

const EXCERPT_LENGTH = 240;

/** A post's text as one short line, for lists. */
export function postExcerpt(body) {
  const text = commentPlainText(body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

/**
 * The projects whose channels the person is in, each with its channels: delivery projects they
 * can read, and engagements while the Consulting module is on. `ensureGeneral` makes a missing
 * General channel, as the Channels tab does on first look.
 */
export async function chatScope(deps, user, { ensureGeneral = true } = {}) {
  const tenantId = tenantIdOf(user);
  const consulting = await isModuleEnabled(deps.workspaceModulesRepository, tenantId, CONSULTING_MODULE);
  const projects = await deps.projectRepository.listProjectsForTenant({ includeEngagements: consulting, tenantId, user });
  const engagements = consulting && projects.some((project) => project.kind === PROJECT_KIND_ENGAGEMENT)
    ? new Map((await deps.projectRepository.listEngagements({ tenantId, user })).map((engagement) => [engagement.id, engagement]))
    : new Map();
  let channels = await deps.projectRepository.listChannelsInProjects({ projectIds: projects.map((project) => project.id), tenantId });
  if (ensureGeneral) {
    const withGeneral = new Set(channels.filter((channel) => channel.isGeneral).map((channel) => channel.projectId));
    const missing = projects.filter((project) => !withGeneral.has(project.id));
    for (const project of missing) await deps.projectRepository.ensureGeneralChannel({ projectId: project.id, tenantId, userId: user.id });
    if (missing.length) channels = await deps.projectRepository.listChannelsInProjects({ projectIds: projects.map((project) => project.id), tenantId });
  }
  const places = projects.map((project) => {
    const engagement = project.kind === PROJECT_KIND_ENGAGEMENT ? engagements.get(project.id) ?? null : null;
    return {
      customer: engagement?.customer ?? '',
      id: project.id,
      kind: project.kind === PROJECT_KIND_ENGAGEMENT ? PROJECT_KIND_ENGAGEMENT : 'delivery',
      name: project.name,
      readOnly: engagement?.status === 'lost',
      status: engagement?.status ?? null,
    };
  });
  return { channels, places, tenantId };
}

// General first, then by name.
const byChannelOrder = (left, right) => (Number(right.isGeneral) - Number(left.isGeneral)) || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
// Lost engagements last, then by name.
const byPlaceOrder = (left, right) => (Number(left.readOnly) - Number(right.readOnly)) || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });

/**
 * The sidebar: direct messages (Odin is pinned by the screen), then each project or engagement
 * with its open channels, unread and mention counts, and the totals the top bar's Chat badge shows.
 */
export async function getChatSidebarForUser(deps, user, { ensureGeneral = true } = {}) {
  const { channels, places, tenantId } = await chatScope(deps, user, { ensureGeneral });
  const open = channels.filter((channel) => !channel.archivedAt);
  const ids = open.map((channel) => channel.id);
  const [unread, mentions, directMessages] = await Promise.all([
    deps.projectRepository.countUnread({ channelIds: ids, principalId: user.id, principalType: 'user', tenantId }),
    deps.projectRepository.countUnreadChannelMentions({ channelIds: ids, tenantId, userId: user.id }),
    listDirectConversations(deps, user),
  ]);
  const groups = places.map((place) => {
    const inPlace = open.filter((channel) => channel.projectId === place.id).sort(byChannelOrder).map((channel) => ({
      id: channel.id,
      isGeneral: Boolean(channel.isGeneral),
      mentionCount: mentions.get(channel.id) ?? 0,
      name: channel.name,
      unreadCount: unread.get(channel.id) ?? 0,
    }));
    return {
      ...place,
      channels: inPlace,
      mentionCount: inPlace.reduce((sum, channel) => sum + channel.mentionCount, 0),
      unreadCount: inPlace.reduce((sum, channel) => sum + channel.unreadCount, 0),
    };
  }).sort(byPlaceOrder);
  const channelUnread = groups.reduce((sum, group) => sum + group.unreadCount, 0);
  const dmUnread = directMessages.reduce((sum, conversation) => sum + conversation.unreadCount, 0);
  return {
    directMessages,
    groups,
    ok: true,
    totals: {
      channels: channelUnread,
      directMessages: dmUnread,
      mentions: groups.reduce((sum, group) => sum + group.mentionCount, 0) + directMessages.reduce((sum, conversation) => sum + conversation.mentionCount, 0),
      unread: channelUnread + dmUnread,
    },
  };
}

/**
 * Just the totals, for the Chat badge in Odin proper's top bar. Read on every page, so it makes no
 * General channel: a project without one has nothing unread.
 */
export async function getChatUnreadForUser(deps, user) {
  const { totals } = await getChatSidebarForUser(deps, user, { ensureGeneral: false });
  return { ok: true, ...totals };
}

// Where each channel and conversation is, for the posts Mentions and Threads list.
async function placesById(deps, user) {
  const { channels, places } = await chatScope(deps, user, { ensureGeneral: false });
  const projects = new Map(places.map((place) => [place.id, place]));
  const channelPlaces = new Map(channels.map((channel) => {
    const project = projects.get(channel.projectId);
    return [channel.id, { channelId: channel.id, channelName: channel.name, kind: project?.kind ?? 'delivery', projectId: channel.projectId, projectName: project?.name ?? '', type: 'channel' }];
  }));
  const conversations = await listDirectConversations(deps, user);
  const conversationPlaces = new Map(conversations.map((conversation) => [conversation.id, { conversationId: conversation.id, title: conversation.title, type: DM_TARGET_TYPE }]));
  return { channelPlaces, conversationPlaces, conversations };
}

function placeOf(post, { channelPlaces, conversationPlaces }) {
  return post.targetType === DM_TARGET_TYPE ? conversationPlaces.get(post.targetId) ?? null : channelPlaces.get(post.targetId) ?? null;
}

function presentListedPost(post) {
  return {
    author: { id: post.authorId, name: post.authorName || (post.authorType === 'stakeholder' ? 'Guest' : 'Former member'), type: post.authorType },
    createdAt: post.createdAt,
    excerpt: postExcerpt(post.body),
    id: post.id,
    parentId: post.parentId ?? null,
  };
}

/** Posts and replies that tag the person, newest first, a page at a time. */
export async function listMentionsForUser(deps, user, { before = null, limit = MENTIONS_PAGE_SIZE } = {}) {
  const tenantId = tenantIdOf(user);
  const places = await placesById(deps, user);
  const page = await deps.projectRepository.listMentionPosts({
    before: decodePostCursor(before),
    channelIds: [...places.channelPlaces.keys()],
    conversationIds: [...places.conversationPlaces.keys()],
    limit,
    tenantId,
    userId: user.id,
  });
  return {
    mentions: page.posts.map((post) => ({ place: placeOf(post, places), post: presentListedPost(post) })).filter((entry) => entry.place),
    nextCursor: page.hasMore && page.posts.length ? encodePostCursor(page.posts.at(-1)) : null,
    ok: true,
  };
}

/**
 * Threads with replies that the person started or replied in, latest reply first. newReplyCount
 * counts replies by others since the person last read the channel or conversation.
 */
export async function listThreadsForUser(deps, user) {
  const tenantId = tenantIdOf(user);
  const places = await placesById(deps, user);
  const channelIds = [...places.channelPlaces.keys()];
  const threads = await deps.projectRepository.listThreadsForMember({ channelIds, conversationIds: [...places.conversationPlaces.keys()], tenantId, userId: user.id });
  const channelReads = await deps.projectRepository.listChannelReads({ channelIds: [...new Set(threads.filter((thread) => thread.root.targetType === 'channel').map((thread) => thread.root.targetId))], userId: user.id });
  const dmReads = new Map(places.conversations.map((conversation) => [conversation.id, conversation.lastReadAt]));
  return {
    ok: true,
    threads: threads.map(({ lastReplyAt, replies, root }) => {
      const lastReadAt = (root.targetType === DM_TARGET_TYPE ? dmReads.get(root.targetId) : channelReads.get(root.targetId)) ?? null;
      const latest = replies.at(-1);
      return {
        lastReply: latest ? presentListedPost(latest) : null,
        lastReplyAt,
        newReplyCount: replies.filter((reply) => !(reply.authorType === 'user' && reply.authorId === user.id) && (!lastReadAt || reply.createdAt > lastReadAt)).length,
        place: placeOf(root, places),
        replyCount: replies.length,
        root: { ...presentListedPost(root), deleted: Boolean(root.deletedAt), excerpt: root.deletedAt ? '' : postExcerpt(root.body) },
      };
    }).filter((thread) => thread.place),
  };
}
