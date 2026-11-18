// Channels and their conversations, unread counts, file comments, library folders and the
// editing marker (docs/engagements/plan.md: Channels and conversation, Files; qna.md E-02 to
// E-07). Every project has channels, delivery projects and engagements alike.
//
// Who may do what:
// - Everyone in the project (project.read) sees every channel, its posts and its library (E-02).
// - Internal members who collaborate (project.collaborate) add channels, rename them, post,
//   reply and comment on files. Authors edit and delete their own posts (E-05).
// - People with decision rights archive and restore channels, and delete anyone's post (E-04).
// - Changing the library (folders, the editing marker) needs project.files.write, as files do.
// - General can be neither renamed nor archived. An archived channel is read-only: its posts,
//   library, folders and file comments refuse changes until it is restored.
// - Guests (workstream 6) reach only the channels they are in, through a context the guests
//   module builds (guests.service.js): they post, reply, comment and mark files as editing there,
//   and edit and delete their own posts. Every function here takes that context (`ctx`), so
//   members and guests go through the same checks; the *ForUser functions build a member's.
import { hasDecisionRights } from '../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, getTenantMembership, hasProjectCapability, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { memberPrincipal } from '../notifications/notifications.service.js';
import { mentionedActors, resolveMentions } from '../requirements/mentions/mention-tokens.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';
import { channelArchivedError, folderPaths } from './channel-library.js';
import { appBaseUrl } from './channel-links.js';
import { GENERAL_CHANNEL_NAME, editingMarker } from './channels.repository.js';
import { SCREENED_POST_NOTE } from './odin-screen.js';
import { normalizeOdinTags, ODIN_MENTIONABLE } from './odin-tag.js';
import { closePoll, pollBody, preparePoll, readPoll, savePoll, votePoll, withPolls } from './polls.service.js';
import { reactionsFor, requireReplyTo, setReaction } from './post-reactions.js';

export const POSTS_PAGE_SIZE = 30;
export const MAX_POSTS_PAGE = 200;
export const MAX_POST_ATTACHMENTS = 10;

function forbidden(message, code) {
  return new HttpError(403, message, { details: { code } });
}

function tenantIdOf(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

/**
 * The caller's rights on a project's channels. Anyone who cannot read the project gets the
 * same 404 as a missing project. A lost engagement is read-only (engagement-guard.js refuses its
 * writes before they get here); the flags say so for the screen.
 */
export async function channelAccess(deps, user, projectId) {
  const tenantId = tenantIdOf(user);
  const access = await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: deps.projectRepository, tenantId, user });
  const tenantRole = getTenantMembership(user, tenantId)?.role;
  const can = (capability) => hasProjectCapability({ capability, projectRole: access?.projectRole, tenantRole, userCapabilities: user.capabilities });
  const kind = deps.projectRepository.getProjectKind ? await deps.projectRepository.getProjectKind({ projectId }) : null;
  const readOnly = kind?.kind === PROJECT_KIND_ENGAGEMENT && kind.engagementStatus === 'lost';
  return {
    canCollaborate: !readOnly && can(PROJECT_CAPABILITIES.COLLABORATE),
    canDecide: !readOnly && hasDecisionRights({ projectRole: access?.projectRole, tenantRole }),
    // Decision rights whatever the engagement's state: removing a guest still works once it is lost.
    decisionRights: hasDecisionRights({ projectRole: access?.projectRole, tenantRole }),
    // Renaming and describing channels: members who collaborate, never guests.
    canManageChannels: !readOnly && can(PROJECT_CAPABILITIES.COLLABORATE),
    canWriteFiles: !readOnly && can(PROJECT_CAPABILITIES.FILE_WRITE),
    // Null for members, who see every channel. A guest's context lists the channels they are in.
    channelIds: null,
    // The account file records and the editing marker name: the member, or a guest's file owner.
    fileActor: { id: user.id, name: user.name ?? '' },
    guest: false,
    kind: kind?.kind ?? 'delivery',
    // Who writes posts and reads channels: { type: 'user' | 'stakeholder', id, name }.
    principal: { id: user.id, name: user.name ?? '', timezone: user.timezone ?? 'UTC', type: 'user' },
    // For notification level defaults: the engagement's owner and the caller's project role.
    project: kind,
    projectId,
    projectRole: access?.projectRole ?? null,
    readOnly,
    tenantId,
    user,
  };
}

const isPrincipal = (ctx, type, id) => ctx.principal.type === type && ctx.principal.id === id;

// A channel or file outside a guest's channels is answered as missing, never as forbidden.
function inScope(ctx, channelId) {
  return !ctx.channelIds || ctx.channelIds.has(channelId);
}

// "Let Odin answer when tagged" (E-16): each channel's own setting, on by default. Without Odin
// wired in, @odin stays text.
function odinEnabled(deps, channel) {
  return Boolean(deps.odinChannelService) && channel?.odinEnabled !== false;
}

// What posts show about Odin (odin-channel.service.js describePosts), by post id. A guest is no
// member, so no confirm button is theirs (`viewer` null).
async function odinExtras(deps, ctx, posts) {
  if (!deps.odinChannelService || !posts.length) return new Map();
  return deps.odinChannelService.describePosts({ posts, tenantId: ctx.tenantId, viewer: ctx.user ?? null });
}

// Who tagged Odin, as odin-channel.service.js afterPostCreated takes them.
function odinPrincipal(ctx) {
  return ctx.user ? { type: 'user', user: ctx.user } : { name: ctx.principal.name, stakeholderId: ctx.principal.id, type: 'stakeholder' };
}

function requireCollaborate(ctx) {
  if (!ctx.canCollaborate) throw forbidden('You can read this project’s channels, but not post or change them.', 'channel_read_only_member');
}

function requireDecide(ctx) {
  if (!ctx.canDecide) throw forbidden('Only a project admin or manager can do that.', 'decision_rights_required');
}

function requireFileWrite(ctx) {
  if (!ctx.canWriteFiles) throw forbidden('You can read this library, but not change it.', 'library_read_only_member');
}

async function requireChannel(deps, ctx, channelId) {
  if (!inScope(ctx, channelId)) throw new HttpError(404, 'Channel not found.');
  const channel = await deps.projectRepository.getChannel({ channelId, projectId: ctx.projectId, tenantId: ctx.tenantId });
  if (!channel) throw new HttpError(404, 'Channel not found.');
  return channel;
}

function requireOpen(channel) {
  if (channel?.archivedAt) throw channelArchivedError();
}

export function presentChannel(channel, ctx, unreadCount = 0, notificationLevel = null) {
  const open = !channel.archivedAt;
  return {
    archivedAt: channel.archivedAt ?? null,
    canArchive: ctx.canDecide && !channel.isGeneral && open,
    canEdit: ctx.canManageChannels && open,
    canPost: ctx.canCollaborate && open,
    canRename: ctx.canManageChannels && open && !channel.isGeneral,
    canRestore: ctx.canDecide && !open,
    canSwitchOdin: ctx.canDecide && open,
    canUpload: ctx.canWriteFiles && open,
    createdAt: channel.createdAt,
    description: channel.description ?? '',
    id: channel.id,
    isGeneral: Boolean(channel.isGeneral),
    name: channel.name,
    // "Let Odin answer when tagged": everyone sees it; decision rights switch it (E-16, AC-25).
    odinEnabled: channel.odinEnabled !== false,
    // The caller's level here ({ level, isDefault }), on the channel list (docs/odin-chat/plan.md, Levels).
    ...(notificationLevel ? { notificationLevel } : {}),
    unreadCount,
  };
}

// General first, then open channels by name, then archived ones.
function sortChannels(channels) {
  return channels.sort((left, right) => (Number(right.isGeneral) - Number(left.isGeneral))
    || (Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)))
    || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function validChannelName(name) {
  const value = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!value) throw new HttpError(400, 'Enter a channel name.', { details: { code: 'channel_name_required' } });
  if (value.toLowerCase() === GENERAL_CHANNEL_NAME.toLowerCase()) throw new HttpError(409, 'Every project already has a General channel.', { details: { code: 'channel_name_taken' } });
  return value;
}

// --- channels --------------------------------------------------------------------------------

/** Every channel in the project, with General made the first time anyone looks. */
export async function listChannelsForUser(deps, user, projectId) {
  const ctx = await channelAccess(deps, user, projectId);
  await deps.projectRepository.ensureGeneralChannel({ projectId, tenantId: ctx.tenantId, userId: user.id });
  const channels = await deps.projectRepository.listChannels({ projectId, tenantId: ctx.tenantId });
  const channelIds = channels.map((channel) => channel.id);
  const unread = await deps.projectRepository.countUnread({ channelIds, principalId: user.id, principalType: 'user', tenantId: ctx.tenantId });
  const levels = deps.notifications ? await deps.notifications.channelLevels(memberPrincipal(user), { channelIds, project: ctx.project, projectRole: ctx.projectRole }) : new Map();
  return {
    channels: sortChannels(channels).map((channel) => presentChannel(channel, ctx, channel.archivedAt ? 0 : unread.get(channel.id) ?? 0, levels.get(channel.id) ?? null)),
    // Whether Odin can answer here at all. Each channel says whether it does (odinEnabled).
    odin: { available: Boolean(deps.odinChannelService) },
    ok: true,
    permissions: { canCreate: ctx.canCollaborate, canDecide: ctx.canDecide, canUpload: ctx.canWriteFiles, readOnly: ctx.readOnly },
  };
}

export async function createChannelForUser(deps, user, projectId, input) {
  const ctx = await channelAccess(deps, user, projectId);
  requireCollaborate(ctx);
  await deps.projectRepository.ensureGeneralChannel({ projectId, tenantId: ctx.tenantId, userId: user.id });
  const channel = await deps.projectRepository.createChannel({ description: input.description ?? '', name: validChannelName(input.name), projectId, tenantId: ctx.tenantId, user });
  return { channel: presentChannel(channel, ctx), ok: true };
}

export async function updateChannelForUser(deps, user, projectId, channelId, input) {
  const ctx = await channelAccess(deps, user, projectId);
  requireCollaborate(ctx);
  const channel = await requireChannel(deps, ctx, channelId);
  requireOpen(channel);
  const changes = {};
  if (input.name !== undefined && input.name.trim() !== channel.name) {
    if (channel.isGeneral) throw new HttpError(409, 'General keeps its name.', { details: { code: 'general_channel' } });
    changes.name = validChannelName(input.name);
  }
  if (input.description !== undefined) changes.description = input.description.trim();
  if (input.odinEnabled !== undefined && input.odinEnabled !== (channel.odinEnabled !== false)) {
    // Only decision rights switch Odin (AC-25).
    requireDecide(ctx);
    requireOdin(deps);
    changes.odinEnabled = input.odinEnabled;
  }
  if (!Object.keys(changes).length) return { channel: presentChannel(channel, ctx), ok: true };
  const saved = await deps.projectRepository.updateChannel({ changes, channelId, projectId, tenantId: ctx.tenantId, user });
  return { channel: presentChannel(saved, ctx), ok: true };
}

export async function archiveChannelForUser(deps, user, projectId, channelId) {
  const ctx = await channelAccess(deps, user, projectId);
  requireDecide(ctx);
  const channel = await requireChannel(deps, ctx, channelId);
  if (channel.isGeneral) throw new HttpError(409, 'General cannot be archived.', { details: { code: 'general_channel' } });
  if (channel.archivedAt) return { channel: presentChannel(channel, ctx), ok: true };
  const saved = await deps.projectRepository.setChannelArchived({ archived: true, channelId, projectId, tenantId: ctx.tenantId, user });
  return { channel: presentChannel(saved, ctx), ok: true };
}

export async function restoreChannelForUser(deps, user, projectId, channelId) {
  const ctx = await channelAccess(deps, user, projectId);
  requireDecide(ctx);
  const channel = await requireChannel(deps, ctx, channelId);
  if (!channel.archivedAt) return { channel: presentChannel(channel, ctx), ok: true };
  const saved = await deps.projectRepository.setChannelArchived({ archived: false, channelId, projectId, tenantId: ctx.tenantId, user });
  return { channel: presentChannel(saved, ctx), ok: true };
}

export async function markChannelReadForUser(deps, user, projectId, channelId) {
  return markChannelRead(deps, await channelAccess(deps, user, projectId), channelId);
}

export async function markChannelRead(deps, ctx, channelId) {
  await requireChannel(deps, ctx, channelId);
  const lastReadAt = await deps.projectRepository.markChannelRead({ channelId, principalId: ctx.principal.id, principalType: ctx.principal.type });
  // Opening a channel, a post or a thread in it reads its notifications (plan.md, Records).
  const reader = notificationPrincipal(ctx);
  if (reader) await deps.notifications?.markRead(reader, { channelId });
  return { lastReadAt, ok: true, unreadCount: 0 };
}

// --- people who can be mentioned ------------------------------------------------------------

// Project members, and the channel's guests (stakeholders), as
// [{ actorType, actorId, name, email, detail, projectRole }].
async function channelPeople(deps, ctx, channelId) {
  const valid = await deps.projectRepository.getValidUsers({ projectId: ctx.projectId, tenantId: ctx.tenantId });
  const people = (valid?.project_users ?? []).filter((member) => member?.id).map((member) => ({ actorId: String(member.id), actorType: 'user', detail: 'Team', email: member.email ?? '', name: member.name || 'Team member', projectRole: member.role ?? null }));
  // Workspace admins and managers reach every project without being on its member list.
  for (const tenantUser of valid?.tenant_users ?? []) {
    if (['admin', 'manager'].includes(String(tenantUser.role ?? '').toLowerCase()) && !people.some((person) => person.actorId === String(tenantUser.id))) {
      people.push({ actorId: String(tenantUser.id), actorType: 'user', detail: 'Team', email: tenantUser.email ?? '', name: tenantUser.name || 'Team member', projectRole: null });
    }
  }
  if (channelId) {
    for (const guest of await deps.projectRepository.listChannelGuests?.({ channelId, tenantId: ctx.tenantId }) ?? []) {
      people.push({ actorId: guest.stakeholderId, actorType: 'stakeholder', detail: 'Guest', email: guest.email ?? '', name: guest.name || 'Guest' });
    }
  }
  return people;
}

/** The people of a channel as notifications take them, for a writer with no context (Odin). */
export function channelPeopleFor(deps, { channelId, projectId, tenantId }) {
  return channelPeople(deps, { projectId, tenantId }, channelId);
}

function presentMentionables(people, ctx) {
  return people
    .filter((person) => !isPrincipal(ctx, person.actorType, person.actorId))
    .map((person) => ({ detail: person.detail, kind: person.actorType === 'stakeholder' ? 'stakeholder' : 'team', name: person.name, ref: `${person.actorType}:${person.actorId}` }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listChannelMentionablesForUser(deps, user, projectId, channelId) {
  return listChannelMentionables(deps, await channelAccess(deps, user, projectId), channelId);
}

export async function listChannelMentionables(deps, ctx, channelId) {
  const channel = await requireChannel(deps, ctx, channelId);
  const people = presentMentionables(await channelPeople(deps, ctx, channelId), ctx);
  // Odin first where the channel lets it answer; its token is its own (odin-tag.js).
  return { ok: true, people: odinEnabled(deps, channel) ? [{ ...ODIN_MENTIONABLE }, ...people] : people };
}

export async function listFileMentionablesForUser(deps, user, projectId, fileId) {
  return listFileMentionables(deps, await channelAccess(deps, user, projectId), fileId);
}

export async function listFileMentionables(deps, ctx, fileId) {
  const file = await requireFile(deps, ctx, fileId);
  return { ok: true, people: presentMentionables(await channelPeople(deps, ctx, file.targetType === 'channel' ? file.targetId : null), ctx) };
}

// Resolves the tags in a body being saved against the people who may be tagged there. Returns
// the body to store and the people it newly tags (an edit tags only those it adds).
function prepareMentions(body, people, previousBody = '') {
  const resolved = resolveMentions(body, { people: people.map((person) => ({ actorId: person.actorId, actorType: person.actorType, name: person.name })) });
  const before = new Set(mentionedActors(previousBody).map((entry) => entry.actorRef));
  return { body: resolved.body, added: resolved.mentioned.filter((entry) => !before.has(entry.actorRef)) };
}

function appBase(deps) {
  return appBaseUrl(deps.frontendAppUrl);
}

/** Where a guest opens a channel, a post or a file: the guest view, which asks them to sign in. */
export function guestChannelUrl(deps, { channelId, fileId = null, postId = null }) {
  const query = new URLSearchParams();
  if (fileId) {
    query.set('tab', 'files');
    query.set('file', fileId);
  }
  if (postId) query.set('post', postId);
  const search = query.toString();
  return `${appBase(deps)}/guest/channels/${encodeURIComponent(channelId)}${search ? `?${search}` : ''}`;
}

// Whose notifications a context reads: a member's, or a guest's, kept under their workspace
// access link (guests/guest-notifications.js).
function notificationPrincipal(ctx) {
  if (ctx.user) return memberPrincipal(ctx.user);
  return ctx.accessLinkId ? { principalId: String(ctx.accessLinkId), principalType: 'guest', tenantId: ctx.tenantId } : null;
}

/**
 * Records the notifications a post, reply or comment makes (modules/notifications) and returns
 * the ids of the members it tagged. The author is the member or guest writing (ctx.principal).
 * Email follows from them in the rolled-up digest, never at once (docs/odin-chat/qna.md Q-04),
 * for guests as for members. A failure never undoes the post.
 */
async function notifyPost(deps, ctx, { channel = null, file = null, isEdit = false, parent = null, people, post, tagged }) {
  if (!deps.notifications) return [];
  const notified = await deps.notifications.notifyPost({
    author: { id: ctx.principal.id, name: ctx.principal.name ?? '', type: ctx.principal.type },
    channel,
    file,
    isEdit,
    mentioned: tagged,
    parent,
    people,
    post,
    projectId: ctx.projectId,
    tenantId: ctx.tenantId,
  });
  return notified.filter((entry) => entry.kind === 'mention' && entry.actorRef.startsWith('user:')).map((entry) => entry.actorRef.slice('user:'.length));
}

// --- posts ------------------------------------------------------------------------------------

export function encodePostCursor(post) {
  return Buffer.from(JSON.stringify({ c: post.createdAt, i: post.id })).toString('base64url');
}

export function decodePostCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof value?.c !== 'string' || typeof value?.i !== 'string' || Number.isNaN(Date.parse(value.c))) throw new Error('bad cursor');
    return { createdAt: new Date(value.c).toISOString(), id: value.i };
  } catch {
    throw new HttpError(400, 'That page link is not valid. Reload the conversation.', { details: { code: 'invalid_cursor' } });
  }
}

function authorOf(post) {
  if (post.authorType === 'odin') return { id: null, name: 'Odin', type: 'odin' };
  return { id: post.authorId, name: post.authorName || (post.authorType === 'stakeholder' ? 'Guest' : 'Former member'), type: post.authorType };
}

// Exported for direct messages (chat/), which present their posts as channel posts are.
export function presentPost(post, ctx, { attachments = new Map(), extras = new Map(), open = true, reactions = new Map(), replies = [] } = {}) {
  const deleted = Boolean(post.deletedAt);
  const isMine = isPrincipal(ctx, post.authorType, post.authorId);
  const extra = deleted ? {} : extras.get(post.id) ?? {};
  return {
    ...extra,
    attachments: deleted ? [] : attachments.get(post.id) ?? [],
    author: authorOf(post),
    body: deleted ? '' : post.body,
    canDelete: open && !deleted && (isMine ? ctx.canCollaborate : ctx.canDecide),
    canEdit: open && !deleted && isMine && ctx.canCollaborate,
    canReact: open && !deleted && ctx.canCollaborate,
    // Reply on a reply answers it in the same thread, with a quote of it (replyToId).
    canReply: open && !deleted && ctx.canCollaborate,
    createdAt: post.createdAt,
    deleted,
    editedAt: deleted ? null : post.editedAt ?? null,
    fileVersion: post.fileVersion ?? null,
    id: post.id,
    isMine,
    parentId: post.parentId ?? null,
    reactions: deleted ? [] : reactions.get(post.id) ?? [],
    replies: replies.map((reply) => presentPost(reply, ctx, { attachments, extras, open, reactions })),
    replyToId: post.replyToId ?? null,
    targetId: post.targetId,
    targetType: post.targetType,
  };
}

// Each post's attachments, wherever in the project they are now: a file moved out of the channel's
// library to the project's files or another channel stays on the post (docs/engagements/plan.md,
// Folders). A guest sees only those still in their channels' libraries.
async function attachmentsFor(deps, ctx, { posts }) {
  const links = await deps.projectRepository.listPostFileIds({ postIds: posts.map((post) => post.id) });
  const byPost = new Map();
  if (!links.length) return byPost;
  const all = await deps.projectRepository.listFiles({ projectId: ctx.projectId, targetId: ctx.projectId, targetType: 'project', tenantId: ctx.tenantId, user: ctx.fileActor });
  const files = new Map(all
    .filter((file) => !ctx.channelIds || (file.targetType === 'channel' && ctx.channelIds.has(file.targetId)))
    .map((file) => [file.id, file]));
  for (const link of links) {
    const file = files.get(link.fileId);
    if (!file) continue;
    const list = byPost.get(link.postId) ?? [];
    list.push({ contentType: file.contentType, fileName: file.fileName, fileSize: file.fileSize, folderId: file.folderId ?? null, id: file.id, scanStatus: file.scanStatus, version: file.version });
    byPost.set(link.postId, list);
  }
  return byPost;
}

// The agent view (agentView=1, as the assistant's channel tools ask): a guest's post an agent may
// not read comes back as a note instead of its text (odin-screen.js). With no screen to ask, none
// of guests' posts can be shown.
async function forAgents(deps, ctx, page) {
  const all = [...page.posts, ...page.replies];
  const hidden = deps.odinChannelService
    ? await deps.odinChannelService.hiddenForAgents({ posts: all, tenantId: ctx.tenantId })
    : new Set(all.filter((post) => post.authorType === 'stakeholder').map((post) => post.id));
  const shown = (post) => (hidden.has(post.id) ? { ...post, body: SCREENED_POST_NOTE } : post);
  return { ...page, posts: page.posts.map(shown), replies: page.replies.map(shown) };
}

async function threadPage(deps, ctx, { agentView = false, before, limit, open, targetId, targetType, channelId = null }) {
  const read = await deps.projectRepository.listPosts({ before, limit, targetId, targetType, tenantId: ctx.tenantId });
  const page = agentView ? await forAgents(deps, ctx, read) : read;
  const all = [...page.posts, ...page.replies];
  const attachments = channelId ? await attachmentsFor(deps, ctx, { channelId, posts: all }) : new Map();
  const extras = await withPolls(deps, ctx, all, targetType === 'channel' ? await odinExtras(deps, ctx, all) : new Map(), { open });
  const reactions = await reactionsFor(deps.projectRepository, { posts: all, principal: ctx.principal, tenantId: ctx.tenantId });
  const repliesOf = new Map();
  for (const reply of page.replies) {
    const list = repliesOf.get(reply.parentId) ?? [];
    list.push(reply);
    repliesOf.set(reply.parentId, list);
  }
  return {
    nextCursor: page.hasMore && page.posts.length ? encodePostCursor(page.posts.at(-1)) : null,
    posts: page.posts.map((post) => presentPost(post, ctx, { attachments, extras, open, reactions, replies: repliesOf.get(post.id) ?? [] })),
  };
}

/** A page of a channel's conversation: top-level posts newest first, each with its replies. */
export async function listPostsForUser(deps, user, projectId, channelId, query = {}) {
  return listPosts(deps, await channelAccess(deps, user, projectId), channelId, query);
}

// `agentView` comes only from the members' route (the assistant's channel tools); the guest
// route's query has no such field.
export async function listPosts(deps, ctx, channelId, { agentView = false, before = null, limit = POSTS_PAGE_SIZE } = {}) {
  const channel = await requireChannel(deps, ctx, channelId);
  const open = !channel.archivedAt;
  const page = await threadPage(deps, ctx, { agentView, before: decodePostCursor(before), channelId, limit: Math.min(MAX_POSTS_PAGE, limit), open, targetId: channelId, targetType: 'channel' });
  return { canPost: ctx.canCollaborate && open, channel: presentChannel(channel, ctx), ok: true, ...page };
}

async function requireReplyParent(deps, ctx, { parentId, targetId, targetType }) {
  if (!parentId) return null;
  const parent = await deps.projectRepository.getPost({ postId: parentId, projectId: ctx.projectId, tenantId: ctx.tenantId });
  if (!parent || parent.targetType !== targetType || parent.targetId !== targetId) throw new HttpError(404, 'The message you are replying to is not here.');
  if (parent.parentId) throw new HttpError(400, 'Replies go one level deep. Reply to the first message instead.', { details: { code: 'reply_depth' } });
  if (parent.deletedAt) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  return parent;
}

function requireBody(body, { attachments = 0 } = {}) {
  const text = String(body ?? '').trim();
  if (!text && !attachments) throw new HttpError(400, 'Write a message or attach a file.', { details: { code: 'post_empty' } });
  return text;
}

export async function createPostForUser(deps, user, projectId, channelId, input) {
  return createPost(deps, await channelAccess(deps, user, projectId), channelId, input);
}

export async function createPost(deps, ctx, channelId, input) {
  const { projectId } = ctx;
  requireCollaborate(ctx);
  const channel = await requireChannel(deps, ctx, channelId);
  requireOpen(channel);
  const parent = await requireReplyParent(deps, ctx, { parentId: input.parentId, targetId: channelId, targetType: 'channel' });
  const replyToId = await requireReplyTo(deps.projectRepository, { parentId: input.parentId ?? null, replyToId: input.replyToId ?? null, targetId: channelId, targetType: 'channel', tenantId: ctx.tenantId });
  const fileIds = [...new Set(input.fileIds ?? [])];
  if (fileIds.length > MAX_POST_ATTACHMENTS) throw new HttpError(400, `A message can carry up to ${MAX_POST_ATTACHMENTS} files.`, { details: { code: 'too_many_attachments' } });
  if (fileIds.length) {
    // Attachments are uploaded into this channel's library first (plan: Channels, Posts).
    const inChannel = new Set((await deps.projectRepository.listFiles({ projectId, targetId: channelId, targetType: 'channel', tenantId: ctx.tenantId, user: ctx.fileActor })).map((file) => file.id));
    const outside = fileIds.filter((fileId) => !inChannel.has(fileId));
    if (outside.length) throw new HttpError(400, 'Attach files from this channel’s library.', { details: { code: 'attachment_not_in_channel', fileIds: outside } });
  }
  const people = await channelPeople(deps, ctx, channelId);
  const poll = preparePoll(input);
  const tagged = prepareMentions(normalizeOdinTags(requireBody(pollBody(input.body, poll), { attachments: fileIds.length }), { enabled: odinEnabled(deps, channel) }), people);
  const post = await deps.projectRepository.createPost({
    fileIds,
    post: { authorId: ctx.principal.id, authorType: ctx.principal.type, body: tagged.body, parentId: input.parentId ?? null, projectId, replyToId, targetId: channelId, targetType: 'channel', tenantId: ctx.tenantId },
  });
  await savePoll(deps, ctx, post, poll);
  const mentioned = await notifyPost(deps, ctx, { channel, parent, people, post, tagged: tagged.added });
  // A post that tags @odin gets one answer in its thread (an edit that adds the tag counts too).
  await deps.odinChannelService?.afterPostCreated({ channel, post, principal: odinPrincipal(ctx) });
  // The writer has read their own channel up to their post, and its notifications with it.
  await deps.projectRepository.markChannelRead({ channelId, principalId: ctx.principal.id, principalType: ctx.principal.type });
  const reader = notificationPrincipal(ctx);
  if (reader) await deps.notifications?.markRead(reader, { channelId });
  const attachments = await attachmentsFor(deps, ctx, { channelId, posts: [post] });
  return { mentioned, ok: true, post: presentPost(post, ctx, { attachments, extras: await withPolls(deps, ctx, [post], await odinExtras(deps, ctx, [post])) }) };
}

export async function signalTypingForUser(deps, user, projectId, channelId, input) {
  return signalTyping(deps, await channelAccess(deps, user, projectId), channelId, input);
}

/**
 * A typing signal for the channel's box or a thread's reply box (`parentId`). Only someone who
 * could post that message may send one: the checks createPost makes, and nothing is saved.
 * Returns what channel-events.js publishes.
 */
export async function signalTyping(deps, ctx, channelId, { parentId = null, typing }) {
  requireCollaborate(ctx);
  const channel = await requireChannel(deps, ctx, channelId);
  requireOpen(channel);
  await requireReplyParent(deps, ctx, { parentId, targetId: channelId, targetType: 'channel' });
  const { id, name, type } = ctx.principal;
  return { ok: true, signal: { actor: { id, name, type }, channelId, parentId: parentId ?? null, projectId: ctx.projectId, typing: Boolean(typing) } };
}

// The post and the place it is in, for an edit or delete: a channel post, or a file comment.
async function requirePostPlace(deps, ctx, postId) {
  const post = await deps.projectRepository.getPost({ postId, projectId: ctx.projectId, tenantId: ctx.tenantId });
  if (!post) throw new HttpError(404, 'Message not found.');
  if (post.targetType === 'channel') {
    const channel = await requireChannel(deps, ctx, post.targetId);
    return { channel, channelId: channel.id, post };
  }
  const file = await requireFile(deps, ctx, post.targetId);
  const channel = file.targetType === 'channel' ? await deps.projectRepository.getChannel({ channelId: file.targetId, projectId: ctx.projectId, tenantId: ctx.tenantId }) : null;
  return { channel, channelId: channel?.id ?? null, file, post };
}

export async function updatePostForUser(deps, user, projectId, postId, input) {
  return updatePost(deps, await channelAccess(deps, user, projectId), postId, input);
}

export async function updatePost(deps, ctx, postId, input) {
  const place = await requirePostPlace(deps, ctx, postId);
  requireOpen(place.channel);
  if (place.post.deletedAt) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  if (!isPrincipal(ctx, place.post.authorType, place.post.authorId) || !ctx.canCollaborate) throw forbidden('Only the author can edit a message.', 'not_author');
  const attachments = place.channelId && place.post.targetType === 'channel' ? (await deps.projectRepository.listPostFileIds({ postIds: [postId] })).length : 0;
  const people = await channelPeople(deps, ctx, place.channelId);
  const body = place.post.targetType === 'channel' ? normalizeOdinTags(requireBody(input.body, { attachments }), { enabled: odinEnabled(deps, place.channel) }) : requireBody(input.body, { attachments });
  const tagged = prepareMentions(body, people, place.post.body);
  const saved = await deps.projectRepository.updatePost({ body: tagged.body, postId, tenantId: ctx.tenantId, user: { id: ctx.principal.id } });
  if (!saved) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  const mentioned = await notifyPost(deps, ctx, { channel: place.channel, file: place.file ?? null, isEdit: true, people, post: saved, tagged: tagged.added });
  // An edit that adds @odin asks it, like a new post. Odin answers each post once, so editing a
  // post it already answered (or is answering) does not ask again.
  if (place.post.targetType === 'channel') await deps.odinChannelService?.afterPostCreated({ channel: place.channel, post: saved, principal: odinPrincipal(ctx) });
  const files = place.post.targetType === 'channel' ? await attachmentsFor(deps, ctx, { channelId: place.channelId, posts: [saved] }) : new Map();
  const extras = place.post.targetType === 'channel' ? await withPolls(deps, ctx, [saved], await odinExtras(deps, ctx, [saved])) : new Map();
  const reactions = await reactionsFor(deps.projectRepository, { posts: [saved], principal: ctx.principal, tenantId: ctx.tenantId });
  return { channelId: place.channelId, fileId: place.file?.id ?? null, mentioned, ok: true, post: presentPost(saved, ctx, { attachments: files, extras, reactions }) };
}

/** Authors delete their own; people with decision rights delete anyone's. It reads "Message deleted" in place. */
export async function deletePostForUser(deps, user, projectId, postId) {
  return deletePost(deps, await channelAccess(deps, user, projectId), postId);
}

export async function deletePost(deps, ctx, postId) {
  const place = await requirePostPlace(deps, ctx, postId);
  requireOpen(place.channel);
  const isMine = isPrincipal(ctx, place.post.authorType, place.post.authorId);
  if (!(isMine ? ctx.canCollaborate : ctx.canDecide)) throw forbidden(isMine ? 'You can no longer change messages here.' : 'Only the author, or a project admin or manager, can delete a message.', 'not_author');
  if (place.post.deletedAt) return { channelId: place.channelId, fileId: place.file?.id ?? null, ok: true, post: presentPost(place.post, ctx) };
  const saved = await deps.projectRepository.deletePost({ postId, tenantId: ctx.tenantId, user: { id: ctx.principal.id } });
  return { channelId: place.channelId, fileId: place.file?.id ?? null, ok: true, post: presentPost(saved ?? place.post, ctx) };
}

/** Adds or removes the caller's emoji on a post or file comment: anyone who can post there. */
export async function setPostReactionForUser(deps, user, projectId, postId, input) {
  return setPostReaction(deps, await channelAccess(deps, user, projectId), postId, input);
}

export async function setPostReaction(deps, ctx, postId, { emoji, reacted }) {
  const place = await requirePostPlace(deps, ctx, postId);
  requireOpen(place.channel);
  requireCollaborate(ctx);
  const reactions = await setReaction(deps.projectRepository, { emoji, post: place.post, principal: ctx.principal, reacted, tenantId: ctx.tenantId });
  return { channelId: place.channelId, fileId: place.file?.id ?? null, ok: true, postId, reactions: reactions.get(postId) ?? [] };
}

// --- file comments ----------------------------------------------------------------------------

// --- Polls (polls.service.js) ----------------------------------------------------------------

async function requirePollPost(deps, ctx, postId) {
  const place = await requirePostPlace(deps, ctx, postId);
  if (place.post.targetType !== 'channel') throw new HttpError(404, 'That poll is not here.', { details: { code: 'poll_not_found' } });
  return place;
}

/** The poll on a channel post, as the caller sees it. */
export async function getPollForUser(deps, user, projectId, postId) {
  return getPoll(deps, await channelAccess(deps, user, projectId), postId);
}

export async function getPoll(deps, ctx, postId) {
  const place = await requirePollPost(deps, ctx, postId);
  return { channelId: place.channelId, ok: true, poll: await readPoll(deps, ctx, place.post, { open: !place.channel.archivedAt }), postId };
}

export async function votePollForUser(deps, user, projectId, postId, input) {
  return votePollIn(deps, await channelAccess(deps, user, projectId), postId, input);
}

export async function votePollIn(deps, ctx, postId, input) {
  const place = await requirePollPost(deps, ctx, postId);
  return { channelId: place.channelId, ok: true, poll: await votePoll(deps, ctx, place.post, input.answer, { open: !place.channel.archivedAt }), postId };
}

export async function closePollForUser(deps, user, projectId, postId) {
  return closePollIn(deps, await channelAccess(deps, user, projectId), postId);
}

export async function closePollIn(deps, ctx, postId) {
  const place = await requirePollPost(deps, ctx, postId);
  return { channelId: place.channelId, ok: true, poll: await closePoll(deps, ctx, place.post, { open: !place.channel.archivedAt }), postId };
}

export async function requireFile(deps, ctx, fileId) {
  const file = await deps.projectRepository.getFileRecord({ fileId, tenantId: ctx.tenantId });
  if (!file?.projectId || file.projectId !== ctx.projectId) throw new HttpError(404, 'File not found.');
  // A guest reaches only the files in their channels' libraries.
  if (ctx.channelIds && !(file.targetType === 'channel' && ctx.channelIds.has(file.targetId))) throw new HttpError(404, 'File not found.');
  return file;
}

async function fileChannel(deps, ctx, file) {
  return file.targetType === 'channel' ? deps.projectRepository.getChannel({ channelId: file.targetId, projectId: ctx.projectId, tenantId: ctx.tenantId }) : null;
}

/** A file's one discussion (E-07): comments oldest first, each with its replies and the version it was made on. */
export async function listFileCommentsForUser(deps, user, projectId, fileId) {
  return listFileComments(deps, await channelAccess(deps, user, projectId), fileId);
}

export async function listFileComments(deps, ctx, fileId) {
  const file = await requireFile(deps, ctx, fileId);
  const channel = await fileChannel(deps, ctx, file);
  const open = !channel?.archivedAt;
  const page = await threadPage(deps, ctx, { limit: MAX_POSTS_PAGE, open, targetId: fileId, targetType: 'file' });
  return {
    canComment: ctx.canCollaborate && open,
    channelId: channel?.id ?? null,
    comments: page.posts.reverse(),
    currentVersion: file.version ?? 1,
    fileId,
    more: Boolean(page.nextCursor),
    ok: true,
  };
}

export async function createFileCommentForUser(deps, user, projectId, fileId, input) {
  return createFileComment(deps, await channelAccess(deps, user, projectId), fileId, input);
}

export async function createFileComment(deps, ctx, fileId, input) {
  const { projectId } = ctx;
  requireCollaborate(ctx);
  const file = await requireFile(deps, ctx, fileId);
  const channel = await fileChannel(deps, ctx, file);
  requireOpen(channel);
  const parent = await requireReplyParent(deps, ctx, { parentId: input.parentId, targetId: fileId, targetType: 'file' });
  const replyToId = await requireReplyTo(deps.projectRepository, { parentId: input.parentId ?? null, replyToId: input.replyToId ?? null, targetId: fileId, targetType: 'file', tenantId: ctx.tenantId });
  const people = await channelPeople(deps, ctx, channel?.id ?? null);
  const tagged = prepareMentions(requireBody(input.body), people);
  const post = await deps.projectRepository.createPost({
    post: { authorId: ctx.principal.id, authorType: ctx.principal.type, body: tagged.body, fileVersion: file.version ?? 1, parentId: input.parentId ?? null, projectId, replyToId, targetId: fileId, targetType: 'file', tenantId: ctx.tenantId },
  });
  const mentioned = await notifyPost(deps, ctx, { channel, file, parent, people, post, tagged: tagged.added });
  return { channelId: channel?.id ?? null, comment: presentPost(post, ctx), mentioned, ok: true };
}

// --- folders ----------------------------------------------------------------------------------

function validFolderName(name) {
  const value = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!value) throw new HttpError(400, 'Enter a folder name.', { details: { code: 'folder_name_required' } });
  if (/[\\/]/.test(value)) throw new HttpError(400, 'A folder name cannot contain / or \\.', { details: { code: 'folder_name_invalid' } });
  return value;
}

async function requireFolder(deps, ctx, folderId) {
  const folder = await deps.projectRepository.getFolder({ folderId, projectId: ctx.projectId, tenantId: ctx.tenantId });
  if (!folder) throw new HttpError(404, 'Folder not found.');
  return folder;
}

function presentFolder(folder) {
  return { channelId: folder.channelId, createdAt: folder.createdAt, id: folder.id, name: folder.name, parentId: folder.parentId ?? null };
}

export async function listFoldersForUser(deps, user, projectId, channelId) {
  return listFolders(deps, await channelAccess(deps, user, projectId), channelId);
}

export async function listFolders(deps, ctx, channelId) {
  const { projectId } = ctx;
  const channel = await requireChannel(deps, ctx, channelId);
  const folders = await deps.projectRepository.listFolders({ channelId, projectId, tenantId: ctx.tenantId });
  return {
    // Guests use the folders they find; members with file rights shape them.
    canManage: ctx.canWriteFiles && !ctx.guest && !channel.archivedAt,
    folders: folders.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })).map(presentFolder),
    ok: true,
  };
}

export async function createFolderForUser(deps, user, projectId, channelId, input) {
  const ctx = await channelAccess(deps, user, projectId);
  requireFileWrite(ctx);
  const channel = await requireChannel(deps, ctx, channelId);
  requireOpen(channel);
  if (input.parentId) {
    const parent = await requireFolder(deps, ctx, input.parentId);
    if (parent.channelId !== channelId) throw new HttpError(400, 'That folder is in another channel.', { details: { code: 'invalid_folder' } });
  }
  const folder = await deps.projectRepository.createFolder({ channelId, name: validFolderName(input.name), parentId: input.parentId ?? null, projectId, tenantId: ctx.tenantId, user });
  return { folder: presentFolder(folder), ok: true };
}

/** Renames a folder, or moves it within its channel (never into itself or one of its own folders). */
export async function updateFolderForUser(deps, user, projectId, folderId, input) {
  const ctx = await channelAccess(deps, user, projectId);
  requireFileWrite(ctx);
  const folder = await requireFolder(deps, ctx, folderId);
  requireOpen(await requireChannel(deps, ctx, folder.channelId));
  const changes = {};
  if (input.name !== undefined) changes.name = validFolderName(input.name);
  if (input.parentId !== undefined && (input.parentId ?? null) !== (folder.parentId ?? null)) {
    if (input.parentId) {
      const folders = await deps.projectRepository.listFolders({ channelId: folder.channelId, projectId, tenantId: ctx.tenantId });
      const byId = new Map(folders.map((entry) => [entry.id, entry]));
      if (!byId.has(input.parentId)) throw new HttpError(400, 'That folder is not in this channel.', { details: { code: 'invalid_folder' } });
      for (let at = byId.get(input.parentId); at; at = at.parentId ? byId.get(at.parentId) : null) {
        if (at.id === folderId) throw new HttpError(400, 'A folder cannot go inside itself.', { details: { code: 'folder_cycle' } });
      }
    }
    changes.parentId = input.parentId ?? null;
  }
  if (!Object.keys(changes).length) return { folder: presentFolder(folder), ok: true };
  const saved = await deps.projectRepository.updateFolder({ changes, folderId, tenantId: ctx.tenantId, user });
  return { folder: presentFolder(saved), ok: true };
}

export async function deleteFolderForUser(deps, user, projectId, folderId) {
  const ctx = await channelAccess(deps, user, projectId);
  requireFileWrite(ctx);
  const folder = await requireFolder(deps, ctx, folderId);
  requireOpen(await requireChannel(deps, ctx, folder.channelId));
  await deps.projectRepository.deleteFolder({ folderId, tenantId: ctx.tenantId, user });
  return { deletedFolderId: folderId, folder: presentFolder(folder), ok: true };
}

// --- the file tree ----------------------------------------------------------------------------
//
// A project's files as one tree (docs/engagements/plan.md, Folders): the project is the top
// folder and holds the project's own files; each channel is a folder in it, holding its library;
// people make their own folders inside a channel. Files on epics, stories, tasks, tickets and
// requirements topics stay with their items and are not in the tree.

const TREE_TARGETS = new Set(['project', 'channel']);

/** Each folder's files directly in it, and with those of the folders below it. */
function countTree(folders, files) {
  const direct = new Map();
  for (const file of files) direct.set(file.folderId ?? null, (direct.get(file.folderId ?? null) ?? 0) + 1);
  const children = new Map();
  for (const folder of folders) children.set(folder.parentId ?? null, [...(children.get(folder.parentId ?? null) ?? []), folder]);
  const totals = new Map();
  const total = (folder, seen = new Set()) => {
    if (totals.has(folder.id)) return totals.get(folder.id);
    seen.add(folder.id);
    const sum = (direct.get(folder.id) ?? 0) + (children.get(folder.id) ?? []).filter((child) => !seen.has(child.id)).reduce((acc, child) => acc + total(child, seen), 0);
    totals.set(folder.id, sum);
    return sum;
  };
  return {
    folders: folders
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((folder) => ({ fileCount: direct.get(folder.id) ?? 0, id: folder.id, name: folder.name, parentId: folder.parentId ?? null, totalFileCount: total(folder) })),
    top: direct.get(null) ?? 0,
    total: files.length,
  };
}

export async function getFileTreeForUser(deps, user, projectId) {
  return getFileTree(deps, await channelAccess(deps, user, projectId));
}

/**
 * The tree for a member, or for a guest only their channels and no project files. fileCount is
 * the files directly in a channel's top level or a folder; totalFileCount adds its folders'.
 */
export async function getFileTree(deps, ctx) {
  const { projectId, tenantId } = ctx;
  if (!ctx.guest) await deps.projectRepository.ensureGeneralChannel?.({ projectId, tenantId, userId: ctx.user?.id ?? null });
  const channels = sortChannels((await deps.projectRepository.listChannels({ projectId, tenantId })).filter((channel) => inScope(ctx, channel.id)));
  const [files, folders] = await Promise.all([
    deps.projectRepository.listFiles({ projectId, targetId: projectId, targetType: 'project', tenantId, user: ctx.fileActor }),
    deps.projectRepository.listFolders({ projectId, tenantId }),
  ]);
  const header = ctx.project?.name !== undefined ? ctx.project : await deps.projectRepository.getProjectHeader?.({ projectId, tenantId });
  const rootFiles = ctx.guest ? [] : files.filter((file) => file.targetType === 'project' && file.targetId === projectId);
  return {
    canManage: ctx.canWriteFiles && !ctx.guest,
    channels: await Promise.all(channels.map(async (channel) => {
      const counted = countTree(folders.filter((folder) => folder.channelId === channel.id), files.filter((file) => file.targetType === 'channel' && file.targetId === channel.id));
      const guests = ctx.guest ? [] : await deps.projectRepository.listChannelGuests?.({ channelId: channel.id, tenantId }) ?? [];
      return {
        archived: Boolean(channel.archivedAt),
        fileCount: counted.top,
        folders: counted.folders,
        guestCount: guests.length,
        id: channel.id,
        isGeneral: Boolean(channel.isGeneral),
        name: channel.name,
        totalFileCount: counted.total,
      };
    })),
    ok: true,
    project: { id: projectId, name: header?.name ?? '' },
    rootFileCount: rootFiles.length,
  };
}

function validFileName(name) {
  const value = String(name ?? '').trim();
  if (!value) throw new HttpError(400, 'Enter a file name.', { details: { code: 'file_name_required' } });
  if (/[\\/\0]/.test(value)) throw new HttpError(400, 'A file name cannot contain / or \\.', { details: { code: 'file_name_invalid' } });
  return value;
}

/**
 * Renames a file in the tree, moves it to the project's top level or a channel's library (one
 * of its folders, or its top level), or both. A file keeps its id, versions, links, comments and
 * the posts it is attached to. Moving it into a channel whose guests could not see it before
 * shows it to them, so that asks for confirmGuests first (409 guests_will_see).
 */
export async function moveFileForUser(deps, user, projectId, fileId, input) {
  const ctx = await channelAccess(deps, user, projectId);
  requireFileWrite(ctx);
  const file = await requireFile(deps, ctx, fileId);
  if (!TREE_TARGETS.has(file.targetType)) {
    throw new HttpError(400, 'This file belongs to a work item or a requirements topic, so it can only be moved or renamed in the project files or a channel library.', { details: { code: 'file_not_in_tree' } });
  }
  const source = await fileChannel(deps, ctx, file);
  requireOpen(source);
  if (deps.complianceRepository) {
    await assertRecordsNotHeld({ repository: deps.complianceRepository, resources: [{ resourceId: projectId, resourceType: 'project' }, { resourceId: fileId, resourceType: 'file' }], tenantId: ctx.tenantId });
  }

  const fileName = input.fileName === undefined ? file.fileName : validFileName(input.fileName);
  let destination = { folderId: file.folderId ?? null, targetId: file.targetId, targetType: file.targetType };
  let channel = source;
  if (input.destination?.kind === 'project') {
    destination = { folderId: null, targetId: projectId, targetType: 'project' };
    channel = null;
  } else if (input.destination?.kind === 'channel') {
    channel = await requireChannel(deps, ctx, input.destination.channelId);
    requireOpen(channel);
    const folderId = input.destination.folderId ?? null;
    if (folderId) {
      const folder = await deps.projectRepository.getFolder({ folderId, projectId, tenantId: ctx.tenantId });
      if (!folder || folder.channelId !== channel.id) throw new HttpError(400, 'That folder is not in this channel.', { details: { code: 'invalid_folder' } });
    }
    destination = { folderId, targetId: channel.id, targetType: 'channel' };
  }

  // A channel's guests see its library. A file new to that library is new to them.
  if (channel && channel.id !== source?.id && !input.confirmGuests) {
    const guests = await deps.projectRepository.listChannelGuests?.({ channelId: channel.id, tenantId: ctx.tenantId }) ?? [];
    if (guests.length) {
      throw new HttpError(409, `${guests.length === 1 ? 'A guest' : `${guests.length} guests`} from outside the team will see this file in #${channel.name}. Move it anyway?`, { details: { channelId: channel.id, code: 'guests_will_see', guestCount: guests.length } });
    }
  }

  const result = await deps.projectRepository.moveFile({ ...destination, fileId, fileName, projectId, tenantId: ctx.tenantId, user });
  if (!result) throw new HttpError(404, 'File not found.');
  const saved = result.file;
  const folders = saved.folderId ? await deps.projectRepository.listFolders({ projectId, tenantId: ctx.tenantId }) : [];
  const channelId = saved.targetType === 'channel' ? saved.targetId : null;
  return {
    changed: result.changed,
    // The libraries to refresh: where the file is now, and where it was.
    channelId,
    file: { ...saved, channelId, folderId: saved.folderId ?? null, folderPath: saved.folderId ? folderPaths(folders).get(saved.folderId) ?? null : null },
    fromChannelId: source?.id ?? null,
    ok: true,
  };
}

// --- the editing marker -----------------------------------------------------------------------

/** Marks a file as being edited by the caller (plan: Library, editing marker). */
export async function setFileEditingForUser(deps, user, projectId, fileId) {
  return setFileEditing(deps, await channelAccess(deps, user, projectId), fileId);
}

export async function setFileEditing(deps, ctx, fileId) {
  requireFileWrite(ctx);
  const file = await requireFile(deps, ctx, fileId);
  requireOpen(await fileChannel(deps, ctx, file));
  const editing = await deps.projectRepository.setFileEditing({ fileId, tenantId: ctx.tenantId, userId: ctx.fileActor.id });
  return { channelId: file.targetType === 'channel' ? file.targetId : null, editing, fileId, ok: true };
}

/** Clears the marker: the person who set it, or someone with decision rights. */
export async function clearFileEditingForUser(deps, user, projectId, fileId) {
  return clearFileEditing(deps, await channelAccess(deps, user, projectId), fileId);
}

export async function clearFileEditing(deps, ctx, fileId) {
  requireFileWrite(ctx);
  const file = await requireFile(deps, ctx, fileId);
  requireOpen(await fileChannel(deps, ctx, file));
  const marker = file.editing ?? editingMarker(file);
  if (marker && marker.userId !== ctx.fileActor.id && !ctx.canDecide) throw forbidden(`${marker.name ?? 'Someone else'} is editing this file. Only they, or a project admin or manager, can clear it.`, 'editing_by_other');
  await deps.projectRepository.clearFileEditing({ fileId, tenantId: ctx.tenantId });
  return { channelId: file.targetType === 'channel' ? file.targetId : null, editing: null, fileId, ok: true };
}

// --- Odin in channels ------------------------------------------------------------------------

function requireOdin(deps) {
  if (!deps.odinChannelService) throw new HttpError(503, 'Odin is not available here.', { details: { code: 'odin_unavailable' } });
  return deps.odinChannelService;
}

/** The member who tagged Odin confirms or cancels the action Odin's reply waits on. */
export async function resolveOdinConfirmationForUser(deps, user, projectId, postId, input) {
  const ctx = await channelAccess(deps, user, projectId);
  requireCollaborate(ctx);
  return requireOdin(deps).resolveConfirmation({ input, postId, projectId, user });
}

/** The member who tagged Odin undoes what one of its replies changed. */
export async function undoOdinChangesForUser(deps, user, projectId, postId) {
  const ctx = await channelAccess(deps, user, projectId);
  requireCollaborate(ctx);
  return requireOdin(deps).undo({ postId, projectId, user });
}

/** Unread posts per project for the Engagements page. */
export async function unreadByProjectForUser(deps, user, projectIds) {
  if (!projectIds.length || typeof deps.projectRepository.countUnreadByProject !== 'function') return new Map();
  return deps.projectRepository.countUnreadByProject({ principalId: user.id, principalType: 'user', projectIds, tenantId: tenantIdOf(user) });
}
